import { TradingAgent } from '../src/agent';
import {
  getPaperVsLiveComparison,
  getRecentTrades,
  getTradeSummary,
  logTrade,
} from '../src/db';
import { getQuote } from '../src/price';
import { swap } from '../src/swap';
import { getTokenDecimals, getTokenSymbol } from '../src/tokenInfo';
import { loadWallet } from '../src/wallet';
import { config } from '../src/config';
import type { TradeRecord } from '../src/types';

const SOL = config.baseMint;
const USDC = config.quoteMint;

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function humanToRaw(mint: string, human: number): bigint {
  const d = getTokenDecimals(mint);
  return BigInt(Math.round(human * 10 ** d));
}

type Pending =
  | { kind: 'buy'; usdcHuman: number; session: string }
  | { kind: 'sell'; solHuman: number; session: string }
  | { kind: 'live'; session: string }
  | { kind: 'reset'; session: string };

const pendingBySession = new Map<string, Pending>();

function sessionKey(id?: string): string {
  return id ?? 'default';
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

async function formatStatus(agent: TradingAgent): Promise<string> {
  const s = await agent.getStatus();
  const uptimeMin = Math.floor(s.uptimeMs / 60000);
  const uptimeH = Math.floor(uptimeMin / 60);
  const upStr =
    uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;
  const devPct =
    s.sma && s.latestPrice
      ? (((s.latestPrice - s.sma) / s.sma) * 100).toFixed(2)
      : 'n/a';
  const volPct = s.volatility !== null ? (s.volatility * 100).toFixed(2) : 'n/a';
  const pp = s.paperPortfolio as {
    balances: Record<string, { human: number }>;
    pnl: { pnl: number; pnlPercent: number; currentValue: number };
  };
  const lines = [
    `${agent.mode.toUpperCase()} TRADING MODE`,
    `Status: ${s.running ? 'Running' : 'Stopped'} | Uptime: ${upStr}`,
    `Price: $${s.latestPrice !== null ? fmt(s.latestPrice) : 'n/a'} | SMA20: $${s.sma !== null ? fmt(s.sma) : 'n/a'} | Deviation: ${devPct}%`,
    `Volatility: ${volPct}%`,
    `Cooldown: ${s.cooldownRemaining}s`,
    'Paper Portfolio:',
  ];
  for (const [mint, b] of Object.entries(pp.balances ?? {})) {
    lines.push(`  ${getTokenSymbol(mint)}: ${fmt(b.human, 4)}`);
  }
  lines.push(
    `Paper P&L: ${fmt(pp.pnl?.pnl ?? 0)} (${fmt(pp.pnl?.pnlPercent ?? 0)}%)`,
  );
  const last = s.recentTrades[0];
  if (last) {
    lines.push(
      `Last trade: ${last.input_mint === SOL ? 'Sold SOL' : 'Sold USDC'} -> see history`,
    );
  }
  if (agent.mode === 'live') {
    const w = loadWallet();
    lines.push(`Wallet: ${w?.publicKey.toBase58() ?? 'n/a'}`);
  }
  return lines.join('\n');
}

function usdValueFromTrade(
  r: TradeRecord | { input_mint: string; output_mint: string; input_amount: string; output_amount: string },
  priceSol: number,
): { inUsd: number; outUsd: number } {
  const isRow = 'input_mint' in r;
  const inMint = isRow ? (r as { input_mint: string }).input_mint : (r as TradeRecord).inputMint;
  const outMint = isRow
    ? (r as { output_mint: string }).output_mint
    : (r as TradeRecord).outputMint;
  const inAmt = isRow
    ? (r as { input_amount: string }).input_amount
    : (r as TradeRecord).inputAmount;
  const outAmt = isRow
    ? (r as { output_amount: string }).output_amount
    : (r as TradeRecord).outputAmount;
  const inHuman =
    Number(BigInt(inAmt)) / 10 ** getTokenDecimals(inMint);
  const outHuman =
    Number(BigInt(outAmt)) / 10 ** getTokenDecimals(outMint);
  const inUsd =
    inMint === SOL ? inHuman * priceSol : inMint === USDC ? inHuman : 0;
  const outUsd =
    outMint === SOL ? outHuman * priceSol : outMint === USDC ? outHuman : 0;
  return { inUsd, outUsd };
}

export async function handleTradeMessage(
  agent: TradingAgent,
  raw: string,
  sessionId?: string,
): Promise<string> {
  const sess = sessionKey(sessionId);
  const lower = raw.trim().toLowerCase();
  if (lower === 'confirm') {
    const p = pendingBySession.get(sess);
    if (!p) return 'Nothing to confirm. Try a /trade buy or /trade sell first.';
    if (p.kind === 'live') {
      return 'Type "confirm live" to switch to live mode.';
    }
    if (p.kind === 'reset') {
      return 'Type "confirm reset" to reset the paper portfolio.';
    }
    pendingBySession.delete(sess);
    try {
      if (p.kind === 'buy') {
        const rawU = humanToRaw(USDC, p.usdcHuman);
        if (agent.mode === 'paper') {
          const rec = await agent.getPaperEngine().executePaperTrade(USDC, SOL, rawU, 'manual_chat');
          rec.priceAtTrade = (await agent.getStatus()).latestPrice ?? undefined;
          logTrade(rec);
          return `Executed paper BUY. Signature ${rec.txSignature}`;
        }
        const { order, result } = await swap(USDC, SOL, rawU, 'live');
        if (!result) return 'Live swap failed: no result';
        const ok = String(result.status).toLowerCase().includes('success');
        const px = (await agent.getStatus()).latestPrice ?? undefined;
        logTrade({
          timestamp: new Date().toISOString(),
          inputMint: USDC,
          outputMint: SOL,
          inputAmount: result.inputAmountResult ?? order.inAmount,
          outputAmount: result.outputAmountResult ?? order.outAmount,
          expectedOutput: order.outAmount,
          txSignature: result.signature,
          status: ok ? 'success' : 'failed',
          priceImpact: order.priceImpactPct,
          mode: 'live',
          strategy: 'manual_chat',
          slippageBps: order.slippageBps,
          priceAtTrade: px,
        });
        return ok
          ? `Live BUY submitted. Sig: ${result.signature}\nIn: ${result.inputAmountResult} Out: ${result.outputAmountResult}`
          : `Live BUY failed: ${result.status}`;
      }
      if (p.kind === 'sell') {
        const rawS = humanToRaw(SOL, p.solHuman);
        if (agent.mode === 'paper') {
          const rec = await agent.getPaperEngine().executePaperTrade(SOL, USDC, rawS, 'manual_chat');
          rec.priceAtTrade = (await agent.getStatus()).latestPrice ?? undefined;
          logTrade(rec);
          return `Executed paper SELL. Signature ${rec.txSignature}`;
        }
        const { order, result } = await swap(SOL, USDC, rawS, 'live');
        if (!result) return 'Live swap failed: no result';
        const ok = String(result.status).toLowerCase().includes('success');
        const px = (await agent.getStatus()).latestPrice ?? undefined;
        logTrade({
          timestamp: new Date().toISOString(),
          inputMint: SOL,
          outputMint: USDC,
          inputAmount: result.inputAmountResult ?? order.inAmount,
          outputAmount: result.outputAmountResult ?? order.outAmount,
          expectedOutput: order.outAmount,
          txSignature: result.signature,
          status: ok ? 'success' : 'failed',
          priceImpact: order.priceImpactPct,
          mode: 'live',
          strategy: 'manual_chat',
          slippageBps: order.slippageBps,
          priceAtTrade: px,
        });
        return ok
          ? `Live SELL submitted. Sig: ${result.signature}`
          : `Live SELL failed: ${result.status}`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Execution error: ${msg}`;
    }
    return 'Unknown pending state';
  }
  if (lower === 'confirm live') {
    const p = pendingBySession.get(sess);
    if (!p || p.kind !== 'live') return "No pending live mode switch. Use /trade mode live first.";
    pendingBySession.delete(sess);
    agent.switchMode('live');
    return 'Switched to LIVE mode. Trades will use real funds.';
  }
  if (lower === 'confirm reset') {
    const p = pendingBySession.get(sess);
    if (!p || p.kind !== 'reset') return 'No pending reset.';
    pendingBySession.delete(sess);
    agent.getPaperEngine().reset();
    return 'Paper portfolio reset to initial balances.';
  }

  const parts = tokenize(raw);
  const root = parts[0]?.toLowerCase();
  if (root !== '/trade' && root !== '/trader') {
    return '';
  }
  const sub = parts[1]?.toLowerCase() ?? 'help';

  if (sub === 'status') return formatStatus(agent);

  if (sub === 'start') {
    agent.start();
    return 'Auto-trading loop started (price monitor + strategy).';
  }
  if (sub === 'stop') {
    agent.stop();
    const sum = getTradeSummary(agent.mode);
    return `Stopped.\nSummary: ${JSON.stringify(sum)}`;
  }

  if (sub === 'mode') {
    const m = parts[2]?.toLowerCase();
    if (!m) return `Current mode: ${agent.mode.toUpperCase()}`;
    if (m === 'paper') {
      agent.switchMode('paper');
      return 'Switched to PAPER mode.';
    }
    if (m === 'live') {
      pendingBySession.set(sess, { kind: 'live', session: sess });
      return 'WARNING: LIVE MODE uses REAL tokens. Type "confirm live" to proceed.';
    }
    return 'Usage: /trade mode [paper|live]';
  }

  if (sub === 'config') {
    const c = agent.getRuntimeConfigView();
    return `Config:\n${Object.entries(c)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n')}`;
  }

  if (sub === 'set') {
    const key = parts[2]?.toLowerCase();
    const val = parts[3];
    if (!key || val === undefined) return 'Usage: /trade set <key> <value>';
    if (key === 'mode') return 'Cannot change mode via set — use /trade mode';
    agent.setRuntimeConfig(key, val);
    return `Updated ${key} = ${val}`;
  }

  if (sub === 'history') {
    const n = parts[2] ? Number(parts[2]) : 10;
    const rows = getRecentTrades(Number.isFinite(n) ? n : 10, agent.mode);
    if (!rows.length) return 'No trades yet.';
    const price = (await agent.getStatus()).latestPrice ?? 150;
    return rows
      .map((r) => {
        const { inUsd, outUsd } = usdValueFromTrade(
          {
            input_mint: r.input_mint,
            output_mint: r.output_mint,
            input_amount: r.input_amount,
            output_amount: r.output_amount,
          },
          price,
        );
        const pnl = outUsd - inUsd;
        return `#${r.id} ${r.timestamp} ${r.mode} ${r.status} PnL~$${fmt(pnl)}`;
      })
      .join('\n');
  }

  if (sub === 'pnl') {
    const pe = agent.getPaperEngine();
    const pnl = await pe.getPnL(USDC);
    const sum = getTradeSummary('paper');
    const rows = getRecentTrades(500, 'paper');
    let wins = 0;
    let losses = 0;
    let best = -Infinity;
    let worst = Infinity;
    const price = (await agent.getStatus()).latestPrice ?? 150;
    for (const r of rows) {
      if (r.status !== 'paper_filled' && r.status !== 'success') continue;
      const { inUsd, outUsd } = usdValueFromTrade(
        {
          input_mint: r.input_mint,
          output_mint: r.output_mint,
          input_amount: r.input_amount,
          output_amount: r.output_amount,
        },
        price,
      );
      const d = outUsd - inUsd;
      if (d >= 0) wins += 1;
      else losses += 1;
      best = Math.max(best, d);
      worst = Math.min(worst, d);
    }
    return [
      'Paper Trading P&L Report',
      `Started: ${pe.startTime.toISOString()}`,
      `Current value (USDC): $${fmt(pnl.currentValue)}`,
      `Baseline value: $${fmt(pnl.initialValue)}`,
      `P&L: $${fmt(pnl.pnl)} (${fmt(pnl.pnlPercent)}%)`,
      `Trades: ${sum.totalTrades} total (${wins} wins, ${losses} losses)`,
      `Win rate: ${fmt(sum.winRate)}%`,
      `Best trade (approx): $${fmt(best === -Infinity ? 0 : best)}`,
      `Worst trade (approx): $${fmt(worst === Infinity ? 0 : worst)}`,
    ].join('\n');
  }

  if (sub === 'compare') {
    const c = getPaperVsLiveComparison();
    if (!c.hasBoth) return 'Need both paper and live trades in the database to compare.';
    return `Paper: ${JSON.stringify(c.paper)}\nLive: ${JSON.stringify(c.live)}`;
  }

  if (sub === 'reset') {
    pendingBySession.set(sess, { kind: 'reset', session: sess });
    return 'This will reset the paper portfolio. Type "confirm reset" to proceed.';
  }

  if (sub === 'buy') {
    const amt = Number(parts[2]);
    const sym = (parts[3] ?? '').toUpperCase();
    if (!Number.isFinite(amt) || sym !== 'SOL')
      return 'Usage: /trade buy <usdc_amount> SOL   (spends USDC for SOL)';
    const q = await getQuote(USDC, SOL, humanToRaw(USDC, amt));
    pendingBySession.set(sess, { kind: 'buy', usdcHuman: amt, session: sess });
    return [
      `Quote: ${amt} USDC -> ~${fmt(Number(q.outAmount) / 1e9, 6)} SOL (impact: ${q.priceImpactPct}%)`,
      `Mode: ${agent.mode.toUpperCase()}`,
      "Reply 'confirm' to execute.",
    ].join('\n');
  }

  if (sub === 'sell') {
    const amt = Number(parts[2]);
    const sym = (parts[3] ?? '').toUpperCase();
    if (!Number.isFinite(amt) || sym !== 'SOL')
      return 'Usage: /trade sell <sol_amount> SOL';
    const q = await getQuote(SOL, USDC, humanToRaw(SOL, amt));
    pendingBySession.set(sess, { kind: 'sell', solHuman: amt, session: sess });
    return [
      `Quote: ${fmt(amt, 4)} SOL -> ~${fmt(Number(q.outAmount) / 1e6, 2)} USDC (impact: ${q.priceImpactPct}%)`,
      `Mode: ${agent.mode.toUpperCase()}`,
      "Reply 'confirm' to execute.",
    ].join('\n');
  }

  return [
    'Commands:',
    '/trade status | start | stop',
    '/trade buy <usdc> SOL | /trade sell <sol> SOL',
    '/trade history [N] | /trade pnl | /trade compare',
    '/trade mode [paper|live] | /trade config | /trade set <key> <value>',
    '/trade reset',
  ].join('\n');
}

export default handleTradeMessage;

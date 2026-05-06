/**
 * Backtest CLI.
 *
 * Single run:
 *   npm run backtest -- --strategy mean_reversion_v1 --symbol SOL --resolution 1h --from 2025-01-01
 *
 * All universe symbols:
 *   npm run backtest -- --strategy breakout_v1 --all --resolution 1h --from 2024-06-01
 *
 * Override config:
 *   npm run backtest -- --strategy mean_reversion_v1 --symbol SOL --threshold 1.5
 *
 * Outputs:
 *   - Console summary (key metrics)
 *   - HTML report at data/backtest-reports/<strategy>-<symbols>-<timestamp>.html
 *   - CSV trade ledger at same path with .csv extension
 */
import fs from 'fs';
import path from 'path';
import { runBacktest } from './engine';
import { renderHtmlReport } from './report';
import { getActiveUniverse } from '../symbols';
import type { Resolution } from '../historical/types';
import type { BacktestParams, BacktestResult } from './types';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error(`Bad date: ${s}`);
  return d;
}

/** Known strategy-config keys we accept as flags. Any --foo numeric flag is
 *  treated as a config override. */
function pluckConfigOverrides(args: Record<string, string | boolean>): Record<string, number> {
  const reserved = new Set([
    'strategy', 'symbol', 'symbols', 'all', 'resolution', 'from', 'to',
    'capital', 'risk', 'sl', 'tp', 'trailing', 'taker', 'slippage',
    'output-dir',
  ]);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(args)) {
    if (reserved.has(k)) continue;
    if (typeof v !== 'string') continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.strategy) {
    console.error('Usage: npm run backtest -- --strategy <name> --symbol <ticker | --all> [--resolution 1h] [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
    console.error('Strategy config flags accepted: --threshold 1.5, --leverage 2, etc.');
    process.exit(1);
  }

  const symbols: string[] = args.all
    ? getActiveUniverse().map((s) => s.symbol)
    : args.symbols
      ? (args.symbols as string).split(',').map((s) => s.trim().toUpperCase())
      : [(args.symbol as string).toUpperCase()];

  const resolution = (args.resolution as Resolution) ?? '1h';
  const now = new Date();
  const from = parseDate(args.from as string, new Date(now.getTime() - 90 * 86400_000));
  const to = parseDate(args.to as string, now);

  const params: BacktestParams = {
    strategy: args.strategy as string,
    symbols,
    resolution,
    fromMs: from.getTime(),
    toMs: to.getTime(),
    configOverride: pluckConfigOverrides(args),
    initialCapital: args.capital ? Number(args.capital) : undefined,
    riskPerTrade: args.risk ? Number(args.risk) : undefined,
    stopLossPercent: args.sl ? Number(args.sl) : undefined,
    takeProfitPercent: args.tp ? Number(args.tp) : undefined,
    trailingStopPercent: args.trailing ? Number(args.trailing) : undefined,
    takerFeeBps: args.taker ? Number(args.taker) : undefined,
    slippageBps: args.slippage ? Number(args.slippage) : undefined,
  };

  console.log(`[BT] ${params.strategy} on [${symbols.join(',')}] @ ${resolution}`);
  console.log(`     ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)} (${((to.getTime() - from.getTime()) / 86400_000).toFixed(0)}d)`);
  if (Object.keys(params.configOverride ?? {}).length > 0) {
    console.log(`     overrides:`, params.configOverride);
  }

  const startedAt = Date.now();
  const result = await runBacktest(params);
  const elapsed = Date.now() - startedAt;
  console.log(`[BT] done in ${elapsed}ms · ${result.trades.length} trades · ${result.metrics.bars} bars`);

  // Console summary
  printSummary(result);

  // Persist outputs
  const outDir = (args['output-dir'] as string) ?? path.join(process.cwd(), 'data', 'backtest-reports');
  fs.mkdirSync(outDir, { recursive: true });
  const tag = `${params.strategy}-${symbols.join('_')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const htmlPath = path.join(outDir, `${tag}.html`);
  const csvPath = path.join(outDir, `${tag}.csv`);
  const jsonPath = path.join(outDir, `${tag}.json`);

  fs.writeFileSync(htmlPath, renderHtmlReport(result));
  fs.writeFileSync(csvPath, renderCsv(result));
  fs.writeFileSync(jsonPath, JSON.stringify({
    params: result.params,
    metrics: result.metrics,
    perSymbol: result.perSymbol,
    tradeCount: result.trades.length,
  }, null, 2));

  console.log(`[BT] wrote ${htmlPath}`);
  console.log(`[BT] wrote ${csvPath}`);
  console.log(`[BT] wrote ${jsonPath}`);
}

function printSummary(r: BacktestResult): void {
  const m = r.metrics;
  const pct = (n: number) => (n * 100).toFixed(2) + '%';
  const usd = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);

  console.log('');
  console.log('  ╭─── RETURNS ───────────────────────────────╮');
  console.log(`  │  Total P&L:       ${usd(m.totalReturnUsd).padEnd(20)} (${pct(m.totalReturnPct)})`);
  console.log(`  │  Sharpe (ann):    ${m.sharpe.toFixed(2)}`);
  console.log(`  │  Sortino:         ${m.sortino.toFixed(2)}`);
  console.log(`  │  Max DD:          -${pct(m.maxDrawdown)}  (${m.maxDrawdownDays.toFixed(1)}d)`);
  console.log('  ├─── TRADES ────────────────────────────────┤');
  console.log(`  │  Total:           ${m.totalTrades}`);
  console.log(`  │  Win rate:        ${pct(m.winRate)}  (${m.wins}W / ${m.losses}L)`);
  console.log(`  │  Avg win:         ${usd(m.avgWin)}`);
  console.log(`  │  Avg loss:        ${usd(m.avgLoss)}`);
  console.log(`  │  Expectancy:      ${usd(m.expectancy)}`);
  console.log(`  │  Profit factor:   ${m.profitFactor.toFixed(2)}`);
  console.log(`  │  Avg hold:        ${m.avgHoldMinutes.toFixed(1)}m  (median ${m.medianHoldMinutes.toFixed(1)}m)`);
  console.log('  ├─── PER SYMBOL ────────────────────────────┤');
  for (const [sym, s] of Object.entries(r.perSymbol)) {
    const pnlStr = (s.realizedPnl < 0 ? '-$' : '$') + Math.abs(s.realizedPnl).toFixed(2);
    console.log(`  │  ${sym.padEnd(6)} ${s.trades}t  ${s.wins}W/${s.losses}L  ${pnlStr}`);
  }
  console.log('  ╰───────────────────────────────────────────╯');
}

function renderCsv(r: BacktestResult): string {
  const header = 'symbol,entry_time,exit_time,entry_price,exit_price,size,notional,gross_pnl,net_pnl,fees,exit_reason,reason,hold_minutes';
  const rows = r.trades.map((t) => [
    t.symbol,
    new Date(t.entryT).toISOString(),
    new Date(t.exitT).toISOString(),
    t.entryPrice,
    t.exitPrice,
    t.size,
    t.notional,
    t.realizedPnl.toFixed(4),
    t.realizedPnlNet.toFixed(4),
    t.feesPaid.toFixed(4),
    t.exitReason,
    JSON.stringify(t.reason),
    t.holdMinutes.toFixed(2),
  ].join(','));
  return [header, ...rows].join('\n');
}

void main().catch((e) => {
  console.error('[BT] fatal:', e);
  process.exit(1);
});

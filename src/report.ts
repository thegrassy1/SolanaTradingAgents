import type { TradingAgent } from './agent';
import { config } from './config';
import type { SqliteDatabase } from './db';
import {
  countTradesTodayUtc,
  getClosedExitStats,
  getTradeSummary,
} from './db';
import type { PaperTradingEngine } from './paper';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtDash<T>(v: T, fmt: (x: NonNullable<T>) => string): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number' && !Number.isFinite(v)) return '—';
  return fmt(v as NonNullable<T>);
}

function fmtUsd(n: number | null | undefined): string {
  return fmtDash(n, (x) =>
    x.toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
  );
}

/** USD with explicit + for positive values (for P&amp;L lines). */
function fmtUsdSigned(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const core = n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
  if (n > 0) return `+${core}`;
  return core;
}

function fmtPctSigned(n: number | null | undefined): string {
  return fmtDash(n, (x) => {
    const sign = x >= 0 ? '+' : '';
    return `${sign}${x.toFixed(2)}%`;
  });
}

function fmtPctPlain(n: number | null | undefined): string {
  return fmtDash(n, (x) => `${x.toFixed(2)}%`);
}

function fmtNum(n: number | null | undefined, decimals: number): string {
  return fmtDash(n, (x) => x.toFixed(decimals));
}

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${m.toString().padStart(2, '0')}`;
}

function formatChicagoDateLine(): string {
  const tz = config.reportTimezone || 'America/Chicago';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date());
  }
}

function mintLabel(mint: string): string {
  if (mint === config.baseMint) return 'SOL';
  if (mint === config.quoteMint) return 'USDC';
  return escapeHtml(mint.slice(0, 8)) + '…';
}

export async function buildDailyReport(
  agent: TradingAgent,
  paperEngine: PaperTradingEngine,
  database: SqliteDatabase,
): Promise<string> {
  const status = await agent.getStatus();
  const runtime = agent.getRuntimeConfigView();
  const riskSnap = status.risk;
  const modeLabel = status.mode === 'live' ? 'LIVE' : 'PAPER';
  const runningLabel = status.running ? 'Yes' : 'No';

  const price = status.latestPrice;
  const sma = status.sma;
  const deviationPct =
    price !== null &&
    sma !== null &&
    typeof price === 'number' &&
    typeof sma === 'number' &&
    sma !== 0
      ? ((price - sma) / sma) * 100
      : null;
  const volPct =
    status.volatility !== null && typeof status.volatility === 'number'
      ? status.volatility * 100
      : null;

  const { totalValue } = await paperEngine.getPortfolioValue(config.quoteMint);
  const balances = status.paperPortfolio.balances;
  const solBal = balances[config.baseMint]?.human;
  const usdcBal = balances[config.quoteMint]?.human;
  const solUsd =
    price !== null && typeof solBal === 'number'
      ? solBal * price
      : null;
  const pnl = status.paperPortfolio.pnl;

  const maxDailyFrac =
    typeof riskSnap.maxDailyLossPercent === 'number'
      ? riskSnap.maxDailyLossPercent
      : Number(riskSnap.maxDailyLossPercent);
  const dayStart = status.dailyStartingValueQuote;
  const dayPnl = status.dailyRealizedPnL;
  const circuitTripped =
    Number.isFinite(dayStart) &&
    dayStart > 0 &&
    Number.isFinite(maxDailyFrac) &&
    dayPnl / dayStart <= -maxDailyFrac;
  const circuitLabel = circuitTripped ? 'TRIPPED' : 'Armed';

  const tradesToday = countTradesTodayUtc(database, status.mode);
  const tradeSummary = getTradeSummary(status.mode);
  const closed = getClosedExitStats(database, status.mode);
  const { exitReasons } = closed;

  const px =
    status.latestPrice ?? agent.priceMonitor.getLatestPrice() ?? null;
  const { positions } = agent.getPositionsApi(px);
  type PosRow = {
    mint?: string;
    entryPrice?: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
  };

  const cooldownSec = status.cooldownRemaining;
  const cooldownLine =
    cooldownSec > 0
      ? `Active ${cooldownSec}s remaining`
      : 'None';

  const thresholdPct =
    typeof runtime.thresholdPct === 'number'
      ? runtime.thresholdPct
      : Number(runtime.thresholdPct);

  const slPct =
    typeof riskSnap.stopLossPercent === 'number'
      ? riskSnap.stopLossPercent * 100
      : null;
  const tpPct =
    typeof riskSnap.takeProfitPercent === 'number'
      ? riskSnap.takeProfitPercent * 100
      : null;
  const maxLossPct =
    typeof riskSnap.maxDailyLossPercent === 'number'
      ? riskSnap.maxDailyLossPercent * 100
      : null;
  const riskPerPct =
    typeof riskSnap.riskPerTradePercent === 'number'
      ? riskSnap.riskPerTradePercent * 100
      : null;
  const coolNormMin =
    typeof riskSnap.cooldownNormalMs === 'number'
      ? riskSnap.cooldownNormalMs / 60_000
      : null;
  const coolLossMin =
    typeof riskSnap.cooldownAfterLossMs === 'number'
      ? riskSnap.cooldownAfterLossMs / 60_000
      : null;

  const lines: string[] = [];
  lines.push('<b>📊 Solana Trader — Daily Report</b>');
  lines.push(`<i>5:00 PM CT — ${escapeHtml(formatChicagoDateLine())}</i>`);
  lines.push('');
  lines.push('<b>Status</b>');
  lines.push(`Mode: ${escapeHtml(modeLabel)}`);
  lines.push(`Uptime: ${escapeHtml(formatUptime(status.uptimeMs))}`);
  lines.push(`Running: ${escapeHtml(runningLabel)}`);
  lines.push('');
  lines.push('<b>Market</b>');
  lines.push(`SOL Price: ${fmtUsd(price)}`);
  lines.push(`SMA (20): ${fmtUsd(sma)}`);
  lines.push(`Deviation: ${fmtPctSigned(deviationPct)}`);
  lines.push(`Volatility: ${fmtPctPlain(volPct)}`);
  lines.push('');
  lines.push('<b>Portfolio</b>');
  lines.push(`Total Value: ${fmtUsd(totalValue)}`);
  lines.push(
    `SOL: ${fmtNum(solBal, 4)} (${fmtUsd(solUsd)})`,
  );
  lines.push(`USDC: ${fmtNum(usdcBal, 2)}`);
  lines.push(
    `Overall P&amp;L: ${fmtUsdSigned(pnl.pnl)} (${fmtPctSigned(pnl.pnlPercent)})`,
  );
  lines.push('');
  lines.push('<b>Today</b>');
  lines.push(`Start Value: ${fmtUsd(dayStart)}`);
  lines.push(`Realized P&amp;L: ${fmtUsdSigned(dayPnl)}`);
  lines.push(`Trades Today: ${String(tradesToday)}`);
  lines.push(`Circuit Breaker: ${escapeHtml(circuitLabel)}`);
  lines.push('');
  lines.push('<b>Trade Stats (all time)</b>');
  lines.push(
    `Total Trades: ${String(tradeSummary.totalTrades)}  (Closed: ${String(tradeSummary.closedTrades)}, Opens: ${String(tradeSummary.openTrades)})`,
  );
  if (tradeSummary.failedTrades > 0) {
    lines.push(`Failed: ${String(tradeSummary.failedTrades)}`);
  }
  lines.push('');
  lines.push('<b>Closed Positions</b>');
  lines.push(
    `Wins: ${String(tradeSummary.wins)}  |  Losses: ${String(tradeSummary.losses)}  |  Breakevens: ${String(tradeSummary.breakevens)}`,
  );
  const decided = tradeSummary.wins + tradeSummary.losses;
  const winRateLine =
    decided < 5
      ? `Win Rate: — (insufficient data, need ≥5 closes)`
      : `Win Rate: ${fmtPctPlain(tradeSummary.winRate)}`;
  lines.push(winRateLine);
  lines.push(
    `Avg Win: ${fmtUsdSigned(tradeSummary.avgWin)}  |  Avg Loss: ${fmtUsdSigned(tradeSummary.avgLoss)}`,
  );
  lines.push(`Expectancy: ${fmtUsdSigned(tradeSummary.expectancy)}/trade`);
  lines.push(
    `Exit Reasons: stop_loss=${exitReasons.stop_loss}, take_profit=${exitReasons.take_profit}, trailing_stop=${exitReasons.trailing_stop}, manual=${exitReasons.manual}`,
  );
  lines.push('');
  lines.push('<b>Open Positions</b>');
  lines.push(`Count: ${String(positions.length)}`);
  const curPx = px !== null && px > 0 ? px : null;
  for (const raw of positions) {
    const p = raw as PosRow;
    const entry = typeof p.entryPrice === 'number' ? p.entryPrice : null;
    const pct =
      curPx !== null && entry !== null && entry !== 0
        ? ((curPx - entry) / entry) * 100
        : null;
    const sl =
      typeof p.stopLossPrice === 'number' && Number.isFinite(p.stopLossPrice)
        ? fmtUsd(p.stopLossPrice)
        : '—';
    const tp =
      typeof p.takeProfitPrice === 'number' &&
      Number.isFinite(p.takeProfitPrice)
        ? fmtUsd(p.takeProfitPrice)
        : '—';
    const sym = typeof p.mint === 'string' ? mintLabel(p.mint) : '—';
    lines.push(
      `- ${sym} @ ${fmtUsd(entry)} → ${fmtUsd(curPx)} (${fmtPctSigned(pct)}) SL:${sl} TP:${tp}`,
    );
  }
  lines.push('');
  lines.push('<b>Risk Config</b>');
  lines.push(
    `Stop Loss: ${fmtPctPlain(slPct)}  Take Profit: ${fmtPctPlain(tpPct)}`,
  );
  lines.push(
    `Max Daily Loss: ${fmtPctPlain(maxLossPct)}  Risk/Trade: ${fmtPctPlain(riskPerPct)}`,
  );
  lines.push(
    `Cooldown: ${fmtNum(coolNormMin, 0)} min (${fmtNum(coolLossMin, 0)} min after loss)`,
  );
  lines.push('');
  lines.push('<b>Current State</b>');
  lines.push(`Cooldown: ${escapeHtml(cooldownLine)}`);
  lines.push(`Threshold: ${fmtNum(thresholdPct, 1)}%`);

  return lines.join('\n');
}

/**
 * Backtest performance metrics: Sharpe, Sortino, max drawdown, trade quality.
 *
 * Sharpe + Sortino computed from bar-to-bar equity changes, annualized
 * by sqrt(bars-per-year). Risk-free rate assumed 0 (close enough for
 * crypto-relative comparisons; we care about relative ranking, not absolutes).
 */
import type { BacktestMetrics, BacktestTrade, EquityPoint } from './types';

export interface MetricsInput {
  startEquity: number;
  endEquity: number;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  barMs: number;
  bars: number;
  symbols: string[];
  fromMs: number;
  toMs: number;
}

export function computeMetrics(input: MetricsInput): BacktestMetrics {
  const { startEquity, endEquity, trades, equityCurve, barMs } = input;

  // Bar-level returns for Sharpe / Sortino
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev <= 0) continue;
    returns.push((equityCurve[i].equity - prev) / prev);
  }

  const meanRet = avg(returns);
  const stdRet = stddev(returns);
  const downsideStd = stddev(returns.filter((r) => r < 0));

  // Annualization factor: how many bars per year
  const barsPerYear = (365.25 * 24 * 60 * 60_000) / barMs;
  const annFactor = Math.sqrt(barsPerYear);
  const sharpe = stdRet === 0 ? 0 : (meanRet / stdRet) * annFactor;
  const sortino = downsideStd === 0 ? 0 : (meanRet / downsideStd) * annFactor;

  // Max drawdown + duration
  let maxDD = 0;
  let curDDStart = 0;
  let maxDDDays = 0;
  let inDrawdown = false;
  for (const p of equityCurve) {
    if (p.drawdown > maxDD) maxDD = p.drawdown;
    if (p.drawdown > 0 && !inDrawdown) {
      inDrawdown = true;
      curDDStart = p.t;
    } else if (p.drawdown === 0 && inDrawdown) {
      inDrawdown = false;
      const days = (p.t - curDDStart) / 86_400_000;
      if (days > maxDDDays) maxDDDays = days;
    }
  }
  // Still in drawdown at end?
  if (inDrawdown && equityCurve.length > 0) {
    const days = (equityCurve[equityCurve.length - 1].t - curDDStart) / 86_400_000;
    if (days > maxDDDays) maxDDDays = days;
  }

  // Trade quality
  const closed = trades.filter((t) => t.exitReason !== 'end_of_test' || t.realizedPnlNet !== 0);
  const winners = closed.filter((t) => t.realizedPnlNet > 0);
  const losers = closed.filter((t) => t.realizedPnlNet < 0);
  const wins = winners.length;
  const losses = losers.length;
  const totalTrades = closed.length;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const avgWin = wins > 0 ? avg(winners.map((t) => t.realizedPnlNet)) : 0;
  const avgLoss = losses > 0 ? avg(losers.map((t) => t.realizedPnlNet)) : 0;
  const expectancy = totalTrades > 0
    ? closed.reduce((s, t) => s + t.realizedPnlNet, 0) / totalTrades
    : 0;
  const sumWins = winners.reduce((s, t) => s + t.realizedPnlNet, 0);
  const sumLosses = Math.abs(losers.reduce((s, t) => s + t.realizedPnlNet, 0));
  const profitFactor = sumLosses > 0 ? sumWins / sumLosses : (sumWins > 0 ? Infinity : 0);

  // Hold-time stats
  const holds = closed.map((t) => t.holdMinutes).sort((a, b) => a - b);
  const avgHold = holds.length ? avg(holds) : 0;
  const medianHold = holds.length ? holds[Math.floor(holds.length / 2)] : 0;

  return {
    startEquity,
    endEquity,
    totalReturnUsd: endEquity - startEquity,
    totalReturnPct: startEquity > 0 ? (endEquity - startEquity) / startEquity : 0,
    sharpe,
    sortino,
    maxDrawdown: maxDD,
    maxDrawdownDays: maxDDDays,
    totalTrades,
    wins,
    losses,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    profitFactor,
    avgHoldMinutes: avgHold,
    medianHoldMinutes: medianHold,
    bars: input.bars,
    symbolsTraded: input.symbols.length,
    duration: {
      startMs: input.fromMs,
      endMs: input.toMs,
      days: (input.toMs - input.fromMs) / 86_400_000,
    },
  };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)));
}

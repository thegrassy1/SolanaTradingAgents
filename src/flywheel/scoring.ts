/**
 * Backtest a (strategy × symbol) combo and reduce to a single comparable score.
 * Shared by both the health checker and the scout.
 */
import { runBacktest } from '../backtest/engine';
import type { ComboScore, FlywheelPolicy } from './types';
import { FLYWHEEL_POLICY } from './types';

export async function scoreCombo(
  strategy: string,
  symbol: string,
  lookbackDays: number,
  resolution: FlywheelPolicy['resolution'] = FLYWHEEL_POLICY.resolution,
): Promise<ComboScore> {
  const toMs = Date.now();
  const fromMs = toMs - lookbackDays * 86_400_000;
  const result = await runBacktest({
    strategy,
    symbols: [symbol],
    resolution,
    fromMs,
    toMs,
  });
  const m = result.metrics;
  return {
    strategy,
    symbol,
    sharpe: m.sharpe,
    totalPnlPct: m.totalReturnPct,
    trades: m.totalTrades,
    winRate: m.winRate,
    maxDrawdown: m.maxDrawdown,
    reliable: m.totalTrades >= FLYWHEEL_POLICY.minTradesForDecision,
  };
}

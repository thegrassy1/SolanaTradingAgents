/**
 * Parameter sweep + walk-forward validation.
 *
 * Sweep:
 *   Run the backtester across a grid of one or more strategy config values
 *   and report which produced the best out-of-sample metrics.
 *
 * Walk-forward:
 *   Split the history into in-sample (train) and out-of-sample (test) halves.
 *   Optimize parameters on train, then run a single backtest on test using
 *   those params. Reports both sets of metrics so you can spot overfitting.
 */
import { runBacktest } from './engine';
import type { BacktestParams, BacktestResult } from './types';

export interface SweepRange {
  /** Config key to sweep, e.g. "threshold". */
  param: string;
  /** Inclusive start. */
  from: number;
  /** Inclusive end. */
  to: number;
  /** Step size. */
  step: number;
}

export interface SweepRow {
  param: string;
  value: number;
  metrics: BacktestResult['metrics'];
  trades: number;
}

/**
 * Sweep a single config parameter across a range and return rows sorted by
 * Sharpe descending (then expectancy as tiebreaker).
 */
export async function sweepParam(
  base: BacktestParams,
  range: SweepRange,
): Promise<SweepRow[]> {
  const values: number[] = [];
  for (let v = range.from; v <= range.to + 1e-9; v += range.step) {
    values.push(roundTo(v, range.step));
  }

  const rows: SweepRow[] = [];
  for (const value of values) {
    const params: BacktestParams = {
      ...base,
      configOverride: { ...(base.configOverride ?? {}), [range.param]: value },
    };
    const r = await runBacktest(params);
    rows.push({
      param: range.param,
      value,
      metrics: r.metrics,
      trades: r.trades.length,
    });
  }

  return rows.sort((a, b) => {
    if (b.metrics.sharpe !== a.metrics.sharpe) return b.metrics.sharpe - a.metrics.sharpe;
    return b.metrics.expectancy - a.metrics.expectancy;
  });
}

/**
 * Walk-forward: split [fromMs, toMs] into train (first `trainPct`) and test.
 * Sweep params on train. Best train-Sharpe param is then run on test.
 * Returns both metrics so the user can see if performance held out of sample.
 */
export async function walkForward(
  base: BacktestParams,
  range: SweepRange,
  trainPct = 0.7,
): Promise<{
  trainBest: SweepRow;
  testResult: SweepRow;
  trainPct: number;
  splitMs: number;
}> {
  const splitMs = base.fromMs + Math.floor((base.toMs - base.fromMs) * trainPct);

  const trainBase: BacktestParams = { ...base, toMs: splitMs };
  const trainRows = await sweepParam(trainBase, range);
  const trainBest = trainRows[0];
  if (!trainBest) throw new Error('Sweep returned no rows');

  // Run that single value on test set
  const testBase: BacktestParams = {
    ...base,
    fromMs: splitMs,
    configOverride: { ...(base.configOverride ?? {}), [range.param]: trainBest.value },
  };
  const testR = await runBacktest(testBase);
  const testResult: SweepRow = {
    param: range.param,
    value: trainBest.value,
    metrics: testR.metrics,
    trades: testR.trades.length,
  };

  return { trainBest, testResult, trainPct, splitMs };
}

function roundTo(v: number, step: number): number {
  // Avoid floating-point creep across many additions.
  const inv = 1 / step;
  return Math.round(v * inv) / inv;
}

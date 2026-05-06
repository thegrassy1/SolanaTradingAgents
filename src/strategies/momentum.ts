import type { Strategy, StrategyContext, StrategySignal } from './base';

/**
 * Momentum / trend-following strategy.
 *
 * Thesis: in crypto, trend-following has been the most consistently profitable
 * retail-accessible strategy for years. The 6-month backtest of our
 * mean-reversion + breakout strategies showed catastrophic losses (-30 to -50%)
 * because both fight or only weakly align with directional moves. Momentum is
 * the missing ingredient: ride trends, don't fade them.
 *
 * Entry conditions (all must hold):
 *   1. SMA(short) > SMA(long)            — short-term avg above long-term avg (trending up)
 *   2. price > SMA(short)                 — current price confirms the trend
 *   3. price > recent N-bar high          — fresh momentum push (no chop entry)
 *   4. trend strength ≥ minSlope          — slope of SMA(short) over `slopeBars`
 *
 * Exit (handled by RiskManager): standard SL / TP / trailing stop. The
 * strategy's only job is when to enter; the engine handles when to leave.
 *
 * Persona: HUNTER — The Tracker. Patient, picks the strongest scent and
 * runs with it.
 *
 * Default config tuned conservatively. Use the sweep CLI to find the best
 * (smaShort, smaLong, breakoutBars) per symbol/regime.
 */
export class MomentumStrategy implements Strategy {
  readonly name = 'momentum_v1';
  readonly displayName = 'Momentum';
  readonly description =
    'Trend-follower: enters on confirmed uptrends (fast SMA over slow SMA + price breakout). Exits via stop loss / take profit. Built to thrive where mean reversion fails — trending markets.';

  getDefaultConfig(): Record<string, number> {
    return {
      smaShort: 20,        // fast SMA period (bars)
      smaLong: 50,         // slow SMA period (bars)
      breakoutBars: 20,    // require break above this many bars' high
      minSlopePct: 0.001,  // SMA-short slope (decimal, 0.001 = 0.1% per bar)
      slopeBars: 10,       // bars to measure slope across
      minVolatility: 0.0,  // optional vol floor (decimal); 0 disables
    };
  }

  validateConfig(config: Record<string, unknown>): boolean {
    const num = (k: string, min: number, max: number, integer = false): boolean => {
      const v = config[k];
      if (v === undefined) return true;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return false;
      if (integer && !Number.isInteger(v)) return false;
      return true;
    };
    if (!num('smaShort', 2, 500, true)) return false;
    if (!num('smaLong', 3, 1000, true)) return false;
    if (!num('breakoutBars', 2, 500, true)) return false;
    if (!num('minSlopePct', -1, 1)) return false;
    if (!num('slopeBars', 2, 200, true)) return false;
    if (!num('minVolatility', 0, 1)) return false;
    return true;
  }

  evaluate(context: StrategyContext): StrategySignal {
    const { currentPrice, openPosition, config, priceHistory, volatility } = context;
    const smaShort = Math.round(config.smaShort ?? 20);
    const smaLong = Math.round(config.smaLong ?? 50);
    const breakoutBars = Math.round(config.breakoutBars ?? 20);
    const minSlopePct = config.minSlopePct ?? 0.001;
    const slopeBars = Math.round(config.slopeBars ?? 10);
    const minVolatility = config.minVolatility ?? 0;

    if (openPosition) {
      return { action: 'hold', reason: 'position_open' };
    }
    if (!priceHistory || priceHistory.length < Math.max(smaLong, breakoutBars + 1, slopeBars + 1)) {
      return { action: 'hold', reason: 'insufficient_data' };
    }
    if (volatility !== null && minVolatility > 0 && volatility < minVolatility) {
      return { action: 'hold', reason: 'low_volatility' };
    }

    const closes = priceHistory.map((p) => p.price);
    const lastShort = avgLast(closes, smaShort);
    const lastLong = avgLast(closes, smaLong);
    if (lastShort === null || lastLong === null) {
      return { action: 'hold', reason: 'insufficient_data' };
    }

    // Gate 1: short-term avg above long-term (uptrend)
    if (lastShort <= lastLong) {
      return { action: 'hold', reason: 'sma_short_below_long' };
    }
    // Gate 2: current price confirms the short-term trend
    if (currentPrice <= lastShort) {
      return { action: 'hold', reason: 'price_below_sma_short' };
    }
    // Gate 3: breaking out of recent N-bar high (no chop entries)
    const priorHighs = closes.slice(-(breakoutBars + 1), -1);
    const priorHigh = priorHighs.length ? Math.max(...priorHighs) : Infinity;
    if (currentPrice <= priorHigh) {
      return { action: 'hold', reason: 'no_breakout' };
    }
    // Gate 4: trend strength — slope of SMA-short over `slopeBars`
    const earlierShort = avgAt(closes, closes.length - 1 - slopeBars, smaShort);
    if (earlierShort === null || earlierShort <= 0) {
      return { action: 'hold', reason: 'insufficient_data' };
    }
    const slopePct = (lastShort - earlierShort) / earlierShort / slopeBars;
    if (slopePct < minSlopePct) {
      return { action: 'hold', reason: 'slope_too_flat' };
    }

    return {
      action: 'buy',
      reason: `trend_aligned_${slopePct.toFixed(4)}/bar`,
      metadata: {
        smaShort: lastShort,
        smaLong: lastLong,
        priorHigh,
        slopePct,
        deviationFromShort: (currentPrice - lastShort) / lastShort,
      },
    };
  }
}

/** Average of the last `n` items in `xs`. Returns null if not enough samples. */
function avgLast(xs: number[], n: number): number | null {
  if (xs.length < n) return null;
  let sum = 0;
  for (let i = xs.length - n; i < xs.length; i++) sum += xs[i];
  return sum / n;
}

/** Average of `n` items ending at index `endIdx` (inclusive). */
function avgAt(xs: number[], endIdx: number, n: number): number | null {
  if (endIdx < n - 1 || endIdx >= xs.length) return null;
  let sum = 0;
  for (let i = endIdx - n + 1; i <= endIdx; i++) sum += xs[i];
  return sum / n;
}

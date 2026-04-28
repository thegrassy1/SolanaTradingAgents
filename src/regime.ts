/**
 * Market regime classifier.
 * Runs on every price tick to label the current market state.
 * Used to gate which strategies are allowed to enter positions.
 */

export type MarketRegime = 'trending_up' | 'trending_down' | 'ranging' | 'dead';

export interface RegimeResult {
  regime: MarketRegime;
  fastSma: number | null;
  slowSma: number | null;
  slopePct: number | null;
  reason: string;
}

/**
 * Classify current market regime from price history + volatility.
 *
 * Algorithm:
 *   1. Dead:         volatility < 0.0002 (0.02%) — market is asleep
 *   2. Trending up:  fast SMA > slow SMA by >0.25% — clear upward momentum
 *   3. Trending down: fast SMA < slow SMA by >0.25% — clear downward momentum
 *   4. Ranging:      everything else — price oscillating near SMA
 *
 * Fast SMA = average of most-recent 10 bars.
 * Slow SMA = average of preceding 10 bars (bars 11-20).
 * Requires at least 20 bars of price history; returns 'ranging' if insufficient.
 */
export function classifyRegime(
  priceHistory: Array<{ t: number; price: number }>,
  volatility: number | null,
): RegimeResult {
  const DEAD_VOL_THRESHOLD = 0.0002;   // 0.02%
  const TREND_SLOPE_THRESHOLD = 0.0025; // 0.25%
  const MIN_BARS = 20;

  if (volatility !== null && volatility < DEAD_VOL_THRESHOLD) {
    return { regime: 'dead', fastSma: null, slowSma: null, slopePct: null, reason: 'volatility_too_low' };
  }

  if (!priceHistory || priceHistory.length < MIN_BARS) {
    return { regime: 'ranging', fastSma: null, slowSma: null, slopePct: null, reason: 'insufficient_history' };
  }

  const recent = priceHistory.slice(-MIN_BARS);
  const slowBars = recent.slice(0, 10).map((p) => p.price);
  const fastBars = recent.slice(10).map((p) => p.price);

  const slowSma = slowBars.reduce((a, b) => a + b, 0) / slowBars.length;
  const fastSma = fastBars.reduce((a, b) => a + b, 0) / fastBars.length;

  const slopePct = slowSma !== 0 ? (fastSma - slowSma) / slowSma : 0;

  if (slopePct > TREND_SLOPE_THRESHOLD) {
    return { regime: 'trending_up', fastSma, slowSma, slopePct, reason: 'fast_sma_above_slow' };
  }
  if (slopePct < -TREND_SLOPE_THRESHOLD) {
    return { regime: 'trending_down', fastSma, slowSma, slopePct, reason: 'fast_sma_below_slow' };
  }

  return { regime: 'ranging', fastSma, slowSma, slopePct, reason: 'sma_flat' };
}

/**
 * Returns true if a strategy is allowed to open positions in the given regime.
 *
 * mean_reversion_v1 — profits from price snapping back to SMA.
 *   Blocked in strong trends where price keeps moving away from SMA.
 *
 * breakout_v1 — profits from sustained directional moves.
 *   Blocked only when market is dead (no energy for a breakout).
 *
 * ai_strategy_v1 — AI decides; blocked only in dead markets.
 *
 * buy_and_hold_v1 — ignores regime; always on.
 */
export function isRegimeAllowed(stratName: string, regime: MarketRegime): boolean {
  switch (stratName) {
    case 'mean_reversion_v1':
      return regime === 'ranging';
    case 'breakout_v1':
      return regime !== 'dead';
    case 'ai_strategy_v1':
      return regime !== 'dead';
    case 'buy_and_hold_v1':
      return true;
    default:
      return true;
  }
}

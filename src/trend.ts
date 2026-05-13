/**
 * Trend Agent — multi-timeframe trend classifier.
 *
 * The legacy regime classifier in regime.ts looks at 20 bars of 30-second
 * polls = 10 minutes of data. That's noise, not trend. This module reads
 * from the historical.db (1h / 4h / 1d bars from Binance) and produces a
 * proper trend signal per symbol.
 *
 * For each symbol we compute on multiple timeframes:
 *   slope_TF = (SMA-fast - SMA-slow) / SMA-slow
 *
 * Then blend timeframes with descending weights (longer TF = more weight
 * for direction; shorter TF = more weight for strength). This way a 1d
 * uptrend that's stalling on 1h gets correctly flagged as "exhausting"
 * rather than just "up".
 *
 * Phase is derived from whether the blended slope is currently above or
 * below its own short-term EMA — accelerating vs decelerating.
 */
import { readBars } from './historical/db';
import type { OHLCVBar } from './historical/types';

export type TrendDirection = 'up' | 'down' | 'neutral';
export type TrendPhase = 'early' | 'mature' | 'exhausting' | 'flat';

export interface TrendState {
  symbol: string;
  ts: number;
  direction: TrendDirection;
  /** 0–100. 0 = no trend / chop. 100 = extreme directional move. */
  strength: number;
  phase: TrendPhase;
  /** Per-timeframe slope (decimal, e.g. 0.015 = 1.5% spread). */
  slopes: { '1h': number; '4h': number; '1d': number };
  /** Composite slope used to decide direction (signed). */
  compositeSlope: number;
  /** 0–1; lower when timeframes disagree. */
  confidence: number;
}

const SMA_FAST = 20;
const SMA_SLOW = 50;
const WEIGHTS = { '1h': 0.2, '4h': 0.3, '1d': 0.5 } as const;
/** Decimal slope magnitudes that map to strength 100. */
const STRENGTH_AT_FULL = 0.06;
/** Minimum composite slope (absolute) to count as a real direction. */
const DIRECTION_THRESHOLD = 0.003;

/** Compute SMA over the last N bar closes. Returns null if not enough bars. */
function sma(bars: OHLCVBar[], n: number): number | null {
  if (bars.length < n) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) sum += bars[i].c;
  return sum / n;
}

/**
 * Per-timeframe slope: (SMA_FAST - SMA_SLOW) / SMA_SLOW.
 * Positive = uptrend (fast above slow), negative = downtrend.
 */
function slope(bars: OHLCVBar[]): number {
  const fast = sma(bars, SMA_FAST);
  const slow = sma(bars, SMA_SLOW);
  if (fast === null || slow === null || slow === 0) return 0;
  return (fast - slow) / slow;
}

/**
 * Read recent bars for one symbol/resolution from the cache, requiring
 * at least SMA_SLOW + a margin so SMAs are well-defined.
 */
function getRecentBars(
  symbol: string,
  resolution: '1h' | '4h' | '1d',
  marginBars = 5,
): OHLCVBar[] {
  const barMs = resolution === '1h' ? 3_600_000 : resolution === '4h' ? 14_400_000 : 86_400_000;
  const needed = SMA_SLOW + marginBars;
  const toMs = Date.now();
  const fromMs = toMs - (needed + 5) * barMs;
  return readBars({ symbol, resolution, fromMs, toMs });
}

/**
 * Classify trend phase by comparing the most recent composite slope to
 * its own 3-bar moving average. If accelerating in the direction of the
 * trend, "early". If decelerating, "exhausting". Etc.
 */
function classifyPhase(
  bars1h: OHLCVBar[],
  composite: number,
  direction: TrendDirection,
): TrendPhase {
  if (direction === 'neutral') return 'flat';
  if (bars1h.length < SMA_SLOW + 6) return 'mature';
  // Compute composite slope from 3 bars ago to see if we're accelerating
  const earlier = bars1h.slice(0, bars1h.length - 3);
  const earlierSlope = slope(earlier);
  // earlierSlope might be on a different timeframe weight, but as a relative
  // signal of "where was the trend a few bars ago" it works.
  const accelerating = direction === 'up'
    ? composite > earlierSlope * 1.1
    : composite < earlierSlope * 1.1;
  const decelerating = direction === 'up'
    ? composite < earlierSlope * 0.9
    : composite > earlierSlope * 0.9;
  if (accelerating) return 'early';
  if (decelerating) return 'exhausting';
  return 'mature';
}

/**
 * Confidence is high when all 3 timeframes agree on direction sign;
 * low when they disagree.
 */
function timeframeAgreement(slopes: { '1h': number; '4h': number; '1d': number }): number {
  const signs = [Math.sign(slopes['1h']), Math.sign(slopes['4h']), Math.sign(slopes['1d'])];
  const positives = signs.filter((s) => s > 0).length;
  const negatives = signs.filter((s) => s < 0).length;
  const maxAgree = Math.max(positives, negatives);
  return maxAgree / 3; // 0.33 (all disagree) to 1.0 (all agree)
}

/** Compute a trend state for a single symbol. Returns null if data is too thin. */
export function computeTrend(symbol: string): TrendState | null {
  const bars1h = getRecentBars(symbol, '1h');
  const bars4h = getRecentBars(symbol, '4h');
  const bars1d = getRecentBars(symbol, '1d');

  // Need at least the 1h slow-SMA data to produce anything meaningful
  if (bars1h.length < SMA_SLOW) return null;

  const slopes = {
    '1h': slope(bars1h),
    '4h': slope(bars4h),
    '1d': slope(bars1d),
  } as const;

  const composite =
    slopes['1h'] * WEIGHTS['1h'] +
    slopes['4h'] * WEIGHTS['4h'] +
    slopes['1d'] * WEIGHTS['1d'];

  let direction: TrendDirection;
  if (composite > DIRECTION_THRESHOLD) direction = 'up';
  else if (composite < -DIRECTION_THRESHOLD) direction = 'down';
  else direction = 'neutral';

  const strength = Math.min(100, Math.round((Math.abs(composite) / STRENGTH_AT_FULL) * 100));
  const phase = classifyPhase(bars1h, composite, direction);
  const confidence = timeframeAgreement(slopes);

  return {
    symbol,
    ts: Date.now(),
    direction,
    strength,
    phase,
    slopes,
    compositeSlope: composite,
    confidence,
  };
}

/**
 * Compute trends for every symbol in a list (in parallel-friendly fashion).
 * Returns a map; symbols without enough data are omitted.
 */
export function computeTrendsForAll(symbols: string[]): Record<string, TrendState> {
  const out: Record<string, TrendState> = {};
  for (const sym of symbols) {
    const t = computeTrend(sym);
    if (t) out[sym] = t;
  }
  return out;
}

/**
 * Strategy-side helper: does this strategy WANT to fire given the trend state?
 *
 * Each strategy declares its own preference. Returning `true` means "go ahead,
 * trend is favorable"; `false` means "skip this entry, conditions wrong".
 * Strategies that aren't trend-sensitive (buy_and_hold) always return true.
 *
 * Designed as advisory — caller may choose to enforce or ignore.
 */
export function strategyWantsFire(stratName: string, trend: TrendState | null): boolean {
  if (!trend) return true; // no data — don't block

  switch (stratName) {
    case 'momentum_v1':
      // HUNTER wants real upward momentum, not exhausted
      return trend.direction === 'up'
        && trend.strength >= 35
        && trend.phase !== 'exhausting';

    case 'breakout_v1':
      // RUSH wants the trend behind it, but not chasing a dying move
      return trend.direction === 'up'
        && trend.phase !== 'exhausting'
        && trend.confidence >= 0.5;

    case 'mean_reversion_v1':
      // STATIC dies in strong trends. Want neutral or weak conditions.
      return trend.direction === 'neutral'
        || trend.strength < 30;

    case 'mean_reversion_short_v1':
      // VOID wants down trends OR exhausting up trends to short into
      return trend.direction === 'down'
        || (trend.direction === 'up' && trend.phase === 'exhausting');

    case 'buy_and_hold_v1':
    case 'ai_strategy_v1':
      // Pass-through: buy_and_hold ignores trend; ai_strategy gets the
      // trend as part of its context and decides for itself via Haiku.
      return true;

    default:
      return true;
  }
}

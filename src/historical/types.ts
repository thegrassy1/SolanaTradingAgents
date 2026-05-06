/**
 * Shared types for historical data + backtest engine.
 */

/** Resolutions we support. Maps onto whatever the source can give us. */
export type Resolution = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

/** Approximate ms-per-bar lookup. */
export const BAR_MS: Record<Resolution, number> = {
  '1m':  60_000,
  '5m':  5 * 60_000,
  '15m': 15 * 60_000,
  '1h':  60 * 60_000,
  '4h':  4 * 60 * 60_000,
  '1d':  24 * 60 * 60_000,
};

/** OHLCV bar. All prices in quote (USDC); timestamp in epoch ms. */
export interface OHLCVBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Funding-rate sample for a perp market (Drift, etc.). */
export interface FundingRateSample {
  /** Market name, e.g. "SOL-PERP". */
  market: string;
  /** Epoch ms. */
  t: number;
  /** Hourly rate as a decimal (e.g. 0.0001 = 0.01%/hour). */
  rate: number;
}

/** Source attribution — useful for auditing data quality. */
export type DataSource = 'birdeye' | 'coingecko' | 'drift' | 'pyth' | 'cache' | 'local-snapshots';

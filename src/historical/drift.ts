/**
 * Drift historical funding rate client.
 *
 * Drift's DLOB API exposes funding rate history per perp market.
 * This is the data we need to backtest the funding-carry strategy
 * (Phase 4 in FEATURES.md).
 *
 * Endpoint: GET https://dlob.drift.trade/funding-rates/{market}
 *   e.g.   https://dlob.drift.trade/funding-rates/SOL-PERP
 *   Returns: array of { ts, fundingRate, ... }
 *   No API key required, no documented rate limit (be polite).
 *
 * Drift expresses funding as a per-hour decimal already, so a value of
 * 0.0001 means 0.01% per hour. We store as-is.
 */
import type { FundingRateSample } from './types';

const DRIFT_BASE = process.env.DRIFT_DLOB_URL ?? 'https://dlob.drift.trade';

interface DriftFundingRow {
  ts?: number | string;
  slot?: number;
  fundingRate?: string | number;
  oraclePriceTwap?: string;
  markPriceTwap?: string;
}

interface DriftFundingResponse {
  fundingRates?: DriftFundingRow[];
  data?: DriftFundingRow[];
}

/** Markets we care about, mapped to canonical symbols in our universe. */
export const DRIFT_MARKET: Record<string, string> = {
  SOL: 'SOL-PERP',
  BTC: 'BTC-PERP',
  ETH: 'ETH-PERP',
  JUP: 'JUP-PERP',
  // Drift adds new perps over time — extend as needed.
};

export class DriftClient {
  private lastCallMs = 0;

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastCallMs;
    if (elapsed < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - elapsed));
    }
    this.lastCallMs = Date.now();
  }

  /** Fetch all available funding-rate samples for a market. */
  async fetchFundingRates(market: string): Promise<FundingRateSample[]> {
    await this.throttle();
    const url = `${DRIFT_BASE}/funding-rates/${market}`;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Drift ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = (await r.json()) as DriftFundingResponse;
    const rows = json.fundingRates ?? json.data ?? [];

    const out: FundingRateSample[] = [];
    for (const row of rows) {
      if (row.ts === undefined || row.fundingRate === undefined) continue;
      const tMs = typeof row.ts === 'string'
        ? parseInt(row.ts, 10) * 1000
        : (row.ts > 1e12 ? row.ts : row.ts * 1000); // sec → ms if needed
      const rate = typeof row.fundingRate === 'string'
        ? parseFloat(row.fundingRate)
        : row.fundingRate;
      if (!Number.isFinite(tMs) || !Number.isFinite(rate)) continue;
      out.push({ market, t: tMs, rate });
    }
    return out.sort((a, b) => a.t - b.t);
  }
}

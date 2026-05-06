/**
 * CoinGecko historical data client. Free, no API key required, but
 * heavily rate-limited (≈30 req/min from a single IP, sometimes lower).
 *
 * Used as a fallback when Birdeye lacks data or the free-tier quota is hit.
 *
 * Endpoint: GET /coins/{id}/market_chart/range?vs_currency=usd&from=&to=
 *   Returns: { prices: [[ms, price], ...], market_caps: [...], total_volumes: [...] }
 *
 * Resolution depends on range size:
 *   - 1 day  → ~5-min granularity
 *   - 2-90d  → hourly
 *   - >90d   → daily
 *
 * No control over resolution — it's inferred from the date range. So we
 * choose the range size we send to match our desired resolution.
 *
 * Note: CoinGecko returns prices as a stream of {t, price} samples, not full
 * OHLCV bars. We synthesize bars from the closest-resolution samples.
 */
import type { OHLCVBar, Resolution } from './types';
import { BAR_MS } from './types';

const CG_BASE = process.env.COINGECKO_API_URL ?? 'https://api.coingecko.com/api/v3';

/** CoinGecko coin IDs for our universe + common pairs. */
export const COINGECKO_ID: Record<string, string> = {
  SOL:  'solana',
  USDC: 'usd-coin',
  USDT: 'tether',
  JUP:  'jupiter-exchange-solana',
  JTO:  'jito-governance-token',
  BONK: 'bonk',
  WIF:  'dogwifcoin',
  BTC:  'bitcoin',
  ETH:  'ethereum',
};

interface CoinGeckoMarketChart {
  prices: Array<[number, number]>;        // [unix_ms, price]
  market_caps: Array<[number, number]>;
  total_volumes: Array<[number, number]>; // [unix_ms, volume_usd]
}

export class CoinGeckoClient {
  private apiKey: string;
  private lastCallMs = 0;

  constructor(apiKey?: string) {
    // Optional Pro / Demo key. Free public tier works without one but is slower.
    this.apiKey = apiKey ?? process.env.COINGECKO_API_KEY ?? '';
  }

  private async throttle(): Promise<void> {
    // Free tier: ≥2.5s between calls is safe (~24 req/min worst case).
    const minMs = this.apiKey ? 600 : 2500;
    const elapsed = Date.now() - this.lastCallMs;
    if (elapsed < minMs) {
      await new Promise((r) => setTimeout(r, minMs - elapsed));
    }
    this.lastCallMs = Date.now();
  }

  /**
   * Fetch synthesized OHLCV bars for [fromMs, toMs] at requested resolution.
   * CG only provides price points, so we bucket them into bars.
   */
  async fetchOHLCV(
    symbol: string,
    resolution: Resolution,
    fromMs: number,
    toMs: number,
  ): Promise<OHLCVBar[]> {
    const cgId = COINGECKO_ID[symbol.toUpperCase()];
    if (!cgId) throw new Error(`No CoinGecko ID mapping for ${symbol}`);

    await this.throttle();
    const url = new URL(`${CG_BASE}/coins/${cgId}/market_chart/range`);
    url.searchParams.set('vs_currency', 'usd');
    url.searchParams.set('from', String(Math.floor(fromMs / 1000)));
    url.searchParams.set('to', String(Math.ceil(toMs / 1000)));
    if (this.apiKey) url.searchParams.set('x_cg_demo_api_key', this.apiKey);

    const r = await fetch(url, {
      headers: { accept: 'application/json' },
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`CoinGecko ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = (await r.json()) as CoinGeckoMarketChart;

    return bucketIntoBars(json.prices, json.total_volumes, BAR_MS[resolution]);
  }
}

/**
 * Bucket sparse price/volume samples into fixed-size OHLCV bars.
 * Each bar's open = first sample, high = max, low = min, close = last sample,
 * volume = sum of total_volumes that fall in the bucket.
 */
function bucketIntoBars(
  prices: Array<[number, number]>,
  volumes: Array<[number, number]>,
  barMs: number,
): OHLCVBar[] {
  if (prices.length === 0) return [];

  // Build a bucket-key → samples map
  const priceBuckets = new Map<number, number[]>();
  for (const [t, p] of prices) {
    const k = Math.floor(t / barMs) * barMs;
    if (!priceBuckets.has(k)) priceBuckets.set(k, []);
    priceBuckets.get(k)!.push(p);
  }
  const volumeBuckets = new Map<number, number>();
  for (const [t, v] of volumes) {
    const k = Math.floor(t / barMs) * barMs;
    volumeBuckets.set(k, (volumeBuckets.get(k) ?? 0) + v);
  }

  const out: OHLCVBar[] = [];
  for (const [t, samples] of [...priceBuckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (samples.length === 0) continue;
    out.push({
      t,
      o: samples[0],
      h: Math.max(...samples),
      l: Math.min(...samples),
      c: samples[samples.length - 1],
      v: volumeBuckets.get(t) ?? 0,
    });
  }
  return out;
}

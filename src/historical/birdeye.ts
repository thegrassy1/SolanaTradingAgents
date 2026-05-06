/**
 * Birdeye OHLCV client. Primary historical data source for our universe.
 *
 * Free tier: requires registering at https://bds.birdeye.so/
 * for an API key (BIRDEYE_API_KEY). 30 req/min, ~1k req/day on free.
 *
 * Endpoint: GET /defi/ohlcv
 *   Params: address (token mint), type (resolution), time_from, time_to (unix sec)
 *   Headers: X-API-KEY, x-chain: solana
 *
 * The Birdeye `/defi/ohlcv` endpoint can return at most ~1000 bars per call,
 * so for long ranges we paginate by chunking the time window.
 */
import type { OHLCVBar, Resolution } from './types';
import { BAR_MS } from './types';

const BIRDEYE_BASE = process.env.BIRDEYE_API_URL ?? 'https://public-api.birdeye.so';

/** Birdeye's resolution strings differ slightly from ours. */
const BIRDEYE_TYPE: Record<Resolution, string> = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '1h':  '1H',
  '4h':  '4H',
  '1d':  '1D',
};

/** Max bars returned per Birdeye call (empirical, sometimes lower in practice). */
const BIRDEYE_MAX_BARS_PER_CALL = 900;

interface BirdeyeRow {
  unixTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  type?: string;
  address?: string;
}

interface BirdeyeResponse {
  success?: boolean;
  data?: { items?: BirdeyeRow[] } | null;
  message?: string;
}

export class BirdeyeClient {
  private apiKey: string;
  private lastCallMs = 0;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.BIRDEYE_API_KEY ?? '';
    if (!this.apiKey) {
      console.warn(
        '[BIRDEYE] No BIRDEYE_API_KEY set. Free tier still requires registration. Get one at https://bds.birdeye.so/',
      );
    }
  }

  /** Naive rate-limit guard: max 30 req/min => ≥2s between calls. */
  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastCallMs;
    if (elapsed < 2100) {
      await new Promise((r) => setTimeout(r, 2100 - elapsed));
    }
    this.lastCallMs = Date.now();
  }

  /**
   * Fetch OHLCV for [fromMs, toMs]. Auto-paginates if range > max bars/call.
   * Returns bars sorted ascending by timestamp.
   */
  async fetchOHLCV(
    mintAddress: string,
    resolution: Resolution,
    fromMs: number,
    toMs: number,
  ): Promise<OHLCVBar[]> {
    if (!this.apiKey) throw new Error('BIRDEYE_API_KEY required');
    const barMs = BAR_MS[resolution];
    const maxRangeMs = BIRDEYE_MAX_BARS_PER_CALL * barMs;
    const out: OHLCVBar[] = [];

    let cursor = fromMs;
    while (cursor <= toMs) {
      const chunkEnd = Math.min(cursor + maxRangeMs, toMs);
      const bars = await this.fetchOHLCVChunk(mintAddress, resolution, cursor, chunkEnd);
      out.push(...bars);
      cursor = chunkEnd + 1;
    }
    // Dedupe + sort
    const seen = new Map<number, OHLCVBar>();
    for (const b of out) seen.set(b.t, b);
    return [...seen.values()].sort((a, b) => a.t - b.t);
  }

  /** Single API call. */
  private async fetchOHLCVChunk(
    mintAddress: string,
    resolution: Resolution,
    fromMs: number,
    toMs: number,
  ): Promise<OHLCVBar[]> {
    await this.throttle();
    const url = new URL(`${BIRDEYE_BASE}/defi/ohlcv`);
    url.searchParams.set('address', mintAddress);
    url.searchParams.set('type', BIRDEYE_TYPE[resolution]);
    url.searchParams.set('time_from', String(Math.floor(fromMs / 1000)));
    url.searchParams.set('time_to', String(Math.floor(toMs / 1000)));

    const r = await fetch(url, {
      headers: {
        'X-API-KEY': this.apiKey,
        'x-chain': 'solana',
        'accept': 'application/json',
      },
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Birdeye ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = (await r.json()) as BirdeyeResponse;
    if (!json.success || !json.data?.items) {
      throw new Error(`Birdeye failure: ${json.message ?? JSON.stringify(json).slice(0, 200)}`);
    }
    return json.data.items.map((row) => ({
      t: row.unixTime * 1000,
      o: row.o,
      h: row.h,
      l: row.l,
      c: row.c,
      v: row.v ?? 0,
    }));
  }
}

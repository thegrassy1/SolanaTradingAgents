/**
 * Binance public klines client. Free, no API key required.
 *
 * This is our PRIMARY OHLCV source — it covers all 5 of our universe
 * symbols (SOL, JUP, JTO, BONK, WIF), has minute-level data going back years,
 * is fast (~50ms per call), and the rate limit is generous (1200 weight/min,
 * klines = 1 weight/call returning up to 1000 bars).
 *
 * Default URL is `data-api.binance.vision` — Binance's globally-accessible
 * read-only market-data mirror. The main `api.binance.com` endpoint is
 * geo-blocked in some regions (US, UK, etc.) with HTTP 451; the .vision
 * mirror works in all the regions we've tested.
 *
 * Endpoint: GET /api/v3/klines
 *   Params: symbol (e.g. SOLUSDT), interval (e.g. 1h), startTime/endTime (ms),
 *           limit (max 1000)
 *   Returns: [[openTime, open, high, low, close, volume, closeTime, ...], ...]
 *
 * Override via BINANCE_API_URL env var if needed.
 */
import type { OHLCVBar, Resolution } from './types';
import { BAR_MS } from './types';

const BINANCE_BASE = process.env.BINANCE_API_URL ?? 'https://data-api.binance.vision';

/** Map our universe tickers to Binance trading pairs (always vs. USDT). */
export const BINANCE_SYMBOL: Record<string, string> = {
  SOL:  'SOLUSDT',
  JUP:  'JUPUSDT',
  JTO:  'JTOUSDT',
  BONK: 'BONKUSDT',
  WIF:  'WIFUSDT',
  BTC:  'BTCUSDT',
  ETH:  'ETHUSDT',
};

/** Binance interval strings. Same format we use except hours are lowercase. */
const BINANCE_INTERVAL: Record<Resolution, string> = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d',
};

const BINANCE_MAX_BARS_PER_CALL = 1000;

export class BinanceClient {
  private lastCallMs = 0;

  /** Polite client-side throttle. Binance's real limit is 1200/min, this is loose. */
  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastCallMs;
    if (elapsed < 100) {
      await new Promise((r) => setTimeout(r, 100 - elapsed));
    }
    this.lastCallMs = Date.now();
  }

  /**
   * Fetch OHLCV bars for [fromMs, toMs]. Auto-paginates if range exceeds
   * the per-call limit. Returns sorted ascending, deduped by openTime.
   */
  async fetchOHLCV(
    symbol: string,
    resolution: Resolution,
    fromMs: number,
    toMs: number,
  ): Promise<OHLCVBar[]> {
    const pair = BINANCE_SYMBOL[symbol.toUpperCase()];
    if (!pair) throw new Error(`No Binance pair mapping for ${symbol}`);
    const interval = BINANCE_INTERVAL[resolution];
    const barMs = BAR_MS[resolution];
    const out: OHLCVBar[] = [];

    let cursor = fromMs;
    while (cursor <= toMs) {
      const chunkEnd = Math.min(cursor + BINANCE_MAX_BARS_PER_CALL * barMs, toMs);
      const chunk = await this.fetchKlinesChunk(pair, interval, cursor, chunkEnd);
      if (chunk.length === 0) break;
      out.push(...chunk);
      // Advance cursor past last returned bar (Binance returns inclusive ranges)
      const lastT = chunk[chunk.length - 1].t;
      const nextT = lastT + barMs;
      if (nextT <= cursor) break; // safety: no progress, bail
      cursor = nextT;
    }

    // Dedupe + sort
    const seen = new Map<number, OHLCVBar>();
    for (const b of out) seen.set(b.t, b);
    return [...seen.values()].sort((a, b) => a.t - b.t);
  }

  private async fetchKlinesChunk(
    pair: string,
    interval: string,
    fromMs: number,
    toMs: number,
  ): Promise<OHLCVBar[]> {
    await this.throttle();
    const url = new URL(`${BINANCE_BASE}/api/v3/klines`);
    url.searchParams.set('symbol', pair);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(fromMs));
    url.searchParams.set('endTime', String(toMs));
    url.searchParams.set('limit', String(BINANCE_MAX_BARS_PER_CALL));

    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Binance ${r.status}: ${body.slice(0, 200)}`);
    }
    const rows = (await r.json()) as Array<
      [number, string, string, string, string, string, number, string, number, string, string, string]
    >;
    return rows.map((row) => ({
      t: row[0], // openTime in ms
      o: parseFloat(row[1]),
      h: parseFloat(row[2]),
      l: parseFloat(row[3]),
      c: parseFloat(row[4]),
      v: parseFloat(row[7]), // quote volume in USDT (more useful than base volume)
    }));
  }
}

/**
 * Unified historical data fetcher.
 *
 * Process-lifetime cache of "this gap recently failed to fill" so we don't
 * re-hammer rate-limited APIs across many backtests in the same sweep.
 */
const FAILED_GAP_RETRY_MS = 60_000;
const recentFailures = new Map<string, number>();
function gapKey(symbol: string, resolution: string, fromMs: number, toMs: number): string {
  return `${symbol}|${resolution}|${fromMs}|${toMs}`;
}

/**
 * Original fetcher comment continues below.
 *
 * Public API: `getHistoricalBars(symbol, resolution, fromMs, toMs)`
 *
 * Strategy:
 *  1. Read what we have from local SQLite cache (data/historical.db)
 *  2. Find gaps in coverage
 *  3. Fill gaps from Birdeye (primary), CoinGecko (fallback)
 *  4. Persist newly fetched data
 *  5. Return merged, deduped, sorted bars for the requested range
 *
 * Sources are pluggable — in tests we can swap Birdeye for a mock.
 */
import type { OHLCVBar, Resolution } from './types';
import { BAR_MS } from './types';
import { BirdeyeClient } from './birdeye';
import { CoinGeckoClient } from './coingecko';
import { findGaps, insertBars, readBars } from './db';
import { getSymbolByTicker } from '../symbols';

export interface FetchOptions {
  /** Skip Birdeye even if API key is available. */
  skipBirdeye?: boolean;
  /** Skip CoinGecko fallback. */
  skipCoinGecko?: boolean;
  /** Force re-fetch (ignore cache). For data-quality re-runs. */
  forceRefetch?: boolean;
  /** Inject pre-built clients (testing). */
  birdeye?: BirdeyeClient;
  coingecko?: CoinGeckoClient;
}

export interface FetchResult {
  bars: OHLCVBar[];
  fromCache: number;
  fromBirdeye: number;
  fromCoinGecko: number;
}

/**
 * Get OHLCV bars for [fromMs, toMs] at the given resolution.
 * Auto-fetches missing data from external sources and caches it.
 *
 * `symbol` is a ticker (SOL, JUP, etc.) — looked up against our universe
 * for the mint address (Birdeye needs the mint, CoinGecko needs the slug).
 */
export async function getHistoricalBars(
  symbol: string,
  resolution: Resolution,
  fromMs: number,
  toMs: number,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const sym = symbol.toUpperCase();
  const result: FetchResult = { bars: [], fromCache: 0, fromBirdeye: 0, fromCoinGecko: 0 };

  if (!opts.forceRefetch) {
    const cached = readBars({ symbol: sym, resolution, fromMs, toMs });
    result.fromCache = cached.length;
  }

  const barMs = BAR_MS[resolution];
  const gaps = opts.forceRefetch
    ? [{ fromMs, toMs }]
    : findGaps({ symbol: sym, resolution, fromMs, toMs }, barMs, barMs * 5);

  // Fill gaps from external sources, with recent-failure dedup
  for (const gap of gaps) {
    const key = gapKey(sym, resolution, gap.fromMs, gap.toMs);
    const lastFail = recentFailures.get(key);
    if (lastFail && Date.now() - lastFail < FAILED_GAP_RETRY_MS) {
      // Recently failed — don't retry yet, use what we have in cache
      continue;
    }
    const newBars = await fetchGap(sym, resolution, gap.fromMs, gap.toMs, opts, result);
    if (newBars.length > 0) {
      insertBars(sym, resolution, newBars, 'mixed');
      recentFailures.delete(key);
    } else {
      recentFailures.set(key, Date.now());
    }
  }

  // Read merged result (cache + newly fetched)
  result.bars = readBars({ symbol: sym, resolution, fromMs, toMs });
  return result;
}

async function fetchGap(
  symbol: string,
  resolution: Resolution,
  fromMs: number,
  toMs: number,
  opts: FetchOptions,
  result: FetchResult,
): Promise<OHLCVBar[]> {
  // Try Birdeye first (it has the mint, gives us volume natively)
  if (!opts.skipBirdeye) {
    try {
      const symInfo = getSymbolByTicker(symbol);
      if (!symInfo) throw new Error(`No mint mapping for ${symbol}`);
      const client = opts.birdeye ?? new BirdeyeClient();
      const bars = await client.fetchOHLCV(symInfo.mint, resolution, fromMs, toMs);
      if (bars.length > 0) {
        result.fromBirdeye += bars.length;
        console.log(`[HIST] ${symbol} ${resolution}: birdeye returned ${bars.length} bars`);
        return bars;
      }
    } catch (e) {
      console.warn(`[HIST] ${symbol} ${resolution}: birdeye failed (${(e as Error).message}); falling back`);
    }
  }
  if (!opts.skipCoinGecko) {
    try {
      const client = opts.coingecko ?? new CoinGeckoClient();
      const bars = await client.fetchOHLCV(symbol, resolution, fromMs, toMs);
      if (bars.length > 0) {
        result.fromCoinGecko += bars.length;
        console.log(`[HIST] ${symbol} ${resolution}: coingecko returned ${bars.length} bars`);
        return bars;
      }
    } catch (e) {
      console.warn(`[HIST] ${symbol} ${resolution}: coingecko failed (${(e as Error).message})`);
    }
  }
  return [];
}

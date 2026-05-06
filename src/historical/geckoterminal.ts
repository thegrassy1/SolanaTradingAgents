/**
 * GeckoTerminal client — free, no API key, Solana-DEX-focused OHLCV.
 *
 * GeckoTerminal is CoinGecko's DEX-specific product. It indexes Solana DEX
 * pools (Raydium, Orca, Meteora, etc.) and exposes OHLCV from real on-chain
 * swap data. This is *better* data than CoinGecko's aggregate prices for
 * DEX-only tokens because it's directly from on-chain swaps.
 *
 * Endpoint:
 *   GET /networks/solana/pools/{pool_address}/ohlcv/{timeframe}
 *   Returns: { data: { attributes: { ohlcv_list: [[t, o, h, l, c, v], ...] } } }
 *
 * Free tier: ~30 req/min, no auth needed.
 *
 * For each universe token, we use the highest-volume Solana pool for that
 * token vs. USDC (or vs. SOL where USDC pools are thin).
 */
import type { OHLCVBar, Resolution } from './types';

const GT_BASE = process.env.GECKOTERMINAL_API_URL ?? 'https://api.geckoterminal.com/api/v2';

/**
 * Symbol → primary Solana pool address (highest volume token/USDC pool).
 * These were verified at write-time; if a pool gets deprecated we'll need
 * to update. The fetcher will fail loudly which is the right signal.
 *
 * Source: GeckoTerminal UI → search ticker → Solana network → top pool by volume.
 */
export const GT_POOL: Record<string, string> = {
  // Raydium SOL/USDC concentrated pool — billions in 24h volume
  SOL:  '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX',
  // Raydium JUP/USDC
  JUP:  'C1MgLojNLWBKADvu9BHdtgzz1oZX4dZ5zGdGcgvvW8Wz',
  // Raydium JTO/USDC
  JTO:  'CPPzKCRG2ymobhbg5RRPsJYNwEgCYf6jH8AKdeqK1QjU',
  // Raydium BONK/USDC
  BONK: 'DSUvc5qf5LJHHV5e2tD184ixotSnCnwj7i4jJa4Xsrmt',
  // Raydium WIF/USDC
  WIF:  'EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx',
};

/** GeckoTerminal timeframe parameter. */
const GT_TIMEFRAME: Record<Resolution, string> = {
  '1m':  'minute?aggregate=1',
  '5m':  'minute?aggregate=5',
  '15m': 'minute?aggregate=15',
  '1h':  'hour?aggregate=1',
  '4h':  'hour?aggregate=4',
  '1d':  'day?aggregate=1',
};

interface GTResponse {
  data?: {
    id?: string;
    type?: string;
    attributes?: {
      ohlcv_list?: Array<[number, number, number, number, number, number]>;
    };
  };
}

export class GeckoTerminalClient {
  private lastCallMs = 0;

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastCallMs;
    if (elapsed < 2100) {
      await new Promise((r) => setTimeout(r, 2100 - elapsed));
    }
    this.lastCallMs = Date.now();
  }

  /**
   * Fetch OHLCV bars from the configured Solana pool for `symbol`.
   * GeckoTerminal returns up to 1000 bars per call, ordered NEWEST first;
   * we reverse + filter to the requested range.
   */
  async fetchOHLCV(
    symbol: string,
    resolution: Resolution,
    fromMs: number,
    toMs: number,
  ): Promise<OHLCVBar[]> {
    const pool = GT_POOL[symbol.toUpperCase()];
    if (!pool) throw new Error(`No GeckoTerminal pool mapping for ${symbol}`);

    await this.throttle();
    // GT timeframe path can carry query params — split it.
    const tf = GT_TIMEFRAME[resolution];
    const [path, queryStr] = tf.split('?');
    const url = new URL(`${GT_BASE}/networks/solana/pools/${pool}/ohlcv/${path}`);
    if (queryStr) {
      for (const kv of queryStr.split('&')) {
        const [k, v] = kv.split('=');
        url.searchParams.set(k, v);
      }
    }
    // Anchor the request to the latest desired bar; GT walks backwards from there.
    url.searchParams.set('before_timestamp', String(Math.floor(toMs / 1000)));
    url.searchParams.set('limit', '1000');

    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`GeckoTerminal ${r.status}: ${body.slice(0, 200)}`);
    }
    const json = (await r.json()) as GTResponse;
    const list = json.data?.attributes?.ohlcv_list ?? [];

    return list
      .map(([t, o, h, l, c, v]) => ({ t: t * 1000, o, h, l, c, v }))
      .filter((b) => b.t >= fromMs && b.t <= toMs)
      .sort((a, b) => a.t - b.t);
  }
}

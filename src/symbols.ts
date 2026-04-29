/**
 * Symbol registry — defines the universe of tokens the agent watches.
 *
 * Adding a token: append to UNIVERSE. The agent will pick it up on next restart.
 * Disabling without removing: set `enabled: false`.
 */

export type Sector = 'l1' | 'defi' | 'meme' | 'ai' | 'depin' | 'gaming' | 'stable';

export interface SymbolInfo {
  /** SPL mint address */
  mint: string;
  /** Display ticker (SOL, JUP, JTO, ...) */
  symbol: string;
  /** SPL decimals */
  decimals: number;
  /** Human label for the dashboard */
  displayName: string;
  /** Sector, used for portfolio risk gates (no two open positions in same sector) */
  sector: Sector;
  /** Whether the agent should monitor + trade this symbol */
  enabled: boolean;
  /** Whether this symbol is routable on Jupiter (spot trading) */
  spotEnabled: boolean;
  /** Drift perp market index, if listed. Undefined means no perp market. */
  driftMarketIndex?: number;
  /**
   * The amount (in raw input units) used for price quotes.
   * For low-priced tokens like BONK, larger amounts give more accurate quotes.
   */
  quoteAmountRaw: bigint;
}

/** Quote currency — every symbol is priced against this. */
export const QUOTE = {
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  symbol: 'USDC',
  decimals: 6,
} as const;

/** Helper: Solana wrapped-SOL native mint. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * The trading universe.
 *
 * NOTE on Drift market indices (as of 2026-04):
 *   0 = SOL, 1 = BTC, 2 = ETH, 3 = APT, ..., specific indices vary by deployment.
 *   Verify against DriftClient.getPerpMarketAccount() before going live on perps.
 */
export const UNIVERSE: SymbolInfo[] = [
  {
    mint: SOL_MINT,
    symbol: 'SOL',
    decimals: 9,
    displayName: 'Solana',
    sector: 'l1',
    enabled: true,
    spotEnabled: true,
    driftMarketIndex: 0,
    quoteAmountRaw: 1_000_000_000n, // 1 SOL
  },
  {
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    symbol: 'JUP',
    decimals: 6,
    displayName: 'Jupiter',
    sector: 'defi',
    enabled: true,
    spotEnabled: true,
    quoteAmountRaw: 1_000_000_000n, // 1000 JUP
  },
  {
    mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    symbol: 'JTO',
    decimals: 9,
    displayName: 'Jito',
    sector: 'defi',
    enabled: true,
    spotEnabled: true,
    quoteAmountRaw: 100_000_000_000n, // 100 JTO
  },
  {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK',
    decimals: 5,
    displayName: 'Bonk',
    sector: 'meme',
    enabled: true,
    spotEnabled: true,
    quoteAmountRaw: 1_000_000_000_000n, // 10M BONK
  },
  {
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    symbol: 'WIF',
    decimals: 6,
    displayName: 'dogwifhat',
    sector: 'meme',
    enabled: true,
    spotEnabled: true,
    quoteAmountRaw: 1_000_000_000n, // 1000 WIF
  },
];

/** Returns enabled symbols only. */
export function getActiveUniverse(): SymbolInfo[] {
  return UNIVERSE.filter((s) => s.enabled);
}

export function getSymbolByMint(mint: string): SymbolInfo | undefined {
  return UNIVERSE.find((s) => s.mint === mint);
}

export function getSymbolByTicker(ticker: string): SymbolInfo | undefined {
  const t = ticker.toUpperCase();
  return UNIVERSE.find((s) => s.symbol === t);
}

/** All mints in the active universe (for DB queries, etc.). */
export function getActiveMints(): string[] {
  return getActiveUniverse().map((s) => s.mint);
}

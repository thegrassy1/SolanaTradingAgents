/**
 * Legacy token info — kept for backwards compat with existing imports.
 *
 * The source of truth for the trading universe is now `symbols.ts`.
 * This file re-exports a flat lookup map for the few callers that just
 * need decimals/symbol from a mint string (e.g. price.ts, paper.ts).
 */
import { UNIVERSE, QUOTE } from './symbols';

export const TOKEN_INFO: Record<string, { symbol: string; decimals: number }> = {
  // Quote currency
  [QUOTE.mint]: { symbol: QUOTE.symbol, decimals: QUOTE.decimals },
  // USDT — stable, kept as a known quote alternate
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  // All universe symbols
  ...Object.fromEntries(
    UNIVERSE.map((s) => [s.mint, { symbol: s.symbol, decimals: s.decimals }]),
  ),
};

export function getTokenDecimals(mint: string): number {
  return TOKEN_INFO[mint]?.decimals ?? 9;
}

export function getTokenSymbol(mint: string): string {
  return TOKEN_INFO[mint]?.symbol ?? mint.slice(0, 4);
}

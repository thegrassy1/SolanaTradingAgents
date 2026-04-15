export const TOKEN_INFO: Record<string, { symbol: string; decimals: number }> = {
  So11111111111111111111111111111111111111112: { symbol: 'SOL', decimals: 9 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
};

export function getTokenDecimals(mint: string): number {
  return TOKEN_INFO[mint]?.decimals ?? 9;
}

export function getTokenSymbol(mint: string): string {
  return TOKEN_INFO[mint]?.symbol ?? mint.slice(0, 4);
}

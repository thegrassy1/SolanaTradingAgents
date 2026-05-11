/**
 * Data refresher — pulls latest bars for all active universe symbols so
 * the backtester is always working with fresh history. Runs hourly.
 *
 * Resolves to the same multi-source fallback chain we use for backtests:
 *   Binance → GeckoTerminal → CoinGecko → (Birdeye if opted-in)
 */
import { getActiveUniverse } from '../symbols';
import { getHistoricalBars } from '../historical/fetcher';
import { FLYWHEEL_POLICY } from './types';

const REFRESH_TAIL_HOURS = 4;

export async function runDataRefresh(): Promise<void> {
  const now = Date.now();
  const fromMs = now - REFRESH_TAIL_HOURS * 60 * 60_000;
  for (const sym of getActiveUniverse()) {
    try {
      const r = await getHistoricalBars(sym.symbol, FLYWHEEL_POLICY.resolution, fromMs, now);
      const newBars = r.fromBinance + r.fromGeckoTerminal + r.fromCoinGecko + r.fromBirdeye;
      if (newBars > 0) {
        console.log(`[FLYWHEEL][refresh] ${sym.symbol}: +${newBars} new bars cached`);
      }
    } catch (e) {
      console.warn(`[FLYWHEEL][refresh] ${sym.symbol} failed: ${(e as Error).message}`);
    }
  }
}

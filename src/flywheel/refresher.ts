/**
 * Data refresher — pulls latest bars for all active universe symbols so
 * the backtester is always working with fresh history. Runs hourly.
 *
 * Resolves to the same multi-source fallback chain we use for backtests:
 *   Binance → GeckoTerminal → CoinGecko → (Birdeye if opted-in)
 */
import { getActiveUniverse } from '../symbols';
import { getHistoricalBars } from '../historical/fetcher';
import type { Resolution } from '../historical/types';

// Refresh windows tuned per resolution so we always have fresh tail data.
// 1h needs short tail (one missed bar per hour); 1d only needs the last week.
const REFRESH_WINDOWS: Array<{ res: Resolution; hoursBack: number }> = [
  { res: '1h', hoursBack: 4 },
  { res: '4h', hoursBack: 24 },
  { res: '1d', hoursBack: 7 * 24 },
];

export async function runDataRefresh(): Promise<void> {
  const now = Date.now();
  for (const sym of getActiveUniverse()) {
    for (const { res, hoursBack } of REFRESH_WINDOWS) {
      try {
        const fromMs = now - hoursBack * 60 * 60_000;
        const r = await getHistoricalBars(sym.symbol, res, fromMs, now);
        const newBars = r.fromBinance + r.fromGeckoTerminal + r.fromCoinGecko + r.fromBirdeye;
        if (newBars > 0) {
          console.log(`[FLYWHEEL][refresh] ${sym.symbol} ${res}: +${newBars} new bars cached`);
        }
      } catch (e) {
        console.warn(`[FLYWHEEL][refresh] ${sym.symbol} ${res} failed: ${(e as Error).message}`);
      }
    }
  }
}

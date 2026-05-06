/**
 * CLI for downloading historical OHLCV + funding data into the local cache.
 *
 * Usage:
 *   npm run hist:fetch -- --symbol SOL --resolution 1h --from 2024-01-01 --to 2026-04-29
 *   npm run hist:fetch -- --all --resolution 1h --from 2024-01-01
 *   npm run hist:funding -- --market SOL-PERP
 *
 * Without --to, defaults to "now". Without --from, defaults to 90 days ago.
 */
import { getActiveUniverse } from '../symbols';
import { getHistoricalBars } from './fetcher';
import { DriftClient, DRIFT_MARKET } from './drift';
import { insertFunding, getCoverage } from './db';
import type { Resolution } from './types';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new Error(`Bad date: ${s}`);
  }
  return d;
}

async function fetchBars(args: Record<string, string | boolean>): Promise<void> {
  const resolution = (args.resolution as Resolution) ?? '1h';
  const now = new Date();
  const from = parseDate(args.from as string, new Date(now.getTime() - 90 * 86400_000));
  const to = parseDate(args.to as string, now);

  const symbols: string[] = args.all
    ? getActiveUniverse().map((s) => s.symbol)
    : [(args.symbol as string).toUpperCase()];

  if (!symbols.length || (!args.all && !args.symbol)) {
    console.error('Usage: --symbol SOL [--resolution 1h] [--from 2024-01-01] [--to 2026-04-29]');
    console.error('   or: --all   [--resolution 1h] [--from 2024-01-01] [--to 2026-04-29]');
    process.exit(1);
  }

  console.log(`[HIST] Fetching ${symbols.join(',')} @ ${resolution} from ${from.toISOString()} to ${to.toISOString()}`);

  for (const sym of symbols) {
    const before = getCoverage(sym, resolution);
    const result = await getHistoricalBars(sym, resolution, from.getTime(), to.getTime());
    const after = getCoverage(sym, resolution);

    console.log(
      `  ${sym}: ${result.bars.length} bars in range | ` +
      `cache: ${result.fromCache} → ${after.bars} (Δ${after.bars - before.bars}) | ` +
      `binance: ${result.fromBinance} | geckoterminal: ${result.fromGeckoTerminal} | ` +
      `coingecko: ${result.fromCoinGecko} | birdeye: ${result.fromBirdeye}`,
    );

    if (after.earliest && after.latest) {
      console.log(
        `         coverage: ${new Date(after.earliest).toISOString()} → ${new Date(after.latest).toISOString()}`,
      );
    }
  }
}

async function fetchFunding(args: Record<string, string | boolean>): Promise<void> {
  const markets: string[] = args.all
    ? Object.values(DRIFT_MARKET)
    : [(args.market as string)];

  if (!args.all && !args.market) {
    console.error('Usage: --market SOL-PERP');
    console.error('   or: --all  (fetch all known markets)');
    process.exit(1);
  }

  const client = new DriftClient();
  for (const mkt of markets) {
    console.log(`[HIST] Fetching Drift funding for ${mkt}…`);
    try {
      const samples = await client.fetchFundingRates(mkt);
      const inserted = insertFunding(samples);
      console.log(`  ${mkt}: ${inserted} samples saved`);
    } catch (e) {
      console.error(`  ${mkt}: failed — ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.funding) {
    await fetchFunding(args);
  } else {
    await fetchBars(args);
  }
}

void main().catch((e) => {
  console.error('[HIST] fatal:', e);
  process.exit(1);
});

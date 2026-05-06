/**
 * Local SQLite cache for historical OHLCV + funding data.
 *
 * Separate file (`data/historical.db`) so backtest data doesn't bloat the
 * live trades.db. Schema is append-only with composite primary keys for
 * idempotent re-fetching.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { OHLCVBar, Resolution, FundingRateSample } from './types';

const DATA_DIR = path.join(process.cwd(), 'data');
const HIST_DB_PATH = path.join(DATA_DIR, 'historical.db');

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  dbInstance = new Database(HIST_DB_PATH);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('synchronous = NORMAL');
  initSchema(dbInstance);
  return dbInstance;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ohlcv (
      symbol     TEXT NOT NULL,
      resolution TEXT NOT NULL,
      t          INTEGER NOT NULL,
      o          REAL,
      h          REAL,
      l          REAL,
      c          REAL,
      v          REAL,
      source     TEXT,
      PRIMARY KEY (symbol, resolution, t)
    );

    CREATE INDEX IF NOT EXISTS idx_ohlcv_lookup
      ON ohlcv(symbol, resolution, t);

    CREATE TABLE IF NOT EXISTS funding (
      market TEXT NOT NULL,
      t      INTEGER NOT NULL,
      rate   REAL,
      PRIMARY KEY (market, t)
    );

    CREATE INDEX IF NOT EXISTS idx_funding_lookup
      ON funding(market, t);
  `);
}

export interface BarRange {
  symbol: string;
  resolution: Resolution;
  fromMs: number;
  toMs: number;
}

/** Insert (or replace) a batch of OHLCV bars. */
export function insertBars(
  symbol: string,
  resolution: Resolution,
  bars: OHLCVBar[],
  source: string,
): number {
  if (bars.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ohlcv
      (symbol, resolution, t, o, h, l, c, v, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows: OHLCVBar[]) => {
    for (const b of rows) {
      stmt.run(symbol, resolution, b.t, b.o, b.h, b.l, b.c, b.v, source);
    }
  });
  tx(bars);
  return bars.length;
}

/** Read bars from cache for [fromMs, toMs] inclusive. */
export function readBars(range: BarRange): OHLCVBar[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t, o, h, l, c, v
    FROM ohlcv
    WHERE symbol = ? AND resolution = ? AND t >= ? AND t <= ?
    ORDER BY t ASC
  `).all(range.symbol, range.resolution, range.fromMs, range.toMs) as OHLCVBar[];
  return rows;
}

/**
 * Returns ranges of missing data within [fromMs, toMs] for a (symbol, resolution).
 * A "gap" is a timestamp range where no bar exists at the expected interval.
 *
 * Naive but effective: snaps fromMs/toMs to bar boundaries, walks expected
 * timestamps, returns merged contiguous gap windows.
 */
export function findGaps(
  range: BarRange,
  barMs: number,
  toleranceMs = 0,
): Array<{ fromMs: number; toMs: number }> {
  const existing = new Set<number>(
    readBars(range).map((b) => Math.round(b.t / barMs) * barMs),
  );

  const start = Math.floor(range.fromMs / barMs) * barMs;
  const end = Math.floor(range.toMs / barMs) * barMs;
  const gaps: Array<{ fromMs: number; toMs: number }> = [];
  let curStart: number | null = null;

  for (let t = start; t <= end; t += barMs) {
    if (!existing.has(t)) {
      if (curStart === null) curStart = t;
    } else if (curStart !== null) {
      gaps.push({ fromMs: curStart, toMs: t - barMs });
      curStart = null;
    }
  }
  if (curStart !== null) gaps.push({ fromMs: curStart, toMs: end });

  // Merge adjacent / near-adjacent gaps if within tolerance
  if (toleranceMs > 0 && gaps.length > 1) {
    const merged: typeof gaps = [gaps[0]];
    for (let i = 1; i < gaps.length; i++) {
      const last = merged[merged.length - 1];
      if (gaps[i].fromMs - last.toMs <= toleranceMs + barMs) {
        last.toMs = gaps[i].toMs;
      } else {
        merged.push(gaps[i]);
      }
    }
    return merged;
  }
  return gaps;
}

/** Insert funding-rate samples (idempotent). */
export function insertFunding(samples: FundingRateSample[]): number {
  if (samples.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO funding (market, t, rate) VALUES (?, ?, ?)
  `);
  const tx = db.transaction((rows: FundingRateSample[]) => {
    for (const r of rows) stmt.run(r.market, r.t, r.rate);
  });
  tx(samples);
  return samples.length;
}

export function readFunding(
  market: string, fromMs: number, toMs: number,
): FundingRateSample[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT market, t, rate FROM funding
    WHERE market = ? AND t >= ? AND t <= ?
    ORDER BY t ASC
  `).all(market, fromMs, toMs) as FundingRateSample[];
  return rows;
}

/** Coverage summary — useful for the CLI fetch script. */
export function getCoverage(symbol: string, resolution: Resolution): {
  bars: number;
  earliest: number | null;
  latest: number | null;
} {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS bars, MIN(t) AS earliest, MAX(t) AS latest
    FROM ohlcv WHERE symbol = ? AND resolution = ?
  `).get(symbol, resolution) as { bars: number; earliest: number | null; latest: number | null };
  return row;
}

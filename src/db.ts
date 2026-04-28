import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { TradeRecord } from './types';
import { config } from './config';
import { getTokenDecimals } from './tokenInfo';

export type SqliteDatabase = InstanceType<typeof Database>;

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'trades.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      mode TEXT NOT NULL,
      input_mint TEXT NOT NULL,
      output_mint TEXT NOT NULL,
      input_amount TEXT NOT NULL,
      output_amount TEXT NOT NULL,
      expected_output TEXT,
      price_impact TEXT,
      slippage_bps INTEGER,
      tx_signature TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      strategy TEXT,
      price_at_trade REAL
    );
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      input_mint TEXT NOT NULL,
      output_mint TEXT NOT NULL,
      price REAL NOT NULL,
      sma_20 REAL,
      volatility REAL
    );
    CREATE TABLE IF NOT EXISTS ai_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now')),
      action TEXT NOT NULL,
      reason TEXT,
      rationale TEXT,
      confidence INTEGER,
      price_at_decision REAL,
      candidate_signals TEXT,
      learnings_snapshot TEXT
    );
  `);
}

initDatabase();

function migrateTradesColumns(): void {
  const cols = db.prepare('PRAGMA table_info(trades)').all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const add = (name: string, ddl: string) => {
    if (!names.has(name)) {
      db.exec(ddl);
    }
  };
  add('entry_price', 'ALTER TABLE trades ADD COLUMN entry_price REAL');
  add('exit_price', 'ALTER TABLE trades ADD COLUMN exit_price REAL');
  add('exit_reason', 'ALTER TABLE trades ADD COLUMN exit_reason TEXT');
  add('realized_pnl', 'ALTER TABLE trades ADD COLUMN realized_pnl REAL');
  add(
    'realized_pnl_gross',
    'ALTER TABLE trades ADD COLUMN realized_pnl_gross REAL',
  );
  add(
    'realized_pnl_net',
    'ALTER TABLE trades ADD COLUMN realized_pnl_net REAL',
  );
  add('fees_quote', 'ALTER TABLE trades ADD COLUMN fees_quote REAL');
  add(
    'taker_fee_bps',
    'ALTER TABLE trades ADD COLUMN taker_fee_bps INTEGER',
  );
  add(
    'taker_fee_quote',
    'ALTER TABLE trades ADD COLUMN taker_fee_quote REAL',
  );
  add(
    'network_fee_lamports',
    'ALTER TABLE trades ADD COLUMN network_fee_lamports INTEGER',
  );
  add(
    'priority_fee_lamports',
    'ALTER TABLE trades ADD COLUMN priority_fee_lamports INTEGER',
  );
  add('sol_fee_quote', 'ALTER TABLE trades ADD COLUMN sol_fee_quote REAL');
}

migrateTradesColumns();

function ensureMigrationsTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function hasMigration(name: string): boolean {
  const row = db
    .prepare('SELECT 1 AS found FROM migrations WHERE name = ?')
    .get(name) as { found: number } | undefined;
  return !!row;
}

function recordMigration(name: string): void {
  db.prepare("INSERT OR IGNORE INTO migrations (name) VALUES (?)").run(name);
}

function normalizeStrategyNames(): void {
  const MIGRATION = 'normalize_strategy_names_v1';
  ensureMigrationsTable();
  if (hasMigration(MIGRATION)) return;

  // Old rows may have NULL, '', or the short name 'mean_reversion'
  const result = db
    .prepare(
      `UPDATE trades
       SET strategy = 'mean_reversion_v1'
       WHERE strategy IS NULL OR strategy = '' OR strategy = 'mean_reversion'`,
    )
    .run();

  if (result.changes > 0) {
    console.log(
      `[DB] Migration ${MIGRATION}: normalized ${result.changes} rows to strategy='mean_reversion_v1'`,
    );
  }
  recordMigration(MIGRATION);
}

normalizeStrategyNames();

function tradeUsdValue(
  mint: string,
  amountStr: string,
  priceSolUsdc: number | null,
): number | null {
  if (priceSolUsdc === null) return null;
  const decimals = getTokenDecimals(mint);
  const raw = BigInt(amountStr);
  const human = Number(raw) / 10 ** decimals;
  if (mint === config.baseMint) return human * priceSolUsdc;
  if (mint === config.quoteMint) return human;
  return null;
}

export function logTrade(trade: TradeRecord): void {
  const stmt = db.prepare(`
    INSERT INTO trades (
      timestamp, mode, input_mint, output_mint, input_amount, output_amount,
      expected_output, price_impact, slippage_bps, tx_signature, status,
      error_message, strategy, price_at_trade,
      entry_price, exit_price, exit_reason, realized_pnl,
      realized_pnl_gross, realized_pnl_net, fees_quote,
      taker_fee_bps, taker_fee_quote,
      network_fee_lamports, priority_fee_lamports, sol_fee_quote
    ) VALUES (
      @timestamp, @mode, @input_mint, @output_mint, @input_amount, @output_amount,
      @expected_output, @price_impact, @slippage_bps, @tx_signature, @status,
      @error_message, @strategy, @price_at_trade,
      @entry_price, @exit_price, @exit_reason, @realized_pnl,
      @realized_pnl_gross, @realized_pnl_net, @fees_quote,
      @taker_fee_bps, @taker_fee_quote,
      @network_fee_lamports, @priority_fee_lamports, @sol_fee_quote
    )
  `);
  stmt.run({
    timestamp: trade.timestamp,
    mode: trade.mode,
    input_mint: trade.inputMint,
    output_mint: trade.outputMint,
    input_amount: trade.inputAmount,
    output_amount: trade.outputAmount,
    expected_output: trade.expectedOutput ?? null,
    price_impact: trade.priceImpact ?? null,
    slippage_bps: trade.slippageBps ?? null,
    tx_signature: trade.txSignature,
    status: trade.status,
    error_message: trade.errorMessage ?? null,
    strategy: trade.strategy ?? null,
    price_at_trade: trade.priceAtTrade ?? null,
    entry_price: trade.entryPrice ?? null,
    exit_price: trade.exitPrice ?? null,
    exit_reason: trade.exitReason ?? null,
    realized_pnl: trade.realizedPnl ?? null,
    realized_pnl_gross: trade.realizedPnlGross ?? trade.realizedPnl ?? null,
    realized_pnl_net: trade.realizedPnlNet ?? null,
    fees_quote: trade.feesQuote ?? null,
    taker_fee_bps: trade.takerFeeBps ?? null,
    taker_fee_quote: trade.takerFeeQuote ?? null,
    network_fee_lamports: trade.networkFeeLamports ?? null,
    priority_fee_lamports: trade.priorityFeeLamports ?? null,
    sol_fee_quote: trade.solFeeQuote ?? null,
  });
}

export function logPrice(
  inputMint: string,
  outputMint: string,
  price: number,
  sma20: number,
  volatility?: number,
): void {
  const stmt = db.prepare(`
    INSERT INTO price_snapshots (input_mint, output_mint, price, sma_20, volatility)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(inputMint, outputMint, price, sma20, volatility ?? null);
}

export type DbTradeRow = {
  id: number;
  timestamp: string;
  mode: string;
  input_mint: string;
  output_mint: string;
  input_amount: string;
  output_amount: string;
  expected_output: string | null;
  price_impact: string | null;
  slippage_bps: number | null;
  tx_signature: string | null;
  status: string;
  error_message: string | null;
  strategy: string | null;
  price_at_trade: number | null;
  entry_price: number | null;
  exit_price: number | null;
  exit_reason: string | null;
  realized_pnl: number | null;
  realized_pnl_gross: number | null;
  realized_pnl_net: number | null;
  fees_quote: number | null;
  taker_fee_bps: number | null;
  taker_fee_quote: number | null;
  network_fee_lamports: number | null;
  priority_fee_lamports: number | null;
  sol_fee_quote: number | null;
};

export function getRecentTrades(limit: number, mode?: 'paper' | 'live'): DbTradeRow[] {
  if (mode) {
    return db
      .prepare(
        `SELECT * FROM trades WHERE mode = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(mode, limit) as DbTradeRow[];
  }
  return db
    .prepare(`SELECT * FROM trades ORDER BY id DESC LIMIT ?`)
    .all(limit) as DbTradeRow[];
}

export type TradeSummary = {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  totalRealizedPnl: number;
  successfulTrades: number;
  failedTrades: number;
  totalVolumeIn: string;
  totalVolumeOut: string;
};

export function getTradeSummary(mode?: 'paper' | 'live'): TradeSummary {
  type AggRow = {
    total: number;
    opens: number;
    closes: number;
    wins: number;
    losses: number;
    breakevens: number;
    avg_win: number | null;
    avg_loss: number | null;
    total_pnl: number | null;
    failed: number;
    vol_in: number | null;
    vol_out: number | null;
  };

  const sql = `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN exit_price IS NULL THEN 1 ELSE 0 END) AS opens,
      SUM(CASE WHEN exit_price IS NOT NULL THEN 1 ELSE 0 END) AS closes,
      SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN exit_price IS NOT NULL AND realized_pnl = 0 THEN 1 ELSE 0 END) AS breakevens,
      AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) AS avg_win,
      AVG(CASE WHEN realized_pnl < 0 THEN realized_pnl END) AS avg_loss,
      COALESCE(SUM(realized_pnl), 0) AS total_pnl,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CAST(input_amount AS REAL)) AS vol_in,
      SUM(CAST(output_amount AS REAL)) AS vol_out
    FROM trades
  `;

  const row = (
    mode
      ? db.prepare(sql + ' WHERE mode = ?').get(mode)
      : db.prepare(sql).get()
  ) as AggRow;

  const wins = row.wins ?? 0;
  const losses = row.losses ?? 0;
  const decided = wins + losses;
  const winRate = decided === 0 ? 0 : (wins / decided) * 100;
  const avgWin = row.avg_win ?? null;
  const avgLoss = row.avg_loss ?? null;
  const expectancy =
    decided > 0
      ? (avgWin !== null ? avgWin * (wins / decided) : 0) +
        (avgLoss !== null ? avgLoss * (losses / decided) : 0)
      : null;
  const total = row.total ?? 0;
  const failed = row.failed ?? 0;

  return {
    totalTrades: total,
    openTrades: row.opens ?? 0,
    closedTrades: row.closes ?? 0,
    wins,
    losses,
    breakevens: row.breakevens ?? 0,
    winRate,
    avgWin,
    avgLoss,
    expectancy,
    totalRealizedPnl: row.total_pnl ?? 0,
    successfulTrades: total - failed,
    failedTrades: failed,
    totalVolumeIn: String(Math.round(row.vol_in ?? 0)),
    totalVolumeOut: String(Math.round(row.vol_out ?? 0)),
  };
}

export function getPaperVsLiveComparison(): {
  paper: TradeSummary;
  live: TradeSummary;
  hasBoth: boolean;
} {
  const paper = getTradeSummary('paper');
  const live = getTradeSummary('live');
  const hasBoth = paper.totalTrades > 0 && live.totalTrades > 0;
  return { paper, live, hasBoth };
}

/** Count trade rows since UTC midnight of the current UTC day (timestamp column is ISO string). */
export function countTradesTodayUtc(
  database: SqliteDatabase,
  mode?: 'paper' | 'live',
): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const startIso = d.toISOString();
  if (mode) {
    const row = database
      .prepare(
        `SELECT COUNT(*) AS c FROM trades WHERE timestamp >= ? AND mode = ?`,
      )
      .get(startIso, mode) as { c: number };
    return row.c;
  }
  const row = database
    .prepare(`SELECT COUNT(*) AS c FROM trades WHERE timestamp >= ?`)
    .get(startIso) as { c: number };
  return row.c;
}

export type ClosedExitStats = {
  totalClosed: number;
  wins: number;
  losses: number;
  breakevens: number;
  avgWin: number | null;
  avgLoss: number | null;
  winRatePct: number;
  exitReasons: {
    stop_loss: number;
    take_profit: number;
    trailing_stop: number;
    manual: number;  // 'manual' or 'manual_api'
    other: number;   // legacy / unrecognised (e.g. historical 'mean_reversion_sell')
  };
};

/** Rows that closed a position (have exit_reason + realized_pnl). */
export function getClosedExitStats(
  database: SqliteDatabase,
  mode?: 'paper' | 'live',
): ClosedExitStats {
  const rows = (
    mode
      ? database
          .prepare(
            `SELECT exit_reason, realized_pnl FROM trades WHERE exit_reason IS NOT NULL AND realized_pnl IS NOT NULL AND mode = ?`,
          )
          .all(mode)
      : database
          .prepare(
            `SELECT exit_reason, realized_pnl FROM trades WHERE exit_reason IS NOT NULL AND realized_pnl IS NOT NULL`,
          )
          .all()
  ) as { exit_reason: string; realized_pnl: number }[];

  const exitReasons = {
    stop_loss: 0,
    take_profit: 0,
    trailing_stop: 0,
    manual: 0,
    other: 0,
  };
  let wins = 0;
  let losses = 0;
  let breakevens = 0;
  let sumWin = 0;
  let sumLoss = 0;

  for (const r of rows) {
    const reason = r.exit_reason;
    if (reason === 'stop_loss') exitReasons.stop_loss += 1;
    else if (reason === 'take_profit') exitReasons.take_profit += 1;
    else if (reason === 'trailing_stop') exitReasons.trailing_stop += 1;
    else if (reason === 'manual' || reason === 'manual_api') exitReasons.manual += 1;
    else exitReasons.other += 1;

    const pnl = r.realized_pnl;
    if (pnl > 0) {
      wins += 1;
      sumWin += pnl;
    } else if (pnl < 0) {
      losses += 1;
      sumLoss += pnl;
    } else {
      breakevens += 1;
    }
  }

  const totalClosed = rows.length;
  const decided = wins + losses;
  return {
    totalClosed,
    wins,
    losses,
    breakevens,
    avgWin: wins > 0 ? sumWin / wins : null,
    avgLoss: losses > 0 ? sumLoss / losses : null,
    winRatePct: decided === 0 ? 0 : (wins / decided) * 100,
    exitReasons,
  };
}

export type StrategyStats = {
  tradeCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  avgWin: number | null;
  avgLoss: number | null;
  expectancy: number | null;
  lastTradeTimestamp: string | null;
};

export function getStrategyStats(strategyName: string, mode?: 'paper' | 'live'): StrategyStats {
  const modeClause = mode ? 'AND mode = ?' : '';
  const args: unknown[] = mode ? [strategyName, mode] : [strategyName];

  type Row = {
    trade_count: number;
    closed_count: number;
    wins: number;
    losses: number;
    total_pnl: number | null;
    avg_win: number | null;
    avg_loss: number | null;
    last_ts: string | null;
  };
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS trade_count,
         SUM(CASE WHEN exit_reason IS NOT NULL AND exit_reason != '' THEN 1 ELSE 0 END) AS closed_count,
         SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
         COALESCE(SUM(realized_pnl), 0) AS total_pnl,
         AVG(CASE WHEN realized_pnl > 0 THEN realized_pnl END) AS avg_win,
         AVG(CASE WHEN realized_pnl < 0 THEN realized_pnl END) AS avg_loss,
         MAX(timestamp) AS last_ts
       FROM trades
       WHERE strategy = ? ${modeClause}`,
    )
    .get(...args) as Row;

  const wins = row.wins ?? 0;
  const losses = row.losses ?? 0;
  const decided = wins + losses;
  const avgWin = row.avg_win ?? null;
  const avgLoss = row.avg_loss ?? null;
  const expectancy =
    decided > 0
      ? (avgWin !== null ? avgWin * (wins / decided) : 0) +
        (avgLoss !== null ? avgLoss * (losses / decided) : 0)
      : null;
  return {
    tradeCount: row.trade_count ?? 0,
    closedCount: row.closed_count ?? 0,
    wins,
    losses,
    winRate: decided === 0 ? 0 : (wins / decided) * 100,
    totalPnL: row.total_pnl ?? 0,
    avgWin,
    avgLoss,
    expectancy,
    lastTradeTimestamp: row.last_ts ?? null,
  };
}

export type AiDecisionRecord = {
  timestamp: string;
  action: string;
  reason: string;
  rationale: string;
  confidence: number;
  priceAtDecision: number;
  candidateSignals: string;
  learningsSnapshot: string;
};

export function logAiDecision(rec: AiDecisionRecord): void {
  db.prepare(
    `INSERT INTO ai_decisions (timestamp, action, reason, rationale, confidence, price_at_decision, candidate_signals, learnings_snapshot)
     VALUES (@timestamp, @action, @reason, @rationale, @confidence, @price_at_decision, @candidate_signals, @learnings_snapshot)`,
  ).run({
    timestamp: rec.timestamp,
    action: rec.action,
    reason: rec.reason,
    rationale: rec.rationale,
    confidence: rec.confidence,
    price_at_decision: rec.priceAtDecision,
    candidate_signals: rec.candidateSignals,
    learnings_snapshot: rec.learningsSnapshot,
  });
}

export function getRecentAiDecisions(limit: number): unknown[] {
  return db
    .prepare(`SELECT * FROM ai_decisions ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

export { db };

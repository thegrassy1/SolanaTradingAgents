import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { TradeRecord } from './types';
import { config } from './config';
import { getTokenDecimals } from './tokenInfo';

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
  `);
}

initDatabase();

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
      error_message, strategy, price_at_trade
    ) VALUES (
      @timestamp, @mode, @input_mint, @output_mint, @input_amount, @output_amount,
      @expected_output, @price_impact, @slippage_bps, @tx_signature, @status,
      @error_message, @strategy, @price_at_trade
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
  successfulTrades: number;
  failedTrades: number;
  totalVolumeIn: string;
  totalVolumeOut: string;
  winRate: number;
};

export function getTradeSummary(mode?: 'paper' | 'live'): TradeSummary {
  const where = mode ? 'WHERE mode = ?' : '';
  const rows = (
    mode
      ? db.prepare(`SELECT * FROM trades ${where}`).all(mode)
      : db.prepare(`SELECT * FROM trades`).all()
  ) as DbTradeRow[];

  const ok = rows.filter(
    (r) => r.status === 'success' || r.status === 'paper_filled',
  );
  const failed = rows.filter((r) => r.status === 'failed').length;
  let wins = 0;
  let compared = 0;
  let volIn = 0n;
  let volOut = 0n;
  for (const r of ok) {
    volIn += BigInt(r.input_amount);
    volOut += BigInt(r.output_amount);
    const p = r.price_at_trade;
    const vin = tradeUsdValue(r.input_mint, r.input_amount, p);
    const vout = tradeUsdValue(r.output_mint, r.output_amount, p);
    if (vin !== null && vout !== null) {
      compared += 1;
      if (vout > vin) wins += 1;
    }
  }
  return {
    totalTrades: rows.length,
    successfulTrades: ok.length,
    failedTrades: failed,
    totalVolumeIn: volIn.toString(),
    totalVolumeOut: volOut.toString(),
    winRate: compared === 0 ? 0 : (wins / compared) * 100,
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

export { db };

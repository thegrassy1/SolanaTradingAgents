import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getTokenDecimals } from './tokenInfo';

const DATA_DIR = path.join(process.cwd(), 'data');
const OPEN_PATH = path.join(DATA_DIR, 'positions.json');
const CLOSED_PATH = path.join(DATA_DIR, 'closed-positions.json');

export type ExitReason = 'stop_loss' | 'take_profit' | 'trailing_stop';

export interface Position {
  id: string;
  mint: string;
  entryPrice: number;
  entryTime: string;
  amount: bigint;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  trailingStopPercent: number | null;
  highWaterMark: number;
  strategy: string;
  mode: 'paper' | 'live';
  /** Quote currency actually spent to open this position (human units). */
  entryQuoteAmount?: number | null;
  /** Fees paid on the entry leg, in quote currency. */
  entryFeesQuote?: number | null;
}

export interface ClosedPosition {
  id: string;
  mint: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  amount: bigint;
  /**
   * Legacy gross realized P&L in quote currency.
   * `(exit - entry) * size`. Kept for backward compatibility.
   */
  realizedPnlQuote: number;
  /** Alias of realizedPnlQuote. Always gross of fees. */
  realizedPnlGross?: number;
  /**
   * True net P&L from actual balance flows:
   * `(exitQuoteAmount - entryQuoteAmount) - entryFeesQuote - exitFeesQuote`.
   * Null when the position was opened before the fee-aware refactor and
   * we don't know the entry-side quote flow.
   */
  realizedPnlNet?: number | null;
  /** Total round-trip fees in quote currency (entry + exit legs). */
  feesQuote?: number | null;
  /** USDC actually spent to open (human units). */
  entryQuoteAmount?: number | null;
  /** USDC actually received on close (human units). */
  exitQuoteAmount?: number | null;
  /** Fees paid on entry leg in quote currency. */
  entryFeesQuote?: number | null;
  /** Fees paid on exit leg in quote currency. */
  exitFeesQuote?: number | null;
  exitReason: ExitReason | string;
  strategy: string;
  mode: 'paper' | 'live';
}

export type ExitSignal = {
  positionId: string;
  reason: ExitReason;
  mint: string;
  amount: bigint;
};

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function serializePosition(p: Position): Record<string, unknown> {
  return {
    ...p,
    amount: p.amount.toString(),
  };
}

function deserializePosition(row: Record<string, unknown>): Position {
  const nullableNum = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  return {
    id: String(row.id),
    mint: String(row.mint),
    entryPrice: Number(row.entryPrice),
    entryTime: String(row.entryTime),
    amount: BigInt(String(row.amount)),
    stopLossPrice: nullableNum(row.stopLossPrice),
    takeProfitPrice: nullableNum(row.takeProfitPrice),
    trailingStopPercent: nullableNum(row.trailingStopPercent),
    highWaterMark: Number(row.highWaterMark),
    strategy: String(row.strategy),
    mode: row.mode === 'live' ? 'live' : 'paper',
    entryQuoteAmount: nullableNum(row.entryQuoteAmount),
    entryFeesQuote: nullableNum(row.entryFeesQuote),
  };
}

function serializeClosed(c: ClosedPosition): Record<string, unknown> {
  return {
    ...c,
    amount: c.amount.toString(),
  };
}

function deserializeClosed(row: Record<string, unknown>): ClosedPosition {
  const nullableNum = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  return {
    id: String(row.id),
    mint: String(row.mint),
    entryPrice: Number(row.entryPrice),
    exitPrice: Number(row.exitPrice),
    entryTime: String(row.entryTime),
    exitTime: String(row.exitTime),
    amount: BigInt(String(row.amount)),
    realizedPnlQuote: Number(row.realizedPnlQuote),
    realizedPnlGross: nullableNum(row.realizedPnlGross) ?? Number(row.realizedPnlQuote),
    realizedPnlNet: nullableNum(row.realizedPnlNet),
    feesQuote: nullableNum(row.feesQuote),
    entryQuoteAmount: nullableNum(row.entryQuoteAmount),
    exitQuoteAmount: nullableNum(row.exitQuoteAmount),
    entryFeesQuote: nullableNum(row.entryFeesQuote),
    exitFeesQuote: nullableNum(row.exitFeesQuote),
    exitReason: String(row.exitReason),
    strategy: String(row.strategy),
    mode: row.mode === 'live' ? 'live' : 'paper',
  };
}

export class PositionManager {
  private open: Position[] = [];
  private closed: ClosedPosition[] = [];

  constructor() {
    this.loadFromDisk();
  }

  openPosition(
    mint: string,
    amount: bigint,
    entryPrice: number,
    mode: 'paper' | 'live',
    strategy: string,
    stopLossPercent?: number,
    takeProfitPercent?: number,
    trailingStopPercent?: number | null,
    opts?: {
      entryQuoteAmount?: number | null;
      entryFeesQuote?: number | null;
    },
  ): Position {
    const id = randomUUID();
    const sl =
      stopLossPercent !== undefined
        ? entryPrice * (1 - stopLossPercent)
        : null;
    const tp =
      takeProfitPercent !== undefined
        ? entryPrice * (1 + takeProfitPercent)
        : null;
    const trail =
      trailingStopPercent === undefined ? null : trailingStopPercent;
    const pos: Position = {
      id,
      mint,
      entryPrice,
      entryTime: new Date().toISOString(),
      amount,
      stopLossPrice: sl,
      takeProfitPrice: tp,
      trailingStopPercent: trail,
      highWaterMark: entryPrice,
      strategy,
      mode,
      entryQuoteAmount: opts?.entryQuoteAmount ?? null,
      entryFeesQuote: opts?.entryFeesQuote ?? null,
    };
    this.open.push(pos);
    this.saveToDisk();
    console.log(
      `[POSITION-OPEN] ${id} mint=${mint} amount=${amount} entry=${entryPrice} sl=${sl ?? 'null'} tp=${tp ?? 'null'} trailing=${trail === null ? 'null' : trail} strategy=${strategy} entryQuote=${pos.entryQuoteAmount ?? 'null'} entryFees=${pos.entryFeesQuote ?? 'null'}`,
    );
    return pos;
  }

  closePosition(
    id: string,
    exitPrice: number,
    reason: string,
    opts?: {
      exitQuoteAmount?: number | null;
      exitFeesQuote?: number | null;
    },
  ): ClosedPosition {
    const idx = this.open.findIndex((p) => p.id === id);
    if (idx === -1) {
      throw new Error(`Position not found: ${id}`);
    }
    const p = this.open[idx]!;
    const solHuman = Number(p.amount) / 1e9;
    const realizedPnlGross = (exitPrice - p.entryPrice) * solHuman;

    const exitQuoteAmount =
      opts?.exitQuoteAmount ?? null;
    const exitFeesQuote =
      opts?.exitFeesQuote ?? null;
    const entryQuoteAmount = p.entryQuoteAmount ?? null;
    const entryFeesQuote = p.entryFeesQuote ?? null;

    let realizedPnlNet: number | null = null;
    let feesQuote: number | null = null;
    if (
      entryQuoteAmount !== null &&
      exitQuoteAmount !== null &&
      Number.isFinite(entryQuoteAmount) &&
      Number.isFinite(exitQuoteAmount)
    ) {
      const entryFees = entryFeesQuote ?? 0;
      const exitFees = exitFeesQuote ?? 0;
      // Net = flow delta - SOL-side fees (taker haircut is already baked into the flows).
      realizedPnlNet = (exitQuoteAmount - entryQuoteAmount) - entryFees - exitFees;
      feesQuote = entryFees + exitFees;
    }

    const closed: ClosedPosition = {
      id: p.id,
      mint: p.mint,
      entryPrice: p.entryPrice,
      exitPrice,
      entryTime: p.entryTime,
      exitTime: new Date().toISOString(),
      amount: p.amount,
      realizedPnlQuote: realizedPnlGross,
      realizedPnlGross,
      realizedPnlNet,
      feesQuote,
      entryQuoteAmount,
      exitQuoteAmount,
      entryFeesQuote,
      exitFeesQuote,
      exitReason: reason,
      strategy: p.strategy,
      mode: p.mode,
    };
    this.open.splice(idx, 1);
    this.closed.push(closed);
    this.saveToDisk();
    const netStr =
      realizedPnlNet === null ? 'n/a' : realizedPnlNet.toFixed(4);
    console.log(
      `[POSITION] Closed ${id.slice(0, 8)}\u2026 reason=${reason} pnlGross=${realizedPnlGross.toFixed(4)} pnlNet=${netStr} fees=${feesQuote === null ? 'n/a' : feesQuote.toFixed(4)}`,
    );
    return closed;
  }

  getOpenPositions(): Position[] {
    return [...this.open];
  }

  getClosedPositions(limit: number): ClosedPosition[] {
    return this.closed.slice(-limit).reverse();
  }

  /**
   * Update HWM + trailing stops for every open position, using the
   * appropriate per-mint price. `prices` maps mint → current price (USDC).
   * Positions whose mint isn't in the map are skipped (no price = no update).
   */
  updateHighWaterMarks(prices: Map<string, number>): void {
    let dirty = false;
    for (const p of this.open) {
      const px = prices.get(p.mint);
      if (px === undefined) continue;
      if (px > p.highWaterMark) {
        p.highWaterMark = px;
        dirty = true;
        if (p.trailingStopPercent !== null && p.trailingStopPercent > 0) {
          const trailStop = p.highWaterMark * (1 - p.trailingStopPercent);
          p.stopLossPrice =
            p.stopLossPrice === null
              ? trailStop
              : Math.max(p.stopLossPrice, trailStop);
        }
      }
    }
    if (dirty) this.saveToDisk();
  }

  /**
   * Check exits across all positions. Each position is evaluated against
   * its own mint's price from `prices`. Positions without a price entry
   * are skipped (no false-trigger from a stale cross-symbol price).
   */
  checkExits(prices: Map<string, number>): ExitSignal[] {
    const logChecks = process.env.LOG_EXIT_CHECKS === 'true';
    const out: ExitSignal[] = [];
    for (const p of this.open) {
      const currentPrice = prices.get(p.mint);
      if (currentPrice === undefined) continue;

      let decision: ExitReason | 'none' = 'none';
      if (p.stopLossPrice !== null && currentPrice <= p.stopLossPrice) {
        const reason: ExitReason =
          p.trailingStopPercent !== null ? 'trailing_stop' : 'stop_loss';
        decision = reason;
        out.push({ positionId: p.id, reason, mint: p.mint, amount: p.amount });
      } else if (
        p.takeProfitPrice !== null &&
        currentPrice >= p.takeProfitPrice
      ) {
        decision = 'take_profit';
        out.push({ positionId: p.id, reason: 'take_profit', mint: p.mint, amount: p.amount });
      }
      if (logChecks) {
        const sigStr = decision === 'none' ? 'none' : decision;
        console.log(
          `[EXIT-CHECK] position ${p.id} (${p.mint.slice(0,4)}): px=${currentPrice} sl=${p.stopLossPrice ?? 'null'} tp=${p.takeProfitPrice ?? 'null'} trail=${p.trailingStopPercent ?? 'null'} → ${sigStr}`,
        );
      }
    }
    return out;
  }

  /**
   * Sum unrealized PnL across all open positions, in quote currency.
   * Uses each position's mint decimals (so SOL decimals=9, BONK=5, etc.).
   */
  getUnrealizedPnL(prices: Map<string, number>): number {
    let total = 0;
    for (const p of this.open) {
      const px = prices.get(p.mint);
      if (px === undefined) continue;
      const dec = getTokenDecimals(p.mint);
      const human = Number(p.amount) / 10 ** dec;
      total += (px - p.entryPrice) * human;
    }
    return total;
  }

  loadFromDisk(): void {
    try {
      ensureDataDir();
      if (fs.existsSync(OPEN_PATH)) {
        const raw = JSON.parse(fs.readFileSync(OPEN_PATH, 'utf8')) as unknown;
        const arr = Array.isArray(raw) ? raw : [];
        this.open = arr.map((r) => deserializePosition(r as Record<string, unknown>));
      }
      if (fs.existsSync(CLOSED_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8')) as unknown;
        const arr = Array.isArray(raw) ? raw : [];
        this.closed = arr.map((r) =>
          deserializeClosed(r as Record<string, unknown>),
        );
      }
    } catch (e) {
      console.warn('[POSITION] loadFromDisk failed:', e);
      this.open = [];
      this.closed = [];
    }
  }

  saveToDisk(): void {
    ensureDataDir();
    fs.writeFileSync(
      OPEN_PATH,
      JSON.stringify(this.open.map(serializePosition), null, 2),
      'utf8',
    );
    fs.writeFileSync(
      CLOSED_PATH,
      JSON.stringify(this.closed.map(serializeClosed), null, 2),
      'utf8',
    );
  }

}

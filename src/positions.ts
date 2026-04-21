import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

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
}

export interface ClosedPosition {
  id: string;
  mint: string;
  entryPrice: number;
  exitPrice: number;
  entryTime: string;
  exitTime: string;
  amount: bigint;
  realizedPnlQuote: number;
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
  return {
    id: String(row.id),
    mint: String(row.mint),
    entryPrice: Number(row.entryPrice),
    entryTime: String(row.entryTime),
    amount: BigInt(String(row.amount)),
    stopLossPrice:
      row.stopLossPrice === null || row.stopLossPrice === undefined
        ? null
        : Number(row.stopLossPrice),
    takeProfitPrice:
      row.takeProfitPrice === null || row.takeProfitPrice === undefined
        ? null
        : Number(row.takeProfitPrice),
    trailingStopPercent:
      row.trailingStopPercent === null || row.trailingStopPercent === undefined
        ? null
        : Number(row.trailingStopPercent),
    highWaterMark: Number(row.highWaterMark),
    strategy: String(row.strategy),
    mode: row.mode === 'live' ? 'live' : 'paper',
  };
}

function serializeClosed(c: ClosedPosition): Record<string, unknown> {
  return {
    ...c,
    amount: c.amount.toString(),
  };
}

function deserializeClosed(row: Record<string, unknown>): ClosedPosition {
  return {
    id: String(row.id),
    mint: String(row.mint),
    entryPrice: Number(row.entryPrice),
    exitPrice: Number(row.exitPrice),
    entryTime: String(row.entryTime),
    exitTime: String(row.exitTime),
    amount: BigInt(String(row.amount)),
    realizedPnlQuote: Number(row.realizedPnlQuote),
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
    };
    this.open.push(pos);
    this.saveToDisk();
    console.log(
      `[POSITION-OPEN] ${id} mint=${mint} amount=${amount} entry=${entryPrice} sl=${sl ?? 'null'} tp=${tp ?? 'null'} trailing=${trail === null ? 'null' : trail} strategy=${strategy}`,
    );
    return pos;
  }

  closePosition(id: string, exitPrice: number, reason: string): ClosedPosition {
    const idx = this.open.findIndex((p) => p.id === id);
    if (idx === -1) {
      throw new Error(`Position not found: ${id}`);
    }
    const p = this.open[idx]!;
    const solHuman = Number(p.amount) / 1e9;
    const realizedPnlQuote = (exitPrice - p.entryPrice) * solHuman;
    const closed: ClosedPosition = {
      id: p.id,
      mint: p.mint,
      entryPrice: p.entryPrice,
      exitPrice,
      entryTime: p.entryTime,
      exitTime: new Date().toISOString(),
      amount: p.amount,
      realizedPnlQuote,
      exitReason: reason,
      strategy: p.strategy,
      mode: p.mode,
    };
    this.open.splice(idx, 1);
    this.closed.push(closed);
    this.saveToDisk();
    console.log(
      `[POSITION] Closed ${id.slice(0, 8)}… reason=${reason} pnl=${realizedPnlQuote.toFixed(4)}`,
    );
    return closed;
  }

  getOpenPositions(): Position[] {
    return [...this.open];
  }

  getClosedPositions(limit: number): ClosedPosition[] {
    return this.closed.slice(-limit).reverse();
  }

  updateHighWaterMarks(currentPrice: number): void {
    let dirty = false;
    for (const p of this.open) {
      if (currentPrice > p.highWaterMark) {
        p.highWaterMark = currentPrice;
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

  checkExits(currentPrice: number): ExitSignal[] {
    const logChecks = process.env.LOG_EXIT_CHECKS === 'true';
    const out: ExitSignal[] = [];
    for (const p of this.open) {
      let decision: ExitReason | 'none' = 'none';
      if (p.stopLossPrice !== null && currentPrice <= p.stopLossPrice) {
        const reason: ExitReason =
          p.trailingStopPercent !== null ? 'trailing_stop' : 'stop_loss';
        decision = reason;
        out.push({
          positionId: p.id,
          reason,
          mint: p.mint,
          amount: p.amount,
        });
      } else if (
        p.takeProfitPrice !== null &&
        currentPrice >= p.takeProfitPrice
      ) {
        decision = 'take_profit';
        out.push({
          positionId: p.id,
          reason: 'take_profit',
          mint: p.mint,
          amount: p.amount,
        });
      }
      if (logChecks) {
        const sigStr = decision === 'none' ? 'none' : decision;
        console.log(
          `[EXIT-CHECK] position ${p.id}: currentPrice=${currentPrice} stopLoss=${p.stopLossPrice ?? 'null'} takeProfit=${p.takeProfitPrice ?? 'null'} trailing=${p.trailingStopPercent ?? 'null'} → ${sigStr}`,
        );
      }
    }
    return out;
  }

  getUnrealizedPnL(currentPrice: number): number {
    let total = 0;
    for (const p of this.open) {
      const solHuman = Number(p.amount) / 1e9;
      total += (currentPrice - p.entryPrice) * solHuman;
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

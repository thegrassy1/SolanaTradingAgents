/**
 * Paper perp engine — simulates Drift-style perpetual positions with
 * leverage, funding accrual, stop loss / take profit, and liquidation.
 *
 * Design notes:
 * - Collateral is debited from the strategy's spot USDC balance on open
 *   and credited back (with PnL net of funding) on close.
 * - "Mark price" uses the live Jupiter quote (we don't have a separate
 *   oracle in paper mode). Real Drift uses Pyth — close enough for now.
 * - Funding rate is simulated based on price-vs-SMA deviation. When price
 *   is above SMA, longs pay shorts (positive funding). Below SMA, shorts
 *   pay longs. This mirrors real-world basis behavior in a directional
 *   sense, exaggerated for visibility in 30s polls.
 * - Liquidation triggers when realized + unrealized loss >= 90% of
 *   collateral. Simpler than Drift's MMR but conservative enough.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getTokenDecimals } from './tokenInfo';
import type { PaperTradingEngine } from './paper';
import { getSymbolByMint } from './symbols';

const DATA_DIR = path.join(process.cwd(), 'data');
const OPEN_PATH = path.join(DATA_DIR, 'perp-positions.json');
const CLOSED_PATH = path.join(DATA_DIR, 'perp-closed.json');

export type PerpDirection = 'long' | 'short';
export type PerpExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'liquidation'
  | 'manual'
  | 'manual_api';

export interface PerpPosition {
  id: string;
  mint: string;
  symbol: string;
  direction: PerpDirection;
  entryPrice: number;
  entryTime: string;
  /** Token notional (e.g. 5 SOL). Equals collateralUsdc × leverage / entryPrice. */
  size: number;
  /** Notional in USDC at entry. */
  notionalUsdc: number;
  /** USDC put up as collateral. */
  collateralUsdc: number;
  leverage: number;
  /** Cumulative funding paid (positive = paid, negative = received) in USDC. */
  fundingAccrued: number;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  trailingStopPercent: number | null;
  highWaterMark: number;
  /** Liquidation price threshold (where collateral - 90% is breached). */
  liquidationPrice: number;
  strategy: string;
  mode: 'paper' | 'live';
  lastFundingTickMs: number;
}

export interface ClosedPerpPosition extends PerpPosition {
  exitPrice: number;
  exitTime: string;
  exitReason: PerpExitReason;
  /** PnL net of funding, in USDC. */
  realizedPnlUsdc: number;
  /** Gross PnL before funding. */
  grossPnlUsdc: number;
}

export interface PerpExitSignal {
  positionId: string;
  reason: PerpExitReason;
  mint: string;
  symbol: string;
}

/**
 * Compute the price at which a perp position would be liquidated.
 * Liquidation = 90% of collateral lost.
 *   For long:  liqPrice = entry × (1 − 0.9 / leverage)
 *   For short: liqPrice = entry × (1 + 0.9 / leverage)
 */
export function computeLiquidationPrice(
  entry: number,
  direction: PerpDirection,
  leverage: number,
): number {
  const buffer = 0.9 / Math.max(1, leverage);
  return direction === 'long' ? entry * (1 - buffer) : entry * (1 + buffer);
}

/** Compute unrealized PnL for a position at a given mark price. */
export function unrealizedPnl(p: PerpPosition, mark: number): number {
  const directionSign = p.direction === 'long' ? 1 : -1;
  return (mark - p.entryPrice) * p.size * directionSign;
}

/**
 * Compute funding rate for one tick (decimal).
 * Sign convention: positive value means the position OWES funding.
 * Longs owe when mark > sma (overheated). Shorts owe when mark < sma.
 *
 * We use a small per-tick rate (≈0.0001 max at 5% deviation) so that
 * funding becomes meaningful over hours, not minutes.
 */
export function fundingRatePerTick(
  mark: number,
  sma: number,
  direction: PerpDirection,
): number {
  if (sma <= 0) return 0;
  const deviation = (mark - sma) / sma; // signed, e.g. 0.02 for 2% above
  // Cap at ±5% deviation, then scale to ±0.005 per tick (0.5% of notional/tick max).
  // In normal markets (<1% dev) this gives ~0.001 per tick — meaningful but slow.
  const capped = Math.max(-0.05, Math.min(0.05, deviation));
  const directionSign = direction === 'long' ? 1 : -1;
  return capped * directionSign * 0.1;
}

export class PerpEngine {
  private open: PerpPosition[] = [];
  private closed: ClosedPerpPosition[] = [];
  /** Strategy name → portfolio engine (for collateral debit/credit). */
  private portfolios: Map<string, PaperTradingEngine>;
  private quoteMint: string;

  constructor(portfolios: Map<string, PaperTradingEngine>, quoteMint: string) {
    this.portfolios = portfolios;
    this.quoteMint = quoteMint;
    this.loadFromDisk();
  }

  getOpen(): PerpPosition[] { return [...this.open]; }
  getClosed(limit?: number): ClosedPerpPosition[] {
    const n = limit ?? this.closed.length;
    return this.closed.slice(-n).reverse();
  }

  /**
   * Open a perp position. Debits collateral from the strategy's USDC balance.
   * Returns the position, or null if insufficient collateral.
   */
  openPerp(args: {
    strategy: string;
    mint: string;
    direction: PerpDirection;
    entryPrice: number;
    collateralUsdc: number;
    leverage: number;
    stopLossPercent?: number | null;
    takeProfitPercent?: number | null;
    trailingStopPercent?: number | null;
    mode: 'paper' | 'live';
  }): PerpPosition | null {
    const symInfo = getSymbolByMint(args.mint);
    const symbol = symInfo?.symbol ?? args.mint.slice(0, 4);
    const portfolio = this.portfolios.get(args.strategy);
    if (!portfolio) {
      console.warn(`[PERP] No portfolio for strategy ${args.strategy}`);
      return null;
    }

    // Debit collateral from USDC balance
    const collateralRaw = BigInt(Math.floor(args.collateralUsdc * 1e6));
    const usdcBal = portfolio.getBalance(this.quoteMint).raw;
    if (usdcBal < collateralRaw) {
      console.warn(
        `[PERP][${args.strategy}] Insufficient USDC: have ${Number(usdcBal) / 1e6}, need ${args.collateralUsdc}`,
      );
      return null;
    }
    portfolio.adjustBalance(this.quoteMint, -collateralRaw);

    const notionalUsdc = args.collateralUsdc * args.leverage;
    const size = notionalUsdc / args.entryPrice;
    const liquidationPrice = computeLiquidationPrice(
      args.entryPrice, args.direction, args.leverage,
    );

    // For shorts: stop ABOVE entry, TP BELOW. For longs: opposite.
    const slPct = args.stopLossPercent ?? 0;
    const tpPct = args.takeProfitPercent ?? 0;
    const stopLossPrice = slPct > 0
      ? (args.direction === 'long'
          ? args.entryPrice * (1 - slPct)
          : args.entryPrice * (1 + slPct))
      : null;
    const takeProfitPrice = tpPct > 0
      ? (args.direction === 'long'
          ? args.entryPrice * (1 + tpPct)
          : args.entryPrice * (1 - tpPct))
      : null;

    const pos: PerpPosition = {
      id: randomUUID(),
      mint: args.mint,
      symbol,
      direction: args.direction,
      entryPrice: args.entryPrice,
      entryTime: new Date().toISOString(),
      size,
      notionalUsdc,
      collateralUsdc: args.collateralUsdc,
      leverage: args.leverage,
      fundingAccrued: 0,
      stopLossPrice,
      takeProfitPrice,
      trailingStopPercent: args.trailingStopPercent ?? null,
      highWaterMark: args.entryPrice,
      liquidationPrice,
      strategy: args.strategy,
      mode: args.mode,
      lastFundingTickMs: Date.now(),
    };
    this.open.push(pos);
    this.saveToDisk();
    console.log(
      `[PERP-OPEN][${args.strategy}][${symbol}] ${args.direction.toUpperCase()} ${args.leverage}x · size=${size.toFixed(4)} · entry=$${args.entryPrice.toFixed(4)} · collat=$${args.collateralUsdc.toFixed(2)} · liq=$${liquidationPrice.toFixed(4)}`,
    );
    return pos;
  }

  /**
   * Update high-water marks + trailing stops for all open perps.
   * For longs: HWM tracks the high. For shorts: HWM tracks the low (favorable price).
   */
  updateHighWaterMarks(prices: Map<string, number>): void {
    let dirty = false;
    for (const p of this.open) {
      const px = prices.get(p.mint);
      if (px === undefined) continue;
      const isFavorable = p.direction === 'long' ? px > p.highWaterMark : px < p.highWaterMark;
      if (isFavorable) {
        p.highWaterMark = px;
        dirty = true;
        if (p.trailingStopPercent !== null && p.trailingStopPercent > 0) {
          // For long: stop trails up. For short: stop trails down.
          const trailStop = p.direction === 'long'
            ? p.highWaterMark * (1 - p.trailingStopPercent)
            : p.highWaterMark * (1 + p.trailingStopPercent);
          if (p.direction === 'long') {
            p.stopLossPrice = p.stopLossPrice === null
              ? trailStop
              : Math.max(p.stopLossPrice, trailStop);
          } else {
            p.stopLossPrice = p.stopLossPrice === null
              ? trailStop
              : Math.min(p.stopLossPrice, trailStop);
          }
        }
      }
    }
    if (dirty) this.saveToDisk();
  }

  /**
   * Accrue funding for every open position. Called once per tick.
   * smaByMint provides the SMA20 reference to compute funding direction.
   */
  accrueFunding(prices: Map<string, number>, smaByMint: Map<string, number>): void {
    let dirty = false;
    for (const p of this.open) {
      const mark = prices.get(p.mint);
      const sma = smaByMint.get(p.mint);
      if (mark === undefined || sma === undefined) continue;
      const ratePerTick = fundingRatePerTick(mark, sma, p.direction);
      const fundingThisTick = ratePerTick * p.notionalUsdc;
      if (fundingThisTick !== 0) {
        p.fundingAccrued += fundingThisTick;
        dirty = true;
      }
    }
    if (dirty) this.saveToDisk();
  }

  /**
   * Check exits + liquidations across all positions. Returns signals to act on.
   */
  checkExits(prices: Map<string, number>): PerpExitSignal[] {
    const out: PerpExitSignal[] = [];
    for (const p of this.open) {
      const mark = prices.get(p.mint);
      if (mark === undefined) continue;

      // 1. Liquidation always wins
      const liquidated = p.direction === 'long'
        ? mark <= p.liquidationPrice
        : mark >= p.liquidationPrice;
      if (liquidated) {
        out.push({ positionId: p.id, reason: 'liquidation', mint: p.mint, symbol: p.symbol });
        continue;
      }

      // 2. Hard equity check (in case liquidation price drift fails)
      const upnl = unrealizedPnl(p, mark);
      const equity = p.collateralUsdc + upnl - p.fundingAccrued;
      if (equity <= p.collateralUsdc * 0.10) {
        out.push({ positionId: p.id, reason: 'liquidation', mint: p.mint, symbol: p.symbol });
        continue;
      }

      // 3. Stop loss
      const slHit = p.stopLossPrice !== null && (
        p.direction === 'long' ? mark <= p.stopLossPrice : mark >= p.stopLossPrice
      );
      if (slHit) {
        const reason: PerpExitReason = p.trailingStopPercent !== null ? 'trailing_stop' : 'stop_loss';
        out.push({ positionId: p.id, reason, mint: p.mint, symbol: p.symbol });
        continue;
      }

      // 4. Take profit
      const tpHit = p.takeProfitPrice !== null && (
        p.direction === 'long' ? mark >= p.takeProfitPrice : mark <= p.takeProfitPrice
      );
      if (tpHit) {
        out.push({ positionId: p.id, reason: 'take_profit', mint: p.mint, symbol: p.symbol });
      }
    }
    return out;
  }

  /**
   * Close a position. Settles PnL + funding to the strategy's USDC balance.
   */
  closePerp(positionId: string, exitPrice: number, reason: PerpExitReason): ClosedPerpPosition {
    const idx = this.open.findIndex((p) => p.id === positionId);
    if (idx < 0) throw new Error(`Perp position not found: ${positionId}`);
    const p = this.open[idx];

    const grossPnl = unrealizedPnl(p, exitPrice);
    const realizedPnl = grossPnl - p.fundingAccrued;

    // Return collateral + realized PnL to USDC balance.
    // On a full liquidation (loss > collateral), credit nothing (the collateral
    // is gone). Cap negative settlement to avoid going below zero.
    const settlementUsdc = Math.max(0, p.collateralUsdc + realizedPnl);
    const settlementRaw = BigInt(Math.floor(settlementUsdc * 1e6));
    const portfolio = this.portfolios.get(p.strategy);
    if (portfolio) {
      portfolio.adjustBalance(this.quoteMint, settlementRaw);
    }

    const closed: ClosedPerpPosition = {
      ...p,
      exitPrice,
      exitTime: new Date().toISOString(),
      exitReason: reason,
      realizedPnlUsdc: realizedPnl,
      grossPnlUsdc: grossPnl,
    };
    this.open.splice(idx, 1);
    this.closed.push(closed);
    this.saveToDisk();

    console.log(
      `[PERP-CLOSE][${p.strategy}][${p.symbol}] ${p.direction.toUpperCase()} → ${reason} · entry=$${p.entryPrice.toFixed(4)} · exit=$${exitPrice.toFixed(4)} · gross=$${grossPnl.toFixed(2)} · funding=$${p.fundingAccrued.toFixed(2)} · net=$${realizedPnl.toFixed(2)}`,
    );
    return closed;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────
  private saveToDisk(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(OPEN_PATH, JSON.stringify(this.open, null, 2));
      fs.writeFileSync(CLOSED_PATH, JSON.stringify(this.closed, null, 2));
    } catch (e) {
      console.error('[PERP] saveToDisk failed:', e);
    }
  }
  loadFromDisk(): void {
    try {
      if (fs.existsSync(OPEN_PATH)) {
        this.open = JSON.parse(fs.readFileSync(OPEN_PATH, 'utf8'));
      }
      if (fs.existsSync(CLOSED_PATH)) {
        this.closed = JSON.parse(fs.readFileSync(CLOSED_PATH, 'utf8'));
      }
    } catch (e) {
      console.error('[PERP] loadFromDisk failed:', e);
    }
  }
}

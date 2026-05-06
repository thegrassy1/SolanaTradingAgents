/**
 * Deterministic backtest engine.
 *
 * Replays historical OHLCV bars, drives the same strategy classes the live
 * agent uses, simulates fills with realistic fees + slippage, and produces
 * a trade ledger + equity curve + metrics.
 *
 * Time-correctness:
 *  - At bar t, strategies see only bars [..., t] (no lookahead bias).
 *  - SL/TP triggers evaluate against bar.high / bar.low so we don't miss
 *    intra-bar exits.
 *  - For per-bar entry signals: we treat the bar's CLOSE as the entry price
 *    (with slippage), which is conservative — real systems get filled mid-bar.
 *
 * Per-symbol independence:
 *  - Each symbol gets its own simulated position book.
 *  - No cross-symbol coupling, no portfolio risk gates yet (Phase 1 focuses
 *    on alpha; portfolio behavior is a separate test in P3 territory).
 */
import { registry } from '../strategies/registry';
import type { Strategy, StrategyContext } from '../strategies/base';
import type { OHLCVBar, Resolution } from '../historical/types';
import { BAR_MS } from '../historical/types';
import { getHistoricalBars } from '../historical/fetcher';
import {
  type BacktestParams,
  type BacktestResult,
  type BacktestTrade,
  type EquityPoint,
  type SimPosition,
  type BacktestExitReason,
} from './types';
import { computeMetrics } from './metrics';

const DEFAULT_INITIAL_CAPITAL = 1000;
const DEFAULT_STOP_LOSS = 0.03;
const DEFAULT_TAKE_PROFIT = 0.06;
const DEFAULT_RISK_PER_TRADE = 0.02;
const DEFAULT_TAKER_FEE_BPS = 10;
const DEFAULT_SLIPPAGE_BPS = 5;
/** Bars of history fed to strategies in priceHistory. Big enough for any
 *  strategy's longest lookback (momentum's smaLong=50, breakout's 20-bar
 *  high, etc.). Engine still computes its own SMA20 for ctx.sma. */
const STRATEGY_HISTORY_BARS = 200;
const SMA_LOOKBACK = 20;

export async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const strategy = registry.getStrategyByName(params.strategy);
  if (!strategy) throw new Error(`Unknown strategy: ${params.strategy}`);

  const initialCapital = params.initialCapital ?? DEFAULT_INITIAL_CAPITAL;
  const config = {
    ...strategy.getDefaultConfig(),
    ...registry.getConfig(params.strategy),
    ...(params.configOverride ?? {}),
  };
  const slPct = params.stopLossPercent ?? DEFAULT_STOP_LOSS;
  const tpPct = params.takeProfitPercent ?? DEFAULT_TAKE_PROFIT;
  const trailPct = params.trailingStopPercent ?? null;
  const riskPerTrade = params.riskPerTrade ?? DEFAULT_RISK_PER_TRADE;
  const takerBps = params.takerFeeBps ?? DEFAULT_TAKER_FEE_BPS;
  const slipBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  // Per-symbol state
  const positions = new Map<string, SimPosition>();
  const cashBySymbol = new Map<string, number>();
  for (const sym of params.symbols) cashBySymbol.set(sym, initialCapital);

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const perSymbol: Record<string, { trades: number; wins: number; losses: number; realizedPnl: number }> = {};
  for (const sym of params.symbols) perSymbol[sym] = { trades: 0, wins: 0, losses: 0, realizedPnl: 0 };

  // Load all symbol bars upfront
  const seriesBySymbol = new Map<string, OHLCVBar[]>();
  for (const sym of params.symbols) {
    const r = await getHistoricalBars(sym, params.resolution, params.fromMs, params.toMs);
    seriesBySymbol.set(sym, r.bars);
  }

  // Find the union of timestamps so we replay synchronously
  const allTimestamps = new Set<number>();
  for (const bars of seriesBySymbol.values()) {
    for (const b of bars) allTimestamps.add(b.t);
  }
  const orderedTimestamps = [...allTimestamps].sort((a, b) => a - b);

  // Per-symbol cursor for efficient history slicing
  const cursorBySymbol = new Map<string, number>();
  for (const sym of params.symbols) cursorBySymbol.set(sym, 0);

  // Equity peak for drawdown
  let equityPeak = initialCapital * params.symbols.length;
  let totalBars = 0;

  for (const t of orderedTimestamps) {
    let unrealized = 0;
    let cashTotal = 0;

    for (const symbol of params.symbols) {
      const series = seriesBySymbol.get(symbol)!;
      let cursor = cursorBySymbol.get(symbol)!;
      // Advance cursor to the most recent bar at-or-before t
      while (cursor < series.length && series[cursor].t <= t) cursor++;
      const idxOfBar = cursor - 1;
      if (idxOfBar < 0) continue;
      const bar = series[idxOfBar];
      if (bar.t !== t) continue; // this symbol didn't have a bar at this exact timestamp
      cursorBySymbol.set(symbol, cursor);
      totalBars++;

      // 1. Check exit conditions on existing positions for this symbol
      const open = positions.get(symbol);
      if (open) {
        // Update HWM + trailing stop based on bar high
        if (bar.h > open.highWaterMark) {
          open.highWaterMark = bar.h;
          if (open.trailingStopPercent !== null && open.trailingStopPercent > 0) {
            const trailStop = open.highWaterMark * (1 - open.trailingStopPercent);
            open.stopLossPrice = Math.max(open.stopLossPrice, trailStop);
          }
        }

        // Check exits — SL first, then TP. Use bar low/high to avoid lookahead
        // (close-only checking misses intra-bar exits).
        let exitReason: BacktestExitReason | null = null;
        let exitPrice = 0;
        if (bar.l <= open.stopLossPrice) {
          exitReason = open.trailingStopPercent !== null ? 'trailing_stop' : 'stop_loss';
          exitPrice = open.stopLossPrice;
        } else if (bar.h >= open.takeProfitPrice) {
          exitReason = 'take_profit';
          exitPrice = open.takeProfitPrice;
        }
        if (exitReason !== null) {
          const trade = closePosition(open, exitPrice, exitReason, bar.t, takerBps, slipBps);
          trades.push(trade);
          perSymbol[symbol].trades++;
          perSymbol[symbol].realizedPnl += trade.realizedPnlNet;
          if (trade.realizedPnlNet > 0) perSymbol[symbol].wins++;
          else if (trade.realizedPnlNet < 0) perSymbol[symbol].losses++;
          cashBySymbol.set(symbol, cashBySymbol.get(symbol)! + trade.notional + trade.realizedPnlNet);
          positions.delete(symbol);
        }
      }

      // 2. Compute strategy signal (open position check happens inside)
      if (!positions.has(symbol)) {
        const lookback = series.slice(Math.max(0, idxOfBar - STRATEGY_HISTORY_BARS), idxOfBar + 1);
        if (lookback.length >= SMA_LOOKBACK) {
          const sma = avg(lookback.slice(-SMA_LOOKBACK).map((b) => b.c));
          const vol = stddev(lookback.slice(-SMA_LOOKBACK).map((b) => b.c)) / sma;

          const ctx: StrategyContext = {
            currentPrice: bar.c,
            sma,
            volatility: vol,
            openPosition: null,
            config,
            priceHistory: lookback.map((b) => ({ t: b.t, price: b.c })),
          };
          const signalRaw = (strategy as Strategy).evaluate(ctx);
          // Strategies are mostly sync; our backtest engine treats AI strategy
          // evaluation as a no-op for now (it depends on candidates from others).
          if (signalRaw instanceof Promise) continue;

          if (signalRaw.action === 'buy') {
            // Compute position size from risk model
            const cash = cashBySymbol.get(symbol)!;
            const slPrice = bar.c * (1 - slPct);
            const tpPrice = bar.c * (1 + tpPct);
            const denom = bar.c - slPrice;
            const baseSize = denom > 0 ? (cash * riskPerTrade) / denom : 0;
            const notionalUsd = baseSize * bar.c;
            if (notionalUsd >= 1 && notionalUsd <= cash * 0.95) {
              // Apply slippage to entry
              const fillPrice = bar.c * (1 + slipBps / 10_000);
              const size = (notionalUsd) / fillPrice;
              cashBySymbol.set(symbol, cash - notionalUsd);
              positions.set(symbol, {
                symbol,
                entryT: bar.t,
                entryPrice: fillPrice,
                size,
                notional: notionalUsd,
                stopLossPrice: fillPrice * (1 - slPct),
                takeProfitPrice: fillPrice * (1 + tpPct),
                trailingStopPercent: trailPct,
                highWaterMark: fillPrice,
                openReason: signalRaw.reason,
              });
            }
          }
        }
      }

      // 3. Tally cash + position market value for equity curve.
      //    On entry we removed `notional` from cash, so we have to add back
      //    the current market value of the position (size × current price),
      //    not just the unrealized delta. Bug fix: previously this only added
      //    the delta, producing wildly inflated drawdowns when a position was open.
      cashTotal += cashBySymbol.get(symbol) ?? 0;
      const stillOpen = positions.get(symbol);
      if (stillOpen) {
        cashTotal += stillOpen.size * bar.c;
        unrealized += (bar.c - stillOpen.entryPrice) * stillOpen.size;
      }
    }

    const equity = cashTotal;
    equityPeak = Math.max(equityPeak, equity);
    const drawdown = equityPeak > 0 ? (equityPeak - equity) / equityPeak : 0;
    equityCurve.push({ t, equity, unrealized, drawdown });
  }

  // Force-close any positions still open at end
  for (const [symbol, open] of positions) {
    const series = seriesBySymbol.get(symbol)!;
    const lastBar = series[series.length - 1];
    if (!lastBar) continue;
    const trade = closePosition(open, lastBar.c, 'end_of_test', lastBar.t, takerBps, slipBps);
    trades.push(trade);
    perSymbol[symbol].trades++;
    perSymbol[symbol].realizedPnl += trade.realizedPnlNet;
    if (trade.realizedPnlNet > 0) perSymbol[symbol].wins++;
    else if (trade.realizedPnlNet < 0) perSymbol[symbol].losses++;
    cashBySymbol.set(symbol, cashBySymbol.get(symbol)! + trade.notional + trade.realizedPnlNet);
  }

  // Final equity = sum of cash across symbols
  const finalEquity = [...cashBySymbol.values()].reduce((a, b) => a + b, 0);

  const metrics = computeMetrics({
    startEquity: initialCapital * params.symbols.length,
    endEquity: finalEquity,
    trades,
    equityCurve,
    barMs: BAR_MS[params.resolution],
    bars: totalBars,
    symbols: params.symbols,
    fromMs: params.fromMs,
    toMs: params.toMs,
  });

  return { params, trades, equityCurve, metrics, perSymbol };
}

function closePosition(
  pos: SimPosition,
  exitPrice: number,
  reason: BacktestExitReason,
  exitT: number,
  takerBps: number,
  slipBps: number,
): BacktestTrade {
  // Apply slippage on exit too
  const fillPrice = exitPrice * (1 - slipBps / 10_000);
  const grossPnl = (fillPrice - pos.entryPrice) * pos.size;
  // Fees: taker fee on entry notional + exit notional
  const entryFee = pos.notional * (takerBps / 10_000);
  const exitFee = pos.size * fillPrice * (takerBps / 10_000);
  const totalFee = entryFee + exitFee;
  const netPnl = grossPnl - totalFee;
  return {
    symbol: pos.symbol,
    entryT: pos.entryT,
    exitT,
    entryPrice: pos.entryPrice,
    exitPrice: fillPrice,
    size: pos.size,
    notional: pos.notional,
    realizedPnl: grossPnl,
    realizedPnlNet: netPnl,
    feesPaid: totalFee,
    exitReason: reason,
    reason: pos.openReason,
    holdMinutes: (exitT - pos.entryT) / 60_000,
  };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(avg(xs.map((x) => (x - m) ** 2)));
}

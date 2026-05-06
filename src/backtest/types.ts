/**
 * Shared types for the backtest engine.
 */
import type { OHLCVBar, Resolution } from '../historical/types';
import type { StrategySignal } from '../strategies/base';

export interface BacktestParams {
  /** Strategy name from registry, e.g. "mean_reversion_v1". */
  strategy: string;
  /** Symbols to backtest against (single or many). */
  symbols: string[];
  resolution: Resolution;
  fromMs: number;
  toMs: number;
  /** Override strategy config (defaults pulled from registry). */
  configOverride?: Record<string, number>;
  /** Starting capital per symbol, in USDC. */
  initialCapital?: number;
  /** SL/TP from RiskManager defaults if omitted. */
  stopLossPercent?: number;
  takeProfitPercent?: number;
  trailingStopPercent?: number | null;
  /** Risk per trade as decimal (default 0.02). */
  riskPerTrade?: number;
  /** Per-trade taker fee, basis points (default 10 = 0.1%). */
  takerFeeBps?: number;
  /** Slippage applied to fills, basis points (default 5). */
  slippageBps?: number;
}

export type BacktestExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'trailing_stop'
  | 'end_of_test';

export interface BacktestTrade {
  symbol: string;
  entryT: number;
  exitT: number;
  entryPrice: number;
  exitPrice: number;
  size: number;          // base-token units
  notional: number;      // USDC at entry
  realizedPnl: number;   // gross
  realizedPnlNet: number; // net of fees
  feesPaid: number;
  exitReason: BacktestExitReason;
  reason: string;        // strategy reason
  holdMinutes: number;
}

export interface EquityPoint {
  t: number;
  equity: number;
  unrealized: number;
  drawdown: number;     // current drawdown from peak (decimal)
}

export interface BacktestMetrics {
  // Returns
  startEquity: number;
  endEquity: number;
  totalReturnUsd: number;
  totalReturnPct: number;
  // Risk
  sharpe: number;       // annualized, computed from bar returns
  sortino: number;      // downside-only Sharpe
  maxDrawdown: number;  // decimal (e.g. 0.12 = 12%)
  maxDrawdownDays: number;
  // Trade quality
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;      // decimal
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  profitFactor: number; // sum_wins / |sum_losses|
  avgHoldMinutes: number;
  medianHoldMinutes: number;
  // Bookkeeping
  bars: number;
  symbolsTraded: number;
  duration: { startMs: number; endMs: number; days: number };
}

export interface BacktestResult {
  params: BacktestParams;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  /** Per-symbol breakdown, keyed by symbol. */
  perSymbol: Record<string, {
    trades: number;
    wins: number;
    losses: number;
    realizedPnl: number;
  }>;
}

/** Internal state of a single open position during the backtest. */
export interface SimPosition {
  symbol: string;
  entryT: number;
  entryPrice: number;
  size: number;
  notional: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  trailingStopPercent: number | null;
  highWaterMark: number;
  /** Reason from the strategy that opened this. */
  openReason: string;
}

/**
 * What the engine passes to a strategy each bar — same shape as the live
 * StrategyContext, so strategies don't need any modifications.
 */
export interface ReplayContext {
  symbol: string;
  bar: OHLCVBar;
  /** Recent bars including the current one (newest last). */
  history: OHLCVBar[];
  signal?: StrategySignal;
}

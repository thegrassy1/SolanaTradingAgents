/**
 * Shared types for the strategy flywheel.
 *
 * The flywheel = a self-improving loop that periodically:
 *   1. Refreshes historical data
 *   2. Backtests every (strategy, symbol) combination
 *   3. Updates the live whitelist based on rolling performance
 *   4. Logs every decision to ai_actions so we can audit what changed and why
 *
 * Three jobs run on different cadences:
 *   - HealthChecker (every 6h):  rolling 14-day backtest on whitelisted combos.
 *                                Promotes hot combos, demotes cold ones.
 *   - ScoutAgent (daily):        30-day backtest on non-whitelisted combos.
 *                                Surfaces new edges as they emerge.
 *   - DataRefresher (hourly):    pulls latest bars so backtests stay fresh.
 */

export interface FlywheelDecision {
  /** When the decision fired. */
  ts: string;
  /** Which job. */
  job: 'health' | 'scout' | 'optimize' | 'refresh';
  strategy: string;
  symbol: string;
  /** What changed. */
  action: 'promote' | 'demote' | 'no_change' | 'tune' | 'flag';
  /** Numeric reason — typically Sharpe of the test. */
  metric: number;
  /** Human-readable explanation. */
  reason: string;
  /** Previous + new state (for the audit trail). */
  before?: string;
  after?: string;
}

export interface ComboScore {
  strategy: string;
  symbol: string;
  sharpe: number;
  totalPnlPct: number;
  trades: number;
  winRate: number;
  maxDrawdown: number;
  reliable: boolean; // sufficient trade count to trust
}

/** Tunables — all in one place so the flywheel's "policy" is easy to audit. */
export const FLYWHEEL_POLICY = {
  /** Backtest window for the health checker (rolling). */
  healthLookbackDays: 14,
  /** Backtest window for the scout. */
  scoutLookbackDays: 30,
  /** Minimum trades for results to be considered statistically meaningful. */
  minTradesForDecision: 6,
  /** Demote a whitelisted combo if 14d Sharpe drops below this. */
  demoteSharpeBelow: -0.5,
  /** Promote a non-whitelisted combo if 30d Sharpe rises above this. */
  promoteSharpeAbove: 0.8,
  /** Required: positive total return to consider promoting. */
  promoteMinReturnPct: 0.5,
  /** Max combos the flywheel can promote in a single sweep — keeps changes incremental. */
  maxPromotionsPerSweep: 2,
  /** Resolution used for flywheel backtests. */
  resolution: '1h' as const,
} as const;

export type FlywheelPolicy = typeof FLYWHEEL_POLICY;

/**
 * Health checker — runs every 6 hours on whitelisted combos.
 *
 * For each (strategy, symbol) currently in the whitelist:
 *   - Run a 14-day backtest at the configured resolution
 *   - If Sharpe drops below `demoteSharpeBelow`: REMOVE from whitelist
 *   - Otherwise: leave it
 *
 * All decisions are logged to ai_actions so we have a permanent audit
 * trail of what the flywheel changed and why.
 */
import type { TradingAgent } from '../agent';
import { logAiAction } from '../db';
import { scoreCombo } from './scoring';
import { FLYWHEEL_POLICY, type FlywheelDecision } from './types';

export async function runHealthCheck(agent: TradingAgent): Promise<FlywheelDecision[]> {
  const decisions: FlywheelDecision[] = [];
  const whitelist = agent.getStrategySymbolWhitelist();

  for (const [strategy, symbols] of Object.entries(whitelist)) {
    // Skip disabled (empty array) and legacy "all-allowed" (undefined) entries
    if (!symbols || symbols.length === 0) continue;
    // Skip strategies the backtest engine can't drive (async AI, special wiring)
    if (strategy === 'ai_strategy_v1' || strategy === 'buy_and_hold_v1') continue;

    for (const symbol of symbols) {
      try {
        const score = await scoreCombo(strategy, symbol, FLYWHEEL_POLICY.healthLookbackDays);
        const decision = decideHealth(strategy, symbol, score, symbols);
        decisions.push(decision);

        if (decision.action === 'demote') {
          const newList = symbols.filter((s) => s !== symbol);
          agent.setStrategySymbolWhitelist(strategy, newList);
          logAiAction({
            timestamp: decision.ts,
            source: 'flywheel_health',
            strategy,
            key: `whitelist:${symbol}`,
            oldValue: 1,
            newValue: 0,
            reason: `DEMOTED ${symbol}: ${decision.reason}`,
          });
        } else if (decision.action === 'flag') {
          logAiAction({
            timestamp: decision.ts,
            source: 'flywheel_health',
            strategy,
            key: `flagged:${symbol}`,
            oldValue: null,
            newValue: decision.metric,
            reason: decision.reason,
          });
        }
      } catch (e) {
        console.warn(`[FLYWHEEL][health] ${strategy}×${symbol} backtest failed: ${(e as Error).message}`);
      }
    }
  }
  return decisions;
}

function decideHealth(
  strategy: string,
  symbol: string,
  score: ReturnType<typeof scoreCombo> extends Promise<infer T> ? T : never,
  currentSymbols: string[],
): FlywheelDecision {
  const ts = new Date().toISOString();
  const base: FlywheelDecision = {
    ts, job: 'health', strategy, symbol,
    action: 'no_change', metric: score.sharpe,
    reason: `sharpe=${score.sharpe.toFixed(2)} return=${(score.totalPnlPct * 100).toFixed(1)}% trades=${score.trades}`,
  };

  // If the test didn't produce enough trades to be statistically meaningful,
  // flag it for visibility but don't change state.
  if (!score.reliable) {
    return {
      ...base,
      action: 'flag',
      reason: `${score.trades} trades over ${FLYWHEEL_POLICY.healthLookbackDays}d — insufficient sample, holding`,
    };
  }

  // Demote if Sharpe fell below threshold AND we'd still have at least one
  // symbol left on the whitelist (don't strip a strategy down to zero from
  // a single bad window — that's what scoring's `reliable` flag mitigates).
  if (score.sharpe < FLYWHEEL_POLICY.demoteSharpeBelow && currentSymbols.length > 1) {
    return {
      ...base,
      action: 'demote',
      before: currentSymbols.join(','),
      after: currentSymbols.filter((s) => s !== symbol).join(','),
      reason: `14d Sharpe ${score.sharpe.toFixed(2)} below ${FLYWHEEL_POLICY.demoteSharpeBelow}; removed from whitelist`,
    };
  }
  return base;
}

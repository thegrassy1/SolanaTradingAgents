/**
 * Scout — runs daily.
 *
 * Tests every (strategy, symbol) NOT currently on the whitelist over a
 * 30-day window. If any combo shows real edge (Sharpe > threshold AND
 * positive return), promotes the strongest few onto the whitelist.
 *
 * This is the discovery half of the flywheel. The health checker removes
 * stale edges; the scout finds new ones. Together they let the system
 * follow alpha as market regimes shift.
 */
import type { TradingAgent } from '../agent';
import { logAiAction } from '../db';
import { getActiveUniverse } from '../symbols';
import { registry } from '../strategies/registry';
import { scoreCombo } from './scoring';
import { FLYWHEEL_POLICY, type ComboScore, type FlywheelDecision } from './types';

export async function runScout(agent: TradingAgent): Promise<FlywheelDecision[]> {
  const decisions: FlywheelDecision[] = [];
  const whitelist = agent.getStrategySymbolWhitelist();
  const universe = getActiveUniverse().map((s) => s.symbol);

  // Build the test grid: every (strategy, symbol) combo NOT currently
  // whitelisted (or where the whitelist entry is "all allowed").
  type Candidate = { strategy: string; symbol: string };
  const candidates: Candidate[] = [];
  for (const strat of registry.getStrategies()) {
    // Backtest engine can't drive these — skip
    if (strat.name === 'ai_strategy_v1' || strat.name === 'buy_and_hold_v1') continue;
    const currentList = whitelist[strat.name];
    for (const symbol of universe) {
      const alreadyOn = Array.isArray(currentList) && currentList.includes(symbol);
      if (alreadyOn) continue;
      candidates.push({ strategy: strat.name, symbol });
    }
  }

  // Score every candidate
  const scored: Array<{ cand: Candidate; score: ComboScore }> = [];
  for (const cand of candidates) {
    try {
      const score = await scoreCombo(cand.strategy, cand.symbol, FLYWHEEL_POLICY.scoutLookbackDays);
      scored.push({ cand, score });
    } catch (e) {
      console.warn(`[FLYWHEEL][scout] ${cand.strategy}×${cand.symbol} failed: ${(e as Error).message}`);
    }
  }

  // Rank by Sharpe descending — best opportunities first
  scored.sort((a, b) => b.score.sharpe - a.score.sharpe);

  let promotions = 0;
  for (const { cand, score } of scored) {
    if (promotions >= FLYWHEEL_POLICY.maxPromotionsPerSweep) break;
    const ts = new Date().toISOString();
    const reasonMetrics =
      `30d sharpe=${score.sharpe.toFixed(2)} return=${(score.totalPnlPct * 100).toFixed(1)}% trades=${score.trades}`;

    const wouldPromote =
      score.reliable &&
      score.sharpe >= FLYWHEEL_POLICY.promoteSharpeAbove &&
      score.totalPnlPct * 100 >= FLYWHEEL_POLICY.promoteMinReturnPct;

    if (!wouldPromote) {
      decisions.push({
        ts, job: 'scout', strategy: cand.strategy, symbol: cand.symbol,
        action: 'no_change', metric: score.sharpe,
        reason: reasonMetrics + (score.reliable ? ' — below promote threshold' : ' — insufficient trades'),
      });
      continue;
    }

    // PROMOTE: add symbol to whitelist
    const currentList = agent.getStrategySymbolWhitelist()[cand.strategy] ?? [];
    const newList = [...currentList, cand.symbol];
    agent.setStrategySymbolWhitelist(cand.strategy, newList);
    promotions++;
    decisions.push({
      ts, job: 'scout', strategy: cand.strategy, symbol: cand.symbol,
      action: 'promote', metric: score.sharpe,
      reason: reasonMetrics + ` — promoted to whitelist`,
      before: currentList.join(','),
      after: newList.join(','),
    });
    logAiAction({
      timestamp: ts,
      source: 'flywheel_scout',
      strategy: cand.strategy,
      key: `whitelist:${cand.symbol}`,
      oldValue: 0,
      newValue: 1,
      reason: `PROMOTED ${cand.symbol}: ${reasonMetrics}`,
    });
  }

  return decisions;
}

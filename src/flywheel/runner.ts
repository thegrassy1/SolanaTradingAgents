/**
 * Flywheel orchestrator.
 *
 * Three jobs scheduled via node-cron (see scheduler.ts):
 *   - DataRefresher (hourly):    pulls latest bars
 *   - HealthChecker (every 6h):  demotes underperforming whitelist combos
 *   - ScoutAgent (daily 04:00):  finds + promotes new edges
 *
 * Each job is idempotent and safe to interrupt — they only ever
 * write to the whitelist + ai_actions, never to trading state.
 */
import type { TradingAgent } from '../agent';
import { runDataRefresh } from './refresher';
import { runHealthCheck } from './healthChecker';
import { runScout } from './scout';

export async function flywheelRefresh(): Promise<void> {
  console.log('[FLYWHEEL] data refresh starting');
  try {
    await runDataRefresh();
  } catch (e) {
    console.error('[FLYWHEEL] refresh failed:', e);
  }
}

export async function flywheelHealth(agent: TradingAgent): Promise<void> {
  console.log('[FLYWHEEL] health check starting');
  try {
    const decisions = await runHealthCheck(agent);
    const demotes = decisions.filter((d) => d.action === 'demote');
    const flags = decisions.filter((d) => d.action === 'flag');
    const ok = decisions.filter((d) => d.action === 'no_change');
    console.log(
      `[FLYWHEEL] health complete: ${decisions.length} combos checked · ` +
      `${demotes.length} demoted · ${flags.length} flagged · ${ok.length} healthy`,
    );
    for (const d of demotes) {
      console.log(`[FLYWHEEL][demote] ${d.strategy}×${d.symbol}: ${d.reason}`);
    }
  } catch (e) {
    console.error('[FLYWHEEL] health check failed:', e);
  }
}

export async function flywheelScout(agent: TradingAgent): Promise<void> {
  console.log('[FLYWHEEL] scout starting');
  try {
    const decisions = await runScout(agent);
    const promotes = decisions.filter((d) => d.action === 'promote');
    console.log(
      `[FLYWHEEL] scout complete: ${decisions.length} candidates tested · ${promotes.length} promoted`,
    );
    for (const d of promotes) {
      console.log(`[FLYWHEEL][promote] ${d.strategy}×${d.symbol}: ${d.reason}`);
    }
  } catch (e) {
    console.error('[FLYWHEEL] scout failed:', e);
  }
}

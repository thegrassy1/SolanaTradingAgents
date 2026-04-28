/**
 * AI Reviewer — runs daily to review recent trade history, update LEARNINGS.md,
 * and produce structured config-change actions that the agent applies automatically.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { config } from '../config';

const AI_DIR = path.join(process.cwd(), 'data', 'ai');
const LEARNINGS_PATH = path.join(AI_DIR, 'LEARNINGS.md');

export interface ReviewerAction {
  type: 'strategy_config';
  strategy: string;
  key: string;
  value: number;
  reason: string;
}

export interface ReviewerResult {
  learnings: string;
  actions: ReviewerAction[];
}

// Bounds on what the reviewer is allowed to change (safety guardrails)
const ACTION_BOUNDS: Record<string, Record<string, [number, number]>> = {
  mean_reversion_v1: { threshold: [0.5, 8.0] },
  breakout_v1: {
    minVolatility: [0.00005, 0.005],
    lookbackBars: [5, 100],
  },
};

function ensureAiDir(): void {
  fs.mkdirSync(AI_DIR, { recursive: true });
}

function readLearnings(): string {
  try {
    if (fs.existsSync(LEARNINGS_PATH)) {
      return fs.readFileSync(LEARNINGS_PATH, 'utf8');
    }
  } catch {}
  return '';
}

function writeLearnings(content: string): void {
  ensureAiDir();
  fs.writeFileSync(LEARNINGS_PATH, content, 'utf8');
}

function getRecentClosedTrades(days = 7): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const rows = db
    .prepare(
      `SELECT strategy, exit_reason, realized_pnl, price_at_trade, entry_price, exit_price, timestamp
       FROM trades
       WHERE exit_reason IS NOT NULL AND exit_reason != ''
         AND timestamp >= ?
       ORDER BY timestamp DESC
       LIMIT 150`,
    )
    .all(cutoff.toISOString()) as Array<{
    strategy: string;
    exit_reason: string;
    realized_pnl: number | null;
    price_at_trade: number | null;
    entry_price: number | null;
    exit_price: number | null;
    timestamp: string;
  }>;

  if (rows.length === 0) return 'No closed trades in the last 7 days.';

  const lines = rows.map(
    (r) =>
      `${r.timestamp.slice(0, 16)} | ${r.strategy} | ${r.exit_reason} | pnl=${r.realized_pnl?.toFixed(4) ?? 'N/A'} | entry=$${r.entry_price?.toFixed(2) ?? '?'} exit=$${r.exit_price?.toFixed(2) ?? '?'}`,
  );

  const wins = rows.filter((r) => (r.realized_pnl ?? 0) > 0).length;
  const losses = rows.filter((r) => (r.realized_pnl ?? 0) < 0).length;
  const totalPnl = rows.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);

  return (
    `Summary: ${rows.length} closes, ${wins} wins, ${losses} losses, net PnL=$${totalPnl.toFixed(4)}\n\n` +
    lines.join('\n')
  );
}

function getIdleStrategies(): string {
  const rows = db
    .prepare(
      `SELECT strategy, MAX(timestamp) AS last_ts
       FROM trades
       WHERE strategy IN ('mean_reversion_v1','breakout_v1')
       GROUP BY strategy`,
    )
    .all() as Array<{ strategy: string; last_ts: string }>;

  const lines: string[] = [];
  for (const r of rows) {
    const daysSince = (Date.now() - new Date(r.last_ts).getTime()) / 86400000;
    if (daysSince >= 1) {
      lines.push(`${r.strategy}: last trade ${daysSince.toFixed(1)} days ago`);
    }
  }
  return lines.length ? lines.join('\n') : 'All strategies traded recently.';
}

function getCurrentConfigs(): string {
  const rows = db
    .prepare(
      `SELECT strategy, MAX(timestamp) AS last_ts, COUNT(*) AS cnt
       FROM trades WHERE strategy IN ('mean_reversion_v1','breakout_v1')
       GROUP BY strategy`,
    )
    .all() as Array<{ strategy: string }>;
  if (!rows.length) return 'No config info available.';
  return 'See system for current configs.';
}

function validateAction(action: ReviewerAction): { ok: boolean; reason: string } {
  const allowed = ACTION_BOUNDS[action.strategy];
  if (!allowed) return { ok: false, reason: `Unknown strategy: ${action.strategy}` };
  const bounds = allowed[action.key];
  if (!bounds) return { ok: false, reason: `Unknown key ${action.key} for ${action.strategy}` };
  const [min, max] = bounds;
  if (typeof action.value !== 'number' || !isFinite(action.value)) {
    return { ok: false, reason: 'Value must be a finite number' };
  }
  if (action.value < min || action.value > max) {
    return { ok: false, reason: `Value ${action.value} outside bounds [${min}, ${max}]` };
  }
  return { ok: true, reason: '' };
}

export async function runDailyReview(
  applyActions?: (actions: ReviewerAction[]) => void,
): Promise<void> {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    console.warn('[AI-REVIEWER] No ANTHROPIC_API_KEY — skipping review');
    return;
  }

  console.log('[AI-REVIEWER] Starting daily review...');
  const client = new Anthropic({ apiKey });
  const tradeSummary = getRecentClosedTrades(7);
  const idleInfo = getIdleStrategies();
  const existingLearnings = readLearnings();

  const systemPrompt = `You are an AI trading analyst for a SOL/USDC paper trading system.
Your job: review recent performance, update trading learnings, and propose config adjustments.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "learnings": "# SOL/USDC Trading Learnings\\n...",
  "actions": [
    {"type":"strategy_config","strategy":"breakout_v1","key":"minVolatility","value":0.0001,"reason":"..."}
  ]
}

Rules for actions:
- Maximum 3 actions per review
- Only propose a change if there is clear evidence from the trade data
- Allowed parameters and bounds:
  * mean_reversion_v1.threshold: 0.5 to 8.0 (default 2.0, lower = more trades)
  * breakout_v1.minVolatility: 0.00005 to 0.005 (default 0.001, lower = more trades)
  * breakout_v1.lookbackBars: 5 to 100 (default 20, lower = easier to break out)
- If a strategy has been idle for 2+ days, consider relaxing its entry parameter
- If a strategy has a poor win rate (<35%), consider tightening its entry parameter
- actions array can be empty [] if no changes are warranted
- Keep learnings under 600 words and focused on actionable patterns`;

  const userContent = `## Recent Trade History (last 7 days)
${tradeSummary}

## Strategy Activity
${idleInfo}

## Current LEARNINGS.md
${existingLearnings || '(empty — first review)'}

Produce the JSON response now.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    const rawText = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';

    let parsed: { learnings?: string; actions?: unknown[] };
    try {
      parsed = JSON.parse(rawText) as { learnings?: string; actions?: unknown[] };
    } catch {
      console.error('[AI-REVIEWER] Failed to parse JSON response:', rawText.slice(0, 300));
      return;
    }

    // Write learnings
    if (parsed.learnings && typeof parsed.learnings === 'string') {
      writeLearnings(parsed.learnings);
      console.log(`[AI-REVIEWER] LEARNINGS.md updated (${parsed.learnings.length} chars)`);
    }

    // Validate and apply actions
    const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
    const validActions: ReviewerAction[] = [];

    for (const raw of rawActions.slice(0, 3)) {
      const a = raw as ReviewerAction;
      if (a.type !== 'strategy_config') continue;
      const check = validateAction(a);
      if (!check.ok) {
        console.warn(`[AI-REVIEWER] Skipping invalid action: ${check.reason}`, a);
        continue;
      }
      validActions.push(a);
      console.log(
        `[AI-REVIEWER] Action queued: ${a.strategy}.${a.key} = ${a.value} (${a.reason})`,
      );
    }

    if (validActions.length > 0 && applyActions) {
      applyActions(validActions);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[AI-REVIEWER] Error calling Haiku:', msg);
  }
}

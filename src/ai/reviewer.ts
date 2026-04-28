/**
 * AI Reviewer — runs daily to review recent trade history and update LEARNINGS.md
 * with actionable insights for the Decider to use.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import { config } from '../config';

const AI_DIR = path.join(process.cwd(), 'data', 'ai');
const LEARNINGS_PATH = path.join(AI_DIR, 'LEARNINGS.md');

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

export async function runDailyReview(): Promise<void> {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    console.warn('[AI-REVIEWER] No ANTHROPIC_API_KEY — skipping review');
    return;
  }

  console.log('[AI-REVIEWER] Starting daily review...');
  const client = new Anthropic({ apiKey });
  const tradeSummary = getRecentClosedTrades(7);
  const existingLearnings = readLearnings();

  const systemPrompt = `You are an AI trading analyst reviewing the performance of a SOL/USDC paper trading system.
Your task is to produce an updated LEARNINGS.md file with actionable insights for the AI trade filter.

Focus on:
- Patterns in exit reasons (stop_loss, take_profit, trailing_stop, manual)
- Price/SMA deviation ranges that correlate with wins vs losses
- Volatility conditions at trade entry
- Strategy-specific observations (mean_reversion_v1, breakout_v1)
- Specific recommendations for when to approve vs reject buy signals

Write clear, concise bullet points grouped by theme. Keep the document under 800 words.
Refine existing insights rather than just appending — remove stale or contradicted patterns.
Start the document with the exact header: # SOL/USDC Trading Learnings`;

  const userContent = `## Recent Trade History (last 7 days)
${tradeSummary}

## Current LEARNINGS.md
${existingLearnings || '(empty — this is the first review)'}

Produce the updated LEARNINGS.md now.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    if (text) {
      writeLearnings(text);
      console.log(`[AI-REVIEWER] LEARNINGS.md updated (${text.length} chars)`);
    } else {
      console.warn('[AI-REVIEWER] Empty response from Haiku — skipping write');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[AI-REVIEWER] Error calling Haiku:', msg);
  }
}

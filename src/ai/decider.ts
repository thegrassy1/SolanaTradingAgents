/**
 * AI Decider — calls Claude Haiku to approve or reject a buy signal
 * based on current market context and accumulated learnings.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logAiDecision } from '../db';

const AI_DIR = path.join(process.cwd(), 'data', 'ai');
const LEARNINGS_PATH = path.join(AI_DIR, 'LEARNINGS.md');

function readLearnings(): string {
  try {
    if (fs.existsSync(LEARNINGS_PATH)) {
      return fs.readFileSync(LEARNINGS_PATH, 'utf8');
    }
  } catch {}
  return 'No learnings recorded yet. Use conservative judgment.';
}

export interface DeciderInput {
  currentPrice: number;
  sma: number | null;
  volatility: number | null;
  priceHistory: Array<{ t: number; price: number }>;
  candidateSignals: Array<{ strategyName: string; action: string; reason: string }>;
  mode: string;
}

export interface DeciderOutput {
  decision: 'approve' | 'reject';
  reason: string;
  confidence: number;
  rationale: string;
}

export async function runDecider(input: DeciderInput): Promise<DeciderOutput> {
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    console.warn('[AI-DECIDER] No ANTHROPIC_API_KEY — defaulting to reject');
    return { decision: 'reject', reason: 'No API key configured', confidence: 0, rationale: '' };
  }

  const client = new Anthropic({ apiKey });
  const learnings = readLearnings();

  const devPct =
    input.sma && input.sma !== 0
      ? (((input.currentPrice - input.sma) / input.sma) * 100).toFixed(2)
      : 'N/A';
  const volPct = input.volatility != null ? (input.volatility * 100).toFixed(3) : 'N/A';
  // Compute price-format decimals from latest price magnitude
  const refPx = input.priceHistory[input.priceHistory.length - 1]?.price ?? input.currentPrice;
  const histDecimals = refPx > 0 && refPx < 0.01
    ? Math.max(4, Math.ceil(-Math.log10(refPx)) + 3)
    : 2;
  const recentPrices = input.priceHistory.slice(-10).map((p) => `$${p.price.toFixed(histDecimals)}`).join(', ');

  const systemPrompt = `You are an AI trading advisor reviewing SOL/USDC signals for a paper trading agent. Your job is to filter buy signals by evaluating market context and accumulated learnings.

You will be given: current market data (price, SMA deviation, volatility), candidate buy signals from quantitative strategies, and historical learnings about what conditions lead to good vs bad trades.

Respond ONLY with valid JSON in this exact format (no markdown, no extra text):
{"decision":"approve","reason":"<one sentence>","confidence":<0-100>,"rationale":"<2-3 sentences>"}
or
{"decision":"reject","reason":"<one sentence>","confidence":<0-100>,"rationale":"<2-3 sentences>"}`;

  // Pick a number of decimals that surfaces meaningful precision for low-priced
  // tokens (BONK at ~$0.0000063 needs 8 decimals; SOL at ~$84 only needs 2).
  const priceDecimals = input.currentPrice > 0 && input.currentPrice < 0.01
    ? Math.max(4, Math.ceil(-Math.log10(input.currentPrice)) + 3)
    : 4;
  const fmtP = (n: number) => '$' + n.toFixed(priceDecimals);

  const userContent = `## Market Context
Price: ${fmtP(input.currentPrice)}
SMA20: ${input.sma != null ? fmtP(input.sma) : 'N/A'}
Deviation from SMA: ${devPct}%
Volatility: ${volPct}%
Recent prices (oldest→newest): ${recentPrices}
Mode: ${input.mode}

## Candidate Buy Signals
${input.candidateSignals.map((s) => `- ${s.strategyName}: ${s.reason}`).join('\n')}

## Accumulated Learnings
${learnings}

Should I approve or reject this buy? Reply with JSON only.`;

  const fallback: DeciderOutput = {
    decision: 'reject',
    reason: 'API error — defaulting to reject',
    confidence: 0,
    rationale: '',
  };

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    const rawText = msg.content[0].type === 'text' ? msg.content[0].text.trim() : '';
    // Strip markdown code fences if the model wraps its JSON
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let parsed: DeciderOutput;
    try {
      parsed = JSON.parse(cleaned) as DeciderOutput;
    } catch {
      console.error('[AI-DECIDER] Failed to parse Haiku response:', rawText.slice(0, 200));
      return fallback;
    }

    logAiDecision({
      timestamp: new Date().toISOString(),
      action: parsed.decision,
      reason: parsed.reason,
      rationale: parsed.rationale,
      confidence: parsed.confidence,
      priceAtDecision: input.currentPrice,
      candidateSignals: JSON.stringify(input.candidateSignals),
      learningsSnapshot: learnings.slice(0, 500),
    });

    console.log(
      `[AI-DECIDER] ${parsed.decision.toUpperCase()} conf=${parsed.confidence}%: ${parsed.reason}`,
    );
    return parsed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[AI-DECIDER] Error calling Haiku:', msg);
    return fallback;
  }
}

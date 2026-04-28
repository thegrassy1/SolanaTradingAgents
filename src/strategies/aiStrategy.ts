import type { Strategy, StrategyContext, StrategySignal } from './base';
import { runDecider } from '../ai/decider';

export class AiStrategy implements Strategy {
  readonly name = 'ai_strategy_v1';
  readonly displayName = 'AI Filter';
  readonly description =
    'Claude Haiku-powered signal filter. Receives buy candidates from other strategies and approves or rejects each one based on market context and accumulated learnings.';

  getDefaultConfig(): Record<string, number> {
    return {
      /** Minimum Haiku confidence % required to approve a buy (0-100). */
      minConfidence: 60,
    };
  }

  validateConfig(config: Record<string, unknown>): boolean {
    if ('minConfidence' in config) {
      const v = Number(config.minConfidence);
      if (!Number.isFinite(v) || v < 0 || v > 100) return false;
    }
    return true;
  }

  async evaluate(context: StrategyContext): Promise<StrategySignal> {
    const candidates = context.candidateSignals ?? [];
    const buyCandidates = candidates.filter((c) => c.signal.action === 'buy');

    if (buyCandidates.length === 0) {
      return {
        action: 'hold',
        reason: 'No buy candidates from other strategies',
      };
    }

    const minConfidence = context.config.minConfidence ?? 60;

    const result = await runDecider({
      currentPrice: context.currentPrice,
      sma: context.sma,
      volatility: context.volatility,
      priceHistory: context.priceHistory ?? [],
      candidateSignals: buyCandidates.map((c) => ({
        strategyName: c.strategyName,
        action: c.signal.action,
        reason: c.signal.reason,
      })),
      mode: 'paper',
    });

    if (result.decision === 'approve' && result.confidence >= minConfidence) {
      return {
        action: 'buy',
        reason: result.reason,
        metadata: {
          confidence: result.confidence,
          rationale: result.rationale,
          approvedCandidates: buyCandidates.map((c) => c.strategyName),
        },
      };
    }

    const holdReason =
      result.decision === 'reject'
        ? `AI rejected: ${result.reason}`
        : `AI confidence too low (${result.confidence}% < ${minConfidence}%)`;

    return {
      action: 'hold',
      reason: holdReason,
      metadata: {
        confidence: result.confidence,
        rationale: result.rationale,
      },
    };
  }
}

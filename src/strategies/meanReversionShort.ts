import type { Strategy, StrategyContext, StrategySignal } from './base';

/**
 * Mean Reversion Short — mirror image of mean_reversion_v1, but enters
 * a leveraged short when price is ABOVE the SMA by `threshold`%. Exits
 * happen via stop loss / take profit as a perp position.
 *
 * Persona: VOID — The Reaper.
 *
 * Returns metadata.perp = { direction: 'short', leverage } so the agent
 * routes this through the perp engine instead of the spot engine.
 */
export class MeanReversionShortStrategy implements Strategy {
  readonly name = 'mean_reversion_short_v1';
  readonly displayName = 'Mean Reversion Short';
  readonly description =
    'Shorts when price climbs above the 20-period SMA by a configurable threshold. Uses 2x leverage on the perp engine.';

  getDefaultConfig(): Record<string, number> {
    return {
      threshold: 1.5,        // % above SMA required to short
      volatilityMax: 0.05,   // max rolling volatility allowed for entry
      leverage: 2,           // perp leverage
    };
  }

  validateConfig(config: Record<string, unknown>): boolean {
    const { threshold, volatilityMax, leverage } = config;
    if (
      threshold !== undefined &&
      (typeof threshold !== 'number' || threshold <= 0 || threshold > 100)
    ) return false;
    if (
      volatilityMax !== undefined &&
      (typeof volatilityMax !== 'number' || volatilityMax <= 0 || volatilityMax > 1)
    ) return false;
    if (
      leverage !== undefined &&
      (typeof leverage !== 'number' || leverage < 1 || leverage > 10)
    ) return false;
    return true;
  }

  evaluate(context: StrategyContext): StrategySignal {
    const { currentPrice, sma, volatility, openPosition, config } = context;
    const threshold = config.threshold ?? 1.5;
    const volatilityMax = config.volatilityMax ?? 0.05;
    const leverage = config.leverage ?? 2;

    if (openPosition) {
      return { action: 'hold', reason: 'position_open' };
    }
    if (sma === null || volatility === null) {
      return { action: 'hold', reason: 'insufficient_data' };
    }
    // Trigger: price > SMA × (1 + threshold/100), with controlled vol
    if (currentPrice > sma * (1 + threshold / 100) && volatility < volatilityMax) {
      const deviationPct = ((currentPrice - sma) / sma) * 100;
      return {
        action: 'buy',
        reason: `price_above_sma_${threshold.toFixed(1)}pct_short`,
        metadata: {
          deviationPct,
          volatility,
          threshold,
          volatilityMax,
          // Marker that tells the agent to route this through the perp engine
          perp: { direction: 'short', leverage } as const,
        },
      };
    }
    return { action: 'hold', reason: 'no_signal' };
  }
}

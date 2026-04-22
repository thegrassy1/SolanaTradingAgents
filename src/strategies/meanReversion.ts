import type { Strategy, StrategyContext, StrategySignal } from './base';

export class MeanReversionStrategy implements Strategy {
  readonly name = 'mean_reversion_v1';
  readonly displayName = 'Mean Reversion';
  readonly description =
    'Buys when SOL price dips below the 20-period SMA by a configurable threshold; exits via stop loss or take profit.';

  getDefaultConfig(): Record<string, number> {
    return {
      threshold: 2,        // % below SMA required to trigger a buy
      volatilityMax: 0.05, // max rolling volatility (decimal) allowed for entry
    };
  }

  validateConfig(config: Record<string, unknown>): boolean {
    const { threshold, volatilityMax } = config;
    if (
      threshold !== undefined &&
      (typeof threshold !== 'number' || threshold <= 0 || threshold > 100)
    )
      return false;
    if (
      volatilityMax !== undefined &&
      (typeof volatilityMax !== 'number' || volatilityMax <= 0 || volatilityMax > 1)
    )
      return false;
    return true;
  }

  evaluate(context: StrategyContext): StrategySignal {
    const { currentPrice, sma, volatility, openPosition, config } = context;
    const threshold = config.threshold ?? 2;
    const volatilityMax = config.volatilityMax ?? 0.05;

    if (openPosition) {
      return { action: 'hold', reason: 'position_open' };
    }
    if (sma === null || volatility === null) {
      return { action: 'hold', reason: 'insufficient_data' };
    }
    if (currentPrice < sma * (1 - threshold / 100) && volatility < volatilityMax) {
      const deviationPct = ((currentPrice - sma) / sma) * 100;
      return {
        action: 'buy',
        reason: `price_below_sma_${threshold.toFixed(1)}pct`,
        metadata: { deviationPct, volatility, threshold, volatilityMax },
      };
    }
    return { action: 'hold', reason: 'no_signal' };
  }
}

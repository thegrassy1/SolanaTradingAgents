import type { Strategy, StrategyContext, StrategySignal } from './base';

export class BreakoutStrategy implements Strategy {
  readonly name = 'breakout_v1';
  readonly displayName = 'Breakout';
  readonly description =
    'Buys when price breaks above the highest close of the prior lookback period; requires minimum volatility.';

  getDefaultConfig(): Record<string, number> {
    return {
      lookbackBars: 20,   // number of prior bars to scan for the high
      minVolatility: 0.001, // minimum rolling volatility (decimal) required
    };
  }

  validateConfig(config: Record<string, unknown>): boolean {
    const { lookbackBars, minVolatility } = config;
    if (
      lookbackBars !== undefined &&
      (typeof lookbackBars !== 'number' || lookbackBars < 2 || lookbackBars > 500)
    )
      return false;
    if (
      minVolatility !== undefined &&
      (typeof minVolatility !== 'number' || minVolatility < 0 || minVolatility > 1)
    )
      return false;
    return true;
  }

  evaluate(context: StrategyContext): StrategySignal {
    const { currentPrice, volatility, openPosition, config, priceHistory } = context;
    const lookbackBars = Math.round(config.lookbackBars ?? 20);
    const minVolatility = config.minVolatility ?? 0.001;

    if (openPosition) {
      return { action: 'hold', reason: 'position_open' };
    }
    if (volatility === null || volatility < minVolatility) {
      return { action: 'hold', reason: 'low_volatility' };
    }
    // Need lookbackBars prior bars + at least one current bar
    if (!priceHistory || priceHistory.length < lookbackBars + 1) {
      return { action: 'hold', reason: 'insufficient_data' };
    }
    // Use the prior N bars (everything before the current bar) to find the high
    const priorBars = priceHistory.slice(0, -1).slice(-lookbackBars);
    const highestHigh = Math.max(...priorBars.map((p) => p.price));
    if (currentPrice > highestHigh) {
      return {
        action: 'buy',
        reason: 'price_above_lookback_high',
        metadata: { highestHigh, lookbackBars, volatility },
      };
    }
    return { action: 'hold', reason: 'no_breakout' };
  }
}

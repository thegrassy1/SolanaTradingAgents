import type { Strategy, StrategyContext, StrategySignal } from './base';

export class BuyAndHoldStrategy implements Strategy {
  readonly name = 'buy_and_hold_v1';
  readonly displayName = 'Buy & Hold';
  readonly description =
    'Converts 100% of initial USDC to SOL on first tick and holds indefinitely. Benchmark baseline.';

  getDefaultConfig(): Record<string, number> {
    return {
      initialAllocationPercent: 1.0, // fraction of USDC to allocate (1.0 = 100%)
    };
  }

  validateConfig(config: Record<string, unknown>): boolean {
    const { initialAllocationPercent } = config;
    if (
      initialAllocationPercent !== undefined &&
      (typeof initialAllocationPercent !== 'number' ||
        initialAllocationPercent <= 0 ||
        initialAllocationPercent > 1)
    )
      return false;
    return true;
  }

  // Initial allocation is handled externally by the agent;
  // this strategy never emits a trading signal.
  evaluate(_context: StrategyContext): StrategySignal {
    return { action: 'hold', reason: 'buy_and_hold' };
  }
}

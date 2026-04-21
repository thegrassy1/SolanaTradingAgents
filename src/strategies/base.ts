export interface StrategyContext {
  currentPrice: number;
  sma: number | null;
  volatility: number | null;
  openPosition: { id: string; entryPrice: number; amount: bigint; strategy: string } | null;
  /** Live numeric config for this strategy (merged defaults + overrides). */
  config: Record<string, number>;
}

export interface StrategySignal {
  action: 'buy' | 'sell' | 'hold';
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface Strategy {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  evaluate(context: StrategyContext): StrategySignal;
  getDefaultConfig(): Record<string, number>;
  validateConfig(config: Record<string, unknown>): boolean;
}

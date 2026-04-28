export interface CandidateSignal {
  strategyName: string;
  signal: StrategySignal;
}

export interface StrategyContext {
  currentPrice: number;
  sma: number | null;
  volatility: number | null;
  openPosition: { id: string; entryPrice: number; amount: bigint; strategy: string } | null;
  /** Live numeric config for this strategy (merged defaults + overrides). */
  config: Record<string, number>;
  /** Recent price history (newest last). Strategies that don't need it can ignore it. */
  priceHistory?: Array<{ t: number; price: number }>;
  /**
   * Buy/sell/hold signals collected from other strategies this tick.
   * Populated only for the AI strategy so it can filter candidates.
   */
  candidateSignals?: CandidateSignal[];
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
  /** May return a plain StrategySignal (synchronous) or a Promise (async strategies like AI). */
  evaluate(context: StrategyContext): StrategySignal | Promise<StrategySignal>;
  getDefaultConfig(): Record<string, number>;
  validateConfig(config: Record<string, unknown>): boolean;
}

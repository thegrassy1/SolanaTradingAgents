export interface JupiterOrderResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  transaction: string | null;
  requestId: string;
  mode: string;
}

export interface JupiterExecuteResponse {
  status: string;
  signature: string;
  slot: number;
  inputAmountResult: string;
  outputAmountResult: string;
  swapEvents: unknown;
}

export interface TradeRecord {
  id?: number;
  timestamp: string;
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  outputAmount: string;
  expectedOutput?: string;
  txSignature: string;
  status: string;
  priceImpact?: string;
  mode: 'paper' | 'live';
  strategy?: string;
  slippageBps?: number;
  errorMessage?: string;
  priceAtTrade?: number;
  entryPrice?: number;
  exitPrice?: number;
  exitReason?: string;
  /**
   * Legacy gross P&L for this exit (mark-to-market, `(exit - entry) * size`).
   * Kept for backward compatibility with OpenClaw agents reading `realizedPnl`.
   */
  realizedPnl?: number;
  /** Alias of `realizedPnl`. Always gross of fees. */
  realizedPnlGross?: number;
  /**
   * True realized P&L net of fees, computed from actual balance flows
   * (`exitQuoteAmount - entryQuoteAmount - solFees`). Only present when
   * the position was opened after the fee-aware refactor.
   */
  realizedPnlNet?: number;
  /** Total fees for this trade leg in quote currency (taker haircut + SOL network fee). */
  feesQuote?: number;
  /** Taker fee bps applied to this trade's output. */
  takerFeeBps?: number;
  /** Taker haircut amount in quote currency (informational). */
  takerFeeQuote?: number;
  /** SOL base network fee in lamports paid by this trade. */
  networkFeeLamports?: number;
  /** SOL priority / compute-unit fee in lamports paid by this trade. */
  priorityFeeLamports?: number;
  /** Total SOL fees (network + priority) expressed in quote currency. */
  solFeeQuote?: number;
}

export interface PaperPortfolio {
  balances: Record<string, number>;
  trades: TradeRecord[];
  startTime: string;
  initialBalances: Record<string, number>;
}

export interface SwapResult {
  order: JupiterOrderResponse;
  result: JupiterExecuteResponse | null;
}

export type AgentMode = 'paper' | 'live';

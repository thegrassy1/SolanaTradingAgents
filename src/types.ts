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

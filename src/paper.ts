import fs from 'fs';
import path from 'path';
import { config } from './config';
import { swapPaper } from './swap';
import type { TradeRecord } from './types';
import { getTokenDecimals, getTokenSymbol } from './tokenInfo';

const DATA_DIR = path.join(process.cwd(), 'data');
const DEFAULT_PORTFOLIO_FILE = path.join(DATA_DIR, 'paper-portfolio.json');
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function humanToSmallest(mint: string, human: number): bigint {
  const d = getTokenDecimals(mint);
  const factor = 10 ** d;
  return BigInt(Math.round(human * factor));
}

function smallestToHuman(mint: string, raw: bigint): number {
  const d = getTokenDecimals(mint);
  return Number(raw) / 10 ** d;
}

type PortfolioSnapshot = {
  balances: Record<string, string>;
  tradeHistory: TradeRecord[];
  startTime: string;
  initialBalancesSmallest: Record<string, string>;
  initialQuoteValue: number | null;
  quoteMintForPnl: string;
  defaultInitialHuman?: Record<string, number>;
};

export class PaperTradingEngine {
  balances: Record<string, bigint> = {};
  tradeHistory: TradeRecord[] = [];
  startTime!: Date;
  initialBalancesSmallest: Record<string, bigint> = {};
  private initialQuoteValue: number | null = null;
  private quoteMintForPnl: string;
  private defaultInitialHuman: Record<string, number>;
  private readonly portfolioFile: string;

  constructor(
    initialBalancesHuman: Record<string, number>,
    quoteMintForPnl: string,
    storagePath?: string,
  ) {
    this.portfolioFile = storagePath ?? DEFAULT_PORTFOLIO_FILE;
    this.quoteMintForPnl = quoteMintForPnl;
    this.defaultInitialHuman = { ...initialBalancesHuman };
    if (fs.existsSync(this.portfolioFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.portfolioFile, 'utf8')) as PortfolioSnapshot;
        this.hydrateFromSnapshot(parsed, initialBalancesHuman);
        console.log(`[PAPER] Restored portfolio from ${path.basename(this.portfolioFile)}`);
        return;
      } catch (e) {
        console.warn('[PAPER] Failed to restore portfolio, using fresh state:', e);
      }
    }
    this.startTime = new Date();
    this.applyHumanBalances(initialBalancesHuman);
  }

  private applyHumanBalances(initialBalancesHuman: Record<string, number>): void {
    this.balances = {};
    this.initialBalancesSmallest = {};
    for (const [mint, human] of Object.entries(initialBalancesHuman)) {
      const raw = humanToSmallest(mint, human);
      this.balances[mint] = raw;
      this.initialBalancesSmallest[mint] = raw;
    }
  }

  private hydrateFromSnapshot(
    data: PortfolioSnapshot,
    fallbackHuman: Record<string, number>,
  ): void {
    this.quoteMintForPnl = data.quoteMintForPnl ?? this.quoteMintForPnl;
    this.defaultInitialHuman =
      data.defaultInitialHuman &&
      typeof data.defaultInitialHuman === 'object' &&
      Object.keys(data.defaultInitialHuman).length > 0
        ? { ...data.defaultInitialHuman }
        : { ...fallbackHuman };
    this.balances = {};
    for (const [k, v] of Object.entries(data.balances ?? {})) {
      this.balances[k] = BigInt(v);
    }
    this.initialBalancesSmallest = {};
    for (const [k, v] of Object.entries(data.initialBalancesSmallest ?? {})) {
      this.initialBalancesSmallest[k] = BigInt(v);
    }
    this.tradeHistory = data.tradeHistory ?? [];
    this.startTime = new Date(data.startTime ?? Date.now());
    this.initialQuoteValue =
      typeof data.initialQuoteValue === 'number' ? data.initialQuoteValue : null;
  }

  async ensureInitialQuoteCaptured(): Promise<void> {
    if (this.initialQuoteValue !== null) return;
    const { totalValue } = await this.getPortfolioValue(this.quoteMintForPnl);
    this.initialQuoteValue = totalValue;
    console.log(`[PAPER] Baseline portfolio value (${this.quoteMintForPnl}): ${totalValue}`);
    this.persist();
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.portfolioFile), { recursive: true });
    const snap: PortfolioSnapshot = {
      balances: {},
      tradeHistory: this.tradeHistory,
      startTime: this.startTime.toISOString(),
      initialBalancesSmallest: {},
      initialQuoteValue: this.initialQuoteValue,
      quoteMintForPnl: this.quoteMintForPnl,
      defaultInitialHuman: this.defaultInitialHuman,
    };
    for (const [k, v] of Object.entries(this.balances)) {
      snap.balances[k] = v.toString();
    }
    for (const [k, v] of Object.entries(this.initialBalancesSmallest)) {
      snap.initialBalancesSmallest[k] = v.toString();
    }
    fs.writeFileSync(this.portfolioFile, JSON.stringify(snap, null, 2), 'utf8');
  }

  async executePaperTrade(
    inputMint: string,
    outputMint: string,
    amountSmallestUnits: bigint,
    strategy = 'manual',
    priceSolUsdc?: number,
  ): Promise<TradeRecord> {
    const bal = this.balances[inputMint] ?? 0n;
    if (bal < amountSmallestUnits) {
      throw new Error(
        `[PAPER] Insufficient balance for ${getTokenSymbol(inputMint)}: have ${bal} need ${amountSmallestUnits}`,
      );
    }
    const { order } = await swapPaper(inputMint, outputMint, amountSmallestUnits);
    const quotedOut = BigInt(order.outAmount);

    // Taker fee: applied as bps haircut on the quoted output amount.
    const takerBps = BigInt(Math.max(0, config.paperTakerFeeBps | 0));
    const takerFeeRaw = (quotedOut * takerBps) / 10_000n;
    const adjustedOut = quotedOut - takerFeeRaw;

    // Network + priority fees: paid in SOL on every swap, deducted from
    // SOL balance (clamped at zero so paper can't overdraft).
    const baseFeeLamports = BigInt(Math.max(0, config.paperNetworkFeeLamports | 0));
    const prioFeeLamports = BigInt(Math.max(0, config.paperPriorityFeeLamports | 0));
    const totalSolFeeLamports = baseFeeLamports + prioFeeLamports;

    this.balances[inputMint] = bal - amountSmallestUnits;
    this.balances[outputMint] =
      (this.balances[outputMint] ?? 0n) + adjustedOut;

    const curSol = this.balances[SOL_MINT] ?? 0n;
    const solFeePaid = curSol >= totalSolFeeLamports ? totalSolFeeLamports : curSol;
    if (solFeePaid > 0n) {
      this.balances[SOL_MINT] = curSol - solFeePaid;
    }

    // Convert fees to quote currency for reporting.
    const px = typeof priceSolUsdc === 'number' && isFinite(priceSolUsdc)
      ? priceSolUsdc
      : 0;
    const takerFeeHuman = smallestToHuman(outputMint, takerFeeRaw);
    let takerFeeQuote = 0;
    if (outputMint === this.quoteMintForPnl) {
      takerFeeQuote = takerFeeHuman;
    } else if (outputMint === SOL_MINT && px > 0) {
      takerFeeQuote = takerFeeHuman * px;
    }
    const solFeeHuman = Number(solFeePaid) / 1e9;
    const solFeeQuote = px > 0 ? solFeeHuman * px : 0;
    const feesQuote = takerFeeQuote + solFeeQuote;

    const record: TradeRecord = {
      timestamp: new Date().toISOString(),
      inputMint,
      outputMint,
      inputAmount: amountSmallestUnits.toString(),
      outputAmount: adjustedOut.toString(),
      expectedOutput: quotedOut.toString(),
      txSignature: `PAPER-${Date.now()}`,
      status: 'paper_filled',
      priceImpact: order.priceImpactPct,
      mode: 'paper',
      strategy,
      slippageBps: order.slippageBps,
      takerFeeBps: Number(takerBps),
      takerFeeQuote,
      networkFeeLamports: Number(baseFeeLamports),
      priorityFeeLamports: Number(prioFeeLamports),
      solFeeQuote,
      feesQuote,
    };
    this.tradeHistory.push(record);
    const hi = smallestToHuman(inputMint, amountSmallestUnits);
    const ho = smallestToHuman(outputMint, adjustedOut);
    console.log(
      `[PAPER] Executed: ${hi.toFixed(6)} ${getTokenSymbol(inputMint)} \u2192 ${ho.toFixed(6)} ${getTokenSymbol(outputMint)} ` +
      `fees: taker=${takerFeeQuote.toFixed(4)} sol=${solFeeQuote.toFixed(4)} total=${feesQuote.toFixed(4)} (quote)`,
    );
    this.persist();
    return record;
  }

  getBalance(mint: string): { raw: bigint; human: number } {
    const raw = this.balances[mint] ?? 0n;
    return { raw, human: smallestToHuman(mint, raw) };
  }

  getAllBalances(): Record<string, { raw: bigint; human: number }> {
    const out: Record<string, { raw: bigint; human: number }> = {};
    for (const [mint, raw] of Object.entries(this.balances)) {
      if (raw === 0n) continue;
      out[mint] = { raw, human: smallestToHuman(mint, raw) };
    }
    return out;
  }

  async getPortfolioValue(quoteMint: string): Promise<{
    totalValue: number;
    breakdown: { mint: string; balance: number; valueInQuote: number }[];
  }> {
    const breakdown: { mint: string; balance: number; valueInQuote: number }[] = [];
    let totalValue = 0;
    for (const [mint, raw] of Object.entries(this.balances)) {
      if (raw === 0n) continue;
      const balanceHuman = smallestToHuman(mint, raw);
      if (mint === quoteMint) {
        breakdown.push({ mint, balance: balanceHuman, valueInQuote: balanceHuman });
        totalValue += balanceHuman;
        continue;
      }
      const { order } = await swapPaper(mint, quoteMint, raw);
      const quoteHuman = smallestToHuman(quoteMint, BigInt(order.outAmount));
      breakdown.push({ mint, balance: balanceHuman, valueInQuote: quoteHuman });
      totalValue += quoteHuman;
    }
    return { totalValue, breakdown };
  }

  async getPnL(quoteMint: string): Promise<{
    currentValue: number;
    initialValue: number;
    pnl: number;
    pnlPercent: number;
  }> {
    if (this.initialQuoteValue === null) {
      await this.ensureInitialQuoteCaptured();
    }
    const { totalValue: currentValue } = await this.getPortfolioValue(quoteMint);
    const initialValue = this.initialQuoteValue ?? currentValue;
    const pnl = currentValue - initialValue;
    const pnlPercent = initialValue === 0 ? 0 : (pnl / initialValue) * 100;
    return { currentValue, initialValue, pnl, pnlPercent };
  }

  getTradeHistory(limit?: number): TradeRecord[] {
    const sorted = [...this.tradeHistory].reverse();
    return limit === undefined ? sorted : sorted.slice(0, limit);
  }

  flushToDisk(): void {
    this.persist();
  }

  reset(initialBalancesHuman?: Record<string, number>): void {
    const human = initialBalancesHuman ?? this.defaultInitialHuman;
    this.defaultInitialHuman = { ...human };
    this.tradeHistory = [];
    this.startTime = new Date();
    this.initialQuoteValue = null;
    this.applyHumanBalances(human);
    this.persist();
    console.log('[PAPER] Portfolio reset');
  }

  toJSON(): Record<string, unknown> {
    const snap: PortfolioSnapshot = {
      balances: {},
      tradeHistory: this.tradeHistory,
      startTime: this.startTime.toISOString(),
      initialBalancesSmallest: {},
      initialQuoteValue: this.initialQuoteValue,
      quoteMintForPnl: this.quoteMintForPnl,
      defaultInitialHuman: this.defaultInitialHuman,
    };
    for (const [k, v] of Object.entries(this.balances)) {
      snap.balances[k] = v.toString();
    }
    for (const [k, v] of Object.entries(this.initialBalancesSmallest)) {
      snap.initialBalancesSmallest[k] = v.toString();
    }
    return snap as unknown as Record<string, unknown>;
  }

  static fromJSON(data: Record<string, unknown>): PaperTradingEngine {
    const snap = data as unknown as PortfolioSnapshot;
    const quoteMint =
      snap.quoteMintForPnl ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const engine = Object.create(PaperTradingEngine.prototype) as PaperTradingEngine;
    engine.quoteMintForPnl = quoteMint;
    engine.hydrateFromSnapshot(snap, snap.defaultInitialHuman ?? {});
    return engine;
  }
}

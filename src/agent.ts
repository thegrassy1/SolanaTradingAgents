import { config, type AppConfig } from './config';
import {
  getRecentTrades,
  getTradeSummary,
  logPrice,
  logTrade,
} from './db';
import { PaperTradingEngine } from './paper';
import { calculatePrice, getQuote, PriceMonitor } from './price';
import { swap } from './swap';
import type { TradeRecord } from './types';
import { getTokenDecimals } from './tokenInfo';
import { loadWallet } from './wallet';

const SOL = config.baseMint;
const USDC = config.quoteMint;

function humanToRawAmount(mint: string, human: number): bigint {
  return BigInt(Math.round(human * 10 ** getTokenDecimals(mint)));
}

export class TradingAgent {
  private readonly cfg: AppConfig;
  readonly priceMonitor: PriceMonitor;
  readonly paperEngine: PaperTradingEngine;
  private running = false;
  mode: 'paper' | 'live';
  private cooldownUntil = 0;
  readonly COOLDOWN_MS = 5 * 60 * 1000;
  private liveVirtualSol: bigint;
  private liveVirtualUsdc: bigint;
  private startedAt: Date | null = null;
  private thresholdPct = 2;
  private cooldownMs = this.COOLDOWN_MS;
  private tradeAmountLamports: number;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.mode = cfg.mode;
    this.tradeAmountLamports = cfg.tradeAmountLamports;
    this.liveVirtualSol = BigInt(Math.round(cfg.paperInitialSol * 1e9));
    this.liveVirtualUsdc = BigInt(Math.round(cfg.paperInitialUsdc * 1e6));
    this.paperEngine = new PaperTradingEngine(
      {
        [SOL]: cfg.paperInitialSol,
        [USDC]: cfg.paperInitialUsdc,
      },
      cfg.quoteMint,
    );
    this.priceMonitor = new PriceMonitor(
      cfg.baseMint,
      cfg.quoteMint,
      cfg.tradeAmountLamports,
      cfg.pollIntervalMs,
    );
  }

  start(): void {
    if (this.running) {
      console.log('[AGENT] Already running');
      return;
    }
    this.running = true;
    this.startedAt = new Date();
    const wallet = loadWallet();
    console.log(
      `[AGENT] Startup mode=${this.mode.toUpperCase()} base=${this.cfg.baseMint} quote=${this.cfg.quoteMint} tradeLamports=${this.tradeAmountLamports} pollMs=${this.cfg.pollIntervalMs}`,
    );
    if (this.mode === 'live' && wallet) {
      console.log(`[AGENT] Live wallet: ${wallet.publicKey.toBase58()}`);
    }
    if (this.mode === 'paper') {
      console.log(
        `[AGENT] Paper balances (human): SOL=${this.cfg.paperInitialSol} USDC=${this.cfg.paperInitialUsdc}`,
      );
    }
    void this.paperEngine.ensureInitialQuoteCaptured();
    this.priceMonitor.onPriceUpdate = (price, sma20) => {
      const vol = this.priceMonitor.getVolatility(20);
      logPrice(this.cfg.baseMint, this.cfg.quoteMint, price, sma20, vol);
      void this.evaluate();
    };
    this.priceMonitor.start();
    console.log(`[AGENT] Agent started in ${this.mode.toUpperCase()} mode`);
  }

  stop(): void {
    if (!this.running) {
      console.log('[AGENT] Not running');
      return;
    }
    this.running = false;
    this.priceMonitor.stop();
    const summary = getTradeSummary();
    console.log('[AGENT] Trade summary:', JSON.stringify(summary));
    if (this.mode === 'paper') {
      void this.paperEngine.getPnL(this.cfg.quoteMint).then((p) => {
        console.log(
          `[AGENT] Paper P&L: ${p.pnl.toFixed(2)} (${p.pnlPercent.toFixed(2)}%)`,
        );
      });
    }
    this.paperEngine.flushToDisk();
    console.log('[AGENT] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getStartedAt(): Date | null {
    return this.startedAt;
  }

  private async resolvePriceSolUsdc(): Promise<number> {
    const p = this.priceMonitor.getLatestPrice();
    if (p !== null && p > 0) return p;
    const q = await getQuote(
      this.cfg.baseMint,
      this.cfg.quoteMint,
      this.tradeAmountLamports,
    );
    const din = getTokenDecimals(this.cfg.baseMint);
    const dout = getTokenDecimals(this.cfg.quoteMint);
    return calculatePrice(q, din, dout);
  }

  private capInputRaw(inputMint: string, raw: bigint): bigint {
    const paperBal = this.paperEngine.getBalance(inputMint).raw;
    if (this.mode === 'paper') {
      return raw > paperBal ? paperBal : raw;
    }
    if (inputMint === SOL) {
      return raw > this.liveVirtualSol ? this.liveVirtualSol : raw;
    }
    if (inputMint === USDC) {
      return raw > this.liveVirtualUsdc ? this.liveVirtualUsdc : raw;
    }
    return raw;
  }

  private isSolUsdcPair(a: string, b: string): boolean {
    const s = new Set([a, b]);
    return s.has(SOL) && s.has(USDC);
  }

  private async executeSwapLeg(
    inputMint: string,
    outputMint: string,
    inputRaw: bigint,
    priceSolUsdc: number,
    strategy: string,
  ): Promise<TradeRecord> {
    if (inputRaw <= 0n) {
      const rec: TradeRecord = {
        timestamp: new Date().toISOString(),
        inputMint,
        outputMint,
        inputAmount: '0',
        outputAmount: '0',
        txSignature: 'n/a',
        status: 'failed',
        mode: this.mode,
        strategy,
        errorMessage: 'Amount must be positive',
        priceAtTrade: priceSolUsdc,
      };
      logTrade(rec);
      return rec;
    }

    try {
      if (this.mode === 'paper') {
        const rec = await this.paperEngine.executePaperTrade(
          inputMint,
          outputMint,
          inputRaw,
          strategy,
        );
        rec.priceAtTrade = priceSolUsdc;
        logTrade(rec);
        return rec;
      }

      const { order, result } = await swap(inputMint, outputMint, inputRaw, 'live');
      if (!result) throw new Error('Live swap missing result');
      const ok = String(result.status).toLowerCase().includes('success');
      const rec: TradeRecord = {
        timestamp: new Date().toISOString(),
        inputMint,
        outputMint,
        inputAmount: result.inputAmountResult ?? order.inAmount,
        outputAmount: result.outputAmountResult ?? order.outAmount,
        expectedOutput: order.outAmount,
        txSignature: result.signature,
        status: ok ? 'success' : 'failed',
        priceImpact: order.priceImpactPct,
        mode: 'live',
        strategy,
        slippageBps: order.slippageBps,
        priceAtTrade: priceSolUsdc,
      };
      logTrade(rec);
      if (ok && this.isSolUsdcPair(inputMint, outputMint)) {
        await this.paperEngine.executePaperTrade(
          inputMint,
          outputMint,
          inputRaw,
          'shadow_live',
        );
        if (inputMint === SOL) {
          this.liveVirtualSol -= BigInt(rec.inputAmount);
        }
        if (inputMint === USDC) {
          this.liveVirtualUsdc -= BigInt(rec.inputAmount);
        }
        if (outputMint === SOL) {
          this.liveVirtualSol += BigInt(rec.outputAmount);
        }
        if (outputMint === USDC) {
          this.liveVirtualUsdc += BigInt(rec.outputAmount);
        }
      }
      return rec;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[AGENT] executeSwapLeg failed:', msg);
      const failed: TradeRecord = {
        timestamp: new Date().toISOString(),
        inputMint,
        outputMint,
        inputAmount: inputRaw.toString(),
        outputAmount: '0',
        txSignature: 'n/a',
        status: 'failed',
        mode: this.mode,
        strategy,
        errorMessage: msg,
        priceAtTrade: priceSolUsdc,
      };
      logTrade(failed);
      return failed;
    }
  }

  private applyCooldownIfFilled(rec: TradeRecord): void {
    if (rec.status === 'paper_filled' || rec.status === 'success') {
      this.cooldownUntil = Date.now() + this.cooldownMs;
      console.log(
        `[AGENT] Trade executed. Cooldown until ${new Date(this.cooldownUntil).toISOString()}`,
      );
    }
  }

  /**
   * Public API: execute a single swap (amount is human units of the input token).
   */
  async executeTrade(params: {
    direction: 'buy' | 'sell';
    amount: number;
    inputMint?: string;
    outputMint?: string;
  }): Promise<TradeRecord> {
    const strategy = 'api';
    const priceSolUsdc = await this.resolvePriceSolUsdc();
    const inputMint =
      params.inputMint ??
      (params.direction === 'buy' ? USDC : SOL);
    const outputMint =
      params.outputMint ??
      (params.direction === 'buy' ? SOL : USDC);

    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      const rec: TradeRecord = {
        timestamp: new Date().toISOString(),
        inputMint,
        outputMint,
        inputAmount: '0',
        outputAmount: '0',
        txSignature: 'n/a',
        status: 'failed',
        mode: this.mode,
        strategy,
        errorMessage: 'Invalid amount',
        priceAtTrade: priceSolUsdc,
      };
      logTrade(rec);
      return rec;
    }

    let inputRaw = humanToRawAmount(inputMint, params.amount);
    inputRaw = this.capInputRaw(inputMint, inputRaw);
    if (inputRaw <= 0n) {
      const rec: TradeRecord = {
        timestamp: new Date().toISOString(),
        inputMint,
        outputMint,
        inputAmount: '0',
        outputAmount: '0',
        txSignature: 'n/a',
        status: 'failed',
        mode: this.mode,
        strategy,
        errorMessage: 'Insufficient balance for input token',
        priceAtTrade: priceSolUsdc,
      };
      logTrade(rec);
      return rec;
    }

    const rec = await this.executeSwapLeg(
      inputMint,
      outputMint,
      inputRaw,
      priceSolUsdc,
      strategy,
    );
    this.applyCooldownIfFilled(rec);
    return rec;
  }

  private async evaluate(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    if (now < this.cooldownUntil) {
      const sec = Math.ceil((this.cooldownUntil - now) / 1000);
      console.log(`[AGENT] Cooling down, ${sec}s remaining`);
      return;
    }
    const n = this.priceMonitor.getSampleCount();
    if (n < 10) {
      console.log(`[AGENT] Warming up, ${n}/10 prices collected`);
      return;
    }
    const price = this.priceMonitor.getLatestPrice();
    const sma = this.priceMonitor.getMovingAverage(20);
    const vol = this.priceMonitor.getVolatility(20);
    if (price === null || sma === null) return;
    const deviationPct = sma !== 0 ? ((price - sma) / sma) * 100 : 0;
    const volPct = vol * 100;
    const t = this.thresholdPct;
    let signal: 'buy' | 'sell' | 'none' = 'none';
    if (price < sma * (1 - t / 100) && vol < 0.05) signal = 'buy';
    if (price > sma * (1 + t / 100) && vol < 0.05) signal = 'sell';
    console.log(
      `[AGENT] price=${price.toFixed(4)} sma=${sma.toFixed(4)} dev=${deviationPct.toFixed(2)}% vol=${volPct.toFixed(2)}% signal=${signal}`,
    );
    if (signal !== 'none') {
      await this.executeSignalTrade(signal, price);
    }
  }

  private async executeSignalTrade(
    direction: 'buy' | 'sell',
    priceSolUsdc: number,
  ): Promise<void> {
    const strategy = 'mean_reversion_v1';
    try {
      if (direction === 'buy') {
        const maxUsdcRaw =
          this.mode === 'paper'
            ? this.paperEngine.getBalance(USDC).raw
            : this.liveVirtualUsdc;
        const usdcSpend = Math.min(
          Number(maxUsdcRaw),
          Math.floor((this.tradeAmountLamports / 1e9) * priceSolUsdc * 1e6),
        );
        if (usdcSpend < 10_000) {
          console.log('[AGENT] Buy skipped: USDC spend too small');
          return;
        }
        const amountUsdc = BigInt(usdcSpend);
        const rec = await this.executeSwapLeg(
          USDC,
          SOL,
          amountUsdc,
          priceSolUsdc,
          strategy,
        );
        this.applyCooldownIfFilled(rec);
      } else {
        const solBal =
          this.mode === 'paper'
            ? this.paperEngine.getBalance(SOL).raw
            : this.liveVirtualSol;
        const amountSol = BigInt(
          Math.min(Number(this.tradeAmountLamports), Number(solBal)),
        );
        if (amountSol <= 0n) {
          console.log('[AGENT] Sell skipped: no SOL');
          return;
        }
        const rec = await this.executeSwapLeg(
          SOL,
          USDC,
          amountSol,
          priceSolUsdc,
          strategy,
        );
        this.applyCooldownIfFilled(rec);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[AGENT] executeSignalTrade failed:', msg);
      const failed: TradeRecord = {
        timestamp: new Date().toISOString(),
        inputMint: direction === 'buy' ? USDC : SOL,
        outputMint: direction === 'buy' ? SOL : USDC,
        inputAmount: '0',
        outputAmount: '0',
        txSignature: 'n/a',
        status: 'failed',
        mode: this.mode,
        strategy,
        errorMessage: msg,
        priceAtTrade: priceSolUsdc,
      };
      logTrade(failed);
    }
  }

  async getStatus(): Promise<{
    mode: 'paper' | 'live';
    running: boolean;
    latestPrice: number | null;
    priceChange: number | null;
    sma: number | null;
    volatility: number | null;
    cooldownRemaining: number;
    paperPortfolio: unknown;
    recentTrades: ReturnType<typeof getRecentTrades>;
    tradeSummary: ReturnType<typeof getTradeSummary>;
    uptimeMs: number;
  }> {
    const pnl = await this.paperEngine.getPnL(this.cfg.quoteMint);
    const all = this.paperEngine.getAllBalances();
    return {
      mode: this.mode,
      running: this.running,
      latestPrice: this.priceMonitor.getLatestPrice(),
      priceChange: this.priceMonitor.getPriceChange(),
      sma: this.priceMonitor.getMovingAverage(20),
      volatility: this.priceMonitor.getVolatility(20),
      cooldownRemaining: Math.max(
        0,
        Math.ceil((this.cooldownUntil - Date.now()) / 1000),
      ),
      paperPortfolio: { balances: all, pnl },
      recentTrades: getRecentTrades(5, this.mode),
      tradeSummary: getTradeSummary(this.mode),
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
    };
  }

  switchMode(newMode: 'paper' | 'live'): void {
    if (newMode === 'live') {
      const w = loadWallet();
      if (!w) throw new Error('Cannot switch to live: wallet not configured');
    }
    console.log(`[AGENT] Switching to ${newMode.toUpperCase()} mode`);
    this.mode = newMode;
  }

  setRuntimeConfig(key: string, value: string): void {
    const k = key.toLowerCase();
    if (k === 'trade_amount' || k === 'trade_amount_lamports') {
      this.tradeAmountLamports = Number(value);
      return;
    }
    if (k === 'threshold') {
      this.thresholdPct = Number(value);
      return;
    }
    if (k === 'cooldown') {
      this.cooldownMs = Number(value) * 60 * 1000;
    }
  }

  getRuntimeConfigView(): Record<string, string | number> {
    return {
      mode: this.mode,
      tradeAmountLamports: this.tradeAmountLamports,
      thresholdPct: this.thresholdPct,
      cooldownMinutes: this.cooldownMs / 60_000,
      pollIntervalMs: this.cfg.pollIntervalMs,
      paperInitialSol: this.cfg.paperInitialSol,
      paperInitialUsdc: this.cfg.paperInitialUsdc,
    };
  }

  getPaperEngine(): PaperTradingEngine {
    return this.paperEngine;
  }

  getConfig(): AppConfig {
    return this.cfg;
  }
}

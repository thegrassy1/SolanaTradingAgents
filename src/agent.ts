import { config, type AppConfig } from './config';
import {
  getRecentTrades,
  getTradeSummary,
  logPrice,
  logTrade,
} from './db';
import { PaperTradingEngine } from './paper';
import { PositionManager } from './positions';
import { calculatePrice, getQuote, PriceMonitor } from './price';
import { RiskManager, type TradeOutcome } from './risk';
import { swap } from './swap';
import type { TradeRecord } from './types';
import { getTokenDecimals } from './tokenInfo';
import {
  loadRuntimeConfigFile,
  saveRuntimeConfigFile,
  snapshotToPersistable,
} from './runtimeConfigPersist';
import type { ExitSignal } from './positions';
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
  readonly positionManager: PositionManager;
  readonly riskManager: RiskManager;
  private running = false;
  mode: 'paper' | 'live';
  private cooldownUntil = 0;
  private liveVirtualSol: bigint;
  private liveVirtualUsdc: bigint;
  private startedAt: Date | null = null;
  private thresholdPct = 2;
  private tradeAmountLamports: number;
  private dailyDateKeyUtc: string;
  private dailyStartingValueQuote = 0;
  private dailyRealizedPnL = 0;
  private lastTradeResult: TradeOutcome = null;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.mode = cfg.mode;
    this.tradeAmountLamports = cfg.tradeAmountLamports;
    this.liveVirtualSol = BigInt(Math.round(cfg.paperInitialSol * 1e9));
    this.liveVirtualUsdc = BigInt(Math.round(cfg.paperInitialUsdc * 1e6));
    this.dailyDateKeyUtc = new Date().toISOString().slice(0, 10);
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
    this.positionManager = new PositionManager();
    this.riskManager = new RiskManager(cfg);
    this.loadPersistedRuntimeKeys();
  }

  private loadPersistedRuntimeKeys(): void {
    const data = loadRuntimeConfigFile();
    if (!data) return;
    let n = 0;
    for (const [k, v] of Object.entries(data)) {
      if (this.applyRuntimeConfigValue(k, v)) n += 1;
    }
    if (n > 0) {
      console.log(`[CONFIG] Loaded ${n} runtime overrides from disk`);
    }
  }

  /** Apply one /config key; returns true if a known key was applied. */
  private applyRuntimeConfigValue(key: string, value: string): boolean {
    const k = key.toLowerCase().replace(/-/g, '_');
    if (this.riskManager.setFromKey(key, value)) return true;
    if (k === 'trade_amount' || k === 'trade_amount_lamports') {
      this.tradeAmountLamports = Number(value);
      return true;
    }
    if (k === 'threshold') {
      this.thresholdPct = Number(value);
      return true;
    }
    return false;
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

  private async portfolioValueQuote(): Promise<number> {
    const { totalValue } = await this.paperEngine.getPortfolioValue(
      this.cfg.quoteMint,
    );
    return totalValue;
  }

  private async ensureDailyNav(): Promise<void> {
    const key = new Date().toISOString().slice(0, 10);
    if (this.dailyDateKeyUtc !== key) {
      this.dailyDateKeyUtc = key;
      this.dailyStartingValueQuote = await this.portfolioValueQuote();
      this.dailyRealizedPnL = 0;
      console.log(
        `[AGENT] UTC day ${key}: daily NAV baseline=${this.dailyStartingValueQuote.toFixed(2)}`,
      );
    } else if (this.dailyStartingValueQuote <= 0) {
      this.dailyStartingValueQuote = await this.portfolioValueQuote();
    }
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
    options?: { skipLog?: boolean; logExtras?: Partial<TradeRecord> },
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
        ...options?.logExtras,
      };
      if (!options?.skipLog) logTrade(rec);
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
        Object.assign(rec, options?.logExtras);
        if (!options?.skipLog) logTrade(rec);
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
        ...options?.logExtras,
      };
      if (!options?.skipLog) logTrade(rec);
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
        ...options?.logExtras,
      };
      if (!options?.skipLog) logTrade(failed);
      return failed;
    }
  }

  private armCooldown(outcome: TradeOutcome): void {
    const ms = this.riskManager.getCooldownMs(outcome);
    this.cooldownUntil = Date.now() + ms;
    console.log(
      `[AGENT] Cooldown ${(ms / 60000).toFixed(1)}m until ${new Date(this.cooldownUntil).toISOString()}`,
    );
  }

  /** @returns true if at least one position was closed (skip strategy this tick). */
  private async processRiskExitSignals(
    signals: ExitSignal[],
    currentPrice: number,
  ): Promise<boolean> {
    let anyClosed = false;
    for (const sig of signals) {
      const pos = this.positionManager
        .getOpenPositions()
        .find((p) => p.id === sig.positionId);
      if (!pos) continue;
      const rec = await this.executeSwapLeg(
        SOL,
        USDC,
        sig.amount,
        currentPrice,
        `risk_exit_${sig.reason}`,
        { skipLog: true },
      );
      if (rec.status !== 'paper_filled' && rec.status !== 'success') continue;
      const closed = this.positionManager.closePosition(
        sig.positionId,
        currentPrice,
        sig.reason,
      );
      anyClosed = true;
      this.dailyRealizedPnL += closed.realizedPnlQuote;
      this.lastTradeResult =
        closed.realizedPnlQuote >= 0 ? 'win' : 'loss';
      logTrade({
        timestamp: rec.timestamp,
        inputMint: rec.inputMint,
        outputMint: rec.outputMint,
        inputAmount: rec.inputAmount,
        outputAmount: rec.outputAmount,
        expectedOutput: rec.expectedOutput,
        txSignature: rec.txSignature,
        status: rec.status,
        priceImpact: rec.priceImpact,
        mode: rec.mode,
        strategy: rec.strategy,
        slippageBps: rec.slippageBps,
        priceAtTrade: currentPrice,
        entryPrice: pos.entryPrice,
        exitPrice: currentPrice,
        exitReason: sig.reason,
        realizedPnl: closed.realizedPnlQuote,
      });
      this.armCooldown(this.lastTradeResult);
    }
    return anyClosed;
  }

  /**
   * Public API: manual trade (OpenClaw / POST /trade). Respects daily circuit breaker,
   * max positions, and cooldown (except closing a tracked position via sell).
   */
  async executeTrade(params: {
    direction: 'buy' | 'sell';
    amount: number;
    inputMint?: string;
    outputMint?: string;
  }): Promise<TradeRecord> {
    const strategy = 'manual';
    await this.ensureDailyNav();
    const priceSolUsdc = await this.resolvePriceSolUsdc();
    const inputMint =
      params.inputMint ??
      (params.direction === 'buy' ? USDC : SOL);
    const outputMint =
      params.outputMint ??
      (params.direction === 'buy' ? SOL : USDC);

    const trackedSell =
      params.direction === 'sell'
        ? (this.positionManager
            .getOpenPositions()
            .find((p) => p.mint === inputMint) ?? null)
        : null;
    const now = Date.now();
    if (now < this.cooldownUntil) {
      if (params.direction === 'buy' || !trackedSell) {
        const sec = Math.ceil((this.cooldownUntil - now) / 1000);
        return {
          timestamp: new Date().toISOString(),
          inputMint,
          outputMint,
          inputAmount: '0',
          outputAmount: '0',
          txSignature: 'n/a',
          status: 'failed',
          mode: this.mode,
          strategy,
          errorMessage: `Cooldown active (${sec}s remaining)`,
          priceAtTrade: priceSolUsdc,
        };
      }
    }

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

    if (params.direction === 'buy') {
      const openCount = this.positionManager.getOpenPositions().length;
      const gate = this.riskManager.canOpenPosition(
        openCount,
        this.dailyRealizedPnL,
        this.dailyStartingValueQuote,
      );
      if (!gate.allowed) {
        const msg =
          gate.reason?.includes('max_open')
            ? `Cannot open position: max open positions (${this.riskManager.maxOpenPositions}) reached. Close existing position first.`
            : (gate.reason ?? 'Entry blocked by risk rules');
        return {
          timestamp: new Date().toISOString(),
          inputMint,
          outputMint,
          inputAmount: '0',
          outputAmount: '0',
          txSignature: 'n/a',
          status: 'failed',
          mode: this.mode,
          strategy,
          errorMessage: msg,
          priceAtTrade: priceSolUsdc,
        };
      }
    }

    let inputRaw = humanToRawAmount(inputMint, params.amount);
    if (params.direction === 'sell' && trackedSell) {
      inputRaw =
        trackedSell.amount < inputRaw ? trackedSell.amount : inputRaw;
    }
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

    if (params.direction === 'sell' && trackedSell) {
      const rec = await this.executeSwapLeg(
        inputMint,
        outputMint,
        inputRaw,
        priceSolUsdc,
        strategy,
        { skipLog: true },
      );
      if (rec.status !== 'paper_filled' && rec.status !== 'success') {
        logTrade(rec);
        return rec;
      }
      const closed = this.positionManager.closePosition(
        trackedSell.id,
        priceSolUsdc,
        'manual',
      );
      this.dailyRealizedPnL += closed.realizedPnlQuote;
      this.lastTradeResult =
        closed.realizedPnlQuote >= 0 ? 'win' : 'loss';
      const merged: TradeRecord = {
        timestamp: rec.timestamp,
        inputMint: rec.inputMint,
        outputMint: rec.outputMint,
        inputAmount: rec.inputAmount,
        outputAmount: rec.outputAmount,
        expectedOutput: rec.expectedOutput,
        txSignature: rec.txSignature,
        status: rec.status,
        priceImpact: rec.priceImpact,
        mode: rec.mode,
        strategy,
        slippageBps: rec.slippageBps,
        priceAtTrade: priceSolUsdc,
        entryPrice: trackedSell.entryPrice,
        exitPrice: priceSolUsdc,
        exitReason: 'manual',
        realizedPnl: closed.realizedPnlQuote,
      };
      logTrade(merged);
      this.armCooldown(this.lastTradeResult);
      return merged;
    }

    if (params.direction === 'buy') {
      const rec = await this.executeSwapLeg(
        inputMint,
        outputMint,
        inputRaw,
        priceSolUsdc,
        strategy,
        { skipLog: true },
      );
      if (rec.status !== 'paper_filled' && rec.status !== 'success') {
        logTrade(rec);
        return rec;
      }
      const outAmt = BigInt(rec.outputAmount);
      this.positionManager.openPosition(
        outputMint,
        outAmt,
        priceSolUsdc,
        this.mode,
        strategy,
        this.riskManager.stopLossPercent,
        this.riskManager.takeProfitPercent,
        this.riskManager.trailingStopPercent,
      );
      const logged: TradeRecord = {
        ...rec,
        entryPrice: priceSolUsdc,
      };
      logTrade(logged);
      this.armCooldown(null);
      return logged;
    }

    const rec = await this.executeSwapLeg(
      inputMint,
      outputMint,
      inputRaw,
      priceSolUsdc,
      strategy,
    );
    if (params.direction === 'sell' && !trackedSell) {
      console.warn('[AGENT] Manual sell with no tracked position');
    }
    if (rec.status === 'paper_filled' || rec.status === 'success') {
      this.armCooldown(null);
    }
    return rec;
  }

  /**
   * Close a tracked position by id (full SOL→USDC exit for v1).
   */
  async closePositionById(
    positionId: string,
    reason = 'manual_api',
  ): Promise<TradeRecord> {
    await this.ensureDailyNav();
    const pos = this.positionManager
      .getOpenPositions()
      .find((p) => p.id === positionId);
    if (!pos) {
      throw new Error(`Position not found: ${positionId}`);
    }
    if (pos.mint !== SOL) {
      throw new Error(
        `closePositionById only supports SOL positions in v1 (got ${pos.mint})`,
      );
    }
    const priceSolUsdc = await this.resolvePriceSolUsdc();
    const rec = await this.executeSwapLeg(
      SOL,
      USDC,
      pos.amount,
      priceSolUsdc,
      `close_${reason}`,
      { skipLog: true },
    );
    if (rec.status !== 'paper_filled' && rec.status !== 'success') {
      logTrade(rec);
      return rec;
    }
    const closed = this.positionManager.closePosition(
      positionId,
      priceSolUsdc,
      reason,
    );
    this.dailyRealizedPnL += closed.realizedPnlQuote;
    this.lastTradeResult =
      closed.realizedPnlQuote >= 0 ? 'win' : 'loss';
    const merged: TradeRecord = {
      timestamp: rec.timestamp,
      inputMint: rec.inputMint,
      outputMint: rec.outputMint,
      inputAmount: rec.inputAmount,
      outputAmount: rec.outputAmount,
      expectedOutput: rec.expectedOutput,
      txSignature: rec.txSignature,
      status: rec.status,
      priceImpact: rec.priceImpact,
      mode: rec.mode,
      strategy: `close_${reason}`,
      slippageBps: rec.slippageBps,
      priceAtTrade: priceSolUsdc,
      entryPrice: pos.entryPrice,
      exitPrice: priceSolUsdc,
      exitReason: reason,
      realizedPnl: closed.realizedPnlQuote,
    };
    logTrade(merged);
    this.armCooldown(this.lastTradeResult);
    return merged;
  }

  private async evaluate(): Promise<void> {
    if (!this.running) return;
    const n = this.priceMonitor.getSampleCount();
    if (n < 10) {
      console.log(`[AGENT] Warming up, ${n}/10 prices collected`);
      return;
    }
    const price = this.priceMonitor.getLatestPrice();
    const sma = this.priceMonitor.getMovingAverage(20);
    const vol = this.priceMonitor.getVolatility(20);
    if (price === null || sma === null) return;

    await this.ensureDailyNav();
    this.positionManager.updateHighWaterMarks(price);
    const exits = this.positionManager.checkExits(price);
    if (exits.length > 0) {
      const riskHandled = await this.processRiskExitSignals(exits, price);
      if (riskHandled) return;
    }

    const now = Date.now();
    if (now < this.cooldownUntil) {
      const sec = Math.ceil((this.cooldownUntil - now) / 1000);
      console.log(`[AGENT] Cooling down (entries), ${sec}s remaining`);
      return;
    }

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
        const openCount = this.positionManager.getOpenPositions().length;
        const gate = this.riskManager.canOpenPosition(
          openCount,
          this.dailyRealizedPnL,
          this.dailyStartingValueQuote,
        );
        if (!gate.allowed) {
          console.log(`[AGENT] Entry blocked: ${gate.reason ?? 'risk'}`);
          return;
        }
        const entryPrice = priceSolUsdc;
        const stopLossPrice = entryPrice * (1 - this.riskManager.stopLossPercent);
        const nav = await this.portfolioValueQuote();
        const { usdcMicroSpend } = this.riskManager.calculatePositionSize(
          nav,
          entryPrice,
          stopLossPrice,
        );
        const maxUsdcRaw =
          this.mode === 'paper'
            ? this.paperEngine.getBalance(USDC).raw
            : this.liveVirtualUsdc;
        let usdcSpend = Number(
          usdcMicroSpend > 0n ? usdcMicroSpend : BigInt(0),
        );
        const fallback = Math.floor(
          (this.tradeAmountLamports / 1e9) * priceSolUsdc * 1e6,
        );
        if (usdcSpend < 10_000) {
          usdcSpend = Math.min(Number(maxUsdcRaw), fallback);
        }
        usdcSpend = Math.min(usdcSpend, Number(maxUsdcRaw));
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
        if (rec.status === 'paper_filled' || rec.status === 'success') {
          const solOut = BigInt(rec.outputAmount);
          this.positionManager.openPosition(
            SOL,
            solOut,
            entryPrice,
            this.mode,
            strategy,
            this.riskManager.stopLossPercent,
            this.riskManager.takeProfitPercent,
            this.riskManager.trailingStopPercent,
          );
          this.armCooldown(null);
        }
      } else {
        const solPos = this.positionManager
          .getOpenPositions()
          .find((p) => p.mint === SOL);
        const solBal =
          this.mode === 'paper'
            ? this.paperEngine.getBalance(SOL).raw
            : this.liveVirtualSol;
        const amountSol = solPos
          ? solPos.amount
          : BigInt(
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
          solPos ? { skipLog: true } : undefined,
        );
        if (rec.status === 'paper_filled' || rec.status === 'success') {
          if (solPos) {
            const closed = this.positionManager.closePosition(
              solPos.id,
              priceSolUsdc,
              'mean_reversion_sell',
            );
            this.dailyRealizedPnL += closed.realizedPnlQuote;
            this.lastTradeResult =
              closed.realizedPnlQuote >= 0 ? 'win' : 'loss';
            logTrade({
              timestamp: rec.timestamp,
              inputMint: rec.inputMint,
              outputMint: rec.outputMint,
              inputAmount: rec.inputAmount,
              outputAmount: rec.outputAmount,
              expectedOutput: rec.expectedOutput,
              txSignature: rec.txSignature,
              status: rec.status,
              priceImpact: rec.priceImpact,
              mode: rec.mode,
              strategy: rec.strategy,
              slippageBps: rec.slippageBps,
              priceAtTrade: priceSolUsdc,
              entryPrice: solPos.entryPrice,
              exitPrice: priceSolUsdc,
              exitReason: 'mean_reversion_sell',
              realizedPnl: closed.realizedPnlQuote,
            });
            this.armCooldown(this.lastTradeResult);
          } else {
            this.armCooldown(null);
          }
        }
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
    thresholdPct: number;
    latestPrice: number | null;
    priceChange: number | null;
    sma: number | null;
    volatility: number | null;
    cooldownRemaining: number;
    paperPortfolio: {
      balances: Record<string, { human: number; raw: string }>;
      pnl: {
        currentValue: number;
        initialValue: number;
        pnl: number;
        pnlPercent: number;
      };
    };
    recentTrades: ReturnType<typeof getRecentTrades>;
    tradeSummary: ReturnType<typeof getTradeSummary>;
    uptimeMs: number;
    risk: ReturnType<RiskManager['snapshot']>;
    dailyRealizedPnL: number;
    dailyStartingValueQuote: number;
    openPositionsCount: number;
  }> {
    const pnl = await this.paperEngine.getPnL(this.cfg.quoteMint);
    const all = this.paperEngine.getAllBalances();
    const balancesJson: Record<string, { human: number; raw: string }> = {};
    for (const [mint, b] of Object.entries(all)) {
      balancesJson[mint] = { human: b.human, raw: b.raw.toString() };
    }
    return {
      mode: this.mode,
      running: this.running,
      thresholdPct: this.thresholdPct,
      latestPrice: this.priceMonitor.getLatestPrice(),
      priceChange: this.priceMonitor.getPriceChange(),
      sma: this.priceMonitor.getMovingAverage(20),
      volatility: this.priceMonitor.getVolatility(20),
      cooldownRemaining: Math.max(
        0,
        Math.ceil((this.cooldownUntil - Date.now()) / 1000),
      ),
      paperPortfolio: { balances: balancesJson, pnl },
      recentTrades: getRecentTrades(5, this.mode),
      tradeSummary: getTradeSummary(this.mode),
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      risk: this.riskManager.snapshot(),
      dailyRealizedPnL: this.dailyRealizedPnL,
      dailyStartingValueQuote: this.dailyStartingValueQuote,
      openPositionsCount: this.positionManager.getOpenPositions().length,
    };
  }

  getPositionsApi(currentPrice: number | null): {
    positions: Array<
      Record<string, unknown> & { unrealizedPnlQuote: number }
    >;
    unrealizedPnLTotal: number;
  } {
    const px = currentPrice ?? this.priceMonitor.getLatestPrice() ?? 0;
    const positions = this.positionManager.getOpenPositions().map((p) => {
      const solHuman = Number(p.amount) / 1e9;
      const unrealized =
        p.mint === SOL ? (px - p.entryPrice) * solHuman : 0;
      return {
        id: p.id,
        mint: p.mint,
        entryTime: p.entryTime,
        entryPrice: p.entryPrice,
        amount: p.amount.toString(),
        stopLossPrice: p.stopLossPrice,
        takeProfitPrice: p.takeProfitPrice,
        trailingStopPercent: p.trailingStopPercent,
        highWaterMark: p.highWaterMark,
        strategy: p.strategy,
        mode: p.mode,
        unrealizedPnlQuote: unrealized,
      };
    });
    const unrealizedPnLTotal =
      px > 0 ? this.positionManager.getUnrealizedPnL(px) : 0;
    return { positions, unrealizedPnLTotal };
  }

  getClosedPositionsApi(limit: number): unknown[] {
    return this.positionManager.getClosedPositions(limit).map((c) => ({
      id: c.id,
      mint: c.mint,
      entryPrice: c.entryPrice,
      exitPrice: c.exitPrice,
      entryTime: c.entryTime,
      exitTime: c.exitTime,
      amount: c.amount.toString(),
      realizedPnlQuote: c.realizedPnlQuote,
      exitReason: c.exitReason,
      strategy: c.strategy,
      mode: c.mode,
    }));
  }

  getRiskApiStatus(): Record<string, unknown> {
    return {
      ...this.riskManager.snapshot(),
      dailyRealizedPnL: this.dailyRealizedPnL,
      dailyStartingValueQuote: this.dailyStartingValueQuote,
      lastTradeResult: this.lastTradeResult,
      openPositions: this.positionManager.getOpenPositions().length,
      utcDay: this.dailyDateKeyUtc,
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
    const v = String(value);
    const ok = this.applyRuntimeConfigValue(key, v);
    if (ok) {
      saveRuntimeConfigFile(
        snapshotToPersistable(this.getRuntimeConfigView()),
      );
      console.log(`[CONFIG] Runtime override applied: ${key}=${v} (persisted)`);
    }
  }

  getRuntimeConfigView(): Record<string, string | number | null> {
    return {
      mode: this.mode,
      tradeAmountLamports: this.tradeAmountLamports,
      thresholdPct: this.thresholdPct,
      pollIntervalMs: this.cfg.pollIntervalMs,
      paperInitialSol: this.cfg.paperInitialSol,
      paperInitialUsdc: this.cfg.paperInitialUsdc,
      ...this.riskManager.snapshot(),
      cooldownMinutes: this.riskManager.cooldownNormalMs / 60_000,
      cooldownLossMinutes: this.riskManager.cooldownAfterLossMs / 60_000,
    };
  }

  getPaperEngine(): PaperTradingEngine {
    return this.paperEngine;
  }

  getConfig(): AppConfig {
    return this.cfg;
  }
}

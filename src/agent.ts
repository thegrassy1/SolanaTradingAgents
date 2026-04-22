import fs from 'fs';
import path from 'path';
import { config, type AppConfig } from './config';
import {
  db,
  getRecentTrades,
  getStrategyStats,
  getTradeSummary,
  logPrice,
  logTrade,
} from './db';
import { PaperTradingEngine } from './paper';
import { PositionManager } from './positions';
import { calculatePrice, getQuote, PriceMonitor } from './price';
import { RiskManager, type TradeOutcome } from './risk';
import { registry } from './strategies/registry';
import { swap } from './swap';
import type { TradeRecord } from './types';
import { getTokenDecimals } from './tokenInfo';
import {
  loadDailyState,
  loadRuntimeConfigFile,
  loadStrategyConfigsFromFile,
  saveDailyState,
  saveRuntimeConfigFile,
  snapshotToPersistable,
} from './runtimeConfigPersist';
import type { ExitSignal } from './positions';
import { loadWallet } from './wallet';

const SOL = config.baseMint;
const USDC = config.quoteMint;
const PORTFOLIO_DIR = path.join(process.cwd(), 'data', 'portfolios');

function humanToRawAmount(mint: string, human: number): bigint {
  return BigInt(Math.round(human * 10 ** getTokenDecimals(mint)));
}

function rawToHumanAmount(mint: string, raw: string | bigint): number {
  const b = typeof raw === 'bigint' ? raw : BigInt(raw);
  return Number(b) / 10 ** getTokenDecimals(mint);
}

const ALL_STRATEGY_NAMES = ['mean_reversion_v1', 'breakout_v1', 'buy_and_hold_v1'];

export class TradingAgent {
  private readonly cfg: AppConfig;
  readonly priceMonitor: PriceMonitor;
  readonly positionManager: PositionManager;
  readonly riskManager: RiskManager;
  private running = false;
  mode: 'paper' | 'live';
  /** Per-strategy paper portfolios. Key = strategy name. */
  private portfolios: Map<string, PaperTradingEngine> = new Map();
  /** Per-strategy cooldown epoch-ms (entries blocked until this time). */
  private strategyCooldowns: Map<string, number> = new Map();
  /** Per-strategy last trade outcome (for logging / circuit breaker). */
  private strategyLastTradeResult: Map<string, TradeOutcome> = new Map();
  private liveVirtualSol: bigint;
  private liveVirtualUsdc: bigint;
  private startedAt: Date | null = null;
  private tradeAmountLamports: number;

  get thresholdPct(): number {
    return registry.getConfig('mean_reversion_v1').threshold ?? 2;
  }

  private dailyDateKeyUtc: string;
  private dailyStartingValueQuote = 0;
  private dailyRealizedPnL = 0;
  private dailyRealizedPnLNet = 0;
  /** @deprecated use strategyLastTradeResult */
  private lastTradeResult: TradeOutcome = null;
  private positionHoldLastLogMs = new Map<string, number>();
  private static readonly POSITION_HOLD_LOG_MS = 120_000;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.mode = cfg.mode;
    this.tradeAmountLamports = cfg.tradeAmountLamports;
    this.liveVirtualSol = BigInt(Math.round(cfg.paperInitialSol * 1e9));
    this.liveVirtualUsdc = BigInt(Math.round(cfg.paperInitialUsdc * 1e6));
    this.dailyDateKeyUtc = new Date().toISOString().slice(0, 10);
    this.initPortfolios();
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

  // ----- Portfolio manager -----

  private initPortfolios(): void {
    fs.mkdirSync(PORTFOLIO_DIR, { recursive: true });

    // Migration: copy legacy paper-portfolio.json → portfolios/mean_reversion_v1.json
    const legacyPath = path.join(process.cwd(), 'data', 'paper-portfolio.json');
    const mrv1Path = path.join(PORTFOLIO_DIR, 'mean_reversion_v1.json');
    if (fs.existsSync(legacyPath) && !fs.existsSync(mrv1Path)) {
      fs.copyFileSync(legacyPath, mrv1Path);
      fs.renameSync(legacyPath, `${legacyPath}.migrated`);
      console.log('[PAPER] Migrated paper-portfolio.json → portfolios/mean_reversion_v1.json');
    }

    const initialBalances = {
      [SOL]: this.cfg.paperInitialSol,
      [USDC]: this.cfg.paperInitialUsdc,
    };

    for (const stratName of ALL_STRATEGY_NAMES) {
      const storagePath = path.join(PORTFOLIO_DIR, `${stratName}.json`);
      const engine = new PaperTradingEngine(initialBalances, this.cfg.quoteMint, storagePath);
      this.portfolios.set(stratName, engine);
    }
  }

  /** Returns the portfolio for a strategy, falling back to mean_reversion_v1. */
  private getPortfolioForStrategy(stratName: string): PaperTradingEngine {
    return this.portfolios.get(stratName) ?? this.portfolios.get('mean_reversion_v1')!;
  }

  /** The primary (mean_reversion_v1) portfolio — kept for backwards compat with api.ts/report.ts. */
  get paperEngine(): PaperTradingEngine {
    return this.portfolios.get('mean_reversion_v1')!;
  }

  // ----- Config loading -----

  private loadPersistedRuntimeKeys(): void {
    const strategyConfigs = loadStrategyConfigsFromFile();
    if (strategyConfigs) {
      registry.loadConfigs(strategyConfigs);
      console.log('[CONFIG] Loaded strategy configs from disk');
    }
    const data = loadRuntimeConfigFile();
    if (!data) return;
    let n = 0;
    for (const [k, v] of Object.entries(data)) {
      if (this.applyRuntimeConfigValue(k, v)) n += 1;
    }
    if (n > 0) console.log(`[CONFIG] Loaded ${n} runtime overrides from disk`);
  }

  private restoreDailyState(): void {
    const today = new Date().toISOString().slice(0, 10);
    const saved = loadDailyState();
    if (saved && saved.date === today && saved.startingValueQuote > 0) {
      this.dailyStartingValueQuote = saved.startingValueQuote;
      console.log(`[AGENT] Restored daily start value: $${saved.startingValueQuote.toFixed(2)}`);
    }
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(realized_pnl), 0) AS total
         FROM trades
         WHERE mode = ? AND date(timestamp) = ? AND realized_pnl IS NOT NULL`,
      )
      .get(this.mode, today) as { total: number };
    const restoredPnl = row?.total ?? 0;
    if (restoredPnl !== 0) {
      this.dailyRealizedPnL = restoredPnl;
      console.log(`[AGENT] Restored daily realized P&L from DB: $${restoredPnl.toFixed(2)}`);
    }
  }

  private applyRuntimeConfigValue(key: string, value: string): boolean {
    const k = key.toLowerCase().replace(/-/g, '_');
    if (this.riskManager.setFromKey(key, value)) return true;
    if (k === 'trade_amount' || k === 'trade_amount_lamports') {
      this.tradeAmountLamports = Number(value);
      return true;
    }
    if (k === 'threshold') {
      registry.setConfigKey('mean_reversion_v1', 'threshold', Number(value));
      return true;
    }
    return false;
  }

  // ----- Lifecycle -----

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
    this.restoreDailyState();
    for (const [name, engine] of this.portfolios) {
      void engine.ensureInitialQuoteCaptured().catch((e) =>
        console.warn(`[PAPER] ensureInitialQuoteCaptured failed for ${name}:`, e),
      );
    }
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
    for (const [name, engine] of this.portfolios) {
      engine.flushToDisk();
      if (this.mode === 'paper') {
        void engine.getPnL(this.cfg.quoteMint).then((p) => {
          console.log(
            `[AGENT][${name}] Paper P&L: ${p.pnl.toFixed(2)} (${p.pnlPercent.toFixed(2)}%)`,
          );
        });
      }
    }
    console.log('[AGENT] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getStartedAt(): Date | null {
    return this.startedAt;
  }

  // ----- Price helpers -----

  private async resolvePriceSolUsdc(): Promise<number> {
    const p = this.priceMonitor.getLatestPrice();
    if (p !== null && p > 0) return p;
    const q = await getQuote(this.cfg.baseMint, this.cfg.quoteMint, this.tradeAmountLamports);
    const din = getTokenDecimals(this.cfg.baseMint);
    const dout = getTokenDecimals(this.cfg.quoteMint);
    return calculatePrice(q, din, dout);
  }

  /** Aggregate portfolio value across all strategy portfolios. */
  private async portfolioValueQuote(): Promise<number> {
    let total = 0;
    for (const engine of this.portfolios.values()) {
      const { totalValue } = await engine.getPortfolioValue(this.cfg.quoteMint);
      total += totalValue;
    }
    return total;
  }

  private async ensureDailyNav(): Promise<void> {
    const key = new Date().toISOString().slice(0, 10);
    if (this.dailyDateKeyUtc !== key) {
      this.dailyDateKeyUtc = key;
      this.dailyStartingValueQuote = await this.portfolioValueQuote();
      this.dailyRealizedPnL = 0;
      this.dailyRealizedPnLNet = 0;
      saveDailyState({ date: key, startingValueQuote: this.dailyStartingValueQuote });
      console.log(
        `[AGENT] UTC day ${key}: daily NAV baseline=${this.dailyStartingValueQuote.toFixed(2)}`,
      );
    } else if (this.dailyStartingValueQuote <= 0) {
      this.dailyStartingValueQuote = await this.portfolioValueQuote();
      saveDailyState({ date: key, startingValueQuote: this.dailyStartingValueQuote });
    }
  }

  private capInputRaw(
    inputMint: string,
    raw: bigint,
    portfolio?: PaperTradingEngine,
  ): bigint {
    if (this.mode === 'paper') {
      const p = portfolio ?? this.paperEngine;
      const paperBal = p.getBalance(inputMint).raw;
      return raw > paperBal ? paperBal : raw;
    }
    if (inputMint === SOL) return raw > this.liveVirtualSol ? this.liveVirtualSol : raw;
    if (inputMint === USDC) return raw > this.liveVirtualUsdc ? this.liveVirtualUsdc : raw;
    return raw;
  }

  private isSolUsdcPair(a: string, b: string): boolean {
    const s = new Set([a, b]);
    return s.has(SOL) && s.has(USDC);
  }

  // ----- Core swap leg -----

  private async executeSwapLeg(
    inputMint: string,
    outputMint: string,
    inputRaw: bigint,
    priceSolUsdc: number,
    strategy: string,
    options?: {
      skipLog?: boolean;
      logExtras?: Partial<TradeRecord>;
      portfolio?: PaperTradingEngine;
    },
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
        const portfolio = options?.portfolio ?? this.paperEngine;
        const rec = await portfolio.executePaperTrade(
          inputMint,
          outputMint,
          inputRaw,
          strategy,
          priceSolUsdc,
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
          priceSolUsdc,
        );
        if (inputMint === SOL) this.liveVirtualSol -= BigInt(rec.inputAmount);
        if (inputMint === USDC) this.liveVirtualUsdc -= BigInt(rec.inputAmount);
        if (outputMint === SOL) this.liveVirtualSol += BigInt(rec.outputAmount);
        if (outputMint === USDC) this.liveVirtualUsdc += BigInt(rec.outputAmount);
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

  // ----- Cooldown -----

  private armStrategyCooldown(stratName: string, outcome: TradeOutcome): void {
    const ms = this.riskManager.getCooldownMs(outcome);
    const until = Date.now() + ms;
    this.strategyCooldowns.set(stratName, until);
    this.strategyLastTradeResult.set(stratName, outcome);
    this.lastTradeResult = outcome;
    console.log(
      `[AGENT][${stratName}] Cooldown ${(ms / 60000).toFixed(1)}m until ${new Date(until).toISOString()}`,
    );
  }

  // ----- Risk exits -----

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
      const portfolio = this.getPortfolioForStrategy(pos.strategy);
      const rec = await this.executeSwapLeg(
        SOL,
        USDC,
        sig.amount,
        currentPrice,
        `risk_exit_${sig.reason}`,
        { skipLog: true, portfolio },
      );
      if (rec.status !== 'paper_filled' && rec.status !== 'success') continue;
      const exitQuoteAmount = rawToHumanAmount(USDC, rec.outputAmount);
      const exitFeesQuote = rec.solFeeQuote ?? 0;
      const closed = this.positionManager.closePosition(
        sig.positionId,
        currentPrice,
        sig.reason,
        { exitQuoteAmount, exitFeesQuote },
      );
      anyClosed = true;
      this.dailyRealizedPnL += closed.realizedPnlGross ?? closed.realizedPnlQuote;
      this.dailyRealizedPnLNet += closed.realizedPnlNet ?? closed.realizedPnlQuote;
      const netForOutcome = closed.realizedPnlNet ?? closed.realizedPnlQuote;
      this.armStrategyCooldown(pos.strategy, netForOutcome >= 0 ? 'win' : 'loss');
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
        strategy: pos.strategy,
        slippageBps: rec.slippageBps,
        priceAtTrade: currentPrice,
        entryPrice: pos.entryPrice,
        exitPrice: currentPrice,
        exitReason: sig.reason,
        realizedPnl: closed.realizedPnlQuote,
        realizedPnlGross: closed.realizedPnlGross ?? closed.realizedPnlQuote,
        realizedPnlNet: closed.realizedPnlNet ?? undefined,
        feesQuote: closed.feesQuote ?? rec.feesQuote,
        takerFeeBps: rec.takerFeeBps,
        takerFeeQuote: rec.takerFeeQuote,
        networkFeeLamports: rec.networkFeeLamports,
        priorityFeeLamports: rec.priorityFeeLamports,
        solFeeQuote: rec.solFeeQuote,
      });
    }
    return anyClosed;
  }

  // ----- Strategy entries -----

  /** Generic buy entry for any signal-based strategy. */
  private async executeStrategyBuy(stratName: string, priceSolUsdc: number): Promise<void> {
    const portfolio = this.getPortfolioForStrategy(stratName);
    try {
      const openCount = this.positionManager.getOpenPositions().length;
      const gate = this.riskManager.canOpenPosition(
        openCount,
        this.dailyRealizedPnL,
        this.dailyStartingValueQuote,
      );
      if (!gate.allowed) {
        console.log(`[AGENT][${stratName}] Entry blocked: ${gate.reason ?? 'risk'}`);
        return;
      }
      const entryPrice = priceSolUsdc;
      const stopLossPrice = entryPrice * (1 - this.riskManager.stopLossPercent);
      const { totalValue: nav } = await portfolio.getPortfolioValue(this.cfg.quoteMint);
      const { usdcMicroSpend } = this.riskManager.calculatePositionSize(
        nav,
        entryPrice,
        stopLossPrice,
      );
      const maxUsdcRaw =
        this.mode === 'paper' ? portfolio.getBalance(USDC).raw : this.liveVirtualUsdc;
      let usdcSpend = Number(usdcMicroSpend > 0n ? usdcMicroSpend : 0n);
      const fallback = Math.floor((this.tradeAmountLamports / 1e9) * priceSolUsdc * 1e6);
      if (usdcSpend < 10_000) usdcSpend = Math.min(Number(maxUsdcRaw), fallback);
      usdcSpend = Math.min(usdcSpend, Number(maxUsdcRaw));
      if (usdcSpend < 10_000) {
        console.log(`[AGENT][${stratName}] Buy skipped: USDC spend too small`);
        return;
      }
      const amountUsdc = BigInt(usdcSpend);
      const rec = await this.executeSwapLeg(
        USDC,
        SOL,
        amountUsdc,
        priceSolUsdc,
        stratName,
        { portfolio },
      );
      if (rec.status === 'paper_filled' || rec.status === 'success') {
        const solOut = BigInt(rec.outputAmount);
        const entryQuoteAmount = rawToHumanAmount(USDC, rec.inputAmount);
        const entryFeesQuote = rec.solFeeQuote ?? 0;
        this.positionManager.openPosition(
          SOL,
          solOut,
          entryPrice,
          this.mode,
          stratName,
          this.riskManager.stopLossPercent,
          this.riskManager.takeProfitPercent,
          this.riskManager.trailingStopPercent,
          { entryQuoteAmount, entryFeesQuote },
        );
        this.armStrategyCooldown(stratName, null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[AGENT][${stratName}] executeStrategyBuy failed:`, msg);
      logTrade({
        timestamp: new Date().toISOString(),
        inputMint: USDC,
        outputMint: SOL,
        inputAmount: '0',
        outputAmount: '0',
        txSignature: 'n/a',
        status: 'failed',
        mode: this.mode,
        strategy: stratName,
        errorMessage: msg,
        priceAtTrade: priceSolUsdc,
      });
    }
  }

  /** Buy & Hold: convert all USDC to SOL on first tick after warmup; never sell. */
  private async handleBuyAndHold(priceSolUsdc: number): Promise<void> {
    const stratName = 'buy_and_hold_v1';
    const portfolio = this.getPortfolioForStrategy(stratName);

    // Already has an open position — nothing to do
    const openPos = this.positionManager
      .getOpenPositions()
      .find((p) => p.strategy === stratName);
    if (openPos) return;

    // Check if USDC available to allocate
    const usdcBal = portfolio.getBalance(USDC).raw;
    if (usdcBal < 10_000n) return;

    const stratConfig = registry.getConfig(stratName);
    const allocationPct = stratConfig.initialAllocationPercent ?? 1.0;
    const amountToSpend = BigInt(Math.floor(Number(usdcBal) * allocationPct));
    if (amountToSpend < 10_000n) return;

    console.log(
      `[AGENT][${stratName}] Initial allocation: ${(Number(amountToSpend) / 1e6).toFixed(2)} USDC → SOL`,
    );
    const rec = await this.executeSwapLeg(
      USDC,
      SOL,
      amountToSpend,
      priceSolUsdc,
      stratName,
      { portfolio },
    );
    if (rec.status === 'paper_filled' || rec.status === 'success') {
      const solOut = BigInt(rec.outputAmount);
      const entryQuoteAmount = rawToHumanAmount(USDC, rec.inputAmount);
      const entryFeesQuote = rec.solFeeQuote ?? 0;
      // Open position with no SL or TP — it holds forever
      this.positionManager.openPosition(
        SOL,
        solOut,
        priceSolUsdc,
        this.mode,
        stratName,
        undefined, // no stop loss
        undefined, // no take profit
        null,
        { entryQuoteAmount, entryFeesQuote },
      );
      console.log(
        `[AGENT][${stratName}] Allocated ${(Number(solOut) / 1e9).toFixed(4)} SOL @ $${priceSolUsdc.toFixed(2)}`,
      );
    }
  }

  // ----- Main evaluate loop -----

  private logPositionHoldIfDue(currentPrice: number, stratName?: string): void {
    const open = this.positionManager
      .getOpenPositions()
      .filter((p) => !stratName || p.strategy === stratName);
    const openIds = new Set(open.map((p) => p.id));
    for (const id of this.positionHoldLastLogMs.keys()) {
      if (!openIds.has(id)) this.positionHoldLastLogMs.delete(id);
    }
    const now = Date.now();
    for (const p of open) {
      if (p.mint !== SOL) continue;
      const last = this.positionHoldLastLogMs.get(p.id) ?? 0;
      if (now - last < TradingAgent.POSITION_HOLD_LOG_MS) continue;
      this.positionHoldLastLogMs.set(p.id, now);
      const solHuman = Number(p.amount) / 1e9;
      const unrealized = (currentPrice - p.entryPrice) * solHuman;
      console.log(
        `[POSITION-HOLD] ${p.id} currentPrice=${currentPrice} entry=${p.entryPrice} unrealizedPnl=${unrealized.toFixed(4)} slPrice=${p.stopLossPrice ?? 'null'} tpPrice=${p.takeProfitPrice ?? 'null'}`,
      );
    }
  }

  private async evaluate(): Promise<void> {
    if (!this.running) return;
    await this.ensureDailyNav();

    const n = this.priceMonitor.getSampleCount();
    if (n < 10) {
      console.log(`[AGENT] Warming up, ${n}/10 prices collected`);
      return;
    }

    const price = this.priceMonitor.getLatestPrice();
    const sma = this.priceMonitor.getMovingAverage(20);
    const vol = this.priceMonitor.getVolatility(20);
    if (price === null || sma === null) return;

    this.positionManager.updateHighWaterMarks(price);

    // Process risk exits for ALL open positions (across all strategies),
    // excluding buy_and_hold positions which have no SL/TP.
    const allExits = this.positionManager
      .checkExits(price)
      .filter((sig) => {
        const pos = this.positionManager
          .getOpenPositions()
          .find((p) => p.id === sig.positionId);
        return pos?.strategy !== 'buy_and_hold_v1';
      });
    if (allExits.length > 0) {
      await this.processRiskExitSignals(allExits, price);
    }

    // Per-strategy evaluation
    const maxLookback = Math.max(...ALL_STRATEGY_NAMES.map((n) => {
      const cfg = registry.getConfig(n);
      return (cfg.lookbackBars ?? 20) + 1;
    }));
    const priceHistory = this.priceMonitor.getPriceHistory(maxLookback);
    const enabledStrategies = this.cfg.strategies;
    const deviationPct = sma !== 0 ? ((price - sma) / sma) * 100 : 0;
    const volPct = (vol ?? 0) * 100;

    for (const stratName of enabledStrategies) {
      const strategy = registry.getStrategyByName(stratName);
      if (!strategy) continue;

      // Buy & Hold is driven by portfolio state, not a signal
      if (stratName === 'buy_and_hold_v1') {
        await this.handleBuyAndHold(price);
        continue;
      }

      const openPos =
        this.positionManager.getOpenPositions().find((p) => p.strategy === stratName) ?? null;

      if (openPos) {
        this.logPositionHoldIfDue(price, stratName);
        continue;
      }

      const now = Date.now();
      const cooldownUntil = this.strategyCooldowns.get(stratName) ?? 0;
      if (now < cooldownUntil) {
        const sec = Math.ceil((cooldownUntil - now) / 1000);
        console.log(`[AGENT][${stratName}] Cooling down (entries), ${sec}s remaining`);
        continue;
      }

      const signal = strategy.evaluate({
        currentPrice: price,
        sma,
        volatility: vol,
        openPosition: null,
        config: registry.getConfig(stratName),
        priceHistory,
      });

      console.log(
        `[AGENT][${stratName}] price=${price.toFixed(4)} sma=${sma.toFixed(4)} dev=${deviationPct.toFixed(2)}% vol=${volPct.toFixed(2)}% signal=${signal.action}`,
      );

      if (signal.action === 'buy') {
        await this.executeStrategyBuy(stratName, price);
      }
    }
  }

  // ----- Public trade API (manual / OpenClaw) -----

  async executeTrade(params: {
    direction: 'buy' | 'sell';
    amount: number;
    inputMint?: string;
    outputMint?: string;
  }): Promise<TradeRecord> {
    // Manual trades debit mean_reversion_v1 portfolio; logged as 'manual' strategy
    const strategy = 'manual';
    const portfolio = this.getPortfolioForStrategy('mean_reversion_v1');
    await this.ensureDailyNav();
    const priceSolUsdc = await this.resolvePriceSolUsdc();
    const inputMint = params.inputMint ?? (params.direction === 'buy' ? USDC : SOL);
    const outputMint = params.outputMint ?? (params.direction === 'buy' ? SOL : USDC);

    const trackedSell =
      params.direction === 'sell'
        ? (this.positionManager.getOpenPositions().find((p) => p.mint === inputMint) ?? null)
        : null;

    const now = Date.now();
    const cooldownUntil = this.strategyCooldowns.get('mean_reversion_v1') ?? 0;
    if (now < cooldownUntil) {
      if (params.direction === 'buy' || !trackedSell) {
        const sec = Math.ceil((cooldownUntil - now) / 1000);
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
        const msg = gate.reason?.includes('max_open')
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
      inputRaw = trackedSell.amount < inputRaw ? trackedSell.amount : inputRaw;
    }
    inputRaw = this.capInputRaw(inputMint, inputRaw, portfolio);
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
      const rec = await this.executeSwapLeg(inputMint, outputMint, inputRaw, priceSolUsdc, strategy, {
        skipLog: true,
        portfolio,
      });
      if (rec.status !== 'paper_filled' && rec.status !== 'success') {
        logTrade(rec);
        return rec;
      }
      const exitQuoteAmount =
        outputMint === USDC ? rawToHumanAmount(USDC, rec.outputAmount) : null;
      const exitFeesQuote = rec.solFeeQuote ?? 0;
      const closed = this.positionManager.closePosition(
        trackedSell.id,
        priceSolUsdc,
        'manual',
        { exitQuoteAmount, exitFeesQuote },
      );
      this.dailyRealizedPnL += closed.realizedPnlGross ?? closed.realizedPnlQuote;
      this.dailyRealizedPnLNet += closed.realizedPnlNet ?? closed.realizedPnlQuote;
      const netForOutcome = closed.realizedPnlNet ?? closed.realizedPnlQuote;
      this.armStrategyCooldown('mean_reversion_v1', netForOutcome >= 0 ? 'win' : 'loss');
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
        realizedPnlGross: closed.realizedPnlGross ?? closed.realizedPnlQuote,
        realizedPnlNet: closed.realizedPnlNet ?? undefined,
        feesQuote: closed.feesQuote ?? rec.feesQuote,
        takerFeeBps: rec.takerFeeBps,
        takerFeeQuote: rec.takerFeeQuote,
        networkFeeLamports: rec.networkFeeLamports,
        priorityFeeLamports: rec.priorityFeeLamports,
        solFeeQuote: rec.solFeeQuote,
      };
      logTrade(merged);
      return merged;
    }

    if (params.direction === 'buy') {
      const rec = await this.executeSwapLeg(inputMint, outputMint, inputRaw, priceSolUsdc, strategy, {
        skipLog: true,
        portfolio,
      });
      if (rec.status !== 'paper_filled' && rec.status !== 'success') {
        logTrade(rec);
        return rec;
      }
      const outAmt = BigInt(rec.outputAmount);
      const entryQuoteAmount =
        inputMint === USDC ? rawToHumanAmount(USDC, rec.inputAmount) : null;
      const entryFeesQuote = rec.solFeeQuote ?? 0;
      this.positionManager.openPosition(
        outputMint,
        outAmt,
        priceSolUsdc,
        this.mode,
        strategy,
        this.riskManager.stopLossPercent,
        this.riskManager.takeProfitPercent,
        this.riskManager.trailingStopPercent,
        { entryQuoteAmount, entryFeesQuote },
      );
      const logged: TradeRecord = { ...rec, entryPrice: priceSolUsdc };
      logTrade(logged);
      this.armStrategyCooldown('mean_reversion_v1', null);
      return logged;
    }

    const rec = await this.executeSwapLeg(inputMint, outputMint, inputRaw, priceSolUsdc, strategy, {
      portfolio,
    });
    if (rec.status === 'paper_filled' || rec.status === 'success') {
      this.armStrategyCooldown('mean_reversion_v1', null);
    }
    return rec;
  }

  async closePositionById(positionId: string, reason = 'manual_api'): Promise<TradeRecord> {
    await this.ensureDailyNav();
    const pos = this.positionManager.getOpenPositions().find((p) => p.id === positionId);
    if (!pos) throw new Error(`Position not found: ${positionId}`);
    if (pos.mint !== SOL) {
      throw new Error(
        `closePositionById only supports SOL positions in v1 (got ${pos.mint})`,
      );
    }
    const portfolio = this.getPortfolioForStrategy(pos.strategy);
    const priceSolUsdc = await this.resolvePriceSolUsdc();
    const rec = await this.executeSwapLeg(SOL, USDC, pos.amount, priceSolUsdc, `close_${reason}`, {
      skipLog: true,
      portfolio,
    });
    if (rec.status !== 'paper_filled' && rec.status !== 'success') {
      logTrade(rec);
      return rec;
    }
    const exitQuoteAmount = rawToHumanAmount(USDC, rec.outputAmount);
    const exitFeesQuote = rec.solFeeQuote ?? 0;
    const closed = this.positionManager.closePosition(positionId, priceSolUsdc, reason, {
      exitQuoteAmount,
      exitFeesQuote,
    });
    this.dailyRealizedPnL += closed.realizedPnlGross ?? closed.realizedPnlQuote;
    this.dailyRealizedPnLNet += closed.realizedPnlNet ?? closed.realizedPnlQuote;
    const netForOutcome = closed.realizedPnlNet ?? closed.realizedPnlQuote;
    this.armStrategyCooldown(pos.strategy, netForOutcome >= 0 ? 'win' : 'loss');
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
      realizedPnlGross: closed.realizedPnlGross ?? closed.realizedPnlQuote,
      realizedPnlNet: closed.realizedPnlNet ?? undefined,
      feesQuote: closed.feesQuote ?? rec.feesQuote,
      takerFeeBps: rec.takerFeeBps,
      takerFeeQuote: rec.takerFeeQuote,
      networkFeeLamports: rec.networkFeeLamports,
      priorityFeeLamports: rec.priorityFeeLamports,
      solFeeQuote: rec.solFeeQuote,
    };
    logTrade(merged);
    return merged;
  }

  // ----- Status / API getters -----

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
    dailyRealizedPnLNet: number;
    dailyStartingValueQuote: number;
    openPositionsCount: number;
  }> {
    // Aggregate P&L across all portfolios
    let aggCurrentValue = 0;
    let aggInitialValue = 0;
    const aggBalancesRaw: Record<string, bigint> = {};
    for (const engine of this.portfolios.values()) {
      const pnl = await engine.getPnL(this.cfg.quoteMint);
      aggCurrentValue += pnl.currentValue;
      aggInitialValue += pnl.initialValue;
      for (const [mint, bal] of Object.entries(engine.getAllBalances())) {
        aggBalancesRaw[mint] = (aggBalancesRaw[mint] ?? 0n) + bal.raw;
      }
    }
    const aggPnl = aggCurrentValue - aggInitialValue;
    const aggPnlPct = aggInitialValue === 0 ? 0 : (aggPnl / aggInitialValue) * 100;
    const balancesJson: Record<string, { human: number; raw: string }> = {};
    for (const [mint, raw] of Object.entries(aggBalancesRaw)) {
      balancesJson[mint] = {
        human: Number(raw) / 10 ** getTokenDecimals(mint),
        raw: raw.toString(),
      };
    }

    // Global cooldown remaining = min across all enabled strategies
    const enabledCooldowns = this.cfg.strategies
      .filter((s) => s !== 'buy_and_hold_v1')
      .map((s) => Math.max(0, Math.ceil(((this.strategyCooldowns.get(s) ?? 0) - Date.now()) / 1000)));
    const cooldownRemaining = enabledCooldowns.length > 0 ? Math.max(...enabledCooldowns) : 0;

    return {
      mode: this.mode,
      running: this.running,
      thresholdPct: this.thresholdPct,
      latestPrice: this.priceMonitor.getLatestPrice(),
      priceChange: this.priceMonitor.getPriceChange(),
      sma: this.priceMonitor.getMovingAverage(20),
      volatility: this.priceMonitor.getVolatility(20),
      cooldownRemaining,
      paperPortfolio: {
        balances: balancesJson,
        pnl: {
          currentValue: aggCurrentValue,
          initialValue: aggInitialValue,
          pnl: aggPnl,
          pnlPercent: aggPnlPct,
        },
      },
      recentTrades: getRecentTrades(5, this.mode),
      tradeSummary: getTradeSummary(this.mode),
      uptimeMs: this.startedAt ? Date.now() - this.startedAt.getTime() : 0,
      risk: this.riskManager.snapshot(),
      dailyRealizedPnL: this.dailyRealizedPnL,
      dailyRealizedPnLNet: this.dailyRealizedPnLNet,
      dailyStartingValueQuote: this.dailyStartingValueQuote,
      openPositionsCount: this.positionManager.getOpenPositions().length,
    };
  }

  /** Per-strategy portfolio summaries for the /portfolios API endpoint. */
  async getPortfoliosApi(): Promise<
    Array<{
      strategy: string;
      displayName: string;
      storagePath: string;
      currentValue: number;
      initialValue: number;
      pnl: number;
      pnlPercent: number;
      balances: Record<string, { human: number; raw: string }>;
    }>
  > {
    const out = [];
    for (const [stratName, engine] of this.portfolios) {
      const strat = registry.getStrategyByName(stratName);
      const pnl = await engine.getPnL(this.cfg.quoteMint);
      const balancesRaw = engine.getAllBalances();
      const balancesJson: Record<string, { human: number; raw: string }> = {};
      for (const [mint, bal] of Object.entries(balancesRaw)) {
        balancesJson[mint] = { human: bal.human, raw: bal.raw.toString() };
      }
      out.push({
        strategy: stratName,
        displayName: strat?.displayName ?? stratName,
        storagePath: `portfolios/${stratName}.json`,
        ...pnl,
        balances: balancesJson,
      });
    }
    return out;
  }

  getPositionsApi(currentPrice: number | null): {
    positions: Array<Record<string, unknown> & { unrealizedPnlQuote: number }>;
    unrealizedPnLTotal: number;
    unrealizedPnLTotalNet: number;
  } {
    const px = currentPrice ?? this.priceMonitor.getLatestPrice() ?? 0;
    const feeLamports =
      (this.cfg.paperNetworkFeeLamports + this.cfg.paperPriorityFeeLamports) | 0;
    const solFeeQuoteEst = px > 0 ? (feeLamports / 1e9) * px : 0;
    const takerBps = Math.max(0, this.cfg.paperTakerFeeBps | 0);
    let totalNet = 0;
    const positions = this.positionManager.getOpenPositions().map((p) => {
      const solHuman = Number(p.amount) / 1e9;
      const unrealizedGross = p.mint === SOL ? (px - p.entryPrice) * solHuman : 0;
      let unrealizedNet = unrealizedGross;
      if (p.mint === SOL && p.entryQuoteAmount != null && px > 0) {
        const grossExitUsdc = solHuman * px;
        const takerHaircut = grossExitUsdc * (takerBps / 10_000);
        const estExitUsdc = grossExitUsdc - takerHaircut;
        const entryFees = p.entryFeesQuote ?? 0;
        unrealizedNet = estExitUsdc - p.entryQuoteAmount - entryFees - solFeeQuoteEst;
      }
      totalNet += unrealizedNet;
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
        entryQuoteAmount: p.entryQuoteAmount ?? null,
        entryFeesQuote: p.entryFeesQuote ?? null,
        unrealizedPnlQuote: unrealizedGross,
        unrealizedPnlGross: unrealizedGross,
        unrealizedPnlNet: unrealizedNet,
      };
    });
    const unrealizedPnLTotal = px > 0 ? this.positionManager.getUnrealizedPnL(px) : 0;
    return { positions, unrealizedPnLTotal, unrealizedPnLTotalNet: totalNet };
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
      realizedPnlGross: c.realizedPnlGross ?? c.realizedPnlQuote,
      realizedPnlNet: c.realizedPnlNet ?? null,
      feesQuote: c.feesQuote ?? null,
      entryQuoteAmount: c.entryQuoteAmount ?? null,
      exitQuoteAmount: c.exitQuoteAmount ?? null,
      entryFeesQuote: c.entryFeesQuote ?? null,
      exitFeesQuote: c.exitFeesQuote ?? null,
      exitReason: c.exitReason,
      strategy: c.strategy,
      mode: c.mode,
    }));
  }

  getRiskApiStatus(): Record<string, unknown> {
    return {
      ...this.riskManager.snapshot(),
      dailyRealizedPnL: this.dailyRealizedPnL,
      dailyRealizedPnLNet: this.dailyRealizedPnLNet,
      dailyStartingValueQuote: this.dailyStartingValueQuote,
      lastTradeResult: this.lastTradeResult,
      openPositions: this.positionManager.getOpenPositions().length,
      utcDay: this.dailyDateKeyUtc,
      paperFees: {
        takerFeeBps: this.cfg.paperTakerFeeBps,
        networkFeeLamports: this.cfg.paperNetworkFeeLamports,
        priorityFeeLamports: this.cfg.paperPriorityFeeLamports,
      },
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
        registry.getAllConfigs(),
      );
      console.log(`[CONFIG] Runtime override applied: ${key}=${v} (persisted)`);
    }
  }

  setStrategyConfig(strategyName: string, key: string, rawValue: string): boolean {
    const num = Number(rawValue);
    if (Number.isNaN(num)) return false;
    const s = registry.getStrategyByName(strategyName);
    if (!s) return false;
    registry.setConfigKey(strategyName, key, num);
    saveRuntimeConfigFile(
      snapshotToPersistable(this.getRuntimeConfigView()),
      registry.getAllConfigs(),
    );
    console.log(`[CONFIG] Strategy ${strategyName}.${key}=${num} (persisted)`);
    return true;
  }

  getStrategyConfig(strategyName: string): Record<string, number> | null {
    const s = registry.getStrategyByName(strategyName);
    if (!s) return null;
    return registry.getConfig(strategyName);
  }

  async getStrategyStatus(strategyName: string): Promise<{
    name: string;
    displayName: string;
    description: string;
    enabled: boolean;
    tradeCount: number;
    closedCount: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnL: number;
    avgWin: number | null;
    avgLoss: number | null;
    expectancy: number | null;
    openPositions: number;
    cooldownRemaining: number;
    avgHoldTimeMinutes: number | null;
    lastTradeTimestamp: string | null;
    config: Record<string, number>;
    portfolio?: {
      currentValue: number;
      initialValue: number;
      pnl: number;
      pnlPercent: number;
      balances: Record<string, { human: number; raw: string }>;
    };
  } | null> {
    const s = registry.getStrategyByName(strategyName);
    if (!s) return null;

    const stats = getStrategyStats(strategyName, this.mode);
    const openCount = this.positionManager
      .getOpenPositions()
      .filter((p) => p.strategy === strategyName).length;

    const allClosed = this.positionManager.getClosedPositions(10_000);
    const stratClosed = allClosed.filter((c) => c.strategy === strategyName);
    let avgHoldTimeMinutes: number | null = null;
    if (stratClosed.length > 0) {
      const totalMs = stratClosed.reduce((sum, c) => {
        const entry = new Date(c.entryTime).getTime();
        const exit = new Date(c.exitTime).getTime();
        return sum + (exit - entry);
      }, 0);
      avgHoldTimeMinutes = totalMs / stratClosed.length / 60_000;
    }

    // Per-strategy portfolio snapshot
    let portfolio: {
      currentValue: number;
      initialValue: number;
      pnl: number;
      pnlPercent: number;
      balances: Record<string, { human: number; raw: string }>;
    } | undefined;
    const engine = this.portfolios.get(strategyName);
    if (engine) {
      const pnl = await engine.getPnL(this.cfg.quoteMint);
      const balancesRaw = engine.getAllBalances();
      const balancesJson: Record<string, { human: number; raw: string }> = {};
      for (const [mint, bal] of Object.entries(balancesRaw)) {
        balancesJson[mint] = { human: bal.human, raw: bal.raw.toString() };
      }
      portfolio = { ...pnl, balances: balancesJson };
    }

    const cooldownUntil = this.strategyCooldowns.get(strategyName) ?? 0;
    const cooldownRemaining = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));

    return {
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      enabled: this.cfg.strategies.includes(strategyName),
      ...stats,
      openPositions: openCount,
      cooldownRemaining,
      avgHoldTimeMinutes,
      config: registry.getConfig(strategyName),
      portfolio,
    };
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

  getStrategiesList(): Array<{
    name: string;
    displayName: string;
    description: string;
    enabled: boolean;
    config: Record<string, number>;
  }> {
    return registry.getStrategies().map((s) => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      enabled: this.cfg.strategies.includes(s.name),
      config: registry.getConfig(s.name),
    }));
  }

  getPaperEngine(): PaperTradingEngine {
    return this.paperEngine;
  }

  getConfig(): AppConfig {
    return this.cfg;
  }
}

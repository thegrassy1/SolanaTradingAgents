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

function humanToRawAmount(mint: string, human: number): bigint {
  return BigInt(Math.round(human * 10 ** getTokenDecimals(mint)));
}

function rawToHumanAmount(mint: string, raw: string | bigint): number {
  const b = typeof raw === 'bigint' ? raw : BigInt(raw);
  return Number(b) / 10 ** getTokenDecimals(mint);
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
  private tradeAmountLamports: number;

  /** Reads threshold from the active strategy config (mean_reversion_v1). */
  get thresholdPct(): number {
    return registry.getConfig('mean_reversion_v1').threshold ?? 2;
  }
  private dailyDateKeyUtc: string;
  private dailyStartingValueQuote = 0;
  /** Sum of gross realized P&L (mark-to-market) for the UTC day. */
  private dailyRealizedPnL = 0;
  /** Sum of net realized P&L (flows minus all fees) for the UTC day. */
  private dailyRealizedPnLNet = 0;
  private lastTradeResult: TradeOutcome = null;
  /** Last `[POSITION-HOLD]` log time per open position id (rate limit). */
  private positionHoldLastLogMs = new Map<string, number>();
  private static readonly POSITION_HOLD_LOG_MS = 120_000;

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
    // Load strategy-specific configs first (migration runs inside loadStrategyConfigsFromFile)
    const strategyConfigs = loadStrategyConfigsFromFile();
    if (strategyConfigs) {
      registry.loadConfigs(strategyConfigs);
      console.log('[CONFIG] Loaded strategy configs from disk');
    }

    // Load flat agent-level overrides (threshold no longer lives here after migration)
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

  /**
   * Restores daily tracking state after a restart so the circuit breaker
   * and "Today" report section stay accurate across pm2 restarts.
   *
   * - dailyStartingValueQuote: loaded from data/daily-state.json (written each
   *   time ensureDailyNav sets the baseline). Ignored if the saved date is not
   *   today's UTC date.
   * - dailyRealizedPnL: recomputed from the trades table (source of truth).
   */
  private restoreDailyState(): void {
    const today = new Date().toISOString().slice(0, 10);

    // Restore day-start NAV from disk
    const saved = loadDailyState();
    if (saved && saved.date === today && saved.startingValueQuote > 0) {
      this.dailyStartingValueQuote = saved.startingValueQuote;
      console.log(
        `[AGENT] Restored daily start value: $${saved.startingValueQuote.toFixed(2)}`,
      );
    }

    // Restore today's realized P&L from DB
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
      console.log(
        `[AGENT] Restored daily realized P&L from DB: $${restoredPnl.toFixed(2)}`,
      );
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
    // Backwards-compat: POST /config { key: "threshold" } applies to mean_reversion_v1
    if (k === 'threshold') {
      registry.setConfigKey('mean_reversion_v1', 'threshold', Number(value));
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
    this.restoreDailyState();
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
      this.dailyRealizedPnLNet +=
        closed.realizedPnlNet ?? closed.realizedPnlQuote;
      const netForOutcome = closed.realizedPnlNet ?? closed.realizedPnlQuote;
      this.lastTradeResult = netForOutcome >= 0 ? 'win' : 'loss';
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
        realizedPnlGross: closed.realizedPnlGross ?? closed.realizedPnlQuote,
        realizedPnlNet: closed.realizedPnlNet ?? undefined,
        feesQuote: closed.feesQuote ?? rec.feesQuote,
        takerFeeBps: rec.takerFeeBps,
        takerFeeQuote: rec.takerFeeQuote,
        networkFeeLamports: rec.networkFeeLamports,
        priorityFeeLamports: rec.priorityFeeLamports,
        solFeeQuote: rec.solFeeQuote,
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
      this.dailyRealizedPnLNet +=
        closed.realizedPnlNet ?? closed.realizedPnlQuote;
      const netForOutcome = closed.realizedPnlNet ?? closed.realizedPnlQuote;
      this.lastTradeResult = netForOutcome >= 0 ? 'win' : 'loss';
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
    const exitQuoteAmount = rawToHumanAmount(USDC, rec.outputAmount);
    const exitFeesQuote = rec.solFeeQuote ?? 0;
    const closed = this.positionManager.closePosition(
      positionId,
      priceSolUsdc,
      reason,
      { exitQuoteAmount, exitFeesQuote },
    );
    this.dailyRealizedPnL += closed.realizedPnlGross ?? closed.realizedPnlQuote;
    this.dailyRealizedPnLNet +=
      closed.realizedPnlNet ?? closed.realizedPnlQuote;
    const netForOutcome = closed.realizedPnlNet ?? closed.realizedPnlQuote;
    this.lastTradeResult = netForOutcome >= 0 ? 'win' : 'loss';
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
    this.armCooldown(this.lastTradeResult);
    return merged;
  }

  private logPositionHoldIfDue(currentPrice: number): void {
    const open = this.positionManager.getOpenPositions();
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
    // ensureDailyNav runs on every tick (before warmup guard) so the circuit
    // breaker baseline and daily-state.json are populated immediately on startup,
    // not delayed by the 10-sample warmup period.
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
    const exits = this.positionManager.checkExits(price);
    if (exits.length > 0) {
      const riskHandled = await this.processRiskExitSignals(exits, price);
      if (riskHandled) return;
    }

    if (this.positionManager.getOpenPositions().length > 0) {
      this.logPositionHoldIfDue(price);
      return;
    }

    const now = Date.now();
    if (now < this.cooldownUntil) {
      const sec = Math.ceil((this.cooldownUntil - now) / 1000);
      console.log(`[AGENT] Cooling down (entries), ${sec}s remaining`);
      return;
    }

    const deviationPct = sma !== 0 ? ((price - sma) / sma) * 100 : 0;
    const volPct = vol * 100;

    // Use the registered strategy to evaluate entry signal
    const strategy = registry.getStrategyByName('mean_reversion_v1');
    const openPos = this.positionManager.getOpenPositions()[0] ?? null;
    const signal = strategy?.evaluate({
      currentPrice: price,
      sma,
      volatility: vol,
      openPosition: openPos
        ? { id: openPos.id, entryPrice: openPos.entryPrice, amount: openPos.amount, strategy: openPos.strategy }
        : null,
      config: registry.getConfig('mean_reversion_v1'),
    }) ?? { action: 'hold' as const, reason: 'no_strategy' };

    console.log(
      `[AGENT] price=${price.toFixed(4)} sma=${sma.toFixed(4)} dev=${deviationPct.toFixed(2)}% vol=${volPct.toFixed(2)}% entrySignal=${signal.action}`,
    );
    if (signal.action === 'buy') {
      await this.executeMeanReversionBuy(price);
    }
  }

  /** Mean-reversion entry only; exits are SL/TP/trailing via checkExits. */
  private async executeMeanReversionBuy(priceSolUsdc: number): Promise<void> {
    const strategy = 'mean_reversion_v1';
    try {
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
        const entryQuoteAmount = rawToHumanAmount(USDC, rec.inputAmount);
        const entryFeesQuote = rec.solFeeQuote ?? 0;
        this.positionManager.openPosition(
          SOL,
          solOut,
          entryPrice,
          this.mode,
          strategy,
          this.riskManager.stopLossPercent,
          this.riskManager.takeProfitPercent,
          this.riskManager.trailingStopPercent,
          { entryQuoteAmount, entryFeesQuote },
        );
        this.armCooldown(null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[AGENT] executeMeanReversionBuy failed:', msg);
      const failed: TradeRecord = {
        timestamp: new Date().toISOString(),
        inputMint: USDC,
        outputMint: SOL,
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
    /** Daily realized P&L net of paper fees (taker + SOL network). */
    dailyRealizedPnLNet: number;
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
      dailyRealizedPnLNet: this.dailyRealizedPnLNet,
      dailyStartingValueQuote: this.dailyStartingValueQuote,
      openPositionsCount: this.positionManager.getOpenPositions().length,
    };
  }

  getPositionsApi(currentPrice: number | null): {
    positions: Array<
      Record<string, unknown> & { unrealizedPnlQuote: number }
    >;
    unrealizedPnLTotal: number;
    unrealizedPnLTotalNet: number;
  } {
    const px = currentPrice ?? this.priceMonitor.getLatestPrice() ?? 0;
    // Estimate exit-side fees at current price so we can project net on close.
    const feeLamports =
      (this.cfg.paperNetworkFeeLamports + this.cfg.paperPriorityFeeLamports) | 0;
    const solFeeQuoteEst = px > 0 ? (feeLamports / 1e9) * px : 0;
    const takerBps = Math.max(0, this.cfg.paperTakerFeeBps | 0);
    let totalNet = 0;
    const positions = this.positionManager.getOpenPositions().map((p) => {
      const solHuman = Number(p.amount) / 1e9;
      const unrealizedGross =
        p.mint === SOL ? (px - p.entryPrice) * solHuman : 0;
      let unrealizedNet = unrealizedGross;
      if (p.mint === SOL && p.entryQuoteAmount != null && px > 0) {
        // Simulate exiting: sell all SOL at current price, pay taker bps + exit SOL fee.
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
    const unrealizedPnLTotal =
      px > 0 ? this.positionManager.getUnrealizedPnL(px) : 0;
    return {
      positions,
      unrealizedPnLTotal,
      unrealizedPnLTotalNet: totalNet,
    };
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

  /** Update a strategy-specific config key, persist to disk. */
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
    openPositions: number;
    avgHoldTimeMinutes: number | null;
    lastTradeTimestamp: string | null;
    config: Record<string, number>;
  } | null> {
    const s = registry.getStrategyByName(strategyName);
    if (!s) return null;

    const stats = getStrategyStats(strategyName, this.mode);
    const openCount = this.positionManager
      .getOpenPositions()
      .filter((p) => p.strategy === strategyName).length;

    // Compute avg hold time from closed-positions.json filtered by strategy
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

    return {
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      enabled: this.cfg.strategies.includes(strategyName),
      ...stats,
      openPositions: openCount,
      avgHoldTimeMinutes,
      config: registry.getConfig(strategyName),
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

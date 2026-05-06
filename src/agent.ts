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
  logAiAction,
} from './db';
import { PaperTradingEngine } from './paper';
import { PositionManager } from './positions';
import { calculatePrice, getQuote, PriceMonitor } from './price';
import { MultiSymbolMonitor } from './multiPrice';
import { getActiveUniverse, getSymbolByMint } from './symbols';
import { PerpEngine } from './perp';
import type { PerpDirection } from './perp';
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
import { classifyRegime, isRegimeAllowed, type MarketRegime, type RegimeResult } from './regime';
import type { ReviewerAction } from './ai/reviewer';

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

const ALL_STRATEGY_NAMES = [
  'mean_reversion_v1',
  'breakout_v1',
  'buy_and_hold_v1',
  'ai_strategy_v1',
  'mean_reversion_short_v1',
  'momentum_v1',
];

export class TradingAgent {
  private readonly cfg: AppConfig;
  readonly priceMonitor: PriceMonitor;
  /** Multi-symbol price monitor — runs one PriceMonitor per universe symbol. */
  readonly multiMonitor: MultiSymbolMonitor;
  readonly positionManager: PositionManager;
  /** Paper-perp engine — handles leveraged longs/shorts with funding + liquidation. */
  perpEngine!: PerpEngine;
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
  /** Per-strategy daily tracking (keyed by strategy name). */
  private strategyDailyDateKey: Map<string, string> = new Map();
  private strategyDailyStartValue: Map<string, number> = new Map();
  private strategyDailyPnL: Map<string, number> = new Map();
  private strategyDailyPnLNet: Map<string, number> = new Map();
  /** @deprecated use strategyLastTradeResult */
  private lastTradeResult: TradeOutcome = null;
  private positionHoldLastLogMs = new Map<string, number>();
  private static readonly POSITION_HOLD_LOG_MS = 120_000;

  // ── Regime classifier ─────────────────────────────────────────────────────
  private currentRegime: MarketRegime = 'ranging';
  private currentRegimeResult: RegimeResult | null = null;

  // ── Strategy × Symbol whitelist ──────────────────────────────────────────
  // Backtest-driven: only run a strategy on symbols where it has shown
  // positive Sharpe over our test window. Updated via /strategies/:name/symbols
  // API or by editing data/strategy-whitelist.json. Empty array = strategy
  // disabled. Missing entry = run on ALL active universe symbols (legacy default).
  //
  // Initial values from 6-month 1h backtest (2025-11-01 → 2026-05-06):
  //   momentum_v1:        +13.9% on JTO (Sharpe 1.01) — only profitable combo
  //   breakout_v1:        +8.9% JTO, +2.0% BONK — others lose
  //   mean_reversion_v1:  loses on all symbols (was +4% on cherry-picked 35d)
  //   buy_and_hold_v1:    SOL only by design (benchmark)
  //   ai_strategy_v1:     filters candidates from above; restrict to same set
  //   mean_reversion_short_v1: untested, no live trades yet — empty whitelist
  private strategySymbolWhitelist: Record<string, string[] | undefined> = {
    momentum_v1:           ['JTO'],
    breakout_v1:           ['JTO', 'BONK'],
    mean_reversion_v1:     [],            // disabled — losing on all symbols
    mean_reversion_short_v1: [],          // untested — keep dark
    buy_and_hold_v1:       ['SOL'],       // benchmark, unchanged
    ai_strategy_v1:        ['JTO', 'BONK'],
  };

  // ── Idle auto-tuner ───────────────────────────────────────────────────────
  private lastAutoTuneKey = '';  // UTC date string, checked once per day
  private static readonly IDLE_THRESHOLD_DAYS = 2;
  // Removed mean_reversion_v1 from auto-tune because the 6-month backtest
  // shows it loses on every symbol regardless of threshold — relaxing it
  // further just makes losses bigger. Only tune strategies with proven edge.
  private static readonly IDLE_RELAX: Record<string, { key: string; factor: number }> = {
    breakout_v1:       { key: 'minVolatility', factor: 0.85 },
    momentum_v1:       { key: 'minSlopePct',   factor: 0.90 },
  };

  // ── Dynamic risk multiplier ───────────────────────────────────────────────
  private strategyRiskMultiplier: Map<string, number> = new Map();
  private lastRiskRebalanceKey = '';  // UTC date string, rebalanced daily

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.mode = cfg.mode;
    this.tradeAmountLamports = cfg.tradeAmountLamports;
    this.liveVirtualSol = BigInt(Math.round(cfg.paperInitialSol * 1e9));
    this.liveVirtualUsdc = BigInt(Math.round(cfg.paperInitialUsdc * 1e6));
    this.dailyDateKeyUtc = new Date().toISOString().slice(0, 10);
    for (const n of ALL_STRATEGY_NAMES) this.strategyRiskMultiplier.set(n, 1.0);
    // Restore daily-once keys from DB so restarts don't retrigger the same day
    this.lastAutoTuneKey = this.loadLastActionDate('auto_tune');
    this.lastRiskRebalanceKey = this.loadLastActionDate('risk_rebalance');
    this.initPortfolios();
    this.priceMonitor = new PriceMonitor(
      cfg.baseMint,
      cfg.quoteMint,
      cfg.tradeAmountLamports,
      cfg.pollIntervalMs,
    );
    // Pass the SOL legacy monitor so multiMonitor doesn't double-poll SOL
    this.multiMonitor = new MultiSymbolMonitor(cfg.pollIntervalMs, this.priceMonitor);
    this.positionManager = new PositionManager();
    // Perp engine shares the per-strategy portfolio map for collateral
    this.perpEngine = new PerpEngine(this.portfolios, cfg.quoteMint);
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
    // Per-strategy restore from DB
    for (const stratName of ALL_STRATEGY_NAMES) {
      this.strategyDailyDateKey.set(stratName, today);
      const stratRow = db
        .prepare(
          `SELECT COALESCE(SUM(realized_pnl), 0) AS total
           FROM trades
           WHERE mode = ? AND strategy = ? AND date(timestamp) = ? AND realized_pnl IS NOT NULL`,
        )
        .get(this.mode, stratName, today) as { total: number };
      const stratPnl = stratRow?.total ?? 0;
      if (stratPnl !== 0) {
        this.strategyDailyPnL.set(stratName, stratPnl);
        console.log(`[AGENT][${stratName}] Restored daily P&L from DB: $${stratPnl.toFixed(2)}`);
      }
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
    // Multi-symbol price collection — logs every universe symbol's tick to DB.
    // Strategy execution still uses this.priceMonitor (SOL only) until P2.
    this.multiMonitor.onPriceUpdate = (mint, price, sma20) => {
      // Skip SOL — it's already logged by priceMonitor above (same data, avoid dupes)
      if (mint === this.cfg.baseMint) return;
      const m = this.multiMonitor.get(mint);
      const vol = m ? m.getVolatility(20) : 0;
      logPrice(mint, this.cfg.quoteMint, price, sma20, vol);
    };
    this.priceMonitor.start();
    this.multiMonitor.start();
    console.log(`[AGENT] Agent started in ${this.mode.toUpperCase()} mode`);
  }

  stop(): void {
    if (!this.running) {
      console.log('[AGENT] Not running');
      return;
    }
    this.running = false;
    this.priceMonitor.stop();
    this.multiMonitor.stop();
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
      const { totalValue } = await engine.getPortfolioValue(this.cfg.quoteMint, this.getCurrentPriceMap());
      total += totalValue;
    }
    return total;
  }

  private async ensureDailyNav(): Promise<void> {
    const key = new Date().toISOString().slice(0, 10);
    // Global aggregate
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
    // Daily once-per-day checks (idle tuner + risk rebalance)
    this.checkIdleStrategies();
    this.updateRiskMultipliers();

    // Per-strategy: iterate all registered strategies (even quiet ones)
    for (const stratName of ALL_STRATEGY_NAMES) {
      const engine = this.portfolios.get(stratName);
      if (!engine) continue;
      const prevKey = this.strategyDailyDateKey.get(stratName);
      if (prevKey !== key) {
        // Day rolled over — reset and snapshot new baseline
        const { totalValue } = await engine.getPortfolioValue(this.cfg.quoteMint, this.getCurrentPriceMap());
        this.strategyDailyDateKey.set(stratName, key);
        this.strategyDailyStartValue.set(stratName, totalValue);
        this.strategyDailyPnL.set(stratName, 0);
        this.strategyDailyPnLNet.set(stratName, 0);
        console.log(`[AGENT][${stratName}] UTC day ${key}: daily NAV baseline=${totalValue.toFixed(2)}`);
      } else if ((this.strategyDailyStartValue.get(stratName) ?? 0) <= 0) {
        // First tick today — set baseline
        const { totalValue } = await engine.getPortfolioValue(this.cfg.quoteMint, this.getCurrentPriceMap());
        this.strategyDailyStartValue.set(stratName, totalValue);
      }
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
      // Exit leg: sell the position's actual mint back to USDC
      // (was hardcoded SOL — would catastrophically misroute multi-symbol exits)
      const rec = await this.executeSwapLeg(
        pos.mint,
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
      const grossPnl = closed.realizedPnlGross ?? closed.realizedPnlQuote;
      const netPnl = closed.realizedPnlNet ?? closed.realizedPnlQuote;
      this.dailyRealizedPnL += grossPnl;
      this.dailyRealizedPnLNet += netPnl;
      this.strategyDailyPnL.set(pos.strategy, (this.strategyDailyPnL.get(pos.strategy) ?? 0) + grossPnl);
      this.strategyDailyPnLNet.set(pos.strategy, (this.strategyDailyPnLNet.get(pos.strategy) ?? 0) + netPnl);
      const netForOutcome = closed.realizedPnlNet ?? closed.realizedPnlQuote;
      // Per (strategy, mint) cooldown so a loss in BONK doesn't delay JUP entries
      this.armStrategyCooldown(`${pos.strategy}:${pos.mint}`, netForOutcome >= 0 ? 'win' : 'loss');
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
  /**
   * Open a position in `targetMint` for `stratName` at `entryPrice` (USDC).
   *
   * Risk gates evaluated in order:
   *   1. Per-strategy max-open + daily-loss circuit breaker (RiskManager)
   *   2. Portfolio gross-exposure cap (P3): sum of open position USDC
   *      values across all strategies must stay under PORTFOLIO_GROSS_CAP_PCT
   *      of the strategy's NAV.
   *   3. Sector cap (P3): no two open positions in the same sector across
   *      all strategies (correlations matter — meme tokens move together).
   */
  private async executeStrategyBuy(
    stratName: string,
    targetMint: string,
    entryPrice: number,
  ): Promise<void> {
    const portfolio = this.getPortfolioForStrategy(stratName);
    const targetSym = getSymbolByMint(targetMint);
    const targetLabel = targetSym?.symbol ?? targetMint.slice(0, 4);

    try {
      // ---- Gate 1: existing per-strategy + daily-loss
      const openCount = this.positionManager.getOpenPositions().length;
      const gate = this.riskManager.canOpenPosition(
        openCount,
        this.strategyDailyPnL.get(stratName) ?? this.dailyRealizedPnL,
        this.strategyDailyStartValue.get(stratName) ?? this.dailyStartingValueQuote,
      );
      if (!gate.allowed) {
        console.log(`[AGENT][${stratName}][${targetLabel}] Entry blocked: ${gate.reason ?? 'risk'}`);
        return;
      }

      // ---- Gate 2 (P3): sector cap
      // Reject if there's already an open position in the same sector
      // (across ALL strategies). Meme tokens correlate, defi tokens correlate.
      if (targetSym) {
        const openPositions = this.positionManager.getOpenPositions();
        const conflictingSector = openPositions.find((p) => {
          const otherSym = getSymbolByMint(p.mint);
          return otherSym?.sector === targetSym.sector && p.mint !== targetMint;
        });
        if (conflictingSector) {
          const otherLabel = getSymbolByMint(conflictingSector.mint)?.symbol ?? '?';
          console.log(
            `[AGENT][${stratName}][${targetLabel}] Entry blocked: sector_cap (${targetSym.sector}) — already long ${otherLabel}`,
          );
          return;
        }
      }

      const stopLossPrice = entryPrice * (1 - this.riskManager.stopLossPercent);
      const { totalValue: nav } = await portfolio.getPortfolioValue(
        this.cfg.quoteMint, this.getCurrentPriceMap(),
      );
      const riskMultiplier = this.strategyRiskMultiplier.get(stratName) ?? 1.0;
      const { usdcMicroSpend } = this.riskManager.calculatePositionSize(
        nav,
        entryPrice,
        stopLossPrice,
        riskMultiplier,
      );

      // ---- Gate 3 (P3): gross-exposure cap (max 30% NAV deployed across all
      // open positions in this portfolio). USDC value = Σ(amount × entry).
      const PORTFOLIO_GROSS_CAP_PCT = 0.30;
      const stratOpen = this.positionManager.getOpenPositions().filter(
        (p) => p.strategy === stratName,
      );
      const grossDeployed = stratOpen.reduce((s, p) => s + (p.entryQuoteAmount ?? 0), 0);
      const remainingCapacity = Math.max(
        0,
        nav * PORTFOLIO_GROSS_CAP_PCT - grossDeployed,
      );
      const usdcMicroFromCap = BigInt(Math.floor(remainingCapacity * 1e6));

      const maxUsdcRaw = this.mode === 'paper'
        ? portfolio.getBalance(USDC).raw
        : this.liveVirtualUsdc;

      let usdcSpend = Number(usdcMicroSpend > 0n ? usdcMicroSpend : 0n);
      // Fallback when calculatePositionSize underflows (e.g. zero entry/sl gap)
      const fallback = Math.floor((this.tradeAmountLamports / 1e9) * entryPrice * 1e6);
      if (usdcSpend < 10_000) usdcSpend = Math.min(Number(maxUsdcRaw), fallback);

      // Clamp to: balance available, gross-exposure cap, otherwise no buy
      usdcSpend = Math.min(usdcSpend, Number(maxUsdcRaw), Number(usdcMicroFromCap));
      if (usdcSpend < 10_000) {
        const reason = remainingCapacity < 0.01
          ? 'gross_exposure_cap_reached'
          : 'usdc_spend_too_small';
        console.log(`[AGENT][${stratName}][${targetLabel}] Buy skipped: ${reason}`);
        return;
      }

      const amountUsdc = BigInt(usdcSpend);
      const rec = await this.executeSwapLeg(
        USDC,
        targetMint,
        amountUsdc,
        entryPrice,
        stratName,
        { portfolio },
      );
      if (rec.status === 'paper_filled' || rec.status === 'success') {
        const tokenOut = BigInt(rec.outputAmount);
        const entryQuoteAmount = rawToHumanAmount(USDC, rec.inputAmount);
        const entryFeesQuote = rec.solFeeQuote ?? 0;
        this.positionManager.openPosition(
          targetMint,
          tokenOut,
          entryPrice,
          this.mode,
          stratName,
          this.riskManager.stopLossPercent,
          this.riskManager.takeProfitPercent,
          this.riskManager.trailingStopPercent,
          { entryQuoteAmount, entryFeesQuote },
        );
        // Per (strategy, mint) cooldown
        this.armStrategyCooldown(`${stratName}:${targetMint}`, null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[AGENT][${stratName}][${targetLabel}] executeStrategyBuy failed:`, msg);
      logTrade({
        timestamp: new Date().toISOString(),
        inputMint: USDC,
        outputMint: targetMint,
        inputAmount: '0',
        outputAmount: '0',
        txSignature: 'n/a',
        status: 'failed',
        mode: this.mode,
        strategy: stratName,
        errorMessage: msg,
        priceAtTrade: entryPrice,
      });
    }
  }

  /**
   * Open a perp position via the perp engine. Sister of executeStrategyBuy
   * for spot. Sizes collateral based on the strategy's risk-per-trade,
   * adjusted by the dynamic risk multiplier and the leverage.
   */
  private async executePerpEntry(
    stratName: string,
    targetMint: string,
    entryPrice: number,
    direction: PerpDirection,
    leverage: number,
  ): Promise<void> {
    const portfolio = this.getPortfolioForStrategy(stratName);
    const targetSym = getSymbolByMint(targetMint);
    const targetLabel = targetSym?.symbol ?? targetMint.slice(0, 4);

    try {
      // Per-strategy + daily-loss gates (same as spot)
      const totalOpenCount =
        this.positionManager.getOpenPositions().length +
        this.perpEngine.getOpen().length;
      const gate = this.riskManager.canOpenPosition(
        totalOpenCount,
        this.strategyDailyPnL.get(stratName) ?? this.dailyRealizedPnL,
        this.strategyDailyStartValue.get(stratName) ?? this.dailyStartingValueQuote,
      );
      if (!gate.allowed) {
        console.log(`[AGENT][${stratName}][${targetLabel}] Perp entry blocked: ${gate.reason ?? 'risk'}`);
        return;
      }

      // Sector cap — count both spot and perp positions
      if (targetSym) {
        const allOpen = [
          ...this.positionManager.getOpenPositions().map((p) => ({ mint: p.mint })),
          ...this.perpEngine.getOpen().map((p) => ({ mint: p.mint })),
        ];
        const conflictingSector = allOpen.find((p) => {
          const otherSym = getSymbolByMint(p.mint);
          return otherSym?.sector === targetSym.sector && p.mint !== targetMint;
        });
        if (conflictingSector) {
          const otherLabel = getSymbolByMint(conflictingSector.mint)?.symbol ?? '?';
          console.log(
            `[AGENT][${stratName}][${targetLabel}] Perp blocked: sector_cap (${targetSym.sector}) — already open on ${otherLabel}`,
          );
          return;
        }
      }

      // Size collateral: use risk-per-trade % of NAV; SL distance defines risk
      const { totalValue: nav } = await portfolio.getPortfolioValue(
        this.cfg.quoteMint, this.getCurrentPriceMap(),
      );
      const slPct = this.riskManager.stopLossPercent;
      const tpPct = this.riskManager.takeProfitPercent;
      const riskMultiplier = this.strategyRiskMultiplier.get(stratName) ?? 1.0;
      const effectiveRisk = this.riskManager.riskPerTradePercent * Math.max(0.1, riskMultiplier);

      // For a leveraged perp:
      //   Adverse move at SL = slPct of entry
      //   Loss at SL = collateral × leverage × slPct
      //   Risk equation: collateral × leverage × slPct = nav × effectiveRisk
      //   ⇒ collateral = nav × effectiveRisk / (leverage × slPct)
      let collateralUsdc = (nav * effectiveRisk) / (leverage * slPct);

      // Clamp to: available USDC, gross cap (30% NAV deployed)
      const PERP_GROSS_CAP_PCT = 0.30;
      const stratPerps = this.perpEngine.getOpen().filter((p) => p.strategy === stratName);
      const grossDeployed = stratPerps.reduce((s, p) => s + p.collateralUsdc, 0);
      const remainingCap = Math.max(0, nav * PERP_GROSS_CAP_PCT - grossDeployed);
      collateralUsdc = Math.min(collateralUsdc, remainingCap);

      const usdcAvailHuman = Number(portfolio.getBalance(this.cfg.quoteMint).raw) / 1e6;
      collateralUsdc = Math.min(collateralUsdc, usdcAvailHuman);

      if (collateralUsdc < 5) {
        console.log(`[AGENT][${stratName}][${targetLabel}] Perp skipped: collateral too small ($${collateralUsdc.toFixed(2)})`);
        return;
      }

      const pos = this.perpEngine.openPerp({
        strategy: stratName,
        mint: targetMint,
        direction,
        entryPrice,
        collateralUsdc,
        leverage,
        stopLossPercent: slPct,
        takeProfitPercent: tpPct,
        trailingStopPercent: this.riskManager.trailingStopPercent,
        mode: this.mode,
      });
      if (pos) {
        this.armStrategyCooldown(`${stratName}:${targetMint}`, null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[AGENT][${stratName}][${targetLabel}] executePerpEntry failed:`, msg);
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

  // ── Strategy × Symbol whitelist ──────────────────────────────────────────

  /**
   * Returns true if `stratName` is allowed to trade `symbol`.
   * - If no entry in the whitelist: legacy "all allowed" behavior
   * - If entry exists but empty: strategy is fully disabled
   * - Otherwise: only listed symbols allowed
   */
  isWhitelisted(stratName: string, symbol: string): boolean {
    const list = this.strategySymbolWhitelist[stratName];
    if (list === undefined) return true;             // no entry → allow all
    return list.includes(symbol.toUpperCase());
  }

  /** Public read-only view for the API. */
  getStrategySymbolWhitelist(): Record<string, string[] | undefined> {
    const out: Record<string, string[] | undefined> = {};
    for (const [k, v] of Object.entries(this.strategySymbolWhitelist)) {
      out[k] = v ? [...v] : undefined;
    }
    return out;
  }

  /** Update the whitelist for one strategy. Pass null to remove the entry
   *  (legacy "all allowed"). Pass an empty array to disable entirely. */
  setStrategySymbolWhitelist(stratName: string, symbols: string[] | null): void {
    if (symbols === null) {
      delete this.strategySymbolWhitelist[stratName];
    } else {
      this.strategySymbolWhitelist[stratName] = symbols.map((s) => s.toUpperCase());
    }
    console.log(
      `[WHITELIST] ${stratName} → ${symbols === null ? 'all allowed' : symbols.length === 0 ? 'DISABLED' : symbols.join(',')}`,
    );
  }

  // ── Idle auto-tuner ───────────────────────────────────────────────────────

  /** Returns the UTC date (YYYY-MM-DD) of the most recent ai_action with a given source, or '' if none. */
  private loadLastActionDate(source: string): string {
    try {
      const row = db
        .prepare(`SELECT timestamp FROM ai_actions WHERE source = ? ORDER BY id DESC LIMIT 1`)
        .get(source) as { timestamp: string } | undefined;
      return row ? row.timestamp.slice(0, 10) : '';
    } catch {
      return '';
    }
  }

  /**
   * Checks each signal strategy once per day. If it hasn't traded in
   * IDLE_THRESHOLD_DAYS, relaxes its primary entry parameter by the configured
   * factor and persists the change.
   */
  private checkIdleStrategies(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastAutoTuneKey === today) return;
    this.lastAutoTuneKey = today;

    for (const [stratName, relax] of Object.entries(TradingAgent.IDLE_RELAX)) {
      const row = db
        .prepare(
          `SELECT MAX(timestamp) AS last_ts FROM trades WHERE strategy = ? AND mode = ?`,
        )
        .get(stratName, this.mode) as { last_ts: string | null };
      if (!row?.last_ts) continue;
      const daysSince = (Date.now() - new Date(row.last_ts).getTime()) / 86400000;
      if (daysSince < TradingAgent.IDLE_THRESHOLD_DAYS) continue;

      const current = registry.getConfig(stratName);
      const oldVal = current[relax.key] ?? 0;
      const newVal = oldVal * relax.factor;
      if (newVal <= 0) continue;

      registry.setConfigKey(stratName, relax.key, newVal);
      saveRuntimeConfigFile(
        snapshotToPersistable(this.getRuntimeConfigView()),
        registry.getAllConfigs(),
      );
      logAiAction({
        timestamp: new Date().toISOString(),
        source: 'auto_tune',
        strategy: stratName,
        key: relax.key,
        oldValue: oldVal,
        newValue: newVal,
        reason: `Idle ${daysSince.toFixed(1)}d — auto-relaxed by ${((1 - relax.factor) * 100).toFixed(0)}%`,
      });
      console.log(
        `[AUTO-TUNE][${stratName}] ${daysSince.toFixed(1)}d idle → ${relax.key}: ${oldVal.toFixed(6)} → ${newVal.toFixed(6)}`,
      );
    }
  }

  // ── Dynamic risk multiplier ───────────────────────────────────────────────

  /**
   * Runs once per day on rollover. Adjusts each strategy's risk multiplier
   * based on its 7-day win rate:
   *   > 60%  → multiply by 1.15 (cap 2.0)
   *   40-60% → no change
   *   < 40%  → multiply by 0.85 (floor 0.5)
   */
  private updateRiskMultipliers(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastRiskRebalanceKey === today) return;
    this.lastRiskRebalanceKey = today;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffIso = cutoff.toISOString();

    for (const stratName of ALL_STRATEGY_NAMES) {
      if (stratName === 'buy_and_hold_v1') continue;

      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses
           FROM trades
           WHERE strategy = ? AND mode = ? AND timestamp >= ?
             AND exit_reason IS NOT NULL AND exit_reason != ''`,
        )
        .get(stratName, this.mode, cutoffIso) as { wins: number; losses: number };

      const wins = row?.wins ?? 0;
      const losses = row?.losses ?? 0;
      const decided = wins + losses;
      if (decided < 3) continue; // need at least 3 closed trades to adjust

      const winRate = (wins / decided) * 100;
      const prev = this.strategyRiskMultiplier.get(stratName) ?? 1.0;
      let next = prev;

      if (winRate > 60) next = Math.min(prev * 1.15, 2.0);
      else if (winRate < 40) next = Math.max(prev * 0.85, 0.5);

      if (Math.abs(next - prev) > 0.001) {
        this.strategyRiskMultiplier.set(stratName, next);
        logAiAction({
          timestamp: new Date().toISOString(),
          source: 'risk_rebalance',
          strategy: stratName,
          key: 'riskMultiplier',
          oldValue: prev,
          newValue: next,
          reason: `7d win rate ${winRate.toFixed(1)}% (${wins}W/${losses}L)`,
        });
        console.log(
          `[RISK-REBALANCE][${stratName}] winRate=${winRate.toFixed(1)}% → multiplier ${prev.toFixed(2)} → ${next.toFixed(2)}`,
        );
      }
    }
  }

  // ── AI reviewer action application ───────────────────────────────────────

  /**
   * Called by the scheduler after the AI reviewer runs.
   * Applies validated config changes produced by the reviewer.
   */
  applyAiReviewerActions(actions: ReviewerAction[]): void {
    if (!actions.length) return;
    for (const action of actions) {
      if (action.type !== 'strategy_config') continue;
      const s = registry.getStrategyByName(action.strategy);
      if (!s) {
        console.warn(`[AI-REVIEWER] Unknown strategy in action: ${action.strategy}`);
        continue;
      }
      const current = registry.getConfig(action.strategy);
      const oldVal = current[action.key] ?? null;
      registry.setConfigKey(action.strategy, action.key, action.value);
      saveRuntimeConfigFile(
        snapshotToPersistable(this.getRuntimeConfigView()),
        registry.getAllConfigs(),
      );
      logAiAction({
        timestamp: new Date().toISOString(),
        source: 'reviewer',
        strategy: action.strategy,
        key: action.key,
        oldValue: oldVal,
        newValue: action.value,
        reason: action.reason,
      });
      console.log(
        `[AI-REVIEWER][APPLIED] ${action.strategy}.${action.key}: ${oldVal ?? '?'} → ${action.value} — ${action.reason}`,
      );
    }
  }

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

    // Build per-symbol price snapshot for exits + HWM updates
    const priceMap = this.getCurrentPriceMap();
    const universe = getActiveUniverse();

    // Build per-symbol SMA snapshot for funding rate calc
    const smaMap = new Map<string, number>();
    for (const sym of universe) {
      const m = this.multiMonitor.get(sym.mint);
      const s = m?.getMovingAverage(20);
      if (s !== null && s !== undefined) smaMap.set(sym.mint, s);
    }
    const solSmaForFunding = this.priceMonitor.getMovingAverage(20);
    if (solSmaForFunding !== null) smaMap.set(this.cfg.baseMint, solSmaForFunding);

    // ── Perp engine tick: accrue funding, update HWMs, process exits ──
    this.perpEngine.accrueFunding(priceMap, smaMap);
    this.perpEngine.updateHighWaterMarks(priceMap);
    const perpExits = this.perpEngine.checkExits(priceMap);
    for (const sig of perpExits) {
      const px = priceMap.get(sig.mint);
      if (px === undefined) continue;
      try {
        this.perpEngine.closePerp(sig.positionId, px, sig.reason);
      } catch (e) {
        console.error('[PERP] close failed:', e);
      }
    }

    this.positionManager.updateHighWaterMarks(priceMap);

    // Process risk exits for ALL open SPOT positions (per-symbol prices),
    // excluding buy_and_hold positions which have no SL/TP.
    const allExits = this.positionManager
      .checkExits(priceMap)
      .filter((sig) => {
        const pos = this.positionManager
          .getOpenPositions()
          .find((p) => p.id === sig.positionId);
        return pos?.strategy !== 'buy_and_hold_v1';
      });
    if (allExits.length > 0) {
      // Group exits by mint and process with the right price for each
      const byMint = new Map<string, typeof allExits>();
      for (const sig of allExits) {
        const arr = byMint.get(sig.mint) ?? [];
        arr.push(sig);
        byMint.set(sig.mint, arr);
      }
      for (const [mint, sigs] of byMint) {
        const px = priceMap.get(mint);
        if (px === undefined) continue;
        await this.processRiskExitSignals(sigs, px);
      }
    }

    // Classify overall market regime using SOL as the macro indicator
    const solSma = this.priceMonitor.getMovingAverage(20);
    const solVol = this.priceMonitor.getVolatility(20);
    const maxLookback = Math.max(...ALL_STRATEGY_NAMES.map((sn) => {
      const cfg = registry.getConfig(sn);
      return (cfg.lookbackBars ?? 20) + 1;
    }));
    const solHistory = this.priceMonitor.getPriceHistory(Math.max(maxLookback, 21));
    const regimeResult = classifyRegime(solHistory, solVol);
    this.currentRegime = regimeResult.regime;
    this.currentRegimeResult = regimeResult;

    const enabledStrategies = this.cfg.strategies;

    // First pass: run signal strategies (mean_rev, breakout) per-symbol;
    // collect candidate signals for AI strategy. Buy & Hold handled separately.
    const candidateSignals: import('./strategies/base').CandidateSignal[] = [];

    for (const sym of universe) {
      const monitor = this.multiMonitor.get(sym.mint);
      if (!monitor || monitor.getSampleCount() < 10) continue;

      const symPrice = monitor.getLatestPrice();
      const symSma = monitor.getMovingAverage(20);
      const symVol = monitor.getVolatility(20);
      const symHistory = monitor.getPriceHistory(Math.max(maxLookback, 21));
      if (symPrice === null || symSma === null) continue;

      // Per-symbol regime classification
      const symRegime = classifyRegime(symHistory, symVol).regime;

      for (const stratName of enabledStrategies) {
        if (stratName === 'ai_strategy_v1' || stratName === 'buy_and_hold_v1') continue;
        const strategy = registry.getStrategyByName(stratName);
        if (!strategy) continue;

        // Backtest-driven whitelist: don't run a strategy on a symbol where
        // it has shown negative edge in historical testing.
        if (!this.isWhitelisted(stratName, sym.symbol)) continue;

        // Per (strategy, mint) open-position lookup — checks BOTH spot and perp
        const openSpot = this.positionManager.getOpenPositions()
          .find((p) => p.strategy === stratName && p.mint === sym.mint) ?? null;
        const openPerp = this.perpEngine.getOpen()
          .find((p) => p.strategy === stratName && p.mint === sym.mint) ?? null;
        const openPos = openSpot ?? (openPerp ? {
          id: openPerp.id,
          entryPrice: openPerp.entryPrice,
          amount: BigInt(Math.floor(openPerp.size * 1e9)),
          strategy: openPerp.strategy,
        } : null);

        if (openPos) {
          this.logPositionHoldIfDue(symPrice, `${stratName}:${sym.symbol}`);
          continue;
        }

        // Regime gate — based on this symbol's regime
        if (!isRegimeAllowed(stratName, symRegime)) {
          continue;
        }

        // Per (strategy, mint) cooldown
        const cdKey = `${stratName}:${sym.mint}`;
        const now = Date.now();
        const cooldownUntil = this.strategyCooldowns.get(cdKey) ?? 0;
        if (now < cooldownUntil) continue;

        const signal = await Promise.resolve(strategy.evaluate({
          currentPrice: symPrice,
          sma: symSma,
          volatility: symVol,
          openPosition: null,
          config: registry.getConfig(stratName),
          priceHistory: symHistory,
        }));

        const dev = symSma !== 0 ? ((symPrice - symSma) / symSma) * 100 : 0;
        if (signal.action !== 'hold') {
          console.log(
            `[AGENT][${stratName}][${sym.symbol}] px=${symPrice.toFixed(4)} dev=${dev.toFixed(2)}% vol=${(symVol * 100).toFixed(2)}% regime=${symRegime} → ${signal.action} (${signal.reason})`,
          );
        }

        // AI sees candidates with which symbol they came from
        candidateSignals.push({
          strategyName: stratName,
          signal: { ...signal, metadata: { ...signal.metadata, mint: sym.mint, symbol: sym.symbol } },
        });

        if (signal.action === 'buy') {
          // Route through perp engine if the strategy tagged this as a perp signal
          const perpMeta = (signal.metadata as { perp?: { direction: PerpDirection; leverage: number } } | undefined)?.perp;
          if (perpMeta) {
            await this.executePerpEntry(stratName, sym.mint, symPrice, perpMeta.direction, perpMeta.leverage);
          } else {
            await this.executeStrategyBuy(stratName, sym.mint, symPrice);
          }
        }
      }
    }

    // Handle Buy & Hold (still SOL-only — that's its whole job)
    const solPrice = priceMap.get(this.cfg.baseMint);
    if (enabledStrategies.includes('buy_and_hold_v1') && solPrice !== undefined) {
      await this.handleBuyAndHold(solPrice);
    }

    // Second pass: AI strategy filters approved candidate-symbol pairs
    if (enabledStrategies.includes('ai_strategy_v1') && solPrice !== undefined) {
      const aiStrategy = registry.getStrategyByName('ai_strategy_v1');
      if (aiStrategy && candidateSignals.some((c) => c.signal.action === 'buy')) {
        // For each unique candidate (strategy, symbol) buy, run AI
        const buyCands = candidateSignals.filter((c) => c.signal.action === 'buy');
        for (const cand of buyCands) {
          const meta = cand.signal.metadata as { mint?: string; symbol?: string } | undefined;
          const candMint = meta?.mint;
          if (!candMint) continue;

          // Skip if AI strategy already has a position in this symbol
          const aiOpen = this.positionManager.getOpenPositions()
            .find((p) => p.strategy === 'ai_strategy_v1' && p.mint === candMint);
          if (aiOpen) continue;

          const aiSym = universe.find((s) => s.mint === candMint);
          if (!aiSym) continue;
          // Whitelist: only consider candidates on symbols where AI has shown edge
          if (!this.isWhitelisted('ai_strategy_v1', aiSym.symbol)) continue;
          const aiMonitor = this.multiMonitor.get(candMint);
          if (!aiMonitor) continue;
          const aiPx = aiMonitor.getLatestPrice();
          const aiSma = aiMonitor.getMovingAverage(20);
          const aiVol = aiMonitor.getVolatility(20);
          if (aiPx === null) continue;

          // Per (ai_strategy_v1, mint) cooldown
          const cdKey = `ai_strategy_v1:${candMint}`;
          const aiCooldownUntil = this.strategyCooldowns.get(cdKey) ?? 0;
          if (Date.now() < aiCooldownUntil) continue;

          if (!isRegimeAllowed('ai_strategy_v1', this.currentRegime)) continue;

          const aiSignal = await Promise.resolve(aiStrategy.evaluate({
            currentPrice: aiPx,
            sma: aiSma,
            volatility: aiVol,
            openPosition: null,
            config: registry.getConfig('ai_strategy_v1'),
            priceHistory: aiMonitor.getPriceHistory(Math.max(maxLookback, 21)),
            candidateSignals: [cand],
          }));

          console.log(
            `[AGENT][ai_strategy_v1][${aiSym.symbol}] candidate=${cand.strategyName} signal=${aiSignal.action} reason="${aiSignal.reason}"`,
          );

          if (aiSignal.action === 'buy') {
            await this.executeStrategyBuy('ai_strategy_v1', candMint, aiPx);
          }
        }
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
      const grossPnlM = closed.realizedPnlGross ?? closed.realizedPnlQuote;
      const netPnlM = closed.realizedPnlNet ?? closed.realizedPnlQuote;
      this.dailyRealizedPnL += grossPnlM;
      this.dailyRealizedPnLNet += netPnlM;
      this.strategyDailyPnL.set('mean_reversion_v1', (this.strategyDailyPnL.get('mean_reversion_v1') ?? 0) + grossPnlM);
      this.strategyDailyPnLNet.set('mean_reversion_v1', (this.strategyDailyPnLNet.get('mean_reversion_v1') ?? 0) + netPnlM);
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
    const portfolio = this.getPortfolioForStrategy(pos.strategy);

    // Resolve current price for the position's actual mint
    let exitPrice: number;
    if (pos.mint === SOL) {
      exitPrice = await this.resolvePriceSolUsdc();
    } else {
      const monitor = this.multiMonitor.get(pos.mint);
      const px = monitor?.getLatestPrice();
      if (px === null || px === undefined) {
        throw new Error(`No live price for mint ${pos.mint} — cannot close`);
      }
      exitPrice = px;
    }

    const rec = await this.executeSwapLeg(pos.mint, USDC, pos.amount, exitPrice, `close_${reason}`, {
      skipLog: true,
      portfolio,
    });
    if (rec.status !== 'paper_filled' && rec.status !== 'success') {
      logTrade(rec);
      return rec;
    }
    const exitQuoteAmount = rawToHumanAmount(USDC, rec.outputAmount);
    const exitFeesQuote = rec.solFeeQuote ?? 0;
    const closed = this.positionManager.closePosition(positionId, exitPrice, reason, {
      exitQuoteAmount,
      exitFeesQuote,
    });
    const grossPnlC = closed.realizedPnlGross ?? closed.realizedPnlQuote;
    const netPnlC = closed.realizedPnlNet ?? closed.realizedPnlQuote;
    this.dailyRealizedPnL += grossPnlC;
    this.dailyRealizedPnLNet += netPnlC;
    this.strategyDailyPnL.set(pos.strategy, (this.strategyDailyPnL.get(pos.strategy) ?? 0) + grossPnlC);
    this.strategyDailyPnLNet.set(pos.strategy, (this.strategyDailyPnLNet.get(pos.strategy) ?? 0) + netPnlC);
    const netForOutcome = closed.realizedPnlNet ?? closed.realizedPnlQuote;
    // Per (strategy, mint) cooldown
    this.armStrategyCooldown(`${pos.strategy}:${pos.mint}`, netForOutcome >= 0 ? 'win' : 'loss');
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
      priceAtTrade: exitPrice,
      entryPrice: pos.entryPrice,
      exitPrice: exitPrice,
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
    regime: MarketRegime;
    regimeDetail?: RegimeResult;
  }> {
    // Aggregate P&L across all portfolios — use cached prices to avoid
    // hitting Jupiter on every /status request (was causing 429 cascades).
    const priceMap = this.getCurrentPriceMap();
    let aggCurrentValue = 0;
    let aggInitialValue = 0;
    const aggBalancesRaw: Record<string, bigint> = {};
    for (const engine of this.portfolios.values()) {
      try {
        const pnl = await engine.getPnL(this.cfg.quoteMint, priceMap);
        aggCurrentValue += pnl.currentValue;
        aggInitialValue += pnl.initialValue;
      } catch (e) {
        console.warn('[STATUS] portfolio PnL failed (skipped):', (e as Error).message);
      }
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
      regime: this.currentRegime,
      regimeDetail: this.currentRegimeResult ?? undefined,
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
    const priceMap = this.getCurrentPriceMap();
    for (const [stratName, engine] of this.portfolios) {
      const strat = registry.getStrategyByName(stratName);
      const pnl = await engine.getPnL(this.cfg.quoteMint, priceMap);
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

  /**
   * Build a Map<mint, currentPrice> snapshot from the multi-symbol monitor
   * and the legacy SOL priceMonitor. Used for position checks, PnL, exits.
   */
  getCurrentPriceMap(): Map<string, number> {
    const out = new Map<string, number>();
    const solPx = this.priceMonitor.getLatestPrice();
    if (solPx !== null) out.set(this.cfg.baseMint, solPx);
    for (const snap of this.multiMonitor.snapshotAll()) {
      if (snap.price !== null) out.set(snap.mint, snap.price);
    }
    return out;
  }

  getPositionsApi(currentPrice: number | null): {
    positions: Array<Record<string, unknown> & { unrealizedPnlQuote: number }>;
    unrealizedPnLTotal: number;
    unrealizedPnLTotalNet: number;
  } {
    const px = currentPrice ?? this.priceMonitor.getLatestPrice() ?? 0;
    const priceMap = this.getCurrentPriceMap();
    const feeLamports =
      (this.cfg.paperNetworkFeeLamports + this.cfg.paperPriorityFeeLamports) | 0;
    const solFeeQuoteEst = px > 0 ? (feeLamports / 1e9) * px : 0;
    const takerBps = Math.max(0, this.cfg.paperTakerFeeBps | 0);
    let totalNet = 0;
    const positions = this.positionManager.getOpenPositions().map((p) => {
      const positionPrice = priceMap.get(p.mint) ?? 0;
      const decimals = getTokenDecimals(p.mint);
      const tokenHuman = Number(p.amount) / 10 ** decimals;
      const unrealizedGross = positionPrice > 0
        ? (positionPrice - p.entryPrice) * tokenHuman
        : 0;
      let unrealizedNet = unrealizedGross;
      if (p.entryQuoteAmount != null && positionPrice > 0) {
        const grossExitUsdc = tokenHuman * positionPrice;
        const takerHaircut = grossExitUsdc * (takerBps / 10_000);
        const estExitUsdc = grossExitUsdc - takerHaircut;
        const entryFees = p.entryFeesQuote ?? 0;
        // SOL gas fee is only meaningful when the swap leg uses SOL
        const gasEst = p.mint === this.cfg.baseMint ? solFeeQuoteEst : 0;
        unrealizedNet = estExitUsdc - p.entryQuoteAmount - entryFees - gasEst;
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
    const unrealizedPnLTotal = this.positionManager.getUnrealizedPnL(priceMap);
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
    dailyRealizedPnL: number;
    dailyRealizedPnLNet: number;
    dailyStartingValueQuote: number;
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
    riskMultiplier: number;
    regime: MarketRegime;
    regimeAllowed: boolean;
  } | null> {
    const s = registry.getStrategyByName(strategyName);
    if (!s) return null;

    const stats = getStrategyStats(strategyName, this.mode);
    const openSpotCount = this.positionManager
      .getOpenPositions()
      .filter((p) => p.strategy === strategyName).length;
    const openPerpCount = this.perpEngine
      .getOpen()
      .filter((p) => p.strategy === strategyName).length;
    const openCount = openSpotCount + openPerpCount;

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
      const pnl = await engine.getPnL(this.cfg.quoteMint, this.getCurrentPriceMap());
      const balancesRaw = engine.getAllBalances();
      const balancesJson: Record<string, { human: number; raw: string }> = {};
      for (const [mint, bal] of Object.entries(balancesRaw)) {
        balancesJson[mint] = { human: bal.human, raw: bal.raw.toString() };
      }
      portfolio = { ...pnl, balances: balancesJson };
    }

    // Cooldown keys are now per (strategy, mint). Report the max remaining.
    const now = Date.now();
    let maxCooldownUntil = 0;
    for (const [key, until] of this.strategyCooldowns) {
      if (key === strategyName || key.startsWith(`${strategyName}:`)) {
        if (until > maxCooldownUntil) maxCooldownUntil = until;
      }
    }
    const cooldownRemaining = Math.max(0, Math.ceil((maxCooldownUntil - now) / 1000));

    return {
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      enabled: this.cfg.strategies.includes(strategyName),
      ...stats,
      openPositions: openCount,
      cooldownRemaining,
      dailyRealizedPnL: this.strategyDailyPnL.get(strategyName) ?? 0,
      dailyRealizedPnLNet: this.strategyDailyPnLNet.get(strategyName) ?? 0,
      dailyStartingValueQuote: this.strategyDailyStartValue.get(strategyName) ?? 0,
      avgHoldTimeMinutes,
      config: registry.getConfig(strategyName),
      portfolio,
      riskMultiplier: this.strategyRiskMultiplier.get(strategyName) ?? 1.0,
      regime: this.currentRegime,
      regimeAllowed: isRegimeAllowed(strategyName, this.currentRegime),
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

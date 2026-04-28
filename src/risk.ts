import type { AppConfig } from './config';

export type TradeOutcome = 'win' | 'loss' | null;

export class RiskManager {
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number | null;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  riskPerTradePercent: number;
  cooldownAfterLossMs: number;
  cooldownNormalMs: number;

  constructor(cfg: AppConfig) {
    this.stopLossPercent = cfg.stopLossPercent;
    this.takeProfitPercent = cfg.takeProfitPercent;
    this.trailingStopPercent = cfg.trailingStopPercent;
    this.maxDailyLossPercent = cfg.maxDailyLossPercent;
    this.maxOpenPositions = cfg.maxOpenPositions;
    this.riskPerTradePercent = cfg.riskPerTradePercent;
    this.cooldownAfterLossMs = cfg.cooldownLossMinutes * 60 * 1000;
    this.cooldownNormalMs = cfg.cooldownMinutes * 60 * 1000;
  }

  /** SOL human from risk formula; USDC spend ≈ solHuman * entryPrice. */
  calculatePositionSize(
    portfolioValueInQuote: number,
    entryPrice: number,
    stopLossPrice: number,
    riskMultiplier = 1.0,
  ): { solHuman: number; usdcMicroSpend: bigint } {
    const denom = entryPrice - stopLossPrice;
    if (denom <= 0 || !Number.isFinite(portfolioValueInQuote) || portfolioValueInQuote <= 0) {
      return { solHuman: 0, usdcMicroSpend: 0n };
    }
    const effectiveRisk = this.riskPerTradePercent * Math.max(0.1, riskMultiplier);
    const solHuman =
      (portfolioValueInQuote * effectiveRisk) / denom;
    if (!Number.isFinite(solHuman) || solHuman <= 0) {
      return { solHuman: 0, usdcMicroSpend: 0n };
    }
    const usdcHuman = solHuman * entryPrice;
    const usdcMicroSpend = BigInt(Math.max(0, Math.floor(usdcHuman * 1e6)));
    return { solHuman, usdcMicroSpend };
  }

  canOpenPosition(
    openPositionsCount: number,
    dailyRealizedPnL: number,
    startingDailyCapitalQuote: number,
  ): { allowed: boolean; reason?: string } {
    if (openPositionsCount >= this.maxOpenPositions) {
      return {
        allowed: false,
        reason: `max_open_positions (${this.maxOpenPositions}) reached`,
      };
    }
    if (
      startingDailyCapitalQuote > 0 &&
      dailyRealizedPnL / startingDailyCapitalQuote <= -this.maxDailyLossPercent
    ) {
      return {
        allowed: false,
        reason: `daily_loss_circuit_breaker (limit ${(this.maxDailyLossPercent * 100).toFixed(1)}% of day start NAV)`,
      };
    }
    return { allowed: true };
  }

  getCooldownMs(lastTradeResult: TradeOutcome): number {
    if (lastTradeResult === 'loss') return this.cooldownAfterLossMs;
    return this.cooldownNormalMs;
  }

  setFromKey(key: string, value: string): boolean {
    const k = key.toLowerCase().replace(/-/g, '_');
    const num = Number(value);
    switch (k) {
      case 'stop_loss':
        if (!Number.isFinite(num)) return false;
        this.stopLossPercent = num;
        return true;
      case 'take_profit':
        if (!Number.isFinite(num)) return false;
        this.takeProfitPercent = num;
        return true;
      case 'trailing_stop':
        if (value.toLowerCase() === 'null' || value === '') {
          this.trailingStopPercent = null;
          return true;
        }
        if (!Number.isFinite(num)) return false;
        this.trailingStopPercent = num;
        return true;
      case 'max_daily_loss':
        if (!Number.isFinite(num)) return false;
        this.maxDailyLossPercent = num;
        return true;
      case 'max_open_positions':
        if (!Number.isInteger(num) || num < 0) return false;
        this.maxOpenPositions = num;
        return true;
      case 'risk_per_trade':
        if (!Number.isFinite(num)) return false;
        this.riskPerTradePercent = num;
        return true;
      case 'cooldown_loss_minutes':
        if (!Number.isFinite(num) || num < 0) return false;
        this.cooldownAfterLossMs = num * 60 * 1000;
        return true;
      case 'cooldown':
      case 'cooldown_minutes':
        if (!Number.isFinite(num) || num < 0) return false;
        this.cooldownNormalMs = num * 60 * 1000;
        return true;
      default:
        return false;
    }
  }

  snapshot(): Record<string, string | number | null> {
    return {
      stopLossPercent: this.stopLossPercent,
      takeProfitPercent: this.takeProfitPercent,
      trailingStopPercent: this.trailingStopPercent,
      maxDailyLossPercent: this.maxDailyLossPercent,
      maxOpenPositions: this.maxOpenPositions,
      riskPerTradePercent: this.riskPerTradePercent,
      cooldownAfterLossMs: this.cooldownAfterLossMs,
      cooldownNormalMs: this.cooldownNormalMs,
    };
  }
}

import type { Strategy } from './base';
import { BreakoutStrategy } from './breakout';
import { BuyAndHoldStrategy } from './buyAndHold';
import { MeanReversionStrategy } from './meanReversion';
import { AiStrategy } from './aiStrategy';
import { MeanReversionShortStrategy } from './meanReversionShort';
import { MomentumStrategy } from './momentum';

export class StrategyRegistry {
  private readonly strategies: Map<string, Strategy> = new Map();
  private readonly configs: Map<string, Record<string, number>> = new Map();

  constructor() {
    this.register(new MeanReversionStrategy());
    this.register(new BreakoutStrategy());
    this.register(new BuyAndHoldStrategy());
    this.register(new AiStrategy());
    this.register(new MeanReversionShortStrategy());
    this.register(new MomentumStrategy());
  }

  private register(s: Strategy): void {
    this.strategies.set(s.name, s);
    this.configs.set(s.name, { ...s.getDefaultConfig() });
  }

  getStrategies(): Strategy[] {
    return [...this.strategies.values()];
  }

  getStrategyByName(name: string): Strategy | undefined {
    return this.strategies.get(name);
  }

  getConfig(name: string): Record<string, number> {
    return { ...(this.configs.get(name) ?? {}) };
  }

  /** Set one config key for a strategy. Returns false if strategy unknown. */
  setConfigKey(name: string, key: string, value: number): boolean {
    const s = this.strategies.get(name);
    if (!s) return false;
    const current = this.configs.get(name) ?? { ...s.getDefaultConfig() };
    current[key] = value;
    this.configs.set(name, current);
    return true;
  }

  /** Bulk-load persisted configs, merging with each strategy's defaults. */
  loadConfigs(strategyConfigs: Record<string, Record<string, number>>): void {
    for (const [name, cfg] of Object.entries(strategyConfigs)) {
      const s = this.strategies.get(name);
      if (!s) continue;
      this.configs.set(name, { ...s.getDefaultConfig(), ...cfg });
    }
  }

  getAllConfigs(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [name, cfg] of this.configs) {
      out[name] = { ...cfg };
    }
    return out;
  }
}

export const registry = new StrategyRegistry();

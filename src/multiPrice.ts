/**
 * MultiSymbolMonitor — owns one PriceMonitor per active universe symbol.
 *
 * Each underlying PriceMonitor polls Jupiter independently for its symbol's
 * price quoted in USDC. The monitor exposes per-symbol getters and a
 * single `onPriceUpdate(mint, price, sma20)` event consumers can subscribe to.
 */
import { PriceMonitor } from './price';
import { getActiveUniverse, QUOTE, type SymbolInfo, SOL_MINT } from './symbols';

export type MultiPriceUpdate = (
  mint: string,
  price: number,
  sma20: number,
) => void;

export class MultiSymbolMonitor {
  private monitors = new Map<string, PriceMonitor>();
  private intervalMs: number;
  private updateHandler: MultiPriceUpdate = () => {};
  /** External SOL PriceMonitor (the legacy one in agent.ts) so we don't double-poll. */
  private solExternal: PriceMonitor | null = null;

  constructor(intervalMs: number, solExternal?: PriceMonitor) {
    this.intervalMs = intervalMs;
    this.solExternal = solExternal ?? null;
    for (const sym of getActiveUniverse()) {
      // Skip SOL if we have an external monitor already polling it (avoid 2× rate).
      if (sym.mint === SOL_MINT && this.solExternal) continue;
      const m = new PriceMonitor(
        sym.mint,
        QUOTE.mint,
        sym.quoteAmountRaw,
        intervalMs,
      );
      // Forward each per-symbol update to the shared handler
      m.onPriceUpdate = (price, sma20) => {
        this.updateHandler(sym.mint, price, sma20);
      };
      this.monitors.set(sym.mint, m);
    }
  }

  /** Sets the single shared callback. Replaces any prior handler. */
  set onPriceUpdate(handler: MultiPriceUpdate) {
    this.updateHandler = handler;
  }

  start(): void {
    // Stagger start times across symbols so all N polls don't fire on the same ms
    let i = 0;
    for (const m of this.monitors.values()) {
      const delay = (i * this.intervalMs) / Math.max(1, this.monitors.size);
      setTimeout(() => m.start(), delay);
      i++;
    }
  }

  stop(): void {
    for (const m of this.monitors.values()) m.stop();
  }

  /** Get the PriceMonitor for a given mint, or undefined if not in the universe. */
  get(mint: string): PriceMonitor | undefined {
    if (mint === SOL_MINT && this.solExternal) return this.solExternal;
    return this.monitors.get(mint);
  }

  /** Returns universe symbols this monitor is tracking. */
  getSymbols(): SymbolInfo[] {
    return getActiveUniverse();
  }

  /** Snapshot of latest price + SMA + vol for every symbol. */
  snapshotAll(): Array<{
    mint: string;
    symbol: string;
    price: number | null;
    sma20: number | null;
    volatility: number;
    sampleCount: number;
  }> {
    return getActiveUniverse().map((s) => {
      // For SOL, use the external monitor if it's wired in
      const m = s.mint === SOL_MINT && this.solExternal
        ? this.solExternal
        : this.monitors.get(s.mint);
      return {
        mint: s.mint,
        symbol: s.symbol,
        price: m?.getLatestPrice() ?? null,
        sma20: m?.getMovingAverage(20) ?? null,
        volatility: m?.getVolatility(20) ?? 0,
        sampleCount: m?.getSampleCount() ?? 0,
      };
    });
  }
}

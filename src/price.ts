import { getOrder } from './swap';
import type { JupiterOrderResponse } from './types';
import { getTokenDecimals } from './tokenInfo';

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: string | number | bigint,
): Promise<JupiterOrderResponse> {
  return getOrder(inputMint, outputMint, amount);
}

export function calculatePrice(
  quote: JupiterOrderResponse,
  inputDecimals: number,
  outputDecimals: number,
): number {
  const inAmt = Number(quote.inAmount);
  const outAmt = Number(quote.outAmount);
  const inHuman = inAmt / 10 ** inputDecimals;
  const outHuman = outAmt / 10 ** outputDecimals;
  if (inHuman === 0) return 0;
  return outHuman / inHuman;
}

type PricePoint = { t: number; price: number };

export class PriceMonitor {
  inputMint: string;
  outputMint: string;
  amount: string | number | bigint;
  intervalMs: number;
  private history: PricePoint[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  onPriceUpdate: (price: number, sma20: number, change: number) => void = () => {};

  constructor(
    inputMint: string,
    outputMint: string,
    amount: string | number | bigint,
    intervalMs: number,
  ) {
    this.inputMint = inputMint;
    this.outputMint = outputMint;
    this.amount = amount;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      const q = await getQuote(this.inputMint, this.outputMint, this.amount);
      const dIn = getTokenDecimals(this.inputMint);
      const dOut = getTokenDecimals(this.outputMint);
      const price = calculatePrice(q, dIn, dOut);
      const t = Date.now();
      this.history.push({ t, price });
      if (this.history.length > 100) {
        this.history.splice(0, this.history.length - 100);
      }
      const sma20 = this.getMovingAverage(20) ?? price;
      const change = sma20 !== 0 ? ((price - sma20) / sma20) * 100 : 0;
      const vol = this.getVolatility(20) * 100;
      const devFromSmaPct = sma20 !== 0 ? ((price - sma20) / sma20) * 100 : 0;
      console.log(
        `[PRICE] ${new Date(t).toISOString()} price=${price.toFixed(4)} sma20=${sma20.toFixed(4)} devFromSma=${devFromSmaPct.toFixed(2)}% vol=${vol.toFixed(2)}%`,
      );
      this.onPriceUpdate(price, sma20, change);
    } catch (e) {
      console.error('[PRICE] tick failed:', e);
    }
  }

  getLatestPrice(): number | null {
    const last = this.history[this.history.length - 1];
    return last ? last.price : null;
  }

  getPriceChange(periods?: number): number | null {
    if (this.history.length < 2) return null;
    const n = periods ?? this.history.length;
    const slice = this.history.slice(-Math.min(n, this.history.length));
    const first = slice[0]?.price;
    const last = slice[slice.length - 1]?.price;
    if (first === undefined || last === undefined || first === 0) return null;
    return ((last - first) / first) * 100;
  }

  getMovingAverage(periods: number): number | null {
    if (this.history.length === 0) return null;
    const slice = this.history.slice(-Math.min(periods, this.history.length));
    const sum = slice.reduce((a, p) => a + p.price, 0);
    return sum / slice.length;
  }

  getVolatility(periods: number): number {
    const slice = this.history.slice(-Math.min(periods, this.history.length));
    if (slice.length < 2) return 0;
    const mean = slice.reduce((a, p) => a + p.price, 0) / slice.length;
    if (mean === 0) return 0;
    const variance =
      slice.reduce((a, p) => a + (p.price - mean) ** 2, 0) / slice.length;
    const sd = Math.sqrt(variance);
    return sd / mean;
  }

  getSampleCount(): number {
    return this.history.length;
  }
}

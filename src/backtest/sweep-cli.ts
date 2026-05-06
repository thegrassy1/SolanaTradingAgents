/**
 * Parameter sweep + walk-forward CLI.
 *
 * Single-param sweep:
 *   npm run sweep -- --strategy mean_reversion_v1 --symbol SOL --from 2026-04-01 \
 *     --param threshold --range 0.5,5,0.25
 *
 * Walk-forward (in-sample 70% / out-of-sample 30%):
 *   npm run sweep -- --strategy mean_reversion_v1 --symbol SOL --from 2026-04-01 \
 *     --param threshold --range 0.5,5,0.25 --walkforward
 *
 * Output: console table sorted by Sharpe descending (sweep) or train/test
 *   comparison (walk-forward).
 */
import { sweepParam, walkForward } from './sweep';
import type { BacktestParams } from './types';
import type { Resolution } from '../historical/types';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error(`Bad date: ${s}`);
  return d;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.strategy || !args.param || !args.range) {
    console.error('Usage: --strategy <name> --symbol <ticker> --param <key> --range <from,to,step>');
    console.error('   add --walkforward for train/test split');
    process.exit(1);
  }

  const symbols: string[] = args.all
    ? require('../symbols').getActiveUniverse().map((s: { symbol: string }) => s.symbol)
    : [(args.symbol as string).toUpperCase()];

  const resolution = (args.resolution as Resolution) ?? '1h';
  const now = new Date();
  const from = parseDate(args.from as string, new Date(now.getTime() - 90 * 86400_000));
  const to = parseDate(args.to as string, now);

  const [r1, r2, r3] = (args.range as string).split(',').map((x) => Number(x));
  if (![r1, r2, r3].every(Number.isFinite)) {
    throw new Error(`Bad --range: expected "from,to,step", got "${args.range}"`);
  }

  const base: BacktestParams = {
    strategy: args.strategy as string,
    symbols,
    resolution,
    fromMs: from.getTime(),
    toMs: to.getTime(),
  };

  const range = { param: args.param as string, from: r1, to: r2, step: r3 };

  if (args.walkforward) {
    console.log(`[SWEEP] Walk-forward: ${args.strategy} on ${symbols.join(',')} @ ${resolution}`);
    console.log(`        ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
    console.log(`        Param ${range.param}: ${range.from} → ${range.to} step ${range.step}`);
    const { trainBest, testResult, trainPct, splitMs } = await walkForward(base, range);
    const splitDate = new Date(splitMs).toISOString().slice(0, 10);
    console.log('');
    console.log(`  Train (in-sample, ${(trainPct * 100).toFixed(0)}% of period):`);
    console.log(`    Best ${range.param}: ${trainBest.value}`);
    console.log(`    Sharpe: ${trainBest.metrics.sharpe.toFixed(2)}  Return: ${(trainBest.metrics.totalReturnPct * 100).toFixed(2)}%  Trades: ${trainBest.trades}`);
    console.log('');
    console.log(`  Test (out-of-sample, from ${splitDate}):`);
    console.log(`    Same ${range.param}=${testResult.value}`);
    console.log(`    Sharpe: ${testResult.metrics.sharpe.toFixed(2)}  Return: ${(testResult.metrics.totalReturnPct * 100).toFixed(2)}%  Trades: ${testResult.trades}`);
    console.log('');
    const overfit = trainBest.metrics.sharpe - testResult.metrics.sharpe;
    console.log(`  Overfitting indicator (train Sharpe - test Sharpe): ${overfit.toFixed(2)}`);
    console.log(`    ${overfit > 1 ? '⚠ Likely overfit (test much worse than train)' : '✓ Holds up out of sample'}`);
    return;
  }

  console.log(`[SWEEP] ${args.strategy} on ${symbols.join(',')} @ ${resolution}`);
  console.log(`        ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
  console.log(`        Param ${range.param}: ${range.from} → ${range.to} step ${range.step}`);

  const t0 = Date.now();
  const rows = await sweepParam(base, range);
  console.log(`[SWEEP] done in ${Date.now() - t0}ms · ${rows.length} configurations\n`);

  // Print top 10 + bottom 5
  console.log(`  ${range.param.padEnd(14)} | Sharpe | Return  | DD      | Trades | Expectancy`);
  console.log(`  ${'-'.repeat(72)}`);
  const display = rows.length > 15 ? [...rows.slice(0, 10), null, ...rows.slice(-5)] : rows;
  for (const r of display) {
    if (r === null) {
      console.log(`  ...`);
      continue;
    }
    const m = r.metrics;
    console.log(`  ${String(r.value).padEnd(14)} | ${m.sharpe.toFixed(2).padStart(6)} | ${(m.totalReturnPct * 100).toFixed(2).padStart(6)}% | -${(m.maxDrawdown * 100).toFixed(1).padStart(5)}% | ${String(r.trades).padStart(6)} | ${m.expectancy >= 0 ? '+' : ''}$${m.expectancy.toFixed(2)}`);
  }
}

void main().catch((e) => {
  console.error('[SWEEP] fatal:', e);
  process.exit(1);
});

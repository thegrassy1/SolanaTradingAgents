import dotenv from 'dotenv';

dotenv.config();

export type Mode = 'paper' | 'live';

export interface AppConfig {
  privateKey: string;
  jupiterApiUrl: string;
  jupiterApiKey: string;
  baseMint: string;
  quoteMint: string;
  tradeAmountLamports: number;
  pollIntervalMs: number;
  mode: Mode;
  paperInitialSol: number;
  paperInitialUsdc: number;
  apiPort: number;
  apiHost: string;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number | null;
  maxDailyLossPercent: number;
  maxOpenPositions: number;
  riskPerTradePercent: number;
  cooldownLossMinutes: number;
  cooldownMinutes: number;
}

function optionalEnv(name: string, defaultValue: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? defaultValue : v;
}

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Invalid integer for ${name}: ${raw}`);
  return n;
}

function parseFloatEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) throw new Error(`Invalid number for ${name}: ${raw}`);
  return n;
}

function parseOptionalTrailingStop(): number | null {
  const raw = process.env.TRAILING_STOP_PERCENT;
  if (raw === undefined || raw === '' || raw.toLowerCase() === 'null') {
    return null;
  }
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? null : n;
}

function parseMode(raw: string | undefined): Mode {
  if (raw === 'live') return 'live';
  return 'paper';
}

const privateKey = (process.env.PRIVATE_KEY ?? '').trim();
const mode = parseMode(process.env.MODE);

if (mode === 'live' && privateKey === '') {
  throw new Error('PRIVATE_KEY is required when MODE=live');
}

export const config: AppConfig = {
  privateKey,
  jupiterApiUrl: optionalEnv('JUPITER_API_URL', 'https://lite-api.jup.ag').replace(/\/$/, ''),
  jupiterApiKey: (process.env.JUPITER_API_KEY ?? '').trim(),
  baseMint: optionalEnv(
    'BASE_MINT',
    'So11111111111111111111111111111111111111112',
  ),
  quoteMint: optionalEnv(
    'QUOTE_MINT',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ),
  tradeAmountLamports: parseIntEnv('TRADE_AMOUNT_LAMPORTS', 10_000_000),
  pollIntervalMs: parseIntEnv('POLL_INTERVAL_MS', 30_000),
  mode,
  paperInitialSol: parseFloatEnv('PAPER_INITIAL_SOL', 10),
  paperInitialUsdc: parseFloatEnv('PAPER_INITIAL_USDC', 1000),
  apiPort: parseIntEnv('API_PORT', 3456),
  apiHost: optionalEnv('API_HOST', '0.0.0.0'),
  stopLossPercent: parseFloatEnv('STOP_LOSS_PERCENT', 0.03),
  takeProfitPercent: parseFloatEnv('TAKE_PROFIT_PERCENT', 0.06),
  trailingStopPercent: parseOptionalTrailingStop(),
  maxDailyLossPercent: parseFloatEnv('MAX_DAILY_LOSS_PERCENT', 0.05),
  maxOpenPositions: parseIntEnv('MAX_OPEN_POSITIONS', 1),
  riskPerTradePercent: parseFloatEnv('RISK_PER_TRADE_PERCENT', 0.02),
  cooldownLossMinutes: parseIntEnv('COOLDOWN_LOSS_MINUTES', 30),
  cooldownMinutes: parseIntEnv('COOLDOWN_MINUTES', 5),
};

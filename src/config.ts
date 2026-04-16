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
};

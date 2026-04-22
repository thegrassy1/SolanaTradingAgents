import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const RUNTIME_CONFIG_PATH = path.join(DATA_DIR, 'runtime-config.json');
const RUNTIME_CONFIG_TMP = path.join(DATA_DIR, 'runtime-config.json.tmp');
const DAILY_STATE_PATH = path.join(DATA_DIR, 'daily-state.json');

export type DailyState = {
  date: string;           // UTC date key, e.g. "2026-04-21"
  startingValueQuote: number; // portfolio NAV at start of this UTC day
};

export function saveDailyState(state: DailyState): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DAILY_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn('[CONFIG] Failed to save daily-state.json:', e);
  }
}

export function loadDailyState(): DailyState | null {
  try {
    if (!fs.existsSync(DAILY_STATE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(DAILY_STATE_PATH, 'utf8')) as unknown;
    if (
      raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      typeof (raw as Record<string, unknown>).date === 'string' &&
      typeof (raw as Record<string, unknown>).startingValueQuote === 'number'
    ) {
      return raw as DailyState;
    }
    return null;
  } catch {
    return null;
  }
}

export type RuntimeConfigView = Record<string, string | number | null>;

/** Keys compatible with POST /config / applyRuntimeConfigValue. */
export function snapshotToPersistable(view: RuntimeConfigView): Record<string, string> {
  // threshold is now owned by the strategy config, not the flat config
  return {
    trade_amount_lamports: String(view.tradeAmountLamports),
    stop_loss: String(view.stopLossPercent),
    take_profit: String(view.takeProfitPercent),
    trailing_stop:
      view.trailingStopPercent === null || view.trailingStopPercent === undefined
        ? 'null'
        : String(view.trailingStopPercent),
    max_daily_loss: String(view.maxDailyLossPercent),
    max_open_positions: String(view.maxOpenPositions),
    risk_per_trade: String(view.riskPerTradePercent),
    cooldown_loss_minutes: String(view.cooldownLossMinutes),
    cooldown_minutes: String(view.cooldownMinutes),
  };
}

/**
 * Read the raw config file and return {flat, strategies}.
 * Also migrates any legacy flat keys that are now strategy-specific
 * (currently: `threshold` → strategies.mean_reversion_v1.threshold).
 * Saves the migrated file back if migration was needed.
 */
function readAndMigrateRawFile(): {
  flat: Record<string, string>;
  strategies: Record<string, Record<string, number>>;
} | null {
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.warn('[CONFIG] Failed to parse runtime-config.json:', e);
    return null;
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const flat: Record<string, string> = {};
  let strategies: Record<string, Record<string, number>> = {};
  let needsSave = false;

  // Extract flat string/number keys (excluding 'strategies')
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'strategies') continue;
    if (typeof v === 'string' || typeof v === 'number') {
      flat[k] = String(v);
    }
  }

  // Extract existing nested strategies block
  if (obj.strategies && typeof obj.strategies === 'object' && !Array.isArray(obj.strategies)) {
    strategies = obj.strategies as Record<string, Record<string, number>>;
  }

  // Migrate flat `threshold` → strategies.mean_reversion_v1.threshold
  if ('threshold' in flat) {
    const v = Number(flat.threshold);
    if (!Number.isNaN(v)) {
      strategies = {
        ...strategies,
        mean_reversion_v1: {
          ...(strategies.mean_reversion_v1 ?? {}),
          threshold: v,
        },
      };
      console.log(
        `[CONFIG] Migrated flat threshold=${flat.threshold} → strategies.mean_reversion_v1.threshold=${v}`,
      );
      delete flat.threshold;
      needsSave = true;
    }
  }

  if (needsSave) {
    try {
      const payload = `${JSON.stringify({ ...flat, strategies }, null, 2)}\n`;
      fs.writeFileSync(RUNTIME_CONFIG_TMP, payload, 'utf8');
      fs.renameSync(RUNTIME_CONFIG_TMP, RUNTIME_CONFIG_PATH);
    } catch (e) {
      console.warn('[CONFIG] Failed to save migrated runtime-config.json:', e);
    }
  }

  return { flat, strategies };
}

/** Load flat (non-strategy) runtime overrides. Strategy keys are excluded. */
export function loadRuntimeConfigFile(): Record<string, string> | null {
  const data = readAndMigrateRawFile();
  if (!data) return null;
  return Object.keys(data.flat).length > 0 ? data.flat : null;
}

/** Load persisted per-strategy configs. */
export function loadStrategyConfigsFromFile(): Record<string, Record<string, number>> | null {
  const data = readAndMigrateRawFile();
  if (!data) return null;
  return Object.keys(data.strategies).length > 0 ? data.strategies : null;
}

export function saveRuntimeConfigFile(
  flat: Record<string, string>,
  strategies: Record<string, Record<string, number>> = {},
): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = `${JSON.stringify({ ...flat, strategies }, null, 2)}\n`;
  fs.writeFileSync(RUNTIME_CONFIG_TMP, payload, 'utf8');
  fs.renameSync(RUNTIME_CONFIG_TMP, RUNTIME_CONFIG_PATH);
}

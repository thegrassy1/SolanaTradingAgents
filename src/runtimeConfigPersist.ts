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
  return {
    threshold: String(view.thresholdPct),
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

export function loadRuntimeConfigFile(): Record<string, string> | null {
  try {
    if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return null;
    const raw = JSON.parse(
      fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8'),
    ) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number') {
        out[k] = String(v);
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (e) {
    console.warn('[CONFIG] Failed to read runtime-config.json:', e);
    return null;
  }
}

export function saveRuntimeConfigFile(data: Record<string, string>): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(RUNTIME_CONFIG_TMP, payload, 'utf8');
  fs.renameSync(RUNTIME_CONFIG_TMP, RUNTIME_CONFIG_PATH);
}

/**
 * One-off diagnostic: HTTP checks against the running agent + read-only SQLite.
 * Env: VERIFY_API_BASE_URL or API_BASE_URL (default http://127.0.0.1:3456), NO_COLOR=1 to disable ANSI.
 * Optional: VERIFY_MEAN_REVERSION_SELL_SINCE=ISO8601 — fail if any exit_reason=mean_reversion_sell at/after that time.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

type SqliteDb = InstanceType<typeof Database>;

type Verdict = 'PASS' | 'FAIL' | 'SKIP';

type Line = {
  verdict: Verdict;
  label: string;
  detail: string;
};

const DEFAULT_BASE = 'http://127.0.0.1:3456';

const useColor =
  process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== '0';

const c = {
  pass: useColor ? '\x1b[32m' : '',
  fail: useColor ? '\x1b[31m' : '',
  skip: useColor ? '\x1b[33m' : '',
  dim: useColor ? '\x1b[90m' : '',
  reset: useColor ? '\x1b[0m' : '',
};

function tag(v: Verdict): string {
  const open =
    v === 'PASS' ? c.pass : v === 'FAIL' ? c.fail : c.skip;
  return `${open}[${v}]${c.reset}`;
}

function baseUrl(): string {
  const raw =
    process.env.VERIFY_API_BASE_URL?.trim() ||
    process.env.API_BASE_URL?.trim() ||
    process.env.AGENT_API_BASE_URL?.trim() ||
    '';
  return raw || DEFAULT_BASE;
}

function joinUrl(base: string, pathname: string): string {
  const b = base.replace(/\/$/, '');
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${b}${p}`;
}

async function fetchJson(
  base: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const url = joinUrl(base, pathname);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

function asRecord(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

function num(x: unknown): number | null {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function openReadonlyDb(): SqliteDb | null {
  const dbPath = path.join(process.cwd(), 'data', 'trades.db');
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function parseTs(s: string): number {
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

function fmtUsd(n: number): string {
  return Math.abs(n).toFixed(2);
}

function main(): void {
  void run().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

async function run(): Promise<void> {
  const base = baseUrl();
  const lines: Line[] = [];
  const notVerified: string[] = [];
  /** Only CHECK 1 failure aborts the rest. */
  let apiUnreachable = false;

  const push = (
    verdict: Verdict,
    label: string,
    detail: string,
    notVerifiedLine?: string,
  ): void => {
    lines.push({ verdict, label, detail });
    if (notVerifiedLine) notVerified.push(notVerifiedLine);
  };

  // CHECK 1
  try {
    const r = await fetchJson(base, 'GET', '/health');
    const health = asRecord(r.json);
    if (r.ok && health?.ok === true) {
      push('PASS', 'API reachable', 'GET /health returned ok=true');
    } else {
      push('FAIL', 'API reachable', `GET /health failed (HTTP ${r.status})`);
      apiUnreachable = true;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    push('FAIL', 'API reachable', msg);
    apiUnreachable = true;
  }

  const db = apiUnreachable ? null : openReadonlyDb();

  if (!apiUnreachable && db) {
    // CHECK 2 — entry signals
    const entryCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM trades
           WHERE status IN ('paper_filled', 'success')
             AND strategy IS NOT NULL
             AND strategy != 'manual'
             AND strategy NOT LIKE 'close_%'
             AND (
               strategy = 'mean_reversion'
               OR strategy LIKE 'mean_reversion%'
             )`,
        )
        .get() as { c: number }
    ).c;
    if (entryCount > 0) {
      push(
        'PASS',
        'Entry signals',
        `${entryCount} trades executed via strategy`,
      );
    } else {
      push('FAIL', 'Entry signals', '0 trades executed via strategy');
    }

    // CHECK 3
    const entryPx = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM trades WHERE entry_price IS NOT NULL AND entry_price > 0`,
        )
        .get() as { c: number }
    ).c;
    if (entryPx > 0) {
      push(
        'PASS',
        'Entry price tracking',
        `${entryPx} trades had entry_price recorded`,
      );
    } else {
      push('FAIL', 'Entry price tracking', '0 trades had entry_price recorded');
    }

    // CHECK 4
    const exitPx = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM trades WHERE exit_price IS NOT NULL AND exit_price > 0`,
        )
        .get() as { c: number }
    ).c;
    if (exitPx > 0) {
      push(
        'PASS',
        'Exit price tracking',
        `${exitPx} closed positions had exit_price recorded`,
      );
    } else {
      push(
        'FAIL',
        'Exit price tracking',
        '0 closed positions had exit_price recorded',
      );
    }

    // CHECK 5
    const sl = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM trades WHERE exit_reason = 'stop_loss'`,
        )
        .get() as { c: number }
    ).c;
    if (sl > 0) {
      push('PASS', 'Stop loss exits', `stop_loss exits: ${sl}`);
    } else {
      push('FAIL', 'Stop loss exits', 'stop_loss exits: 0');
    }

    // CHECK 6
    const tp = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM trades WHERE exit_reason = 'take_profit'`,
        )
        .get() as { c: number }
    ).c;
    if (tp > 0) {
      push('PASS', 'Take profit exits', `take_profit exits: ${tp}`);
    } else {
      push('FAIL', 'Take profit exits', 'take_profit exits: 0');
    }

    // CHECK 7
    const ts = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM trades WHERE exit_reason = 'trailing_stop'`,
        )
        .get() as { c: number }
    ).c;
    if (ts > 0) {
      push('PASS', 'Trailing stop exits', `trailing_stop exits: ${ts}`);
    } else {
      push(
        'SKIP',
        'Trailing stop exits',
        `trailing_stop exits: 0 — ${c.dim}Trailing stop test requires trailing_stop to have been enabled. If you haven't enabled it via /trade set trailing_stop, this check cannot verify.${c.reset}`,
        'Trailing stop: run `/trade set trailing_stop 0.003` and wait for price to rise then retrace',
      );
    }

    // CHECK 8
    const manual = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM trades WHERE exit_reason = 'manual'`,
        )
        .get() as { c: number }
    ).c;
    if (manual > 0) {
      push('PASS', 'Manual exits', `manual exits: ${manual}`);
    } else {
      push(
        'SKIP',
        'Manual exits',
        `manual exits: 0 — ${c.dim}No manual closes found. Send /trade close from chat to test.${c.reset}`,
      );
    }

    // CHECK 8b — mean_reversion_sell must not appear after deploy (risk-only exits)
    const mrsSince =
      process.env.VERIFY_MEAN_REVERSION_SELL_SINCE?.trim() || '';
    if (!mrsSince) {
      push(
        'SKIP',
        'No mean_reversion_sell (post-deploy)',
        `${c.dim}Set VERIFY_MEAN_REVERSION_SELL_SINCE to ISO8601 deploy time to assert zero mean_reversion_sell exits on new trades.${c.reset}`,
      );
    } else {
      const badMrs = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM trades
             WHERE exit_reason = 'mean_reversion_sell' AND timestamp >= ?`,
          )
          .get(mrsSince) as { c: number }
      ).c;
      if (badMrs === 0) {
        push(
          'PASS',
          'No mean_reversion_sell (post-deploy)',
          `0 rows with exit_reason=mean_reversion_sell since ${mrsSince}`,
        );
      } else {
        push(
          'FAIL',
          'No mean_reversion_sell (post-deploy)',
          `${badMrs} trade(s) with mean_reversion_sell since ${mrsSince} (expected risk-only exits)`,
        );
      }
    }

    // CHECK 9
    const pnlRow = db
      .prepare(
        `SELECT
           COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl END), 0) AS winSum,
           COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl END), 0) AS lossSum
         FROM trades
         WHERE (
             (exit_price IS NOT NULL AND exit_price > 0)
             OR (exit_reason IS NOT NULL AND exit_reason != '')
           )
           AND realized_pnl IS NOT NULL`,
      )
      .get() as { n: number; winSum: number; lossSum: number };
    if (pnlRow.n > 0) {
      push(
        'PASS',
        'Realized P&L',
        `P&L tracked on ${pnlRow.n} closes. Wins total: +$${fmtUsd(
          pnlRow.winSum,
        )}, Losses total: -$${fmtUsd(-pnlRow.lossSum)}`,
      );
    } else {
      push('FAIL', 'Realized P&L', 'No closed trades with realized_pnl recorded');
    }

    // CHECK 10 — loss cooldown (sequential)
    const lossRows = db
      .prepare(
        `SELECT id, timestamp, realized_pnl FROM trades
         WHERE realized_pnl IS NOT NULL AND realized_pnl < 0
         ORDER BY timestamp ASC, id ASC`,
      )
      .all() as { id: number; timestamp: string; realized_pnl: number }[];

    const allOrdered = db
      .prepare(
        `SELECT id, timestamp FROM trades ORDER BY timestamp ASC, id ASC`,
      )
      .all() as { id: number; timestamp: string }[];

    const idxById = new Map<number, number>();
    for (let i = 0; i < allOrdered.length; i++) {
      idxById.set(allOrdered[i].id, i);
    }

    let gapsGe10m = 0;
    let gapsWithNext = 0;
    for (const row of lossRows) {
      const idx = idxById.get(row.id);
      if (idx === undefined) continue;
      const next = allOrdered[idx + 1];
      if (!next) continue;
      const t0 = parseTs(row.timestamp);
      const t1 = parseTs(next.timestamp);
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
      const gapSec = (t1 - t0) / 1000;
      gapsWithNext += 1;
      if (gapSec >= 600) gapsGe10m += 1;
    }

    if (lossRows.length < 3) {
      push(
        'SKIP',
        'Loss cooldown',
        'Not enough losses to verify (< 3 losing closes in DB)',
      );
    } else if (gapsWithNext === 0) {
      push(
        'SKIP',
        'Loss cooldown',
        'No sequential next-trade data after losses',
      );
    } else if (gapsGe10m > 0) {
      push(
        'PASS',
        'Loss cooldown',
        `Loss cooldown: ${gapsGe10m}/${gapsWithNext} losses had gap >= 10 min to next trade`,
      );
    } else {
      push(
        'FAIL',
        'Loss cooldown',
        `Loss cooldown: 0/${gapsWithNext} losses had gap >= 10 min to next trade`,
      );
    }

    // CHECK 12
    const manualApi = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM trades
           WHERE strategy = 'manual' AND entry_price IS NOT NULL`,
        )
        .get() as { c: number }
    ).c;
    if (manualApi > 0) {
      push(
        'PASS',
        'Manual API trades',
        `${manualApi} manual trade(s) with entry_price`,
      );
    } else {
      push(
        'SKIP',
        'Manual API trades',
        `${c.dim}No manual buy found. Send /trade buy 10 from chat to test API trade → position tracking integration.${c.reset}`,
      );
    }

    db.close();
  } else if (apiUnreachable) {
    const s = 'Skipped — CHECK 1 failed (API unreachable)';
    push('SKIP', 'Entry signals', s);
    push('SKIP', 'Entry price tracking', s);
    push('SKIP', 'Exit price tracking', s);
    push('SKIP', 'Stop loss exits', s);
    push('SKIP', 'Take profit exits', s);
    push('SKIP', 'Trailing stop exits', s);
    push('SKIP', 'Manual exits', s);
    push(
      'SKIP',
      'No mean_reversion_sell (post-deploy)',
      s,
    );
    push('SKIP', 'Realized P&L', s);
    push('SKIP', 'Loss cooldown', s);
    push('SKIP', 'Manual API trades', s);
  } else {
    push(
      'FAIL',
      'Entry signals',
      'Cannot open ./data/trades.db (missing or unreadable)',
    );
    const s = 'Skipped — ./data/trades.db not available';
    push('SKIP', 'Entry price tracking', s);
    push('SKIP', 'Exit price tracking', s);
    push('SKIP', 'Stop loss exits', s);
    push('SKIP', 'Take profit exits', s);
    push('SKIP', 'Trailing stop exits', s);
    push('SKIP', 'Manual exits', s);
    push(
      'SKIP',
      'No mean_reversion_sell (post-deploy)',
      s,
    );
    push('SKIP', 'Realized P&L', s);
    push('SKIP', 'Loss cooldown', s);
    push('SKIP', 'Manual API trades', s);
  }

  if (!apiUnreachable) {
    // CHECK 11
    try {
      const r = await fetchJson(base, 'GET', '/risk');
      const o = asRecord(r.json);
      const m = o ? num(o.maxDailyLossPercent) : null;
      if (r.ok && m !== null && m >= 0.01 && m <= 0.1) {
        push(
          'PASS',
          'Circuit breaker config',
          `Circuit breaker configured at ${(m * 100).toFixed(0)}% daily loss`,
          'Circuit breaker trip: only fires on 5% daily loss — skip unless you want to force it',
        );
      } else {
        push(
          'FAIL',
          'Circuit breaker config',
          m === null
            ? 'maxDailyLossPercent missing or invalid in GET /risk'
            : `maxDailyLossPercent=${m} (expected 0.01–0.10)`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push('FAIL', 'Circuit breaker config', msg);
    }

    // CHECK 13 — threshold round-trip
    try {
      const s0 = await fetchJson(base, 'GET', '/status');
      const b0 = asRecord(s0.json);
      const orig = b0 ? num(b0.thresholdPct) : null;
      if (orig === null) {
        push(
          'FAIL',
          'Threshold config',
          'GET /status missing thresholdPct — restart the agent after upgrading so this field is exposed, then re-run verify',
        );
      } else {
        let needRestore = false;
        try {
          await fetchJson(base, 'POST', '/config', {
            key: 'threshold',
            value: '0.5',
          });
          needRestore = true;
          const s1 = await fetchJson(base, 'GET', '/status');
          const j1 = asRecord(s1.json);
          const v1 = j1 ? num(j1.thresholdPct) : null;
          const changed = v1 !== null && Math.abs(v1 - 0.5) < 1e-6;
          await fetchJson(base, 'POST', '/config', {
            key: 'threshold',
            value: String(orig),
          });
          needRestore = false;
          const s2 = await fetchJson(base, 'GET', '/status');
          const j2 = asRecord(s2.json);
          const v2 = j2 ? num(j2.thresholdPct) : null;
          const restored = v2 !== null && Math.abs(v2 - orig) < 1e-6;
          if (changed && restored) {
            push(
              'PASS',
              'Threshold config',
              'Threshold config round-trip: PASS',
            );
          } else {
            push(
              'FAIL',
              'Threshold config',
              `Threshold config round-trip: FAIL (orig=${orig} afterSet=${v1} afterRestore=${v2})`,
            );
          }
        } finally {
          if (needRestore) {
            await fetchJson(base, 'POST', '/config', {
              key: 'threshold',
              value: String(orig),
            });
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push('FAIL', 'Threshold config', msg);
    }

    // CHECK 14
    try {
      const url = joinUrl(base, '/');
      const res = await fetch(url, { method: 'GET' });
      const ct = res.headers.get('content-type') ?? '';
      if (
        res.status === 200 &&
        ct.toLowerCase().includes('text/html')
      ) {
        push('PASS', 'Dashboard', 'Dashboard: reachable');
      } else {
        push(
          'FAIL',
          'Dashboard',
          `GET / expected 200 + text/html, got ${res.status} content-type=${ct}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push('FAIL', 'Dashboard', msg);
    }

    // CHECK 15
    try {
      const r = await fetchJson(base, 'POST', '/report/send', {});
      const o = asRecord(r.json);
      const errStr =
        typeof o?.error === 'string' ? o.error : '';
      if (r.ok && o?.ok === true) {
        push(
          'PASS',
          'Telegram report',
          'Telegram configured and report sent',
        );
      } else if (
        errStr.includes('Telegram is not configured') ||
        errStr.includes('TELEGRAM_BOT_TOKEN')
      ) {
        push(
          'SKIP',
          'Telegram report',
          `${c.dim}Telegram not configured in .env${c.reset}`,
        );
      } else {
        push(
          'FAIL',
          'Telegram report',
          errStr || r.text.slice(0, 200) || `HTTP ${r.status}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push('FAIL', 'Telegram report', msg);
    }
  } else {
    push('SKIP', 'Circuit breaker config', 'Skipped — API unreachable');
    push('SKIP', 'Threshold config', 'Skipped — API unreachable');
    push('SKIP', 'Dashboard', 'Skipped — API unreachable');
    push('SKIP', 'Telegram report', 'Skipped — API unreachable');
  }

  // --- Report ---
  const pass = lines.filter((l) => l.verdict === 'PASS').length;
  const fail = lines.filter((l) => l.verdict === 'FAIL').length;
  const skip = lines.filter((l) => l.verdict === 'SKIP').length;

  console.log('');
  console.log('  FEATURE VERIFICATION REPORT');
  console.log('  ===========================');
  console.log('');
  for (const l of lines) {
    console.log(`  ${tag(l.verdict)} ${l.label}${l.detail ? ` — ${l.detail}` : ''}`);
  }
  console.log('');
  console.log(
    `  Total: ${c.pass}${pass} PASS${c.reset}, ${c.skip}${skip} SKIP${c.reset}, ${c.fail}${fail} FAIL${c.reset}`,
  );
  console.log('');

  const uniqueNotes = [...new Set(notVerified)];
  if (uniqueNotes.length > 0) {
    console.log('  Not verified (require further action):');
    for (const n of uniqueNotes) {
      console.log(`  - ${n}`);
    }
    console.log('');
  }

  process.exit(fail > 0 ? 1 : 0);
}

main();

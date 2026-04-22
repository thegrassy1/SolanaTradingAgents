# Solana Trading Agent — Claude Code Onboarding

## Project Overview

A Solana mean-reversion trading agent built on the Jupiter Ultra API. Supports paper and live trading modes. Runs 24/7 on a Ubuntu VPS managed by PM2. Controlled via OpenClaw chat integration (/trade commands) and a mobile-friendly web dashboard served by the agent itself.

## Architecture

- **Node.js/TypeScript agent** (`src/`) polls Jupiter Ultra API every 30 seconds (default) for SOL/USDC price
- **SQLite database** (`data/trades.db`) logs every trade; `mode` column distinguishes `paper` vs `live`
- **HTTP API on port 3456** (`src/api.ts`) — control plane for dashboard, OpenClaw, and direct curl commands
- **Position tracking** (`src/positions.ts`) with per-position stop loss, take profit, and trailing stop baked in at open time; open/closed positions persisted to `data/positions.json` and `data/closed-positions.json`
- **Risk manager** (`src/risk.ts`) enforces daily loss limit, max open positions, cooldown after loss, and circuit breaker
- **Runtime config** persisted to `data/runtime-config.json` so `/config` overrides survive `pm2 restart`
- **Paper trading engine** (`src/paper.ts`) uses real Jupiter quotes with a configurable fee model: taker bps haircut (`PAPER_TAKER_FEE_BPS`, default 10), base network fee (`PAPER_NETWORK_FEE_LAMPORTS`, default 5000), and priority fee (`PAPER_PRIORITY_FEE_LAMPORTS`, default 50_000) — SOL gas is debited from SOL balance on every swap. Virtual portfolio persisted to `data/paper-portfolio.json`
- **Dashboard HTML** served at `GET /` (`src/dashboard.ts`) — mobile-friendly, no external dependencies
- **Daily Telegram report** at 5 PM Central (`src/scheduler.ts`, `src/report.ts`, `src/telegram.ts`) — also triggerable via `POST /report/send`
- **OpenClaw skill** in `openclaw-skill/` handles `/trade` commands via chat; see `openclaw-skill/SKILL.md` for full command reference

## Key Files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — wires agent, API server, scheduler, and PM2 signal handlers |
| `src/agent.ts` | `TradingAgent` class — poll loop, mean-reversion signal, position open/close logic |
| `src/api.ts` | Native Node.js `http` HTTP API (manual if/else routing, no framework) — all REST endpoints, runtime config mutation, manual trade execution |
| `src/config.ts` | Loads all config from env vars with typed defaults |
| `src/dashboard.ts` | Generates the mobile web dashboard HTML served at `GET /` |
| `src/db.ts` | SQLite schema, `logTrade`, `logPrice`, `getRecentTrades`, `getTradeSummary` |
| `src/paper.ts` | `PaperTradingEngine` — virtual buy/sell, balance tracking, P&L, file persistence |
| `src/positions.ts` | `PositionManager` — open/close/evaluate positions, stop loss/TP/trailing stop logic |
| `src/price.ts` | `PriceMonitor` (SMA, volatility), `getQuote`, `calculatePrice` wrappers |
| `src/risk.ts` | `RiskManager` — circuit breaker, daily P&L, canOpenPosition, position sizing |
| `src/runtimeConfigPersist.ts` | Load/save `data/runtime-config.json`; `snapshotToPersistable` maps agent state to POST /config keys |
| `src/scheduler.ts` | node-cron scheduler for daily Telegram report |
| `src/report.ts` | Builds the daily report text from DB and agent state |
| `src/swap.ts` | Jupiter Ultra API `getOrder` (quote) and `executeOrder` (live swap) |
| `src/telegram.ts` | `sendTelegramMessage` — thin wrapper over Telegram Bot API |
| `src/tokenInfo.ts` | Static token registry (SOL, USDC, USDT) — decimals and symbols |
| `src/types.ts` | Shared TypeScript interfaces (`JupiterOrderResponse`, `JupiterExecuteResponse`, `TradeRecord`, etc.) |
| `src/wallet.ts` | Load Keypair from `PRIVATE_KEY` env var; sign versioned transactions |

## Deployment

- **VPS:** Ubuntu, IP `187.77.205.215`, user `root`
- **SSH alias:** `solana-vps` (configured in local `~/.ssh/config` — no password prompt)
- **Project path on VPS:** `~/apps/solana-trader`
- **Git remote:** `https://github.com/thegrassy1/SolanaTradingAgents.git`
- **PM2 process name:** `solana-trader`

**Deploy flow (single command):**
```bash
git push && ssh solana-vps "cd ~/apps/solana-trader && git pull && npm install && npm run build && pm2 restart solana-trader --update-env"
```

**Other common VPS commands:**
```bash
# Tail logs
ssh solana-vps "pm2 logs solana-trader --lines 50 --nostream"

# Check agent health
ssh solana-vps "curl -s http://127.0.0.1:3456/status"

# Query database
ssh solana-vps "sqlite3 ~/apps/solana-trader/data/trades.db 'SELECT ...'"
```

**Deployment gotcha — VPS tracks `main` only:** The VPS always pulls from `main`. Any work done on feature branches or worktree branches must be merged into `main` before `git pull` on the VPS will pick up the changes. Always verify the merge landed on `main` before declaring a deploy complete — run `git log --oneline main` locally to confirm the commit is there before triggering the VPS pull.

**OpenClaw:**
- Lives in Docker at `/docker/openclaw-fnwc/`
- Skill directory: `/docker/openclaw-fnwc/data/.openclaw/skills/solana-trader/`
- Workspace TOOLS.md: `/docker/openclaw-fnwc/data/.openclaw/workspace/TOOLS.md`
- Container reaches agent API at `http://172.20.0.1:3456`

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `MODE` | `paper` | Trading mode (`paper` or `live`) |
| `PRIVATE_KEY` | — | Base58 Solana wallet private key (required for live mode) |
| `JUPITER_API_URL` | `https://lite-api.jup.ag` | Jupiter Ultra API base URL |
| `JUPITER_API_KEY` | — | Optional API key sent as `x-api-key` header |
| `BASE_MINT` | SOL mint | Token to trade (base) |
| `QUOTE_MINT` | USDC mint | Quote currency |
| `TRADE_AMOUNT_LAMPORTS` | `10000000` (0.01 SOL) | Default trade size in lamports |
| `POLL_INTERVAL_MS` | `30000` | Price poll interval in milliseconds |
| `PAPER_INITIAL_SOL` | `10` | Starting SOL balance for paper mode |
| `PAPER_INITIAL_USDC` | `1000` | Starting USDC balance for paper mode |
| `API_PORT` | `3456` | HTTP API listen port |
| `API_HOST` | `0.0.0.0` | HTTP API bind address |
| `STOP_LOSS_PERCENT` | `0.03` | Stop loss as decimal (0.03 = 3%) |
| `TAKE_PROFIT_PERCENT` | `0.06` | Take profit as decimal |
| `TRAILING_STOP_PERCENT` | — | Trailing stop as decimal; set to `null` or omit to disable |
| `MAX_DAILY_LOSS_PERCENT` | `0.05` | Circuit breaker: max daily loss vs day-start NAV |
| `MAX_OPEN_POSITIONS` | `1` | Maximum concurrent open positions |
| `RISK_PER_TRADE_PERCENT` | `0.02` | Risk per trade for position sizing |
| `COOLDOWN_MINUTES` | `5` | Normal post-trade cooldown |
| `COOLDOWN_LOSS_MINUTES` | `30` | Post-loss cooldown |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token for daily reports |
| `TELEGRAM_CHAT_ID` | — | Telegram chat ID for daily reports |
| `REPORT_CRON` | `0 17 * * *` | Cron expression for daily report |
| `REPORT_TIMEZONE` | `America/Chicago` | Timezone for report scheduler |

## Common Diagnostic Queries

```bash
# Connect
sqlite3 ~/apps/solana-trader/data/trades.db

# Recent trades (last 20)
SELECT timestamp, mode, status, exit_reason,
       CAST(input_amount AS REAL)/1e6 AS usdc_in,
       CAST(output_amount AS REAL)/1e9 AS sol_out
FROM trades ORDER BY id DESC LIMIT 20;

# Exit reasons since a cutoff
SELECT exit_reason, COUNT(*) AS cnt
FROM trades
WHERE timestamp > '2026-04-01'
GROUP BY exit_reason ORDER BY cnt DESC;

# Open positions count
SELECT COUNT(*) FROM trades WHERE status='open';

# Closed positions by exit reason
SELECT exit_reason, COUNT(*) AS cnt,
       ROUND(SUM(CAST(realized_pnl_quote AS REAL)/1e6), 2) AS total_pnl_usdc
FROM trades
WHERE status='closed'
GROUP BY exit_reason ORDER BY cnt DESC;

# Trade counts by mode
SELECT mode, status, COUNT(*) AS cnt
FROM trades GROUP BY mode, status;

# Realized P&L for closed paper trades today
SELECT SUM(CAST(realized_pnl_quote AS REAL)/1e6) AS pnl_usdc
FROM trades
WHERE mode='paper' AND status='closed'
  AND date(timestamp) = date('now');
```

## HTTP API Endpoints

All endpoints at `http://172.20.0.1:3456` (from Docker/OpenClaw) or `http://localhost:3456` (from VPS).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness: `{ ok, uptime, mode, running }` |
| `GET` | `/` | Mobile web dashboard HTML |
| `GET` | `/dashboard` | Alias for `/` |
| `GET` | `/status` | Full status: mode, price, SMA, volatility, cooldown, balances, P&L, risk, open positions |
| `GET` | `/quote` | Jupiter quote (no execution). Params: `inputMint`, `outputMint`, `amount` (raw units) |
| `POST` | `/trade` | Execute swap. Body: `{ direction, amount, [inputMint], [outputMint] }` |
| `GET` | `/history` | Recent trades from DB. Params: `limit` (max 500), `mode` |
| `GET` | `/pnl` | Paper engine P&L: `currentValue`, `initialValue`, `pnl`, `pnlPercent` |
| `POST` | `/mode` | Switch mode. Body: `{ mode: "paper" \| "live" }` |
| `POST` | `/config` | Update runtime setting. Body: `{ key, value }`. See keys below. |
| `GET` | `/positions` | Open positions with unrealized P&L |
| `POST` | `/positions/close` | Close position(s). Body: `{ positionId }` or `{ all: true }`, optional `reason` |
| `GET` | `/positions/closed` | Recently closed positions with realized P&L and exit reason. Param: `limit` |
| `GET` | `/risk` | Risk config + circuit breaker state + daily P&L |
| `POST` | `/reset` | Reset paper portfolio to initial balances (destructive) |
| `POST` | `/report/send` | Manually send the daily Telegram report |

**POST /config keys:** `trade_amount`, `trade_amount_lamports`, `threshold`, `cooldown`, `cooldown_minutes`, `stop_loss`, `take_profit`, `trailing_stop` (`null` to disable), `max_daily_loss`, `max_open_positions`, `risk_per_trade`, `cooldown_loss_minutes`

## Known Issues and History

- **Mean-reversion exit bug (fixed):** Originally the agent could exit via a `mean_reversion_sell` path before `stop_loss`/`take_profit` had a chance to trigger. Fixed by running risk exits first on every tick when a position is open, and removing the strategy-flip exit path entirely.
- **Runtime config persistence (added):** `/config` changes now write to `data/runtime-config.json` and reload on startup, so overrides survive `pm2 restart`.
- **SL/TP baked in at open:** `stopLossPrice` and `takeProfitPrice` are calculated and stored when a position opens. Changing `stop_loss`/`take_profit` via `/config` only affects new positions — existing positions keep their original prices.

## Paper Trading Behavior

- Uses real Jupiter quotes for both entry and exit pricing
- Applies a 0.1% slippage haircut on fill amounts
- Virtual balances stored as `bigint` for precision (no floating-point drift)
- Portfolio state (balances) persisted to `data/paper-portfolio.json` across restarts
- Paper trades log to the `trades` table with `mode='paper'`

## Running the Verify Script

```bash
npm run verify
```

Connects to the running agent at `http://127.0.0.1:3456` and reads `data/trades.db`. Checks all risk features end to end (stop loss, take profit, trailing stop, circuit breaker, cooldown). See `scripts/verify-features.ts`.

## Data Available for Analysis

### SQLite: `data/trades.db`

Two tables. Connect with: `sqlite3 ~/apps/solana-trader/data/trades.db`

**`trades`** — one row per swap execution (both entries and exits):

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `timestamp` | TEXT | ISO-8601, UTC, default `datetime('now')` |
| `mode` | TEXT | `paper` or `live` |
| `input_mint` | TEXT | Token mint address being sold |
| `output_mint` | TEXT | Token mint address being bought |
| `input_amount` | TEXT | Raw amount of input token (bigint as string) |
| `output_amount` | TEXT | Raw amount of output token received |
| `expected_output` | TEXT | Quote's expected output before execution |
| `price_impact` | TEXT | Jupiter price impact (string) |
| `slippage_bps` | INTEGER | Slippage in basis points |
| `tx_signature` | TEXT | On-chain signature (null for paper) |
| `status` | TEXT | `paper_filled`, `success`, or `failed` |
| `error_message` | TEXT | Populated on failure |
| `strategy` | TEXT | `mean_reversion_v1` or `manual` |
| `price_at_trade` | REAL | SOL/USDC spot price at execution |
| `entry_price` | REAL | Entry price of position (populated on close rows) |
| `exit_price` | REAL | Exit price of position (populated on close rows) |
| `exit_reason` | TEXT | `stop_loss`, `take_profit`, `trailing_stop`, `manual`, `manual_api` — NULL on entry rows |
| `realized_pnl` | REAL | P&L in USDC; NULL on entry rows |

Entry rows: `exit_reason IS NULL`. Close rows: `exit_reason IS NOT NULL`.

**`price_snapshots`** — one row per poll tick (every 30s):

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `timestamp` | TEXT | ISO-8601, UTC |
| `input_mint` | TEXT | Base token (SOL) |
| `output_mint` | TEXT | Quote token (USDC) |
| `price` | REAL | SOL/USDC price |
| `sma_20` | REAL | 20-sample moving average |
| `volatility` | REAL | Rolling volatility (decimal, e.g. 0.0003) |

16,000+ rows from 2026-04-15 onward. Good for backtesting signal quality.

---

### JSON State Files: `data/`

**`paper-portfolio.json`** — paper engine live state:
- `balances`: raw bigint balances per mint
- `tradeHistory`: array of all paper swaps
- `startTime`: when the portfolio was last reset
- `initialBalancesSmallest`: balances at reset
- `initialQuoteValue`: USDC NAV at reset (used as P&L baseline)

**`positions.json`** — currently open positions (array, usually 0–1 entries):
- `id`, `mint`, `entryPrice`, `entryTime`, `amount` (bigint)
- `stopLossPrice`, `takeProfitPrice`, `trailingStopPercent`, `highWaterMark`
- `strategy`, `mode`

**`closed-positions.json`** — all historical closed positions (grows unbounded):
- Same fields as open positions plus `exitPrice`, `exitTime`, `exitReason`, `realizedPnlQuote`
- The only source of `entryTime`+`exitTime` together — use this for hold-time analysis

**`runtime-config.json`** — persisted runtime overrides applied via `POST /config`:
- Keys match POST /config key names (`stop_loss`, `take_profit`, `threshold`, etc.)
- Loaded at startup; survives `pm2 restart`

---

### PM2 Logs: `~/.pm2/logs/`

- **`solana-trader-out.log`** — structured operational log:
  - `[PRICE]` — every tick: timestamp, price, sma20, devFromSma%, vol%
  - `[AGENT]` — every tick (when warmed up): price, sma, dev%, vol%, entrySignal
  - `[AGENT] Cooling down (entries), Xs remaining` — post-trade cooldown
  - `[AGENT] Entry blocked: <reason>` — risk gate rejected an entry
  - `[PAPER-SWAP]` — paper trade execution details
  - `[POSITION-OPEN]`, `[POSITION-CLOSE]`, `[POSITION-HOLD]` — position lifecycle
  - `[API]` — HTTP request log (method, path, status, duration)
  - `[SCHEDULER]` — daily report trigger

- **`solana-trader-error.log`** — exceptions and unhandled rejections only; should be 0 bytes in healthy operation

---

### Common Analysis Queries

```bash
# Exit reason distribution with P&L
sqlite3 ~/apps/solana-trader/data/trades.db "
SELECT exit_reason,
       COUNT(*) AS trades,
       ROUND(AVG(realized_pnl), 4) AS avg_pnl,
       ROUND(SUM(realized_pnl), 4) AS total_pnl
FROM trades
WHERE exit_reason IS NOT NULL AND exit_reason != ''
GROUP BY exit_reason ORDER BY trades DESC;"

# Daily realized P&L
sqlite3 ~/apps/solana-trader/data/trades.db "
SELECT date(timestamp) AS day,
       COUNT(*) AS closes,
       ROUND(SUM(realized_pnl), 4) AS daily_pnl
FROM trades
WHERE exit_reason IS NOT NULL AND exit_reason != ''
GROUP BY date(timestamp) ORDER BY day;"

# Win rate (closes with non-zero P&L)
sqlite3 ~/apps/solana-trader/data/trades.db "
SELECT COUNT(*) AS total,
       SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
       ROUND(100.0 * SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS win_pct
FROM trades
WHERE exit_reason IS NOT NULL AND exit_reason != ''
  AND realized_pnl IS NOT NULL AND realized_pnl != 0;"

# Hold time by exit reason (uses closed-positions.json — run in Python)
# python3 -c "
# import json
# from datetime import datetime
# data = json.load(open('data/closed-positions.json'))
# from collections import defaultdict
# by_reason = defaultdict(list)
# for p in data:
#     et = datetime.fromisoformat(p['entryTime'].replace('Z','+00:00'))
#     xt = datetime.fromisoformat(p['exitTime'].replace('Z','+00:00'))
#     by_reason[p['exitReason']].append((xt-et).total_seconds()/60)
# for r, times in sorted(by_reason.items()):
#     print(f'{r}: avg={sum(times)/len(times):.1f}min n={len(times)}')
# "

# Position size history
sqlite3 ~/apps/solana-trader/data/trades.db "
SELECT date(timestamp) AS day,
       ROUND(CAST(input_amount AS REAL)/1e6, 2) AS usdc_spent,
       price_at_trade
FROM trades
WHERE input_mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  AND (exit_reason IS NULL OR exit_reason = '')
ORDER BY id DESC LIMIT 20;"

# Check for rogue mean_reversion_sell exits (should always return 0)
sqlite3 ~/apps/solana-trader/data/trades.db "
SELECT COUNT(*) AS bad_exits FROM trades WHERE exit_reason = 'mean_reversion_sell';"
```

## How I Want You To Work

- **Before changing anything**, query the running system (`GET /status`, `GET /risk`, `GET /positions`) or read the database to confirm the hypothesis
- Prefer small commits with clear messages
- Always run `npx tsc --noEmit` before pushing
- When debugging on the VPS, SSH in to read logs and state — do not edit files on the VPS directly; deploy only via git
- The user is non-technical; explain tradeoffs clearly before making any non-trivial change
- **Never change MODE to live** without explicit confirmation in the same session
- **Never modify trading strategy parameters** (thresholds, SL/TP defaults, position sizing) without asking first

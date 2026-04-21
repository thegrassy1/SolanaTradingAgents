# Solana Trading Agent

You have access to a Solana trading agent running on the user’s machine (or VPS). The HTTP API binds to **0.0.0.0** by default (`API_HOST` in `.env`; port `API_PORT`, default **3456**) so other processes (e.g. OpenClaw in Docker) can reach it on the host network. From the **same host** as the agent, use **http://172.20.0.1:3456** (or `http://localhost:3456`). From a **Docker container** on the same machine, use the host gateway (often **http://host.docker.internal:3456** on Docker Desktop) or the host’s LAN IP—**not** `127.0.0.1` inside the container (that is the container itself). The VPS firewall should still block public access to port 3456 if only local/bridge access is intended.

Assume the agent process is already running (`npm start` or equivalent). If a request fails with connection refused, tell the user to start the agent first and verify `API_HOST` / `API_PORT` and Docker networking.

The agent also serves a **web dashboard** at **GET /** — point the user to `http://<host>:3456/` on the same network (same host/port as the API) to open it in a browser.

## When to use this skill

Use this skill when the user mentions trading, crypto, Solana, Jupiter, their portfolio, paper trading, live trading, or uses commands like `/trade`, `/trader`, or asks for status, quotes, P&L, or trade history for this agent.

## Fees & net P&L (important)

Every paper swap now models three kinds of cost, so dashboards and reports should always surface **net** P&L, not gross:

1. **Taker fee** — a bps haircut on the Jupiter-quoted output (configurable via `PAPER_TAKER_FEE_BPS`, default 10 bps). Reflected directly in `outputAmount`.
2. **Base network fee** — `PAPER_NETWORK_FEE_LAMPORTS` (default 5000) debited from the SOL balance on every swap.
3. **Priority / compute-unit fee** — `PAPER_PRIORITY_FEE_LAMPORTS` (default 50_000) debited from the SOL balance on every swap.

Every `TradeRecord` now carries the fee breakdown:

- `takerFeeBps`, `takerFeeQuote` — taker fee bps applied and its USDC value.
- `networkFeeLamports`, `priorityFeeLamports`, `solFeeQuote` — SOL-side fees paid for this leg (total SOL fee in USDC).
- `feesQuote` — total cost of this trade leg in quote currency.
- `realizedPnlGross` — legacy mark-to-market P&L, `(exit - entry) * size`.
- `realizedPnlNet` — **true realized P&L from actual balance flows**: `(exitQuoteAmount - entryQuoteAmount) - entryFees - exitFees`. Present only for positions opened after the fee-aware refactor.
- `realizedPnl` — alias of `realizedPnlGross`, kept for backward compatibility.

**Reporting rule of thumb:** when summarising P&L (daily, per-trade, or per-position) always **prefer `realizedPnlNet` / `dailyRealizedPnLNet` / `unrealizedPnlNet`** when they're non-null; fall back to the gross field only for legacy rows. When both are known and differ, it's fine to mention gross parenthetically (e.g. `"+$4.94 net (gross +$5.05, fees $0.11)"`).

## Available endpoints

Base URL (on the agent host): `http://172.20.0.1:3456` — adjust host/port if the user’s setup uses Docker or a remote host.

Default mints (from the agent’s env): **SOL** `So11111111111111111111111111111111111111112`, **USDC** `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

### GET /health

Liveness: `{ ok, uptime (seconds), mode, running }`.

```bash
curl -s http://172.20.0.1:3456/health
```

### GET /status

Full agent status: mode, running, latest price, SMA, volatility, cooldown, paper portfolio balances and P&L, recent trades, trade summary, uptime, **risk** snapshot, **dailyRealizedPnL** (gross), **dailyRealizedPnLNet** (net of fees — prefer this), **dailyStartingValueQuote**, **openPositionsCount**.

```bash
curl -s http://172.20.0.1:3456/status
```

### GET /quote

Quote-only Jupiter order (no taker). Query parameters: **inputMint**, **outputMint**, **amount** (amount in the smallest unit of the input token, e.g. lamports for SOL, micro-USDC for USDC).

Response JSON: `inputMint`, `outputMint`, `inAmount`, `outAmount`, `priceImpact`, `slippageBps`.

Example (quote 0.01 SOL → USDC, amount = 10_000_000 lamports):

```bash
curl -s "http://172.20.0.1:3456/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=10000000"
```

### POST /trade

Execute one swap in the agent’s **current** mode (paper or live).

Manual trades use the **same risk layer as the auto strategy** (daily realized P&L vs day-start NAV / circuit breaker, `max_open_positions`, post-trade cooldown). The **only** difference from auto entries is that manual trades **ignore** the mean-reversion signal threshold—the user is explicitly requesting the trade.

- **Buy:** `riskManager.canOpenPosition()` runs before the swap. On block, the API returns **400** with `errorMessage` explaining why (including *“Cannot open position: max open positions (N) reached…”* when at capacity). On success, the agent opens a **tracked position** on the token received (default SOL) with stop loss, take profit, and trailing stop from the current risk config (`strategy: "manual"`).
- **Sell:** If an open position exists for the **input** mint, the sell is treated as **closing** that position: swap (capped to position size), `closePosition` with `exitReason: "manual"`, realized P&L and cooldown updates. If there is **no** tracked position, the swap still runs (discretionary) and the agent logs a warning.

Body JSON:

- `direction`: `"buy"` or `"sell"` (default pair: buy = spend USDC for SOL; sell = sell SOL for USDC).
- `amount`: number in **human** units of the **input** token (e.g. `100` = 100 USDC for a default buy, `0.5` = 0.5 SOL for a default sell).
- Optional `inputMint`, `outputMint` to override the pair; `amount` is then human units of `inputMint`.

Success: HTTP **200** and a `TradeRecord` JSON (status `paper_filled` or `success`). Failure: HTTP **400** (or **500**) and JSON may include `error` on server faults; failed trades may still return a `TradeRecord` with `status: "failed"`.

```bash
curl -s -X POST http://172.20.0.1:3456/trade -H "Content-Type: application/json" -d "{\"direction\":\"buy\",\"amount\":50}"
```

```bash
curl -s -X POST http://172.20.0.1:3456/trade -H "Content-Type: application/json" -d "{\"direction\":\"sell\",\"amount\":0.25}"
```

### GET /history

Recent rows from SQLite `trades`. Query: **limit** (default 20, max 500), optional **mode** `paper` or `live`.

```bash
curl -s "http://172.20.0.1:3456/history?limit=10&mode=paper"
```

### GET /pnl

Paper engine P&L vs quote mint (USDC): `currentValue`, `initialValue`, `pnl`, `pnlPercent`.

```bash
curl -s http://172.20.0.1:3456/pnl
```

### POST /mode

Switch trading mode. Body: `{ "mode": "paper" | "live" }`. Switching to **live** without a configured wallet returns **400**.

```bash
curl -s -X POST http://172.20.0.1:3456/mode -H "Content-Type: application/json" -d "{\"mode\":\"paper\"}"
```

### POST /config

Update runtime settings. Body: `{ "key": "...", "value": "..." }`. Cannot set `mode` here (use POST /mode).

**General / strategy:** `trade_amount` / `trade_amount_lamports`, `threshold` (mean-reversion percent), `cooldown` / `cooldown_minutes` (normal cooldown minutes).

**Risk (percents as decimals, e.g. `0.03` = 3%):** `stop_loss`, `take_profit`, `trailing_stop` (use string `null` to disable), `max_daily_loss`, `max_open_positions` (integer), `risk_per_trade`, `cooldown_loss_minutes` (longer cooldown after a losing exit).

> The paper fee model (`PAPER_TAKER_FEE_BPS`, `PAPER_NETWORK_FEE_LAMPORTS`, `PAPER_PRIORITY_FEE_LAMPORTS`) is configured via environment variables and applied on every paper swap. It is **not** hot-editable via `/config` today — changing it requires restarting the agent.

```bash
curl -s -X POST http://172.20.0.1:3456/config -H "Content-Type: application/json" -d "{\"key\":\"threshold\",\"value\":\"3\"}"
```

```bash
curl -s -X POST http://172.20.0.1:3456/config -H "Content-Type: application/json" -d "{\"key\":\"stop_loss\",\"value\":\"0.03\"}"
```

### GET /positions

Open SOL positions (risk layer). Each row carries:

- `unrealizedPnlQuote` / `unrealizedPnlGross` — mark-to-market gross.
- `unrealizedPnlNet` — projected exit P&L net of estimated close-side fees (taker + SOL network). Prefer this for summaries.
- `entryQuoteAmount` — USDC actually spent to open the position (null for legacy positions).
- `entryFeesQuote` — entry-leg fees in USDC (null for legacy).

Totals: `unrealizedPnLTotal` (gross) and `unrealizedPnLTotalNet`.

```bash
curl -s http://172.20.0.1:3456/positions
```

### POST /positions/close

Close one open position by id, or **all** open positions. Each close runs a SOL→USDC exit (v1), updates realized P&L and cooldown like other exits. Body JSON:

- `positionId` (string): close that position.
- `all` (boolean `true`): close every open position (snapshot at request time).
- Optional `reason` (string): passed through to the agent (default `manual_api`).

Response: `{ "trades": [ ...TradeRecord ] }` (one entry per close). Errors (e.g. unknown `positionId`) return **400** with `{ "error": "..." }`.

```bash
curl -s -X POST http://172.20.0.1:3456/positions/close -H "Content-Type: application/json" -d "{\"all\":true}"
```

```bash
curl -s -X POST http://172.20.0.1:3456/positions/close -H "Content-Type: application/json" -d "{\"positionId\":\"<uuid>\",\"reason\":\"manual\"}"
```

### GET /positions/closed

Recently closed positions. Query: **limit** (default 20, max 500). Each row carries:

- `realizedPnlQuote` / `realizedPnlGross` — legacy gross P&L.
- `realizedPnlNet` — true net P&L from balance flows (null for positions opened before the fee-aware refactor).
- `feesQuote` — total round-trip fees in USDC.
- `entryQuoteAmount`, `exitQuoteAmount` — actual USDC flows on entry / exit (human units).
- `entryFeesQuote`, `exitFeesQuote` — per-leg fees in USDC.
- `exitReason`, `strategy`, `mode`, `entryPrice`, `exitPrice`, `entryTime`, `exitTime`, `amount`.

```bash
curl -s "http://172.20.0.1:3456/positions/closed?limit=15"
```

### GET /risk

Current risk parameters and daily state:

- `dailyRealizedPnL` — gross daily realized P&L (legacy).
- `dailyRealizedPnLNet` — net daily realized P&L (prefer this).
- `dailyStartingValueQuote` — day-start NAV baseline.
- `lastTradeResult`, `openPositions`, `utcDay`.
- `paperFees: { takerFeeBps, networkFeeLamports, priorityFeeLamports }` — the active paper fee model.
- All risk limits (`stopLossPercent`, `takeProfitPercent`, `trailingStopPercent`, `maxDailyLossPercent`, `maxOpenPositions`, `riskPerTradePercent`).

```bash
curl -s http://172.20.0.1:3456/risk
```

### POST /reset

Reset the **paper** portfolio to initial balances. Response: `{ message, balances }`.

```bash
curl -s -X POST http://172.20.0.1:3456/reset
```

### POST /report/send

Manually build the daily Telegram report (same content as the scheduled job) and send it via the bot. Requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the agent’s environment. Success: **200** `{ "ok": true, "message": "Report sent" }`. Failure (e.g. missing token, Telegram error): **500** `{ "error": "..." }`.

```bash
curl -s -X POST http://172.20.0.1:3456/report/send
```

## How to respond

- When the user says **/trade status** or asks how the agent is doing, call **GET /status** and summarize: mode, running, price/SMA/volatility/cooldown, balances, P&L, open position count, daily P&L vs baseline, and key risk limits if useful.
- **/trade positions** → **GET /positions** (open positions and unrealized P&L).
- **/trade closed** → **GET /positions/closed** (recent exits with reasons and realized P&L).
- **/trade close** → **POST /positions/close** with `{ "all": true }` (close every open position).
- **/trade close** with a position id (e.g. from GET /positions) → **POST /positions/close** with `{ "positionId": "<uuid>" }` (optional `"reason"`).
- **/trade risk** → **GET /risk** (risk config + circuit breaker state).
- **/trade set stop_loss 0.03** (and similar) → **POST /config** with `{ "key": "stop_loss", "value": "0.03" }` (same pattern for `take_profit`, `trailing_stop`, `max_daily_loss`, `max_open_positions`, `risk_per_trade`, `cooldown_loss_minutes`, `cooldown`).
- When they say **/trade buy** or want to buy SOL with USDC: first **GET /quote** with USDC as input, SOL as output, and an amount in **USDC smallest units** (human USDC × 10^6) so they see the quote; confirm they understand the amounts, then after they confirm, **POST /trade** with `{ "direction": "buy", "amount": <USDC human> }`. Warn that **live** mode spends real funds.
- When they say **/trade sell** or want to sell SOL: quote with SOL as input, USDC as output, amount in **lamports** (human SOL × 10^9) for GET /quote; then **POST /trade** with `{ "direction": "sell", "amount": <SOL human> }` after confirmation.
- **/trade pnl** → **GET /pnl**; summarize dollar P&L and percent.
- **/trade history** → **GET /history** with a reasonable limit; summarize the latest trades (side, approximate size, status).
- **/trade mode paper** or **live** → **POST /mode**; if they want **live**, warn clearly first; if the API returns 400 about the wallet, explain they must set `PRIVATE_KEY` and restart.
- For **/trade config** or changing thresholds, use **GET /status** or describe current config from context if you have it, and **POST /config** for updates.
- For **/trade reset**, call **POST /reset** only after explicit user confirmation (destructive to paper state).
- **/trade report** → **POST /report/send** to manually trigger the Telegram daily report (for testing or on-demand summaries).
- If the user’s command does not map to an endpoint, list the supported commands briefly.

## Response formatting

- Prices in USDC: **2** decimal places.
- SOL amounts: **4** decimal places.
- Percentages: **2** decimal places.
- Use **plain text** (no markdown) in the chat reply for readability.
- Keep answers concise unless the user asks for detail.

# FEATURES.md — Trading System Improvement Roadmap

> Living to-do list. Goal: turn a beautifully-engineered system optimizing
> strategies-with-unproven-edge into a system that actually makes money.
> Phases are ordered by expected impact / dollar of dev effort.

---

## North Star

**Profit, not features.** Every item below should end with a measurable answer
to: "Did this make us more money in backtest, then in paper, then in live?"

If we can't measure it, we don't ship it.

---

## Phase 1 · Backtester + Historical Data ✅ COMPLETE

The single highest-leverage change. Without this, every other improvement on
this list is guesswork. With it, ideas can be validated in seconds instead of
days of forward-testing on live capital.

### 1.1 — Historical data pipeline (multi-source, on-chain capable)

We were going to backtest on our own 16k price snapshots (3 weeks of ranging
market only). That's overfitting bait. We need:

- [ ] **Birdeye API** integration — primary source
  - Free tier: 30 req/min, 100k req/month
  - Multi-year OHLCV for all our universe symbols (SOL, JUP, JTO, BONK, WIF)
  - Resolutions: 1m, 5m, 15m, 1h, 4h, 1d
  - Has volume (we don't currently track this)
  - Endpoint: `https://public-api.birdeye.so/defi/history_price`
- [ ] **CoinGecko** integration — fallback / cross-validation
  - Most reliable historical data, longest history
  - Free tier: 30 req/min
  - Daily/hourly OHLCV
- [ ] **Drift API** integration — funding-rate history
  - For backtesting funding-carry strategies
  - Endpoint: `https://dlob.drift.trade/funding-rates/<market>`
- [ ] **Pyth historical archive** — oracle prices at sub-second resolution
  - Optional, only if we need microstructure precision
- [ ] **Our DB sanity check** — verify recent external data matches our
  recorded `price_snapshots` to detect feed problems

**Cache strategy:** download once, store in `data/historical.db` (separate
SQLite file). Re-fetch only deltas. Don't hammer external APIs on every
backtest run.

**Deliverable:** `src/historical/` module with:
- `BirdeyeClient`, `CoingeckoClient`, `DriftClient`
- `HistoricalDb` — local cache
- `getHistoricalBars(symbol, resolution, start, end)` — unified interface
- Script `npm run hist:fetch -- --symbol SOL --from 2024-01-01 --to 2026-04-29`

### 1.2 — Deterministic backtest engine

- [ ] `src/backtest/engine.ts` — replay loop
  - Iterates historical bars at chosen resolution
  - Maintains a virtual `MultiSymbolMonitor`-shaped state
  - Drives each strategy's `evaluate()` exactly as the live agent does
  - Routes signals through a virtual position manager + perp engine
- [ ] **Realistic fee + slippage model**
  - Apply `paperTakerFeeBps`, `paperNetworkFeeLamports`, etc. (already exists)
  - Model slippage as a function of bar volume (bigger trades, more slip)
  - Funding accrual for perps (using real Drift historical funding rates)
- [ ] **Time-correct evaluation**
  - At bar `t`, strategies see only bars `<= t` (no lookahead bias)
  - Stops/TPs evaluated against `bar.high`/`bar.low`, not just `close`
- [ ] CLI: `npm run backtest -- --strategy mean_reversion_v1 --symbol SOL --from 2025-01-01 --threshold 1.5`

### 1.3 — Metrics & reporting

For every backtest, compute:
- [ ] Realized P&L (gross + net of fees)
- [ ] Sharpe ratio (annualized)
- [ ] Sortino ratio
- [ ] Max drawdown + drawdown duration
- [ ] Win rate, avg win, avg loss, expectancy, profit factor
- [ ] Hold-time distribution (median, p25, p75)
- [ ] Per-month and per-regime breakdown (so we can see "this strategy works
      in trending markets, dies in ranging")
- [ ] Trade-by-trade ledger (CSV export)

**Output:** HTML report with equity curve, drawdown chart, monthly heatmap.
Generated at `data/backtest-reports/<strategy>-<symbol>-<timestamp>.html`.

### 1.4 — Parameter sweep / optimization

- [ ] `npm run sweep -- --strategy mean_reversion_v1 --param threshold --range 0.5,5,0.25`
- [ ] Outputs: heatmap of returns + Sharpe per parameter combo
- [ ] Walk-forward validation: split history 70/30, optimize on first half,
      validate on second. Reports out-of-sample metrics.

**Acceptance for Phase 1:** can answer in <60 seconds:
1. "What's mean_reversion_v1's Sharpe over the last 12 months on SOL?"
2. "Which threshold value would have produced the highest out-of-sample profit?"
3. "Does buy_and_hold beat mean_reversion + breakout combined?"

---

## Phase 2 · Smarter Exits

Our current static 3% SL / 6% TP leaves money on the table. Avg win $1.93 vs
avg loss $1.56 is fine, but the win/loss ratio is small because we cut winners
early. Concrete improvements:

- [ ] **ATR-based stops** — `slPrice = entry - 2 × ATR(14)`
  - Wider stops in high vol, tighter in low vol
  - Pulls SL/TP from market behavior instead of fixed config
- [ ] **Scale-out exits**
  - Sell ⅓ at +3% (lock in)
  - Sell ⅓ at +6% (current TP)
  - Trail final ⅓ on a 2× ATR trailing stop
- [ ] **Breakeven move** — once price reaches +1.5%, ratchet SL to entry
  - Eliminates the gut-punch trades that briefly turned profitable then reversed
- [ ] **Per-strategy exit policies** — RUSH (breakout) wants different exits
  than STATIC (mean reversion). Let strategies declare their preferred policy.

**Validate via Phase 1 backtester before shipping live.**

---

## Phase 3 · ORACLE: Filter → Generator

Currently Haiku is a $0.001/call rubber stamp on signals our quant strategies
already produced. Underwhelming. Real value:

- [ ] **Feed Haiku context beyond market data:**
  - Recent news headlines (NewsAPI free tier, or direct CoinDesk RSS)
  - On-chain whale movements (Solscan API for top-100 wallet net flows)
  - Twitter/X mentions of universe symbols (xAI Grok API or Twitter's free tier)
  - Drift funding-rate momentum
- [ ] **`ORACLE-GEN` strategy** — proposes signals the quant strategies missed
  - "JUP up 3% in 1h, social volume spiked 5×, sentiment positive → suggest LONG"
  - Returns same `StrategySignal` shape; agent treats it like any other strategy
- [ ] **Confidence-weighted sizing** — high-confidence Haiku signals get
  larger position sizes than 65%-confidence ones
- [ ] **Cost guardrails** — max 50 Haiku calls/day, fall back to existing
  filter mode if budget exhausted

This plays to LLM strengths (synthesis, context, multi-source reasoning)
instead of weaknesses (precise math).

---

## Phase 4 · Funding-Rate Carry (Real Money Strategy)

This is **the strategy most likely to actually pay rent.** Mechanical edge
that exists right now and isn't arbed away because it requires capital
+ infrastructure most retail doesn't have.

- [ ] **Drift funding-rate monitor**
  - Poll funding rates for SOL/BTC/ETH perps every 5min
  - When SOL perp funding > 50 bps/8h sustained, the trade is on:
    - Short SOL perp on Drift (collect funding)
    - Long SOL spot on Jupiter (hedge directional risk)
  - Net: market-neutral, collect ~0.5% / 8h while signal persists
- [ ] **`FUNDING-CARRY` strategy** — new persona, e.g. "TIDE — The Harvester"
  - Special: only fires when funding signal is hot, ignores price/SMA
  - Auto-unwinds when funding normalizes
- [ ] **Backtest first** using Drift's historical funding API (Phase 1.1.3)
- [ ] Requires **Phase 6** (Drift live integration) before going live

**Realistic ROI:** 8-25% APR on capital deployed during signal periods, plus
small directional drift. Probably the most-likely-to-be-profitable strategy
we can build.

---

## Phase 5 · Quality Metrics Dashboard

Right now we track P&L. We don't track *why* trades win or lose. Add:

- [ ] **Sharpe per (strategy, symbol)** — see "STATIC works on SOL, dies on BONK"
- [ ] **Win rate by hour-of-day** — schedule strategies to their best windows
- [ ] **Hold-time distribution** — are short-hold winners or long-hold winners
      generating P&L?
- [ ] **Rolling max drawdown chart** (30d window)
- [ ] **Realized vs expected slippage** — did we get the price we expected?
- [ ] **Per-strategy equity curve** on the dashboard, not just totals

**Output goes in dashboard's `Details` panel** to keep main view clean.

---

## Phase 6 · Live Drift Integration

Required for Phase 4 to go live. **Don't do this until Phase 4 strategy is
validated in paper.**

- [ ] `@drift-labs/sdk` integration
- [ ] USDC collateral deposit/withdraw flow
- [ ] Sub-account architecture
- [ ] Real Pyth oracle price subscription (not Jupiter quotes)
- [ ] Real funding-rate accrual (replaces our simulated model)
- [ ] Real liquidation handling (much stricter than paper)
- [ ] Comprehensive integration tests on devnet first
- [ ] **Mandatory: paper-trade VOID + funding-carry strategies for ≥1 month
  with positive expectancy before going live**

---

## Phase 7 · Universe Optimization

Once Phase 1 backtester exists, **let the data pick the universe.**

- [ ] Backtest each current symbol (SOL, JUP, JTO, BONK, WIF) over 12 months
- [ ] Drop symbols where no strategy clears Sharpe > 0.5 net of fees
- [ ] Add candidate symbols and retest:
  - PYTH, RAY, ORCA (defi blue chips)
  - W (Wormhole), JTO (Jito governance)
  - PNUT, GOAT (high-vol memes — but only if strategies adapt)
  - RENDER (AI sector for diversification)
- [ ] **Sector concentration rule:** max 40% of universe in any one sector
  to keep portfolio risk gates meaningful

---

## Phase 8 · Multi-Timeframe Context

Currently strategies see only 30-second bars + 20-bar SMA. Trends visible at
1h are invisible to our agents.

- [ ] Compute SMAs at 5m / 15m / 1h / 4h in addition to current 30s rolling
- [ ] Pass multi-timeframe context to strategies via `StrategyContext`
- [ ] **Trend filter:** breakout strategies only fire when 1h trend agrees
- [ ] **Mean-reversion filter:** only enter against 30s noise *with* the 1h trend

---

## Phase 9 · Statistical Arbitrage on Correlated Pairs

When directional strategies fail (chop), spread strategies often work.

- [ ] **JTO vs JitoSOL ratio** — they should track but periodically diverge
- [ ] **JUP vs basket-of-DEFI** — buy when JUP underperforms its sector, sell
  when it leads
- [ ] **SOL/BTC ratio** — Solana ecosystem altcoins follow SOL/BTC strength
- [ ] **Z-score entries:** enter when ratio is >2σ from 30d mean

Requires Phase 8 (multi-timeframe) and Phase 1 (backtester) first.

---

## Phase 10 · Adaptive Risk Sizing

Current 2% risk per trade is rigid. Better:

- [ ] **Kelly-fraction-lite:** size = base_risk × (1 + recent_sharpe × k)
- [ ] **Confidence-scaling:** AI-approved trades get 1.2×, regime-aligned
  trades get 1.5×, against-regime get 0.5×
- [ ] **Drawdown-aware:** halve size during 5%+ drawdowns, restore on recovery
- [ ] **Per-strategy multipliers** already exist; expand the dynamic-rebalance
  logic to use Phase 5 metrics

---

## Backlog (Lower Priority)

- [ ] **MEV-aware execution** — use Jito bundles for live spot trades
- [ ] **Limit orders** instead of market quotes for entries (better fills)
- [ ] **Token launch sniper** — separate strategy for Pump.fun/Raydium new
  pools (high risk, very different code path)
- [ ] **Multi-account / multi-key** support — for operating multiple
  strategies in isolation
- [ ] **Telegram bot commands** — set thresholds, query stats from chat
- [ ] **Public read-only dashboard** — share links without exposing controls
- [ ] **WebSocket live updates** to dashboard (replace 4s polling)
- [ ] **Mobile-app shell** (PWA) — install dashboard as a phone app
- [ ] **Historical chart in symbol expand panel** (sparkline of last 24h)

---

## Won't Do (Deliberate)

- ❌ **Sub-second polling** — we can't compete with HFT bots; not our edge
- ❌ **Adding more strategies before validating existing ones** — fixing zero-edge
  strategies by adding more strategies-of-unknown-edge is how trading systems die
- ❌ **Custom RPC / validator-colocation** — infrastructure-level edge requires
  $$$ that won't pay back at retail scale
- ❌ **Token launch sniping as a primary strategy** — gambling, not trading
- ❌ **Live trading without ≥30 days proven paper edge per strategy**

---

## Operational Discipline

For every Phase to merge to `main`:
1. **TypeScript clean** (`npx tsc --noEmit` returns 0)
2. **Backtest results documented** in `data/backtest-reports/`
3. **Paper-trade ≥3 days** before any live wiring (Phase 6)
4. **Dashboard updated** if user-visible
5. **Won't change live `MODE` to live** without explicit user confirmation
   in the same session (per CLAUDE.md)

---

## Open Questions

- Birdeye free tier sufficient, or do we need paid ($99/mo) for full historical?
  → answer empirically: try free tier first, see if it covers our universe
- How far back is "enough" history? At least one full bull-bear cycle (so
  ≥18 months). Aim for 2024-01-01 onward.
- Drift's funding rate API — public or auth required? Need to verify.
- Backtest resolution: 30s (matches our live polls) vs 1m (matches Birdeye)?
  → 1m initially. The 30s noise is mostly Jupiter quote variance, not signal.

---

## Status Summary

| Phase | Status | Owner | Started | Completed |
|---|---|---|---|---|
| 1 — Backtester + historical data | ✅ Complete | Claude | 2026-05-05 | 2026-05-05 |
| 7 — Universe optimization (data-driven) | ✅ Complete | Claude | 2026-05-06 | 2026-05-06 |
| MOMENTUM_V1 strategy (HUNTER persona) | ✅ Complete | Claude | 2026-05-06 | 2026-05-06 |
| 2 — Smarter exits | 🟢 Next | — | — | — |
| 3 — ORACLE generator | ⏳ Queued | — | — | — |
| 4 — Funding carry | ⏳ Queued (needs P6) | — | — | — |
| 5 — Quality metrics | ⏳ Queued | — | — | — |
| 6 — Live Drift | ⏳ Queued | — | — | — |
| 7 — Universe opt | ⏳ Queued (needs P1) | — | — | — |
| 8 — Multi-timeframe | ⏳ Queued | — | — | — |
| 9 — Stat arb | ⏳ Queued (needs P1, P8) | — | — | — |
| 10 — Adaptive sizing | ⏳ Queued (needs P5) | — | — | — |

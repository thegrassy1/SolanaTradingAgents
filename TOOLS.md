# Solana trading agent — OpenClaw / HTTP command map

Use the HTTP API (default `http://172.20.0.1:3456` in this repo’s SKILL; adjust host for your Docker/host layout).

## Chat-style commands → HTTP

| User says | HTTP |
|-----------|------|
| `/trade status` | `GET /status` |
| `/trade positions` | `GET /positions` |
| `/trade closed` | `GET /positions/closed?limit=20` |
| `/trade close` | `POST http://172.20.0.1:3456/positions/close` body `{"all":true}` |
| `/trade close <id>` | `POST http://172.20.0.1:3456/positions/close` body `{"positionId":"<id>"}` |
| `/trade risk` | `GET /risk` |
| `/trade pnl` | `GET /pnl` |
| `/trade history` | `GET /history?limit=10` |
| `/trade set stop_loss 0.03` | `POST /config` body `{"key":"stop_loss","value":"0.03"}` |
| `/trade set take_profit 0.06` | `POST /config` body `{"key":"take_profit","value":"0.06"}` |
| `/trade set trailing_stop 0.05` | `POST /config` body `{"key":"trailing_stop","value":"0.05"}` |
| `/trade set trailing_stop null` | `POST /config` body `{"key":"trailing_stop","value":"null"}` |
| `/trade set max_daily_loss 0.05` | `POST /config` body `{"key":"max_daily_loss","value":"0.05"}` |
| `/trade set max_open_positions 1` | `POST /config` body `{"key":"max_open_positions","value":"1"}` |
| `/trade set risk_per_trade 0.02` | `POST /config` body `{"key":"risk_per_trade","value":"0.02"}` |
| `/trade set cooldown_loss_minutes 30` | `POST /config` body `{"key":"cooldown_loss_minutes","value":"30"}` |
| `/trade set cooldown 5` | `POST /config` body `{"key":"cooldown","value":"5"}` (normal cooldown, minutes) |
| `/trade set threshold 2` | `POST /config` body `{"key":"threshold","value":"2"}` |
| `/trade set trade_amount 10000000` | `POST /config` body `{"key":"trade_amount","value":"10000000"}` |
| `/trade report` | `POST http://172.20.0.1:3456/report/send` (no body) — sends the daily Telegram report |

Other endpoints: `GET /health`, `GET /quote`, `POST /trade`, `POST /positions/close`, `POST /mode`, `POST /reset`, `POST /report/send` — see `openclaw-skill/SKILL.md`.

**Dashboard:** visit `http://172.20.0.1:3456/` in a browser on the same network (or via Tailscale/SSH tunnel).

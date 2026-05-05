import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import type { TradingAgent } from './agent';
import { config } from './config';
import { getDashboardHtml } from './dashboard';
import { db, getRecentTrades, getTradeSummary, getRecentAiDecisions, getRecentAiActions } from './db';
import { buildDailyReport } from './report';
import { sendTelegramMessage } from './telegram';
import { getQuote } from './price';
import type { TradeRecord } from './types';
import { loadWallet } from './wallet';
import { runDailyReview } from './ai/reviewer';

const AI_DIR = path.join(process.cwd(), 'data', 'ai');
const LEARNINGS_PATH = path.join(AI_DIR, 'LEARNINGS.md');

/** Parse /strategies[/:name[/:sub]]. Returns null if not a strategies path. */
function parseStrategyPath(
  pathname: string,
): { name: string; sub: string | null } | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'strategies') return null;
  return { name: parts[1] ?? '', sub: parts[2] ?? null };
}

/** Serialize JSON with BigInt support (BigInt → string). */
function jsonSafe(obj: unknown): string {
  return JSON.stringify(obj, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = jsonSafe(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('Invalid JSON body');
  }
}

export function startApiServer(agent: TradingAgent): http.Server {
  const port = config.apiPort;
  const host = config.apiHost;
  const server = http.createServer((req, res) => {
    void handleRequest(agent, req, res, port);
  });
  server.listen(port, host, () => {
    console.log(`API server listening on http://${host}:${port}`);
  });
  return server;
}

export function stopApiServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function handleRequest(
  agent: TradingAgent,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
): Promise<void> {
  const started = Date.now();
  let logCode = 500;
  const method = (req.method ?? 'GET').toUpperCase();
  const base = `http://127.0.0.1:${port}`;
  const url = new URL(req.url ?? '/', base);
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  const done = (code: number, body: unknown): void => {
    logCode = code;
    sendJson(res, code, body);
  };

  try {
    if (method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
      const html = getDashboardHtml();
      logCode = 200;
      const body = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Content-Security-Policy': [
          "default-src 'none'",
          "base-uri 'none'",
          "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
          "style-src 'unsafe-inline'",
          "connect-src 'self'",
          'img-src data: blob:',
          "font-src 'self' https://cdn.jsdelivr.net",
        ].join('; '),
      });
      res.end(body);
      return;
    }

    if (method === 'GET' && pathname === '/stats') {
      const modeParam = url.searchParams.get('mode') as 'paper' | 'live' | undefined;
      const summary = getTradeSummary(modeParam ?? (agent.mode as 'paper' | 'live'));
      done(200, summary);
      return;
    }

    if (method === 'GET' && pathname === '/symbols') {
      // Multi-symbol snapshot — current price/SMA/vol for each universe symbol.
      done(200, { symbols: agent.multiMonitor.snapshotAll() });
      return;
    }

    if (method === 'GET' && pathname === '/prices/recent') {
      const limitRaw = url.searchParams.get('limit') ?? '50';
      const limit = Math.min(
        300,
        Math.max(1, Number.parseInt(limitRaw, 10) || 50),
      );
      const points = agent.priceMonitor.getPriceHistory(limit);
      done(200, { points });
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      const uptimeSec = agent.getStartedAt()
        ? Math.floor((Date.now() - agent.getStartedAt()!.getTime()) / 1000)
        : 0;
      done(200, {
        ok: true,
        uptime: uptimeSec,
        mode: agent.mode,
        running: agent.isRunning(),
      });
      return;
    }

    if (method === 'GET' && pathname === '/status') {
      try {
        const body = await agent.getStatus();
        done(200, body);
      } catch (e) {
        // Defensive: never let /status 500 — dashboard polls this every 4s
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[STATUS] degraded:', msg);
        done(200, {
          mode: agent.mode,
          running: agent.isRunning(),
          regime: 'unknown',
          degraded: true,
          degradedReason: msg,
          recentTrades: [],
          tradeSummary: { wins: 0, losses: 0, winRate: 0, totalRealizedPnl: 0, closedTrades: 0 },
          paperPortfolio: { balances: {}, pnl: { currentValue: 0, initialValue: 0, pnl: 0, pnlPercent: 0 } },
          dailyRealizedPnL: 0,
          dailyRealizedPnLNet: 0,
          dailyStartingValueQuote: 0,
          uptimeMs: 0,
          openPositionsCount: 0,
          risk: agent.riskManager.snapshot(),
          thresholdPct: 0,
          latestPrice: null, sma: null, volatility: null, priceChange: null,
          cooldownRemaining: 0,
        });
      }
      return;
    }

    if (method === 'GET' && pathname === '/quote') {
      const inputMint = url.searchParams.get('inputMint');
      const outputMint = url.searchParams.get('outputMint');
      const amount = url.searchParams.get('amount');
      if (!inputMint || !outputMint || amount === null || amount === '') {
        done(400, {
          error: 'Missing query params: inputMint, outputMint, amount',
        });
        return;
      }
      const order = await getQuote(inputMint, outputMint, amount);
      done(200, {
        inputMint: order.inputMint,
        outputMint: order.outputMint,
        inAmount: order.inAmount,
        outAmount: order.outAmount,
        priceImpact: order.priceImpactPct,
        slippageBps: order.slippageBps,
      });
      return;
    }

    if (method === 'GET' && pathname === '/history') {
      const limitRaw = url.searchParams.get('limit') ?? '20';
      const limit = Math.min(500, Math.max(1, Number.parseInt(limitRaw, 10) || 20));
      const modeParam = url.searchParams.get('mode');
      const mode =
        modeParam === 'paper' || modeParam === 'live' ? modeParam : undefined;
      const rows = getRecentTrades(limit, mode);
      done(200, rows);
      return;
    }

    if (method === 'GET' && pathname === '/pnl') {
      const pnl = await agent.getPaperEngine().getPnL(config.quoteMint);
      done(200, pnl);
      return;
    }

    if (method === 'GET' && pathname === '/portfolios') {
      const data = await agent.getPortfoliosApi();
      done(200, data);
      return;
    }

    if (method === 'GET' && pathname === '/positions') {
      const px = agent.priceMonitor.getLatestPrice();
      done(200, agent.getPositionsApi(px));
      return;
    }

    if (method === 'GET' && pathname === '/perps') {
      // Open perp positions with unrealized PnL using current prices
      const priceMap = agent.getCurrentPriceMap();
      const open = agent.perpEngine.getOpen().map((p) => {
        const mark = priceMap.get(p.mint) ?? p.entryPrice;
        const directionSign = p.direction === 'long' ? 1 : -1;
        const grossPnl = (mark - p.entryPrice) * p.size * directionSign;
        const netPnl = grossPnl - p.fundingAccrued;
        const equity = p.collateralUsdc + netPnl;
        const equityPct = (equity / p.collateralUsdc) * 100;
        return {
          ...p,
          mark,
          unrealizedGross: grossPnl,
          unrealizedNet: netPnl,
          equityUsdc: equity,
          equityPct,
        };
      });
      done(200, { positions: open });
      return;
    }

    if (method === 'GET' && pathname === '/perps/closed') {
      const limitRaw = url.searchParams.get('limit') ?? '20';
      const limit = Math.min(500, Math.max(1, Number.parseInt(limitRaw, 10) || 20));
      done(200, agent.perpEngine.getClosed(limit));
      return;
    }

    if (method === 'POST' && pathname === '/perps/close') {
      const raw = await readBody(req);
      const body = parseJson<{ positionId?: string; reason?: string }>(raw);
      if (typeof body.positionId !== 'string') {
        done(400, { error: 'positionId required' });
        return;
      }
      const pos = agent.perpEngine.getOpen().find((p) => p.id === body.positionId);
      if (!pos) {
        done(404, { error: 'position not found' });
        return;
      }
      const priceMap = agent.getCurrentPriceMap();
      const mark = priceMap.get(pos.mint);
      if (mark === undefined) {
        done(400, { error: 'no live price for position mint' });
        return;
      }
      const closed = agent.perpEngine.closePerp(pos.id, mark, (body.reason as 'manual_api') ?? 'manual_api');
      done(200, closed);
      return;
    }

    if (method === 'GET' && pathname === '/positions/closed') {
      const limitRaw = url.searchParams.get('limit') ?? '20';
      const limit = Math.min(500, Math.max(1, Number.parseInt(limitRaw, 10) || 20));
      done(200, agent.getClosedPositionsApi(limit));
      return;
    }

    if (method === 'GET' && pathname === '/risk') {
      done(200, agent.getRiskApiStatus());
      return;
    }

    if (method === 'POST' && pathname === '/positions/close') {
      const raw = await readBody(req);
      const body = parseJson<{
        positionId?: string;
        all?: boolean;
        reason?: string;
      }>(raw);
      const reason = typeof body.reason === 'string' ? body.reason : 'manual_api';
      try {
        if (body.all === true) {
          const ids = [
            ...agent.positionManager.getOpenPositions().map((p) => p.id),
          ];
          const trades: TradeRecord[] = [];
          for (const id of ids) {
            trades.push(await agent.closePositionById(id, reason));
          }
          done(200, { trades });
          return;
        }
        if (typeof body.positionId === 'string' && body.positionId !== '') {
          const rec = await agent.closePositionById(body.positionId, reason);
          done(200, { trades: [rec] });
          return;
        }
        done(400, {
          error: 'Provide JSON body with positionId (string) or all: true',
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        done(400, { error: msg });
      }
      return;
    }

    if (method === 'POST' && pathname === '/trade') {
      const raw = await readBody(req);
      const body = parseJson<{
        direction?: string;
        amount?: number;
        inputMint?: string;
        outputMint?: string;
      }>(raw);
      if (body.direction !== 'buy' && body.direction !== 'sell') {
        done(400, { error: 'direction must be "buy" or "sell"' });
        return;
      }
      if (typeof body.amount !== 'number' || !Number.isFinite(body.amount)) {
        done(400, { error: 'amount must be a finite number' });
        return;
      }
      const rec = await agent.executeTrade({
        direction: body.direction,
        amount: body.amount,
        inputMint: body.inputMint,
        outputMint: body.outputMint,
      });
      const ok = rec.status === 'success' || rec.status === 'paper_filled';
      done(ok ? 200 : 400, rec);
      return;
    }

    if (method === 'POST' && pathname === '/mode') {
      const raw = await readBody(req);
      const body = parseJson<{ mode?: string }>(raw);
      if (body.mode !== 'paper' && body.mode !== 'live') {
        done(400, { error: 'mode must be "paper" or "live"' });
        return;
      }
      if (body.mode === 'live' && !loadWallet()) {
        done(400, {
          error: 'Cannot switch to live: wallet not configured (PRIVATE_KEY)',
        });
        return;
      }
      try {
        agent.switchMode(body.mode);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        done(400, { error: msg });
        return;
      }
      done(200, {
        mode: agent.mode,
        message: `Switched to ${agent.mode.toUpperCase()} mode`,
      });
      return;
    }

    if (method === 'POST' && pathname === '/config') {
      const raw = await readBody(req);
      const body = parseJson<{ key?: string; value?: string }>(raw);
      if (!body.key || body.value === undefined) {
        done(400, { error: 'Missing key or value' });
        return;
      }
      if (body.key.toLowerCase() === 'mode') {
        done(400, {
          error: 'Cannot change mode via /config — use POST /mode',
        });
        return;
      }
      agent.setRuntimeConfig(body.key, String(body.value));
      done(200, {
        key: body.key,
        value: body.value,
        message: 'Runtime config updated',
      });
      return;
    }

    if (method === 'POST' && pathname === '/reset') {
      agent.getPaperEngine().reset();
      const balances = agent.getPaperEngine().getAllBalances();
      const human: Record<string, { raw: string; human: number }> = {};
      for (const [mint, b] of Object.entries(balances)) {
        human[mint] = { raw: b.raw.toString(), human: b.human };
      }
      done(200, {
        message: 'Paper portfolio reset',
        balances: human,
      });
      return;
    }

    if (method === 'POST' && pathname === '/report/send') {
      try {
        const report = await buildDailyReport(
          agent,
          agent.paperEngine,
          db,
        );
        await sendTelegramMessage(report);
        done(200, { ok: true, message: 'Report sent' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        done(500, { error: msg });
      }
      return;
    }

    // AI routes: /ai/decisions, /ai/learnings, /ai/review
    if (pathname.startsWith('/ai')) {
      if (method === 'GET' && pathname === '/ai/decisions') {
        const limitRaw = url.searchParams.get('limit') ?? '20';
        const limit = Math.min(200, Math.max(1, Number.parseInt(limitRaw, 10) || 20));
        done(200, getRecentAiDecisions(limit));
        return;
      }
      if (method === 'GET' && pathname === '/ai/actions') {
        const limitRaw = url.searchParams.get('limit') ?? '20';
        const limit = Math.min(200, Math.max(1, Number.parseInt(limitRaw, 10) || 20));
        done(200, getRecentAiActions(limit));
        return;
      }
      if (method === 'GET' && pathname === '/ai/learnings') {
        let content = '';
        try {
          if (fs.existsSync(LEARNINGS_PATH)) {
            content = fs.readFileSync(LEARNINGS_PATH, 'utf8');
          }
        } catch {}
        done(200, { content, path: LEARNINGS_PATH, exists: content.length > 0 });
        return;
      }
      if (method === 'POST' && pathname === '/ai/review') {
        if (!config.anthropicApiKey) {
          done(400, { error: 'ANTHROPIC_API_KEY not configured' });
          return;
        }
        void runDailyReview().then(() => {
          console.log('[AI] Manual review complete');
        });
        done(202, { ok: true, message: 'AI review started (runs in background)' });
        return;
      }
      done(404, { error: 'AI route not found' });
      return;
    }

    // Strategy routes: /strategies[/:name[/:sub]]
    const stratPath = parseStrategyPath(pathname);
    if (stratPath) {
      // GET /strategies — list all strategies
      if (method === 'GET' && !stratPath.name) {
        done(200, { strategies: agent.getStrategiesList() });
        return;
      }

      if (stratPath.name && stratPath.sub === 'status' && method === 'GET') {
        const status = await agent.getStrategyStatus(stratPath.name);
        if (!status) { done(404, { error: `Strategy not found: ${stratPath.name}` }); return; }
        done(200, status);
        return;
      }

      if (stratPath.name && stratPath.sub === 'trades' && method === 'GET') {
        const s = agent.getStrategiesList().find((x) => x.name === stratPath.name);
        if (!s) { done(404, { error: `Strategy not found: ${stratPath.name}` }); return; }
        const limitRaw = url.searchParams.get('limit') ?? '20';
        const limit = Math.min(500, Math.max(1, Number.parseInt(limitRaw, 10) || 20));
        const rows = db
          .prepare(`SELECT * FROM trades WHERE strategy = ? ORDER BY id DESC LIMIT ?`)
          .all(stratPath.name, limit);
        done(200, rows);
        return;
      }

      if (stratPath.name && stratPath.sub === 'config') {
        if (method === 'GET') {
          const cfg = agent.getStrategyConfig(stratPath.name);
          if (!cfg) { done(404, { error: `Strategy not found: ${stratPath.name}` }); return; }
          done(200, { strategy: stratPath.name, config: cfg });
          return;
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const body = parseJson<{ key?: string; value?: string }>(raw);
          if (!body.key || body.value === undefined) {
            done(400, { error: 'Missing key or value' }); return;
          }
          const ok = agent.setStrategyConfig(stratPath.name, body.key, String(body.value));
          if (!ok) { done(400, { error: `Unknown strategy or invalid value: ${stratPath.name}.${body.key}` }); return; }
          done(200, { strategy: stratPath.name, key: body.key, value: body.value, message: 'Strategy config updated' });
          return;
        }
      }

      done(404, { error: 'Not found' });
      return;
    }

    done(404, { error: 'Not found' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) {
      logCode = 500;
      sendJson(res, 500, { error: msg });
    }
  } finally {
    const ms = Date.now() - started;
    console.log(`[API] ${method} ${pathname} ${logCode} ${ms}ms`);
  }
}

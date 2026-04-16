import http from 'http';
import { URL } from 'url';
import type { TradingAgent } from './agent';
import { config } from './config';
import { getRecentTrades } from './db';
import { getQuote } from './price';
import { loadWallet } from './wallet';

const HOST = '127.0.0.1';

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
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
  const server = http.createServer((req, res) => {
    void handleRequest(agent, req, res, port);
  });
  server.listen(port, HOST, () => {
    console.log(`API server listening on http://${HOST}:${port}`);
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
  const base = `http://${HOST}:${port}`;
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
      const body = await agent.getStatus();
      done(200, body);
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

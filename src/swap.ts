import { config } from './config';
import type {
  JupiterExecuteResponse,
  JupiterOrderResponse,
  SwapResult,
} from './types';
import { loadWallet, signTransaction } from './wallet';

function ts(): string {
  return new Date().toISOString();
}

function apiHeaders(): HeadersInit {
  const h: Record<string, string> = {};
  if (config.jupiterApiKey) {
    h['x-api-key'] = config.jupiterApiKey;
  }
  return h;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '(unable to read body)';
  }
}

export async function getOrder(
  inputMint: string,
  outputMint: string,
  amount: string | number | bigint,
  takerPublicKey?: string,
): Promise<JupiterOrderResponse> {
  const url = new URL(`${config.jupiterApiUrl}/ultra/v1/order`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amount));
  if (takerPublicKey) {
    url.searchParams.set('taker', takerPublicKey);
  }
  try {
    const res = await fetch(url.toString(), { headers: apiHeaders() });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error(
        `[${ts()}] getOrder failed ${res.status} ${res.statusText} body=${bodyText}`,
      );
      throw new Error(`getOrder HTTP ${res.status}: ${bodyText}`);
    }
    return JSON.parse(bodyText) as JupiterOrderResponse;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('getOrder')) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${ts()}] getOrder error: ${msg}`);
    throw e;
  }
}

export async function executeSwap(
  signedTransaction: string,
  requestId: string,
): Promise<JupiterExecuteResponse> {
  const url = `${config.jupiterApiUrl}/ultra/v1/execute`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...apiHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ signedTransaction, requestId }),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      console.error(
        `[${ts()}] executeSwap failed ${res.status} ${res.statusText} body=${bodyText}`,
      );
      throw new Error(`executeSwap HTTP ${res.status}: ${bodyText}`);
    }
    return JSON.parse(bodyText) as JupiterExecuteResponse;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('executeSwap')) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${ts()}] executeSwap error: ${msg}`);
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableExecuteFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  if (/HTTP 429/.test(m)) return true;
  if (/HTTP 5\d\d/.test(m)) return true;
  const lower = m.toLowerCase();
  if (lower.includes('rate limit')) return true;
  if (lower.includes('blockhash')) return true;
  if (lower.includes('timeout')) return true;
  if (lower.includes('temporarily')) return true;
  return false;
}

export async function swapPaper(
  inputMint: string,
  outputMint: string,
  amount: string | number | bigint,
): Promise<{ order: JupiterOrderResponse; result: null }> {
  console.log(
    `[${ts()}] [PAPER-SWAP] getOrder quote-only input=${inputMint} output=${outputMint} amount=${amount}`,
  );
  const order = await getOrder(inputMint, outputMint, amount);
  console.log(
    `[${ts()}] [PAPER-SWAP] Would swap ${order.inAmount} → ${order.outAmount}, price impact: ${order.priceImpactPct}`,
  );
  return { order, result: null };
}

export async function swapLive(
  inputMint: string,
  outputMint: string,
  amount: string | number | bigint,
): Promise<{ order: JupiterOrderResponse; result: JupiterExecuteResponse }> {
  const wallet = loadWallet();
  if (!wallet) {
    throw new Error('Wallet not loaded; cannot execute live swap');
  }
  const taker = wallet.publicKey.toBase58();
  console.log(
    `[${ts()}] [SWAP] getOrder live taker=${taker} input=${inputMint} output=${outputMint} amount=${amount}`,
  );
  const order = await getOrder(inputMint, outputMint, amount, taker);
  console.log(
    `[${ts()}] [SWAP] Quote in=${order.inAmount} out=${order.outAmount} impact=${order.priceImpactPct} slippageBps=${order.slippageBps}`,
  );
  if (!order.transaction || !order.requestId) {
    throw new Error('Live order missing transaction or requestId');
  }
  const signed = signTransaction(order.transaction, wallet);
  let result: JupiterExecuteResponse;
  try {
    result = await executeSwap(signed, order.requestId);
  } catch (e) {
    if (isRetryableExecuteFailure(e)) {
      console.log(`[${ts()}] [SWAP] Retrying execute after 2s...`);
      await sleep(2000);
      result = await executeSwap(signed, order.requestId);
    } else {
      throw e;
    }
  }
  console.log(
    `[${ts()}] [SWAP] Execute status=${result.status} sig=${result.signature} in=${result.inputAmountResult} out=${result.outputAmountResult}`,
  );
  return { order, result };
}

export async function swap(
  inputMint: string,
  outputMint: string,
  amount: string | number | bigint,
  mode: 'paper' | 'live',
): Promise<SwapResult> {
  if (mode === 'paper') {
    const { order, result } = await swapPaper(inputMint, outputMint, amount);
    return { order, result };
  }
  const { order, result } = await swapLive(inputMint, outputMint, amount);
  return { order, result };
}

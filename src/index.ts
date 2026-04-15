import dotenv from 'dotenv';
import { TradingAgent } from './agent';
import { config } from './config';
import { loadWallet } from './wallet';

dotenv.config();

const modeLabel = config.mode.toUpperCase();
const pollSec = Math.round(config.pollIntervalMs / 1000);
console.log('==============================');
console.log(' Solana Trading Agent v1.0');
console.log(` Mode: ${modeLabel}`);
console.log(' Pair: SOL/USDC');
console.log(` Poll: every ${pollSec}s`);
console.log('==============================');

const agent = new TradingAgent(config);

const w = loadWallet();
console.log('Trading agent initialized', {
  mode: config.mode,
  ...(config.mode === 'live' && w ? { wallet: w.publicKey.toBase58() } : {}),
});

agent.start();

function shutdown(): void {
  agent.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

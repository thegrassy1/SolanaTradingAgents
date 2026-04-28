import type { Server } from 'http';
import dotenv from 'dotenv';
import { TradingAgent } from './agent';
import { startApiServer, stopApiServer } from './api';
import { config } from './config';
import { db } from './db';
import { buildDailyReport } from './report';
import { startScheduler, stopScheduler } from './scheduler';
import { sendTelegramMessage } from './telegram';
import { loadWallet } from './wallet';
import { runDailyReview } from './ai/reviewer';

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

let apiServer: Server | null = null;
apiServer = startApiServer(agent);

const sendDailyReport = async (): Promise<void> => {
  try {
    const report = await buildDailyReport(agent, agent.paperEngine, db);
    await sendTelegramMessage(report);
    console.log('[SCHEDULER] Daily report sent');
  } catch (err) {
    console.error('[SCHEDULER] Report failed:', err);
  }
};

const aiReviewEnabled = !!config.anthropicApiKey;

if (config.telegramBotToken && config.telegramChatId) {
  startScheduler(sendDailyReport, aiReviewEnabled ? runDailyReview : undefined);
  console.log(
    '[SCHEDULER] Daily report enabled for',
    config.reportCron,
    config.reportTimezone,
  );
} else {
  startScheduler(sendDailyReport, aiReviewEnabled ? runDailyReview : undefined);
  console.log('[SCHEDULER] Telegram not configured — daily reports disabled');
}

if (aiReviewEnabled) {
  console.log(`[SCHEDULER] AI reviewer enabled for ${config.aiReviewCron} ${config.reportTimezone}`);
} else {
  console.log('[SCHEDULER] AI reviewer disabled (no ANTHROPIC_API_KEY)');
}

function shutdown(): void {
  const done = (): void => {
    stopScheduler();
    agent.stop();
    process.exit(0);
  };
  if (apiServer) {
    void stopApiServer(apiServer).finally(done);
    apiServer = null;
  } else {
    done();
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

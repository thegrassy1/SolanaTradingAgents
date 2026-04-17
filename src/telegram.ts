import { config } from './config';

const TELEGRAM_MAX = 4096;

/** Split at newline boundaries; if a single line exceeds max, hard-split it. */
function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= maxLen) {
      chunks.push(rest);
      break;
    }
    const slice = rest.slice(0, maxLen);
    const nl = slice.lastIndexOf('\n');
    const breakAt = nl > 0 ? nl + 1 : maxLen;
    chunks.push(rest.slice(0, breakAt));
    rest = rest.slice(breakAt);
  }
  return chunks;
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const token = config.telegramBotToken.trim();
  const chatId = config.telegramChatId.trim();
  if (!token || !chatId) {
    throw new Error(
      'Telegram is not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID',
    );
  }

  const parts = chunkMessage(text, TELEGRAM_MAX);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  for (const part of parts) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: part,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      let json: { ok?: boolean; description?: string };
      try {
        json = (await res.json()) as { ok?: boolean; description?: string };
      } catch {
        const msg = `HTTP ${res.status} ${res.statusText}`;
        console.error('[TELEGRAM] error:', msg);
        throw new Error(msg);
      }
      if (!res.ok || !json.ok) {
        const msg = json.description ?? res.statusText;
        console.error('[TELEGRAM] error:', msg);
        throw new Error(`Telegram API error: ${msg}`);
      }
      console.log(`[TELEGRAM] sent (${part.length} chars)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[TELEGRAM] error:', msg);
      throw e instanceof Error ? e : new Error(msg);
    }
  }
}

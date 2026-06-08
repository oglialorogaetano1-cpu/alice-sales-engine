import 'dotenv/config';
import express, { Request, Response } from 'express';
import { createBot } from './recall';
import { adminClient } from './supabase';
import { handleWebhook } from './webhook';

const app = express();

// ── POST /webhook — PRIMA di express.json() ───────────────
// express.raw() deve girare su body non ancora parsato.
// Se express.json() globale girasse prima, consumerebbe lo stream
// e rawBody risulterebbe un oggetto JS, invalidando la firma HMAC.
app.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// Da qui in poi il body viene parsato come JSON per tutte le altre route
app.use(express.json());

// ── Health ────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'alice-sales-engine' });
});

// ── POST /join ────────────────────────────────────────────
// Body: { meeting_url: string, closer_id?: string }
app.post('/join', async (req: Request, res: Response) => {
  const { meeting_url, closer_id } = req.body as { meeting_url?: string; closer_id?: string };

  if (!meeting_url) {
    res.status(400).json({ ok: false, error: 'meeting_url è obbligatorio' });
    return;
  }

  let bot;
  try {
    bot = await createBot(meeting_url);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Recall error';
    console.error('[join] createBot failed:', msg);
    res.status(502).json({ ok: false, error: msg });
    return;
  }

  const adm = adminClient();
  const { data: chiamata, error } = await adm
    .from('chiamate')
    .insert({
      recall_bot_id: bot.id,
      meeting_url,
      data: new Date().toISOString().slice(0, 10),
      stato_pipeline: 'in_attesa',
      ...(closer_id ? { closer_id } : {}),
    })
    .select('id')
    .single();

  if (error) {
    console.error('[join] insert chiamata:', error.message);
    res.status(500).json({ ok: false, error: error.message });
    return;
  }

  console.log(`[join] bot=${bot.id} chiamata=${chiamata.id} url=${meeting_url}`);
  res.json({ ok: true, bot_id: bot.id, chiamata_id: chiamata.id });
});

// ── POST /test-telegram ───────────────────────────────────
// Invia una notifica di test senza bisogno di una call reale.
// Body opzionale: { chat_id?: string } — se omesso usa MANAGER_TELEGRAM_CHAT_ID
app.post('/test-telegram', async (req: Request, res: Response) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN non impostato' });
    return;
  }

  const chatId = (req.body as { chat_id?: string }).chat_id
    ?? process.env.MANAGER_TELEGRAM_CHAT_ID;

  if (!chatId) {
    res.status(400).json({ ok: false, error: 'chat_id mancante e MANAGER_TELEGRAM_CHAT_ID non impostato' });
    return;
  }

  const text = [
    '🧪 <b>Alert di test — Alice Sales Engine</b>',
    '',
    'Se ricevi questo messaggio, il bot funziona correttamente.',
    `<i>chat_id: ${chatId}</i>`,
  ].join('\n');

  const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });

  const tgBody = await tgRes.json() as { ok: boolean; description?: string };

  if (!tgRes.ok || !tgBody.ok) {
    res.status(502).json({ ok: false, telegram_error: tgBody.description ?? 'unknown' });
    return;
  }

  res.json({ ok: true, sent_to: chatId });
});

// ── Start ─────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`alice-sales-engine v2A listening on :${PORT}`);
});

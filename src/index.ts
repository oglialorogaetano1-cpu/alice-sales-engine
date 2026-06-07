import 'dotenv/config';
import express, { Request, Response } from 'express';
import { createBot } from './recall';
import { adminClient } from './supabase';
import { handleWebhook } from './webhook';

const app = express();
app.use(express.json());

// ── Health ────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'alice-sales-engine' });
});

// ── POST /join ────────────────────────────────────────────
// Body: { meeting_url: string, closer_id?: string }
// Crea un bot Recall e inserisce una riga in chiamate
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

// ── POST /webhook ─────────────────────────────────────────
// Riceve eventi da Recall (bot.status_change, recording.done, …)
// express.raw() preserva il body grezzo necessario per la verifica firma Svix
app.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// ── Start ─────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`alice-sales-engine listening on :${PORT}`);
});

import crypto from 'crypto';
import { Request, Response } from 'express';
import { adminClient } from './supabase';

const TOLERANCE_SEC = 300; // 5 minuti, stessa soglia dell'SDK Svix

function verifySignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
): boolean {
  const secret = process.env.RECALL_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[webhook] RECALL_WEBHOOK_SECRET non impostato — verifica firma saltata');
    return true;
  }

  const msgId        = (headers['webhook-id']        ?? headers['svix-id'])        as string | undefined;
  const msgTimestamp = (headers['webhook-timestamp']  ?? headers['svix-timestamp']) as string | undefined;
  const msgSignature = (headers['webhook-signature']  ?? headers['svix-signature']) as string | undefined;

  if (!msgId || !msgTimestamp || !msgSignature) {
    console.warn('[webhook] header Svix mancanti');
    return false;
  }

  // Replay protection: rifiuta payload più vecchi di 5 minuti
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(msgTimestamp, 10)) > TOLERANCE_SEC) {
    console.warn('[webhook] timestamp fuori tolleranza');
    return false;
  }

  // Deriva chiave: strip "whsec_" e base64-decode
  const keyBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');

  // Stringa firmata: id.timestamp.rawBody
  const toSign      = `${msgId}.${msgTimestamp}.${rawBody.toString('utf8')}`;
  const expectedB64 = crypto.createHmac('sha256', keyBytes).update(toSign).digest('base64');
  const expectedBuf = Buffer.from(expectedB64, 'base64');

  // webhook-signature può contenere più firme separate da spazio (rotazione chiavi)
  // Confronto timing-safe come raccomandato dalla doc Recall/Svix
  for (const versionedSig of msgSignature.split(' ')) {
    const [version, signature] = versionedSig.split(',');
    if (version !== 'v1' || !signature) continue;
    const sigBuf = Buffer.from(signature, 'base64');
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

type RecallEvent = {
  event: string;
  data: {
    bot_id?: string;
    status?: { code: string; message?: string };
    recording?: { id: string; media_shortcuts?: Record<string, { url: string; expires_at: string }> };
  };
};

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = req.body as Buffer;

  if (!verifySignature(req.headers as Record<string, string | string[] | undefined>, rawBody)) {
    console.warn('[webhook] firma non valida — 401');
    res.status(401).json({ ok: false, error: 'Invalid signature' });
    return;
  }

  let body: RecallEvent;
  try {
    body = JSON.parse(rawBody.toString()) as RecallEvent;
  } catch {
    res.status(400).json({ ok: false, error: 'Body non è JSON valido' });
    return;
  }

  const { event, data } = body;
  console.log(`[webhook] event=${event} bot_id=${data?.bot_id ?? '?'}`);

  const adm = adminClient();

  if (event === 'bot.status_change') {
    const code = data.status?.code ?? '';
    if (code === 'fatal' || code === 'recording_permission_denied') {
      const { error } = await adm
        .from('chiamate')
        .update({ stato_pipeline: 'errore', errore_msg: `bot.status: ${code}` })
        .eq('recall_bot_id', data.bot_id);
      if (error) console.error('[webhook] update errore:', error.message);
    }
    res.json({ ok: true, handled: 'status_change', code });
    return;
  }

  if (event === 'recording.done') {
    const botId = data.bot_id;
    if (!botId) { res.status(400).json({ ok: false, error: 'bot_id mancante' }); return; }

    const { error } = await adm
      .from('chiamate')
      .update({ stato_pipeline: 'registrata' })
      .eq('recall_bot_id', botId)
      .eq('stato_pipeline', 'in_attesa');

    if (error) {
      console.error('[webhook] update registrata:', error.message);
      res.status(500).json({ ok: false, error: error.message });
      return;
    }

    console.log(`[webhook] chiamata ${botId} → registrata`);
    res.json({ ok: true, handled: 'recording.done', bot_id: botId });
    return;
  }

  res.json({ ok: true, handled: false, event });
}

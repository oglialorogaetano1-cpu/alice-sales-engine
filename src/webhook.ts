import crypto from 'crypto';
import { Request, Response } from 'express';
import { adminClient } from './supabase';
import { createTranscript, getTranscriptContent } from './recall';
import { analyzeCall } from './analyze';
import { notifyCloser, notifyManager } from './telegram';

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
    data?: { code: string; sub_code?: string | null };
    bot?: { id: string; metadata?: Record<string, string> };
    recording?: { id: string };
    transcript?: { id: string };
    status?: { code: string; message?: string };
    bot_id?: string;
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
    const code  = data.status?.code ?? '';
    const botId = data.bot?.id ?? data.bot_id;
    const meta  = data.bot?.metadata;

    // Calendar-initiated bot: create chiamata if it doesn't exist yet
    if ((code === 'joining_call' || code === 'in_call_not_recording') && meta?.closer_id && botId) {
      const { data: existing } = await adm
        .from('chiamate').select('id').eq('recall_bot_id', botId).maybeSingle();
      if (!existing) {
        const { error: insErr } = await adm.from('chiamate').insert({
          recall_bot_id: botId,
          closer_id:     meta.closer_id,
          data:          new Date().toISOString().slice(0, 10),
          stato_pipeline: 'in_attesa',
        });
        if (insErr) console.error('[webhook] insert calendar chiamata:', insErr.message);
        else console.log(`[webhook] calendar-bot chiamata creata bot=${botId} closer=${meta.closer_id}`);
      }
    }

    if (code === 'fatal' || code === 'recording_permission_denied') {
      const { error } = await adm
        .from('chiamate')
        .update({ stato_pipeline: 'errore', errore_msg: `bot.status: ${code}` })
        .eq('recall_bot_id', botId);
      if (error) console.error('[webhook] update errore:', error.message);
    }
    res.json({ ok: true, handled: 'status_change', code });
    return;
  }

  if (event === 'recording.done') {
    const botId = data.bot?.id ?? data.bot_id;
    const recordingId = data.recording?.id;
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

    if (recordingId) {
      try {
        await createTranscript(recordingId);
        console.log(`[webhook] createTranscript avviata per recording ${recordingId}`);
      } catch (e) {
        console.error('[webhook] createTranscript failed (non-fatal):', e);
      }
    }

    console.log(`[webhook] chiamata ${botId} → registrata`);
    res.json({ ok: true, handled: 'recording.done', bot_id: botId });
    return;
  }

  if (event === 'transcript.done') {
    const botId = data.bot?.id ?? data.bot_id;
    const transcriptId = data.transcript?.id;

    if (!botId || !transcriptId) {
      res.status(400).json({ ok: false, error: 'bot_id o transcript_id mancanti' });
      return;
    }

    res.json({ ok: true, handled: 'transcript.done', bot_id: botId });

    (async () => {
      try {
        const segments = await getTranscriptContent(transcriptId);
        const transcriptText = segments
          .map(seg => `[${seg.participant.name}]: ${seg.words.map(w => w.text).join(' ')}`)
          .join('\n');

        await adm.from('chiamate')
          .update({ transcript: transcriptText, stato_pipeline: 'trascritta' })
          .eq('recall_bot_id', botId);

        const { data: contesto } = await adm
          .from('contesto_aziendale')
          .select('descrizione_azienda, pacchetti, cliente_tipo')
          .single();

        const contestoText = [
          contesto?.descrizione_azienda ? `Descrizione azienda: ${contesto.descrizione_azienda}` : '',
          contesto?.cliente_tipo ? `Tipo cliente target: ${contesto.cliente_tipo}` : '',
          contesto?.pacchetti ? `Pacchetti disponibili: ${JSON.stringify(contesto.pacchetti, null, 2)}` : '',
        ].filter(Boolean).join('\n');

        const analisi = await analyzeCall(transcriptText, contestoText);

        await adm.from('chiamate')
          .update({
            analisi_json: analisi,
            voto_totale: analisi.voto_totale,
            stato_trattativa: analisi.stato_trattativa,
            stato_pipeline: 'analizzata',
          })
          .eq('recall_bot_id', botId);

        console.log(`[webhook] chiamata ${botId} → analizzata (voto: ${analisi.voto_totale})`);

        const { data: chiamataRow } = await adm
          .from('chiamate')
          .select('closer_id, closers(nome, telegram_chat_id)')
          .eq('recall_bot_id', botId)
          .single();

        type CloserRow = { nome: string; telegram_chat_id: string | null };
        const closer = chiamataRow?.closers as unknown as CloserRow | null;

        if (closer?.telegram_chat_id) {
          await notifyCloser(closer.telegram_chat_id, analisi);
        }
        if (analisi.voto_totale <= 5 || analisi.stato_trattativa === 'a_rischio') {
          await notifyManager(analisi, closer?.nome ?? 'Sconosciuto');
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[webhook] pipeline errore bot=${botId}:`, errMsg);
        await adm.from('chiamate')
          .update({ stato_pipeline: 'errore', errore_msg: errMsg })
          .eq('recall_bot_id', botId);
      }
    })();

    return;
  }

  res.json({ ok: true, handled: false, event });
}

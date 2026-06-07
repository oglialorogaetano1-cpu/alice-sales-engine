import { Request, Response } from 'express';
import { adminClient } from './supabase';

type RecallEvent = {
  event: string;
  data: {
    bot_id?: string;
    status?: { code: string; message?: string };
    recording?: { id: string; media_shortcuts?: Record<string, { url: string; expires_at: string }> };
  };
};

export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const body = req.body as RecallEvent;
  const { event, data } = body;

  console.log(`[webhook] event=${event} bot_id=${data?.bot_id ?? '?'}`);

  const adm = adminClient();

  if (event === 'bot.status_change') {
    const code = data.status?.code ?? '';
    // Aggiorna stato_pipeline in base al codice Recall
    const mapping: Record<string, string> = {
      in_call_recording: 'in_attesa',  // bot sta registrando, pipeline non ancora avanzata
      call_ended: 'in_attesa',          // chiamata finita, aspettiamo recording.done
      fatal: 'errore',
      recording_permission_denied: 'errore',
    };
    const nuovoStato = mapping[code];

    if (nuovoStato === 'errore') {
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
      .eq('stato_pipeline', 'in_attesa'); // evita sovrascrittura se già avanzata

    if (error) {
      console.error('[webhook] update registrata:', error.message);
      res.status(500).json({ ok: false, error: error.message });
      return;
    }

    console.log(`[webhook] chiamata ${botId} → registrata`);
    res.json({ ok: true, handled: 'recording.done', bot_id: botId });
    return;
  }

  // Evento non gestito: risponde 200 per non far ritrasmettere Recall
  res.json({ ok: true, handled: false, event });
}

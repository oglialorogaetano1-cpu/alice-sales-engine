import { AnalisiChiamata } from './analyze';

async function sendMessage(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { console.warn('[telegram] TELEGRAM_BOT_TOKEN non impostato'); return; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) console.error('[telegram] sendMessage failed:', await res.text());
}

export async function notifyCloser(chatId: string, analisi: AnalisiChiamata): Promise<void> {
  const emoji = analisi.voto_totale >= 7 ? '🟢' : analisi.voto_totale >= 5 ? '🟡' : '🔴';
  const text = [
    `${emoji} <b>Chiamata analizzata</b>`,
    `Voto: <b>${analisi.voto_totale}/10</b> | Stato: <b>${analisi.stato_trattativa}</b>`,
    '',
    '💪 <b>Punti di forza:</b>',
    ...analisi.punti_di_forza.map(p => `• ${p}`),
    '',
    '⚠️ <b>Da correggere:</b>',
    ...analisi.errori_da_correggere.slice(0, 3).map(e => `• ${e}`),
    '',
    `🎯 <b>Prossimo passo:</b> ${analisi.prossimo_passo_consigliato}`,
    '',
    `💬 <i>${analisi.frase_coaching}</i>`,
  ].join('\n');
  await sendMessage(chatId, text);
}

export async function notifyManager(analisi: AnalisiChiamata, closerNome: string): Promise<void> {
  const chatId = process.env.MANAGER_TELEGRAM_CHAT_ID;
  if (!chatId) return;
  const text = [
    `🔴 <b>Chiamata a rischio — voto ${analisi.voto_totale}/10</b>`,
    `Closer: <b>${closerNome}</b>`,
    `Stato: <b>${analisi.stato_trattativa}</b>`,
    '',
    `⚠️ ${analisi.errori_da_correggere[0] ?? ''}`,
    '',
    `💬 <i>${analisi.frase_coaching}</i>`,
  ].join('\n');
  await sendMessage(chatId, text);
}

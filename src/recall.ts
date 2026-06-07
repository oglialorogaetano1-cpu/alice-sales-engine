const REGION = process.env.RECALL_REGION || 'eu';
const BASE = REGION === 'eu'
  ? 'https://eu-central-1.recall.ai/api/v1'
  : 'https://api.recall.ai/api/v1';

function headers() {
  return {
    Authorization: `Token ${process.env.RECALL_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export type RecallBot = {
  id: string;
  meeting_url: string;
  status: { code: string };
};

export async function createBot(meetingUrl: string): Promise<RecallBot> {
  const url = `${BASE}/bot/`;
  console.log(`[recall] POST ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        meeting_url: meetingUrl,
        bot_name: 'Alice Sales Bot',
      }),
    });
  } catch (e: unknown) {
    const msg  = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error ? String((e as { cause?: unknown }).cause ?? '') : '';
    console.error(`[recall] fetch error: ${msg} | cause: ${cause}`);
    throw new Error(`fetch failed: ${msg}${cause ? ` | cause: ${cause}` : ''}`);
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(`[recall] API error ${res.status}: ${text}`);
    throw new Error(`Recall createBot ${res.status}: ${text}`);
  }
  return res.json() as Promise<RecallBot>;
}

export async function getBot(botId: string): Promise<RecallBot> {
  const res = await fetch(`${BASE}/bot/${botId}/`, { headers: headers() });
  if (!res.ok) throw new Error(`Recall getBot ${res.status}`);
  return res.json() as Promise<RecallBot>;
}

const REGION = process.env.RECALL_REGION || 'eu';
const BASE = REGION === 'eu'
  ? 'https://api.eu.recall.ai/api/v1'
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
  const res = await fetch(`${BASE}/bot/`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      meeting_url: meetingUrl,
      bot_name: 'Alice Sales Bot',
      recording_mode: 'speaker_view',
      real_time_transcription: { destination_url: null },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Recall createBot ${res.status}: ${text}`);
  }
  return res.json() as Promise<RecallBot>;
}

export async function getBot(botId: string): Promise<RecallBot> {
  const res = await fetch(`${BASE}/bot/${botId}/`, { headers: headers() });
  if (!res.ok) throw new Error(`Recall getBot ${res.status}`);
  return res.json() as Promise<RecallBot>;
}

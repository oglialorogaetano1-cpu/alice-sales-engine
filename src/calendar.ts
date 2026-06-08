import { Request, Response } from 'express';
import { adminClient } from './supabase';

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const RECALL_BASE      = 'https://eu-central-1.recall.ai/api/v2';
const REDIRECT_URI     = 'https://alice-sales-engine-production.up.railway.app/calendar/callback';
const PLATFORM_URL     = 'https://auto-broker.it/closer/dashboard';
const CALENDAR_WEBHOOK = 'https://alice-sales-engine-production.up.railway.app/calendar/webhook';

type CalendarEvent = {
  id: string;
  start_time: string;
  meeting_url?: string | null;
};

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

export async function handleCalendarConnect(req: Request, res: Response): Promise<void> {
  const { closer_id } = req.params as { closer_id: string };

  const { data: closer } = await adminClient()
    .from('closers').select('id').eq('id', closer_id).single();
  if (!closer) { res.status(404).send('Closer non trovato'); return; }

  const state  = Buffer.from(JSON.stringify({ closer_id })).toString('base64');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.GOOGLE_CLIENT_ID!,
    redirect_uri:  REDIRECT_URI,
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state,
  });

  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
}

export async function handleCalendarCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error } = req.query as Record<string, string | undefined>;

  if (error) {
    res.redirect(`${PLATFORM_URL}?calendar=error&reason=${error}`); return;
  }
  if (!code || !state) {
    res.redirect(`${PLATFORM_URL}?calendar=error&reason=missing_params`); return;
  }

  let closer_id: string;
  try {
    closer_id = (JSON.parse(Buffer.from(state, 'base64').toString()) as { closer_id: string }).closer_id;
  } catch {
    res.redirect(`${PLATFORM_URL}?calendar=error&reason=invalid_state`); return;
  }

  try {
    const tokRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }).toString(),
    });
    const tokens = await tokRes.json() as { access_token?: string; refresh_token?: string; error?: string };
    if (!tokRes.ok || !tokens.refresh_token) throw new Error(tokens.error ?? 'no refresh_token');

    const profRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const { email } = await profRes.json() as { email?: string };

    const calRes = await fetch(`${RECALL_BASE}/calendars/`, {
      method: 'POST',
      headers: {
        Authorization:  `Token ${process.env.RECALL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        platform:            'google_calendar',
        oauth_client_id:     process.env.GOOGLE_CLIENT_ID,
        oauth_client_secret: process.env.GOOGLE_CLIENT_SECRET,
        oauth_refresh_token: tokens.refresh_token,
        webhook_url:         CALENDAR_WEBHOOK,
      }),
    });
    if (!calRes.ok) throw new Error(`Recall: ${await calRes.text()}`);
    const { id: recall_calendar_id } = await calRes.json() as { id: string };

    await adminClient().from('closers').update({
      calendar_connesso:  true,
      recall_calendar_id,
      ...(email ? { email_google: email } : {}),
    }).eq('id', closer_id);

    console.log(`[calendar] closer=${closer_id} recall_calendar_id=${recall_calendar_id}`);
    res.redirect(`${PLATFORM_URL}?calendar=connected`);

  } catch (e) {
    console.error('[calendar] errore:', e instanceof Error ? e.message : e);
    res.redirect(`${PLATFORM_URL}?calendar=error&reason=internal`);
  }
}

export function handleCalendarWebhook(req: Request, res: Response): void {
  res.json({ ok: true });

  const body = req.body as { event?: string; data?: { calendar_id?: string } };
  if (body?.event !== 'calendar.sync_events') return;
  const calendarId = body?.data?.calendar_id;
  if (!calendarId) return;

  (async () => {
    try {
      const adm = adminClient();
      const { data: closerRow } = await adm
        .from('closers')
        .select('id')
        .eq('recall_calendar_id', calendarId)
        .single();

      if (!closerRow) {
        console.warn(`[calendar-wh] no closer for calendar_id=${calendarId}`);
        return;
      }
      const closerId = closerRow.id as string;

      const now = new Date().toISOString();
      const evRes = await fetch(
        `${RECALL_BASE}/calendar-events/?calendar_id=${calendarId}&start_time__gte=${encodeURIComponent(now)}`,
        { headers: { Authorization: `Token ${process.env.RECALL_API_KEY}` } },
      );
      if (!evRes.ok) {
        console.error('[calendar-wh] fetch events failed:', await evRes.text()); return;
      }
      const { results } = await evRes.json() as { results: CalendarEvent[] };

      for (const ev of (results ?? [])) {
        if (!ev.meeting_url) continue;

        const botRes = await fetch(`${RECALL_BASE}/calendar-events/${ev.id}/bot/`, {
          method: 'POST',
          headers: {
            Authorization: `Token ${process.env.RECALL_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            bot_name: 'Alice AI',
            deduplication_key: `${ev.id}-${closerId}`,
            metadata: { closer_id: closerId },
          }),
        });

        if (botRes.ok) {
          console.log(`[calendar-wh] bot schedulato ev=${ev.id} closer=${closerId}`);
        } else {
          const txt = await botRes.text();
          if (!txt.includes('deduplication_key')) {
            console.error(`[calendar-wh] schedule bot ev=${ev.id}:`, txt);
          }
        }
      }
    } catch (e) {
      console.error('[calendar-wh]', e instanceof Error ? e.message : e);
    }
  })();
}

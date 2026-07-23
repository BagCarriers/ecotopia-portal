import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}

// ── RFC 5545 helpers ─────────────────────────────────────────────────────
// Escape backslash first, then the special characters.
function icsEscape(v: string): string {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsUnescape(v: string): string {
  return String(v)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// date (YYYY-MM-DD or ISO) -> YYYYMMDD for an all-day DTSTART
function toIcsDate(dateStr: string): string {
  return String(dateStr).slice(0, 10).replace(/-/g, '');
}

// ── Outbound: build an ICS calendar from all events ──────────────────────
function buildIcs(events: Array<Record<string, unknown>>): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ecotopia Earthcare//Portal Calendar//EN',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Ecotopia Earthcare',
  ];
  for (const ev of events) {
    const date = ev.date as string | null;
    if (!date) continue; // events without a date cannot be all-day VEVENTs
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.id}@ecotopia`);
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(date)}`);
    lines.push(`SUMMARY:${icsEscape((ev.title as string) || '')}`);
    if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description as string)}`);
    if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location as string)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ── Inbound: parse a Google secret-address ICS feed ──────────────────────
function unfold(raw: string): string[] {
  const rawLines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

// Allowlist the stored ICS URL: it must be a Google Calendar secret address.
// Defense-in-depth against SSRF via a maliciously-stored settings value.
function isGoogleCalendarUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch (_e) { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return host === 'calendar.google.com' || host.endsWith('.googleusercontent.com');
}

interface ParsedEvent { date: string; title: string; allDay: boolean; }

function parseIcs(raw: string): ParsedEvent[] {
  const lines = unfold(raw);
  const events: ParsedEvent[] = [];
  let cur: Partial<ParsedEvent> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && cur.date) {
        events.push({ date: cur.date, title: cur.title || '', allDay: !!cur.allDay });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const dt = line.match(/^DTSTART([^:]*):(.+)$/);
    if (dt) {
      const params = dt[1] || '';
      const value = dt[2].trim();
      const ymd = value.slice(0, 8);
      if (/^\d{8}$/.test(ymd)) {
        cur.date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
        cur.allDay = /VALUE=DATE/i.test(params) || !value.includes('T');
      }
      continue;
    }
    const sm = line.match(/^SUMMARY([^:]*):(.*)$/);
    if (sm) { cur.title = icsUnescape(sm[2]); continue; }
  }
  // Window guards against unbounded feeds; the 500-item cap is the real bound
  // (we read one DTSTART per VEVENT, no RRULE expansion). Lookback is widened to
  // two years so seasonal/annual community events remain visible when scrolling
  // the calendar back; forward horizon is one year. Cap 500.
  const now = Date.now();
  const lo = now - 730 * 86400000;
  const hi = now + 365 * 86400000;
  return events
    .filter((e) => {
      const t = new Date(e.date + 'T12:00:00Z').getTime();
      return !isNaN(t) && t >= lo && t <= hi;
    })
    .slice(0, 500);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true }, 200);

  // ── Outbound ICS feed (GET, token-authed; Google's fetcher sends no headers)
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url);
      const token = url.searchParams.get('token');
      if (!token) return json({ error: 'Forbidden' }, 403);
      const sb = admin();
      const { data: setting } = await sb.from('portal_settings').select('value')
        .eq('key', 'calendar_feed_token').maybeSingle();
      if (!setting || setting.value !== token) return json({ error: 'Forbidden' }, 403);

      const { data: events, error } = await sb.from('events').select('*');
      if (error) return json({ error: 'Could not load events.' }, 500);
      const ics = buildIcs(events || []);
      return new Response(ics, {
        status: 200,
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'inline; filename="ecotopia.ics"',
          ...CORS,
        },
      });
    } catch (_e) {
      return json({ error: 'Unexpected error.' }, 500);
    }
  }

  // ── Inbound proxy (POST, signed-in staff only) ─────────────────────────
  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}));
      if (body.action !== 'google_events') return json({ error: 'Unknown action.' }, 400);

      const authHeader = req.headers.get('Authorization') || '';
      const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (!jwt) return json({ error: 'Unauthorized' }, 401);

      const sb = admin();
      const { data: userData, error: userErr } = await sb.auth.getUser(jwt);
      if (userErr || !userData || !userData.user) return json({ error: 'Unauthorized' }, 401);

      const { data: pu } = await sb.from('portal_users').select('user_id')
        .eq('user_id', userData.user.id).eq('active', true).maybeSingle();
      if (!pu) return json({ error: 'No portal access.' }, 403);

      const { data: setting } = await sb.from('portal_settings').select('value')
        .eq('key', 'google_calendar_ics_url').maybeSingle();
      const icsUrl = setting && typeof setting.value === 'string' ? setting.value : null;
      if (!icsUrl) return json({ configured: false, events: [] }, 200);
      if (!isGoogleCalendarUrl(icsUrl)) {
        return json({ error: 'Calendar URL must be a Google Calendar secret address (https://calendar.google.com/...).' }, 400);
      }

      let res: Response;
      try {
        res = await fetch(icsUrl);
      } catch (_e) {
        return json({ error: 'Could not reach the Google calendar feed.' }, 502);
      }
      if (!res.ok) return json({ error: 'Google calendar feed returned an error.' }, 502);
      const raw = await res.text();
      const events = parseIcs(raw);
      return json({ configured: true, events }, 200);
    } catch (_e) {
      return json({ error: 'Unexpected error.' }, 500);
    }
  }

  return json({ error: 'Method not allowed.' }, 405);
});

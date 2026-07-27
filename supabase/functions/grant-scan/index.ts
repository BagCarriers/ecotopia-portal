import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-scan-token',
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

// ── Small helpers ─────────────────────────────────────────────────────────
// Decode the handful of HTML entities Grants.gov/DCNR emit, and collapse space.
function cleanText(v: string): string {
  return String(v || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// MM/DD/YYYY -> YYYY-MM-DD (null-safe; returns null on empty/bad input).
function parseUsDate(v: unknown): string | null {
  if (!v || typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const mm = m[1].padStart(2, '0');
  const dd = m[2].padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

// ── (a) Grants.gov ──────────────────────────────────────────────────────────
const GRANTS_GOV_QUERIES = [
  'native plants',
  'riparian buffer',
  'pollinator habitat',
  'community garden',
  'urban forestry',
  'watershed restoration Pennsylvania',
  'tree planting',
];

// Relevance heuristic for a small PA nonprofit / ecological landscaping org.
// Drop obviously-irrelevant hits; keep the rest (allowlist rescues a few that a
// blocklist word would otherwise catch). Kept intentionally small.
const BLOCK_WORDS = [
  'tribal', 'tribe', 'indian ', 'native american', 'alaska nativ',
  'embassy', 'overseas', 'foreign', 'international', 'abroad', 'u.s. mission',
  'nasa', 'space', 'aeronautic', 'astro', 'satellite',
  'defense', 'military', 'navy', 'army', 'air force', 'weapon', 'missile',
  'nuclear', 'coral reef', 'marine fisher', 'aquaculture', 'coral',
];
const ALLOW_WORDS = [
  'plant', 'native', 'riparian', 'buffer', 'pollinat', 'garden', 'forest',
  'tree', 'watershed', 'habitat', 'wetland', 'stream', 'stormwater',
  'conservation', 'restoration', 'urban green', 'green infrastructure',
  'community', 'landscap', 'ecosystem', 'wildlife', 'nature', 'soil', 'stewardship',
];

function isRelevant(title: string, agency: string): boolean {
  const hay = (title + ' ' + agency).toLowerCase();
  const allowed = ALLOW_WORDS.some((w) => hay.includes(w));
  const blocked = BLOCK_WORDS.some((w) => hay.includes(w));
  // Allowlist rescues a blocked-but-clearly-relevant hit; otherwise a block word
  // drops it. No allow signal at all -> drop (the query already loosely matched).
  if (blocked && !allowed) return false;
  return allowed;
}

interface Opp {
  source: string;
  source_ref: string;
  title: string;
  agency: string | null;
  url: string | null;
  close_date: string | null;
  summary: string | null;
  keywords: string;
}

async function scanGrantsGov(): Promise<Opp[]> {
  // number -> { opp, matched query terms }
  const byNumber = new Map<string, { opp: Opp; terms: Set<string> }>();
  for (const q of GRANTS_GOV_QUERIES) {
    let res: Response;
    try {
      res = await fetch('https://api.grants.gov/v1/api/search2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: q, oppStatuses: 'posted', rows: 50 }),
      });
    } catch (_e) {
      continue; // one query failing must not sink the source; try the rest
    }
    if (!res.ok) continue;
    let payload: any;
    try { payload = await res.json(); } catch (_e) { continue; }
    const hits = payload?.data?.oppHits;
    if (!Array.isArray(hits)) continue;
    for (const h of hits) {
      const number = h?.number ? String(h.number).trim() : '';
      const id = h?.id ? String(h.id).trim() : '';
      if (!number) continue;
      const title = cleanText(h?.title || '');
      const agency = cleanText(h?.agency || h?.agencyName || '');
      if (!title) continue;
      if (!isRelevant(title, agency)) continue;
      const existing = byNumber.get(number);
      if (existing) { existing.terms.add(q); continue; }
      byNumber.set(number, {
        terms: new Set([q]),
        opp: {
          source: 'grants.gov',
          source_ref: number,
          title,
          agency: agency || null,
          url: id ? `https://www.grants.gov/search-results-detail/${id}` : null,
          close_date: parseUsDate(h?.closeDate),
          summary: agency || null,
          keywords: '',
        },
      });
    }
  }
  const out: Opp[] = [];
  for (const { opp, terms } of byNumber.values()) {
    opp.keywords = Array.from(terms).join(', ');
    out.push(opp);
  }
  return out;
}

// ── (b) DCNR grants page (lightweight change-surface, not a parser) ──────────
async function scanDcnr(): Promise<Opp[]> {
  const PAGE = 'https://www.pa.gov/agencies/dcnr/programs-and-services/grants.html';
  let res: Response;
  try {
    res = await fetch(PAGE, { redirect: 'follow' });
  } catch (_e) {
    throw new Error('Could not reach the DCNR grants page.');
  }
  if (!res.ok) throw new Error(`DCNR page returned ${res.status}.`);
  const html = await res.text();

  // Program links: any href under /dcnr/ that mentions "grant". Cap 10, dedupe
  // by path, drop the grants index page itself (it is where we already are).
  const seen = new Set<string>();
  const out: Opp[] = [];
  const re = /href="([^"]*dcnr[^"]*grant[^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 10) {
    const href = m[1].replace(/&amp;/gi, '&').trim();
    // Absolutize + normalize to a path key for dedupe.
    let abs: URL;
    try {
      abs = new URL(href, 'https://www.pa.gov');
    } catch (_e) { continue; }
    const path = abs.pathname.replace(/\/+$/, '');
    // Skip the grants index page itself (…/grants or …/grants.html).
    if (/\/grants(\.html)?$/i.test(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const slug = path.split('/').filter(Boolean).pop() || 'grant';
    const title = 'DCNR: ' + slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    out.push({
      source: 'dcnr',
      source_ref: path,
      title,
      agency: 'PA DCNR',
      url: abs.origin + path,
      close_date: null,
      summary: 'Found on the DCNR grants page. Check the page for current round dates.',
      keywords: 'dcnr',
    });
  }
  return out;
}

// ── (c) DEP Growing Greener (best-effort; skip cleanly if not usable) ────────
async function scanDep(): Promise<Opp[]> {
  const PAGE = 'https://www.pa.gov/agencies/dep/programs-and-services/grants-loans-and-rebates.html';
  let res: Response;
  try {
    res = await fetch(PAGE, { redirect: 'follow' });
  } catch (_e) {
    throw new Error('Could not reach the DEP grants page.');
  }
  if (!res.ok) throw new Error(`DEP page not usable (returned ${res.status}); skipped.`);
  const html = await res.text();
  // Confirm it is the expected server-rendered grants page before trusting it.
  if (!/growing greener|grant/i.test(html)) {
    throw new Error('DEP page structure not recognized; skipped.');
  }
  const seen = new Set<string>();
  const out: Opp[] = [];
  const re = /href="([^"]*dep[^"]*grant[^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 10) {
    const href = m[1].replace(/&amp;/gi, '&').trim();
    let abs: URL;
    try { abs = new URL(href, 'https://www.pa.gov'); } catch (_e) { continue; }
    const path = abs.pathname.replace(/\/+$/, '');
    if (/grants-loans-and-rebates(\.html)?$/i.test(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    const slug = path.split('/').filter(Boolean).pop() || 'grant';
    const title = 'DEP: ' + slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    out.push({
      source: 'dep',
      source_ref: path,
      title,
      agency: 'PA DEP',
      url: abs.origin + path,
      close_date: null,
      summary: 'Found on the DEP grants page. Check the page for current round dates.',
      keywords: 'dep',
    });
  }
  return out;
}

// ── Upsert: refresh content + last_seen, NEVER overwrite staff triage status ─
async function upsertOpps(
  sb: ReturnType<typeof admin>,
  opps: Opp[]
): Promise<number> {
  let upserted = 0;
  for (const o of opps) {
    const now = new Date().toISOString();
    // Does the row already exist? (dedupe on source + source_ref)
    const { data: existing } = await sb.from('grant_opportunities')
      .select('id').eq('source', o.source).eq('source_ref', o.source_ref).maybeSingle();
    if (existing) {
      const { error } = await sb.from('grant_opportunities').update({
        title: o.title,
        agency: o.agency,
        url: o.url,
        close_date: o.close_date,
        summary: o.summary,
        keywords: o.keywords,
        last_seen: now,
        // NOTE: status is intentionally NOT touched - staff triage survives rescans.
      }).eq('id', existing.id);
      if (!error) upserted++;
    } else {
      const { error } = await sb.from('grant_opportunities').insert({
        source: o.source,
        source_ref: o.source_ref,
        title: o.title,
        agency: o.agency,
        url: o.url,
        close_date: o.close_date,
        summary: o.summary,
        keywords: o.keywords,
        status: 'new',
        first_seen: now,
        last_seen: now,
      });
      if (!error) upserted++;
    }
  }
  return upserted;
}

// ── Auth: staff JWT OR the shared cron token ────────────────────────────────
async function authorize(req: Request, sb: ReturnType<typeof admin>): Promise<boolean> {
  const scanToken = req.headers.get('X-Scan-Token');
  const expected = Deno.env.get('GRANT_SCAN_TOKEN');
  if (scanToken && expected && scanToken === expected) return true;

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return false;
  const { data: userData, error: userErr } = await sb.auth.getUser(jwt);
  if (userErr || !userData || !userData.user) return false;
  const { data: pu } = await sb.from('portal_users').select('user_id')
    .eq('user_id', userData.user.id).eq('active', true).maybeSingle();
  return !!pu;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true }, 200);
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    if (body.action !== 'scan') return json({ error: 'Unknown action.' }, 400);

    const sb = admin();
    if (!(await authorize(req, sb))) return json({ error: 'Unauthorized' }, 401);

    // Per-source isolation: one source failing never kills the others.
    const errors: Record<string, string> = {};
    const bySource: Record<string, number> = {};
    let fetched = 0;
    let upserted = 0;

    const sources: Array<[string, () => Promise<Opp[]>]> = [
      ['grants.gov', scanGrantsGov],
      ['dcnr', scanDcnr],
      ['dep', scanDep],
    ];

    for (const [name, fn] of sources) {
      try {
        const opps = await fn();
        fetched += opps.length;
        const n = await upsertOpps(sb, opps);
        upserted += n;
        bySource[name] = n;
      } catch (e) {
        errors[name] = e instanceof Error ? e.message : String(e);
      }
    }

    return json({
      ok: true,
      counts: { fetched, upserted, bySource },
      ...(Object.keys(errors).length ? { errors } : {}),
    }, 200);
  } catch (_e) {
    return json({ error: 'Unexpected error.' }, 500);
  }
});

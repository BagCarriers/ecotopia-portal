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

// THE single implementation of the resolution logic. Importing it for its side
// effect populates globalThis.EcoInat, exactly as the browser does with
// assets/mapping.js. tests/inat.test.js requires the same file, so the tests
// cover this code rather than a copy of it. Do not redeclare any of it here.
import '../_shared/inat-logic.js';
const { normaliseBotanical, isResolvableName, pickTaxon } = (globalThis as any).EcoInat;

const PA_PLACE_ID = 42;
const UA = 'EcotopianEarthCare/1.0 (https://ecotopianearthcare.com; frank.lechner@bagcarriers.com)';
const API = 'https://api.inaturalist.org/v1';

// iNaturalist allows 60 requests per minute. 1100ms between calls keeps us under
// it with margin and is polite to a free community service.
const PACE_MS = 1100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pick = { taxonId: number | null; match: string; matchedName: string | null };

async function inat(pathAndQuery: string): Promise<any> {
  const res = await fetch(API + pathAndQuery, { headers: { 'User-Agent': UA } });
  if (res.status === 429) throw new Error('rate_limited');
  if (!res.ok) throw new Error('inat_http_' + res.status);
  return await res.json();
}

// Pennsylvania establishment plus PA conservation status, from one call.
function readPaFacts(taxon: any): { establishment: string | null; conservation: string | null } {
  const em = taxon && taxon.establishment_means;
  const raw = em && typeof em === 'object' ? String(em.establishment_means || '') : '';
  const establishment = raw === 'introduced' || raw === 'native' ? raw : null;

  let conservation: string | null = null;
  for (const cs of (taxon && taxon.conservation_statuses) || []) {
    const place = cs && cs.place;
    if (place && place.name === 'Pennsylvania' && cs.status) {
      conservation = String(cs.status);
      break;
    }
  }
  return { establishment, conservation };
}

async function resolveAndEnrich(sb: ReturnType<typeof admin>) {
  const { data: rows, error } = await sb
    .from('plant_species')
    .select('id, botanical, inat_taxon_id, inat_match')
    .is('inat_taxon_id', null)
    .or('inat_match.is.null,inat_match.neq.manual');
  if (error) throw new Error(error.message);

  const counts = { examined: 0, resolved: 0, fuzzy: 0, unresolved: 0, enriched: 0 };

  for (const row of rows || []) {
    counts.examined++;
    const norm = normaliseBotanical(row.botanical || '');

    if (!isResolvableName(norm)) {
      // 'Pycnanthemum virginicum & muticum' lands here. No API call, no guess.
      await sb.from('plant_species')
        .update({ inat_match: 'none', inat_synced_at: new Date().toISOString() })
        .eq('id', row.id);
      counts.unresolved++;
      continue;
    }

    let pick: Pick;
    try {
      const search = await inat('/taxa?q=' + encodeURIComponent(norm) + '&per_page=3');
      pick = pickTaxon(norm, search.results || []);
    } catch (_e) {
      // One bad species never aborts the run. It is simply retried tomorrow.
      continue;
    }
    await sleep(PACE_MS);

    if (!pick.taxonId) {
      await sb.from('plant_species')
        .update({ inat_match: 'none', inat_synced_at: new Date().toISOString() })
        .eq('id', row.id);
      counts.unresolved++;
      continue;
    }

    let facts = { establishment: null as string | null, conservation: null as string | null };
    try {
      const detail = await inat('/taxa/' + pick.taxonId + '?place_id=' + PA_PLACE_ID);
      facts = readPaFacts((detail.results || [])[0] || {});
      counts.enriched++;
    } catch (_e) {
      // Enrichment is optional; the taxon link is the valuable part.
    }
    await sleep(PACE_MS);

    await sb.from('plant_species').update({
      inat_taxon_id: pick.taxonId,
      inat_match: pick.match,
      inat_matched_name: pick.matchedName,
      inat_establishment: facts.establishment,
      inat_conservation: facts.conservation,
      inat_synced_at: new Date().toISOString(),
    }).eq('id', row.id);

    if (pick.match === 'fuzzy') counts.fuzzy++;
    else counts.resolved++;
  }

  return counts;
}

// Auth: staff JWT OR the shared cron token. Same shape as grant-scan.
async function authorize(req: Request, sb: ReturnType<typeof admin>): Promise<boolean> {
  const scanToken = req.headers.get('X-Scan-Token');
  const expected = Deno.env.get('INAT_SYNC_TOKEN');
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
    if (body.action !== 'sync') return json({ error: 'Unknown action.' }, 400);

    const sb = admin();
    if (!(await authorize(req, sb))) return json({ error: 'Unauthorized' }, 401);

    const counts = await resolveAndEnrich(sb);
    return json({ ok: true, counts }, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'rate_limited') return json({ error: 'Rate limited, resume later.' }, 429);
    return json({ error: 'Unexpected error.' }, 500);
  }
});

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
const { normaliseBotanical, isResolvableName, pickTaxon, pickPhoto, canAutoFill, isOwnPhoto } =
  (globalThis as any).EcoInat;

const PA_PLACE_ID = 42;
const UA = 'EcotopianEarthCare/1.0 (https://ecotopianearthcare.com; frank.lechner@bagcarriers.com)';
const API = 'https://api.inaturalist.org/v1';

// iNaturalist allows 60 requests per minute. 1100ms between calls keeps us under
// it with margin and is polite to a free community service.
const PACE_MS = 1100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pick = { taxonId: number | null; match: string; matchedName: string | null };

type Counts = {
  examined: number; resolved: number; fuzzy: number;
  unresolved: number; enriched: number; failed: number;
};

type PhotoPick = {
  photoId: number; licence: string; attribution: string; mediumUrl: string; sourceUrl: string;
} | null;

type PhotoCounts = {
  considered: number; filled: number; noUsableLicence: number; noAttribution: number;
  skippedOwn: number; skippedDecided: number; skippedRaced: number; failed: number;
  // Always present, so a caller reading zeros can tell a fill that was switched
  // off from one that ran and found nothing to do. See photoFillEnabled below.
  disabled: boolean;
};

const zeroPhotoCounts = (): PhotoCounts => ({
  considered: 0, filled: 0, noUsableLicence: 0, noAttribution: 0,
  skippedOwn: 0, skippedDecided: 0, skippedRaced: 0, failed: 0, disabled: false,
});

// THE kill switch for the photo pass. Off unless INAT_PHOTO_FILL is exactly
// 'on'; absent, empty, 'true', '1' and anything else all mean off.
//
// Writing photo_path publishes. plants.html reads plant_species live over the
// anon key, so the row write IS the publication, worldwide and immediately, and
// the credit line must be live on the public page before a single CC photo is
// written. That ordering rule has so far been enforced only by a human reading
// the runbook, which held while every run was a person pressing a button. The
// nightly cron makes the pass permanent and unattended, and a cron job cannot
// read a runbook, so the rule becomes a switch that defaults to off. An early
// run put 33 uncredited photos on the live shop; this is what makes a repeat
// take a deliberate act rather than an oversight.
//
// The resolution pass is unaffected: it writes no photo and publishes nothing.
const photoFillEnabled = () => Deno.env.get('INAT_PHOTO_FILL') === 'on';

// iNaturalist's medium_url is usually a .jpg but is sometimes a .png. Storing a
// PNG under a .jpg name with a jpeg content type serves it mislabelled out of a
// public bucket, so both the extension and the content type are taken from what
// was actually downloaded. The header is preferred over the URL because it is
// what the server says the bytes are; the URL is the fallback for a server that
// answers application/octet-stream, and jpeg is the fallback for both.
const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};

export function imageKind(url: string, contentType: string | null): { ext: string; mime: string } {
  const header = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (IMAGE_EXT_BY_MIME[header]) return { ext: IMAGE_EXT_BY_MIME[header], mime: header };

  const bare = String(url || '').split('?')[0].split('#')[0];
  const m = /\.([A-Za-z0-9]+)$/.exec(bare);
  const ext = m ? m[1].toLowerCase() : '';
  if (IMAGE_MIME_BY_EXT[ext]) {
    return { ext: ext === 'jpeg' ? 'jpg' : ext, mime: IMAGE_MIME_BY_EXT[ext] };
  }
  return { ext: 'jpg', mime: 'image/jpeg' };
}

// A rate limit is not a per-row problem. iNaturalist is telling the whole run to
// stop, so this is thrown past the per-row handlers and answered with a 429
// carrying the partial counts. A nightly cron must be able to tell a run that was
// cut short from a run that finished, and an ok:true with zero resolutions cannot
// be told apart from success.
// The payload is deliberately loose: the resolution pass throws its own counts,
// the photo pass throws the whole run's counts with the photo block nested, and
// both need to reach the caller unaltered.
class RateLimited extends Error {
  counts: Record<string, unknown>;
  constructor(counts: Record<string, unknown>) {
    super('rate_limited');
    this.counts = counts;
  }
}

const isRateLimit = (e: unknown) => e instanceof Error && e.message === 'rate_limited';
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The pace lives in a finally so it applies to every request, not only the ones
// that succeed. Pacing on success alone bursts hardest exactly when iNaturalist
// has asked us to slow down: a run of failures would fire one request per row
// with no gap at all. Keeping it here rather than at the call sites means a new
// caller cannot forget it.
async function inat(pathAndQuery: string): Promise<any> {
  try {
    const res = await fetch(API + pathAndQuery, { headers: { 'User-Agent': UA } });
    if (res.status === 429) throw new Error('rate_limited');
    if (!res.ok) throw new Error('inat_http_' + res.status);
    return await res.json();
  } finally {
    await sleep(PACE_MS);
  }
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

  const counts: Counts = {
    examined: 0, resolved: 0, fuzzy: 0, unresolved: 0, enriched: 0, failed: 0,
  };

  for (const row of rows || []) {
    counts.examined++;
    const norm = normaliseBotanical(row.botanical || '');

    if (!isResolvableName(norm)) {
      // 'Pycnanthemum virginicum & muticum' lands here. No API call, no guess.
      //
      // The error is checked for the same reason the photo pass checks it:
      // discarding a PostgREST result makes a write that did not happen
      // indistinguishable from one that did, and these counts are the only
      // evidence a nightly cron leaves behind. .select() is not needed here (the
      // predicate is .eq('id', ...) on a row just read, so a zero-row match is
      // near-impossible); an unnoticed error is the real risk.
      const { error: updErr } = await sb.from('plant_species')
        .update({ inat_match: 'none', inat_synced_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updErr) {
        console.error('inat-sync: write failed for', row.botanical, updErr.message);
        counts.failed++;
        continue;
      }
      counts.unresolved++;
      continue;
    }

    let pick: Pick;
    try {
      const search = await inat('/taxa?q=' + encodeURIComponent(norm) + '&per_page=3');
      pick = pickTaxon(norm, search.results || []);
    } catch (e) {
      if (isRateLimit(e)) throw new RateLimited(counts);
      // One bad species never aborts the run. It is simply retried tomorrow. The
      // log line is the only diagnostic a nightly cron leaves behind, and counts
      // .failed is what stops examined silently exceeding the other totals.
      console.error('inat-sync: taxon search failed for', row.botanical, errorMessage(e));
      counts.failed++;
      continue;
    }

    if (!pick.taxonId) {
      const { error: updErr } = await sb.from('plant_species')
        .update({ inat_match: 'none', inat_synced_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updErr) {
        console.error('inat-sync: write failed for', row.botanical, updErr.message);
        counts.failed++;
        continue;
      }
      counts.unresolved++;
      continue;
    }

    let facts = { establishment: null as string | null, conservation: null as string | null };
    let stopped: RateLimited | null = null;
    try {
      const detail = await inat('/taxa/' + pick.taxonId + '?place_id=' + PA_PLACE_ID);
      facts = readPaFacts((detail.results || [])[0] || {});
      counts.enriched++;
    } catch (e) {
      // Enrichment is optional; the taxon link is the valuable part, so the row is
      // written below either way. A rate limit still ends the run, but only after
      // this row's link is saved: the plan keeps partial progress.
      if (isRateLimit(e)) stopped = new RateLimited(counts);
      else console.error('inat-sync: enrichment failed for', row.botanical, errorMessage(e));
    }

    const { error: updErr } = await sb.from('plant_species').update({
      inat_taxon_id: pick.taxonId,
      inat_match: pick.match,
      inat_matched_name: pick.matchedName,
      inat_establishment: facts.establishment,
      inat_conservation: facts.conservation,
      inat_synced_at: new Date().toISOString(),
    }).eq('id', row.id);

    if (updErr) {
      // A link that was not saved is not a resolution. Counting it as one would
      // report progress the next run has to make all over again.
      console.error('inat-sync: write failed for', row.botanical, updErr.message);
      counts.failed++;
    } else if (pick.match === 'fuzzy') {
      counts.fuzzy++;
    } else {
      counts.resolved++;
    }

    // A rate limit still ends the run whether or not this row's write landed.
    if (stopped) throw stopped;
  }

  return counts;
}

// Copies one licence-clean photograph into the gallery bucket for each species
// that has no photograph at all.
//
// Two independent defences stand between this function and Jordan's own
// photography, and both are meant to be here:
//   1. the database filters, .is('photo_path', null) on the SELECT and repeated
//      on the UPDATE, so a concurrent staff upload cannot be clobbered even if
//      the row was eligible when it was read;
//   2. canAutoFill, THE eligibility rule, which lives in _shared/inat-logic.js
//      and is called rather than restated. Restating it here would be strictly
//      weaker: a hand-written photo_path check does not refuse a row carrying a
//      bare inat_photo_id, which is exactly the shape a staff rejection leaves
//      behind.
export async function fillPhotos(sb: ReturnType<typeof admin>) {
  // The switch is read before anything else, so a disabled run makes no iNat
  // request, no storage write and no database write. Not even the SELECT.
  if (!photoFillEnabled()) {
    console.error('inat-sync: photo fill is switched off (INAT_PHOTO_FILL is not "on")');
    return { ...zeroPhotoCounts(), disabled: true };
  }

  const { data: rows, error } = await sb
    .from('plant_species')
    .select('id, common, inat_taxon_id, photo_path, inat_photo_id, inat_photo_status')
    .not('inat_taxon_id', 'is', null)
    .is('photo_path', null);
  if (error) throw new Error(error.message);

  const counts: PhotoCounts = zeroPhotoCounts();

  for (const row of rows || []) {
    const candidate = {
      photoPath: row.photo_path,
      inatPhotoId: row.inat_photo_id,
      inatPhotoStatus: row.inat_photo_status,
    };
    if (!canAutoFill(candidate)) {
      // Split only so the report can tell the destructive-risk case apart from a
      // routine one. isOwnPhoto is the same predicate canAutoFill consulted.
      if (isOwnPhoto(candidate)) counts.skippedOwn++;
      else counts.skippedDecided++;
      continue;
    }
    counts.considered++;

    let pick: PhotoPick = null;
    try {
      const detail = await inat('/taxa/' + row.inat_taxon_id);
      pick = pickPhoto((detail.results || [])[0] || {});
    } catch (e) {
      if (isRateLimit(e)) throw new RateLimited(counts);
      console.error('inat-sync: photo lookup failed for', row.common, errorMessage(e));
      counts.failed++;
      continue;
    }

    if (!pick) {
      counts.noUsableLicence++;
      continue;
    }

    // CC-BY and CC-BY-SA both require the credit to be shown. iNaturalist
    // sometimes returns a usable licence code with no attribution string at
    // all, and an image we cannot credit is no more publishable on a storefront
    // than a NonCommercial one, so it is refused on the same footing.
    if (!String(pick.attribution || '').trim()) {
      counts.noAttribution++;
      continue;
    }

    if (!pick.mediumUrl) {
      console.error('inat-sync: photo has no medium_url for', row.common);
      counts.failed++;
      continue;
    }

    let bytes: ArrayBuffer;
    let kind: { ext: string; mime: string };
    try {
      const img = await fetch(pick.mediumUrl, { headers: { 'User-Agent': UA } });
      if (!img.ok) throw new Error('photo_http_' + img.status);
      kind = imageKind(pick.mediumUrl, img.headers.get('content-type'));
      bytes = await img.arrayBuffer();
    } catch (e) {
      console.error('inat-sync: photo download failed for', row.common, errorMessage(e));
      counts.failed++;
      continue;
    }

    const objectPath = 'plants/' + crypto.randomUUID() + '.' + kind.ext;
    const up = await sb.storage.from('gallery')
      .upload(objectPath, bytes, { contentType: kind.mime, upsert: false });
    if (up.error) {
      console.error('inat-sync: storage upload failed for', row.common, up.error.message);
      counts.failed++;
      continue;
    }

    // Storage first, row second. If the update fails we leak one orphan object,
    // which is harmless. The reverse order would point a row at a missing image.
    //
    // The two IS NULL conditions mirror canAutoFill at the database, so the two
    // layers refuse the same rows: photo_path catches a staff upload and
    // inat_photo_id catches a staff rejection, either of which can land in the
    // window between the SELECT above and this write, when the in-memory guard
    // is working from stale data.
    //
    // .select('id') is not decoration. PostgREST returns error: null when the
    // predicate matches no rows, so without asking for the rows back an UPDATE
    // the guard REFUSED is indistinguishable from one that wrote, and the run
    // would report a fill that never happened. The counts are the only evidence
    // a nightly cron leaves behind.
    const { data: updated, error: updErr } = await sb.from('plant_species').update({
      photo_path: objectPath,
      inat_photo_id: pick.photoId,
      inat_photo_license: pick.licence,
      inat_photo_attribution: pick.attribution,
      inat_photo_source_url: pick.sourceUrl,
      inat_photo_status: 'auto',
      inat_synced_at: new Date().toISOString(),
    }).eq('id', row.id).is('photo_path', null).is('inat_photo_id', null).select('id');
    if (updErr) {
      console.error('inat-sync: row update failed for', row.common, updErr.message);
      counts.failed++;
      continue;
    }
    if (!updated || updated.length === 0) {
      // Staff got there first. Nothing is corrupted and the uploaded object is
      // left orphaned, which is harmless, but this is emphatically not a fill.
      console.error('inat-sync: photo write refused by the row guard for', row.common);
      counts.skippedRaced++;
      continue;
    }
    counts.filled++;
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
    let photos: PhotoCounts;
    try {
      photos = await fillPhotos(sb);
    } catch (e) {
      // A rate limit in the photo pass ends the run, but the resolutions this
      // run already earned are real and must still be reported.
      if (e instanceof RateLimited) throw new RateLimited({ ...counts, photos: e.counts });
      throw e;
    }
    return json({ ok: true, counts: { ...counts, photos } }, 200);
  } catch (e) {
    if (e instanceof RateLimited) {
      console.error('inat-sync: stopped by iNaturalist rate limiting', JSON.stringify(e.counts));
      return json({ error: 'Rate limited, resume later.', counts: e.counts }, 429);
    }
    console.error('inat-sync: unexpected error', errorMessage(e));
    return json({ error: 'Unexpected error.' }, 500);
  }
});

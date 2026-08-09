/**
 * Ecotopia Portal - iNaturalist enrichment logic.
 *
 * THE single implementation. supabase/functions/inat-sync/index.ts imports this
 * file and tests/inat.test.js requires it, so the tests cover the code that runs
 * in production. Do not copy any of it anywhere.
 *
 * Pure functions only: no network, no DOM, no Supabase client. Written in the same
 * universal style as assets/mapping.js, so the one file loads under Deno (via a
 * side-effect import) and under Node (via require), both reading globalThis.EcoInat.
 */
(function (root) {
  // Commercially usable licences ONLY. Ecotopia sells plants, so every
  // NonCommercial variant is excluded. Adding one here puts a non-commercial
  // photograph on a storefront.
  const PHOTO_LICENCES = ['cc0', 'cc-by', 'cc-by-sa', 'pd'];

  const isUsableLicence = (code) =>
    PHOTO_LICENCES.indexOf(String(code || '').toLowerCase()) !== -1;

  // The catalogue contains typographic apostrophes; iNaturalist wants ASCII.
  const normaliseBotanical = (name) =>
    String(name || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

  // A resolvable name is a single binomial. Anything else (a genus alone, or two
  // species joined with '&' as in 'Pycnanthemum virginicum & muticum') is refused
  // here so no API call is wasted and no guess is made.
  const isResolvableName = (name) =>
    /^[A-Z][a-z]+ [a-z][a-z-]+$/.test(normaliseBotanical(name));

  function levenshtein(a, b) {
    a = String(a); b = String(b);
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[n];
  }

  const NO_MATCH = { taxonId: null, match: 'none', matchedName: null };

  function pickTaxon(botanical, results) {
    const norm = normaliseBotanical(botanical);
    if (!isResolvableName(norm)) return { ...NO_MATCH };
    const rows = Array.isArray(results) ? results.filter((r) => r && r.name) : [];

    const exact = rows.find((r) => String(r.name).toLowerCase() === norm.toLowerCase());
    if (exact) return { taxonId: exact.id, match: 'exact', matchedName: exact.name };

    // Fuzzy: same genus, and an epithet within a Levenshtein distance of 2.
    // Exactly one candidate may qualify. Two or more is a no match, never a guess.
    const [genus, epithet] = norm.toLowerCase().split(' ');
    const near = rows.filter((r) => {
      const parts = String(r.name).toLowerCase().split(' ');
      return parts.length === 2 && parts[0] === genus && levenshtein(parts[1], epithet) <= 2;
    });
    if (near.length === 1) {
      return { taxonId: near[0].id, match: 'fuzzy', matchedName: near[0].name };
    }
    return { ...NO_MATCH };
  }

  function pickPhoto(taxon) {
    const t = taxon || {};
    const candidates = [t.default_photo]
      .concat((t.taxon_photos || []).map((tp) => tp && tp.photo))
      .filter(Boolean);
    const hit = candidates.find((p) => isUsableLicence(p.license_code));
    if (!hit) return null;
    return {
      photoId: hit.id,
      licence: String(hit.license_code).toLowerCase(),
      attribution: hit.attribution || '',
      mediumUrl: hit.medium_url || '',
      sourceUrl: 'https://www.inaturalist.org/photos/' + hit.id,
    };
  }

  // A photo_path with no inat_photo_id is Jordan's own photograph. The sync must
  // never modify one. This is the guard whose failure is destructive and silent.
  const isOwnPhoto = (row) => !!(row && row.photoPath && !row.inatPhotoId);

  // Eligible means no photograph of Jordan's and no prior iNaturalist decision of any
  // kind. It delegates to isOwnPhoto instead of re-reading photoPath, so the two can
  // never drift and the mutation-proven guard is the one standing on the write path.
  // An inatPhotoId means the row has already been through the pipeline whatever its
  // status, so the sync must not propose a second photo for it. Checking the id here
  // rather than trusting a later pass to write photoPath keeps this guard standing on
  // its own, not on an invariant enforced in another file.
  const canAutoFill = (row) => {
    const r = row || {};
    if (isOwnPhoto(r)) return false;
    if (r.inatPhotoId) return false;
    if (r.inatPhotoStatus === 'rejected') return false;
    return true;
  };

  const establishmentLabel = (value) => {
    const v = String(value || '').toLowerCase();
    return v === 'introduced' || v === 'native' ? v : 'unknown';
  };

  root.EcoInat = {
    PHOTO_LICENCES, isUsableLicence, normaliseBotanical, isResolvableName,
    levenshtein, pickTaxon, pickPhoto, isOwnPhoto, canAutoFill, establishmentLabel,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

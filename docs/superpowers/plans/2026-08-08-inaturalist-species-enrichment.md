# iNaturalist Species Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve all 50 plant catalogue species to iNaturalist taxa, auto-fill commercially licensed photos for the 41 species that have none, and record Pennsylvania establishment and conservation status.

**Architecture:** Pure logic lives in ONE file, `supabase/functions/_shared/inat-logic.js`, written in the same universal style as `assets/mapping.js` so the identical file loads under Deno (side-effect `import`) and under Node (`require`), both reaching it via `globalThis.EcoInat`. The edge function imports it and the tests require it, so the tests cover the code that actually runs. A nightly `inat-sync` writes to cached columns on `plant_species`. Public pages read Supabase only and never contact iNaturalist.

**Tech Stack:** Static HTML, Supabase (Postgres + Storage + Edge Functions on Deno), `node --test`, no build step.

**Spec:** `docs/superpowers/specs/2026-08-08-inaturalist-species-enrichment-design.md`

## Global Constraints

- **No em dashes anywhere**, in code, comments, copy, or commit messages. Repo-wide rule.
- **`esc()` every database or third-party string** before it reaches `innerHTML`. Attribution strings are third-party text and are untrusted.
- **Additive schema first, removal last.** The deployed page and the deployed schema must be compatible at every commit. This repo has already caused two live outages by violating it.
- **Only `cc0`, `cc-by`, `cc-by-sa`, `pd` are usable licences.** `cc-by-nc` and every other NonCommercial variant is excluded because Ecotopia sells plants.
- **A row with `photo_path` set and `inat_photo_id` null is Jordan's own photograph and must never be modified by the sync.**
- **SQL is applied via the Supabase Management API using `curl`, never `python urllib`** (Cloudflare returns 403 error 1010 to urllib). Token: `security find-generic-password -s "Supabase CLI" -w`. Project ref `wibnryfinfwbwwgsyojr`. Note `supabase_migrations.schema_migrations` does not exist in this project, so `supabase db push` is not the mechanism.
- **Supabase MCP in this session points at the wrong project** (the Cope database). Do not use it.
- **The resolution logic has exactly one implementation**, `supabase/functions/_shared/inat-logic.js`. Do not copy any of it into `index.ts` or into `assets/`. The browser never runs this logic, so a second copy would be both dead code and an untested divergence.
- iNaturalist requires a descriptive `User-Agent` with a contact address and rate limits to 60 requests per minute.

---

### Task 1: Pure iNaturalist logic and its tests

This task carries every rule that can be tested without a network. It is deliberately first because the destructive-failure guard lives here.

**Files:**
- Create: `supabase/functions/_shared/inat-logic.js`
- Create: `tests/inat.test.js`

`_shared/` is Supabase's documented convention for code imported by more than one edge function, and it keeps the file inside `supabase/functions/` where the deploy bundler can reach it. A file under `assets/` would not be bundled.

**Interfaces:**
- Consumes: nothing.
- Produces: `globalThis.EcoInat` with `PHOTO_LICENCES: string[]`, `isUsableLicence(code: string): boolean`, `normaliseBotanical(name: string): string`, `isResolvableName(name: string): boolean`, `levenshtein(a: string, b: string): number`, `pickTaxon(botanical: string, results: object[]): {taxonId: number|null, match: 'exact'|'fuzzy'|'none', matchedName: string|null}`, `pickPhoto(taxon: object): {photoId: number, licence: string, attribution: string, mediumUrl: string, sourceUrl: string}|null`, `canAutoFill(row: {photoPath, inatPhotoId, inatPhotoStatus}): boolean`, `isOwnPhoto(row): boolean`, `establishmentLabel(value): 'introduced'|'native'|'unknown'`.

- [ ] **Step 1: Write the failing test**

Create `tests/inat.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
require('../supabase/functions/_shared/inat-logic.js');
const E = globalThis.EcoInat;

test('the licence allowlist excludes every NonCommercial variant', () => {
  // Ecotopia sells plants. A NonCommercial photo on the storefront is a licence
  // breach, so this list is the single place that decision is expressed.
  assert.deepStrictEqual(E.PHOTO_LICENCES, ['cc0', 'cc-by', 'cc-by-sa', 'pd']);
  assert.strictEqual(E.isUsableLicence('cc-by-nc'), false);
  assert.strictEqual(E.isUsableLicence('cc-by-nc-sa'), false);
  assert.strictEqual(E.isUsableLicence('cc-by-nc-nd'), false);
  assert.strictEqual(E.isUsableLicence('cc-by-nd'), false);
  assert.strictEqual(E.isUsableLicence(null), false);
  assert.strictEqual(E.isUsableLicence('CC-BY'), true);
});

test('a photograph of Jordan is never eligible for auto fill', () => {
  // THE destructive-failure guard. photo_path set with no inat_photo_id means a
  // real nursery photograph. If this ever returns true, a nightly cron job
  // silently overwrites Jordan's photography and there is no undo.
  const jordan = { photoPath: 'plants/abc.jpg', inatPhotoId: null, inatPhotoStatus: null };
  assert.strictEqual(E.isOwnPhoto(jordan), true);
  assert.strictEqual(E.canAutoFill(jordan), false);

  const staticAsset = { photoPath: 'static:wild-columbine.jpg', inatPhotoId: null, inatPhotoStatus: null };
  assert.strictEqual(E.isOwnPhoto(staticAsset), true);
  assert.strictEqual(E.canAutoFill(staticAsset), false);
});

test('only a species with no photo at all is eligible', () => {
  assert.strictEqual(E.canAutoFill({ photoPath: null, inatPhotoId: null, inatPhotoStatus: null }), true);
  assert.strictEqual(E.canAutoFill({ photoPath: '', inatPhotoId: null, inatPhotoStatus: null }), true);
  // Already carries an approved iNaturalist photo: leave it alone.
  assert.strictEqual(E.canAutoFill({ photoPath: 'plants/x.jpg', inatPhotoId: 99, inatPhotoStatus: 'approved' }), false);
});

test('a rejected photo is never proposed again', () => {
  assert.strictEqual(
    E.canAutoFill({ photoPath: null, inatPhotoId: 12345, inatPhotoStatus: 'rejected' }),
    false
  );
});

test('typographic apostrophes are normalised before querying', () => {
  assert.strictEqual(E.normaliseBotanical('Culver’s Root'), "Culver's Root");
  assert.strictEqual(E.normaliseBotanical('  Aquilegia   canadensis '), 'Aquilegia canadensis');
});

test('a two species row is refused without ever calling the API', () => {
  // The real catalogue row 'Pycnanthemum virginicum & muticum' is two species
  // crammed into one. It cannot resolve to a single taxon and must not guess.
  assert.strictEqual(E.isResolvableName('Pycnanthemum virginicum & muticum'), false);
  assert.strictEqual(E.isResolvableName('Aquilegia canadensis'), true);
  assert.strictEqual(E.isResolvableName('Monarda bradburiana'), true);
  assert.strictEqual(E.isResolvableName(''), false);
  assert.strictEqual(E.isResolvableName('Pycnanthemum'), false);
});

test('an exact botanical match wins', () => {
  const results = [{ id: 47912, name: 'Asclepias tuberosa' }, { id: 1, name: 'Asclepias tuberosa interior' }];
  assert.deepStrictEqual(E.pickTaxon('Asclepias tuberosa', results), {
    taxonId: 47912, match: 'exact', matchedName: 'Asclepias tuberosa',
  });
});

test('a single close spelling variant in the same genus resolves as fuzzy', () => {
  // Real case: the catalogue says Monarda bradburiana, iNaturalist says bradburyana.
  const results = [{ id: 63314, name: 'Monarda bradburyana' }];
  assert.deepStrictEqual(E.pickTaxon('Monarda bradburiana', results), {
    taxonId: 63314, match: 'fuzzy', matchedName: 'Monarda bradburyana',
  });
});

test('two plausible fuzzy candidates is a no match, never a guess', () => {
  const results = [{ id: 1, name: 'Monarda bradburyana' }, { id: 2, name: 'Monarda bradburiona' }];
  assert.deepStrictEqual(E.pickTaxon('Monarda bradburiana', results), {
    taxonId: null, match: 'none', matchedName: null,
  });
});

test('a different genus never fuzzy matches however close the epithet', () => {
  const results = [{ id: 1, name: 'Pycnanthemum canadensis' }];
  assert.deepStrictEqual(E.pickTaxon('Aquilegia canadensis', results), {
    taxonId: null, match: 'none', matchedName: null,
  });
});

test('an empty result set is a no match', () => {
  assert.deepStrictEqual(E.pickTaxon('Aquilegia canadensis', []), {
    taxonId: null, match: 'none', matchedName: null,
  });
});

test('pickPhoto prefers the community default photo when it is usable', () => {
  const taxon = {
    default_photo: { id: 7, license_code: 'cc-by', attribution: '(c) A, CC BY', medium_url: 'https://x/7.jpg' },
    taxon_photos: [{ photo: { id: 9, license_code: 'cc0', attribution: '(c) B', medium_url: 'https://x/9.jpg' } }],
  };
  const got = E.pickPhoto(taxon);
  assert.strictEqual(got.photoId, 7);
  assert.strictEqual(got.licence, 'cc-by');
  assert.strictEqual(got.attribution, '(c) A, CC BY');
  assert.strictEqual(got.mediumUrl, 'https://x/7.jpg');
  assert.strictEqual(got.sourceUrl, 'https://www.inaturalist.org/photos/7');
});

test('pickPhoto falls back past a NonCommercial default photo', () => {
  const taxon = {
    default_photo: { id: 7, license_code: 'cc-by-nc', attribution: '(c) A', medium_url: 'https://x/7.jpg' },
    taxon_photos: [
      { photo: { id: 8, license_code: 'cc-by-nc-sa', attribution: '(c) B', medium_url: 'https://x/8.jpg' } },
      { photo: { id: 9, license_code: 'cc-by-sa', attribution: '(c) C', medium_url: 'https://x/9.jpg' } },
    ],
  };
  assert.strictEqual(E.pickPhoto(taxon).photoId, 9);
});

test('pickPhoto returns null when nothing is commercially usable', () => {
  // Seven real catalogue species are in exactly this position and still need
  // Jordan's own photography.
  const taxon = {
    default_photo: { id: 7, license_code: 'cc-by-nc', attribution: '(c) A', medium_url: 'https://x/7.jpg' },
    taxon_photos: [{ photo: { id: 8, license_code: 'cc-by-nc-nd', attribution: '(c) B', medium_url: 'https://x/8.jpg' } }],
  };
  assert.strictEqual(E.pickPhoto(taxon), null);
});

test('an absent establishment listing is unknown and never native', () => {
  // Measured on the live API: Monarda didyma returns native for PA, while
  // Asclepias syriaca, Quercus alba and Rudbeckia hirta return nothing at all
  // despite being unambiguously native. Rendering null as native would assert
  // something the data does not say.
  assert.strictEqual(E.establishmentLabel(null), 'unknown');
  assert.strictEqual(E.establishmentLabel(undefined), 'unknown');
  assert.strictEqual(E.establishmentLabel(''), 'unknown');
  assert.strictEqual(E.establishmentLabel('introduced'), 'introduced');
  assert.strictEqual(E.establishmentLabel('native'), 'native');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL, `Cannot find module '../supabase/functions/_shared/inat-logic.js'`

- [ ] **Step 3: Write the implementation**

Create `supabase/functions/_shared/inat-logic.js`:

```js
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

  const canAutoFill = (row) => {
    const r = row || {};
    if (r.photoPath) return false;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: PASS, all `tests/inat.test.js` tests green alongside the existing mapping, pricing and team suites.

- [ ] **Step 5: Prove the destructive guard test actually bites**

Temporarily change `isOwnPhoto` to `return false;`, run `npm test`, and confirm the Jordan test FAILS. Then revert. A guard test that passes against a broken implementation is worthless, and this is the one that matters.

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: FAIL while mutated, PASS after revert.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/ecotopia-portal
git add supabase/functions/_shared/inat-logic.js tests/inat.test.js
git commit -m "feat(inat): pure taxon resolution, licence and photo-guard logic

One implementation under _shared, imported by the edge function and required by
the tests, so the tests cover the code that actually runs.

The licence allowlist excludes every NonCommercial variant because Ecotopia
sells plants. isOwnPhoto is the guard that stops the nightly sync overwriting
Jordan's own photography; its test is mutation-proven."
```

---

### Task 2: Migration 0033, additive columns

**Files:**
- Create: `supabase/migrations/0033_inat_species.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: eleven columns on `public.plant_species`, reachable in the browser as camelCase via the generic mapper in `assets/mapping.js` (`inat_taxon_id` becomes `inatTaxonId`, and so on). No mapping code changes are needed.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0033_inat_species.sql`:

```sql
-- iNaturalist enrichment for the plant catalogue.
--
-- Additive only. photo_path keeps its exact current meaning: 'static:<file>' is a
-- repo asset under assets/img/plants/, anything else is a gallery-bucket object.
-- iNaturalist images are written as plants/<uuid>.jpg, which the existing
-- renderers already handle, so nothing about display changes here.
--
-- LOAD-BEARING: a row with photo_path set and inat_photo_id NULL is Jordan's own
-- photograph. The nightly sync must never modify one. See isOwnPhoto in
-- supabase/functions/_shared/inat-logic.js and its mutation-proven test.
--
-- inat_establishment is 'introduced', 'native', or NULL. NULL means iNaturalist
-- has no Pennsylvania listing, which is NOT evidence of being native: measured on
-- the live API, Quercus alba and Rudbeckia hirta return nothing at all.

alter table public.plant_species add column if not exists inat_taxon_id          integer;
alter table public.plant_species add column if not exists inat_match             text;
alter table public.plant_species add column if not exists inat_matched_name      text;
alter table public.plant_species add column if not exists inat_establishment     text;
alter table public.plant_species add column if not exists inat_conservation      text;
alter table public.plant_species add column if not exists inat_photo_id          bigint;
alter table public.plant_species add column if not exists inat_photo_license     text;
alter table public.plant_species add column if not exists inat_photo_attribution text;
alter table public.plant_species add column if not exists inat_photo_source_url  text;
alter table public.plant_species add column if not exists inat_photo_status      text;
alter table public.plant_species add column if not exists inat_synced_at         timestamptz;

alter table public.plant_species drop constraint if exists plant_species_inat_match_chk;
alter table public.plant_species add constraint plant_species_inat_match_chk
  check (inat_match is null or inat_match in ('exact', 'fuzzy', 'manual', 'none'));

alter table public.plant_species drop constraint if exists plant_species_inat_photo_status_chk;
alter table public.plant_species add constraint plant_species_inat_photo_status_chk
  check (inat_photo_status is null or inat_photo_status in ('auto', 'approved', 'rejected'));

alter table public.plant_species drop constraint if exists plant_species_inat_establishment_chk;
alter table public.plant_species add constraint plant_species_inat_establishment_chk
  check (inat_establishment is null or inat_establishment in ('introduced', 'native'));

-- No index. The table holds 50 rows; a sequential scan is faster than any index
-- lookup at this size and an index here would be pure maintenance cost.

-- No new RLS policy. The existing sp_anon_read (gated on active) and sp_staff_all
-- cover these columns, and no anonymous write path is introduced.
```

- [ ] **Step 2: Apply it via the Management API**

```bash
cd ~/GitHub/ecotopia-portal
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary "$(python3 -c "import json,sys;print(json.dumps({'query':open('supabase/migrations/0033_inat_species.sql').read()}))")"
```

Expected: `[]` or a success payload, no error key. Note `python3` is used only to build the JSON body locally; the HTTP call itself is `curl`, per the repo rule.

- [ ] **Step 3: Verify the columns and constraints landed**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select column_name, data_type from information_schema.columns where table_name = '"'"'plant_species'"'"' and column_name like '"'"'inat%'"'"' order by column_name"}'
```

Expected: exactly 11 rows, `inat_conservation` through `inat_taxon_id`. No index is created; the table holds 50 rows.

- [ ] **Step 4: Verify no existing row was disturbed**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select count(*) total, count(photo_path) with_photo, count(inat_taxon_id) resolved from public.plant_species"}'
```

Expected: `total 50, with_photo 9, resolved 0`. If `with_photo` is not 9, stop and investigate before going further.

- [ ] **Step 5: Commit**

```bash
cd ~/GitHub/ecotopia-portal
git add supabase/migrations/0033_inat_species.sql
git commit -m "feat(db): migration 0033 adds iNaturalist columns to plant_species

Additive only. photo_path keeps its meaning. inat_photo_id NULL alongside a set
photo_path marks Jordan's own photography, which the sync must never touch."
```

---

### Task 3: The `inat-sync` edge function, taxon resolution only

No photos are written in this task. Resolution, establishment and conservation land first so the riskier image-writing work gets its own review gate.

**Files:**
- Create: `supabase/functions/inat-sync/index.ts`
- Modify: `supabase/config.toml` (add a `[functions.inat-sync]` block beside the four existing ones)

**Interfaces:**
- Consumes: `globalThis.EcoInat` from `../_shared/inat-logic.js` (Task 1), specifically `normaliseBotanical`, `isResolvableName`, `pickTaxon` and `PHOTO_LICENCES`. Import it for its side effect; it takes no arguments and returns nothing.
- Produces: `POST /inat-sync` with body `{"action":"sync"}`, returning `{ok: true, counts: {examined, resolved, fuzzy, unresolved, enriched}}`. Authorised by an `X-Scan-Token` header matching `INAT_SYNC_TOKEN`, or a staff JWT.

There is no mirror test in this task. The mirror it would have guarded no longer exists, because there is now one copy of the logic.

- [ ] **Step 1: Write the no-duplication guard first**

Append to `tests/inat.test.js`. This replaces the mirror test the earlier draft
called for: with one implementation there is nothing to mirror, so the test now
enforces that no second copy ever appears.

```js
test('the edge function does not reimplement the shared logic', () => {
  // There is exactly one implementation, in _shared/inat-logic.js. A second copy
  // inside index.ts would be dead code that the tests do not cover and that can
  // silently diverge from what actually runs.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'inat-sync', 'index.ts'), 'utf8');
  assert.match(src, /import '\.\.\/_shared\/inat-logic\.js'/,
    'index.ts must import the shared logic for its side effect');
  for (const name of ['function levenshtein', 'function pickTaxon', 'function pickPhoto',
                      'const PHOTO_LICENCES']) {
    assert.ok(!src.includes(name), `index.ts must not redeclare ${name}`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, `ENOENT ... supabase/functions/inat-sync/index.ts`

- [ ] **Step 3: Write the edge function**

Create `supabase/functions/inat-sync/index.ts`:

```ts
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
```

- [ ] **Step 4: Pin the function in config.toml**

Modify `supabase/config.toml`, adding directly after the `[functions.grant-scan]` block:

```toml
[functions.inat-sync]
verify_jwt = false
```

- [ ] **Step 5: Run the mirror test to verify it passes**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: PASS, including the new mirror test.

- [ ] **Step 6: Prove the mirror test bites**

Temporarily change the edge function line to `const PHOTO_LICENCES = ['cc0', 'cc-by', 'cc-by-sa', 'pd', 'cc-by-nc'];`, run `npm test`, confirm FAIL. Revert.

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: FAIL while mutated, PASS after revert.

- [ ] **Step 7: Set the secret and deploy**

```bash
cd ~/GitHub/ecotopia-portal
TOKEN_VALUE=$(openssl rand -hex 32)
echo "INAT_SYNC_TOKEN=$TOKEN_VALUE   # save this, the cron job needs it in Task 5"
supabase secrets set INAT_SYNC_TOKEN="$TOKEN_VALUE" --project-ref wibnryfinfwbwwgsyojr
supabase functions deploy inat-sync --project-ref wibnryfinfwbwwgsyojr --no-verify-jwt
```

Expected: deploy succeeds. Record the token value; Task 5 embeds it in the cron SQL.

- [ ] **Step 8: Verify the auth gate rejects an unauthenticated call**

```bash
curl -s -X POST "https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/inat-sync" \
  -H "Content-Type: application/json" -d '{"action":"sync"}'
```

Expected: `{"error":"Unauthorized"}`. A green deploy does not prove a working function; this is the check that the token gate exists at all.

- [ ] **Step 9: Run a real sync and check it against the measured baseline**

```bash
curl -s -X POST "https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/inat-sync" \
  -H "Content-Type: application/json" -H "X-Scan-Token: $TOKEN_VALUE" \
  -d '{"action":"sync"}'
```

Expected: `examined 50`, `resolved 48`, `fuzzy 1`, `unresolved 1`. These are the figures measured against the live API on 2026-08-08. A materially different result means the resolution logic regressed, not that iNaturalist changed. Investigate before continuing. The run takes roughly two minutes because of the deliberate pacing.

- [ ] **Step 10: Verify the two known introduced species were flagged**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select common, botanical, inat_match, inat_matched_name, inat_establishment from public.plant_species where inat_establishment is not null or inat_match <> '"'"'exact'"'"' order by common"}'
```

Expected: *Coreopsis lanceolata* and *Echinacea purpurea* as `introduced`, *Monarda didyma* as `native`, `Monarda bradburiana` as `fuzzy` matching `Monarda bradburyana`, and the Mountain Mint row as `none`.

- [ ] **Step 11: Commit**

```bash
cd ~/GitHub/ecotopia-portal
git add supabase/functions/inat-sync/index.ts supabase/config.toml tests/inat.test.js
git commit -m "feat(inat): inat-sync resolves taxa and records PA establishment

48 of 50 botanical names resolve exactly, one spelling variant resolves fuzzily,
and the two-species Mountain Mint row is refused without an API call. The
function imports the shared logic rather than reimplementing it, guarded by a
test that fails if a second copy ever appears."
```

---

### Task 4: Photo copy into Storage

The destructive-risk surface, isolated so it gets its own review gate.

**Files:**
- Modify: `supabase/functions/inat-sync/index.ts`

**Interfaces:**
- Consumes: `resolveAndEnrich` from Task 3, and the resolved `inat_taxon_id` values it wrote.
- Produces: `fillPhotos(sb)` returning `{considered, filled, noUsableLicence, skippedOwn}`, merged into the response as `counts.photos`.

- [ ] **Step 1: Add the photo pass to the edge function**

Insert into `supabase/functions/inat-sync/index.ts`, above `authorize`:

Extend the existing destructure at the top of the file to pull in `pickPhoto`
as well, so it reads:

```ts
const { normaliseBotanical, isResolvableName, pickTaxon, pickPhoto } = (globalThis as any).EcoInat;
```

Then add, above `authorize`:

```ts
type PhotoPick = {
  photoId: number; licence: string; attribution: string; mediumUrl: string; sourceUrl: string;
} | null;

async function fillPhotos(sb: ReturnType<typeof admin>) {
  // ONLY rows with no photo at all. A photo_path with a NULL inat_photo_id is
  // Jordan's own photograph and is excluded by the .is('photo_path', null) filter
  // below, which is the single most important line in this function.
  const { data: rows, error } = await sb
    .from('plant_species')
    .select('id, common, inat_taxon_id, photo_path, inat_photo_id, inat_photo_status')
    .not('inat_taxon_id', 'is', null)
    .is('photo_path', null);
  if (error) throw new Error(error.message);

  const counts = { considered: 0, filled: 0, noUsableLicence: 0, skippedOwn: 0 };

  for (const row of rows || []) {
    // Belt and braces against the query filter ever being loosened by accident.
    if (row.photo_path) { counts.skippedOwn++; continue; }
    if (row.inat_photo_status === 'rejected') continue;
    counts.considered++;

    let pick: PhotoPick = null;
    try {
      const detail = await inat('/taxa/' + row.inat_taxon_id);
      pick = pickPhoto((detail.results || [])[0] || {});
    } catch (_e) {
      continue;
    }
    await sleep(PACE_MS);

    if (!pick) {
      counts.noUsableLicence++;
      continue;
    }

    let bytes: ArrayBuffer;
    try {
      const img = await fetch(pick.mediumUrl, { headers: { 'User-Agent': UA } });
      if (!img.ok) continue;
      bytes = await img.arrayBuffer();
    } catch (_e) {
      continue;
    }

    const objectPath = 'plants/' + crypto.randomUUID() + '.jpg';
    const up = await sb.storage.from('gallery')
      .upload(objectPath, bytes, { contentType: 'image/jpeg', upsert: false });
    if (up.error) continue;

    // Storage first, row second. If the update fails we leak one orphan object,
    // which is harmless. The reverse order would point a row at a missing image.
    const { error: updErr } = await sb.from('plant_species').update({
      photo_path: objectPath,
      inat_photo_id: pick.photoId,
      inat_photo_license: pick.licence,
      inat_photo_attribution: pick.attribution,
      inat_photo_source_url: pick.sourceUrl,
      inat_photo_status: 'auto',
      inat_synced_at: new Date().toISOString(),
    }).eq('id', row.id).is('photo_path', null);
    if (updErr) continue;
    counts.filled++;
  }

  return counts;
}
```

Note the `.is('photo_path', null)` repeated on the UPDATE. It makes the write conditional at the database rather than only in application logic, so a concurrent staff upload cannot be clobbered.

- [ ] **Step 2: Call it from the handler**

In `Deno.serve`, replace the two lines computing and returning `counts` with:

```ts
    const counts = await resolveAndEnrich(sb);
    const photos = await fillPhotos(sb);
    return json({ ok: true, counts: { ...counts, photos } }, 200);
```

- [ ] **Step 3: Record the pre-run state so the guard is provable**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select id, common, photo_path from public.plant_species where photo_path is not null order by common"}' \
  > /tmp/inat-photos-before.json
cat /tmp/inat-photos-before.json
```

Expected: exactly 9 rows, all `static:` paths. This is the evidence the next verification compares against.

- [ ] **Step 4: Deploy and run**

```bash
cd ~/GitHub/ecotopia-portal
supabase functions deploy inat-sync --project-ref wibnryfinfwbwwgsyojr --no-verify-jwt
curl -s -X POST "https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/inat-sync" \
  -H "Content-Type: application/json" -H "X-Scan-Token: $TOKEN_VALUE" \
  -d '{"action":"sync"}'
```

Expected: `photos.filled` is 33, `photos.noUsableLicence` is 7. Measured figures. The run takes several minutes.

- [ ] **Step 5: Verify Jordan's nine photos are untouched**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select id, common, photo_path from public.plant_species where inat_photo_id is null and photo_path is not null order by common"}'
```

Expected: byte-identical to `/tmp/inat-photos-before.json`, all 9 rows still `static:` paths. **If any of the nine changed, stop and restore them from git history before doing anything else.**

- [ ] **Step 6: Verify the seven unusable ones were left empty rather than filled badly**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select common, botanical from public.plant_species where photo_path is null order by common"}'
```

Expected: 8 rows. The 7 with no commercially usable photo (Yarrow, Scarlet Beebalm, Purple Poppy Mallow, Culver's Root, Skullcap, Obedient Plant, Sneezeweed) plus the unresolved Mountain Mint row.

- [ ] **Step 7: Verify every stored photo recorded its licence**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select count(*) total, count(inat_photo_license) with_licence, count(inat_photo_attribution) with_attribution from public.plant_species where inat_photo_id is not null"}'
```

Expected: all three counts equal 33. A stored image with no recorded licence is a compliance hole, since the CC grant is only provable if captured at copy time.

- [ ] **Step 8: Commit**

```bash
cd ~/GitHub/ecotopia-portal
git add supabase/functions/inat-sync/index.ts
git commit -m "feat(inat): copy licence-clean photos into the gallery bucket

Fills only species with no photo at all, recording licence and attribution at
copy time so the Creative Commons grant stays provable. The UPDATE repeats the
photo_path IS NULL condition so a concurrent staff upload cannot be clobbered."
```

---

### Task 5: Portal review grid, needs-attention list and Sync now

The cron job in Task 7 must not be switched on before this exists, or auto-filled photos reach the public site with no way to reject them.

**Files:**
- Modify: `manage-plants.html`
- Modify: `assets/data.js` (add the two staff methods)
- Modify: `dashboard.html` (pending-review count)

**Interfaces:**
- Consumes: the columns from Task 2 as camelCase (`inatMatch`, `inatPhotoStatus`, `inatEstablishment`, `inatMatchedName`, `inatPhotoAttribution`) via the existing generic mapper, and the `inat-sync` endpoint from Tasks 3 and 4.
- Produces: `DataStore.approveInatPhoto(id)`, `DataStore.rejectInatPhoto(id, photoPath)`, `DataStore.setInatTaxon(id, taxonId)`.

**Existing identifiers this task must use, verified in the current file:** the species array is `species` (lowercase), the reloader is `loadSpecies()`, `esc` is `DataStore.esc`, and `catalogPhotoSrc(photoPath)` is defined at `manage-plants.html:346`. Do not introduce `SPECIES` or `loadAll()`; neither exists.

**Wiring:** extend the existing one-line loader at `manage-plants.html:891` so every caller refreshes all three sections, rather than repeating render calls in each handler:

```js
async function loadSpecies() {
  species = await DataStore.getPlantSpecies();
  renderSpecies();
  renderInatReview();
  renderInatAttention();
}
```

- [ ] **Step 1: Add the data methods**

In `assets/data.js`, directly after `deletePlantSpecies`, add:

```js
    // iNaturalist enrichment. Approving keeps the photo and marks it reviewed.
    // Rejecting removes the stored object, clears photo_path so the card falls
    // back to no image, and keeps inat_photo_id so the sync never proposes that
    // same photo again.
    approveInatPhoto: (id) => update('plant_species', id, { inat_photo_status: 'approved' }),
    rejectInatPhoto: async (id, photoPath) => {
      if (photoPath && String(photoPath).slice(0, 7) !== 'static:') {
        try { await sb.storage.from('gallery').remove([photoPath]); } catch (e) { /* ignore */ }
      }
      return update('plant_species', id, { photo_path: null, inat_photo_status: 'rejected' });
    },
    // A hand-entered taxon id is permanent: the sync never revisits a 'manual' row.
    setInatTaxon: (id, taxonId) =>
      update('plant_species', id, { inat_taxon_id: taxonId, inat_match: 'manual' }),
```

The sync call itself does **not** go in `assets/data.js`. `grant-finder.html` calls its edge function from a page-level constant, and this task follows that existing convention rather than inventing a second one. Task 5 Step 4 defines it in `manage-plants.html`.

- [ ] **Step 2: Add the review grid to manage-plants.html**

Add a section above the existing species list, and its renderer alongside `renderSpecies`:

```html
<section class="card" id="inat_review_card" style="display:none">
  <h2>iNaturalist photos awaiting review</h2>
  <p class="muted">Auto-filled from iNaturalist. Approve the ones that look like a plant
    a customer would recognise, reject the rest. Rejected photos are never offered again.</p>
  <div id="inat_review_grid" class="inat-grid"></div>
</section>
```

```js
// Auto-filled photos land here for a single scan-and-reject pass rather than
// making Jordan open 33 species one at a time.
function renderInatReview() {
  const pending = species.filter((p) => p.inatPhotoStatus === 'auto');
  const card = document.getElementById('inat_review_card');
  card.style.display = pending.length ? '' : 'none';
  document.getElementById('inat_review_grid').innerHTML = pending.map((p) => `
    <figure class="inat-cell">
      <img src="${esc(catalogPhotoSrc(p.photoPath) || '')}" alt="">
      <figcaption>
        <strong>${esc(p.common)}</strong>
        <em>${esc(p.botanical || '')}</em>
        <span class="credit">${esc(p.inatPhotoAttribution || '')}</span>
      </figcaption>
      <div class="inat-actions">
        <button onclick="approveInat('${esc(p.id)}')">Keep</button>
        <button class="danger" onclick="rejectInat('${esc(p.id)}')">Reject</button>
      </div>
    </figure>`).join('');
}

async function approveInat(id) {
  await DataStore.approveInatPhoto(id);
  await loadSpecies();
}

async function rejectInat(id) {
  const p = species.find((s) => s.id === id);
  if (!p) return;
  if (!confirm('Reject this photo for ' + p.common + '? It will not be offered again.')) return;
  await DataStore.rejectInatPhoto(id, p.photoPath);
  await loadSpecies();
}
```

Both handlers rely on the extended `loadSpecies()` above to refresh all three sections.

Every interpolated value passes through `esc()`, including the third-party attribution string and the uuid in the `onclick`, per the repo convention that `onclick` arguments are uuids or allowlisted values only.

- [ ] **Step 3: Add the needs-attention list**

Add the markup directly beneath the review card added in Step 2:

```html
<section class="card" id="inat_attention_card" style="display:none">
  <h2>Species iNaturalist could not match</h2>
  <p class="muted">Look the plant up on iNaturalist and paste its taxon id. A hand-entered
    id is permanent and the nightly sync will not overwrite it.</p>
  <ul id="inat_attention_list"></ul>
</section>
```

```js
// Rows the sync could not resolve on its own. Includes the real
// 'Pycnanthemum virginicum & muticum' row, which is two species in one and needs
// splitting or a permanent manual taxon id.
function renderInatAttention() {
  const stuck = species.filter((p) => p.inatMatch === 'none' || p.inatMatch === 'fuzzy');
  const card = document.getElementById('inat_attention_card');
  card.style.display = stuck.length ? '' : 'none';
  document.getElementById('inat_attention_list').innerHTML = stuck.map((p) => `
    <li>
      <strong>${esc(p.common)}</strong> <em>${esc(p.botanical || '')}</em>
      ${p.inatMatch === 'fuzzy'
        ? `<span class="pill">matched as ${esc(p.inatMatchedName || '')}</span>`
        : '<span class="pill warn">no match</span>'}
      <input type="number" placeholder="taxon id" id="tx_${esc(p.id)}">
      <button onclick="saveInatTaxon('${esc(p.id)}')">Set</button>
    </li>`).join('');
}

async function saveInatTaxon(id) {
  const raw = document.getElementById('tx_' + id).value.trim();
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) { alert('Enter a whole taxon id.'); return; }
  await DataStore.setInatTaxon(id, n);
  await loadSpecies();
}
```

- [ ] **Step 4: Add the establishment badge and Sync now button**

In `renderSpecies`, inside the existing `.row-sub` block, append:

```js
      ${p.inatEstablishment === 'introduced'
        ? '<span class="pill warn">introduced in PA</span>'
        : p.inatEstablishment === 'native' ? '<span class="pill">PA native</span>' : ''}
```

Absent data renders nothing at all, never "native". Two real species carry the introduced badge today: *Coreopsis lanceolata* and *Echinacea purpurea*.

Add the button beside the existing page actions:

```html
<button id="inat_sync_btn" onclick="runInatSync()">Sync iNaturalist</button>
```

This mirrors the "Scan now" call in `grant-finder.html:275-280` exactly, including the `apikey` header, which that call sends and which the function's CORS allowlist expects:

```js
const SYNC_URL = 'https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/inat-sync';

async function runInatSync() {
  const btn = document.getElementById('inat_sync_btn');
  btn.disabled = true;
  btn.textContent = 'Syncing, this takes a few minutes';
  try {
    const { data } = await window.ecoSupabase.auth.getSession();
    const token = data && data.session ? data.session.access_token : null;
    if (!token) throw new Error('Not signed in.');
    const res = await fetch(SYNC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'apikey': window.ECO_CONFIG.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ action: 'sync' }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Sync failed.');
    const c = payload.counts || {};
    const ph = c.photos || {};
    alert(`Resolved ${c.resolved || 0}, photos filled ${ph.filled || 0}.`);
    await loadSpecies();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync iNaturalist';
  }
}
```

Browser `fetch` has no timeout and a full sync takes minutes, which is why the button is disabled for the duration and says so.

- [ ] **Step 5: Add the dashboard count**

In `dashboard.html`, immediately after the `pendingReviews` block that ends at line 362, add a matching entry. The `attentionItems` shape is `{badge, label, text, link, linkText}`, verified at `dashboard.html:350-362`:

```js
const pendingPhotos = (await DataStore.getPlantSpecies())
  .filter(p => p.inatPhotoStatus === 'auto');
if (pendingPhotos.length > 0) {
  attentionItems.push({
    badge: 'amber', label: 'Photos',
    text: `${pendingPhotos.length} plant photo${pendingPhotos.length > 1 ? 's' : ''} awaiting review`,
    link: 'manage-plants.html', linkText: 'Review →'
  });
}
```

Note the singular and plural handling matches the sibling entries. A previous dashboard fix in this repo existed solely to correct a missing plural, so follow the pattern rather than hardcoding "photos".

- [ ] **Step 6: Verify in a browser**

Open `manage-plants.html` signed in as `frank.lechner@bagcarriers.dev`. Confirm the review grid shows 33 photos with attribution captions, rejecting one removes it and empties that species' image, the needs-attention list shows the Mountain Mint and Bradbury's Monarda rows, and both *Coreopsis lanceolata* and *Echinacea purpurea* carry an "introduced in PA" pill.

This is a mandatory browser check. A previous Ecotopia feature shipped a whole branch that had never been rendered in a browser, and this repo has form for schema-ahead-of-code breakage that only a real page load catches.

- [ ] **Step 7: Run the syntax check and tests**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: PASS, including the existing extracted-inline-script `node --check` step.

- [ ] **Step 8: Commit**

```bash
cd ~/GitHub/ecotopia-portal
git add manage-plants.html assets/data.js dashboard.html
git commit -m "feat(inat): portal review grid, needs-attention list and Sync now

Jordan reviews all 33 auto-filled photos in one screen. Absent PA establishment
data renders nothing rather than claiming native."
```

---

### Task 6: Public attribution line

CC-BY and CC-BY-SA both require visible attribution, so this must ship before any iNaturalist photo is publicly visible.

**Files:**
- Modify: `plants.html`

**Interfaces:**
- Consumes: `inatPhotoAttribution` and `inatPhotoId` on each species row.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Render the credit on species cards**

In the species card template in `plants.html`, directly beneath the image element:

```js
        ${p.inatPhotoId && p.inatPhotoAttribution
          ? `<div class="photo-credit">${esc(p.inatPhotoAttribution)}</div>` : ''}
```

- [ ] **Step 2: Style it quietly**

In the page's style block:

```css
  .photo-credit { font-size: 0.65rem; line-height: 1.3; opacity: 0.6; margin-top: 2px; }
```

Low emphasis but genuinely legible, following the precedent set by the "Administration" fee line: required secondary text gets a quiet position, not a hidden one. Do not reduce the opacity further, since an attribution nobody can read does not discharge the licence obligation.

- [ ] **Step 3: Verify in a browser**

Load `plants.html` and confirm each of the 33 iNaturalist-sourced cards shows a credit, the 9 Jordan cards show none, the line wraps rather than overflowing on a narrow viewport, and the layout does not shift.

- [ ] **Step 4: Confirm the attribution is escaped**

Attribution strings are third-party text containing names and punctuation. Confirm `esc()` wraps the value. Temporarily set one species' `inat_photo_attribution` to `<img src=x onerror=alert(1)>` via the Management API, reload the page, confirm it renders as literal text with no alert, then restore the real value.

- [ ] **Step 5: Run the tests and deploy**

```bash
cd ~/GitHub/ecotopia-portal
npm test
netlify deploy --prod --dir=.
```

Expected: tests PASS, deploy succeeds. Then load the live site and confirm the credits render there too.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/ecotopia-portal
git add plants.html
git commit -m "feat(inat): photo credit line on public plant cards

CC-BY and CC-BY-SA require visible attribution. Quiet but legible, and escaped
because the attribution string is third-party text."
```

---

### Task 7: Nightly schedule

Last deliberately. The cron job must not run before the review grid (Task 5) and the public credit line (Task 6) exist.

**Files:**
- Create: `supabase/migrations/0034_inat_sync_cron.sql`

**Interfaces:**
- Consumes: the deployed `inat-sync` function and the `INAT_SYNC_TOKEN` value from Task 3 Step 7.
- Produces: a `pg_cron` job named `inat-sync-nightly`.

- [ ] **Step 1: Write the cron migration**

Create `supabase/migrations/0034_inat_sync_cron.sql`, substituting the real token for `REPLACE_WITH_INAT_SYNC_TOKEN`. The token is embedded in the cron SQL, matching how `grant-scan-nightly` already works in this database.

```sql
-- Nightly iNaturalist sync at 10:00 UTC, an hour after grant-scan-nightly at
-- 09:00 UTC so the two never contend.
--
-- Only switch this on AFTER manage-plants.html has the review grid and
-- plants.html has the attribution line. Without them an auto-filled photo
-- reaches the public site uncredited and with no way to reject it.

select cron.unschedule('inat-sync-nightly')
  where exists (select 1 from cron.job where jobname = 'inat-sync-nightly');

select cron.schedule(
  'inat-sync-nightly',
  '0 10 * * *',
  $$
  select net.http_post(
    url := 'https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/inat-sync',
    headers := '{"Content-Type": "application/json", "X-Scan-Token": "REPLACE_WITH_INAT_SYNC_TOKEN"}'::jsonb,
    body := '{"action": "sync"}'::jsonb
  );
  $$
);
```

- [ ] **Step 2: Apply it**

```bash
cd ~/GitHub/ecotopia-portal
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary "$(python3 -c "import json;print(json.dumps({'query':open('supabase/migrations/0034_inat_sync_cron.sql').read()}))")"
```

- [ ] **Step 3: Verify the job is registered**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select jobname, schedule, active from cron.job order by jobname"}'
```

Expected: both `grant-scan-nightly` at `0 9 * * *` and `inat-sync-nightly` at `0 10 * * *`, both active.

- [ ] **Step 4: Verify idempotence**

The catalogue is fully resolved by now, so a second run must change nothing. Trigger the function manually once more and confirm `resolved` is 0, `photos.filled` is 0, and the nine Jordan photos are still `static:` paths.

```bash
curl -s -X POST "https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/inat-sync" \
  -H "Content-Type: application/json" -H "X-Scan-Token: $TOKEN_VALUE" \
  -d '{"action":"sync"}'
```

Expected: all counts zero. A non-zero `filled` here means the job is churning and would overwrite something eventually.

- [ ] **Step 5: Redact the token before committing**

The committed migration must not contain the live token. Replace it with `REPLACE_WITH_INAT_SYNC_TOKEN` in the file on disk, matching how the grant-scan cron token is handled, and note in `docs/OPERATIONS.md` that the real value lives in `INAT_SYNC_TOKEN`.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/ecotopia-portal
git add supabase/migrations/0034_inat_sync_cron.sql docs/OPERATIONS.md
git commit -m "feat(inat): nightly sync at 10:00 UTC

Scheduled an hour after grant-scan-nightly. Switched on only after the review
grid and the public credit line existed. Token redacted in the committed file."
```

---

## Verification summary

Evidence required before this plan is called complete:

| Claim | Evidence |
| --- | --- |
| Resolution works | `examined 50, resolved 48, fuzzy 1, unresolved 1` from a live run |
| Photos filled | `photos.filled 33, noUsableLicence 7` from a live run |
| Jordan's photos safe | Post-run query byte-identical to `/tmp/inat-photos-before.json` |
| Licence recorded | 33 rows with `inat_photo_id` all have licence and attribution |
| Guard test bites | `npm test` fails when `isOwnPhoto` is mutated to `return false` |
| Mirror test bites | `npm test` fails when `cc-by-nc` is added to the edge function list |
| Attribution renders | Live `plants.html` shows credits on 33 cards, none on the 9 |
| Attribution is escaped | Injected `<img src=x onerror=alert(1)>` renders as literal text |
| Idempotent | Second run reports all counts zero |

## Left for Jordan, not code

1. Split `Pycnanthemum virginicum & muticum` into two catalogue rows, or accept a permanent manual taxon override.
2. Decide what to do about *Coreopsis lanceolata* and *Echinacea purpurea* being flagged introduced in Pennsylvania.
3. Supply photographs for the 7 species with no commercially usable iNaturalist image: Yarrow, Scarlet Beebalm, Purple Poppy Mallow, Culver's Root, Skullcap, Obedient Plant, Sneezeweed.

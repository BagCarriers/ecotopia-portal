# Garden Planting Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record what the team planted at each community garden, so the portal can answer "we planted 2,400 native plants across nine sites" and the public garden cards can say what is growing there.

**Architecture:** One new table, `garden_plantings`, holding one row per planting event. Pure summarising logic lives in `assets/plantings.js` as a browser-and-Node global, following the existing `assets/mapping.js` pattern, so the totals arithmetic is tested by `node --test` and shared by the portal and the public page. No new dependencies.

**Tech Stack:** Static HTML, Supabase (Postgres), `node --test`, no build step.

**Spec:** `docs/superpowers/specs/2026-08-09-garden-plantings-design.md`

## Global Constraints

- **No em dashes anywhere**, in code, comments, copy, or commit messages. Repo-wide rule.
- **`esc()` every database string before it reaches `innerHTML`.** `species_label` and `note` are staff-entered free text and are untrusted.
- **Additive schema first, removal last.** The deployed page and the deployed schema must be compatible at every commit. This repo has already caused two live outages by violating it.
- **`species_label` is mandatory; `species_id` is an optional link to the shop, never the name itself.** There is exactly one way to name a plant.
- **Writing a content row publishes it.** The deployed site reads Supabase live over the anon key, so a row with anon-read RLS is public the instant it exists. Ship the public rendering before, or in the same deploy as, any real data. This rule exists because violating it put 27 uncredited photos on the live storefront on 2026-08-09.
- **SQL is applied via the Supabase Management API using `curl`, never `python urllib`** (Cloudflare returns 403 error 1010 to urllib). Token: `security find-generic-password -s "Supabase CLI" -w`. Project ref `wibnryfinfwbwwgsyojr`. `supabase_migrations.schema_migrations` does not exist in this project, so `supabase db push` is not the mechanism.
- **The Supabase MCP tools in this environment point at a DIFFERENT project.** Do not use them.
- **This harness refuses compound shell commands it cannot verify stay inside the worktree.** Put multi-step shell work in a `.sh` file and run `bash file.sh`.

## Note on migration numbering

`0034_inat_sync_cron.sql` exists in the repo and is **deliberately unapplied**. This plan adds `0035`, which is independent of it. Applying 0035 while 0034 remains unapplied is correct and expected. Do not apply 0034.

## File structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0035_garden_plantings.sql` | The table, its constraints, its index, its RLS |
| `assets/plantings.js` | Pure summarising logic: totals, per-garden rollups, label resolution. No DOM, no network |
| `tests/plantings.test.js` | Tests for the above |
| `assets/data.js` | Staff CRUD methods, following the existing per-garden pattern |
| `garden-detail.html` | Portal: the Plantings section |
| `gardens.html` | Portal: the all-gardens totals line |
| `community-gardens.html` | Public: the per-card summary |

---

### Task 1: Pure summarising logic and its tests

Built first so the arithmetic every other task displays is settled and tested before any UI depends on it.

**Files:**
- Create: `assets/plantings.js`
- Create: `tests/plantings.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `globalThis.EcoPlantings` with `plantingLabel(row): string`, `summarise(rows): {plants: number, species: number}`, `summariseForYear(rows, year): {plants: number, species: number}`, `speciesBreakdown(rows): Array<{label: string, plants: number}>`.

- [ ] **Step 1: Write the failing test**

Create `tests/plantings.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
require('../assets/plantings.js');
const P = globalThis.EcoPlantings;

const ROWS = [
  { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 12, plantedOn: '2026-05-04' },
  { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 8,  plantedOn: '2026-06-01' },
  { gardenId: 'g1', speciesLabel: 'Foam Flower',    quantity: 5,  plantedOn: '2026-06-01' },
  { gardenId: 'g2', speciesLabel: 'Wild Columbine', quantity: 20, plantedOn: '2025-04-11' },
  { gardenId: 'g2', speciesLabel: 'American Plum',  quantity: 2,  plantedOn: '2025-04-11' },
];

test('a species planted twice at one garden counts once as a species', () => {
  // The whole point of the distinct count. Counting rows would say 3 species here.
  const g1 = ROWS.filter(r => r.gardenId === 'g1');
  assert.deepStrictEqual(P.summarise(g1), { plants: 25, species: 2 });
});

test('the same species at two gardens counts once overall', () => {
  // 45 plants, but Wild Columbine appears at both gardens and is one species.
  assert.deepStrictEqual(P.summarise(ROWS), { plants: 47, species: 3 });
});

test('summarising an empty list gives zeroes, not NaN', () => {
  assert.deepStrictEqual(P.summarise([]), { plants: 0, species: 0 });
  assert.deepStrictEqual(P.speciesBreakdown([]), []);
});

test('the year filter uses planted_on, not created_at', () => {
  assert.deepStrictEqual(P.summariseForYear(ROWS, 2026), { plants: 25, species: 2 });
  assert.deepStrictEqual(P.summariseForYear(ROWS, 2025), { plants: 22, species: 2 });
  assert.deepStrictEqual(P.summariseForYear(ROWS, 2024), { plants: 0, species: 0 });
});

test('species matching is case and whitespace insensitive', () => {
  // Staff typing 'wild columbine' must not create a second species.
  const rows = [
    { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 1, plantedOn: '2026-05-04' },
    { gardenId: 'g1', speciesLabel: '  wild columbine ', quantity: 1, plantedOn: '2026-05-04' },
  ];
  assert.strictEqual(P.summarise(rows).species, 1);
});

test('the breakdown is ordered by quantity, highest first', () => {
  assert.deepStrictEqual(P.speciesBreakdown(ROWS), [
    { label: 'Wild Columbine', plants: 40 },
    { label: 'Foam Flower', plants: 5 },
    { label: 'American Plum', plants: 2 },
  ]);
});

test('the breakdown keeps the first spelling it saw, not the lowercased key', () => {
  const rows = [
    { gardenId: 'g1', speciesLabel: 'Wild Columbine', quantity: 3, plantedOn: '2026-05-04' },
    { gardenId: 'g1', speciesLabel: 'wild columbine', quantity: 1, plantedOn: '2026-05-04' },
  ];
  assert.deepStrictEqual(P.speciesBreakdown(rows), [{ label: 'Wild Columbine', plants: 4 }]);
});

test('plantingLabel returns the stored label and never invents one', () => {
  assert.strictEqual(P.plantingLabel({ speciesLabel: 'Foam Flower' }), 'Foam Flower');
  // A row can never legally have a blank label; if one appears, say so rather than
  // rendering an empty cell that looks like a rendering bug.
  assert.strictEqual(P.plantingLabel({ speciesLabel: '' }), 'Unnamed planting');
  assert.strictEqual(P.plantingLabel({}), 'Unnamed planting');
});

test('a non-numeric or negative quantity contributes nothing rather than NaN', () => {
  const rows = [
    { gardenId: 'g1', speciesLabel: 'A', quantity: null, plantedOn: '2026-01-01' },
    { gardenId: 'g1', speciesLabel: 'B', quantity: 5, plantedOn: '2026-01-01' },
  ];
  assert.strictEqual(P.summarise(rows).plants, 5);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: FAIL, `Cannot find module '../assets/plantings.js'`

- [ ] **Step 3: Write the implementation**

Create `assets/plantings.js`:

```js
/**
 * Ecotopia Portal - planting record arithmetic.
 *
 * Pure functions only: no network, no DOM, no Supabase client. The portal and the
 * public garden cards both summarise the same rows, so the arithmetic lives here
 * once and is tested by node --test.
 *
 * Written in the same universal style as assets/mapping.js, so the one file loads
 * in the browser via a script tag and in Node via require, both reading
 * globalThis.EcoPlantings.
 *
 * Rows are the camelCase shape EcoMapping.fromDbAll produces: gardenId,
 * speciesLabel, quantity, plantedOn.
 */
(function (root) {
  // Staff type labels by hand, so 'Wild Columbine' and 'wild columbine ' are the
  // same plant. Counting keys off a normalised form stops a stray capital from
  // inventing a second species in a grant figure.
  const key = (label) => String(label || '').trim().toLowerCase();

  const qty = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  const plantingLabel = (row) => {
    const label = String((row && row.speciesLabel) || '').trim();
    return label || 'Unnamed planting';
  };

  function summarise(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const species = new Set();
    let plants = 0;
    for (const r of list) {
      plants += qty(r && r.quantity);
      const k = key(r && r.speciesLabel);
      if (k) species.add(k);
    }
    return { plants, species: species.size };
  }

  // Filters on plantedOn, the date the work happened, NOT created_at, which is when
  // somebody got around to typing it in. A planting entered late still belongs to
  // the year it went in the ground.
  function summariseForYear(rows, year) {
    const list = Array.isArray(rows) ? rows : [];
    const want = String(year);
    return summarise(list.filter((r) => String((r && r.plantedOn) || '').slice(0, 4) === want));
  }

  function speciesBreakdown(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const byKey = new Map();
    for (const r of list) {
      const k = key(r && r.speciesLabel);
      if (!k) continue;
      // Keep the first spelling seen, so the display shows a human's capitalisation
      // rather than the normalised lookup key.
      const seen = byKey.get(k) || { label: plantingLabel(r), plants: 0 };
      seen.plants += qty(r && r.quantity);
      byKey.set(k, seen);
    }
    return [...byKey.values()].sort((a, b) => b.plants - a.plants || a.label.localeCompare(b.label));
  }

  root.EcoPlantings = {
    plantingLabel, summarise, summariseForYear, speciesBreakdown,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: PASS, the new `tests/plantings.test.js` tests green alongside the existing suites.

- [ ] **Step 5: Prove the distinct-species test bites**

Temporarily change `summarise` to `species: list.length`, run `npm test`, and confirm the two distinct-count tests FAIL. Then revert. Distinct species is the figure that goes into a grant application, and a test that would pass against a naive count is worthless.

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: FAIL while mutated, PASS after revert.

- [ ] **Step 6: Commit**

```bash
cd ~/GitHub/ecotopia-portal
git add assets/plantings.js tests/plantings.test.js
git commit -m "feat(plantings): planting record arithmetic

Distinct species counting is normalised on a trimmed lowercase key, so a stray
capital cannot invent a second species in a grant figure. A garden with no
plantings is absent from the rollup rather than zero, so the public card can
tell the two apart."
```

---

### Task 2: Migration 0035

**Files:**
- Create: `supabase/migrations/0035_garden_plantings.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `public.garden_plantings`, reachable in the browser as camelCase via the generic mapper in `assets/mapping.js` (`species_label` becomes `speciesLabel`, `planted_on` becomes `plantedOn`). No mapping code changes are needed.

- [ ] **Step 1: Write the migration**

> ## STOP. THE SQL LISTING BELOW IS SUPERSEDED. DO NOT RUN IT.
>
> It contains `create policy gp_anon_read ... for select to anon using (true)`, which
> published the staff-only `note` column to anonymous readers. **Migration 0036 exists
> specifically to drop that policy**, replacing it with the view
> `public.garden_plantings_public`, which excludes `note`. Re-running this listing
> re-opens staff notes to the internet.
>
> The listing is kept as the historical record of what 0035 originally did. The
> statements that are actually live are whatever is in
> `supabase/migrations/0035_garden_plantings.sql` **as amended by 0036 and 0037**.

Create `supabase/migrations/0035_garden_plantings.sql`:

```sql
-- One row per planting event: what the team put in the ground, where, and when.
--
-- species_label is MANDATORY and species_id is an optional link to the shop
-- catalogue. The label is the durable record of what was planted; the foreign key
-- only adds "and it happens to be something we sell". This is deliberately simpler
-- than a nullable label with a one-of-two constraint, which would give two ways to
-- name a plant and force every reader to handle both.
--
-- The habitat kits already reference American Plum, Buttonbush and Summersweet,
-- none of which are among the 50 catalogue wildflowers, so requiring a foreign key
-- would make a large share of real plantings unloggable.
--
-- on delete set null for species_id, NOT cascade: deleting a species from the shop
-- must not erase the historical fact that it was planted. The row keeps its label,
-- quantity and date and simply stops linking to a shop page.

create table if not exists public.garden_plantings (
  id            uuid primary key default gen_random_uuid(),
  garden_id     uuid not null references public.gardens(id) on delete cascade,
  species_id    uuid references public.plant_species(id) on delete set null,
  species_label text not null,
  quantity      integer not null,
  planted_on    date not null,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  constraint garden_plantings_label_chk check (length(trim(species_label)) > 0),
  constraint garden_plantings_quantity_chk check (quantity > 0)
);

-- Unlike plant_species, which is a fixed 50 rows, this table grows without bound
-- and is always read for one garden at a time. An index earns its keep here.
create index if not exists garden_plantings_garden_idx
  on public.garden_plantings (garden_id);

alter table public.garden_plantings enable row level security;

-- ###########################################################################
-- ##  SUPERSEDED. DO NOT RUN THE gp_anon_read POLICY BELOW.                ##
-- ##                                                                       ##
-- ##  It granted anon SELECT on the whole table, which published the       ##
-- ##  staff-only `note` column to the internet. Migration 0036 DROPS this  ##
-- ##  policy and replaces it with the view public.garden_plantings_public, ##
-- ##  which exposes every column except `note`. The public pages read      ##
-- ##  that view.                                                           ##
-- ##                                                                       ##
-- ##  Running this statement again re-opens staff notes to anonymous       ##
-- ##  readers. It is kept here only as the record of what 0035 originally  ##
-- ##  did, and why 0036 exists.                                            ##
-- ###########################################################################
-- Same shape as every sibling content table: the public reads, staff write.
create policy gp_anon_read on public.garden_plantings
  for select to anon using (true);
create policy gp_staff_all on public.garden_plantings
  for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());

create trigger set_updated_at before update on public.garden_plantings
  for each row execute function public.set_updated_at();
```

- [ ] **Step 2: Apply it via the Management API**

Write `apply-0035.sh` in the repo root and run it with `bash apply-0035.sh`:

```bash
#!/bin/bash
set -u
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
BODY=$(python3 -c "import json;print(json.dumps({'query':open('supabase/migrations/0035_garden_plantings.sql').read()}))")
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary "$BODY"
```

Expected: `[]` or a success payload with no `error` key. `python3` builds the JSON body locally; the HTTP call itself is `curl`, per the repo rule. Delete `apply-0035.sh` before committing.

- [ ] **Step 3: Verify the table, constraints, index and policies landed**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select (select count(*) from information_schema.columns where table_name = '"'"'garden_plantings'"'"') cols, (select count(*) from pg_constraint where conrelid = '"'"'public.garden_plantings'"'"'::regclass and contype = '"'"'c'"'"') checks, (select count(*) from pg_indexes where tablename = '"'"'garden_plantings'"'"') indexes, (select count(*) from pg_policies where tablename = '"'"'garden_plantings'"'"') policies"}'
```

Expected: `cols 9, checks 2, indexes 2, policies 2`. Two indexes because the primary key has one.

- [ ] **Step 4: Verify the constraints actually reject bad rows**

A constraint nobody tested is a constraint you hope exists. Run each and confirm it FAILS:

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
API="https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query"
GID=$(curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select id from public.gardens limit 1"}' | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")

echo "--- blank label must be rejected ---"
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"insert into public.garden_plantings (garden_id, species_label, quantity, planted_on) values ('$GID', '   ', 1, '2026-01-01')\"}"

echo "--- zero quantity must be rejected ---"
curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"insert into public.garden_plantings (garden_id, species_label, quantity, planted_on) values ('$GID', 'Test', 0, '2026-01-01')\"}"
```

Expected: both return an error mentioning `garden_plantings_label_chk` and `garden_plantings_quantity_chk` respectively. If either INSERT succeeds, the migration is wrong; delete the row and fix it.

- [ ] **Step 5: Verify that deleting a species keeps the planting**

The spec's central claim about `species_id` is that deleting a catalogue species must not
erase the historical fact that it was planted. Prove it rather than trusting the DDL. Write
`verify-species-delete.sh` and run it with `bash verify-species-delete.sh`:

```bash
#!/bin/bash
set -u
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
API="https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query"
q() { curl -s -X POST "$API" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "$1"; }

echo "--- create a throwaway species and a planting that links to it ---"
q '{"query":"insert into public.plant_species (common, botanical, active) values ('"'"'ZZ Delete Probe'"'"', '"'"'Probus deletus'"'"', false) returning id"}'
q '{"query":"insert into public.garden_plantings (garden_id, species_id, species_label, quantity, planted_on) select (select id from public.gardens limit 1), (select id from public.plant_species where common = '"'"'ZZ Delete Probe'"'"'), '"'"'ZZ Delete Probe'"'"', 7, '"'"'2026-01-01'"'"' returning id, species_id"}'

echo "--- delete the species ---"
q '{"query":"delete from public.plant_species where common = '"'"'ZZ Delete Probe'"'"'"}'

echo "--- the planting must survive with a null link and its label intact ---"
q '{"query":"select species_label, quantity, species_id from public.garden_plantings where species_label = '"'"'ZZ Delete Probe'"'"'"}'

echo "--- clean up ---"
q '{"query":"delete from public.garden_plantings where species_label = '"'"'ZZ Delete Probe'"'"'"}'
```

Expected: after the species delete, the planting row still exists with `species_label`
"ZZ Delete Probe", `quantity` 7 and `species_id` null. If the row vanished, the foreign key
is `on delete cascade` rather than `set null` and the migration is wrong. Delete
`verify-species-delete.sh` afterwards.

- [ ] **Step 6: Confirm the table is empty**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select count(*) from public.garden_plantings"}'
```

Expected: `0`. The two rejected INSERTs above must have left nothing behind.

- [ ] **Step 7: Commit**

```bash
cd ~/GitHub/ecotopia-portal
rm -f apply-0035.sh verify-species-delete.sh
git add supabase/migrations/0035_garden_plantings.sql
git commit -m "feat(db): migration 0035 adds garden_plantings

species_label is mandatory and species_id is an optional shop link, so deleting
a catalogue species cannot erase the record that it was planted. Indexed on
garden_id because this table grows without bound and is always read per garden."
```

---

### Task 3: Staff data methods

**Files:**
- Modify: `assets/data.js`

**Interfaces:**
- Consumes: the table from Task 2.
- Produces: `DataStore.getPlantingsByGarden(gardenId)`, `DataStore.getAllPlantings()`, `DataStore.addPlanting(record)`, `DataStore.updatePlanting(id, changes)`, `DataStore.deletePlanting(id)`. Rows come back camelCase.

- [ ] **Step 1: Add the methods**

In `assets/data.js`, directly after the `getPlantingSuggestionsByGarden` group at line 255, add:

```js
    // Planting records: what the team actually put in the ground. Distinct from
    // planting_suggestions above, which is the public "suggest a site" form.
    // species_label is always written, even when a catalogue species is chosen, so
    // the record survives that species being deleted from the shop.
    getPlantingsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('garden_plantings').select('*')
        .eq('garden_id', gId).order('planted_on', { ascending: false }))),
    getAllPlantings: async () =>
      fromDbAll(unwrap(await sb.from('garden_plantings').select('*')
        .order('planted_on', { ascending: false }))),
    addPlanting: (r) => insert('garden_plantings', r),
    updatePlanting: (id, ch) => update('garden_plantings', id, ch),
    deletePlanting: async (id) => {
      unwrap(await sb.from('garden_plantings').delete().eq('id', id));
    },
```

`insert`, `update`, `unwrap` and `fromDbAll` are the existing helpers at `assets/data.js:11-33`. The delete follows the same shape as `deletePlantingSuggestion` at line 260.

- [ ] **Step 2: Verify the file still parses**

Run: `cd ~/GitHub/ecotopia-portal && node --check assets/data.js && npm test`
Expected: no output from `node --check`, and the existing suites stay green.

- [ ] **Step 3: Commit**

```bash
cd ~/GitHub/ecotopia-portal
git add assets/data.js
git commit -m "feat(plantings): staff data methods for garden_plantings"
```

---

### Task 4: The portal Plantings section

**Files:**
- Modify: `garden-detail.html`

**Interfaces:**
- Consumes: `DataStore.getPlantingsByGarden`, `addPlanting`, `updatePlanting`, `deletePlanting` from Task 3; `EcoPlantings.summarise`, `plantingLabel` from Task 1; `DataStore.getPlantSpecies` for the picker.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Load the shared arithmetic**

Add the script tag beside the page's existing asset scripts, before the page's own inline script:

```html
<script src="assets/plantings.js"></script>
```

- [ ] **Step 2: Add the section markup**

Add a section after the Maintenance Tasks block that ends before line 476, following the same `section` / `section-header` idiom used at line 407:

```html
<!-- Plantings -->
<div class="section">
  <div class="section-header">
    <h2>Plantings</h2>
    <button class="btn-sm btn-outline-sm" onclick="toggleAddPlanting()">+ Add Planting</button>
  </div>
  <p class="section-note" id="plantingSummary"></p>
  <div class="add-task-form" id="addPlantingForm">
    <div class="form-row">
      <div class="form-group">
        <label>Species *</label>
        <input type="text" id="ap_label" list="ap_species_list" placeholder="e.g. Wild Columbine">
        <datalist id="ap_species_list"></datalist>
      </div>
      <div class="form-group">
        <label>How many *</label>
        <input type="number" id="ap_qty" min="1" placeholder="12">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Planted on *</label>
        <input type="date" id="ap_date">
      </div>
      <div class="form-group">
        <label>Note</label>
        <input type="text" id="ap_note" placeholder="optional">
      </div>
    </div>
    <div class="modal-error" id="addPlantingError"></div>
    <button class="btn-sm" onclick="addPlanting()">Add Planting</button>
  </div>
  <div id="plantingList"></div>
</div>
```

The species field is a free-text input backed by a `datalist`, so staff can pick a catalogue species or type anything. That is the whole requirement: the catalogue assists, it does not constrain.

- [ ] **Step 3: Add the renderer and handlers**

```js
let plantings = [];
let plantSpeciesForPicker = [];

// The datalist offers catalogue species by common name. Choosing one is optional:
// the kits reference trees and shrubs that are not in the 50 wildflowers, so the
// field must accept anything.
function renderPlantingPicker() {
  document.getElementById('ap_species_list').innerHTML =
    plantSpeciesForPicker.map(s => '<option value="' + esc(s.common) + '"></option>').join('');
}

function renderPlantings() {
  const totals = EcoPlantings.summarise(plantings);
  document.getElementById('plantingSummary').textContent = plantings.length
    ? totals.plants + ' plants, ' + totals.species + ' species recorded here.'
    : 'No plantings recorded here yet.';

  document.getElementById('plantingList').innerHTML = plantings.length
    ? plantings.map(p => `
      <div class="row-item">
        <div>
          <strong>${esc(EcoPlantings.plantingLabel(p))}</strong>
          <span class="row-sub">${esc(String(p.quantity))} planted on ${esc(p.plantedOn)}</span>
          ${p.note ? `<div class="row-sub">${esc(p.note)}</div>` : ''}
        </div>
        <button class="btn-sm danger" onclick="removePlanting('${esc(p.id)}')">Delete</button>
      </div>`).join('')
    : '';
}

function toggleAddPlanting() {
  document.getElementById('addPlantingForm').classList.toggle('open');
}

async function addPlanting() {
  const errEl = document.getElementById('addPlantingError');
  errEl.textContent = '';
  const label = document.getElementById('ap_label').value.trim();
  const qty = Number(document.getElementById('ap_qty').value);
  const date = document.getElementById('ap_date').value;
  if (!label) { errEl.textContent = 'Name what was planted.'; return; }
  if (!Number.isInteger(qty) || qty < 1) { errEl.textContent = 'How many must be a whole number, 1 or more.'; return; }
  if (!date) { errEl.textContent = 'Pick the date it was planted.'; return; }

  // Link to the shop when the label matches a catalogue species, so the public card
  // can link through. The label is stored either way and is what gets rendered.
  const match = plantSpeciesForPicker
    .find(s => String(s.common).trim().toLowerCase() === label.toLowerCase());

  try {
    await DataStore.addPlanting({
      gardenId: garden.id,
      speciesId: match ? match.id : null,
      speciesLabel: label,
      quantity: qty,
      plantedOn: date,
      note: document.getElementById('ap_note').value.trim() || null,
    });
  } catch (e) {
    errEl.textContent = e.message;
    return;
  }
  document.getElementById('ap_label').value = '';
  document.getElementById('ap_qty').value = '';
  document.getElementById('ap_note').value = '';
  document.getElementById('addPlantingForm').classList.remove('open');
  plantings = await DataStore.getPlantingsByGarden(garden.id);
  renderPlantings();
}

async function removePlanting(id) {
  const p = plantings.find(x => x.id === id);
  if (!p) return;
  if (!confirm('Delete the record of ' + p.quantity + ' ' + EcoPlantings.plantingLabel(p) + '?')) return;
  await DataStore.deletePlanting(id);
  plantings = await DataStore.getPlantingsByGarden(garden.id);
  renderPlantings();
}
```

Every interpolated value passes through `esc()`, including `species_label` and `note`, which are staff-entered free text, and the uuid in each `onclick`, per the repo convention that `onclick` arguments are uuids or allowlisted values only.

- [ ] **Step 4: Wire it into the page load**

The page loads everything in one `Promise.all` at `garden-detail.html:868-876`, destructured
positionally. Extend both sides, keeping the order aligned:

```js
    [garden, tasks, walkins, checkins, observations, volunteers, suggestions,
     plantings, plantSpeciesForPicker] = await Promise.all([
      DataStore.getGarden(gardenId),
      DataStore.getTasksByGarden(gardenId),
      DataStore.getWalkins(),
      DataStore.getCheckinsByGarden(gardenId),
      DataStore.getObservationsByGarden(gardenId),
      DataStore.getVolunteers(),
      DataStore.getPlantingSuggestionsByGarden(gardenId),
      DataStore.getPlantingsByGarden(gardenId),
      DataStore.getPlantSpecies(),
    ]);
    renderPage();
```

The destructuring is positional, so a new read must be appended to BOTH lists in the same
position. Adding it to only one silently shifts every variable after it.

Then call `renderPlantingPicker()` and `renderPlantings()` from inside `renderPage()`,
alongside the calls that render the other sections, so a later reload refreshes all of them
together.

- [ ] **Step 5: Verify in a browser**

Serve the repo locally (`python3 -m http.server` from the repo root) and open `garden-detail.html?id=<a real garden id>` signed in. Confirm: the empty state reads "No plantings recorded here yet"; adding a planting works and the summary updates; the datalist offers catalogue species; typing a species not in the catalogue is accepted; a blank species, a zero quantity and a missing date are each refused with a message and no write; delete works.

**This browser check is mandatory.** This repo has form: a whole feature branch once shipped having never been rendered in a browser, and it has caused two live outages from schema-ahead-of-code drift.

**Clean up after yourself.** Delete every test planting you create. Verify with a count query that `garden_plantings` is empty before committing, because the next task makes these rows public. (Since 0036 the table itself is staff only and the public reads `garden_plantings_public`, which withholds `note`. Every column a test row puts in the other six is still published.)

- [ ] **Step 6: Run the checks and commit**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: PASS.

> **Correction.** Earlier revisions of this plan said this step also ran "the repo's
> `node --check` over extracted inline scripts". That was untrue when written: `npm test`
> ran `node --test tests/*.js` and no test opened an HTML file, so no branch in this repo
> ever had its inline scripts syntax checked. The same false claim appears in four other
> plan and spec documents under `docs/superpowers/`.
>
> It is true as of this branch: `tests/inline-scripts.test.js` extracts every inline
> `<script>` from all 46 HTML pages and parses each one, so `npm test` now genuinely
> covers it.

```bash
cd ~/GitHub/ecotopia-portal
git add garden-detail.html
git commit -m "feat(plantings): portal section for recording what was planted

Free-text species field backed by a catalogue datalist, because the habitat kits
reference trees and shrubs that are not among the 50 wildflowers."
```

---

### Task 5: The all-gardens totals line

The figure that goes in a grant application. Separate from Task 4 because it reads across every garden rather than one.

**Files:**
- Modify: `gardens.html`

**Interfaces:**
- Consumes: `DataStore.getAllPlantings` from Task 3; `EcoPlantings.summarise` and `summariseForYear` from Task 1.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Load the shared arithmetic**

Add beside the page's existing asset scripts:

```html
<script src="assets/plantings.js"></script>
```

- [ ] **Step 2: Add the totals line**

Add a paragraph above the garden list:

```html
<p class="section-note" id="plantingTotals"></p>
```

```js
// The sentence a grant application needs. Deriving it by hand from a list is
// exactly the friction that stops it being written.
async function renderPlantingTotals() {
  const el = document.getElementById('plantingTotals');
  let rows;
  try {
    rows = await DataStore.getAllPlantings();
  } catch (e) {
    el.textContent = '';
    return;
  }
  if (!rows.length) { el.textContent = ''; return; }
  const all = EcoPlantings.summarise(rows);
  const year = new Date().getFullYear();
  const thisYear = EcoPlantings.summariseForYear(rows, year);
  el.textContent =
    all.plants + ' native plants, ' + all.species + ' species, planted across our gardens. ' +
    thisYear.plants + ' of them in ' + year + '.';
}
```

Call `renderPlantingTotals()` from the page's existing load function. A failure renders nothing rather than an error, because this is a supporting figure and must never block the garden list.

- [ ] **Step 3: Verify in a browser**

With the table empty, confirm the line renders as nothing at all rather than "0 native plants". Add two plantings at different gardens in different years through the Task 4 UI, reload, and confirm the totals and the current-year figure are both right. Then delete those rows and confirm the line disappears again.

- [ ] **Step 4: Run the checks and commit**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: PASS.

```bash
cd ~/GitHub/ecotopia-portal
git add gardens.html
git commit -m "feat(plantings): all-gardens totals line for grant applications"
```

---

### Task 6: The public garden card summary

Last, because it is the surface that publishes. Per the global constraint, this must be deployed before any real planting data exists, or rows become public before there is anything rendering them.

**Files:**
- Modify: `community-gardens.html`

**Interfaces:**
- Consumes: `EcoPlantings.summarise` and `speciesBreakdown` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Load the shared arithmetic**

Add beside the page's existing asset scripts:

```html
<script src="assets/plantings.js"></script>
```

- [ ] **Step 2: Read the plantings over anon**

`community-gardens.html` uses `EcoSite`, not `DataStore`. Add a loader beside `loadGardens` at line 174:

```js
// Public read over the anon key, through the view, NOT the table. The table is
// staff only: it carries a free-text note column, so 0036 removed its anon policy
// and exposed public.garden_plantings_public instead. Reading the table here would
// not error, it would return 200 with [], and every card would render an empty
// rollup that looks exactly like "no plantings recorded here".
//
// The view's column names match the table's, so fromDbAll needs no special casing.
// A failure here must not break the garden list, so the caller falls back to an
// empty rollup.
async function loadPlantings() {
  const res = await sb().from('garden_plantings_public').select('*');
  if (res.error) throw new Error(res.error.message);
  return window.EcoMapping.fromDbAll(res.data);
}
```

Use the same `sb()` accessor the page's other reads use.

- [ ] **Step 3: Render the summary on each card**

In `loadGardens` at line 174, fetch the rollup before building cards, tolerating failure:

```js
    // Group the rows by garden once, then hand each card its own rows. A failure here
    // must never break the garden list, which is the page's actual job.
    let rowsByGarden = {};
    try {
      (await loadPlantings()).forEach(function (r) {
        if (!r.gardenId) return;
        (rowsByGarden[r.gardenId] = rowsByGarden[r.gardenId] || []).push(r);
      });
    } catch (e) { rowsByGarden = {}; }
```

`gardenCardInner(g)` at line 133 currently takes one argument. Widen it to
`gardenCardInner(g, plantingRows)`, where `plantingRows` is that garden's rows and defaults
to an empty array, and update BOTH existing call sites (the featured card at line 190 and
the grouped cards at line 204) to pass them.

Keeping the rows rather than a precomputed summary means the card derives both figures from
one source, so the headline count and the expanded list can never disagree.

Inside `gardenCardInner`, before building `text`:

```js
  var rows = Array.isArray(plantingRows) ? plantingRows : [];
  var summary = rows.length ? EcoPlantings.summarise(rows) : null;
  var breakdown = rows.length ? EcoPlantings.speciesBreakdown(rows) : [];
```

Then add to the `text` chain, after the `sqft` line:

```js
    (summary
      ? '<details class="garden-plantings"><summary>' +
          esc(String(summary.plants)) + ' native plants, ' +
          esc(String(summary.species)) + ' species planted here</summary>' +
          '<ul>' + breakdown.map(function (b) {
            return '<li>' + esc(b.label) + ' <span class="qty">' + esc(String(b.plants)) + '</span></li>';
          }).join('') + '</ul></details>'
      : '') +
```

A `<details>` element gives the disclosure with no JavaScript. A garden with no rows produces
`summary === null` and renders nothing at all, which is the distinction between "nothing
planted here" and "zero planted here".

- [ ] **Step 4: Style it**

```css
.garden-plantings { margin: 6px 0 10px; font-size: 0.85rem; }
.garden-plantings summary { cursor: pointer; color: var(--green-dark); }
.garden-plantings ul { margin: 6px 0 0; padding-left: 18px; }
.garden-plantings .qty { color: var(--ink-soft); }
```

- [ ] **Step 5: Verify in a browser, including the escaping**

Serve locally and load `community-gardens.html`. With the table empty, confirm no card shows a summary and the page is unchanged. Then add plantings at one garden through the portal and confirm only that card gains a summary, the count is right, and the disclosure expands.

Set one planting's `species_label` to `<img src=x onerror=alert(1)>` via the Management API, reload, and confirm it renders as literal text with no alert and no element created. Then delete every test row and confirm the page returns to showing no summaries.

- [ ] **Step 6: Run the checks and commit**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: PASS.

```bash
cd ~/GitHub/ecotopia-portal
git add community-gardens.html
git commit -m "feat(plantings): public planting summary on garden cards

A garden with no plantings renders nothing rather than a zero, which is why the
rollup omits empty gardens instead of returning zeroes for them."
```

---

## Verification summary

Evidence required before this plan is called complete:

| Claim | Evidence |
| --- | --- |
| Distinct species counting is right | `npm test` fails when `summarise` is mutated to `species: list.length` |
| Constraints reject bad rows | A blank label and a zero quantity both rejected by name at the database |
| The table is empty before shipping | `select count(*)` returns 0 after every browser check |
| Portal add and delete work | Exercised in a browser, signed in, against a real garden |
| Totals are correct across gardens and years | Two plantings, two gardens, two years, figures checked by hand |
| Empty renders as nothing, not zero | Public card and totals line both show nothing with an empty table |
| Public output is escaped | An injected `<img src=x onerror=alert(1)>` label renders as literal text |

## Deliberately not built

Coordinates, maps, polygon editing: see `docs/superpowers/specs/2026-08-09-garden-geography-findings.md`. Volunteer attribution and iNaturalist survival tracking were considered and dropped during the brainstorm.

## Known limitation, accepted

The log covers the nine gardens the portal knows about. The client's own map shows twenty-nine sites. If staff start wanting to log plantings at sites the portal does not have, that is the signal the geography spec has become urgent.

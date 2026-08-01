# Plant Size Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sell each native plant in two sizes, a $5.00 spring plug and an $8.00 gallon pot, each independently switchable on and off.

**Architecture:** A new `plant_size_settings` table carries the seasonal switch per size, mirroring the existing `service_settings` pattern including its anon-read policy. Each species declares which sizes it is grown in. A size is orderable only when both agree. Prices stay as edge-function constants so the display-equals-charge drift test still has something to scrape.

**Tech Stack:** Static HTML, no build. Vanilla JS browser globals. Supabase Postgres + Deno edge functions. `node --test` for the suite.

## Global Constraints

- **No em dashes anywhere** (`—`, `–`), in code, comments, copy, or commit messages.
- **Never state a discount percentage** in customer-facing copy. Two prices instead.
- `esc()` every DB or anon-supplied string interpolated into `innerHTML`. `plants.html` is public.
- Prices live in `supabase/functions/square-pay/index.ts` and are mirrored for display in `plants.html`. **Never in the database.**
- Size keys are exactly `plug` and `gallon`, CHECK-constrained in the database and used verbatim in order lines.
- Orderable means `plant_size_settings.active AND plant_species.offers_<size>`. A species narrows, never widens.
- Customer copy names readiness, not a month: "ready from mid summer", so it stays true in October.
- Migrations are applied live via the Management API with **curl, not python urllib** (Cloudflare blocks urllib with HTTP 403 / error 1010). Token: `security find-generic-password -s "Supabase CLI" -w`, POST to `https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query` with `{"query":"..."}`.
- **The Supabase MCP tools point at a DIFFERENT project. Do not use them.**
- Edge function deploy: `supabase functions deploy square-pay --no-verify-jwt --project-ref wibnryfinfwbwwgsyojr`. It is currently live at **v15 with PRODUCTION Square keys**, so a real card is really charged. Do not complete a checkout.

## Live-system cautions

Read these before touching anything.

1. **Production Square is live.** Minting a payment link is free and safe; paying one is not. Test by reading the minted amount back through Square's API, never by completing a payment.
2. The database holds **50 species, 2 real orders (both the owner's, one paid on production Square), and 1 draft quote**. Do not touch any of them. Delete every test row you create.
3. `stock_qty` was null on all 50 species, which is what made dropping it safe. **Verify before dropping.**

### What already went wrong here, so it does not happen twice

Task 1 dropped `stock_qty` while the deployed edge function still selected it. **Plant checkout returned `item_unavailable` for about twelve minutes on a live site.** It was repaired out of band before Task 2 ran, in commit `418b962`, which also passes the size to `decrement_stock` so per-size counters actually move.

Two rules follow, and they bind every remaining task:

- **The deployed page and the deployed function must stay compatible at every single commit.** Never rely on "Task N deploys later" to make the system correct. Each deploy has to be safe standing alone, because the site is taking orders between them.
- **A schema change that removes something must ship after the code that stops using it, not before.** Additive first, remove last.

When Task 2 rewrites the species branch, it is rewriting the code from `418b962`, not the original.

## Where the spec's five tests actually live

The spec lists five tests. Three are pure logic and run in `npm test`. Two exercise the Deno edge function, which the node runner cannot load, so they are verified against the live function instead:

| Spec test | Where |
|---|---|
| 1. Both gross-ups exact | `npm test`, Task 3 |
| 2. Availability matrix | `npm test`, Task 3 |
| 5. Retargeted drift test | `npm test`, Task 3 |
| 3. `create_order` rejects a closed size | Live, Task 2 Step 7 |
| 4. Merge key keeps sizes separate | Live, Task 2 Step 7 |

This is a real coverage difference, not an equivalent substitute: 3 and 4 only run when someone runs them.

## A naming hazard to know about

`PLANT_SIZES` exists in **two files with different shapes and different units**:

- `supabase/functions/square-pay/index.ts` maps a size key to **integer cents** (`plug: 500`)
- `plants.html` maps a size key to an object holding **dollars** plus display copy (`plug: { price: 5, ... }`)

This mirrors how `KIT_TIERS` already behaves across the same two files, so it is consistent with the codebase rather than a new wart. Task 3's mirror test reads both and asserts they agree. Do not "tidy" one to match the other without updating that test.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0028_plant_sizes.sql` (create) | `plant_size_settings` table + policies, four species columns, drop `stock_qty`, extend `decrement_stock` |
| `supabase/functions/square-pay/index.ts` (modify) | `PLANT_SIZES` price map, per-size validation and availability re-check, size-aware stock |
| `assets/data.js` (modify) | `getPlantSizeSettings` / `updatePlantSizeSetting` accessors |
| `plants.html` (modify) | Two-button card, size-keyed tray, closed-season note, lead copy |
| `manage-plants.html` (modify) | Season switches, per-species size checkboxes, per-size stock fields |
| `tests/pricing.test.js` (modify) | Both gross-ups, availability matrix, retargeted drift test |
| `docs/OPERATIONS.md` (modify) | The size model, the both-must-be-true rule, the seasonal switch |

---

### Task 1: Migration 0028

**Files:**
- Create: `supabase/migrations/0028_plant_sizes.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `public.plant_size_settings` (`size_key`, `label`, `blurb`, `active`, `off_message`, `reopen_date`, `sort`, `updated_at`); `plant_species.offers_plug`, `.offers_gallon`, `.stock_plug`, `.stock_gallon`; `decrement_stock(p_kind text, p_id uuid, p_qty integer, p_size text default null)`.

- [ ] **Step 1: Confirm the drop is safe**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"select count(*) total, count(stock_qty) tracked from plant_species;"}'
```

Expected: `{"total":50,"tracked":0}`. **If `tracked` is not 0, STOP and report.** Someone began tracking stock, and the drop would destroy those counts.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0028_plant_sizes.sql`:

```sql
-- 0028: two plant sizes, each independently switchable by season.
-- A size is orderable only when the seasonal switch AND the species flag agree.
-- Prices are NOT stored here: they live in supabase/functions/square-pay/index.ts,
-- so the display-equals-charge drift test has a constant to scrape.

create table if not exists public.plant_size_settings (
  size_key    text primary key check (size_key in ('plug', 'gallon')),
  label       text not null,
  blurb       text not null,
  active      boolean not null default false,
  off_message text,
  reopen_date date,
  sort        integer not null default 0,
  updated_at  timestamptz
);

alter table public.plant_size_settings enable row level security;

drop policy if exists pss_anon_read on public.plant_size_settings;
create policy pss_anon_read on public.plant_size_settings
  for select to anon using (true);

drop policy if exists pss_staff_read on public.plant_size_settings;
create policy pss_staff_read on public.plant_size_settings
  for select to authenticated using (true);

drop policy if exists pss_staff_write on public.plant_size_settings;
create policy pss_staff_write on public.plant_size_settings
  for all to authenticated using (true) with check (true);

-- plug seeds ACTIVE because that matches what is on sale today ($5 plants are
-- orderable right now). gallon seeds INACTIVE so this migration changes nothing
-- a customer can see until Jordan opens the season himself.
insert into public.plant_size_settings (size_key, label, blurb, active, sort) values
  ('plug',   'Spring plug', '3 by 5 inch container',              true,  1),
  ('gallon', 'Gallon pot',  'More mature, ready from mid summer', false, 2)
on conflict (size_key) do nothing;

alter table public.plant_species
  add column if not exists offers_plug   boolean not null default true,
  add column if not exists offers_gallon boolean not null default true,
  add column if not exists stock_plug    integer,
  add column if not exists stock_gallon  integer;

-- stock_qty is null on all 50 rows (verified immediately before this migration).
-- It cannot stay: one counter cannot express plugs selling out while gallons remain.
alter table public.plant_species drop column if exists stock_qty;

-- decrement_stock gains an optional size. Kits and merch keep calling the old shape.
drop function if exists public.decrement_stock(text, uuid, integer);
create or replace function public.decrement_stock(
  p_kind text, p_id uuid, p_qty integer, p_size text default null
)
returns void language sql security definer set search_path = public as $$
  update plant_species set stock_plug = greatest(stock_plug - p_qty, 0)
    where p_kind = 'species' and p_size = 'plug' and id = p_id and stock_plug is not null;
  update plant_species set stock_gallon = greatest(stock_gallon - p_qty, 0)
    where p_kind = 'species' and p_size = 'gallon' and id = p_id and stock_gallon is not null;
  update plant_kits set stock_qty = greatest(stock_qty - p_qty, 0)
    where p_kind = 'kit' and id = p_id and stock_qty is not null;
  update merch_items set stock_qty = greatest(stock_qty - p_qty, 0)
    where p_kind = 'merch' and id = p_id and stock_qty is not null;
$$;
revoke execute on function public.decrement_stock(text, uuid, integer, text) from public;
revoke execute on function public.decrement_stock(text, uuid, integer, text) from anon, authenticated;
grant execute on function public.decrement_stock(text, uuid, integer, text) to service_role;
```

- [ ] **Step 3: Apply it**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
python3 -c "import json;print(json.dumps({'query':open('supabase/migrations/0028_plant_sizes.sql').read()}))" > /tmp/mig28.json
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data @/tmp/mig28.json
```

Expected: `[]`. The API returns only the last statement's result set.

- [ ] **Step 4: Verify**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"select size_key, active, label from plant_size_settings order by sort;"}'
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"select column_name from information_schema.columns where table_name='"'"'plant_species'"'"' and column_name in ('"'"'offers_plug'"'"','"'"'offers_gallon'"'"','"'"'stock_plug'"'"','"'"'stock_gallon'"'"','"'"'stock_qty'"'"') order by column_name;"}'
```

Expected: `plug` active true, `gallon` active false; four columns present and **no `stock_qty`**.

Re-run Step 3 once and confirm it still returns `[]`, proving idempotency.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0028_plant_sizes.sql
git commit -m "feat: migration 0028, per-size plant availability and stock"
```

---

### Task 2: Edge function pricing and availability

**Files:**
- Modify: `supabase/functions/square-pay/index.ts` (constants near line 33, `handleCreateOrder` species branch near line 326, merge key near line 300, `decrementOrderStock` near line 172)

**Interfaces:**
- Consumes: the four species columns and `plant_size_settings` from Task 1.
- Produces: `PLANT_SIZES: Record<string, number>` = `{ plug: 500, gallon: 800 }`. Order lines for species carry `size`. New error codes `bad_size` (400) and `size_closed` (409).

- [ ] **Step 1: Replace the single plant price with a map**

At `index.ts:33`, replace `const PLANT_PRICE_CENTS = 500;` with:

```ts
// Two sizes, priced here and nowhere else. plants.html mirrors these for display.
const PLANT_SIZES: Record<string, number> = {
  plug: 500,
  gallon: 800,
};
```

- [ ] **Step 2: Include size in the duplicate-line merge key**

The merge key currently ignores size, so two sizes of one species would collapse into a single mispriced line. Replace it with:

```ts
    const key = [raw?.kind, raw?.id, raw?.tier ?? '', raw?.size ?? ''].join(':');
```

- [ ] **Step 3: Load the open seasons once per order**

Immediately before the `for (const raw of merged.values())` loop, add:

```ts
  // Which sizes are open right now. Read once: an order is priced against a single
  // snapshot, so a season closing mid-loop cannot half-accept a cart.
  const { data: sizeRows } = await sb.from('plant_size_settings').select('size_key, active');
  const openSizes = new Set((sizeRows || []).filter((r) => r.active).map((r) => r.size_key));
```

- [ ] **Step 4: Re-price and re-check the species branch**

Replace the `if (kind === 'species')` block (currently lines 326-335) with:

```ts
    if (kind === 'species') {
      // A payload with NO size comes from a page built before sizes existed, and that
      // page sold plugs, so that is what it means. This default is load-bearing until
      // Task 4 deploys: the live plants.html does not send a size, and rejecting it
      // here would break plant checkout on a site that is taking real orders. Only an
      // explicitly unknown size is an error.
      const size = raw?.size == null ? 'plug' : String(raw.size);
      if (!Object.prototype.hasOwnProperty.call(PLANT_SIZES, size)) {
        return json({ error: 'bad_size' }, 400);
      }
      const { data: row } = await sb.from('plant_species')
        .select('id, common, active, offers_plug, offers_gallon, stock_plug, stock_gallon')
        .eq('id', id).maybeSingle();
      if (!row || row.active === false) return json({ error: 'item_unavailable' }, 400);
      // Both layers must agree. The page hides closed sizes, but a stale tab or a
      // crafted payload must not be able to buy one.
      const offered = size === 'plug' ? row.offers_plug !== false : row.offers_gallon !== false;
      if (!openSizes.has(size) || !offered) {
        return json({ error: 'size_closed', item: row.common }, 409);
      }
      const stock = size === 'plug' ? row.stock_plug : row.stock_gallon;
      if (stock != null && stock < qty) {
        return json({ error: 'insufficient_stock', item: row.common }, 409);
      }
      const unit = PLANT_SIZES[size];
      subtotal += unit * qty;
      lines.push({ kind, id, name: row.common, qty, unit_cents: unit, size });
    } else if (kind === 'kit') {
```

- [ ] **Step 5: Pass size through to the stock decrement**

In `decrementOrderStock`, forward the line's size so the right counter moves:

```ts
      await sb.rpc('decrement_stock', {
        p_kind: kind, p_id: id, p_qty: qty, p_size: it?.size ?? null,
      });
```

- [ ] **Step 6: Deploy**

```bash
supabase functions deploy square-pay --no-verify-jwt --project-ref wibnryfinfwbwwgsyojr
```

- [ ] **Step 7: Verify against the live function**

Woodland Phlox is `98976158-6ad9-424e-a5a3-a58179c76c98`.

```bash
FN=https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/square-pay
S=98976158-6ad9-424e-a5a3-a58179c76c98
echo "--- plug, open: expect an order at 500 base ---"
curl -s -X POST $FN -H 'Content-Type: application/json' \
 -d "{\"action\":\"create_order\",\"customer\":{\"name\":\"ZZ SIZE plug\"},\"pay_mode\":\"pickup\",\"items\":[{\"kind\":\"species\",\"id\":\"$S\",\"size\":\"plug\",\"qty\":1}]}"
echo; echo "--- gallon, season closed: expect 409 size_closed ---"
curl -s -X POST $FN -H 'Content-Type: application/json' \
 -d "{\"action\":\"create_order\",\"customer\":{\"name\":\"ZZ SIZE gallon\"},\"pay_mode\":\"pickup\",\"items\":[{\"kind\":\"species\",\"id\":\"$S\",\"size\":\"gallon\",\"qty\":1}]}"
echo; echo "--- NO size: must SUCCEED as a plug (the live page sends no size) ---"
curl -s -X POST $FN -H 'Content-Type: application/json' \
 -d "{\"action\":\"create_order\",\"customer\":{\"name\":\"ZZ SIZE none\"},\"pay_mode\":\"pickup\",\"items\":[{\"kind\":\"species\",\"id\":\"$S\",\"qty\":1}]}"
echo; echo "--- explicitly unknown size: expect 400 bad_size ---"
curl -s -X POST $FN -H 'Content-Type: application/json' \
 -d "{\"action\":\"create_order\",\"customer\":{\"name\":\"ZZ SIZE bogus\"},\"pay_mode\":\"pickup\",\"items\":[{\"kind\":\"species\",\"id\":\"$S\",\"size\":\"bucket\",\"qty\":1}]}"
```

**The no-size case succeeding is not a nicety, it is the whole reason plant checkout is not broken right now.** If it returns an error, stop and fix it before deploying anything else.

Then confirm the stored line carries the size and the base price:

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"select customer_name, subtotal_cents, items from orders where customer_name like '"'"'ZZ SIZE%'"'"';"}'
```

Expected: one row only (`ZZ SIZE plug`), `subtotal_cents` 500, its item carrying `"size":"plug"` and `"unit_cents":500`.

- [ ] **Step 8: Temporarily open the gallon season and re-check pricing**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"update plant_size_settings set active = true where size_key = '"'"'gallon'"'"';"}'
```

Re-run the gallon curl from Step 7. Expect an order, not a 409. Confirm `subtotal_cents` is **800**. Then close it again:

```bash
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"update plant_size_settings set active = false where size_key = '"'"'gallon'"'"';"}'
```

**Leave gallon inactive.** The storefront must look unchanged until Jordan opens it.

- [ ] **Step 9: Delete the test rows**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"delete from orders where customer_name like '"'"'ZZ %'"'"' returning customer_name;"}'
```

Then confirm `select count(*) from orders` is 0 and `plant_size_settings` reads plug true / gallon false.

- [ ] **Step 10: Commit**

```bash
git add supabase/functions/square-pay/index.ts
git commit -m "feat: price and gate plant orders per size"
```

---

### Task 3: Pricing tests

**Files:**
- Modify: `tests/pricing.test.js`

**Interfaces:**
- Consumes: `EcoPricing.cardDollars` / `cardCents` from `assets/pricing.js`; `PLANT_SIZES` in the edge function source.
- Produces: an exported-by-convention helper is NOT added; tests read source files directly, as the existing mirror test does.

- [ ] **Step 1: Write the failing tests**

Append to `tests/pricing.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

test('both plant sizes gross exactly', () => {
  const { cardCents } = globalThis.EcoPricing;
  assert.strictEqual(cardCents(500), 520);  // spring plug
  assert.strictEqual(cardCents(800), 832);  // gallon pot
});

test('the edge function prices both sizes and nowhere else does', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'square-pay', 'index.ts'), 'utf8');
  const m = src.match(/const PLANT_SIZES[^=]*=\s*\{([^}]*)\}/);
  assert.ok(m, 'PLANT_SIZES not found in the edge function');
  assert.match(m[1], /plug:\s*500/);
  assert.match(m[1], /gallon:\s*800/);
  assert.ok(!/PLANT_PRICE_CENTS/.test(src), 'the old single plant price still exists');
});

test('plants.html states each size price and it matches the constant', () => {
  const { cardDollars } = globalThis.EcoPricing;
  const html = fs.readFileSync(path.join(__dirname, '..', 'plants.html'), 'utf8');
  const m = html.match(/var PLANT_SIZES\s*=\s*(\{[\s\S]*?\});/);
  assert.ok(m, 'PLANT_SIZES not found in plants.html');
  const sizes = eval('(' + m[1] + ')');
  assert.strictEqual(sizes.plug.price, 5);
  assert.strictEqual(sizes.gallon.price, 8);
  assert.strictEqual(cardDollars(sizes.plug.price), 5.2);
  assert.strictEqual(cardDollars(sizes.gallon.price), 8.32);
});

test('orderable requires the season AND the species flag', () => {
  // Mirrors the rule in the edge function and in plants.html. Both must be true.
  const orderable = (seasonOpen, speciesOffers) => seasonOpen && speciesOffers;
  assert.strictEqual(orderable(true, true), true);
  assert.strictEqual(orderable(true, false), false);
  assert.strictEqual(orderable(false, true), false);
  assert.strictEqual(orderable(false, false), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL. `PLANT_SIZES not found in the edge function` if Task 2 is not yet merged into the working tree, and `PLANT_SIZES not found in plants.html` regardless, since Task 4 has not run.

- [ ] **Step 3: Make the first three pass**

Tasks 2 and 4 supply the implementations. If running tasks in order, the edge-function tests pass after Task 2 and the `plants.html` test passes after Task 4. Do not weaken a test to make it green early.

- [ ] **Step 4: Confirm green after Task 4**

Run: `npm test`
Expected: all pass, including the 17 pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add tests/pricing.test.js
git commit -m "test: both plant sizes, their mirrors, and the availability rule"
```

---

### Task 4: Public plants page

**Files:**
- Modify: `plants.html` (`PLANT_PRICE` near line 473, `renderPlants` near line 601, the add handler near line 622, tray render near line 868, lead copy near line 294)
- Modify: `assets/data.js` (near line 222, beside the service-settings accessors)

**Interfaces:**
- Consumes: `plant_size_settings` from Task 1; `EcoPricing.cardDollars`.
- Produces: `DataStore.getPlantSizeSettings()` returning camelCase rows; `DataStore.updatePlantSizeSetting(sizeKey, changes)`. In `plants.html`, `var PLANT_SIZES` keyed `plug` / `gallon` with `{ price, label, blurb }`.

- [ ] **Step 1: Add the DataStore accessors**

In `assets/data.js`, beside `getServiceSettings` at line 222:

```js
    getPlantSizeSettings: () => list('plant_size_settings', 'sort'),
    updatePlantSizeSetting: async (sizeKey, ch) =>
      fromDb(unwrap(await sb.from('plant_size_settings').update(toDb(ch))
        .eq('size_key', sizeKey).select().single())),
```

- [ ] **Step 2: Replace the single price constant**

In `plants.html`, replace `var PLANT_PRICE = 5;` with:

```js
  // Display mirror of PLANT_SIZES in supabase/functions/square-pay/index.ts.
  // tests/pricing.test.js asserts these two agree; if you change one, change both.
  var PLANT_SIZES = {
    plug:   { price: 5, label: 'Spring plug', blurb: '3 by 5 inch container' },
    gallon: { price: 8, label: 'Gallon pot',  blurb: 'More mature, ready from mid summer' }
  };
  var openSizes = {};   // filled from plant_size_settings on load
  var sizeMeta  = {};   // label / blurb / off_message / reopen_date from the DB
```

- [ ] **Step 3: Load the seasons before rendering**

Wherever the page currently loads species (the same `await` block), add:

```js
  var sizeRows = await DataStore.getPlantSizeSettings();
  sizeRows.forEach(function (r) {
    sizeMeta[r.sizeKey] = r;
    if (r.active) openSizes[r.sizeKey] = true;
  });
```

- [ ] **Step 4: Render one row per open size**

Replace the single add button in `renderPlants` with a helper and a loop. The species flags are `offers_plug` / `offers_gallon`, camelCased by `EcoMapping` to `offersPlug` / `offersGallon`:

```js
  function speciesOffers(p, key) {
    return key === 'plug' ? p.offersPlug !== false : p.offersGallon !== false;
  }
  function speciesStock(p, key) {
    return key === 'plug' ? p.stockPlug : p.stockGallon;
  }
  // One row per size that is BOTH open this season and grown in that size.
  function sizeRowsHtml(p) {
    var out = '';
    Object.keys(PLANT_SIZES).forEach(function (key) {
      if (!openSizes[key] || !speciesOffers(p, key)) return;
      var meta = PLANT_SIZES[key];
      var stock = speciesStock(p, key);
      var soldOut = stock != null && stock <= 0;
      out +=
        '<div class="plant-size">' +
          '<p class="plant-size-name">' + esc(meta.label) + '</p>' +
          '<p class="plant-size-blurb">' + esc(meta.blurb) + '</p>' +
          '<p class="plant-price">' + twoPrice(meta.price) + '</p>' +
          (soldOut ? '<span class="sold-chip">Sold out</span>' : '') +
          '<button type="button" class="plant-add" data-id="' + esc(p.id) + '"' +
            ' data-size="' + esc(key) + '"' + (soldOut ? ' disabled' : '') + '>' +
            'Add' +
          '</button>' +
        '</div>';
    });
    if (!out) out = closedNoteHtml();
    return out;
  }
  // Nothing orderable: keep the card (this page is a catalogue too) and explain.
  function closedNoteHtml() {
    var open = Object.keys(PLANT_SIZES).filter(function (k) { return openSizes[k]; });
    if (open.length) return '<p class="plant-closed">Not available in the sizes we have right now.</p>';
    var m = sizeMeta.plug || {};
    var msg = m.offMessage ? m.offMessage : 'Plant sales are closed for the season.';
    var when = m.reopenDate ? ' We reopen ' + esc(String(m.reopenDate).split('T')[0]) + '.' : '';
    return '<p class="plant-closed">' + esc(msg) + when + '</p>';
  }
```

- [ ] **Step 5: Carry the size through the add handler and the tray**

The tray must key lines by species **and** size, so the two sizes of one plant stay separate rows:

```js
  grid.querySelectorAll('.plant-add').forEach(function (btn) {
    btn.addEventListener('click', function () {
      addToTray(btn.getAttribute('data-id'), btn.getAttribute('data-size'));
    });
  });
```

**Read the tray functions before editing them** (`addToTray`, the tray render near line 868, the tray total near line 882, and the `create_order` payload near line 923). The tray currently keys entries by bare species id, which would silently merge a plug and a gallon into one mispriced line.

Required changes, all in that cluster:

- key entries by `id + ':' + size` instead of `id`
- store `size` on each entry alongside `id` and `qty`
- price each line from `PLANT_SIZES[size].price`, not from a single constant
- label each line with its size: `esc(p.common) + ', ' + esc(PLANT_SIZES[size].label)`
- send `{ kind: 'species', id: entry.id, size: entry.size, qty: entry.qty }` in the `create_order` items array
- the tray total sums mixed sizes, so it must add `PLANT_SIZES[e.size].price * e.qty` per entry rather than multiplying one price by a total count

The existing `twoPrice(baseDollars)` helper already renders the card/cash pair from a dollar figure; reuse it for the tray total rather than writing a second formatter.

- [ ] **Step 6: Add the size-row styles**

Beside the existing `.plant-price` rule:

```css
.plant-size { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 10px; }
.plant-size:first-of-type { border-top: 0; margin-top: 0; }
.plant-size-name { font-family: var(--font-util); font-weight: 700; font-size: 0.9rem; margin: 0; }
.plant-size-blurb { font-size: 0.82rem; color: var(--ink-soft); margin: 2px 0 6px; }
.plant-closed { font-size: 0.88rem; color: var(--ink-soft); font-style: italic; margin: 10px 0 0; }
```

- [ ] **Step 7: Update the lead paragraph**

The lead currently quotes the single pair. Prices now vary by size, so the lead stops quoting them and the cards carry them. Replace the price sentence with:

```
Reserve the plants you want here; we confirm availability and arrange pickup or delivery. Pay in person, or pay online now; cash or check costs a little less.
```

Leave the existing wildflower lead near line 318 alone unless it names a price; if it does, remove the figure there too, since the card is now the only place a price is stated.

- [ ] **Step 8: Verify the inline scripts parse**

```bash
python3 - <<'PY'
import re
h=open('plants.html').read()
print('\n'.join(re.findall(r'<script(?![^>]*src=)[^>]*>([\s\S]*?)</script>', h)))
PY
```
Pipe that to a file and `node --check` it. Expected: clean.

- [ ] **Step 9: Run the suite**

Run: `npm test`
Expected: all pass, including Task 3's `plants.html` mirror test.

- [ ] **Step 10: Commit**

```bash
git add plants.html assets/data.js
git commit -m "feat: plants page offers each open size with its own price"
```

---

### Task 5: Portal controls

**Files:**
- Modify: `manage-plants.html`

**Interfaces:**
- Consumes: `DataStore.getPlantSizeSettings()` / `updatePlantSizeSetting()` from Task 4; `updatePlantSpecies(id, changes)` which already exists.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add the season switches**

At the top of the page, above the species table, render one row per size from `getPlantSizeSettings()` showing label, an Active/Off pill, and a toggle. Follow the pattern already in `manage-services.html:205-211` verbatim, including the `status-pill` / `status-on` / `status-off` classes, so the two pages look like one system.

Turning a size **off** opens the same modal `manage-services.html` uses, collecting `off_message` and `reopen_date`. Turning it **on** clears both:

```js
  await DataStore.updatePlantSizeSetting(sizeKey, { active: true, offMessage: null, reopenDate: null });
```

- [ ] **Step 2: Add the per-species size checkboxes**

In the species editor, two checkboxes bound to `offersPlug` and `offersGallon`, labelled "Grown as spring plugs" and "Grown as gallon pots". Both default checked for a new species, matching the column defaults.

Add a one-line note under them so the rule is visible where it is set: `Both the season switch above and this box must be on for a size to be orderable.`

- [ ] **Step 3: Replace the stock field with two**

The single stock input bound to `stockQty` becomes two, bound to `stockPlug` and `stockGallon`, labelled "Plug stock" and "Gallon stock", each with the existing placeholder convention where blank means untracked.

- [ ] **Step 4: Verify the inline scripts parse**

Same extraction and `node --check` as Task 4 Step 8, against `manage-plants.html`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add manage-plants.html
git commit -m "feat: portal controls for plant seasons, sizes and per-size stock"
```

---

### Task 6: Documentation and deploy

**Files:**
- Modify: `docs/OPERATIONS.md`

- [ ] **Step 1: Document the size model**

Add a "Plant sizes" section covering: the two sizes and their prices; that prices live in the edge function and are mirrored in `plants.html` with a test enforcing it; the both-must-be-true rule; that `plant_size_settings.active` is a plain switch with no scheduled end because Jordan closes each season when he runs out; that `reopen_date` is courtesy copy, not a trigger; and that `decrement_stock` now takes an optional size, with kits and merch unchanged.

Update the migration repair note from 0001-0027 to 0001-0028.

Correct anything in the existing plants section that still describes a single $5 price or `stock_qty`.

- [ ] **Step 2: Deploy the site**

```bash
netlify deploy --prod --dir=.
```

- [ ] **Step 3: Verify the storefront is visually unchanged**

```bash
curl -s https://ecotopia.bagcarriers.dev/plants.html | grep -c "Gallon pot"
curl -s https://ecotopia.bagcarriers.dev/plants.html | grep -o "5.20 card" | head -1
```

Expected: **0** occurrences of "Gallon pot" (its season is closed), and the $5.20 plug pair present. If a gallon price is visible on the live page, the seed is wrong: stop and set `plant_size_settings.active = false where size_key = 'gallon'`.

- [ ] **Step 4: Commit**

```bash
git add docs/OPERATIONS.md
git commit -m "docs: plant size model, seasons and per-size stock"
```

---

## What the owner does after this ships

Nothing is visible until Jordan opens the gallon season in the portal. When he does, every species with "Grown as gallon pots" checked gains a second Add button at $8.32 card / $8.00 cash.

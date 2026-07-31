# Plant size options (spring plug and gallon pot)

Design approved 2026-07-31. Native plants gain two size options at different prices, each independently switchable on and off so Jordan can follow his growing season.

## Why

Today every plant is $5.00 in a 3 by 5 inch container. Jordan also grows a more mature plant in a gallon pot, ready from mid summer, worth $8.00. The two are seasonal rather than permanent: plugs sell in spring, gallons run from mid summer into fall, and he needs to open and close each on his own schedule without editing fifty species by hand.

Neither season has a scheduled end. Jordan switches each off when he runs out, which is why `active` is a plain boolean and not a date range. `reopen_date` stays available as courtesy copy for the closed state, not as a trigger.

Customer-facing copy names readiness rather than a month ("ready from mid summer"), so it stays true in October without anyone editing it.

## Decisions

1. **Global seasonal switch per size, with a per-species override.** Two switches drive the season; individual species declare which sizes they are grown in.
2. **Both must be true to order.** `plant_size_settings.active AND plant_species.offers_<size>`. A species can narrow availability, never widen it. One rule to hold in your head, and the seasonal switch is always the last word.
3. **Two add buttons per card when both sizes are open.** A customer can take plugs of one species and a gallon of another in the same order, which is how a nursery bench actually gets shopped.
4. **Stock splits per size.** Plugs run out in May while gallons are still coming; one counter cannot express that.
5. **Prices stay in code, not in the settings table.** See "Pricing authority" below.

## Data model

### New table `public.plant_size_settings`

Mirrors the existing `service_settings` pattern, including its anon-read policy, because this is the same shape of problem (a public surface that staff open and close with a courtesy message).

| Column | Type | Notes |
|---|---|---|
| `size_key` | text PK | `plug` or `gallon`, CHECK constrained |
| `label` | text not null | "Spring plug", "Gallon pot" |
| `blurb` | text not null | "3 by 5 inch container", "More mature, ready from mid summer" |
| `active` | boolean not null default false | Jordan's seasonal switch |
| `off_message` | text | shown when closed, as services already do |
| `reopen_date` | date | shown when closed |
| `sort` | integer not null default 0 | display order |
| `updated_at` | timestamptz | |

RLS: anon SELECT, staff ALL. Same policy shape as `service_settings`.

### Changes to `public.plant_species`

```sql
add column offers_plug    boolean not null default true
add column offers_gallon  boolean not null default true
add column stock_plug     integer            -- null = untracked
add column stock_gallon   integer            -- null = untracked
drop column stock_qty
```

`stock_qty` is null on all 50 rows (verified 2026-07-31), so dropping it loses nothing. Leaving it would be a counter that cannot be correct once two sizes share it.

### Seed values

`plug` seeds `active = true`, `gallon` seeds `active = false`.

**The migration must not change what is currently for sale.** Plug-active matches today's behavior exactly, where $5 plants are orderable. Gallon stays dark until Jordan opens it himself.

## Pricing authority

The edge function's `PLANT_PRICE_CENTS = 500` becomes a map in the same shape `KIT_TIERS` already uses:

```ts
const PLANT_SIZES: Record<string, number> = { plug: 500, gallon: 800 };
```

Both gross exactly: $5.00 to $5.20, $8.00 to $8.32.

**Prices deliberately do NOT live in `plant_size_settings`.** Three reasons:

1. It matches how plants and kits already work; only merch reads a price from the database.
2. The existing drift test scrapes page copy back to a code constant. That only works if there is a constant to scrape.
3. A staff-editable price field would let the displayed and charged figures disagree, which is the exact failure the cash-discount work exists to prevent.

Changing $8.00 later is a one-line code change plus a redeploy, which is the correct weight for a headline price.

## Order lines

A species line becomes `{kind: 'species', id, size, qty}`, mirroring how kit lines already carry `tier`.

The server re-prices from `size` against `PLANT_SIZES` and **re-checks availability** before accepting, so a stale page or a crafted payload cannot order a closed size. Client-sent prices remain ignored, as now.

The duplicate-line merge key extends from `kind:id:tier` to include `size`, so the two sizes of one species stay separate lines rather than collapsing into one mispriced row.

`decrement_stock` gains an optional size argument defaulting to null. Kits and merch keep calling it unchanged; species pass the size and hit the matching counter.

## Customer-facing (`plants.html`)

The card keeps its catalog role (bloom, height, what it attracts, the fact) and gains an availability block:

- **Both open:** two rows, each with its own price pair and Add button, each labelled with the size and its blurb.
- **One open:** a single row. This is the normal state for most of the year.
- **Neither open:** no buttons, plus the `off_message` and `reopen_date` note, exactly as a closed service card renders today. The card stays visible because people read this page to learn about the plants, not only to buy them.

Sold-out is evaluated per size against the matching counter.

The tray keys lines by species **and** size, so "New England Aster, spring plug x3" and "New England Aster, gallon x1" are separate rows that price independently.

### Lead paragraph

The lead currently states the $5.20 / $5.00 pair, and `tests/pricing.test.js` scrapes it to catch drift. Spelling out four figures in one sentence reads badly, so **the lead stops quoting prices and the cards carry them.**

The drift test retargets from the prose to the card renderer, asserting the rendered pair for each size matches `cardDollars` of that size's constant. Same protection, applied to the surface that now states the numbers.

## Portal (`manage-plants.html`)

Two season switches at the top, carrying the same active / off-message / reopen-date fields `manage-services.html` already uses.

Per species: two checkboxes for which sizes that plant is grown in, and two stock fields.

## Testing

Added to the existing `npm test` suite:

1. Both gross-ups exact: 500 to 520, 800 to 832.
2. The availability matrix: all four combinations of global switch and species flag, asserting only both-on is orderable.
3. `create_order` rejects a line whose size is closed, by either layer.
4. The merge key keeps two sizes of one species as separate lines.
5. The retargeted drift test: each rendered card pair matches its constant.

Plus the existing `node --check` pass over extracted inline scripts.

## Rollout

1. Apply migration 0028 via the Management API (curl, not urllib).
2. Deploy the edge function.
3. Deploy the site.

Because gallon seeds inactive, the storefront is visually identical on day one and changes only when Jordan flips the switch.

## Out of scope

- Per-size photos. Both sizes share the species photo.
- Selling a specific plant out of season. Decision 2 makes the seasonal switch absolute, by choice.
- Any change to kits, merch, or the quote flow.

# iNaturalist species enrichment (spec A)

Date: 2026-08-08
Status: approved design, not yet planned
Repo: ecotopia-portal

## Purpose

Resolve every plant catalogue species to an iNaturalist taxon, then hang three things off
that link: a photo for the 41 species that have none, a Pennsylvania establishment flag
(introduced / native / unknown), and PA conservation status.

The taxon link is the foundation the later specs need. Nothing else in the iNaturalist
programme can be built until a species row can be joined to a taxon id.

## Scope

This spec covers the taxon link and species-level enrichment only.

Deliberately out of scope, each getting its own spec later:

- **Spec B, garden biodiversity.** `lat` / `lng` plus a nullable `inat_place_id` on
  `gardens`, and "recently seen near this garden" feeds on the public garden pages.
  Blocked on geocoding the ten gardens. Reuses this spec's sync function and taxon link.
- **Spec C, community observation project.** An iNaturalist collection project fed by
  volunteers through the QR kiosk. Blocked on two things: nobody has decided who owns the
  iNaturalist account, and iNaturalist requires a confirmed email plus 50 verifiable
  observations before an account may create places at all.

## Measured baseline

Every figure below was measured against the live catalogue and the live iNaturalist API on
2026-08-08, not estimated.

| Measure | Value |
| --- | --- |
| Species in catalogue | 50, all active, all with a botanical name |
| Species with a photo today | 9 |
| Species with no photo | 41 |
| Botanical names resolving to an exact iNaturalist taxon | 48 of 50 |
| Photo-less species with at least one license-clean photo | 33 |
| Photo-less species with no license-clean photo | 8 |
| Catalogue species flagged introduced in PA | 2 |

The two names that do not resolve exactly:

- `Monarda bradburiana` matches iNaturalist's `Monarda bradburyana`. A spelling variant,
  resolvable by the fuzzy fallback below.
- `Pycnanthemum virginicum & muticum` is two species in a single catalogue row. It cannot
  resolve to one taxon and never will. It needs splitting into two rows or a permanent
  manual override. This spec treats it as unresolvable and surfaces it for staff.

## Architecture

A nightly edge function writing to cached Supabase columns, structurally identical to the
existing `grant-scan` function. Public pages read Supabase only and never contact
iNaturalist.

This follows the rule already set for this repo after the Star Bev and B&A catalogue-sync
work: Supabase is the source of truth, and a third party is a feed into it, never a runtime
dependency of a page load.

Rejected alternatives, recorded so they are not revisited:

- **Browser calls iNaturalist directly.** Every visitor hits a third party, a User-Agent
  cannot be set from the browser, public page speed becomes hostage to iNaturalist's
  uptime, and attribution is never captured so licence compliance cannot be proven.
- **Staff-triggered only, no schedule.** The data rots because nobody clicks the button.

### Licensing

Creative Commons grants are irrevocable. A photo copied while it carried CC-BY stays
usable even if the photographer later relicenses or deletes it, but only if the licence
and attribution were recorded at the moment of copying. This is the reason photos are
copied into Storage rather than hotlinked, and the reason the schema stores the licence
string, the attribution string, the iNaturalist photo id and the source URL alongside
every image.

Only `cc0`, `cc-by`, `cc-by-sa` and `pd` are eligible. `cc-by-nc` is excluded because
Ecotopia sells plants, which is commercial use. The API filters this server-side via
`photo_license`, verified working.

CC-BY and CC-BY-SA both require visible attribution, so an iNaturalist-sourced photo
renders a credit line on the public plant card. This is not optional and is not a
preference.

## Schema

Migration `0033_inat_species.sql`, additive only. Per the standing rule in this repo, the
deployed page and the deployed schema must be compatible at every commit, so nothing is
dropped and no existing column changes meaning.

Columns added to `plant_species`:

| Column | Type | Meaning |
| --- | --- | --- |
| `inat_taxon_id` | integer | Resolved taxon, null when unresolved |
| `inat_match` | text | `exact`, `fuzzy`, `manual`, `none` |
| `inat_matched_name` | text | The iNaturalist name actually matched, so a fuzzy match is auditable |
| `inat_establishment` | text | `introduced`, `native`, or null for uncurated |
| `inat_conservation` | text | PA status string, null when none |
| `inat_photo_id` | bigint | Source photo, null when the photo is not from iNaturalist |
| `inat_photo_license` | text | Licence at copy time |
| `inat_photo_attribution` | text | Attribution string at copy time |
| `inat_photo_source_url` | text | The iNaturalist photo page |
| `inat_photo_status` | text | `auto`, `approved`, `rejected`, null when no iNat photo |
| `inat_synced_at` | timestamptz | Last successful enrichment |

`photo_path` keeps its current meaning exactly. iNaturalist images are written to the
gallery bucket as `plants/<uuid>.jpg`, which is the convention the existing renderer in
`assets/data.js` already handles, so no rendering code changes to display them.

**Load-bearing:** `inat_photo_id` is what distinguishes an iNaturalist photo from Jordan's
own. A row with `photo_path` set and `inat_photo_id` null is a Jordan photo and the sync
must never touch it. This is the guard that stops a nightly job overwriting real nursery
photography.

RLS follows the sibling content tables. The new columns are covered by the existing
`sp_anon_read` (gated on `active`) and `sp_staff_all` policies. No new policy is needed,
and no anonymous write path is introduced.

## Taxon resolution

Run only for rows where `inat_taxon_id` is null and `inat_match` is not `manual`. A manual
match is permanent and the job never revisits it.

1. Query `/v1/taxa?q=<botanical>&per_page=3`.
2. If a result's `name` equals the botanical name case-insensitively, record `exact`.
3. Otherwise, if exactly one result has the same genus and a Levenshtein distance of 2 or
   less on the species epithet, record `fuzzy` and store `inat_matched_name`. This is what
   catches `bradburiana` against `bradburyana`, a distance of 1. Two or more candidates
   passing this test is treated as no match, never a guess.
4. Otherwise record `none` and leave `inat_taxon_id` null.

A `fuzzy` or `none` row appears in a portal review list. Staff can set a taxon id by hand,
which records `manual`.

Typographic apostrophes are normalised to ASCII before querying. The catalogue contains
them.

## Photo fill

Frank chose automatic fill with staff override, having been shown the risk that a
community photo may be a seed pod or a leaf close-up rather than a sellable flower shot.
Two mitigations follow from that choice.

First, the job prefers the taxon's `default_photo`, which is the community-chosen
representative image, and only falls back to the first license-clean entry in
`taxon_photos` when the default is not license-clean.

Second, `manage-plants.html` gains a review grid showing every `auto` photo at once with
its species name, so Jordan can scan all 33 in one screen and reject rather than opening
33 species one at a time. Rejecting sets `inat_photo_status = 'rejected'`, clears
`photo_path`, and the job never proposes that same photo id again.

The job fills a photo only when `photo_path` is null. It never replaces an existing image,
whether Jordan's or a previously approved iNaturalist one.

## Establishment and conservation

`establishment_means` is read with `place_id=42` (Pennsylvania) and stored verbatim as
`introduced`, `native`, or null.

**Null means uncurated, not native.** Measured on the live API: *Monarda didyma* returns
`native` for PA, while *Asclepias syriaca*, *Quercus alba* and *Rudbeckia hirta* return
nothing at all despite being unambiguously native. Any copy or badge that renders null as
"native" would be asserting something the data does not say. The portal shows three
states and the public site shows none of them in this spec.

Conservation status is taken from the PA entry in `conservation_statuses` where present.

The portal surfaces `introduced` species prominently, because a Pennsylvania native plant
business selling a PA-introduced species is a credibility problem worth catching. Two
already exist in the catalogue: *Coreopsis lanceolata* and *Echinacea purpurea*. This
badge is staff-facing only. It is a prompt for Jordan to check a source he trusts, not a
public claim, because iNaturalist establishment data is community-curated rather than
authoritative.

## Edge function

`supabase/functions/inat-sync/index.ts`, deployed `--no-verify-jwt` and pinned in
`config.toml`, mirroring `grant-scan`.

- Token-gated on a shared secret in an `X-Scan-Token` header, matching `grant-scan`'s
  pattern, with the secret in `INAT_SYNC_TOKEN`.
- Nightly `pg_cron` job `inat-sync-nightly` at 10:00 UTC, deliberately an hour after the
  existing `grant-scan-nightly` at 09:00 UTC so the two never contend.
- Sends a descriptive `User-Agent` with a contact address, which iNaturalist asks for.
- Paces requests to stay under 60 per minute, and stops early on a 429.
- Resolution and enrichment are idempotent. Re-running changes nothing for a row that is
  already resolved, approved, and fresh.
- A per-row failure is logged and skipped. One bad species never aborts the run.

A "Sync now" button in the portal calls the same function, exactly as `grant-finder.html`
offers "Scan now".

## Portal UI

`manage-plants.html` gains:

- A **photo review grid** of every `auto` photo with approve and reject controls.
- A **needs attention** list holding `fuzzy` matches, `none` matches, and the two-species
  Mountain Mint row, each with a manual taxon id field.
- Per-species display of the establishment flag, conservation status, matched taxon name,
  and a link to the iNaturalist taxon page.
- A **Sync now** button.

The dashboard gains a count of photos awaiting review, following the existing
needs-attention pattern.

## Public UI

`plants.html` renders a credit line beneath any card whose `inat_photo_id` is set, reading
the stored attribution string. Styled quietly, consistent with the existing "Administration"
line precedent of putting required-but-secondary text in a low-emphasis position.

No establishment or conservation badge appears publicly in this spec.

Every value reaching `innerHTML` goes through `esc()`, per the repo convention. Attribution
strings are third-party text containing names and punctuation and must be treated as
untrusted.

## Testing

Under `node --test`, matching the existing `tests/pricing.test.js` approach:

- The licence allowlist is asserted to exclude `cc-by-nc` and every non-commercial variant.
- Resolution is tested against recorded fixtures for the exact, fuzzy, and no-match cases,
  including the real `bradburiana` and Mountain Mint rows.
- The Jordan-photo guard is tested directly: a row with `photo_path` set and
  `inat_photo_id` null must be left untouched by a sync pass. This is the highest-value
  test in the suite because the failure is destructive and silent.
- A rejected photo id is asserted never to be proposed again.
- Null `establishment_means` is asserted to render as unknown and never as native.

Fixtures are recorded from the live API rather than hand-written, so they reflect real
response shapes.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| iNaturalist unreachable | Sync is a no-op, pages serve cached data, nothing degrades |
| Rate limited | Stop early, resume next night, partial progress kept |
| Photo deleted upstream | Our Storage copy and its recorded licence are unaffected |
| Taxon merged or renamed upstream | `inat_matched_name` drifts from `botanical`, surfaced in needs-attention |
| Bad auto photo reaches the public site | Reject in the review grid, clears immediately |

## Open questions

1. **Mountain Mint.** Split `Pycnanthemum virginicum & muticum` into two catalogue rows, or
   keep one row with a manual taxon override? Splitting is correct data modelling but
   changes what the shop displays and needs Jordan's agreement.
2. **The two introduced species.** Once Jordan confirms, does the catalogue keep them with
   different copy, or drop them? Out of scope here, but this spec is what surfaces the
   question.
3. **Contact address in the User-Agent.** iNaturalist asks for one. Confirm whether to use
   a BagCarriers address or an Ecotopia address.

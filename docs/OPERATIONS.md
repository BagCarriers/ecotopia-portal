# Ecotopia Portal - Operations

Operational notes for the Ecotopia Earthcare admin portal. Keep this file current;
it is committed so it survives across machines and sessions.

## Supabase project

- Project ref: `wibnryfinfwbwwgsyojr`
- URL: `https://wibnryfinfwbwwgsyojr.supabase.co`
- The anon key in `assets/config.js` is public-safe by design; all protection comes
  from Row Level Security (RLS). Never commit any other key.

## Migrations

Migrations `0001`-`0006` were applied to the live database directly via the Supabase
Management API (`POST https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query`),
NOT via `supabase db push`. Because of that, the `supabase_migrations.schema_migrations`
table is empty and the CLI does not know these migrations ran.

Before ever running `supabase db push` against this project, first register the
already-applied migrations so the CLI does not try to re-run them:

```
supabase migration repair --status applied 0001
supabase migration repair --status applied 0002
supabase migration repair --status applied 0003
supabase migration repair --status applied 0004
supabase migration repair --status applied 0005
supabase migration repair --status applied 0006
```

To apply a new migration by hand via the Management API, get the token with
`security find-generic-password -s "Supabase CLI" -w` and POST `{"query": "<sql>"}`
with an `Authorization: Bearer <token>` header. Never write that token to disk.

## Edge functions

- `accept-invite` is deployed with `--no-verify-jwt` (it is called by an anonymous
  visitor setting their password from an invite link). `supabase/config.toml` now
  pins `[functions.accept-invite] verify_jwt = false`, so a future redeploy keeps
  JWT verification off instead of silently re-enabling it and breaking the invite flow.

## Calendar sync

Two-way Google Calendar sync for `calendar.html`, backed by the `portal_settings`
key-value table (migration `0007`) and the `calendar-feed` edge function.

Settings (rows in `public.portal_settings`, RLS: any portal user reads, admins write):

- `calendar_feed_token` - an opaque JSON string. The outbound ICS feed is authed by
  this token alone (Google's fetcher sends no headers). Generated the first time an
  admin opens the Calendar sync panel. Treat it like a secret; rotating it means
  deleting the row and re-opening the panel, then re-subscribing in Google.
- `google_calendar_ics_url` - the Google "secret address in iCal format" URL an admin
  pastes to overlay their Google events into the portal calendar (read-only, visible
  to all portal users).

`calendar-feed` has two modes:

- `GET ?token=<calendar_feed_token>` - outbound. Returns a `text/calendar` ICS of all
  `events` (one all-day VEVENT each). Token mismatch or missing token returns a generic
  403. This is the URL staff paste into Google Calendar (Other calendars > + > From URL):
  `https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/calendar-feed?token=<token>`
- `POST {"action":"google_events"}` - inbound. Requires a valid user JWT
  (`Authorization: Bearer`) AND an active `portal_users` row; otherwise 401/403. Reads
  `google_calendar_ics_url`, fetches it server-side, parses VEVENT DTSTART/SUMMARY, and
  returns `{configured, events:[{date, title, allDay}]}`. Google fetch failure returns 502.
  The parser reads a single DTSTART per VEVENT (no RRULE expansion); results are limited
  to a two-year lookback / one-year lookahead window and capped at 500 events.

Deploy (JWT verification is done manually in the function for the POST path; the GET
path is token-authed for Google's headerless fetcher, so the platform check stays off):

```
supabase functions deploy calendar-feed --no-verify-jwt --project-ref wibnryfinfwbwwgsyojr
```

`supabase/config.toml` pins `[functions.calendar-feed] verify_jwt = false` so a future
redeploy keeps JWT verification off instead of silently breaking the token-authed feed.

`calendar.html` also has a "+ New Event" button (header, and a "+ Add event on this day"
affordance in the day panel) that opens the same event form as `events.html` as a modal
(title, date, garden, type, description, optional photo to `gallery` under `events/`). The
date prefills from the selected day when the day panel is open, else today; on save it
re-fetches events and re-renders. Photo upload uses upload-before-insert with orphan cleanup
on failure, identical to `events.html`.

## Gallery (photo library)

Migration `0009_gallery.sql` adds a staff photo library plus volunteer photo
submissions. It was applied live via the Management API (like the others), so
register it with `supabase migration repair --status applied 0009` before any
`supabase db push`.

Storage bucket `gallery`:

- `public = true` (photos are served via public URLs on `gallery.html`),
  `file_size_limit = 10 MB`, `allowed_mime_types = jpeg/png/webp/gif`.
- Path convention: staff uploads go under `staff/<uuid>.<ext>`, volunteer
  submissions under `volunteer/<uuid>.jpg`.
- Object policies: `gallery_staff_all` gives authenticated portal users full CRUD
  on the bucket; `gallery_anon_upload` lets anon INSERT only when the first path
  segment is `volunteer/` (no anon read/update/delete). Public read comes from the
  bucket being public, not from a policy.

Metadata table `public.gallery_photos` (one row per photo; `storage_path`,
`caption`, `uploaded_by`, `source` in (`staff`,`volunteer`), optional
`garden_id`/`garden_name`):

- `gp_staff_all`: authenticated portal users get full CRUD.
- `gp_anon_ins`: anon may INSERT only rows with `source = 'volunteer'`, and cannot
  select/update/delete (the kiosk fire-and-forgets via `return=minimal`).

Delete removes the storage object first, then the row (`DataStore.deleteGalleryPhoto`);
a missing object is ignored so the row is still removed. `DataStore.resizeImage`
downscales images client-side (canvas, long edge <= 1600px, JPEG q0.85) before
upload; GIFs and already-small images pass through untouched.

Event photos (migration `0015_event_photos.sql`) live in this same `gallery`
bucket under the `events/<uuid>.jpg` prefix, referenced by column
`public.events.photo_path`; the existing `gallery_staff_all` policy (no path
restriction) covers staff writes and public bucket read serves the marketing pages.
Replacing or removing an event photo deletes the old storage object best-effort
(errors ignored), the same pattern as gallery deletes.

## Service lead-gen (per-service toggles + waitlist)

Migration `0011_service_leads.sql` adds two tables (applied live via the Management
API, so register it with `supabase migration repair --status applied 0011` before any
`supabase db push`):

- `public.service_settings` - one row per marketing service, keyed by `slug` (the same
  ten slugs the marketing forms use). Columns: `name`, `active`, `off_message`,
  `reopen_date`. RLS: anon may SELECT (the public cards read it); authenticated portal
  users may SELECT and write. Seeded with all ten services active.
- `public.service_waitlist` - anon-insertable waitlist rows (`service_slug`, `name`,
  `email`, `phone`, `note`). RLS: anon may INSERT only (no read); portal users get full
  CRUD. The public modal fire-and-forgets via `return=minimal`.

How it works:

- Public cards on `index.html` (6-card preview) and `services.html` (all ten, incl. the
  DCNR callout) carry `data-service-slug`. `EcoSite.initServiceLeads()` (in `site.js`)
  wires each card as a keyboard-operable button and reads `service_settings` once.
  - Active service -> a brand-styled inquiry modal (service-specific questions from the
    `SERVICE_FORMS` allowlist in `site.js` + a contact block). On submit it does two anon
    inserts: an `intake_submissions` row and a `jobs` row with `status = 'inquiry'`
    (title `"<Service> Inquiry"`, activity log "Received via services page.").
  - Off service -> an out-of-season message (`off_message` or a default, plus the reopen
    date if set) and a waitlist mini-form that inserts a `service_waitlist` row.
  - If the settings fetch fails, cards fall back to linking `intake.html` (fail-soft).

Who can toggle: any active portal user (admin or user), via `manage-services.html`
(the "Services" nav link). There they turn a service off (setting an off message +
optional reopen date), turn it back on (which clears the off message/date), view each
service's waitlist inline, convert a waitlist entry to a `jobs` inquiry
(title `"<Service> Inquiry (from waitlist)"`, activity log "Converted from waitlist."),
or delete an entry.

Where leads land: both modal-submitted inquiries and waitlist conversions appear in
`jobs.html` as `inquiry` jobs. Modal submissions also write an `intake_submissions` row.

Service details (the details card shown before the inquiry form) live in the
`SERVICE_DETAILS` const in `assets/site.js`, keyed by the same slugs. Editing that
copy is a code edit (not a database change). Migration `0012_tree_nets.sql` added the
`tree_nets` service (hand-woven tree nets, made to order), applied live via the
Management API; register it with `supabase migration repair --status applied 0012`
before any `supabase db push`. Its wording is flagged for client review
(`review: true` in `SERVICE_DETAILS`).

## Quotes and administration fee

Migration `0013_quotes.sql` adds `public.quotes` (applied live via the Management API,
so register it with `supabase migration repair --status applied 0013` before any
`supabase db push`). RLS is staff-only: a single `q_staff_all` policy for authenticated
portal users; there is no anon policy, so the public site cannot read quotes.

Staff build quotes on `quotes.html` (the "Quotes" nav link) and print a branded
Open Sesame Designs LLC document via `quote-print.html?id=<uuid>`.

The 5 percent administration fee is the core rule:

- Every quote stores `subtotal` (sum of the line-item amounts),
  `admin_fee = round(subtotal * 0.05, 2)`, and `total = subtotal + admin_fee`.
- The fee percent lives in ONE place: the `ADMIN_FEE_RATE = 0.05` const in
  `quotes.html`. Change it there and nowhere else.
- Client-facing, the fee is a QUIET line ("Processing and administration") just above
  the total on both the builder summary and the printed quote. It is deliberately NOT a
  line item in the table.
- Deposit is display/deduction only: it does not change the subtotal math. When a
  deposit is present the printed quote shows `DEPOSIT RECEIVED` and a final
  `BALANCE DUE = total - deposit`.

Quote numbering: `quote_number` is per `quote_year` (shown as "N of YYYY", e.g. "3 of
2026"). A new quote takes `nextQuoteNumber(year of quote_date)` = max existing number
for that year + 1 (or 1 when the year is empty). Editing a quote recomputes
subtotal/admin_fee/total but NEVER changes its number or year. Status flows
`draft -> sent -> accepted -> invoiced`.

YTD tally: the "Admin fees YTD" chip on `quotes.html` is
`adminFeesTotal(currentYear)` = the sum of `admin_fee` for the current year across
quotes in status `sent`, `accepted`, or `invoiced` (drafts are excluded, so unsent
work-in-progress does not inflate the figure).

Convert to invoice: creates a draft `invoices` row (`amount = total`,
`jobTitle = "Quote N of YYYY"`, notes recording the included 5 percent fee) and flips
the quote to `invoiced`. Already-invoiced quotes cannot be converted again (the action
is hidden).

Reconciliation: the administration fee is collected by BagCarriers (the agency).
Monthly, BagCarriers invoices the client (Open Sesame Designs LLC / Ecotopian
EarthCare) for the accumulated fees; the YTD figure on `quotes.html` is the running
tally. The legal entity printed on quotes is Open Sesame Designs LLC.

## Public quote acceptance and deposits

Migration `0022_quote_acceptance.sql` lets a client open a sent quote from a private
link, accept it online, and see deposit instructions. Applied live via the Management
API, so register it with `supabase migration repair --status applied 0022` before any
`supabase db push`.

New `public.quotes` columns: `share_token` (unique, nullable), `accepted_at`,
`accepted_by`, and `deposit_status` (`unpaid` default / `pending` / `paid`, CHECK).

**No anon table policy.** The public page never selects `quotes` directly. Two
token-gated `security definer` RPCs (granted to `anon` + `authenticated`) are the only
public entry points:

- `get_quote_by_token(p_token)` -> returns the quote body plus `accepted_at`,
  `accepted_by`, and `deposit_status`, but ONLY for quotes in status
  `sent`/`accepted`/`invoiced` (drafts never resolve) whose token is >= 32 chars.
  Returns no row for a missing/short/unknown token.
- `accept_quote(p_token, p_name)` -> flips a still-`sent` quote to `accepted`, stamping
  `accepted_at = now()` and `accepted_by = left(p_name, 200)`. Idempotent: it only acts
  when `status = 'sent' and accepted_at is null`, and returns `true` only when THIS call
  performed the acceptance (a second call returns `false`).

Note: the `get_quote_by_token` signature returns two more columns than the original
spec (`accepted_by`, `deposit_status`) so the public page can render the "Accepted by
<name>" banner and the deposit panel. Both are safe to expose (a client's own typed
name; a coarse paid/unpaid flag).

Share token: generated on `quotes.html` as two dash-stripped `crypto.randomUUID()`
values concatenated (64 hex chars). It is minted automatically the first time a quote
is moved to `sent`, or on demand via the per-row "Share link" action (any non-draft
quote). The public link is `https://ecotopia.bagcarriers.dev/quote-view.html?t=<token>`
(shown in a copy-to-clipboard modal). `PUBLIC_BASE` lives at the top of `quotes.html`.

Staff row surface (`quotes.html`): each row shows the acceptance state
("Accepted by <name> on <date>") once accepted, a `Deposit: unpaid/pending/paid` pill
(when the quote has a deposit), and a manual "Mark deposit paid" action
(`deposit_status = 'paid'`). Jordan reconciles deposits by hand until a processor is
wired; there is no automated payment capture yet.

Public page (`quote-view.html`): a standalone, marketing-branded document (NO `auth.js`,
`noindex`). It reads `?t=`, calls `get_quote_by_token`, and renders the branded quote
(gold header, line-item table, quiet "Processing and administration" line above TOTAL,
deposit + balance). Action panel by state:

- `sent`: an "Accept this quote" button reveals a "Type your name to accept" input and a
  confirm button that calls `accept_quote`, then re-fetches and shows the accepted state.
- `accepted`/`invoiced`: a green "Accepted by <name> on <date>" banner, then a Deposit
  panel (when `deposit > 0` and `deposit_status != 'paid'`) showing "Deposit due: $X" and
  payment instructions; a paid deposit shows a "Deposit received" confirmation instead.
- invalid/expired/unknown token: a friendly "This quote link is not available" screen with
  the `814-631-5338` phone number.

Every dynamic value (client name, line items, `accepted_by`) is `esc()`'d even though
these are staff/DB strings, because the page renders them publicly.

**Payment processor upgrade path (processor-agnostic).** Deposit instructions come from
the `PAYMENT_CONFIG` const at the top of `quote-view.html`:

```
const PAYMENT_CONFIG = {
  mode: 'manual',            // 'manual' | 'link'
  payLinkTemplate: '',       // used only when mode === 'link'; {token} -> share token
  instructions: 'Please mail a check payable to Open Sesame Designs LLC, ...',
};
```

Today `mode: 'manual'` renders the mailing/site-visit instructions. When a processor is
chosen, set `mode: 'link'` and `payLinkTemplate` to a checkout URL containing the literal
`{token}` (replaced with the quote's share token at render time, e.g.
`https://buy.stripe.com/...?client_reference_id={token}`); the deposit panel then renders
a "Pay deposit online" button instead of the instructions. No other code change is needed.
`deposit_status` (`pending`, `paid`) is already in the schema for a webhook/reconciliation
step to flip.

## Volunteer hours certificate

`volunteer-detail.html` has a "Print hours certificate" button with a range picker (last 30 / 90 / 365 days / all time) that opens the branded, printable `volunteer-hours-print.html?id=<volunteerId>&days=<N>` (days=0 means all recorded service); it lists the volunteer's check-ins (date, garden, task, hours) and a prominent total, plus an "Email it" mailto (save the PDF from the print dialog first, then attach it).
The verifying signature is drawn per-print on an in-page canvas (mouse or touch) and prints as part of the document; it is never uploaded or stored anywhere.

## Grant finder

Migration `0014_grant_finder.sql` adds `public.grant_opportunities` (applied live via
the Management API, so register it with `supabase migration repair --status applied 0014`
before any `supabase db push`). RLS is staff-only: a single `go_staff_all` policy for
authenticated portal users; there is no anon policy, so the public site cannot read
discovered opportunities. Staff triage them on `grant-finder.html` (the "Grant Finder"
nav link, right after Grants).

The `grant-scan` edge function auto-discovers grants relevant to Ecotopia's work
(ecological landscaping, native plants, riparian buffers, pollinator habitat, community
gardens, urban forestry, watershed restoration in Central PA):

- POST `{"action":"scan"}`. Auth is EITHER a valid staff JWT (`Authorization: Bearer`,
  validated the same way as `calendar-feed` - `auth.getUser` + an active `portal_users`
  row) OR the shared secret header `X-Scan-Token` matching the `GRANT_SCAN_TOKEN`
  function secret (used by the nightly cron). Otherwise 401.
- Sources (per-source isolated: one failing never kills the others; per-source errors
  come back in the response `errors` map):
  - **Grants.gov** (`https://api.grants.gov/v1/api/search2`, no API key): runs seven
    keyword queries (the `GRANTS_GOV_QUERIES` const in the function), collects unique
    opportunities by number, and applies a lightweight relevance heuristic (the
    `ALLOW_WORDS` / `BLOCK_WORDS` consts) to drop obviously-irrelevant hits (tribal-only,
    overseas/embassy, NASA/space, defense). `source = 'grants.gov'`,
    `source_ref = <opp number>`, `url = https://www.grants.gov/search-results-detail/<id>`,
    `close_date` parsed from MM/DD/YYYY (null-safe), `keywords` = the matching queries.
  - **DCNR** (`https://www.pa.gov/agencies/dcnr/programs-and-services/grants.html`,
    server-rendered): a lightweight change-surface, not a parser. Surfaces up to 10
    distinct program links whose href is under `/dcnr/` and mentions "grant" (e.g. the
    Community Conservation Partnerships Program / C2P2), one row each, `close_date` null,
    with a "Check the page for current round dates" summary.
  - **DEP** (`.../dep/.../grants-loans-and-rebates.html`): attempted the same way, but as
    of 2026-07 that URL 301-redirects to a 404, so the source is skipped cleanly and the
    skip reason is reported in `errors.dep`. Revisit if DEP restores a server-rendered
    grants page.
- Upsert semantics: on conflict `(source, source_ref)` it refreshes
  `title`/`url`/`close_date`/`summary` and bumps `last_seen`, but **never overwrites
  `status`** - staff triage (`new` -> `reviewing` -> `applying`, or `dismissed`) survives
  every rescan. "Track in Grants" on the finder page creates a `grants` row
  (`status = 'prospect'`, notes carry the source URL) and flips the opportunity to
  `applying`.

Deploy (JWT verification is done manually in the function so the cron token path works;
the platform check stays off, pinned in `supabase/config.toml`):

```
supabase functions deploy grant-scan --no-verify-jwt --project-ref wibnryfinfwbwwgsyojr
```

`GRANT_SCAN_TOKEN` (function secret) - the shared cron token. Set it with:

```
supabase secrets set --project-ref wibnryfinfwbwwgsyojr GRANT_SCAN_TOKEN=<random hex>
```

The nightly cron embeds this same value. To rotate: generate a new hex, `secrets set` it,
and reschedule the cron job (below) with the new value - the two must stay in sync.

Nightly schedule (`pg_cron` + `pg_net`, inside the Ecotopia Supabase project, applied via
the Management API - `create extension if not exists pg_cron; create extension if not
exists pg_net;` then `cron.schedule(...)`): job name `grant-scan-nightly`, `0 9 * * *`
(09:00 UTC, overnight ET), which `net.http_post`s to the function with the `X-Scan-Token`
header. The token lives in the cron job's SQL (stored in the same DB the service role
protects; acceptable). Inspect/verify with `select * from cron.job where jobname =
'grant-scan-nightly';`.

## Garden profiles

Migration `0016_garden_profiles.sql` adds `public.gardens.description` (public text,
shown esc'd on `community-gardens.html` full cards and as the first sentence on the
homepage strip) and `public.gardens.map_mid` (a Google My Maps id only). Applied live
via the Management API, so register it with `supabase migration repair --status applied
0016` before any `supabase db push`.

`map_mid` renders into an iframe `src` (`https://www.google.com/maps/d/embed?mid=<mid>`)
on `community-gardens.html`, so the public renderer refuses any value failing
`/^[A-Za-z0-9_-]+$/` (`EcoSite.validMapMid`); the portal parses staff input (bare mid or
any URL with `mid=`) and enforces the same charset via `DataStore.parseMapMid`. Staff set
both fields on the `gardens.html` Add Garden form and the `garden-detail.html` Edit details
modal. Seeded gardens: Pawpaw Pathways and Zebra Swallowtail Trails (has a map) and
Reciprocity Community Food Forest.

Migration `0017_garden_links.sql` adds two more `public.gardens` columns (applied live
via the Management API, so register it with `supabase migration repair --status applied
0017` before any `supabase db push`):

- `form_url` - a public "get involved" link (e.g. a Google interest form) rendered as an
  `href` on the community-gardens card. Because it is a live link, the public renderer
  refuses any value that does not start with `https://` (a simple scheme check), and the
  portal forms enforce the same rule inline. When present it shows a "Suggest a planting
  site" button (`btn-amber`, `target=_blank rel=noopener`). NOTE for a Google Form: if the
  form is set to "restricted to signed-in users" visitors will hit a sign-in wall, so turn
  "Requires sign in / limit to 1 response" off in the form's settings for a public form.
- `photo_path` - a card photo. Two forms are supported by the renderer:
  - `static:<file>` -> a repo static asset served from `assets/img/gardens/<file>`. The
    filename is guarded against `/^[A-Za-z0-9._-]+$/` so it cannot escape the folder. This
    is how the Pawpaw Pathways grove sign (`static:pawpaw-sign.jpg`, a designed portrait
    poster) is served; it renders `object-fit: contain` so the sign is never cropped.
  - any other value -> a gallery-bucket path served via public URL (the events photo
    pattern, `EcoSite.gardenPhotoUrl`). No portal upload path for garden photos exists yet;
    that is future work. Today garden photos are set by hand (static asset + a SQL update).

Overview map: `community-gardens.html` shows a hardcoded "Every garden on one map" section
ABOVE the per-garden cards, embedding the "Eco-Community Gardens (WildOnes PA Ridge &
Valley)" Google My Maps (`mid=1svkTJPU3IDO2qzA2r2Lezr03P4Ol5Wg`). It is page content, not
data, so it lives directly in the HTML with a comment. Below it, the cards lead with Pawpaw
Pathways as a featured full-width card (sign photo + map + form), then the remaining gardens
are grouped client-side by town derived from the address (Altoona, Duncansville, Bellwood,
Hollidaysburg, then "Other gardens").

## Planting suggestions (Pawpaw Pathways)

Migration `0018_planting_suggestions.sql` adds `public.planting_suggestions`, a
portal-native replacement for the old Pawpaw Pathways "Suggest a planting site" Google
Form. Applied live via the Management API, so register it with `supabase migration repair
--status applied 0018` before any `supabase db push`.

The mission: a pawpaw grove every half mile along Blair County waterways so Zebra
Swallowtail butterflies have a corridor. The public suggests spots; Jordan scouts and
plants, then adds map icons.

Table `public.planting_suggestions` columns:

| column          | notes                                                            |
| --------------- | ---------------------------------------------------------------- |
| `garden_id`     | FK to `gardens` (`on delete set null`); the Pawpaw garden row    |
| `name`          | required                                                         |
| `phone`         | one of phone/email required (enforced by the public form)        |
| `email`         | one of phone/email required (enforced by the public form)        |
| `location_text` | required; address, landmark, or a description of the spot        |
| `land_relation` | I own it / I know the owner / Public land / Not sure             |
| `notes`         | optional                                                        |
| `status`        | `new` (default) / `contacted` / `planted` / `dismissed` (CHECK)  |
| `created_at`    | default `now()`                                                 |
| `updated_at`    | maintained by the shared `set_updated_at` trigger                |

RLS: `anon` may INSERT only (`psg_anon_ins`), matching the return=minimal insert pattern
so no anon read policy is needed; everything else (read, status updates, delete) is
staff-only (`psg_staff_all`, `authenticated` + `is_portal_user()`).

Where things live:

- Public form: `suggest-a-site.html` (marketing-branded, `EcoSite.renderNav(null)`, loads
  `data.js` with no auth). It resolves the Pawpaw garden id at runtime by name via
  `EcoSite.getGardens()` (no hardcoded uuid) and submits through
  `DataStore.submitPlantingSuggestion` (anon fire-and-forget, no `.id` reads). It links to
  the Pawpaw map viewer (`mid=1MWDTLstCAOrHauRWVuwRsVcpFmUaTOQ`) and shows the grove sign.
- Card entry point: the Pawpaw garden row's `form_url` now points at
  `https://ecotopia.bagcarriers.dev/suggest-a-site.html`, so the existing
  community-gardens card "Suggest a planting site" button opens the portal-native form.
- Staff review: `garden-detail.html` shows a "Planting Suggestions" section (hidden when a
  garden has zero) listing each suggestion (name, contact, location, land relation, notes,
  date, status pill) with Contacted / Planted / Dismiss status actions and Delete (confirm).
  These strings are anon-submitted, so every dynamic value is `esc()`'d (stored-XSS class).
- `dashboard.html` "Needs attention" surfaces an "N new planting suggestion(s)" item
  (`status = 'new'` count across gardens) linking to `gardens.html`.

Data helpers (`assets/data.js`): `submitPlantingSuggestion` (anon), plus staff
`getPlantingSuggestions`, `getPlantingSuggestionsByGarden(gardenId)` (both `created_at`
desc), `updatePlantingSuggestion(id, ch)`, `deletePlantingSuggestion(id)`.

Retired predecessor: the Pawpaw "Suggest a planting site" Google Form
(`https://docs.google.com/forms/d/e/1FAIpQLSeHJ4xdIjv0Ct_rmucEkuTzOesA62sUCz3p-xdMjirlsO8ffQ/viewform`)
is no longer linked anywhere and can be closed in Google Forms. Its responses (if any) were
not migrated.

## Plant catalog (native plants shop)

Migration `0019_plant_catalog.sql` moves the native-plant shop from hardcoded
`PLANTS` / `KITS` consts in `plants.html` into two editable tables (applied live via
the Management API, so register it with `supabase migration repair --status applied
0019` before any `supabase db push`):

- `public.plant_species` - one row per wildflower species. Columns: `common` (required),
  `botanical`, `bloom`, `height`, `attracts`, `fact`, `tags` (jsonb array), `photo_path`,
  `sort` (integer, ascending), `active` (boolean). RLS: `sp_anon_read` lets anon SELECT
  only `active` rows; `sp_staff_all` gives authenticated portal users full CRUD (and their
  reads return inactive rows too).
- `public.plant_kits` - one row per habitat kit. Columns: `slug` (unique; the old const
  id, e.g. `hummingbird`), `name` (required), `blurb`, `plants` (jsonb array of
  `{name, note?}`), `photo_path`, `sort`, `active`. Same two-policy RLS
  (`pk_anon_read` active-only for anon, `pk_staff_all` for staff).

Both tables carry the shared `set_updated_at` trigger.

Seed provenance: the 50 species and 11 kits were migrated verbatim from the `plants.html`
consts on 2026-07-28 (species `sort = index * 10` in the old array order; kits kept their
const id as `slug` and their `plants` jsonb verbatim). The one-off seed script was run out
of the scratchpad and is not committed.

Photo convention (identical to garden photos, but rooted at `assets/img/plants/`):

- `static:<file>` -> a repo static asset served from `assets/img/plants/<file>`. The
  filename is charset-guarded (`/^[A-Za-z0-9._-]+$/`) so it cannot escape the folder. All
  seeded photos use this form (e.g. `static:wild-columbine.jpg`).
- any other value -> a gallery-bucket object served via its public URL. Staff photo
  uploads on `manage-plants.html` go through `DataStore.resizeImage` (long edge <= 1600px,
  JPEG q0.85) and land in the `gallery` bucket under `plants/<uuid>.jpg` (the existing
  `gallery_staff_all` object policy covers these writes; public bucket read serves them).

Public page (`plants.html`): reads active rows over anon (ordered `sort` then name),
rendering the same filter chips, `$5` request tray, and 4-tier kit modals as before. The
kit pricing table (`KIT_TIERS`) and `PLANT_PRICE` stay hardcoded (universal), and the card
game section is unchanged. The request tray now references species by row id (not array
index) so a reorder in the portal cannot corrupt a pending request. Each section fails
soft independently: a failed species fetch shows "The plant list is updating. Check back
soon." while the kit section (and its request modals) keep working, and vice versa.

Staff page (`manage-plants.html`, the "Plants" nav link after Services): two tabs
(Species / Kits). Each is a compact list (photo thumb, name, botanical/blurb, Live/Hidden
pill) with up/down arrows that swap the two rows' `sort` values, an Edit modal (all fields;
tags entered comma-separated and validated against the allowlist
`spring/summer/fall/shade/medicinal/edible/bird`, unknown tags rejected inline; the kit
editor edits its plant list as dynamic name+note rows), Deactivate/Reactivate (soft hide
from the shop, `active` flag), and Delete. Delete is a hard delete; if the row's photo is a
gallery-bucket object (not a `static:` asset) the storage object is removed best-effort
first, then the row. New rows get `sort = max(existing) + 10`. Data helpers live in
`assets/data.js`: `getPlantSpecies` / `getPlantKits` (staff reads, inactive included),
`addPlantSpecies` / `updatePlantSpecies` / `deletePlantSpecies` (and the kit equivalents),
plus `plantPhotoUrl` for gallery-bucket paths.

## Public questions ("Ask us anything")

Migration `0020_questions.sql` adds `public.questions`, a public "Ask us anything"
form that feeds a staff inbox. Applied live via the Management API, so register it
with `supabase migration repair --status applied 0020` before any `supabase db push`.

Table `public.questions` columns:

| column       | notes                                                            |
| ------------ | ---------------------------------------------------------------- |
| `name`       | optional                                                        |
| `email`      | optional (encouraged, so staff can answer directly)              |
| `question`   | required                                                        |
| `answer`     | staff-entered answer (nullable)                                  |
| `status`     | `new` (default) / `answered` / `published` / `dismissed` (CHECK) |
| `created_at` | default `now()`                                                 |
| `updated_at` | maintained by the shared `set_updated_at` trigger                |

`status = 'published'` is reserved for a FUTURE public Q&A built from answered
questions. There is **no public (anon) read policy yet** - marking a question
published only sets the status today; it does not expose it publicly.

RLS: `anon` may INSERT only (`qs_anon_ins`, `with check (true)`), matching the
return=minimal insert pattern so no anon read policy is needed; everything else
(read, answer, status updates, delete) is staff-only (`qs_staff_all`,
`authenticated` + `is_portal_user()`).

Where things live:

- Public form: `questions.html` (marketing-branded, `EcoSite.renderNav(null)`, loads
  `data.js` with no auth). Fields: question (textarea, required), name (optional),
  email (optional, encouraged). Submits through `DataStore.submitQuestion` (anon
  fire-and-forget, no `.id` reads). Success note mentions a future Q&A.
- Entry points: the homepage "Ask a question" band (green callout near the volunteer
  band) and an "Ask a question" link in the "Get involved" footer on every marketing
  page. The public nav is deliberately NOT extended (it is already crowded).
- Staff inbox: `question-inbox.html` (the "Questions" nav link after Grant Finder).
  Groups questions by status (new first, then answered, published, dismissed). Each
  card shows the question, a name/email line (mailto when an email is present), the
  date, an Answer textarea (Save marks it `answered`), and Mark published / Dismiss /
  Delete (confirm) actions. Every anon-submitted string is `esc()`'d (stored-XSS class).
- `dashboard.html` "Needs attention" surfaces an "N new question(s)" item
  (`status = 'new'` count) linking `question-inbox.html`.

Data helpers (`assets/data.js`): `submitQuestion` (anon), plus staff `getQuestions`
(`created_at` desc), `updateQuestion(id, ch)`, `deleteQuestion(id)`.

## Shop (non-plant merch)

Migration `0021_merch.sql` adds `public.merch_items`, the catalog behind the standalone
Shop page. The card game moved out of the Native Plants page (`plants.html`) and into
this shop as the first item. Applied live via the Management API, so register it with
`supabase migration repair --status applied 0021` before any `supabase db push`.

Table `public.merch_items` columns:

| column        | notes                                                             |
| ------------- | ----------------------------------------------------------------- |
| `name`        | required                                                         |
| `blurb`       | optional description                                             |
| `price_text`  | free text ("US $40", "From $15")                                  |
| `status_text` | free text ("Pre-order", "In stock", "Coming soon")                |
| `photo_path`  | `static:<path>` repo asset, or a gallery-bucket object (see below) |
| `link_url`    | optional external buy link; the public card renders it ONLY when it starts with `https://` |
| `sort`        | integer, ascending                                              |
| `active`      | boolean; anon sees active only                                   |
| `created_at`  | default `now()`                                                 |
| `updated_at`  | maintained by the shared `set_updated_at` trigger                |

RLS: `mi_anon_read` lets anon SELECT only `active` rows; `mi_staff_all` gives
authenticated portal users full CRUD (and their reads return inactive rows too).
Carries the shared `set_updated_at` trigger.

Photo convention (rooted at `assets/img/`, subdirectories allowed):

- `static:<path>` -> a repo static asset served from `assets/img/<path>`. The path may
  contain subdirectories; each segment is charset-guarded (`/^[A-Za-z0-9._-]+$/`) and
  `..` is rejected, so it cannot escape `assets/img/`. The seeded card game uses
  `static:game/game-playing.jpg` (the four card-art files stay in `assets/img/game/`;
  they were NOT moved). Static assets are never touched in storage on delete or replace.
- any other value -> a gallery-bucket object served via its public URL. Staff photo
  uploads on `manage-shop.html` go through `DataStore.resizeImage` (long edge <= 1600px,
  JPEG q0.85) and land in the `gallery` bucket under `shop/<uuid>.jpg` (the existing
  `gallery_staff_all` object policy covers these writes; public bucket read serves them).

Seed: the card game was seeded via the Management API as the first item
(`name = 'Ecotopian EarthCare: The Card Game'`, blurb from the old plants.html copy,
`price_text = 'US $40'`, `status_text = 'Pre-order'`, `photo_path =
'static:game/game-playing.jpg'`).

Where things live:

- Public page: `shop.html` (marketing-branded, `EcoSite.renderNav('shop')`; "Shop" is
  in the public nav between Native Plants and Events, and in the "Explore" footer). It
  reads active rows over anon (ordered `sort` then name) with a parity guard so a
  signed-in staff JWT never leaks inactive rows onto the public grid. Each card shows the
  photo, name, blurb, price, and a status chip. CTA: if `link_url` is `https://`, a "Buy"
  link (new tab); otherwise a "Pre-order / Ask about this" button opens a modal
  (name required; email OR phone required; quantity 1-5; optional note). On submit it does
  two anon inserts, mirroring the plants flows: an `intake_submissions` row
  (`service_type = 'merch'`) and a `jobs` row (`status = 'inquiry'`, title
  `"<item> Order Request"`, type `merch`, activity log "Received via shop page."). The card
  game entry (a `static:game/...` photo) also renders three hardcoded card-art thumbnails.
- The card game section was removed from `plants.html`; a small cross-link in the intro
  ("Looking for the card game? It moved to our new Shop.") points at `shop.html`.
- Staff page: `manage-shop.html` (the "Shop" nav link after Plants). A single compact list
  (thumb, name, price, status chip, Live/Hidden pill, external-link note) with up/down
  arrows that swap `sort` values, an Edit modal (name, blurb, price, status, https-validated
  buy link, photo upload), Add item, Deactivate/Reactivate, and Delete (confirm; a
  gallery-bucket photo object is removed best-effort first, never a `static:` asset). New
  rows get `sort = max(existing) + 10`.

Data helpers (`assets/data.js`): `getMerchItems` (staff read, inactive included, ordered
`sort` then name), `addMerchItem` / `updateMerchItem` / `deleteMerchItem(id, photoPath)`,
plus `merchPhotoUrl` for gallery-bucket paths.

## Deploy

The site is a static bundle deployed to Netlify:

```
netlify deploy --prod --dir=.
```

- Netlify site: `ecotopia-portal-578`
- Custom domain: `ecotopia.bagcarriers.dev`

## Design notes

- The `complete_task` RPC is intentionally callable by the anonymous role. The QR
  check-in kiosk is an honor-system flow where volunteers mark their own tasks done;
  there is no authenticated session at the kiosk. This is by design, not a gap.

## Dev seed

`supabase/seed-dev.sql` seeds demo data for local development only. NEVER run it
against production.

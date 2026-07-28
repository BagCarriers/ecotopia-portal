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

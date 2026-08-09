# Ecotopia Portal - Operations

Operational notes for the Ecotopia Earthcare admin portal. Keep this file current;
it is committed so it survives across machines and sessions.

## Supabase project

- Project ref: `wibnryfinfwbwwgsyojr`
- URL: `https://wibnryfinfwbwwgsyojr.supabase.co`
- The anon key in `assets/config.js` is public-safe by design; all protection comes
  from Row Level Security (RLS). Never commit any other key.

## Migrations

Migrations `0001`-`0033` were applied to the
live database directly via the Supabase Management API
(`POST https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query`),
NOT via `supabase db push`. Because of that the CLI does not know any of them ran: the
`supabase_migrations.schema_migrations` table does not exist on this project at all
(checked 2026-07-31, `relation ... does not exist`, not merely empty). The first
`migration repair` creates it.

Before ever running `supabase db push` against this project, first register the
already-applied migrations so the CLI does not try to re-run them:

```
for n in $(seq -w 1 33); do supabase migration repair --status applied 00$n; done
```

(equivalently, one `supabase migration repair --status applied <NNNN>` per file, `0001`
through `0033`). Keep this range current: every new migration in this project is applied
by hand through the Management API, so every new migration extends it.

**`0034_inat_sync_cron.sql` is committed but deliberately NOT applied**, so it is not in
that range and must not be repaired as applied. It schedules the nightly iNaturalist sync,
and scheduling that job publishes Creative Commons photographs to the live shop. See
"iNaturalist species enrichment" below for the precondition that has to be true first.

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
  `admin_fee = round(subtotal * 0.05, 2)`, and `total = subtotal + admin_fee`. All three
  are BASE (cash) figures. See "Cash-discount pricing" below for how the card figures are
  derived at display time.
- The fee is computed on the BASE subtotal, never on the grossed one, so choosing to pay
  by card does not enlarge the administration fee.
- The fee percent lives in ONE place: the `ADMIN_FEE_RATE = 0.05` const in
  `assets/pricing.js`. Change it there and nowhere else.
- The fee is a QUIET line just above the total, never a line item in the table. It reads
  **"Administration"** on the two client-facing documents (`quote-view.html:268`,
  `quote-print.html:218`) and **"Administration (5%)"** on the staff builder summary
  (`quotes.html:225`), where naming the rate is useful and no client sees it.
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
(gold header, line-item table, quiet "Administration" line above TOTAL, deposit +
balance). Amounts are grossed for card and paired with their cash figures, see
"Cash-discount pricing". Action panel by state:

- `sent`: an "Accept this quote" button reveals a "Type your name to accept" input and a
  confirm button that calls `accept_quote`, then re-fetches and shows the accepted state.
- `accepted`/`invoiced`: a green "Accepted by <name> on <date>" banner, then a Deposit
  panel (when `deposit > 0` and `deposit_status != 'paid'`) showing "Deposit due: $X" and
  payment instructions; a paid deposit shows a "Deposit received" confirmation instead.
- invalid/expired/unknown token: a friendly "This quote link is not available" screen with
  the `814-631-5338` phone number.

Every dynamic value (client name, line items, `accepted_by`) is `esc()`'d even though
these are staff/DB strings, because the page renders them publicly.

Deposit payment: online card payment is handled by **Square** (see the "Square deposit
payments" section below). Until Square credentials are set the deposit panel shows the
manual check instructions with no code change, so this page is safe to ship before the
processor is live.

## Square deposit payments

Online deposit payments for accepted quotes, via Square Payment Links. Built to run
**dark**: the whole flow is deployed and live, but until the five Square secrets are set
it returns `{configured:false}` and the public quote page falls back to the manual check
instructions. Setting the secrets lights it up with **zero code changes**.

Migration `0024_square_orders.sql` adds two nullable `public.quotes` columns:
`square_order_id` and `square_pay_url`. Applied live via the Management API, so register
it with `supabase migration repair --status applied 0024` before any `supabase db push`.
No new policies: only the `square-pay` edge function (service role) touches these columns;
the public page never reads them (it reads the coarse `deposit_status` via the existing
token-gated `get_quote_by_token` RPC).

`square-pay` edge function (one endpoint, two jobs, told apart by the presence of the
`x-square-hmacsha256-signature` header):

- **`POST {action:'create_link', token:<share_token>}`** - PUBLIC (anon; the public
  quote-view page calls it on the accepting client's behalf with the anon `apikey` +
  `Authorization: Bearer <anon>` headers). Validates the token is >= 32 chars, then looks
  up the quote via service role: its status must be `accepted` **or `invoiced`**
  (`index.ts:207`), with `deposit > 0` and not already `deposit_status = 'paid'` (which is
  a `409`). If the quote already has a `square_pay_url` it is
  returned as-is (idempotent re-click). Otherwise, if `SQUARE_ACCESS_TOKEN` or
  `SQUARE_LOCATION_ID` is unset it returns `{configured:false}` (dark mode). With both
  set, it creates a Square Payment Link (`quick_pay` for `Deposit - Quote N of YYYY -
  Ecotopian EarthCare`, amount **`cardCents(round(deposit*100))`** cents, `idempotency_key
  = <quote id>:deposit:<that amount>`), saves `square_order_id` + `square_pay_url`, flips
  `deposit_status` to `pending`, and returns `{configured:true, url}`.
  **The idempotency key carries the amount, and it has to.** Square answers a repeated key
  with the original link at the original amount, so a key naming only the quote would hand
  back the old charge after staff changed the deposit, and the re-mint below would be a
  no-op. See "Editing a deposit after the link is minted".
  **The deposit carries the card uplift** (`index.ts:255`): `quotes.deposit` is the BASE
  figure staff entered, and this is the card path, so a $200 deposit is charged **$208**.
  `quote-view.html` pairs both figures wherever it names a deposit, so the page and the
  link agree: "Deposit due: $208.00" over "$200.00 if you pay by check or cash" in the
  action panel (`:302-303`), and `DEPOSIT RECEIVED` over `By check or cash:` on the
  document itself. See "Cash-discount pricing".
- **Square webhook (`payment.updated`)** - Square POSTs the event JSON signed with an
  HMAC-SHA256 over (`SQUARE_WEBHOOK_URL` + raw body), base64, in the
  `x-square-hmacsha256-signature` header. The function verifies that signature
  (constant-time) against `SQUARE_WEBHOOK_SIGNATURE_KEY`; a missing/unset key or a
  bad/missing signature is rejected `401`. On a `COMPLETED` payment it looks up the quote
  by `square_order_id` (= `payment.order_id`) and sets `deposit_status = 'paid'` **and
  `deposit_tender = 'card'`** (`index.ts:141`). Events for unknown orders (or non-completed
  statuses) are a fast `200` no-op.

  **Do not reconcile off `deposit_tender`.** It is written in exactly that one place and
  read nowhere. The manual "Mark deposit paid" action on `quotes.html` sets only
  `deposit_status`, so a deposit taken by check or cash leaves the column null. Null
  therefore means "not recorded", never "not a card", and the column cannot today tell the
  two apart.

Tokens and keys are never logged or returned; Square API error bodies are swallowed (the
page just falls back to manual). Deployed `--no-verify-jwt` (the create_link path is anon;
the webhook path authenticates itself via its signature), pinned in
`supabase/config.toml` (`[functions.square-pay] verify_jwt = false`):

```
supabase functions deploy square-pay --no-verify-jwt --project-ref wibnryfinfwbwwgsyojr
```

The function's public URL is:
`https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/square-pay`

Public page (`quote-view.html`): when a quote is accepted with a deposit still owing, the
page calls `create_link` and renders the deposit panel by result -

- `configured:true` -> a prominent green "Pay your deposit online" button (the returned
  Square url, `target=_blank rel=noopener`), a "Secure card payment via Square" note, and
  the check-by-mail instructions as a secondary option.
- `configured:false` (dark) or any error/unreachable -> the manual check instructions
  (`MANUAL_INSTRUCTIONS` const), unchanged from before Square.
- `deposit_status = 'pending'` (a link already exists / a return visit) -> a "Payment link
  created. Already paid? It can take a minute to confirm." line above the same button.
- `deposit_status = 'paid'` -> a green "Deposit received. Thank you!" banner (no button).

Staff page (`quotes.html`): the `Deposit: unpaid/pending/paid` pill and the manual "Mark
deposit paid" action are unchanged. A Square payment flips the pill to `paid` on its own
(webhook); "Mark deposit paid" stays as the manual override for checks / cash / any
deposit paid outside Square.

### Editing a deposit after the link is minted

A Square Payment Link charges the amount it was minted for and nothing else, forever.
Nothing in Square updates when `quotes.deposit` changes. So **any writer of
`quotes.deposit` must clear `square_pay_url` and `square_order_id` with it**, or the
client's quote will show one figure over a Pay button that takes another.

The quote builder is the only writer today and does exactly that (`quotes.html`, the
editing branch of the builder submit handler): when the deposit figure moves on a quote
that has a minted link and a deposit **not** already paid, it nulls both columns and puts
`deposit_status` back to `unpaid`. The next load of the client's quote page mints a fresh
link at the new figure. Because the idempotency key names the amount, that really is a new
link; with the old key Square would have returned the original one and the clear would have
changed nothing. Verified against the sandbox on 2026-07-31: clearing the columns without
changing the deposit returned the identical url and `square_order_id` (retry protection
intact), and lowering $5,000 to $2,000 returned a new url whose checkout page charges
`208000` cents, matching the `$2,080.00` the page displays.

Two things this does not do:

- **A deposit already paid is never re-minted.** The money is in and that link is the
  record of it. Editing the figure afterwards leaves the quote disagreeing with what was
  collected, which is the deposit reconciliation gap tracked separately (nothing records
  the observed deposit amount).
- **The old link is not deactivated.** It stays live and payable at the old amount. We
  never send that url anywhere ourselves (the client gets `quote-view.html?t=...`, which
  reads the current link), so the exposure is a client who kept an old checkout page or
  bookmark. Closing it means storing Square's `payment_link.id` and calling
  `DELETE /v2/online-checkout/payment-links/{id}` on re-mint, which needs a new column.
  **A payment on a superseded link is silently unrecorded, not merely unreconciled.**
  `handleWebhook` looks the payment up in `quotes` by `square_order_id`, which now holds the
  **new** order, finds nothing, falls through to `orders`, finds nothing there either, and
  returns `{ok:true}`. The money lands in Square with **no portal record at all**: the
  deposit stays `unpaid`, no row moves, nothing is logged. It will only ever surface in
  Square's own reporting, so reconcile Square against the portal before writing a deposit
  off as unpaid.

### Secrets checklist (set the night Jordan creates his Square account)

In the Square Developer dashboard (https://developer.squareup.com): create/open an
application, then read its **Sandbox** credentials first to test, and switch to
**Production** credentials to go live.

1. `SQUARE_ACCESS_TOKEN` - the application's access token (production or sandbox).
2. `SQUARE_LOCATION_ID` - a location id from the account (Locations in the dashboard, or
   `GET /v2/locations`).
3. `SQUARE_ENV` - `sandbox` while testing, `production` when live (defaults to
   `production` if unset).
4. `SQUARE_WEBHOOK_SIGNATURE_KEY` - from the webhook subscription (below).
5. `SQUARE_WEBHOOK_URL` - the function's own public URL, EXACTLY as registered in Square
   (`https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/square-pay`). The signature is
   computed over this string + the body, so it must match the registered notification URL
   character-for-character.

Webhook setup: in the dashboard's Webhooks (Subscriptions), add a subscription with the
notification URL above, subscribe to the **`payment.updated`** event, and copy its
**signature key** into `SQUARE_WEBHOOK_SIGNATURE_KEY`.

Set all five and redeploy the function (secrets are read at invocation, but redeploy to be
safe):

```
supabase secrets set --project-ref wibnryfinfwbwwgsyojr \
  SQUARE_ACCESS_TOKEN=<token> \
  SQUARE_LOCATION_ID=<location_id> \
  SQUARE_ENV=sandbox \
  SQUARE_WEBHOOK_SIGNATURE_KEY=<signature_key> \
  SQUARE_WEBHOOK_URL=https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/square-pay
supabase functions deploy square-pay --no-verify-jwt --project-ref wibnryfinfwbwwgsyojr
```

Test in sandbox first (accept a test quote, click Pay, complete a sandbox payment, confirm
the pill flips to `paid`), then swap `SQUARE_ACCESS_TOKEN`/`SQUARE_LOCATION_ID` for the
production pair, set `SQUARE_ENV=production`, and re-point the webhook to a production
subscription (new signature key). Manual "Mark deposit paid" is always available as a
fallback.

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
rendering the same filter chips, per-plant order tray, and 4-tier kit modals as before.
Every price on the page is printed as a pair, "$5.20 card · $5.00 cash or check" and the
kit equivalent, never a single figure: see "Cash-discount pricing". Plant prices are per
size and live in `PLANT_SIZES` (see "Plant sizes and seasons"); the kit pricing table
(`KIT_TIERS`, base dollars) stays hardcoded and universal. The card price is always
derived from the base. The card
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

## Plant sizes and seasons (2026-08-01)

Migrations `0028_plant_sizes.sql`, `0029_plant_size_settings_rls.sql` and
`0030_plant_size_settings_touch.sql`. Applied live via the Management API, so register
each one (`supabase migration repair --status applied 0028`, and the same for `0029` and
`0030`) before any `supabase db push`.

Every wildflower species is sold in up to two sizes, each independently switchable by
season:

| size key | label and blurb | base price | card price |
| -------- | --------------- | ---------- | ---------- |
| `plug`   | Spring plug, "3 by 5 inch container" | $5.00 | $5.20 |
| `gallon` | Gallon pot, "More mature, ready from mid summer" | $8.00 | $8.32 |

The base price is what cash or check pays; the card price is derived from it by the shared
uplift. Both figures are always shown together and **a discount percentage is never stated
to a customer anywhere in this project**, on any surface, for any product. See
"Cash-discount pricing" for why a single percentage would be wrong about one of the two
figures.

### Where a plant price lives

`PLANT_SIZES` in `supabase/functions/square-pay/index.ts` maps a size key to integer
CENTS (`plug: 500`, `gallon: 800`). That is the only figure ever charged. `plants.html`
holds a display mirror keyed exactly the same way but carrying DOLLARS plus the label and
blurb copy the card renders, the same deliberate shape difference `KIT_TIERS` already has
between the two files.

**Never put a plant price in the database.** Migration `0028` says so in its own header,
and the reason is the drift guard: it can only compare two constants it can scrape out of
two files. A price in a table would be invisible to it.

`tests/pricing.test.js` reads both files and asserts they agree:

- "the edge function prices both sizes and nowhere else does" scrapes `PLANT_SIZES` out of
  the edge function, requires `plug: 500` and `gallon: 800`, and fails if the retired
  `PLANT_PRICE_CENTS` reappears.
- "plants.html states each size price and it matches the constant" evaluates the page's own
  object literal and requires base 5 and 8, card 5.20 and 8.32.

Change one file, change the other, or the suite fails. The older test that scraped a
single `PLANT_PRICE` out of a sentence of marketing copy is gone: no static sentence can
state a plant price that stays true now, so no price appears in the page's prose at all.
Every figure the page prints is rendered from `PLANT_SIZES`.

### Orderable means both are true

A size is orderable only when `plant_size_settings.active` **AND**
`plant_species.offers_<size>` are both true. **A species narrows, never widens**: with the
gallon season closed, ticking "Grown as gallon pots" on a species changes nothing a
customer can see or buy.

The rule is applied in three places, and the server one is the one that counts:

- `plants.html` renders a size row only when the season is open and the species offers it.
- `addToTray` re-applies the same test (plus known-species, known-size and sold-out
  guards) before it will put anything in the tray, so a re-rendered or hand-poked button
  cannot add a size the card was not entitled to show.
- `square-pay` re-checks both facts server-side against a fresh read of
  `plant_size_settings` and answers `409 {error:'size_closed', item}`. **This is the only
  check that catches a season that closed after the page loaded**, because the page's own
  two checks share one in-memory snapshot taken at load. A stale tab or a hand-written
  payload cannot buy a closed size.

`offers_plug` and `offers_gallon` are `not null default true`, and every reader treats a
missing flag as yes (`!== false`), so all 50 existing species offer both sizes today
(confirmed live 2026-08-01: 50 of 50 on each flag).

### Seasons are a plain switch with no scheduled end

`public.plant_size_settings`, one row per size, primary key `size_key` (CHECK constrained
to `plug` / `gallon`), mirroring the `service_settings` shape: `label`, `blurb`, `active`,
`off_message`, `reopen_date`, `sort`, `updated_at`.

- **`active` is a switch, not a schedule.** Nothing closes a season on a date. Jordan
  closes a size when he runs out of it, by hand, in the portal.
- **`reopen_date` is courtesy copy, not a trigger.** When every size is closed the public
  card prints the off message plus "We reopen <date>." if one is set. Nothing reads that
  date, and it never reopens anything; turning the size back on is a manual click.
- Seed state (still live as of 2026-08-01): `plug` active, `gallon` inactive. The
  migration therefore changed nothing a customer could see. The gallon size becomes
  visible the moment Jordan turns that season on.
- **`label` and `blurb` exist in two places and only one of them is public.** The public
  card renders the label and blurb out of `PLANT_SIZES` in `plants.html`, next to the
  price; the row's `label` / `blurb` columns are what the portal's seasons table shows.
  Editing those columns changes the staff view only. `off_message` and `reopen_date` are
  the only columns the public page reads text out of.

Closed-season copy on the public card: if some size is still open, a species that offers
none of the open ones says "Not available in the sizes we have right now." If every season
is closed, each closed size gets its say. One message (or the same message twice) prints
once with no label; two different messages each print prefixed with the size label, so a
gallon-specific note is never swallowed by the plug's; and if staff left every message
blank it falls back to "Plant sales are closed for the season." The messages and dates are
staff-entered strings, so both are escaped at render.

RLS on `plant_size_settings`:

| policy | who | what |
| ------ | --- | ---- |
| `pss_anon_read`  | anon | SELECT, `using (true)` |
| `pss_staff_read` | authenticated | SELECT, `using (true)` |
| `pss_staff_write`| authenticated | ALL, `using (is_portal_user()) with check (is_portal_user())` |

**Migration `0029` tightened the write policy.** `0028` shipped it as `using (true)`,
which is wider than every sibling settings table: any authenticated account, including a
deactivated one, could open or close a plant season and write the off message a customer
reads. `is_portal_user()` is the gate `service_settings` already uses. Anon read is
deliberately preserved so a logged-out visitor still sees the closed-season note.

**Migration `0030`** attached the shared `set_updated_at` trigger, which `0028` declared a
column for but never wired up, so `updated_at` was advertising an audit trail it did not
keep.

### Who switches what, and where

`manage-plants.html`, Species tab:

- A **Plant seasons** card sits above the species list: one row per size with a status
  pill, the off message, the reopen date, and Turn off / Turn on / Edit message. Turning a
  size ON clears `off_message` and `reopen_date` in the same write. Turning it off opens
  the message-plus-optional-reopen-date modal, the same shape `manage-services.html` uses.
- The species modal gained "Sizes grown" checkboxes (`offers_plug` / `offers_gallon`) and
  separate "Plug stock" / "Gallon stock" inputs.

Data helpers in `assets/data.js`: `getPlantSizeSettings()` (ordered by `sort`) and
`updatePlantSizeSetting(sizeKey, changes)`, keyed on `size_key`, not `id`.

### Per-size stock

`0028` **dropped `plant_species.stock_qty`** and replaced it with `stock_plug` and
`stock_gallon` (both nullable integer, same semantics as before: null = untracked, an
integer = a tracked count, 0 = sold out). One counter could not express plugs selling out
while gallons remained. The drop was safe because `stock_qty` was null on all 50 species
rows, checked immediately before the migration ran and recorded in its header comment.
Both new columns are still null on all 50 rows today, meaning every species is untracked.
**`plant_kits.stock_qty` and `merch_items.stock_qty` still exist and are unchanged.**

`decrement_stock` gained a fourth argument. Its live signature is now
`decrement_stock(p_kind text, p_id uuid, p_qty integer, p_size text default null)`; the
old three-argument version was dropped, and execute on the new one is again revoked from
`public`/`anon`/`authenticated` and granted to `service_role`. Species lines pass
`plug` or `gallon`. Kit and merch lines pass null, and their branches ignore `p_size`
entirely.

**A NULL `p_size` on a species line silently decrements nothing.** Both species branches
match on `p_size = 'plug'` / `p_size = 'gallon'`, and NULL matches neither, so the call
succeeds and no counter moves. That is exactly why the caller (`decrementOrderStock`)
defaults a sizeless species line to `plug` rather than passing the size straight through.
Order rows written before `0028` carry no `size` on their line items, and one of them was
still unpaid when this was checked live on 2026-08-01, so the default has a real row to
serve.

### The sizeless-means-plug default is load-bearing

`create_order` reads a species line with **no `size` at all** as a `plug`. A page built
before sizes existed sold plugs, so that is what such a payload means, and this is what
kept plant checkout working on a live site through the window between the migration and
the page deploy. Only an **explicitly unknown** size is an error.

| species line payload | result |
| -------------------- | ------ |
| no `size` key at all | priced and stocked as `plug` |
| `size: 'plug'` or `size: 'gallon'` | that size |
| any other `size` value | `400 {error:'bad_size'}` |
| a known size whose season is closed, or which the species does not offer | `409 {error:'size_closed', item}` |
| a known, open size with `stock_<size> < qty` | `409 {error:'insufficient_stock', item}` |

The cart merge key applies the same default. Without it the two spellings of a plug
(absent, and explicit `'plug'`) would hash to different keys, and each half would clear
the per-line stock check on its own, which is precisely the split the merge exists to
prevent. **Only a species line contributes a size to the key.** The kit and merch
branches ignore the field entirely, so letting their `size` into the key would let a
crafted payload split one merch line into as many lines as it can invent size names for
and clear the stock cap on each.

### Failure modes worth knowing

- **A failed season read is its own answer, never a closed season.** `create_order`
  returns `500 {error:'server_error'}` if the `plant_size_settings` read errors, rather
  than continuing with an empty open-size set, which would tell every plant customer
  "sold out" while kits and merch kept selling. `plants.html` puts its season read inside
  the same try block as the species fetch for the same reason: a failure renders "The
  plant list is updating. Check back soon." instead of a false closed-season notice the
  customer could not tell from the truth.
- **Seasons are read once per order**, before the line loop, so a season closing mid-cart
  cannot half-accept it, and **only when the cart holds a species line**. A kit or merch
  order never touches `plant_size_settings` and so cannot fail on it; that is what makes
  the bullet above true rather than aspirational.
- The public tray is keyed `<species id>:<size>`, not by species id, and the server's
  merge key carries the size too. A key that ignored the size would collapse a plug and a
  gallon of the same plant into one line priced at whichever size arrived first.

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
| `price_text`  | free text label, **display only**. NOT the price we charge, and a payable card does not render it at all: `shop.html:286` shows it only on request-only items and on items with an external buy link |
| `price_cents` | integer, nullable (added by `0025`). **The storefront price.** Set = orderable through our own checkout, and the card shows the card and cash pair; null = request-only (`400 not_payable` if ordered). Same exception as `price_text` above: a valid `https://` `link_url` wins, and such a card shows `price_text` and sends the CTA outside instead |
| `stock_qty`   | integer, nullable (added by `0025`). null = untracked, 0 = sold out |
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

## Inventory and orders

Migration `0025_inventory_orders.sql` makes **Supabase the single source of truth** for
catalog, prices, inventory, and orders. **Square is a pure payment vessel**: it only ever
sees a computed total via an ad-hoc `quick_pay` Payment Link, and **nothing is mirrored
into Square** (no catalog items, no inventory, no customers). Applied live via the
Management API, so register it with `supabase migration repair --status applied 0025`
before any `supabase db push`.

Schema changes:

- `plant_species.stock_qty`, `plant_kits.stock_qty`, `merch_items.stock_qty` (all nullable
  integer). **Stock semantics: `null` = untracked (always available); an integer = a tracked
  count; `0` = sold out** (the public page shows a "Sold out" chip and disables the button).
  **Superseded for species by migration `0028`**, which dropped `plant_species.stock_qty`
  in favour of `stock_plug` / `stock_gallon` with the same semantics per size (see "Plant
  sizes and seasons"). The kit and merch columns are untouched.
- `merch_items.price_cents` (nullable integer): the **payable** price. `price_text` stays
  display-only. A merch item with `price_cents = null` is **request-only** (it uses the old
  ask/pre-order form and cannot be ordered online); setting `price_cents` makes it orderable.
- `public.orders` (Supabase-owned). Columns: `order_token` (unique, 64 hex; the public
  status/pay page key), `customer_name`, `phone`, `email`, `items` (jsonb array of
  `{kind:'species'|'kit'|'merch', id, name, qty, unit_cents, tier?, size?}`; `size` is
  written on species lines since `0028`, and lines older than that carry none),
  `subtotal_cents`,
  `status`, `pay_mode` (`pickup`/`online`), `square_order_id`, `square_pay_url`, `note`,
  plus `charge_cents`, `tender` and `amount_collected_cents` from migration `0027` (see
  "Cash-discount pricing"). **No anon RLS policy** at all: a single `o_staff_all` policy
  for authenticated portal users; anon reaches orders only through the security-definer
  edge function. Carries the shared `set_updated_at` trigger.
- `decrement_stock(p_kind, p_id, p_qty)` (security definer): draws down a tracked row's
  stock, floored at 0, leaving untracked (`null`) rows alone. **Execute is revoked from
  `public`/`anon`/`authenticated` and granted only to `service_role`** - it is called ONLY
  by the `square-pay` edge function. **Migration `0028` replaced it** with
  `decrement_stock(p_kind, p_id, p_qty, p_size default null)`; the three-argument version
  no longer exists. Species callers must pass a size or nothing is decremented (see "Plant
  sizes and seasons"); kits and merch pass null and behave exactly as before.

**Order lifecycle:** `new` -> `link_created` (online, a Square link was minted) -> `paid`
-> `ready` -> `completed`, or `cancelled`. Stock is drawn down exactly once, on the first
transition into `paid` (idempotent: re-marking paid never double-decrements).

**Pricing authority (single source):** `PLANT_SIZES` (`plug`->500, `gallon`->800 cents)
and `KIT_TIERS` (`50`->7200, `100`->14400, `150`->20000, `200`->25000 cents) live in the
`square-pay` edge function. `PLANT_SIZES` replaced the old single `PLANT_PRICE_CENTS` in
migration `0028`'s companion change, and a test fails if that name comes back. Client-sent
prices are always ignored; the server re-prices every line from
the live catalog. `merch` lines are priced from `price_cents` (request-only items rejected).

The `square-pay` edge function gained three public/staff actions plus a webhook branch (one
endpoint, told apart by the `x-square-hmacsha256-signature` header then `body.action`):

- **`create_order`** (PUBLIC, anon) - `{action, customer:{name, phone?, email?}, items:
  [{kind,id,qty,tier?,size?}], pay_mode, note?}`. Validates server-side: name required; 1-40
  lines; qty 1-20 (kits forced 1-5, tier required and in `KIT_TIERS`); each row loaded from
  the live catalog and must be `active`; merch must have `price_cents` (else `400
  not_payable`). A species line also carries a size, defaulting to `plug` when absent, and
  must clear the season and species-flag check (`400 bad_size` / `409 size_closed`, see
  "Plant sizes and seasons"). Any tracked item short of the quantity asked
  (`stock_plug` / `stock_gallon` for a species, `stock_qty` for a kit or merch item) ->
  `409 {error:'insufficient_stock',
  item}`. Recomputes `subtotal_cents` server-side and inserts the order (`order_token` = 64
  hex) with `charge_cents` = `subtotal_cents` for `pickup` and **`cardCents(subtotal_cents)`
  for `online`**. `pay_mode:'online'` + Square configured mints a `quick_pay` Payment Link
  (`Order <first 8 of id> - Ecotopian EarthCare`, **amount `charge_cents`, NOT
  `subtotal_cents`** (`index.ts:450`) so Square is asked for the card price, idempotency
  `<id>:order`), saves `square_order_id`/`square_pay_url`, sets status `link_created`,
  returns `{token, pay_url}`. `online` but Square dark (or unreachable) ->
  `{token, configured:false}` (order stays `new`, treated as pickup, and **it keeps the
  card `charge_cents` while the customer will pay base**, which is why `staff_mark_paid`
  ignores that column). `pickup` -> `{token}`.
- **`order_status`** (PUBLIC, anon) - `{action, token}` (>= 32 chars). Returns `{status,
  items, subtotal_cents, charge_cents, pay_mode, pay_url, created_at}` for the public
  `order.html` page; `404` otherwise.
- **`staff_mark_paid`** (STAFF) - `{action, order_id, tender}` with an `Authorization:
  Bearer <staff JWT>`. **`tender` is REQUIRED** and must be `cash`, `check` or `card`;
  anything else is `400 {error:'bad_tender'}`. The JWT is validated by resolving it against
  GoTrue `/user` directly (apikey = service role) and confirming an active `portal_users`
  row. It exists because staff RLS can update `orders` but **cannot** call the
  service-role-only `decrement_stock`; this action sets `paid` AND draws down tracked stock
  in one call, for in-person pickups. It also records what was collected:
  `amount_collected_cents = subtotal_cents` for cash/check, `cardCents(subtotal_cents)` for
  card. Returns `{ok:true, status:'paid', collected_cents}` on the transition, or
  `409 {ok:false, status}` when the order had already moved on.
- **Webhook routing** - on a `COMPLETED` `payment.updated`, the function first looks up a
  `quotes` row by `square_order_id` (deposit flow, unchanged); if none matches it looks up an
  `orders` row and, when the order is still `new`/`link_created`, sets it `paid`,
  `tender = 'card'`, `amount_collected_cents = <what Square took>` and decrements tracked
  stock (idempotent; unknown order id is a `200` no-op). A collected amount that does not
  equal `charge_cents` still marks the order paid but raises the mismatch flag described
  under "Cash-discount pricing". **This is the same webhook URL Square already calls for
  deposit payments - order payments arrive here too.**

Where things live:

- Public `plants.html`: the plant tray and the kit modal now create orders (replacing the
  old `intake_submissions` + `jobs` writes). Each carries a pay-mode choice ("Reserve and pay
  at pickup" [default] / "Pay online now"); online falls back to a saved-for-pickup note when
  Square is dark. Since `0028` a species card carries one block per open size, each with its
  own price pair and its own Add button; a sold-out size (`stock_plug` / `stock_gallon` at 0)
  shows a chip and disables that size's button only, and a sold-out kit (`stock_qty === 0`)
  does the same for the kit.
- Public `shop.html`: payable merch (`price_cents` set) uses an "Order this" modal that
  creates an order; request-only merch keeps the ask/pre-order form; sold-out items are
  disabled. Branch flag: `isPayable = priceCents != null`.
- Public `order.html?t=<token>` (marketing-branded, `noindex`, NO auth): reads
  `order_status`, renders items, total, a Received -> Paid/Pay-at-pickup -> Ready -> Completed
  timeline, a Square Pay button when a link exists and the order is unpaid, else a
  pay-at-pickup note. Poll-free (refresh to update). Every value is `esc()`'d.
  A species line prints its size beside the name ("3x Anise Hyssop (Spring plug)"), the
  same parenthetical a kit uses for its tier, so a mixed order does not read as the same
  plant twice.
- Portal `orders.html` (the "Orders" nav link after Jobs): newest-first list with status
  filters, status pills, items + total, customer contact, note, and actions - **Paid cash**
  / **Paid check** / **Paid card** (three buttons, each calling `staff_mark_paid` with its
  own `tender`; they decrement stock), **Mark ready**, **Mark completed**, **Cancel**
  (plain staff status updates via `DataStore.updateOrder`), and **Copy order link**. A row
  with a recorded `amount_collected_cents` shows "Collected: $X <tender>" in place of the
  total; every other row shows the base total. Items carry the same size parenthetical
  `order.html` prints, which is what a picker reads off the screen.
  Both surfaces hold a `SIZE_LABEL` map of size key to display word, exactly the shape
  `TIER_LABEL` already has for kit tiers. It carries **no price**: the two size prices
  live in `PLANT_SIZES` (edge function, display mirror in `plants.html`) and the drift
  guard still sees exactly two copies. A size key that is not an own property of the map
  renders nothing, so a legacy sizeless line reads exactly as it always did.
  `dashboard.html` "Needs attention" surfaces "N new order(s)" (`new`/`link_created`).
- Staff editors: the `manage-plants.html` kit modal gains a "Stock (blank = untracked)"
  input, and its species modal gains "Plug stock" and "Gallon stock" (one per size, since
  `0028`); `manage-shop.html` gains "Stock" and "Price (USD, for online payment)" (stored as
  `price_cents`, blank = request-only). **`price_cents` is the storefront price for a
  payable item; the free-text `price_text` is a display label only** and appears just on
  request-only cards and on cards with an external buy link, so editing it does not change
  what a shopper pays. Data helpers in `assets/data.js`: `getOrders`
  (newest-first) and `updateOrder(id, ch)`; stock/price ride the existing camelCase mapping.

The whole online-payment path runs **dark** until Square credentials exist (same five
secrets as the deposit flow, see "Square deposit payments"); until then online orders save
for pickup with no code change.

## Cash-discount pricing (2026-07-30)

Ecotopian EarthCare prices to cash. **Every displayed price carries the cost of accepting
a card; cash and check pay the base price.** Nothing is added at checkout and no surcharge
is ever named: the customer sees two figures and picks one.

### The two rate mirrors

`CARD_UPLIFT = 0.04` exists in exactly **two** places and they must move together:

1. `assets/pricing.js` - the display authority, loaded by `order.html`, `plants.html`,
   `quote-print.html`, `quote-view.html`, `quotes.html` and `shop.html`. It exposes
   `EcoPricing = { CARD_UPLIFT, ADMIN_FEE_RATE, cardCents, cardDollars, quoteTotals }`.
2. `supabase/functions/square-pay/index.ts` - the **charging** authority. Every amount we
   actually take is computed here, from the live catalog, ignoring anything the client sent.

`tests/pricing.test.js` reads the edge-function source and asserts its `CARD_UPLIFT`
literal equals the one in `pricing.js`, so `npm test` fails loudly the moment either copy
drifts. That guard was verified to genuinely fail when one side is changed alone.

To change the rate: edit **both** constants, run `npm test`, then redeploy **both** the
edge function (`supabase functions deploy square-pay --no-verify-jwt --project-ref
wibnryfinfwbwwgsyojr`) and the static site. Deploying one without the other quotes a
customer one number and charges another.

Rounding is half-up to the cent throughout: `cardCents(baseCents)` for integer cents,
`cardDollars(baseDollars)` for dollar amounts.

### What is stored (migration `0027_cash_discount.sql`)

Applied live via the Management API, so register it with
`supabase migration repair --status applied 0027` before any `supabase db push`. It adds
`orders.charge_cents`, `orders.tender`, `orders.amount_collected_cents` and
`quotes.deposit_tender`. `tender` and `deposit_tender` are CHECK-constrained to
`cash`/`check`/`card`. No new RLS policies (orders has no anon policy; quotes is staff-only
plus its token-gated RPCs).

- **`orders.subtotal_cents` is BASE**, un-grossed. Its meaning did not change, which is why
  no backfill was needed.
- **`orders.charge_cents` is what we charge**: `subtotal_cents` for `pickup`,
  `cardCents(subtotal_cents)` for `online`. It is **nullable with no default and nothing
  backfills it**. `null` means "not priced yet" and must **never** be coerced to
  `subtotal_cents`: pre-0027 rows have no charge, and rendering `money(null)` would show
  "$0.00" beside a Square link charging the real amount, so `order.html` shows no total at
  all in that case. That blank applies only on the Square branch of `chargedLine()`; an
  unsettled pickup row prints the pair off `subtotal_cents` and never consults
  `charge_cents` at all. The staff list never renders `charge_cents`: an unsettled row on
  `orders.html` always shows `money(subtotalCents)`, the BASE total, including a
  `link_created` online order whose Square link is 4 percent higher. The row switches to
  "Collected: ..." on `amountCollectedCents != null` (`orders.html:219`), NOT on status, so
  a settled order whose payment event carried no usable amount (`index.ts:158` writes null)
  keeps showing the base total.
- **`orders.tender`** is null until the order settles (no default), then records how it was
  paid.
- **`orders.amount_collected_cents`** is the amount recorded as collected, and the two paths
  mean slightly different things by it. On the card/webhook path it is **observed**: what
  Square reported taking, or null when the event carried no usable amount. On the
  `staff_mark_paid` path it is **derived** (`index.ts:499`): what the tender says the
  customer owed, not what anyone counted. So it confirms a Square settlement, but on a
  pickup it only records what we asked for.
- **`quotes.total` is the CASH total** (base subtotal + the 5 percent administration fee,
  which is itself computed on the base subtotal). The builder writes it as
  `total: totals.cashTotal` (`quotes.html:490` and `:519`). Unchanged in meaning, so again
  no backfill. The card figures are derived at display time by `quoteTotals`, never stored.
- **`quotes.deposit_tender`** is set to `card` by the Square deposit webhook, and by
  nothing else. **Do not reconcile off it**: the manual "Mark deposit paid" action leaves it
  null, so null means "not recorded", never "not a card". Full caveat under "Square deposit
  payments" above.

### Tender at pickup

`orders.html` offers three buttons on an unsettled order: **Paid cash**, **Paid check**,
**Paid card**. Each calls `staff_mark_paid` with its own `tender`, which is now
**required** (`400 bad_tender` otherwise), and gets back
`{ok, status, collected_cents}`.

The collected amount is derived from **`subtotal_cents` and the tender, never from
`charge_cents`**: base for cash and check, `cardCents(subtotal_cents)` for card. This is
deliberate. An `online` order that never got a Square link (Square dark, or unreachable at
create time) still carries the **card** `charge_cents` on the row, but the customer was
routed down the pickup path and will hand over the **base** price. Reading `charge_cents`
there would record, and invite staff to collect, 4 percent more than the customer owes.

### Quote to invoice bills the CASH total

"Convert to invoice" on `quotes.html` writes `amount: q.total`, and `quotes.total` is the
**cash** total. `invoices.amount` keeps that meaning: the invoice list, the totals across
the top of that page and the reports all read it as one figure, and quietly writing a card
figure into it would move all of them.

So a job whose quote sheet says `TOTAL ESTIMATE: $10,900` becomes a `$10,500` invoice, and
if that client pays by card the job is under-billed by the card cost. **Nothing automatic
prevents this.** What the page does is refuse to let it happen quietly:

- the confirmation names both figures and says which one it is about to create;
- the invoice notes carry the card figure, so whoever sends it has the number without going
  back to the quote;
- the amount is editable on the Invoices page.

Choosing which figure to bill is a judgement about how that client pays, and it is
deliberately a human one. If invoices ever need to carry the tender themselves, that is a
column on `invoices` plus a decision about what the reports should then count, and it is
not built.

### Webhook mismatch flag

On a `COMPLETED` payment the webhook records `amount_collected_cents` from the event and
sets `tender = 'card'`. If that amount does not equal a non-null `charge_cents` (an event
carrying **no** usable amount counts as a mismatch too, because we cannot confirm what was
taken) the order is **still marked paid** - refusing would strand real money - and the
function prefixes

```
AMOUNT MISMATCH: expected <charge_cents>, <what happened>. Review before fulfilling.
```

onto the note, separated from the customer's own text by a blank line. The customer's text
is never overwritten: a mismatch is exactly when staff need the address and contact
preference they wrote. A null `charge_cents` is never flagged, because there is nothing to
compare against.

### The staff "Amount mismatch" chip

`orders.html` raises the chip off the **money columns**, never off the note. The gate is
`SETTLED.includes(status) && expected != null && amountCollectedCents !== expected`, where
`expectedCents(o)` is what the recorded tender says the customer owed:

| `tender` | expected |
| --- | --- |
| `cash` or `check` | `subtotalCents` (base) |
| `card`, `pay_mode = 'online'`, `chargeCents` non-null | `chargeCents` |
| `card`, otherwise | `cardCents(subtotalCents)` |
| null / anything else | null, and the row is never flagged |

Two of those rows are load-bearing and neither is obvious. **Comparing against
`chargeCents` alone would be wrong**: a pickup row's `charge_cents` is the BASE figure, so
every card taken at the table (`collected = cardCents(subtotal)`) would raise a chip, as
would every Square-dark `online` order paid in cash at pickup (`charge_cents` is the card
figure, the customer hands over base). Both are correct-by-design outcomes described under
"Tender at pickup", and flagging them would have been a systematic false positive on the
commonest path in the shop. And an order that really did go to Square is held to the
`charge_cents` its link was minted for rather than a fresh `cardCents()`, so **changing the
card rate cannot make every live link look short** (the `CARD_UPLIFT = 0` fallback under
"Before production credentials" would otherwise flag every link minted before the change).

**What it catches**: a Square payment that settled for anything other than the amount its
link charged, and a payment event that carried no usable amount at all (`collected` null
against a real expectation, because we cannot confirm what was taken). Those are exactly
the two conditions the webhook writes the `AMOUNT MISMATCH` note for, so the chip and the
note now agree, and the chip survives an operator editing the note away.

**What it does not catch**: anything on the `staff_mark_paid` path. That handler *derives*
`amount_collected_cents` from the tender by the same rule this gate expects, so a pickup
can never disagree with itself. If staff press "Paid cash" on a customer who handed over
too little, nothing here will know. It also does not catch a refund or a partial capture
made in Square after the order settled: the webhook only acts on the first transition out
of `new`/`link_created`.

**One known false positive, unreachable today.** A pre-0027 `online` row has a null
`charge_cents` and a Square link minted before the uplift existed, so it charges BASE. If
such a row settled now, `expectedCents` would fall through to `cardCents(subtotalCents)`
while Square collected base, and the chip would fire on a correct payment. `orders` is empty
in production (the shop has taken no orders), so no such row exists and none can be created.
If one ever turns up, read the Square payment rather than the chip.

The chip stays visible past `paid` because staff advance a flagged order through `ready`
and `completed`, and those are precisely the moments someone is about to hand over goods
that may not have been paid for. It deliberately excludes `cancelled`, so a flagged order
that is cancelled loses its chip at exactly the moment someone is deciding whether to
refund. The `AMOUNT MISMATCH` note text is still rendered on the card, so the signal is not
lost there, only demoted.

**It is no longer forgeable.** Before 2026-07-31 the chip keyed on the note starting with
`AMOUNT MISMATCH`. `orders.note` is customer free text off the public order form
(`index.ts:297`, stored verbatim at `:381`), so a customer could type that prefix into
their own order, pay their own Square link correctly, and have the webhook settle the row
with the forged text intact: the chip was already up the first time staff opened the page,
with no operator action anywhere in the sequence. The money columns are written only by the
webhook and by `staff_mark_paid`, and `orders` has no anon policy, so nothing a customer
can reach moves them.

### Customer-facing copy

**Never state a discount or surcharge percentage to a customer.** Show the two prices
instead. Adding 4 percent and then taking 4 percent back off does not return to the base
price (the true round trip off the grossed price is 3.846 percent), so any single stated
percentage would be wrong about one of the two figures. Every surface therefore prints the
pair:

- `plants.html`: the pair on every species card, once per open size ("$5.20 card · $5.00
  cash or check" for a spring plug, "$8.32 card · $8.00 cash or check" for a gallon pot),
  the same pair per line and on the total in the plant tray, and the kit equivalent in the
  kit modal directly above the tender choice (it updates with the size dropdown and is
  `aria-live="polite"`). No figure appears in the page's prose: prices vary by size and
  each size opens on its own season, so a written sentence could not stay true.
- `shop.html`: the pair on payable merch cards and in the order modal. Request-only items
  and items with an external buy link keep their free-text `price_text` label instead.
- `order.html`: an order still owing money at pickup shows "Due at pickup ... cash or check"
  and "If paying by card ..."; an order actually going to Square shows the single card total
  it will be charged; a settled order shows neither and states what was collected instead
  (see "What order.html shows in each state").
- `quote-view.html` / `quote-print.html`: line items are printed grossed, the "Administration"
  fee line sits above the card TOTAL, the cash total is stated beneath it, and the deposit
  and balance rows each carry their own "By check or cash" counterpart.

### What order.html shows in each state

Three helpers decide the whole page, and they all read the same two facts, so the item
column, the figure beneath it and the timeline can never quote different prices:

- `onSquare(o)` - `pay_mode = 'online'` **and** a usable `square_pay_url`. An `online` order
  that minted no link (Square dark or unreachable) is a pickup in every respect, so this is
  what the timeline's second step, the item column and the total all key off, never
  `pay_mode` on its own.
- `showsCardAmounts(o)` - `onSquare(o)`, **or** a settled order whose `tender` is `card`.
  When true, the item column is printed grossed; otherwise it is BASE.
- `chargedLine(o)` - the one figure printed under the column, or null when there is none.

| State | Item column | Figure beneath |
| --- | --- | --- |
| Unsettled, going to Square | grossed | `Total <charge_cents>` (nothing if `charge_cents` is null) |
| Unsettled, paying at pickup | BASE | the pair: `Due at pickup ... cash or check` and `If paying by card ...` |
| Settled, `tender` cash or check | BASE | `Paid by cash/check <amount_collected_cents>` |
| Settled, `tender` card | grossed | `Paid by card <amount_collected_cents>` |
| Settled, `amount_collected_cents` null | as above per tender | nothing |
| Cancelled | as above per tender | nothing |

A settled order never states a figure as due, and never states the two-price pair: the
tender has already been chosen, so there is only one true number left. Where that number is
unknown (a payment event that carried no usable amount, or a pre-0027 row with neither
column) the page prints no figure rather than a wrong one; the "Payment received" status
line still stands. `order_status` returns `tender` and `amount_collected_cents` for exactly
this. It does **not** return `note`, which can carry the staff-facing mismatch flag.

### Known characteristic: the charge grosses the subtotal, the column grosses each line

`quoteTotals` deliberately sums **individually grossed lines** (`cardSubtotal`) rather than
grossing the subtotal, because the client reads the grossed column on the printed quote and
that column has to add up to the total beneath it.

Orders charge the other way: `charge_cents = cardCents(subtotal_cents)`, one grossing of the
whole subtotal. For a unit price that is not a whole dollar, `cardCents(unit * qty)` summed
over the lines can differ from `cardCents(subtotal)` by a cent or two. **Drift is exactly
zero for every current price** ($5 plugs, $8 gallon pots, $72/$144/$200/$250 kits, the $40
card game, all whole dollars), so nothing is wrong today.

`order.html` prints a grossed column anyway, and settles the residual **on the last line**
so the column adds up to the figure beneath it. Two conditions gate that, and both matter:

1. **The lines must sum to `subtotal_cents`**, which is the precondition for the charged
   figure having been computed from them. If they do not, there is nothing to tie out
   against and a residual would be a fiction.
2. **The residual must be plausibly rounding: `abs(residual) <= lines.length`.**
   `cardCents()` can move each line by at most half a cent either way and the target carries
   half a cent of its own, so one cent per line is the ceiling for real drift.

The second bound exists because on a **settled** order the target is
`amount_collected_cents`, which is whatever Square actually reported, not a figure we
computed. Without it, a short settlement (charge 5093, Square reports 100) rendered a
literal `$-9.40` line item, and an over settlement rendered three $12.99 tins at $42.57. An
over settlement is not hypothetical: if Jordan's Square account applies its own service
charge (the open blocker below) it happens on **every** online order. When either gate
fails, the column is printed honestly grossed and left un-reconciled; the figure beneath it
still states what was really collected, and the two simply do not tie, which is the truth.

**What is charged never moves.** The residual is a presentation adjustment inside a total
that is still `charge_cents` (or, on a settled order, `amount_collected_cents`) exactly as
stored.

The shop card still shows a per-unit card figure, which is `cardCents(unit)`. If a
non-whole-dollar merch price is ever set, that per-unit figure times the quantity can be a
cent away from the line printed on `order.html`. Decide first which of the two the customer
should see.

### Before production credentials

**Open blocker.** If Jordan's Square account applies its own 4 percent service charge, this
implementation double-charges: we gross $5.00 to $5.20 and Square collects $5.41. Square's
documentation does not say whether Dashboard-configured automatic service charges attach to
`quick_pay` payment links, and the sandbox account is a fresh auto-created one with no
service charge, so it cannot answer the question. A completed sandbox order (2026-07-31,
$15.00 base) came back with `total_money` 1560, `total_service_charge_money` 0 and
`total_card_surcharge_money` 0, which shows Square added nothing **to an account that has
nothing configured**; it does not settle what Jordan's account will do. **One real
production payment must prove Square charges our amount and not more.** If it adds its own percentage, set
`CARD_UPLIFT = 0` in both mirrors: every display then falls back to the base price
automatically, because the display layer reads the same constant the server charges from.

## Deploy

The site is a static bundle deployed to Netlify:

```
netlify deploy --prod --dir=.
```

- Netlify site: `ecotopia-portal-578`
- Custom domain: `ecotopia.bagcarriers.dev`

### `--dir=.` uploads the whole checkout

That deploy command publishes the repository root, not a built subset, so every tracked
file goes to the CDN and is reachable over HTTP unless something stops it. Verified live
on 2026-08-02 against `ecotopianearthcare.com`: `/docs/OPERATIONS.md` (this file),
`/package.json`, every `/supabase/migrations/*.sql`, all four
`/supabase/functions/*/index.ts`, `/supabase/seed-dev.sql`, `/supabase/config.toml`,
`/tests/*.js` and `/scripts/verify-rls.mjs` all returned 200. No credentials are in any
of them (the functions read theirs from the environment), but together they are a
detailed map of the security model of a site that takes card payments.

`_redirects` now carries forced `404!` rules, above the Squarespace 301s, for `/docs/*`,
`/supabase/*`, `/tests/*`, `/scripts/*`, `/package.json`, `/package-lock.json`,
`/netlify.toml`, `/node_modules/*`, `/.superpowers/*`, `/.env` and `/.gitignore`. Two
details that are easy to get wrong:

- The `!` is mandatory. An unforced rule loses to a real file at the same path, and
  every path in that list is a real file, so without the `!` the rules do nothing.
- Rules match top to bottom, first match wins, which is why they sit above the 301s.

**They are not airtight.** Netlify matches redirect rules case-sensitively but serves
files case-insensitively. `/DOCS/OPERATIONS.MD` returned 200 on the live site, and
Netlify's own matcher (`netlify-redirector`, the WASM engine, driven against this
`_redirects` locally) returns no rule for that path. Covering every case variant would
take an exponential number of rules. The rules block what is guessable and what scanners
ask for; the complete fix is to stop uploading these files, which means deploying from a
publish directory that contains only site files instead of `--dir=.`. Netlify CLI 26 has
no `.netlifyignore`, so that is a layout change, not a config flag.

Hidden files are not uploaded by the CLI today (`/.gitignore` and
`/.superpowers/sdd/progress.md` both 404 live). That is a property of the deploy tool,
not a decision this site made, hence the belt-and-braces rules for them.

## Design notes

- The `complete_task` RPC is intentionally callable by the anonymous role. The QR
  check-in kiosk is an honor-system flow where volunteers mark their own tasks done;
  there is no authenticated session at the kiosk. This is by design, not a gap.

## Dev seed

`supabase/seed-dev.sql` seeds demo data for local development only. NEVER run it
against production.

## Event visibility (2026-07-29)
- `events.is_public` (default true). Anon RLS only returns public rows; site.js also
  filters `isPublic !== false` for signed-in staff parity.
- Calendar page "+ New Event" defaults INTERNAL (unchecked publish toggle) for crew
  days / site visits / reminders. The Events page creates public events and can flip
  visibility in its edit modal (INTERNAL pill shows on internal cards).
- The calendar-feed ICS (Jordan's own Google subscription) intentionally includes
  internal events; it is served by service role, not the anon policy.

## Reviews (2026-07-29)
- First-party reviews (no Google Business Profile yet): public.reviews, anon may
  INSERT only pending rows and SELECT only approved ones; staff moderate in
  review-inbox.html (approve / dismiss / delete). Pending count on the dashboard.
- Display: reviews.html (all approved + submit form) and a homepage testimonials
  strip (up to 3, hidden when none).
- Deliberately NO Review/AggregateRating schema markup: Google disallows rich-result
  markup for self-collected reviews. Revisit if a GBP is created later.

## Team members (2026-08-02)

Migrations `0031_team_members.sql` and `0032_team_members_anon_active.sql` move the
"Meet the team" grid on `about.html` out of eleven hardcoded `<figure>` blocks and into
`public.team_members`, edited on `manage-team.html` ("Team" in the portal nav, after
Shop). Both were applied live via the Management API, so register each one
(`supabase migration repair --status applied 0031`, and the same for `0032`) before any
`supabase db push`.

**A row here is public listing content and nothing else. It grants no portal access.**
Logins are `portal_users` rows and are managed on the Users page; adding someone to the
team grid does not give them an account, and removing them does not take one away.

Table `public.team_members` columns:

| column       | notes                                                              |
| ------------ | ------------------------------------------------------------------ |
| `id`         | uuid primary key, default `gen_random_uuid()`                      |
| `name`       | required; also the tie-breaker in both listing queries             |
| `role`       | required; the line printed under the name on the card              |
| `photo_path` | nullable. `static:<file>` repo asset, or a gallery-bucket object (see below); null renders an initials tile |
| `sort`       | integer, not null, default 0, ascending. No unique constraint      |
| `active`     | boolean, not null, default true. False hides the member from the public page, and from anon reads entirely |
| `created_at` | not null, default `now()`                                          |
| `updated_at` | nullable; maintained by the shared `set_updated_at` trigger, attached by `0031` at table creation |

RLS is enabled and there are exactly three policies:

- `tm_anon_read` - SELECT to `anon`, `using (active)`.
- `tm_staff_read` - SELECT to `authenticated`, `using (true)`. Deliberately wider than
  the anon policy: the portal has to keep seeing hidden rows so Jordan can unhide them.
- `tm_staff_write` - ALL to `authenticated`, `using (is_portal_user())` and
  `with check (is_portal_user())`. Not `using (true)`: an auth account that is not an
  active portal user must not be able to edit content that renders on the public site.

There is no anon INSERT, UPDATE or DELETE policy, and RLS is enabled, so the anon key
can only read. The anon role does hold the usual Supabase table grants on this table
(SELECT, INSERT, UPDATE, DELETE), so RLS is the entire barrier, which is why the policy
list above is the thing to check if this ever looks wrong. Verified live over the anon
key on 2026-08-02: INSERT rejected `42501` ("new row violates row-level security
policy"), PATCH matched zero rows and left `updated_at` null on all eleven.

**`0032` is a security fix, not a tidy-up.** `0031` shipped `tm_anon_read` as
`using (true)`, so a hidden member's name, role and photo stayed readable by anyone
holding the anon key. The `.eq('active', true)` in `DataStore.getPublicTeam` was a
client-side filter, not a boundary, which defeats the point of the hide toggle. Every
sibling content table already gated anon on visibility (`plant_species`, `plant_kits`
and `merch_items` on `active`; `events` on `is_public`). With the policy scoped to
`active`, a hidden row is therefore visible to the service role and invisible over the
anon key, which is how it was verified when `0032` went in.

**Never re-apply `0031` on its own.** It still contains the original
`create policy tm_anon_read ... using (true)` and drops the existing policy first, so
running that file by hand reverts `0032` silently: the seed no-ops on a non-empty table,
nothing errors, nothing looks different, and every hidden member is public again. `0031`
now carries a warning at the top and above the policy. If it ever is re-applied, apply
`0032` straight afterwards and confirm with
`select polname, pg_get_expr(polqual, polrelid) from pg_policy
where polrelid = 'public.team_members'::regclass;`

Seed: `0031` inserted the eleven members from the then-hardcoded `about.html` markup in
their existing order, `sort` 1 through 11, each `photo_path` a `static:` repo file, so
shipping the feature changed nothing a visitor sees. The insert is guarded by
`where not exists (select 1 from team_members)`, not `on conflict do nothing`: there is
no unique constraint for a conflict to fire on, so a re-apply would otherwise insert
eleven duplicates with fresh ids. **Consequence worth knowing: the guard keys on the
table being empty, so if every row is ever deleted, a re-apply reseeds all eleven as
active, republishing people who were deliberately taken off the page.**

Photo convention (rooted at `assets/img/team/`, resolved by `EcoTeam.teamPhotoSrc` in
`assets/team.js`, shared by the public page and the portal page so the two cannot drift):

- `static:<file>` -> a repo static asset served from `assets/img/team/<file>`. The
  filename is charset-guarded (`/^[A-Za-z0-9._-]+$/`, anchored) so a crafted value
  cannot escape the folder; anything that fails the guard resolves to no photo, which
  falls back to the initials tile. The charset permits `.`, so a value that is nothing
  but dots (`static:.`, `static:..`) is rejected separately: it passes the charset test
  and escapes nothing, but it names a directory rather than a file, and without the
  extra check it would render a broken image instead of the initials tile.
  All eleven seeded photos use this form (e.g.
  `static:team-jordan.jpg`). **`static:` files are never deleted from storage, because
  they are not in storage**; `removeTeamPhotoObject` returns early on them.
- any other value -> a `gallery` bucket object served via its public URL. Staff uploads
  on `manage-team.html` go through `DataStore.resizeImage(file, 1600)` (long edge scaled
  to 1600px, JPEG q0.85; a file already inside 1600px is uploaded unchanged, so the
  `.jpg` name does not by itself guarantee JPEG bytes) and land under
  `team/<uuid>.jpg`. The existing `gallery_staff_all` object policy covers these writes
  and the public bucket read serves them.

Storage cleanup, in the order it actually happens:

- Delete a member: the bucket object is removed first, best-effort, then the row.
  `DataStore.removeTeamMember` drops the row only, so doing it the other way round
  would orphan the object.
- Replace or clear a photo: the new file is uploaded first, then the row is written,
  and only then is the old object removed best-effort. If the row write fails, the
  freshly uploaded object is deleted so a failed save leaves no orphan.

No photo (null, or a `static:` value that fails the charset guard) renders a cream tile
with the member's initials: first letter of the first word plus first letter of the last
word, uppercased, one letter for a single-word name (so "Brendan" is `B`).
`EcoTeam.teamInitials` is covered by `tests/team.test.js` (`npm test`).

Public page (`about.html`): `renderTeam()` reads active rows over anon via
`DataStore.getPublicTeam` (ordered `sort` then `name`) and writes the cards into
`#teamGrid`, escaping every database value before it reaches `innerHTML`. A failed
fetch, or no rows, leaves the grid empty rather than throwing; the surrounding heading
and lead paragraph still render. **It calls `EcoSite.decorate()` after rendering, and
that call is load-bearing**: the cards carry `class="reveal"`, and `.reveal` is
`opacity: 0` in `assets/site.css` until `decorate()` adds `.in` through its
IntersectionObserver. Drop the call and the section renders invisible to everyone
except visitors with `prefers-reduced-motion: reduce`, for whom the stylesheet forces
`.reveal` back to `opacity: 1`. That is a nasty way to find the bug, so if the grid is
blank in a browser, check the console before touching the policies.

Staff page (`manage-team.html`): one compact list (photo thumb or initials placeholder,
name, Shown/Hidden pill, role, sort number) with up/down arrows, Edit, Hide/Show and
Delete per row. Delete is a hard delete and says so in the confirm, pointing at Hide as
the reversible option. The Add form pre-fills `sort` with `max(existing sort) + 1`, or 1
when the list is empty, so a new member lands at the end on their own number; the field
is editable and accepts any whole number from 0 to 2147483647, blank meaning 0. The
upper bound is the postgres `integer` maximum and is checked client-side so a long digit
string produces "Sort must be 2147483647 or less." rather than a raw `22003 integer out
of range` from the database. The page is in `robots.txt` under `Disallow`.

Two things about `sort` worth knowing before someone reports a bug:

- It has no unique constraint and defaults to 0, so two members can tie. Both listing
  queries break the tie on `name`, and the portal list flags tied rows with a "tied"
  chip so the order looks decided rather than random.
- The up/down arrows renumber the whole list 1..n instead of swapping the two rows'
  values, writing only the rows whose number actually changed. A swap would be a no-op
  between two rows that already tie.

Data helpers (`assets/data.js`): `getTeamMembers` (staff read, hidden rows included),
`getPublicTeam` (anon read, active only), both ordered `sort` then `name`;
`addTeamMember` / `updateTeamMember` / `removeTeamMember(id)`; plus `teamPhotoUrl` for
gallery-bucket paths. Note `removeTeamMember` takes only the id and does not touch
storage: the caller removes the object.

## iNaturalist species enrichment (2026-08-08)

Migration `0033_inat_species.sql` (applied; register it with
`supabase migration repair --status applied 0033` before any `supabase db push`) adds
eleven `inat_*` columns to `public.plant_species`. The `inat-sync` edge function fills
them from the public iNaturalist API.

### What it does, in two passes

One POST runs both passes in order and returns the counts from each.

1. **Resolution and enrichment.** Every species with `inat_taxon_id` null (and
   `inat_match` not `manual`, so a hand-set override is never re-guessed) is looked up by
   its normalised botanical name. A hit writes `inat_taxon_id`, `inat_match`
   (`exact`/`fuzzy`), `inat_matched_name`, plus Pennsylvania `inat_establishment` and
   `inat_conservation` from a second call. A name that cannot be resolved, or that is not
   a single resolvable binomial (`Pycnanthemum virginicum & muticum`), is written
   `inat_match = 'none'` with no API guess.
2. **Photo fill.** Every resolved species with `photo_path` null gets one licence-clean
   photograph copied into the `gallery` bucket under `plants/<uuid>.<ext>`, along with
   `inat_photo_id`, `inat_photo_license`, `inat_photo_attribution`,
   `inat_photo_source_url` and `inat_photo_status = 'auto'`. The usable set is exactly
   `cc0`, `pd`, `cc-by`, `cc-by-sa` (the `PHOTO_LICENCES` const); Ecotopia sells plants, so
   a NonCommercial licence is refused. A usable licence with no attribution string is
   refused on the same footing, because an image we cannot credit is not publishable
   either.

**Jordan's own photographs are never touched.** A row with `photo_path` set and
`inat_photo_id` null is his. The rule lives once, in `canAutoFill` / `isOwnPhoto` in
`supabase/functions/_shared/inat-logic.js`, and is enforced twice: in memory before the
work, and again as `.is('photo_path', null).is('inat_photo_id', null)` on the UPDATE
itself, so a staff upload landing mid-run cannot be clobbered. A refused UPDATE is counted
as `skippedRaced`, not as a fill.

### The ordering rule: credit before photos

**Writing `photo_path` publishes.** `plants.html` reads `plant_species` live over the anon
key, so there is no separate publish step: the row write is the publication, worldwide,
immediately. CC-BY and CC-BY-SA both require the credit to be shown, so **the credit line
on `plants.html` must be deployed and confirmed on the live page before the photo pass is
allowed to run at all**, whether by cron or by hand. This is not theoretical: an early run
put 33 uncredited CC photos on the live shop and they had to be rolled back the same day.

### Manual invocation

```
curl -s -X POST "https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/inat-sync" \
  -H "Content-Type: application/json" -H "X-Scan-Token: $INAT_SYNC_TOKEN" \
  -d '{"action":"sync"}'
```

Staff can also run it from `manage-plants.html` ("Sync now"), which authenticates with the
caller's own JWT instead of the token. Auth is either the `X-Scan-Token` header matching
the `INAT_SYNC_TOKEN` function secret, or a valid staff JWT backed by an active
`portal_users` row; anything else is a 401. The token is a shared secret, not a user
identity, so the header path bypasses the portal entirely: treat it accordingly.

`INAT_SYNC_TOKEN` (function secret) holds the live value. It is already set on this
project. Rotate with:

```
supabase secrets set --project-ref wibnryfinfwbwwgsyojr INAT_SYNC_TOKEN=<random hex>
```

and re-run the cron schedule with the same new value (below); the two must stay in sync,
exactly like `GRANT_SCAN_TOKEN`. Deploy:

```
supabase functions deploy inat-sync --no-verify-jwt --project-ref wibnryfinfwbwwgsyojr
```

`supabase/config.toml` pins `[functions.inat-sync] verify_jwt = false` so a redeploy keeps
the token path working.

Rate limiting is a whole-run condition, not a per-row one: a 429 from iNaturalist stops the
run and comes back as a `429` carrying the partial counts, so a truncated run can never be
mistaken for a quiet successful one. The run is resumable by design (each row is its own
committed UPDATE, selection is driven by `inat_taxon_id is null`), so the fix for a stopped
run is to run it again later.

### Nightly cron: written, NOT scheduled

`supabase/migrations/0034_inat_sync_cron.sql` schedules `inat-sync-nightly` at `0 10 * * *`
(10:00 UTC, an hour after `grant-scan-nightly`) via `pg_cron` + `pg_net`, on the same
`X-Scan-Token` pattern the grant scan uses, with the token embedded in the cron command.
**It has not been applied**, and must not be until the credit line above is live. The file
carries the full precondition, the token placeholder to substitute, and two constraints
worth reading first: the run has no batch limit (linear in the backlog, so a much larger
catalogue would outlast the edge function's wall clock), and `net.http_post` is
asynchronous, so `cron.job_run_details` reports success even when the call 401s or times
out. Read `net._http_response` and the function logs instead.

### Tests

`tests/inat.test.js` covers the pure logic in `_shared/inat-logic.js` (name normalisation,
taxon and photo picking, the licence allowlist, `isOwnPhoto` / `canAutoFill`) and runs
under `npm test`.

`tests/deno/inat-sync.test.ts` covers the write path itself, with `fetch` and the Supabase
client stubbed so nothing leaves the machine. **`npm test` does not run it**: that script
is `node --test tests/*.js`, whose glob neither matches nor understands this file. Run it
separately:

```
deno test -A --config tests/deno/deno.json tests/deno/
```

Both suites are expected green (55 under Node, 11 under Deno as of 2026-08-08). Run both
before touching the sync.

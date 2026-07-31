# Ecotopia Portal - Operations

Operational notes for the Ecotopia Earthcare admin portal. Keep this file current;
it is committed so it survives across machines and sessions.

## Supabase project

- Project ref: `wibnryfinfwbwwgsyojr`
- URL: `https://wibnryfinfwbwwgsyojr.supabase.co`
- The anon key in `assets/config.js` is public-safe by design; all protection comes
  from Row Level Security (RLS). Never commit any other key.

## Migrations

Migrations `0001`-`0027` (every migration in `supabase/migrations/`) were applied to the
live database directly via the Supabase Management API
(`POST https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query`),
NOT via `supabase db push`. Because of that the CLI does not know any of them ran: the
`supabase_migrations.schema_migrations` table does not exist on this project at all
(checked 2026-07-31, `relation ... does not exist`, not merely empty). The first
`migration repair` creates it.

Before ever running `supabase db push` against this project, first register the
already-applied migrations so the CLI does not try to re-run them:

```
for n in $(seq -w 1 27); do supabase migration repair --status applied 00$n; done
```

(equivalently, one `supabase migration repair --status applied <NNNN>` per file, `0001`
through `0027`). Keep this range current: every new migration in this project is applied
by hand through the Management API, so every new migration extends it.

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
  **The deposit carries the card uplift** (`index.ts:242`): `quotes.deposit` is the BASE
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
  Note that a payment on the old link would also **not** flip `deposit_status`: the webhook
  matches on `square_order_id`, which now holds the new order.

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
Both the tray and the kit modal print two prices, "$5.20 card · $5.00 cash or check" and
the kit equivalent, never a single figure: see "Cash-discount pricing". `PLANT_PRICE` (5,
the BASE dollar price) and the kit pricing table (`KIT_TIERS`, also base) stay hardcoded
(universal); the card price is always derived from them. The card
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
- `merch_items.price_cents` (nullable integer): the **payable** price. `price_text` stays
  display-only. A merch item with `price_cents = null` is **request-only** (it uses the old
  ask/pre-order form and cannot be ordered online); setting `price_cents` makes it orderable.
- `public.orders` (Supabase-owned). Columns: `order_token` (unique, 64 hex; the public
  status/pay page key), `customer_name`, `phone`, `email`, `items` (jsonb array of
  `{kind:'species'|'kit'|'merch', id, name, qty, unit_cents, tier?}`), `subtotal_cents`,
  `status`, `pay_mode` (`pickup`/`online`), `square_order_id`, `square_pay_url`, `note`,
  plus `charge_cents`, `tender` and `amount_collected_cents` from migration `0027` (see
  "Cash-discount pricing"). **No anon RLS policy** at all: a single `o_staff_all` policy
  for authenticated portal users; anon reaches orders only through the security-definer
  edge function. Carries the shared `set_updated_at` trigger.
- `decrement_stock(p_kind, p_id, p_qty)` (security definer): draws down a tracked row's
  stock, floored at 0, leaving untracked (`null`) rows alone. **Execute is revoked from
  `public`/`anon`/`authenticated` and granted only to `service_role`** - it is called ONLY
  by the `square-pay` edge function.

**Order lifecycle:** `new` -> `link_created` (online, a Square link was minted) -> `paid`
-> `ready` -> `completed`, or `cancelled`. Stock is drawn down exactly once, on the first
transition into `paid` (idempotent: re-marking paid never double-decrements).

**Pricing authority (single source):** `PLANT_PRICE_CENTS` (500) and `KIT_TIERS`
(`50`->7200, `100`->14400, `150`->20000, `200`->25000 cents) live in the `square-pay`
edge function. Client-sent prices are always ignored; the server re-prices every line from
the live catalog. `merch` lines are priced from `price_cents` (request-only items rejected).

The `square-pay` edge function gained three public/staff actions plus a webhook branch (one
endpoint, told apart by the `x-square-hmacsha256-signature` header then `body.action`):

- **`create_order`** (PUBLIC, anon) - `{action, customer:{name, phone?, email?}, items:
  [{kind,id,qty,tier?}], pay_mode, note?}`. Validates server-side: name required; 1-40
  lines; qty 1-20 (kits forced 1-5, tier required and in `KIT_TIERS`); each row loaded from
  the live catalog and must be `active`; merch must have `price_cents` (else `400
  not_payable`). Any tracked item with `stock_qty < qty` -> `409 {error:'insufficient_stock',
  item}`. Recomputes `subtotal_cents` server-side and inserts the order (`order_token` = 64
  hex) with `charge_cents` = `subtotal_cents` for `pickup` and **`cardCents(subtotal_cents)`
  for `online`**. `pay_mode:'online'` + Square configured mints a `quick_pay` Payment Link
  (`Order <first 8 of id> - Ecotopian EarthCare`, **amount `charge_cents`, NOT
  `subtotal_cents`** (`index.ts:394`) so Square is asked for the card price, idempotency
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
  Square is dark. Sold-out species/kits (`stock_qty === 0`) show a chip and a disabled button.
- Public `shop.html`: payable merch (`price_cents` set) uses an "Order this" modal that
  creates an order; request-only merch keeps the ask/pre-order form; sold-out items are
  disabled. Branch flag: `isPayable = priceCents != null`.
- Public `order.html?t=<token>` (marketing-branded, `noindex`, NO auth): reads
  `order_status`, renders items, total, a Received -> Paid/Pay-at-pickup -> Ready -> Completed
  timeline, a Square Pay button when a link exists and the order is unpaid, else a
  pay-at-pickup note. Poll-free (refresh to update). Every value is `esc()`'d.
- Portal `orders.html` (the "Orders" nav link after Jobs): newest-first list with status
  filters, status pills, items + total, customer contact, note, and actions - **Paid cash**
  / **Paid check** / **Paid card** (three buttons, each calling `staff_mark_paid` with its
  own `tender`; they decrement stock), **Mark ready**, **Mark completed**, **Cancel**
  (plain staff status updates via `DataStore.updateOrder`), and **Copy order link**. A row
  with a recorded `amount_collected_cents` shows "Collected: $X <tender>" in place of the
  total; every other row shows the base total.
  `dashboard.html` "Needs attention" surfaces "N new order(s)" (`new`/`link_created`).
- Staff editors: `manage-plants.html` species + kit modals gain a "Stock (blank = untracked)"
  input; `manage-shop.html` gains "Stock" and "Price (USD, for online payment)" (stored as
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
  "Collected: ..." on `amountCollectedCents != null` (`orders.html:203`), NOT on status, so
  a settled order whose payment event carried no usable amount (`index.ts:158` writes null)
  keeps showing the base total.
- **`orders.tender`** is null until the order settles (no default), then records how it was
  paid.
- **`orders.amount_collected_cents`** is the amount recorded as collected, and the two paths
  mean slightly different things by it. On the card/webhook path it is **observed**: what
  Square reported taking, or null when the event carried no usable amount. On the
  `staff_mark_paid` path it is **derived** (`index.ts:481`): what the tender says the
  customer owed, not what anyone counted. So it confirms a Square settlement, but on a
  pickup it only records what we asked for.
- **`quotes.total` is the CASH total** (base subtotal + the 5 percent administration fee,
  which is itself computed on the base subtotal). The builder writes it as
  `total: totals.cashTotal` (`quotes.html:490` and `:499`). Unchanged in meaning, so again
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

`orders.html` raises an "Amount mismatch" chip when the note starts with that prefix and
the order is `paid`, `ready` or `completed`. It stays visible past `paid` because staff
advance a flagged order through `ready` and `completed`, and those are precisely the
moments someone is about to hand over goods that may not have been paid for. Customers
cannot write any of those three statuses themselves (no anon policy on `orders`, and the
public `create_order` action only ever writes `new` or `link_created`), though paying does
settle the order through the webhook, which is the hole the next paragraph is about.

**The chip is NOT forgery-proof. Treat it as "read the note", not as proof we were
short-changed.** `orders.note` is customer free text off the public order form
(`index.ts:284`, stored verbatim at `:368`), the webhook rewrites it only when there IS a
mismatch, and `staff_mark_paid` never touches it. So a customer who types
`AMOUNT MISMATCH: ...` into their own note and then pays the correct amount ends up at
`status = 'paid'` with that text intact, and the chip fires on a clean order. **No operator
action is needed anywhere in that sequence**: on the online path the customer pays their own
Square link and the webhook sets `paid` itself (`index.ts:159-174`), so the chip is already
showing the first time staff open the page. It is customer-triggerable end to end. The
status gate buys exactly one thing, and it is worth keeping: they cannot raise it on their
own row while it is still unpaid, only once the order settles. Closing the hole properly
means flagging on `amountCollectedCents !== chargeCents` rather than trusting note text,
which would also survive an operator editing the note. That is not built.

The gate deliberately excludes `cancelled`, so a flagged order that is cancelled loses its
chip at exactly the moment someone is deciding whether to refund. The `AMOUNT MISMATCH`
text is still in the note, which is rendered on the card, so the signal is not lost, only
demoted.

### Customer-facing copy

**Never state a discount or surcharge percentage to a customer.** Show the two prices
instead. Adding 4 percent and then taking 4 percent back off does not return to the base
price (the true round trip off the grossed price is 3.846 percent), so any single stated
percentage would be wrong about one of the two figures. Every surface therefore prints the
pair:

- `plants.html`: "$5.20 card · $5.00 cash or check" on the plant tray, and the same pair
  in the kit modal directly above the tender choice (it updates with the size dropdown and
  is `aria-live="polite"`).
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
zero for every current price** ($5 plants, $72/$144/$200/$250 kits, the $40 card game, all
whole dollars), so nothing is wrong today.

`order.html` prints a grossed column anyway, and settles the residual **on the last line**
so the column always adds up to the figure beneath it. It does that only when the lines sum
to `subtotal_cents`, which is the precondition for the charge having been computed from
them; if they do not, the lines are printed grossed and left un-reconciled rather than
having a fictional residual forced onto one of them. **What is charged never moves**: the
residual is a presentation adjustment inside a total that is still `charge_cents` (or, on a
settled order, `amount_collected_cents`) exactly as stored.

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

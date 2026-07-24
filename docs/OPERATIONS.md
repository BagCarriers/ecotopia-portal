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

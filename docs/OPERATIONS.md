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

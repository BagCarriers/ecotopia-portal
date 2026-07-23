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

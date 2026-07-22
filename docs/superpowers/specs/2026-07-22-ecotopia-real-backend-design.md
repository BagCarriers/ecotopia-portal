# Ecotopia Portal: Real Backend (Supabase) Design

**Date:** 2026-07-22
**Status:** Approved by Frank (Approach B: async refactor, keep static HTML)

## Goal

Move the Ecotopia Earthcare portal off localStorage demo data and hardcoded
client-side credentials onto a real Supabase backend with real authentication,
so Ecotopia can use it in production. The existing static HTML/CSS pages are
kept; the data and auth layers are rewritten as properly async.

## Non-goals

- No framework rebuild (Next.js/React rejected for now; the Supabase schema
  and RLS carry over unchanged if a port ever happens).
- No volunteer/client logins. Only staff log in.
- No data import; production starts empty.

## Architecture

Static HTML site (17 pages) deployed on Netlify, talking directly to Supabase
via `supabase-js` (vendored into `assets/`, not CDN-loaded at runtime if
practical; otherwise pinned CDN). Two rewritten core modules:

- **`assets/data.js` (DataStore)** becomes an async Supabase client wrapper.
  Same method surface as today (per-entity get/list/create/update/delete),
  but every method returns a Promise. No sync cache layer.
- **`assets/auth.js` (AuthManager)** is replaced with Supabase Auth
  (email/password). `requireAuth()` checks the live session and redirects to
  `login.html`. Sign-out calls `supabase.auth.signOut()`.

Every page's init/render code is wrapped in an async bootstrap: show a
lightweight loading state, `await` the data the page needs, render, and show
an error banner if a fetch fails.

The current pre-backend state of the repo is tagged `demo-mvp` before any
changes so the working localStorage demo remains one checkout away.

## Database

New dedicated Supabase project for Ecotopia (separate from all other client
projects; ~$10/mo, log for Forrest per-client P&L).

Thirteen entity tables mirroring the existing demo shapes in `data.js`:
`gardens`, `clients`, `jobs`, `volunteers`, `tasks`, `walkins`, `checkins`,
`events`, `invoices`, `grants`, `observations`, `intake_submissions`,
`volunteer_applications`. Exact column definitions are derived from the demo
seed shapes during planning (snake_case columns, `id uuid default
gen_random_uuid()`, `created_at timestamptz default now()`).

Plus two auth-support tables (Star Bev portal pattern):

- `portal_users` — `user_id uuid` (references `auth.users`), `email`,
  `role text check (role in ('admin','user'))`, `active bool`.
- `portal_invites` — `email`, `role`, `token`, `expires_at`, `used_at`.

Production starts empty. The current demo data moves to a dev-only seed
(usable locally; never applied to prod).

## Auth and user management

- Jordan gets the first account (created during setup).
- Invite flow: an **admin** creates an invite (row in `portal_invites`);
  invitee opens the invite link, sets a password, and a `portal_users` row is
  created with the invited role. Implemented the same way as the Star Bev
  admin portal signup.
- Roles: `admin` = all data + Users management surface (invite, deactivate,
  change role). `user` = all data, no user management.
- Session: Supabase Auth default session handling (persistent, auto-refresh).
  The old 8-hour hand-rolled expiry is dropped.

## Row-level security

- All thirteen entity tables: full CRUD for authenticated users who have an
  active `portal_users` row. (Authenticated-but-not-a-portal-user gets
  nothing; being in `auth.users` alone is not enough.)
- `portal_users` / `portal_invites`: readable by active portal users; writes
  admin-only (enforced in RLS, not just UI).
- Anon (public pages):
  - `intake_submissions`: INSERT only.
  - `volunteer_applications`: INSERT only.
  - `checkins`: INSERT only (QR check-in kiosk).
  - QR check-in and volunteer board read-only needs: scoped SELECT policies
    exposing only the minimal columns/rows those pages display (exact scope
    determined from the pages during planning — likely volunteer names for
    check-in matching and open tasks for the board).
- Nothing else is readable or writable with the anon key.

## Public pages (no login)

`login.html`, `intake.html`, `qr-checkin.html`, `volunteer-board.html`.
They load supabase-js with the anon key and use the policies above. Failed
public-form submissions show a retry message; nothing is silently dropped.

## Error handling

- Failed writes from admin pages keep the modal open with an inline error so
  entered data is not lost.
- Fetch failures on page load show an error banner with a retry.
- Expired/invalid sessions redirect to `login.html`.

## Testing and verification

- Manual per-page checklist: each admin page loads, lists, creates, edits,
  and deletes against the real DB.
- RLS verification: with only the anon key, confirm admin tables are neither
  readable nor writable, and public inserts work.
- Auth verification: unauthenticated access to admin pages redirects; a
  deactivated portal user loses data access.
- Public flows E2E: intake submit, volunteer application, QR check-in.

## Deployment and ops

- Netlify manual deploy (`netlify deploy --prod`) to
  `ecotopia.bagcarriers.dev`.
- Supabase MCP in this environment points at the wrong project (known
  gotcha): migrations for the new project go through the Supabase CLI or the
  browser SQL editor. Frank may need to create the project / provide access
  at that step.
- Supabase URL + anon key are public-safe and shipped in the static JS;
  service-role key is never shipped (invite acceptance uses a Supabase Edge
  Function if password-set-from-invite requires it, mirroring Star Bev).

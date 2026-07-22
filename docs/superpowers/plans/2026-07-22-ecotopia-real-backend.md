# Ecotopia Real Backend (Supabase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Ecotopia Earthcare portal off localStorage demo data onto a real Supabase backend with real Supabase Auth, keeping the existing static HTML pages (Approach B: honest async refactor).

**Architecture:** Static HTML on Netlify talks directly to Supabase via a vendored `supabase-js` UMD build. `assets/data.js` is rewritten as an async `DataStore` (same method names, now returning Promises); `assets/auth.js` is rewritten on Supabase Auth. Every page gets an async bootstrap that awaits its data then renders. RLS enforces access: authenticated portal users get full CRUD; the anon key gets narrowly scoped insert/select for the 4 public pages.

**Tech Stack:** Vanilla JS static site, supabase-js v2 (vendored UMD), Supabase (Postgres + Auth + one Edge Function), Netlify manual deploy, `node --test` for unit-testable pieces.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-ecotopia-real-backend-design.md`. Read it before starting.
- DB columns are `snake_case`; page-facing JS objects stay `camelCase`. All translation happens in one place (`assets/mapping.js`), top-level keys only — jsonb values pass through untouched.
- The anon key ships in the client and is the ONLY key that ever appears in this repo. The service-role key exists only as a Supabase Edge Function env var. Never commit it, never log it.
- Production starts EMPTY. `supabase/seed-dev.sql` is dev-only; never run it against prod after go-live verification is done (test rows it creates must be deleted, see Task 10).
- No em dashes in any user-facing copy (Frank's standing rule).
- The `demo-mvp` git tag preserves the localStorage demo; never delete it.
- Supabase MCP in this environment points at the WRONG project (Cope's DB). All DB work goes through the Supabase CLI (`supabase link` + `supabase db push`) or the browser SQL editor. Never `mcp__supabase__*` for this project.
- Commit after every task (messages given per task). Do not push until Frank says to.
- Every DataStore data method is async and throws `Error` on failure. Callers (pages) catch and show errors; nothing fails silently.

---

## File Structure

```
assets/
  supabase.js          CREATE  vendored @supabase/supabase-js v2 UMD build (pinned)
  config.js            CREATE  window.ECO_CONFIG = { SUPABASE_URL, SUPABASE_ANON_KEY }
  supabase-client.js   CREATE  window.ecoSupabase = supabase.createClient(...)
  mapping.js           CREATE  EcoMapping.toDb/fromDb/fromDbAll (browser + Node loadable)
  auth.js              REWRITE Supabase Auth (async), hasCachedSession sync guard
  data.js              REWRITE async Supabase DataStore, same method surface
  nav.js               MODIFY  admin-only Users link
*.html (17 pages)      MODIFY  script-tag block + async bootstrap
users.html             CREATE  admin user management (invite / role / deactivate)
accept-invite.html     CREATE  public invite-acceptance page (set password)
supabase/
  migrations/0001_init.sql  CREATE  schema + RLS + views + RPCs
  seed-dev.sql              CREATE  dev-only sample rows
  functions/accept-invite/index.ts  CREATE  service-role invite acceptance
scripts/verify-rls.mjs      CREATE  anon-key RLS verification (plain fetch, no deps)
tests/mapping.test.js       CREATE  node --test unit tests for mapping
package.json                CREATE  private, test script only
.gitignore                  CREATE  node_modules, .netlify, .env*
```

Script-tag load order used by ALL pages that touch data or auth (referenced by later tasks as "the standard script block"):

```html
<script src="assets/supabase.js"></script>
<script src="assets/config.js"></script>
<script src="assets/supabase-client.js"></script>
<script src="assets/mapping.js"></script>
<script src="assets/auth.js"></script>
```

(`assets/data.js` and `assets/nav.js` stay where each page already includes them, AFTER the block above.)

---

### Task 1: Foundations — vendored SDK, client bootstrap, mapping layer + tests

**Files:**
- Create: `assets/supabase.js`, `assets/config.js`, `assets/supabase-client.js`, `assets/mapping.js`
- Create: `tests/mapping.test.js`, `package.json`, `.gitignore`

**Interfaces:**
- Produces: `window.supabase` (vendored SDK), `window.ECO_CONFIG`, `window.ecoSupabase` (shared client), `globalThis.EcoMapping = { toDb(obj), fromDb(row), fromDbAll(rows) }`.

- [ ] **Step 1: Write the failing mapping tests**

`package.json`:

```json
{
  "name": "ecotopia-portal",
  "private": true,
  "scripts": { "test": "node --test tests/" }
}
```

`.gitignore`:

```
node_modules/
.netlify/
.env
.env.*
```

`tests/mapping.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
require('../assets/mapping.js');
const { toDb, fromDb, fromDbAll } = globalThis.EcoMapping;

test('toDb converts camelCase top-level keys to snake_case', () => {
  assert.deepStrictEqual(
    toDb({ gardenId: 'g1', estMinutes: 30, sqft: 100, qrToken: 'x' }),
    { garden_id: 'g1', est_minutes: 30, sqft: 100, qr_token: 'x' }
  );
});

test('fromDb converts snake_case top-level keys to camelCase', () => {
  assert.deepStrictEqual(
    fromDb({ garden_id: 'g1', next_due: 'T', created_at: 'C', name: 'n' }),
    { gardenId: 'g1', nextDue: 'T', createdAt: 'C', name: 'n' }
  );
});

test('jsonb values pass through untouched (no deep key mapping)', () => {
  const row = fromDb({ activity_log: [{ ts: 'T1', note: 'hi' }], skills: ['planting'] });
  assert.deepStrictEqual(row.activityLog, [{ ts: 'T1', note: 'hi' }]);
  assert.deepStrictEqual(row.skills, ['planting']);
});

test('fromDbAll maps arrays and tolerates null', () => {
  assert.deepStrictEqual(fromDbAll(null), []);
  assert.deepStrictEqual(fromDbAll([{ a_b: 1 }]), [{ aB: 1 }]);
});

test('toDb passes null/undefined/non-objects through', () => {
  assert.strictEqual(toDb(null), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/GitHub/ecotopia-portal && npm test`
Expected: FAIL (cannot find `../assets/mapping.js`)

- [ ] **Step 3: Implement `assets/mapping.js`**

```js
/**
 * Ecotopia Portal — key mapping between DB rows (snake_case) and page objects (camelCase).
 * Top-level keys only; values (including jsonb arrays/objects) pass through untouched.
 * Loadable in the browser (script tag) and in Node (require) for tests.
 */
(function (root) {
  const snakeKey = (k) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  const camelKey = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

  function mapKeys(obj, fn) {
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[fn(k)] = v;
    return out;
  }

  root.EcoMapping = {
    toDb: (obj) => mapKeys(obj, snakeKey),
    fromDb: (row) => mapKeys(row, camelKey),
    fromDbAll: (rows) => (rows || []).map((r) => mapKeys(r, camelKey)),
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: 5 passing

- [ ] **Step 5: Vendor supabase-js and create client bootstrap**

```bash
cd ~/GitHub/ecotopia-portal
curl -fsSL https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js -o assets/supabase.js
head -c 300 assets/supabase.js   # sanity: should be minified JS, not an error page
```

Prepend a comment line to `assets/supabase.js` recording the pinned version (check it with `curl -sI https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2 | grep -i location` or read the version banner inside the file):

```js
/* @supabase/supabase-js v2.x.y — vendored 2026-07-22 from jsDelivr. Do not edit. */
```

`assets/config.js` (real values filled in by Task 2 after project creation):

```js
/**
 * Ecotopia Portal — Supabase config. The anon key is public-safe by design;
 * all protection comes from RLS. Never put any other key in this repo.
 */
window.ECO_CONFIG = {
  SUPABASE_URL: 'FILLED_IN_BY_TASK_2',
  SUPABASE_ANON_KEY: 'FILLED_IN_BY_TASK_2',
};
```

`assets/supabase-client.js`:

```js
/** Shared Supabase client. Load AFTER supabase.js and config.js. */
window.ecoSupabase = window.supabase.createClient(
  window.ECO_CONFIG.SUPABASE_URL,
  window.ECO_CONFIG.SUPABASE_ANON_KEY
);
```

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore tests/ assets/mapping.js assets/supabase.js assets/config.js assets/supabase-client.js
git commit -m "feat: vendored supabase-js, shared client bootstrap, key-mapping layer with tests"
```

---

### Task 2: Supabase project, schema migration, RLS, dev seed  ⚠️ NEEDS FRANK / CREDENTIALS

**Files:**
- Create: `supabase/migrations/0001_init.sql`, `supabase/seed-dev.sql`, `supabase/config.toml` (via CLI init)
- Modify: `assets/config.js` (real URL + anon key)

**Interfaces:**
- Produces: live Supabase project with all tables, `volunteers_public` view, RPCs `match_volunteer_by_phone(p_phone text)`, `complete_task(p_task_id uuid)`, helpers `is_portal_user()`, `is_portal_admin()`.

**Checkpoint:** creating the project needs Frank's Supabase org (dashboard) or an access token (`SUPABASE_ACCESS_TOKEN` / `supabase login`). A `sbp_` token exists in the Reader Electric repo's `settings.local.json`; if it is org-scoped it can create/link this project too. Stop and ask Frank if no working token is available. Record the new project ref, URL, anon key. Note the ~$10/mo cost for Forrest's per-client P&L.

- [ ] **Step 1: Create project + link CLI**

```bash
cd ~/GitHub/ecotopia-portal
supabase init            # creates supabase/config.toml
supabase projects create ecotopia-portal --org-id <FRANKS_ORG_ID> --db-password "$(openssl rand -base64 24)" --region us-east-1
supabase link --project-ref <NEW_PROJECT_REF>
```

(If CLI project creation is blocked, Frank creates it in the dashboard and we only `supabase link`.)

- [ ] **Step 2: Write the migration**

`supabase/migrations/0001_init.sql` — complete content:

```sql
-- Ecotopia Portal initial schema. All tables RLS-on.
-- Staff access = active row in portal_users. Anon access = narrow policies for public pages.

create extension if not exists pgcrypto;

-- ── updated_at trigger ─────────────────────────────────────────────────────
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── auth support ───────────────────────────────────────────────────────────
create table public.portal_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  role       text not null check (role in ('admin','user')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table public.portal_invites (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  role       text not null check (role in ('admin','user')),
  token      text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- security definer so these can read portal_users regardless of RLS (no recursion)
create or replace function public.is_portal_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from portal_users where user_id = auth.uid() and active);
$$;

create or replace function public.is_portal_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from portal_users where user_id = auth.uid() and active and role = 'admin');
$$;

-- ── entity tables ──────────────────────────────────────────────────────────
create table public.gardens (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  address    text,
  sqft       integer,
  qr_token   text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  address    text,
  email      text,
  phone      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table public.jobs (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid references public.clients(id) on delete set null,
  client_name  text,
  title        text not null,
  address      text,
  type         text,
  status       text not null default 'inquiry',
  sqft         text,
  price        numeric,
  grant_funded boolean not null default false,
  grant_name   text,
  grant_amount numeric,
  notes        text,
  activity_log jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);

create table public.volunteers (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  phone        text,
  email        text,
  skills       jsonb not null default '[]'::jsonb,
  availability text,
  status       text not null default 'active',
  joined_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);

create table public.tasks (
  id             uuid primary key default gen_random_uuid(),
  garden_id      uuid references public.gardens(id) on delete cascade,
  title          text not null,
  cadence_days   integer,
  est_minutes    integer,
  owner          text not null default 'open' check (owner in ('volunteer','jordan','open')),
  volunteer_id   uuid references public.volunteers(id) on delete set null,
  volunteer_name text,
  skill_level    text,
  active         boolean not null default true,
  last_completed timestamptz,
  next_due       timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz
);

create table public.walkins (
  id          uuid primary key default gen_random_uuid(),
  garden_id   uuid references public.gardens(id) on delete cascade,
  title       text not null,
  est_minutes integer,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

create table public.checkins (
  id             uuid primary key default gen_random_uuid(),
  garden_id      uuid references public.gardens(id) on delete set null,
  garden_name    text,
  volunteer_id   uuid references public.volunteers(id) on delete set null,
  volunteer_name text,
  task_id        uuid references public.tasks(id) on delete set null,
  task_title     text,
  hours_logged   numeric,
  check_in_time  timestamptz,
  check_out_time timestamptz,
  type           text check (type in ('scheduled','walkin')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz
);

create table public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  date        date,
  garden_id   uuid references public.gardens(id) on delete set null,
  garden_name text,
  description text,
  type        text,
  open_signup boolean not null default false,
  signups     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

create table public.invoices (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references public.clients(id) on delete set null,
  client_name text,
  job_id      uuid references public.jobs(id) on delete set null,
  job_title   text,
  amount      numeric,
  status      text not null default 'draft',
  due_date    date,
  issued_date date,
  paid_date   date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

create table public.grants (
  id            uuid primary key default gen_random_uuid(),
  funder        text,
  program       text,
  job_id        uuid references public.jobs(id) on delete set null,
  job_title     text,
  amount        numeric,
  status        text not null default 'prospect',
  notes         text,
  deadline      date,
  applied_date  date,
  approved_date date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

create table public.observations (
  id           uuid primary key default gen_random_uuid(),
  garden_id    uuid references public.gardens(id) on delete cascade,
  garden_name  text,
  submitted_by text,
  note         text,
  flagged      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);

create table public.intake_submissions (
  id                 uuid primary key default gen_random_uuid(),
  name               text,
  phone              text,
  email              text,
  address            text,
  service_type       text,
  size               text,
  description        text,
  contact_preference text,
  referral           text,
  submitted_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);

create table public.volunteer_applications (
  id                 uuid primary key default gen_random_uuid(),
  task_id            uuid references public.tasks(id) on delete set null,
  garden_id          uuid references public.gardens(id) on delete set null,
  garden_name        text,
  task_title         text,
  name               text,
  phone              text,
  email              text,
  preferred_schedule text,
  submitted_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);

-- updated_at triggers on every table
do $$
declare t text;
begin
  foreach t in array array['portal_users','portal_invites','gardens','clients','jobs','volunteers',
    'tasks','walkins','checkins','events','invoices','grants','observations',
    'intake_submissions','volunteer_applications']
  loop
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS ────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['portal_users','portal_invites','gardens','clients','jobs','volunteers',
    'tasks','walkins','checkins','events','invoices','grants','observations',
    'intake_submissions','volunteer_applications']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- staff: full CRUD on every entity table
do $$
declare t text;
begin
  foreach t in array array['gardens','clients','jobs','volunteers','tasks','walkins','checkins',
    'events','invoices','grants','observations','intake_submissions','volunteer_applications']
  loop
    execute format('create policy staff_all on public.%I for all to authenticated
                    using (public.is_portal_user()) with check (public.is_portal_user())', t);
  end loop;
end $$;

-- portal_users / portal_invites: read for staff, writes admin-only
create policy pu_read  on public.portal_users   for select to authenticated using (public.is_portal_user());
create policy pu_ins   on public.portal_users   for insert to authenticated with check (public.is_portal_admin());
create policy pu_upd   on public.portal_users   for update to authenticated using (public.is_portal_admin()) with check (public.is_portal_admin());
create policy pu_del   on public.portal_users   for delete to authenticated using (public.is_portal_admin());
create policy pi_read  on public.portal_invites for select to authenticated using (public.is_portal_user());
create policy pi_ins   on public.portal_invites for insert to authenticated with check (public.is_portal_admin());
create policy pi_upd   on public.portal_invites for update to authenticated using (public.is_portal_admin()) with check (public.is_portal_admin());
create policy pi_del   on public.portal_invites for delete to authenticated using (public.is_portal_admin());

-- anon: exactly what the 4 public pages need, nothing more.
-- Gardens/tasks/walkins hold no sensitive data (qr_token is share-a-link security
-- by design; the kiosk is honor-system). Volunteers hold PII, so anon gets a
-- name-only view + a phone-match RPC instead of the table.
create policy anon_read_gardens  on public.gardens  for select to anon using (true);
create policy anon_read_tasks    on public.tasks    for select to anon using (active);
create policy anon_read_walkins  on public.walkins  for select to anon using (active);
create policy anon_ins_checkins  on public.checkins for insert to anon with check (true);
create policy anon_ins_intake    on public.intake_submissions     for insert to anon with check (true);
create policy anon_ins_vol_apps  on public.volunteer_applications for insert to anon with check (true);
create policy anon_ins_inquiry   on public.jobs for insert to anon with check (status = 'inquiry');

-- name-only volunteer view for the kiosk (security definer view: owner bypasses RLS;
-- intentional, exposes only id+name of active volunteers)
create view public.volunteers_public as
  select id, name from public.volunteers where status = 'active';
grant select on public.volunteers_public to anon, authenticated;

-- ── RPCs for the kiosk ─────────────────────────────────────────────────────
create or replace function public.match_volunteer_by_phone(p_phone text)
returns table (id uuid, name text)
language sql stable security definer set search_path = public as $$
  select v.id, v.name from volunteers v
  where v.status = 'active'
    and regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> ''
    and regexp_replace(coalesce(v.phone, ''), '\D', '', 'g')
      = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
$$;

create or replace function public.complete_task(p_task_id uuid)
returns void
language sql security definer set search_path = public as $$
  update tasks
     set last_completed = now(),
         next_due = now() + (coalesce(cadence_days, 0) || ' days')::interval,
         updated_at = now()
   where id = p_task_id and active;
$$;

grant execute on function public.match_volunteer_by_phone(text) to anon, authenticated;
grant execute on function public.complete_task(uuid) to anon, authenticated;
```

- [ ] **Step 3: Apply the migration**

Run: `supabase db push`
Expected: `0001_init.sql` applied, no errors. (Fallback: paste the file into the browser SQL editor and run, then `supabase migration repair` or just keep the file as the source of record.)

- [ ] **Step 4: Fill real values into `assets/config.js`**

Get URL + anon key: `supabase projects api-keys --project-ref <REF>` (or dashboard Settings → API). Replace both `FILLED_IN_BY_TASK_2` values.

- [ ] **Step 5: Write the dev seed (never for prod)**

`supabase/seed-dev.sql` — complete content:

```sql
-- DEV ONLY. A representative slice of the old localStorage demo data.
-- Never run against the production project once real data exists.
insert into gardens (id, name, address, sqft, qr_token) values
  ('11111111-1111-1111-1111-111111111101', 'Millbrook Community Garden', '847 Oak St, Altoona PA', 1200, 'mcg-millbrook'),
  ('11111111-1111-1111-1111-111111111102', 'Juniata Valley Meadow Restoration', 'Rt 22, Huntingdon PA', 3400, 'jvmr-juniata');

insert into volunteers (id, name, phone, email, skills, availability, status, joined_at) values
  ('22222222-2222-2222-2222-222222222201', 'Sarah Mitchell', '(814) 555-0201', 'sarah.m@email.com', '["planting","watering"]', 'Available weekends', 'active', '2025-06-01'),
  ('22222222-2222-2222-2222-222222222202', 'Bob Kowalski', '(814) 555-0212', 'bob.k@email.com', '["pruning","heavy_labor"]', 'Saturdays only', 'active', '2025-07-15');

insert into tasks (garden_id, title, cadence_days, est_minutes, owner, volunteer_id, volunteer_name, skill_level, active, last_completed, next_due) values
  ('11111111-1111-1111-1111-111111111101', 'Water raised beds', 3, 45, 'volunteer', '22222222-2222-2222-2222-222222222201', 'Sarah Mitchell', 'none', true, now() - interval '2 days', now() + interval '1 day'),
  ('11111111-1111-1111-1111-111111111101', 'Weed main paths', 14, 90, 'open', null, null, 'none', true, now() - interval '10 days', now() + interval '4 days'),
  ('11111111-1111-1111-1111-111111111102', 'Mow paths', 21, 90, 'jordan', null, null, 'none', true, now() - interval '15 days', now() + interval '6 days');

insert into walkins (garden_id, title, est_minutes, active) values
  ('11111111-1111-1111-1111-111111111101', 'Trash pickup', 15, true),
  ('11111111-1111-1111-1111-111111111101', 'Pull weeds anywhere', 30, true);

insert into clients (name, address, email, phone) values
  ('Robert & Carol Smith', '412 Pine Ridge Rd', 'rmsmith@email.com', '(814) 555-0192');
```

- [ ] **Step 6: Sanity-check via REST**

```bash
curl -s "$SUPABASE_URL/rest/v1/gardens?select=id" -H "apikey: $ANON_KEY" | head
```
Expected: `[]` (empty prod) with HTTP 200 — anon can read gardens.

```bash
curl -s -o /dev/null -w "%{http_code}" "$SUPABASE_URL/rest/v1/clients?select=id" -H "apikey: $ANON_KEY"
```
Expected: `200` with body `[]` — RLS hides rows (run with `-i` to confirm empty array).

- [ ] **Step 7: Commit**

```bash
git add supabase/ assets/config.js
git commit -m "feat: Supabase project schema, RLS, kiosk RPCs, dev seed; wire real config"
```

---

### Task 3: Rewrite auth — `assets/auth.js`, `login.html`, `index.html`

**Files:**
- Rewrite: `assets/auth.js`
- Modify: `login.html` (email field, async submit, standard script block), `index.html`
- Modify: `assets/nav.js:1-5` area only if needed for signOut (call site already compatible)

**Interfaces:**
- Consumes: `window.ecoSupabase` (Task 1).
- Produces: `AuthManager` = `{ hasCachedSession(): boolean (sync), isAuthenticated(): Promise<boolean>, signIn(email, password): Promise<{success, error?}>, signOut(): Promise<void> (redirects), requireAuth(): Promise<Session> (redirects+throws if not an active portal user), getUser(): Promise<string|null>, getRole(): Promise<'admin'|'user'|null> }`.

- [ ] **Step 1: Rewrite `assets/auth.js`**

```js
/**
 * Ecotopia Portal — Auth Manager (Supabase Auth).
 * All methods async except hasCachedSession(), a cheap sync pre-render guard.
 * requireAuth() is authoritative: valid session AND active portal_users row.
 */
const AuthManager = (() => {
  const sb = window.ecoSupabase;

  function hasCachedSession() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) return true;
      }
    } catch (e) { /* storage blocked: fall through to async check */ }
    return false;
  }

  async function isAuthenticated() {
    const { data } = await sb.auth.getSession();
    return !!(data && data.session);
  }

  let cachedRole; // undefined = not fetched yet; null = no portal access
  async function getRole() {
    if (cachedRole !== undefined) return cachedRole;
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) { cachedRole = null; return null; }
    const res = await sb.from('portal_users').select('role, active')
      .eq('user_id', data.session.user.id).maybeSingle();
    cachedRole = (res.data && res.data.active) ? res.data.role : null;
    return cachedRole;
  }

  async function signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { success: false, error: 'Invalid email or password.' };
    cachedRole = undefined;
    const role = await getRole();
    if (!role) {
      await sb.auth.signOut();
      return { success: false, error: 'This account does not have portal access.' };
    }
    return { success: true };
  }

  async function signOut() {
    await sb.auth.signOut();
    window.location.href = 'login.html';
  }

  async function requireAuth() {
    const { data } = await sb.auth.getSession();
    if (!data || !data.session) {
      window.location.replace('login.html');
      throw new Error('Not authenticated');
    }
    const role = await getRole();
    if (!role) {
      await sb.auth.signOut();
      window.location.replace('login.html');
      throw new Error('No portal access');
    }
    return data.session;
  }

  async function getUser() {
    const { data } = await sb.auth.getSession();
    return (data && data.session) ? data.session.user.email : null;
  }

  return { hasCachedSession, isAuthenticated, signIn, signOut, requireAuth, getUser, getRole };
})();
```

- [ ] **Step 2: Update `login.html`**

Replace its script includes with the standard script block. Change the username field to email: label text `Email`, `<input type="email" id="username" ...>` (keep the id to minimize churn). Replace the submit handler (currently `login.html:117-132`):

```js
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('username').value.trim();
  const pass = document.getElementById('password').value;
  const err = document.getElementById('errorMsg');
  const result = await AuthManager.signIn(email, pass);
  if (result.success) {
    window.location.href = 'dashboard.html';
  } else {
    err.textContent = result.error;
    err.classList.add('visible');
    document.getElementById('password').value = '';
    document.getElementById('password').focus();
  }
});
```

Also add at the top of login's script (skip login page if already signed in):

```js
(async () => { if (await AuthManager.isAuthenticated()) window.location.replace('dashboard.html'); })();
```

- [ ] **Step 3: Update `index.html`**

Replace the whole `<head>` script section with the standard script block plus:

```html
<script>
(async () => {
  window.location.replace((await AuthManager.isAuthenticated()) ? 'dashboard.html' : 'login.html');
})();
</script>
```

- [ ] **Step 4: Manual verification**

Run: `cd ~/GitHub/ecotopia-portal && python3 -m http.server 8080` then open `http://localhost:8080/login.html`.
Expected: wrong password shows "Invalid email or password." No portal user exists yet, so a correct-credential test happens in Task 9 after Jordan's account is created. Verify no console errors on load.

- [ ] **Step 5: Commit**

```bash
git add assets/auth.js login.html index.html
git commit -m "feat: Supabase Auth sign-in, session handling, portal-user gate"
```

---

### Task 4: Rewrite `assets/data.js` as the async Supabase DataStore

**Files:**
- Rewrite: `assets/data.js`

**Interfaces:**
- Consumes: `window.ecoSupabase`, `globalThis.EcoMapping`.
- Produces: `DataStore` with every method below. All data methods async, throw on error. Sync utilities unchanged: `formatDate(iso)`, `formatTime(iso)`, `daysUntil(iso)`, `uid()`.

- [ ] **Step 1: Write the new `assets/data.js`**

```js
/**
 * Ecotopia Portal — DataStore (Supabase-backed).
 * Every data method returns a Promise and throws Error on failure.
 * Rows come back camelCase (EcoMapping); writes accept camelCase.
 * submit* methods use return=minimal inserts so anon RLS (no select) works.
 */
const DataStore = (() => {
  const sb = window.ecoSupabase;
  const { toDb, fromDb, fromDbAll } = globalThis.EcoMapping;

  function unwrap({ data, error }) {
    if (error) throw new Error(error.message);
    return data;
  }

  async function list(table, orderCol = 'created_at') {
    return fromDbAll(unwrap(await sb.from(table).select('*').order(orderCol, { ascending: true })));
  }
  async function getOne(table, id) {
    if (!id) return null;
    const row = unwrap(await sb.from(table).select('*').eq('id', id).maybeSingle());
    return row ? fromDb(row) : null;
  }
  async function insert(table, record) {
    return fromDb(unwrap(await sb.from(table).insert(toDb(record)).select().single()));
  }
  // Anon-safe insert: no RETURNING, so no select policy is needed.
  async function submit(table, record) {
    unwrap(await sb.from(table).insert(toDb(record)));
    return record;
  }
  async function update(table, id, changes) {
    return fromDb(unwrap(await sb.from(table).update(toDb(changes)).eq('id', id).select().single()));
  }

  const api = {
    // Gardens
    getGardens: () => list('gardens'),
    getGarden: (id) => getOne('gardens', id),
    getGardenByToken: async (token) => {
      const row = unwrap(await sb.from('gardens').select('*').eq('qr_token', token).maybeSingle());
      return row ? fromDb(row) : null;
    },
    addGarden: (r) => insert('gardens', r),
    updateGarden: (id, ch) => update('gardens', id, ch),

    // Clients
    getClients: () => list('clients'),
    getClient: (id) => getOne('clients', id),
    addClient: (r) => insert('clients', r),
    updateClient: (id, ch) => update('clients', id, ch),

    // Jobs
    getJobs: () => list('jobs'),
    getJob: (id) => getOne('jobs', id),
    addJob: (r) => insert('jobs', r),
    submitInquiryJob: (r) => submit('jobs', { ...r, status: 'inquiry' }), // public intake path
    updateJob: (id, ch) => update('jobs', id, ch),
    addJobNote: async (id, note) => {
      const job = await getOne('jobs', id);
      if (!job) return null;
      const log = job.activityLog || [];
      log.push({ ts: new Date().toISOString(), note });
      return update('jobs', id, { activityLog: log });
    },

    // Volunteers
    getVolunteers: () => list('volunteers'),
    getVolunteer: (id) => getOne('volunteers', id),
    addVolunteer: (r) => insert('volunteers', r),
    updateVolunteer: (id, ch) => update('volunteers', id, ch),
    // Kiosk (anon): names only + phone matching + task completion via RPC
    getVolunteersPublic: async () =>
      fromDbAll(unwrap(await sb.from('volunteers_public').select('*').order('name'))),
    matchVolunteerByPhone: async (phone) => {
      const rows = unwrap(await sb.rpc('match_volunteer_by_phone', { p_phone: phone }));
      return rows && rows.length ? fromDb(rows[0]) : null;
    },
    completeTask: async (taskId) => { unwrap(await sb.rpc('complete_task', { p_task_id: taskId })); },

    // Tasks
    getTasks: () => list('tasks'),
    getTask: (id) => getOne('tasks', id),
    getTasksByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('tasks').select('*').eq('garden_id', gId))),
    getTasksByVolunteer: async (vId) =>
      fromDbAll(unwrap(await sb.from('tasks').select('*').eq('volunteer_id', vId))),
    getJordanTasks: async () =>
      fromDbAll(unwrap(await sb.from('tasks').select('*').eq('owner', 'jordan'))),
    getOpenTasks: async () =>
      fromDbAll(unwrap(await sb.from('tasks').select('*').eq('owner', 'open'))),
    addTask: (r) => insert('tasks', r),
    updateTask: (id, ch) => update('tasks', id, ch),
    claimTask: (taskId, volunteerId, volunteerName) =>
      update('tasks', taskId, { owner: 'volunteer', volunteerId, volunteerName }),

    // Walk-ins
    getWalkins: () => list('walkins'),
    getWalkinsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('walkins').select('*').eq('garden_id', gId).eq('active', true))),
    updateWalkin: (id, ch) => update('walkins', id, ch),

    // Check-ins
    getCheckins: () => list('checkins'),
    getCheckinsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('checkins').select('*').eq('garden_id', gId))),
    getCheckinsByVolunteer: async (vId) =>
      fromDbAll(unwrap(await sb.from('checkins').select('*').eq('volunteer_id', vId))),
    addCheckin: (r) => submit('checkins', r), // submit: kiosk runs as anon
    getRecentCheckins: async (n = 5) =>
      fromDbAll(unwrap(await sb.from('checkins').select('*')
        .order('check_in_time', { ascending: false }).limit(n))),
    getHoursLast30: async (volunteerId) => {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const rows = unwrap(await sb.from('checkins').select('hours_logged')
        .eq('volunteer_id', volunteerId).gte('check_in_time', cutoff));
      return (rows || []).reduce((sum, c) => sum + (Number(c.hours_logged) || 0), 0);
    },

    // Events
    getEvents: () => list('events'),
    getEvent: (id) => getOne('events', id),
    addEvent: (r) => insert('events', r),
    updateEvent: (id, ch) => update('events', id, ch),
    signupForEvent: async (eventId, name) => {
      const ev = await getOne('events', eventId);
      if (!ev) return null;
      const signups = ev.signups || [];
      if (!signups.includes(name)) signups.push(name);
      return update('events', eventId, { signups });
    },
    getUpcomingEvents: async () => {
      const today = new Date().toISOString().slice(0, 10);
      return fromDbAll(unwrap(await sb.from('events').select('*')
        .gte('date', today).order('date', { ascending: true })));
    },

    // Invoices
    getInvoices: () => list('invoices'),
    getInvoice: (id) => getOne('invoices', id),
    addInvoice: (r) => insert('invoices', r),
    updateInvoice: (id, ch) => update('invoices', id, ch),
    markInvoicePaid: (id) =>
      update('invoices', id, { status: 'paid', paidDate: new Date().toISOString().slice(0, 10) }),
    getUnpaidInvoices: async () =>
      fromDbAll(unwrap(await sb.from('invoices').select('*').neq('status', 'paid'))),

    // Grants
    getGrants: () => list('grants'),
    getGrant: (id) => getOne('grants', id),
    addGrant: (r) => insert('grants', r),
    updateGrant: (id, ch) => update('grants', id, ch),

    // Observations
    getObservations: () => list('observations'),
    getObservationsByGarden: async (gId) =>
      fromDbAll(unwrap(await sb.from('observations').select('*').eq('garden_id', gId))),
    addObservation: (r) => insert('observations', r),
    flagObservation: (id) => update('observations', id, { flagged: true }),

    // Public form submissions (anon inserts, return=minimal)
    addIntakeSubmission: (r) => submit('intake_submissions', r),
    getIntakeSubmissions: () => list('intake_submissions'),
    addVolunteerApplication: (r) => submit('volunteer_applications', r),
    getVolunteerApplications: () => list('volunteer_applications'),

    // Sync utilities (unchanged from the demo version)
    uid: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    formatDate(isoStr) {
      if (!isoStr) return '-';
      const d = new Date(isoStr);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },
    formatTime(isoStr) {
      if (!isoStr) return '-';
      const d = new Date(isoStr);
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    },
    daysUntil(isoStr) {
      if (!isoStr) return null;
      const diff = new Date(isoStr).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
      return Math.round(diff / 86400000);
    },
  };

  return api;
})();
```

Notes locked in here: `DataStore.init()` is gone (no more auto-seed; pages must not call it). `addCheckin`, `addIntakeSubmission`, `addVolunteerApplication`, `submitInquiryJob` use minimal-return inserts because anon has no select policy on those tables.

- [ ] **Step 2: Verify in browser console against the live dev DB**

Run: `python3 -m http.server 8080`, open `http://localhost:8080/login.html`, and in DevTools console run:

```js
await DataStore.getGardens()          // [] on empty prod, rows if dev seed loaded
await DataStore.getVolunteersPublic() // [] or seeded names
```
Expected: arrays returned, no thrown errors. Then confirm RLS bites: `await DataStore.getClients()` as anon returns `[]`.

- [ ] **Step 3: Run unit tests still pass**

Run: `npm test`
Expected: 5 passing (mapping unaffected).

- [ ] **Step 4: Commit**

```bash
git add assets/data.js
git commit -m "feat: async Supabase-backed DataStore replacing localStorage demo store"
```

---

### Task 5: Async refactor — admin pages batch A (dashboard, gardens, garden-detail)

**Files:**
- Modify: `dashboard.html`, `gardens.html`, `garden-detail.html`

**Interfaces:**
- Consumes: `AuthManager.requireAuth()`, `AuthManager.hasCachedSession()`, async `DataStore` (Task 4 signatures).

**The refactor recipe (applies to every admin page in Tasks 5-8; repeated in each task so tasks are self-contained):**

1. Replace the page's top auth script `<script>try { AuthManager.requireAuth(); } catch(e) { throw e; }</script>` with the standard script block (supabase.js, config.js, supabase-client.js, mapping.js, auth.js) followed by the sync guard:
   `<script>if (!AuthManager.hasCachedSession()) location.replace('login.html');</script>`
2. Keep the existing `<script src="assets/data.js"></script>` and `nav.js` includes after that block.
3. Wrap the page's inline logic in one async bootstrap. All DataStore data reads happen up front via `Promise.all`; render functions become pure functions of that data (no DataStore data calls inside template loops). Sync utilities (`formatDate`, `formatTime`, `daysUntil`, `uid`) may stay inline anywhere.
4. Write actions (`add*`/`update*` in modal handlers) become `async`, are awaited inside `try/catch`; on success re-fetch the affected data and re-render; on failure keep the modal open and show the message in an inline error element (add `<div class="modal-error" id="..."></div>` to each modal; style: `color:#b3261e; font-size:0.85rem; margin-top:8px;`). Never `alert()` for save failures.
5. Page-load failure shows an error banner in the page's main container:
   `el.innerHTML = '<div class="empty">Could not load data (' + err.message + '). <a href="javascript:location.reload()">Retry</a></div>'`

**Per-page data loads:**

- `dashboard.html`:
  ```js
  const [gardens, jobs, invoices, unpaidInvoices, jordanTasks, openTasks, recentCheckins, upcomingEvents, observations] =
    await Promise.all([
      DataStore.getGardens(), DataStore.getJobs(), DataStore.getInvoices(),
      DataStore.getUnpaidInvoices(), DataStore.getJordanTasks(), DataStore.getOpenTasks(),
      DataStore.getRecentCheckins(5), DataStore.getUpcomingEvents(), DataStore.getObservations(),
    ]);
  ```
  Then the existing dashboard logic runs unchanged against these local variables.
- `gardens.html`: load `const [gardens, tasks] = await Promise.all([DataStore.getGardens(), DataStore.getTasks()]);` and inside `renderGardens`, replace `DataStore.getTasksByGarden(g.id)` with `tasks.filter(t => t.gardenId === g.id)`.
- `garden-detail.html`: `const id = new URLSearchParams(location.search).get('id')` (as today), then
  ```js
  const [garden, tasks, walkins, checkins, observations, volunteers] = await Promise.all([
    DataStore.getGarden(id), DataStore.getTasksByGarden(id), DataStore.getWalkinsByGarden(id),
    DataStore.getCheckinsByGarden(id), DataStore.getObservationsByGarden(id), DataStore.getVolunteers(),
  ]);
  ```
  Replace inner `DataStore.getTask(...)`/`DataStore.getVolunteer(...)` lookups with finds over the loaded arrays. Modal saves (`addTask`, `updateTask`, `updateWalkin`) follow recipe step 4, re-fetching just tasks/walkins and re-rendering.

**Worked example — the complete new `gardens.html` script section** (this exact shape is the template for every page):

```html
<script src="assets/supabase.js"></script>
<script src="assets/config.js"></script>
<script src="assets/supabase-client.js"></script>
<script src="assets/mapping.js"></script>
<script src="assets/auth.js"></script>
<script>if (!AuthManager.hasCachedSession()) location.replace('login.html');</script>
<script src="assets/data.js"></script>
<script src="assets/nav.js"></script>
<script>
function renderGardens(gardens, tasks) {
  const el = document.getElementById('gardenGrid');
  el.innerHTML = gardens.map(g => {
    const gTasks = tasks.filter(t => t.gardenId === g.id);
    /* ...existing card-building logic, verbatim, but using gTasks
       instead of DataStore.getTasksByGarden(g.id)... */
  }).join('');
  if (!gardens.length) el.innerHTML = '<div class="empty">No gardens yet. Add your first garden.</div>';
}

(async function init() {
  await AuthManager.requireAuth();
  Nav.render();
  try {
    const [gardens, tasks] = await Promise.all([DataStore.getGardens(), DataStore.getTasks()]);
    renderGardens(gardens, tasks);
  } catch (err) {
    document.getElementById('gardenGrid').innerHTML =
      '<div class="empty">Could not load data (' + err.message + '). <a href="javascript:location.reload()">Retry</a></div>';
  }
})();
</script>
```

- [ ] **Step 1: Refactor `dashboard.html`** per the recipe and its data-load block above.
- [ ] **Step 2: Refactor `gardens.html`** per the worked example.
- [ ] **Step 3: Refactor `garden-detail.html`** per the recipe (largest page; its add/edit task and walk-in modals all follow recipe step 4).
- [ ] **Step 4: Manual verification** — with the dev seed loaded and a portal user existing (if Task 9 not yet done, temporarily create one: dashboard → Auth → Add user, then SQL `insert into portal_users (user_id, email, role) values ('<uid>', '<email>', 'admin');`). Sign in, then: dashboard renders all tiles; gardens grid shows seeded gardens with task splits; garden detail loads, add-task modal creates a row (verify in table editor), edit persists after reload.
- [ ] **Step 5: Commit**

```bash
git add dashboard.html gardens.html garden-detail.html
git commit -m "refactor: async Supabase data flow for dashboard, gardens, garden detail"
```

---

### Task 6: Async refactor — batch B (clients, jobs, job-detail)

**Files:**
- Modify: `clients.html`, `jobs.html`, `job-detail.html`

**Interfaces:** same recipe as Task 5 (steps 1-5 repeated verbatim there; treat that recipe as part of this task).

**Per-page data loads:**

- `clients.html`: `const [clients, jobs] = await Promise.all([DataStore.getClients(), DataStore.getJobs()]);` — per-client job counts come from `jobs.filter(j => j.clientId === c.id)`. `addClient`/`updateClient` modals per recipe step 4 (re-fetch clients, re-render).
- `jobs.html`: `const jobs = await DataStore.getJobs();` — `addJob` modal per recipe step 4.
- `job-detail.html`:
  ```js
  const job = await DataStore.getJob(id);
  const client = job && job.clientId ? await DataStore.getClient(job.clientId) : null;
  ```
  If `job` is null render "Job not found." `addJobNote`, `updateJob`, `addInvoice` awaited per recipe step 4; after `addJobNote`/`updateJob`, re-fetch the job and re-render the activity log/status.

- [ ] **Step 1: Refactor `clients.html`**
- [ ] **Step 2: Refactor `jobs.html`**
- [ ] **Step 3: Refactor `job-detail.html`**
- [ ] **Step 4: Manual verification** — clients list + add/edit client persists across reload; jobs board renders by status; job detail: add note appends to activity log (check `activity_log` jsonb in table editor), create-invoice button inserts an invoice row.
- [ ] **Step 5: Commit**

```bash
git add clients.html jobs.html job-detail.html
git commit -m "refactor: async Supabase data flow for clients, jobs, job detail"
```

---

### Task 7: Async refactor — batch C (volunteers, volunteer-detail, calendar, events)

**Files:**
- Modify: `volunteers.html`, `volunteer-detail.html`, `calendar.html`, `events.html`

**Interfaces:** same recipe as Task 5.

**Per-page data loads:**

- `volunteers.html`:
  ```js
  const [volunteers, gardens, tasks, checkins] = await Promise.all([
    DataStore.getVolunteers(), DataStore.getGardens(), DataStore.getTasks(), DataStore.getCheckins(),
  ]);
  ```
  Replace per-volunteer `DataStore.getTasksByVolunteer(v.id)` with `tasks.filter(t => t.volunteerId === v.id)`, `DataStore.getCheckinsByVolunteer(v.id)` with `checkins.filter(c => c.volunteerId === v.id)`, and `DataStore.getHoursLast30(v.id)` with a local helper:
  ```js
  const hoursLast30 = (vId) => {
    const cutoff = Date.now() - 30 * 86400000;
    return checkins.filter(c => c.volunteerId === vId && new Date(c.checkInTime).getTime() >= cutoff)
      .reduce((s, c) => s + (Number(c.hoursLogged) || 0), 0);
  };
  ```
  `addVolunteer`/`updateVolunteer`/`addCheckin` (log-hours modal) per recipe step 4.
- `volunteer-detail.html`:
  ```js
  const [volunteer, vTasks, vCheckins, gardens] = await Promise.all([
    DataStore.getVolunteer(id), DataStore.getTasksByVolunteer(id),
    DataStore.getCheckinsByVolunteer(id), DataStore.getGardens(),
  ]);
  ```
  Garden-name lookups become `gardens.find(g => g.id === x)`; hours-last-30 computed from `vCheckins` as above.
- `calendar.html`: `const [events, jobs, tasks, gardens] = await Promise.all([DataStore.getEvents(), DataStore.getJobs(), DataStore.getTasks(), DataStore.getGardens()]);` — `DataStore.getGarden(id)` call sites become `gardens.find(...)`.
- `events.html`: `const [events, gardens] = await Promise.all([DataStore.getEvents(), DataStore.getGardens()]);` — `addEvent`/`updateEvent`/`signupForEvent` per recipe step 4 (re-fetch events, re-render).

- [ ] **Step 1: Refactor `volunteers.html`**
- [ ] **Step 2: Refactor `volunteer-detail.html`**
- [ ] **Step 3: Refactor `calendar.html`**
- [ ] **Step 4: Refactor `events.html`**
- [ ] **Step 5: Manual verification** — volunteer roster shows hours and assigned tasks from seed; volunteer detail matches; calendar shows seeded events/tasks/jobs on correct dates; add event + admin signup persists (check `signups` jsonb).
- [ ] **Step 6: Commit**

```bash
git add volunteers.html volunteer-detail.html calendar.html events.html
git commit -m "refactor: async Supabase data flow for volunteers, calendar, events"
```

---

### Task 8: Async refactor — batch D (invoices, grants, reports)

**Files:**
- Modify: `invoices.html`, `grants.html`, `reports.html`

**Interfaces:** same recipe as Task 5.

**Per-page data loads:**

- `invoices.html`: `const invoices = await DataStore.getInvoices();` — `updateInvoice`/`markInvoicePaid` per recipe step 4 (re-fetch, re-render).
- `grants.html`: `const [grants, jobs] = await Promise.all([DataStore.getGrants(), DataStore.getJobs()]);` — job lookups become `jobs.find(...)`; `addGrant`/`updateGrant` per recipe step 4.
- `reports.html`: `const [checkins, gardens, volunteers] = await Promise.all([DataStore.getCheckins(), DataStore.getGardens(), DataStore.getVolunteers()]);` — all aggregation logic runs unchanged on the local arrays.

- [ ] **Step 1: Refactor `invoices.html`**
- [ ] **Step 2: Refactor `grants.html`**
- [ ] **Step 3: Refactor `reports.html`**
- [ ] **Step 4: Manual verification** — mark-paid flips status and sets `paid_date`; grant add/edit persists; reports totals match seed check-ins.
- [ ] **Step 5: Commit**

```bash
git add invoices.html grants.html reports.html
git commit -m "refactor: async Supabase data flow for invoices, grants, reports"
```

---

### Task 9: Public pages (intake, volunteer board, QR kiosk) + users management + invite Edge Function

**Files:**
- Modify: `intake.html`, `volunteer-board.html`, `qr-checkin.html`, `assets/nav.js`
- Create: `users.html`, `accept-invite.html`, `supabase/functions/accept-invite/index.ts`

**Interfaces:**
- Consumes: `DataStore.submitInquiryJob`, `addIntakeSubmission`, `addVolunteerApplication`, `addCheckin`, `getVolunteersPublic`, `matchVolunteerByPhone`, `completeTask`, `getGardenByToken`, `getTasksByGarden`, `getWalkinsByGarden`, `claimTask` signatures from Task 4; `AuthManager.getRole()` from Task 3.
- Produces: Edge Function endpoint `POST {SUPABASE_URL}/functions/v1/accept-invite` with body `{ token, password }` returning `{ ok: true }` or `{ error }`.

- [ ] **Step 1: `intake.html`** — public page: use the standard script block + `data.js` (NO auth guard, NO nav). Make the submit handler async with try/catch; replace `DataStore.addJob({...})` (`intake.html:226`) with `DataStore.submitInquiryJob({...same fields, minus status...})` and await both calls:

```js
try {
  await DataStore.addIntakeSubmission({ /* existing fields verbatim */ });
  await DataStore.submitInquiryJob({ /* existing fields verbatim, without status */ });
  document.getElementById('intakeForm').style.display = 'none';
  document.getElementById('thanksScreen').classList.add('visible');
} catch (err) {
  document.getElementById('intakeError').textContent =
    'Something went wrong sending your request. Please try again, or call us directly.';
  document.getElementById('intakeError').classList.add('visible');
}
```

Add `<div id="intakeError" class="modal-error"></div>` above the submit button. Keep the existing required-fields `alert` validation as is.

- [ ] **Step 2: `volunteer-board.html`** — standard script block + data.js, async init: `const [gardens, allTasks] = await Promise.all([DataStore.getGardens(), DataStore.getTasks()]);` (anon reads active tasks via RLS); open tasks = `allTasks.filter(t => t.owner === 'open')` grouped by garden as today. `submitClaim` becomes async: `await DataStore.addVolunteerApplication({...existing fields...})` in try/catch; on error show inline message in the card instead of marking claimed.

- [ ] **Step 3: `qr-checkin.html`** — standard script block + data.js, async init:
  ```js
  const gardenToken = new URLSearchParams(window.location.search).get('garden'); // existing param name, qr-checkin.html:132
  garden = gardenToken ? await DataStore.getGardenByToken(gardenToken) : null;
  const [tasks, walkins, volunteersPublic] = await Promise.all([
    DataStore.getTasksByGarden(garden.id), DataStore.getWalkinsByGarden(garden.id),
    DataStore.getVolunteersPublic(),
  ]);
  ```
  Replace both `DataStore.getVolunteers()` call sites: the scheduled-path volunteer list uses `volunteersPublic`; the walk-in phone match (`qr-checkin.html:339`) becomes `const matchedVol = phone ? await DataStore.matchVolunteerByPhone(phone) : null;`. `checkInScheduled` becomes async:
  ```js
  await DataStore.addCheckin({ /* existing fields verbatim */ });
  await DataStore.completeTask(selectedTask.id);   // replaces the direct updateTask call
  showSuccess(...);
  ```
  Wrap both check-in paths in try/catch; on failure show "Check-in did not save. Please try again." inline and do not show the success screen.

- [ ] **Step 4: Edge Function** — `supabase/functions/accept-invite/index.ts`:

```ts
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
    },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true }, 200);
  try {
    const { token, password } = await req.json();
    if (!token || !password || String(password).length < 8) {
      return json({ error: 'Invalid token, or password shorter than 8 characters.' }, 400);
    }
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: invite } = await admin.from('portal_invites').select('*')
      .eq('token', token).is('used_at', null)
      .gt('expires_at', new Date().toISOString()).maybeSingle();
    if (!invite) return json({ error: 'Invite not found, expired, or already used.' }, 400);

    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: invite.email, password, email_confirm: true,
    });
    if (cErr) return json({ error: cErr.message }, 400);

    const { error: puErr } = await admin.from('portal_users').insert({
      user_id: created.user.id, email: invite.email, role: invite.role, active: true,
    });
    if (puErr) return json({ error: puErr.message }, 500);

    await admin.from('portal_invites').update({ used_at: new Date().toISOString() }).eq('id', invite.id);
    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: 'Unexpected error: ' + String(e) }, 500);
  }
});
```

Deploy: `supabase functions deploy accept-invite --no-verify-jwt`
(`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are auto-provided to functions; nothing to set.)

- [ ] **Step 5: `users.html`** (admin-only) — copy the head/styles of `clients.html` for visual consistency, standard script block + data.js + nav.js. Bootstrap:

```js
(async function init() {
  await AuthManager.requireAuth();
  Nav.render();
  if ((await AuthManager.getRole()) !== 'admin') { location.replace('dashboard.html'); return; }
  await refresh();
})();

async function refresh() {
  const sb = window.ecoSupabase;
  const [users, invites] = await Promise.all([
    sb.from('portal_users').select('*').order('created_at'),
    sb.from('portal_invites').select('*').is('used_at', null).order('created_at'),
  ]);
  renderUsers(users.data || []);
  renderInvites(invites.data || []);
}

async function createInvite(email, role) {
  const sb = window.ecoSupabase;
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const { error } = await sb.from('portal_invites').insert({
    email, role, token,
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  if (error) throw new Error(error.message);
  return location.origin + location.pathname.replace('users.html', 'accept-invite.html') + '?token=' + token;
}
```

UI: table of users (email, role, active, buttons: Toggle role, Deactivate/Reactivate via `sb.from('portal_users').update(...)`); pending invites list showing the copyable accept link; invite form (email + role select) calling `createInvite` and displaying the returned link with a Copy button. All writes in try/catch with inline `.modal-error` display per the Task 5 recipe.

- [ ] **Step 6: `accept-invite.html`** (public) — minimal page matching `login.html` styling: reads `?token=`, form with password + confirm (min 8, must match, validated client-side), submits:

```js
const res = await fetch(window.ECO_CONFIG.SUPABASE_URL + '/functions/v1/accept-invite', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: window.ECO_CONFIG.SUPABASE_ANON_KEY },
  body: JSON.stringify({ token, password }),
});
const body = await res.json();
if (body.ok) { /* show success + link to login.html */ }
else { /* show body.error inline */ }
```

- [ ] **Step 7: `assets/nav.js`** — after the existing render, append a Users link for admins (both sidebar and nowhere on mobile primary):

```js
// at the end of render():
AuthManager.getRole().then((role) => {
  if (role !== 'admin') return;
  const sidebar = document.querySelector('#eco-sidebar nav') || document.getElementById('eco-sidebar');
  if (!sidebar) return;
  const a = document.createElement('a');
  a.href = 'users.html';
  a.className = 'eco-nav-link' + (currentPage() === 'users.html' ? ' active' : '');
  a.innerHTML = '<span class="eco-nav-icon">🔑</span> Users';
  sidebar.appendChild(a);
});
```

(Match the exact class names used by the existing sidebar links when implementing; read `nav.js` render output first.)

- [ ] **Step 8: Manual verification** — intake submit as anon creates `intake_submissions` + inquiry job rows; board application creates `volunteer_applications` row; kiosk via `qr-checkin.html?...token` checks in a seeded scheduled task (checkin row + task `next_due` advanced by RPC) and a walk-in with phone match; users.html invite → accept-invite sets password → new user logs in; regular-role user does not see the Users nav link and gets bounced off users.html.
- [ ] **Step 9: Commit**

```bash
git add intake.html volunteer-board.html qr-checkin.html users.html accept-invite.html assets/nav.js supabase/functions/
git commit -m "feat: public pages on anon RLS, user management with invite flow via edge function"
```

---

### Task 10: RLS verification script + Jordan's account + full manual pass

**Files:**
- Create: `scripts/verify-rls.mjs`

**Interfaces:**
- Consumes: env vars `SUPABASE_URL`, `SUPABASE_ANON_KEY`.

- [ ] **Step 1: Write `scripts/verify-rls.mjs`** (plain fetch, no dependencies):

```js
// Verifies the anon key can do exactly what the public pages need and nothing more.
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/verify-rls.mjs
// NOTE: inserts test rows (name RLS-TEST). Delete them afterwards:
//   delete from intake_submissions where name = 'RLS-TEST';
//   delete from volunteer_applications where name = 'RLS-TEST';
//   delete from checkins where notes = 'RLS-TEST';
//   delete from jobs where title = 'RLS-TEST';
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY'); process.exit(2); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message); }
}
const get = (p) => fetch(`${URL_}/rest/v1/${p}`, { headers: H });
const post = (p, body) => fetch(`${URL_}/rest/v1/${p}`, {
  method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body),
});
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

await check('anon reads gardens (200)', async () => {
  const r = await get('gardens?select=id'); assert(r.status === 200, `status ${r.status}`);
});
await check('anon sees zero clients rows', async () => {
  const r = await get('clients?select=id'); const rows = await r.json();
  assert(r.status === 200 && Array.isArray(rows) && rows.length === 0, `got ${r.status} / ${rows.length ?? 'non-array'}`);
});
await check('anon sees zero volunteers rows', async () => {
  const r = await get('volunteers?select=id'); const rows = await r.json();
  assert(rows.length === 0, `leaked ${rows.length} rows`);
});
await check('anon sees zero invoices rows', async () => {
  const r = await get('invoices?select=id'); const rows = await r.json();
  assert(rows.length === 0, `leaked ${rows.length} rows`);
});
await check('anon reads volunteers_public (200)', async () => {
  const r = await get('volunteers_public?select=name'); assert(r.status === 200, `status ${r.status}`);
});
await check('anon CANNOT insert clients', async () => {
  const r = await post('clients', { name: 'RLS-TEST' }); assert(r.status >= 400, `status ${r.status}`);
});
await check('anon CANNOT update gardens', async () => {
  const r = await fetch(`${URL_}/rest/v1/gardens?name=eq.x`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ name: 'y' }),
  });
  const body = await r.json().catch(() => []);
  assert(r.status >= 400 || (Array.isArray(body) && body.length === 0), `status ${r.status}`);
});
await check('anon CAN insert intake submission', async () => {
  const r = await post('intake_submissions', { name: 'RLS-TEST', phone: '000' });
  assert(r.status === 201, `status ${r.status}`);
});
await check('anon CAN insert volunteer application', async () => {
  const r = await post('volunteer_applications', { name: 'RLS-TEST' });
  assert(r.status === 201, `status ${r.status}`);
});
await check('anon CAN insert checkin', async () => {
  const r = await post('checkins', { notes: 'RLS-TEST', type: 'walkin' });
  assert(r.status === 201, `status ${r.status}`);
});
await check('anon CAN insert inquiry job only', async () => {
  const ok = await post('jobs', { title: 'RLS-TEST', status: 'inquiry' });
  assert(ok.status === 201, `inquiry insert status ${ok.status}`);
  const bad = await post('jobs', { title: 'RLS-TEST', status: 'active' });
  assert(bad.status >= 400, `active insert allowed (status ${bad.status})`);
});
console.log(failures ? `\n${failures} FAILURES` : '\nAll RLS checks passed.');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run it**

Run: `SUPABASE_URL=<url> SUPABASE_ANON_KEY=<key> node scripts/verify-rls.mjs`
Expected: `All RLS checks passed.` Then delete the RLS-TEST rows with the SQL in the file header (SQL editor).

- [ ] **Step 3: Create Jordan's account** — Supabase dashboard → Authentication → Add user (email + strong generated password, email confirmed), then SQL editor:

```sql
insert into portal_users (user_id, email, role)
select id, email, 'admin' from auth.users where email = '<JORDANS_EMAIL>';
```

⚠️ Get Jordan's actual email from Frank. Password handed over out-of-band; Jordan can be given a reset link from the dashboard.

- [ ] **Step 4: Full manual checklist** (against the local server, real DB): every admin page loads/creates/edits/deletes; logout/login works; deactivating a test user blocks their sign-in with the "does not have portal access" message; public pages work signed-out (fresh incognito window).

- [ ] **Step 5: Remove all seed/test data from prod** — SQL editor: `delete from` each entity table (dev seed rows + anything created during manual testing), verify every table is empty except `portal_users` (Jordan + Frank if added). Production starts empty per spec.

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-rls.mjs
git commit -m "test: anon-key RLS verification script"
```

---

### Task 11: Deploy to Netlify (ecotopia.bagcarriers.dev)

**Files:**
- Modify: `netlify.toml` (only if needed; existing redirect is fine)

- [ ] **Step 1: Create + link Netlify site**

```bash
cd ~/GitHub/ecotopia-portal
netlify sites:create --name ecotopia-portal   # uses the token in settings.local.json pattern
netlify link --name ecotopia-portal
```

- [ ] **Step 2: Deploy**

```bash
netlify deploy --prod --dir=.
```
Expected: deploy URL prints; site loads at the `.netlify.app` URL and redirects `/` to login.

- [ ] **Step 3: Attach the subdomain** — `bagcarriers.dev` DNS is on Netlify: `netlify api createDnsRecord` or dashboard → Domain management → add `ecotopia.bagcarriers.dev` as a domain alias on this site. Verify HTTPS works after cert issuance.

- [ ] **Step 4: Production smoke test** — on `https://ecotopia.bagcarriers.dev`: log in as the test admin (or Jordan), dashboard renders (empty states everywhere); in an incognito window: intake form submits, volunteer board loads, a QR link with a real garden token loads the kiosk (needs at least one garden created first — create one via the UI, grab its token from the table editor). Delete any smoke-test rows created.

- [ ] **Step 5: Re-run RLS verification against prod** — `node scripts/verify-rls.mjs` with prod env vars; delete RLS-TEST rows after.

- [ ] **Step 6: Commit any deploy-config changes + final state**

```bash
git add -A
git commit -m "chore: netlify site config for ecotopia.bagcarriers.dev"
```

Do not push to origin until Frank confirms (repo pushes are Frank's call).

---

## Post-plan notes (not tasks)

- Log the new Supabase project (~$10/mo) in the spend-tracking program for Forrest's per-client P&L.
- Old-Mac reminder: `demo-mvp` tag = the fully working localStorage demo; `git checkout demo-mvp` + `netlify deploy` restores it anywhere if something goes wrong post-launch.
- Portal app-icon standard: check whether the site has a 180x180 `apple-touch-icon`; if not, add one in a follow-up (needs an Ecotopia logo asset from Frank).
- Future hardening candidates deliberately left out (YAGNI): rate-limiting public inserts, kiosk token rotation, email notifications on intake submissions.

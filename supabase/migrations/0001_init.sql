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

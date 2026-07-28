-- Editable plant shop catalog (species + habitat kits).
-- Replaces the hardcoded PLANTS / KITS consts in plants.html with live data the
-- staff portal (manage-plants.html) can edit. Applied live via the Management API
-- (see docs/OPERATIONS.md), so register it with
-- `supabase migration repair --status applied 0019` before any `supabase db push`.
create table public.plant_species (
  id         uuid primary key default gen_random_uuid(),
  common     text not null,
  botanical  text,
  bloom      text,
  height     text,
  attracts   text,
  fact       text,
  tags       jsonb not null default '[]'::jsonb,
  photo_path text,
  sort       integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create table public.plant_kits (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique,
  name       text not null,
  blurb      text,
  plants     jsonb not null default '[]'::jsonb,
  photo_path text,
  sort       integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
alter table public.plant_species enable row level security;
alter table public.plant_kits enable row level security;
create policy sp_anon_read on public.plant_species for select to anon using (active);
create policy sp_staff_all on public.plant_species for all to authenticated using (public.is_portal_user()) with check (public.is_portal_user());
create policy pk_anon_read on public.plant_kits for select to anon using (active);
create policy pk_staff_all on public.plant_kits for all to authenticated using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.plant_species for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.plant_kits for each row execute function public.set_updated_at();

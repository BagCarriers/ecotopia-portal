-- Per-service lead-gen settings + waitlist.
-- service_settings: one row per marketing service; staff toggle active/off and
--   set an off message + reopen date. Anon reads them so the marketing cards
--   know whether to open an inquiry modal or an out-of-season / waitlist modal.
-- service_waitlist: anon-insertable waitlist rows captured when a service is off.
-- Applied live via the Management API (see docs/OPERATIONS.md), not `supabase db push`.

create table public.service_settings (
  slug        text primary key,
  name        text not null,
  active      boolean not null default true,
  off_message text,
  reopen_date date,
  updated_at  timestamptz
);
alter table public.service_settings enable row level security;
create policy ss_anon_read on public.service_settings for select to anon using (true);
create policy ss_staff_read on public.service_settings for select to authenticated using (public.is_portal_user());
create policy ss_staff_write on public.service_settings for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.service_settings
  for each row execute function public.set_updated_at();

create table public.service_waitlist (
  id           uuid primary key default gen_random_uuid(),
  service_slug text not null,
  name         text not null,
  email        text,
  phone        text,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
alter table public.service_waitlist enable row level security;
create policy sw_anon_ins on public.service_waitlist for insert to anon with check (true);
create policy sw_staff_all on public.service_waitlist for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.service_waitlist
  for each row execute function public.set_updated_at();

-- Seed the ten marketing services (all active). Idempotent.
insert into public.service_settings (slug, name) values
  ('pollinator_garden',   'Pollinator Garden / Mini Meadow'),
  ('food_forest',         'Food Forest Design'),
  ('rain_garden',         'Rain Garden'),
  ('annual_food_garden',  'Annual Food Garden'),
  ('living_willow',       'Living Willow Fence'),
  ('garden_maintenance',  'Routine Garden Maintenance'),
  ('medicinal_herb',      'Medicinal Herb Garden and Consulting'),
  ('forest_restoration',  'Forest Habitat Restoration'),
  ('woodland_restoration','Woodland Habitat Restoration'),
  ('lawn_to_meadow',      'Lawn to Meadow Conversion')
on conflict (slug) do nothing;

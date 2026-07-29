-- First-party reviews (no GBP): anon submit, staff moderate, approved shown publicly.
-- The client has no Google Business Profile, so the website collects, moderates, and
-- displays its own reviews. Applied live via the Management API (see docs/OPERATIONS.md),
-- so register it with `supabase migration repair --status applied 0026` before any
-- `supabase db push`.
create table public.reviews (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  location   text,                -- 'Altoona', 'Hollidaysburg' etc, optional
  rating     integer not null check (rating between 1 and 5),
  service    text,                -- free text: what we did for them
  body       text not null,
  status     text not null default 'pending' check (status in ('pending','approved','dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
alter table public.reviews enable row level security;
create policy rv_anon_ins on public.reviews for insert to anon with check (status = 'pending');
create policy rv_anon_read on public.reviews for select to anon using (status = 'approved');
create policy rv_staff_all on public.reviews for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.reviews
  for each row execute function public.set_updated_at();

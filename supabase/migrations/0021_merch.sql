-- Non-plant merch catalog for the shop page.
-- Applied live via the Management API (see docs/OPERATIONS.md), so register it
-- with `supabase migration repair --status applied 0021` before any `supabase db push`.
create table public.merch_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  blurb       text,
  price_text  text,
  status_text text,
  photo_path  text,
  link_url    text,
  sort        integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
alter table public.merch_items enable row level security;
create policy mi_anon_read on public.merch_items for select to anon using (active);
create policy mi_staff_all on public.merch_items for all to authenticated using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.merch_items for each row execute function public.set_updated_at();

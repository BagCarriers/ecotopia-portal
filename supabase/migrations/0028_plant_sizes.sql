-- 0028: two plant sizes, each independently switchable by season.
-- A size is orderable only when the seasonal switch AND the species flag agree.
-- Prices are NOT stored here: they live in supabase/functions/square-pay/index.ts,
-- so the display-equals-charge drift test has a constant to scrape.

create table if not exists public.plant_size_settings (
  size_key    text primary key check (size_key in ('plug', 'gallon')),
  label       text not null,
  blurb       text not null,
  active      boolean not null default false,
  off_message text,
  reopen_date date,
  sort        integer not null default 0,
  updated_at  timestamptz
);

alter table public.plant_size_settings enable row level security;

drop policy if exists pss_anon_read on public.plant_size_settings;
create policy pss_anon_read on public.plant_size_settings
  for select to anon using (true);

drop policy if exists pss_staff_read on public.plant_size_settings;
create policy pss_staff_read on public.plant_size_settings
  for select to authenticated using (true);

drop policy if exists pss_staff_write on public.plant_size_settings;
create policy pss_staff_write on public.plant_size_settings
  for all to authenticated using (true) with check (true);

-- plug seeds ACTIVE because that matches what is on sale today ($5 plants are
-- orderable right now). gallon seeds INACTIVE so this migration changes nothing
-- a customer can see until Jordan opens the season himself.
insert into public.plant_size_settings (size_key, label, blurb, active, sort) values
  ('plug',   'Spring plug', '3 by 5 inch container',              true,  1),
  ('gallon', 'Gallon pot',  'More mature, ready from mid summer', false, 2)
on conflict (size_key) do nothing;

alter table public.plant_species
  add column if not exists offers_plug   boolean not null default true,
  add column if not exists offers_gallon boolean not null default true,
  add column if not exists stock_plug    integer,
  add column if not exists stock_gallon  integer;

-- stock_qty is null on all 50 rows (verified immediately before this migration).
-- It cannot stay: one counter cannot express plugs selling out while gallons remain.
alter table public.plant_species drop column if exists stock_qty;

-- decrement_stock gains an optional size. Kits and merch keep calling the old shape.
drop function if exists public.decrement_stock(text, uuid, integer);
create or replace function public.decrement_stock(
  p_kind text, p_id uuid, p_qty integer, p_size text default null
)
returns void language sql security definer set search_path = public as $$
  update plant_species set stock_plug = greatest(stock_plug - p_qty, 0)
    where p_kind = 'species' and p_size = 'plug' and id = p_id and stock_plug is not null;
  update plant_species set stock_gallon = greatest(stock_gallon - p_qty, 0)
    where p_kind = 'species' and p_size = 'gallon' and id = p_id and stock_gallon is not null;
  update plant_kits set stock_qty = greatest(stock_qty - p_qty, 0)
    where p_kind = 'kit' and id = p_id and stock_qty is not null;
  update merch_items set stock_qty = greatest(stock_qty - p_qty, 0)
    where p_kind = 'merch' and id = p_id and stock_qty is not null;
$$;
revoke execute on function public.decrement_stock(text, uuid, integer, text) from public;
revoke execute on function public.decrement_stock(text, uuid, integer, text) from anon, authenticated;
grant execute on function public.decrement_stock(text, uuid, integer, text) to service_role;

-- One row per planting event: what the team put in the ground, where, and when.
--
-- species_label is MANDATORY and species_id is an optional link to the shop
-- catalogue. The label is the durable record of what was planted; the foreign key
-- only adds "and it happens to be something we sell". This is deliberately simpler
-- than a nullable label with a one-of-two constraint, which would give two ways to
-- name a plant and force every reader to handle both.
--
-- The habitat kits already reference American Plum, Buttonbush and Summersweet,
-- none of which are among the 50 catalogue wildflowers, so requiring a foreign key
-- would make a large share of real plantings unloggable.
--
-- on delete set null for species_id, NOT cascade: deleting a species from the shop
-- must not erase the historical fact that it was planted. The row keeps its label,
-- quantity and date and simply stops linking to a shop page.

create table if not exists public.garden_plantings (
  id            uuid primary key default gen_random_uuid(),
  garden_id     uuid not null references public.gardens(id) on delete cascade,
  species_id    uuid references public.plant_species(id) on delete set null,
  species_label text not null,
  quantity      integer not null,
  planted_on    date not null,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  constraint garden_plantings_label_chk check (length(trim(species_label)) > 0),
  constraint garden_plantings_quantity_chk check (quantity > 0)
);

-- Unlike plant_species, which is a fixed 50 rows, this table grows without bound
-- and is always read for one garden at a time. An index earns its keep here.
create index if not exists garden_plantings_garden_idx
  on public.garden_plantings (garden_id);

alter table public.garden_plantings enable row level security;

-- Same shape as every sibling content table: the public reads, staff write.
create policy gp_anon_read on public.garden_plantings
  for select to anon using (true);
create policy gp_staff_all on public.garden_plantings
  for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());

create trigger set_updated_at before update on public.garden_plantings
  for each row execute function public.set_updated_at();

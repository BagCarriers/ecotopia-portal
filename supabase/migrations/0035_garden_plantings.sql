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
--
-- Re-runnable in full, per the convention this repo adopted at 0028. create policy
-- has no IF NOT EXISTS in any Postgres version and create trigger has only OR
-- REPLACE, so every policy, trigger and constraint is dropped first. The check
-- constraints are added by alter rather than inline, because create table if not
-- exists silently skips inline constraints once the table exists, which would make
-- a re-run quietly fail to update them.

create table if not exists public.garden_plantings (
  id            uuid primary key default gen_random_uuid(),
  garden_id     uuid not null references public.gardens(id) on delete cascade,
  species_id    uuid references public.plant_species(id) on delete set null,
  species_label text not null,
  quantity      integer not null,
  planted_on    date not null,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

-- The trim set is spelled out instead of using plain trim(), because Postgres
-- trim()/btrim() default to stripping the ASCII SPACE ONLY, while JavaScript's
-- String.prototype.trim() strips 25 codepoints. A label of a single tab or a
-- non-breaking space would pass `length(trim(x)) > 0` and still be blank to the
-- browser, which is how a headline total could exceed the species list beneath it.
-- Non-breaking spaces and U+FEFF arrive routinely in pasted text.
--
-- This literal is exactly the 25 codepoints JavaScript strips, verified per
-- codepoint against this database. A regex on [[:space:]] was rejected because it
-- misses U+FEFF. btrim only strips from the ends, so a label containing any of
-- these internally is unaffected. Written as \u escapes on purpose: the literal
-- characters would be invisible in a diff and unreviewable.
alter table public.garden_plantings
  drop constraint if exists garden_plantings_label_chk;
alter table public.garden_plantings
  add constraint garden_plantings_label_chk check (length(btrim(species_label,
    E' \t\n\r\f\v\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF')) > 0);

-- Keeps garbage out of published grant totals. Note this does NOT reject a
-- fractional quantity: Postgres applies the numeric to integer assignment cast
-- before the check, so 2.5 is rounded to 3 and accepted. It does still catch
-- anything that rounds to zero or below, so every stored quantity is a positive
-- integer. Rejecting a non-integer belongs in the write path, not here.
alter table public.garden_plantings
  drop constraint if exists garden_plantings_quantity_chk;
alter table public.garden_plantings
  add constraint garden_plantings_quantity_chk check (quantity > 0);

-- Unlike plant_species, which is a fixed 50 rows, this table grows without bound
-- and is always read for one garden at a time. An index earns its keep here.
create index if not exists garden_plantings_garden_idx
  on public.garden_plantings (garden_id);

alter table public.garden_plantings enable row level security;

-- Staff only. The note column is staff authored free text, so this table follows
-- planting_suggestions, observations, checkins, jobs and clients and gives anon no
-- select policy at all. The public reads six columns of it through
-- public.garden_plantings_public, the view added in 0036; RLS is row level, so a
-- policy here could not have withheld a single column.
--
-- An earlier revision of this file created gpl_anon_read ... using (true), which
-- published the note. It is dropped rather than merely deleted from the source,
-- because this file advertises itself as re-runnable and would otherwise put the
-- policy back on any database that already has it.
--
-- Prefixed gpl_ rather than gp_, which gallery_photos already uses for
-- gp_staff_all in 0009, so a diagnostic query filtering on policyname alone does
-- not return rows from two unrelated tables. The gp_ drops below clear the names
-- an earlier revision of this migration created.
drop policy if exists gp_anon_read on public.garden_plantings;
drop policy if exists gp_staff_all on public.garden_plantings;
drop policy if exists gpl_anon_read on public.garden_plantings;

drop policy if exists gpl_staff_all on public.garden_plantings;
create policy gpl_staff_all on public.garden_plantings
  for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());

drop trigger if exists set_updated_at on public.garden_plantings;
create trigger set_updated_at before update on public.garden_plantings
  for each row execute function public.set_updated_at();

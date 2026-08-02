-- 0032: scope the team_members anon read to active rows.
--
-- 0031 shipped tm_anon_read as `using (true)`, which is wider than every sibling
-- content table (plant_species, plant_kits and merch_items all gate anon on
-- `active`; events gates on `is_public`). The `.eq('active', true)` in
-- DataStore.getPublicTeam was therefore a client-side filter, not a boundary:
-- a hidden member's name, role and photo stayed readable by anyone holding the
-- anon key, which is exactly what the hide toggle exists to prevent. Someone
-- taken off the public page must actually be off it.
--
-- tm_staff_read is deliberately left alone: the portal has to keep seeing hidden
-- rows so Jordan can unhide them.
drop policy if exists tm_anon_read on public.team_members;
create policy tm_anon_read on public.team_members
  for select to anon using (active);

-- 0029: match plant_size_settings write access to service_settings.
-- 0028 shipped pss_staff_write as `to authenticated using (true)`, which is wider than
-- every sibling settings table: any authenticated account, including a deactivated one,
-- could open or close a plant season and write the off message a customer reads.
-- is_portal_user() is the gate service_settings already uses.
drop policy if exists pss_staff_write on public.plant_size_settings;
create policy pss_staff_write on public.plant_size_settings
  for all to authenticated using (is_portal_user()) with check (is_portal_user());

drop policy if exists pss_staff_read on public.plant_size_settings;
create policy pss_staff_read on public.plant_size_settings
  for select to authenticated using (true);

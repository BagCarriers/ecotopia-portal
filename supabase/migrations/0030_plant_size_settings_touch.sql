-- 0030: plant_size_settings.updated_at was never maintained.
-- 0028 declared the column, but the set_updated_at trigger that plant_species and
-- service_settings carry was never attached here, so the column advertised an audit
-- trail it did not keep.
drop trigger if exists plant_size_settings_set_updated_at on public.plant_size_settings;
create trigger plant_size_settings_set_updated_at
  before update on public.plant_size_settings
  for each row execute function public.set_updated_at();

-- Photo for each service card in the homepage showcase.
--
-- Frank (2026-08-23): Jordan should be able to change the photos on the service
-- cards himself, through the portal, instead of asking us to swap a file.
--
-- Same convention as plant_species.photo_path and gardens.photo_path:
--   'static:<file>'  a repo asset under assets/img/services/ (charset-guarded on
--                    read so a stored value cannot escape the folder)
--   anything else    an object key in the public 'gallery' storage bucket
--
-- Backfilled to exactly what index.html ships today, so applying this changes
-- nothing on the site until Jordan actually uploads something. The markup keeps
-- its hardcoded <img src> as a fallback for a failed fetch or no JS.
alter table public.service_settings add column if not exists photo_path text;

comment on column public.service_settings.photo_path is
  'Homepage service card photo. ''static:<file>'' is a repo asset under assets/img/services/; any other value is a key in the public gallery bucket.';

update public.service_settings set photo_path = v.path
from (values
  ('tree_nets',            'static:tree-nets.jpg'),
  ('lawn_to_meadow',       'static:lawn-to-meadow.jpg'),
  ('pollinator_garden',    'static:pollinator-garden.jpg'),
  ('food_forest',          'static:food-forest.jpg'),
  ('rain_garden',          'static:rain-garden.jpg'),
  ('annual_food_garden',   'static:annual-food.jpg'),
  ('living_willow',        'static:living-willow.jpg'),
  ('garden_maintenance',   'static:maintenance-crew.jpg'),
  ('medicinal_herb',       'static:medicinal-herb.jpg'),
  ('forest_restoration',   'static:forest-restoration.jpg'),
  ('woodland_restoration', 'static:woodland-restoration.jpg')
) as v(slug, path)
where public.service_settings.slug = v.slug
  and public.service_settings.photo_path is null;

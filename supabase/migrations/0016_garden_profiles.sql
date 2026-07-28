-- Public garden profiles: description + optional Google My Maps embed.
-- description renders (esc'd) on community-gardens.html and the homepage strip.
-- map_mid holds ONLY a Google My Maps id (the mid= value); the public renderer
-- validates it against /^[A-Za-z0-9_-]+$/ before building an iframe src, so a
-- crafted value cannot break out of the src or point the embed elsewhere.
alter table public.gardens add column if not exists description text;
alter table public.gardens add column if not exists map_mid text;

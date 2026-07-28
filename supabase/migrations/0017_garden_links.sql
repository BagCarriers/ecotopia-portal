-- Get-involved link (e.g. Google interest form) + photo for garden cards.
-- form_url renders as a public href on community-gardens.html, so the renderer
-- requires it to start with 'https://' (a simple scheme check) before building
-- the link; anything else is refused.
-- photo_path either follows the events pattern (a gallery-bucket path served via
-- public URL) or is a 'static:<file>' value pointing at a repo asset under
-- assets/img/gardens/; the renderer validates the static filename against
-- /^[A-Za-z0-9._-]+$/ before use.
alter table public.gardens add column if not exists form_url text;
alter table public.gardens add column if not exists photo_path text;

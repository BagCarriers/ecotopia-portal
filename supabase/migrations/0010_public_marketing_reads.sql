-- Marketing site (public) reads: events listing and staff-curated gallery photos.
create policy anon_read_events on public.events for select to anon using (true);
create policy gp_anon_read_staff on public.gallery_photos for select to anon using (source = 'staff');

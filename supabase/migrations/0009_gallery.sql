-- Gallery: staff photo library + volunteer photo submissions.
-- Storage bucket 'gallery' (public read) holds the image files; the
-- gallery_photos table holds the metadata rows. Applied live via the
-- Management API (see docs/OPERATIONS.md), not `supabase db push`.

-- ── Storage bucket + policies ──────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gallery', 'gallery', true, 10485760, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do nothing;

-- Staff (authenticated portal users) get full CRUD on gallery objects.
create policy gallery_staff_all on storage.objects for all to authenticated
  using (bucket_id = 'gallery' and public.is_portal_user())
  with check (bucket_id = 'gallery' and public.is_portal_user());
-- Anon may only upload under the volunteer/ prefix (no read/update/delete).
create policy gallery_anon_upload on storage.objects for insert to anon
  with check (bucket_id = 'gallery' and (storage.foldername(name))[1] = 'volunteer');

-- ── Metadata table ─────────────────────────────────────────────────────────
create table public.gallery_photos (
  id           uuid primary key default gen_random_uuid(),
  storage_path text not null,
  caption      text,
  uploaded_by  text,
  source       text not null default 'staff' check (source in ('staff','volunteer')),
  garden_id    uuid references public.gardens(id) on delete set null,
  garden_name  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
alter table public.gallery_photos enable row level security;
-- Staff: full CRUD. Anon: insert only, and only volunteer-sourced rows.
create policy gp_staff_all on public.gallery_photos for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());
create policy gp_anon_ins on public.gallery_photos for insert to anon
  with check (source = 'volunteer');
create trigger set_updated_at before update on public.gallery_photos
  for each row execute function public.set_updated_at();

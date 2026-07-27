-- Event photos live in the existing public gallery bucket under events/.
-- The gallery_staff_all policy (0009) has no path restriction, so authenticated
-- portal users can already write objects under the events/ prefix; the bucket is
-- public-read so the marketing pages can render them. Applied live via the
-- Management API (like the other migrations), not `supabase db push`.
alter table public.events add column if not exists photo_path text;

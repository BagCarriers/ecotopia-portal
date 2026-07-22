-- Events UI writes location and volunteerCount; initial schema missed both.
alter table public.events add column if not exists location text;
alter table public.events add column if not exists volunteer_count integer;

-- Garden-detail edit modals write tasks.description and walkins.type; initial schema missed both.
alter table public.tasks add column if not exists description text;
alter table public.walkins add column if not exists type text;

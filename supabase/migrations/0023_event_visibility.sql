-- Internal vs public events: calendar-created entries default internal;
-- only public events appear on the marketing site (RLS-enforced for anon).
alter table public.events add column if not exists is_public boolean not null default true;
drop policy anon_read_events on public.events;
create policy anon_read_events on public.events for select to anon using (is_public);

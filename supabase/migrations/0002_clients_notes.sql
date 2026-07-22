-- Clients UI has a Notes field the initial schema missed.
alter table public.clients add column if not exists notes text;

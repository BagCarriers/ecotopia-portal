-- Invoice edit form writes notes; initial schema missed it.
alter table public.invoices add column if not exists notes text;

-- Quotes with automatic administration fee tracking.
-- Every quote stores subtotal (sum of line items), admin_fee (5 percent of the
-- subtotal), and total (subtotal + admin_fee). The 5 percent is collected by
-- BagCarriers (the agency); the YTD tally on quotes.html excludes drafts.
-- Applied live via the Management API (see docs/OPERATIONS.md), not `supabase db push`.
create table public.quotes (
  id           uuid primary key default gen_random_uuid(),
  quote_year   integer not null,
  quote_number integer not null,
  client_name  text not null,
  client_address text,
  job_id       uuid references public.jobs(id) on delete set null,
  quote_date   date not null default current_date,
  line_items   jsonb not null default '[]'::jsonb,
  deposit      numeric not null default 0,
  subtotal     numeric not null default 0,
  admin_fee    numeric not null default 0,
  total        numeric not null default 0,
  status       text not null default 'draft' check (status in ('draft','sent','accepted','invoiced')),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz,
  unique (quote_year, quote_number)
);
alter table public.quotes enable row level security;
create policy q_staff_all on public.quotes for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.quotes
  for each row execute function public.set_updated_at();

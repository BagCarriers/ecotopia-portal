-- 0027: cash-discount pricing.
-- Displayed prices carry a 4 percent card uplift; cash and check pay base.
-- orders.subtotal_cents KEEPS its meaning (base, un-grossed) so no backfill is needed.
-- charge_cents is what we actually charge for the chosen pay_mode.

alter table public.orders
  add column if not exists charge_cents integer,
  add column if not exists tender text,
  add column if not exists amount_collected_cents integer;

alter table public.orders
  drop constraint if exists orders_tender_chk;
alter table public.orders
  add constraint orders_tender_chk
  check (tender is null or tender in ('cash', 'check', 'card'));

alter table public.quotes
  add column if not exists deposit_tender text;

alter table public.quotes
  drop constraint if exists quotes_deposit_tender_chk;
alter table public.quotes
  add constraint quotes_deposit_tender_chk
  check (deposit_tender is null or deposit_tender in ('cash', 'check', 'card'));

-- No new RLS policies. orders has no anon policies; only the square-pay edge function
-- (service role) and staff writes reach these columns. quotes is staff-only plus the
-- existing token-gated security-definer RPCs.

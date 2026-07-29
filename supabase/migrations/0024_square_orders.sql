-- Square payment linkage for quote deposits.
-- Applied live via the Management API (see docs/OPERATIONS.md), so register it with
-- `supabase migration repair --status applied 0024` before any `supabase db push`.
--
-- No new policies and no RPC changes: the public quote-view page never touches these
-- columns directly. The `square-pay` edge function (service role) reads/writes them
-- server-side; `deposit_status` (already unpaid/pending/paid from 0022) is what the
-- token-gated get_quote_by_token RPC exposes to the public page.
alter table public.quotes add column if not exists square_order_id text;
alter table public.quotes add column if not exists square_pay_url text;

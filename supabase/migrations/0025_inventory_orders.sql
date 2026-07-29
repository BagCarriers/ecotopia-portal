-- Supabase-owned inventory and orders. Supabase is the single source of truth for
-- catalog, prices, inventory, and orders; Square is a pure payment vessel that only
-- ever sees a computed total (nothing is mirrored into Square).
-- Applied live via the Management API (see docs/OPERATIONS.md), so register it with
-- `supabase migration repair --status applied 0025` before any `supabase db push`.

-- Inventory: null stock = untracked (always available); integer = tracked count.
alter table public.plant_species add column if not exists stock_qty integer;
alter table public.plant_kits add column if not exists stock_qty integer;
alter table public.merch_items add column if not exists stock_qty integer;
alter table public.merch_items add column if not exists price_cents integer; -- payable price; price_text stays display-only

-- Orders: Supabase-owned; Square sees only the total.
create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  order_token   text unique not null,           -- public status/payment page key (64 hex)
  customer_name text not null,
  phone         text,
  email         text,
  items         jsonb not null default '[]'::jsonb, -- [{kind:'species'|'kit'|'merch', id, name, qty, unit_cents, tier?}]
  subtotal_cents integer not null default 0,
  status        text not null default 'new' check (status in ('new','link_created','paid','ready','completed','cancelled')),
  pay_mode      text not null default 'pickup' check (pay_mode in ('pickup','online')),
  square_order_id text,
  square_pay_url  text,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
alter table public.orders enable row level security;
-- No anon policies at all: anon goes through security-definer RPCs / the edge function only.
create policy o_staff_all on public.orders for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

-- Atomic-enough stock decrement on payment (small-org scale).
-- Called ONLY by the square-pay edge function via the service role. Never granted to
-- anon/authenticated: execute is revoked from public and re-granted to service_role only.
create or replace function public.decrement_stock(p_kind text, p_id uuid, p_qty integer)
returns void language sql security definer set search_path = public as $$
  update plant_species set stock_qty = greatest(stock_qty - p_qty, 0)
    where p_kind = 'species' and id = p_id and stock_qty is not null;
  update plant_kits set stock_qty = greatest(stock_qty - p_qty, 0)
    where p_kind = 'kit' and id = p_id and stock_qty is not null;
  update merch_items set stock_qty = greatest(stock_qty - p_qty, 0)
    where p_kind = 'merch' and id = p_id and stock_qty is not null;
$$;
revoke execute on function public.decrement_stock(text, uuid, integer) from public;
revoke execute on function public.decrement_stock(text, uuid, integer) from anon, authenticated;
grant execute on function public.decrement_stock(text, uuid, integer) to service_role;

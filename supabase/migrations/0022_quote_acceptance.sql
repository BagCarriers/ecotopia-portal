-- Public quote acceptance: share token + acceptance record + deposit tracking.
-- Applied live via the Management API (see docs/OPERATIONS.md), so register it with
-- `supabase migration repair --status applied 0022` before any `supabase db push`.
--
-- No anon table policies are added: the public quote-view page reaches quotes ONLY
-- through the two token-gated security-definer RPCs below. Drafts are never
-- resolvable (the read RPC filters to sent/accepted/invoiced), and a token shorter
-- than 32 chars is refused, so an empty/guessed token can never resolve a row.
alter table public.quotes add column if not exists share_token text unique;
alter table public.quotes add column if not exists accepted_at timestamptz;
alter table public.quotes add column if not exists accepted_by text;
alter table public.quotes add column if not exists deposit_status text not null default 'unpaid'
  check (deposit_status in ('unpaid','pending','paid'));

-- Read a quote by its share token (anon-callable). Returns accepted_by and
-- deposit_status in addition to the quote body so the public page can render the
-- "Accepted by <name>" banner and the deposit panel. Both extra columns are safe to
-- expose: accepted_by is the client's own typed name, deposit_status is a coarse
-- unpaid/pending/paid flag. Only sent/accepted/invoiced quotes resolve (never drafts).
create or replace function public.get_quote_by_token(p_token text)
returns table (id uuid, quote_year integer, quote_number integer, client_name text,
               quote_date date, line_items jsonb, deposit numeric, subtotal numeric,
               admin_fee numeric, total numeric, status text, accepted_at timestamptz,
               accepted_by text, deposit_status text)
language sql stable security definer set search_path = public as $$
  select q.id, q.quote_year, q.quote_number, q.client_name, q.quote_date, q.line_items,
         q.deposit, q.subtotal, q.admin_fee, q.total, q.status, q.accepted_at,
         q.accepted_by, q.deposit_status
  from quotes q
  where q.share_token = p_token and length(coalesce(p_token,'')) >= 32
    and q.status in ('sent','accepted','invoiced');
$$;

-- Accept a quote by its share token (anon-callable). Idempotent: only a quote that
-- is still 'sent' and not yet accepted flips to 'accepted'; a second call returns
-- false. Returns true only when this call performed the acceptance.
create or replace function public.accept_quote(p_token text, p_name text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update quotes set status = 'accepted', accepted_at = now(),
    accepted_by = left(coalesce(p_name,''), 200)
  where share_token = p_token and length(coalesce(p_token,'')) >= 32
    and status = 'sent' and accepted_at is null;
  return found;
end $$;

grant execute on function public.get_quote_by_token(text) to anon, authenticated;
grant execute on function public.accept_quote(text, text) to anon, authenticated;

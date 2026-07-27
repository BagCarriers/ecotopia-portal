-- Grant finder: auto-discovered grant opportunities for staff triage.
-- Filled by the `grant-scan` edge function (Grants.gov + PA DCNR), which runs
-- nightly via pg_cron and on-demand from grant-finder.html. Staff triage each
-- row (status new -> reviewing -> applying, or dismissed); rescans upsert on the
-- (source, source_ref) key and NEVER overwrite status, so triage survives.
-- Applied live via the Management API (see docs/OPERATIONS.md), not `supabase db push`.
create table public.grant_opportunities (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,               -- 'grants.gov' | 'dcnr' | 'dep'
  source_ref  text not null,               -- opportunity number/url path (dedupe key)
  title       text not null,
  agency      text,
  url         text,
  close_date  date,
  summary     text,
  keywords    text,                        -- which search terms matched
  status      text not null default 'new' check (status in ('new','reviewing','applying','dismissed')),
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  unique (source, source_ref)
);
alter table public.grant_opportunities enable row level security;
-- Staff only. No anon policy: the public site cannot read discovered opportunities.
create policy go_staff_all on public.grant_opportunities for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.grant_opportunities
  for each row execute function public.set_updated_at();

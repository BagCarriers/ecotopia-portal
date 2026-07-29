-- Public questions inbox (future public Q&A built from answered ones).
-- Applied live via the Management API (see docs/OPERATIONS.md), so register it
-- with `supabase migration repair --status applied 0020` before any `supabase db push`.
create table public.questions (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  email      text,
  question   text not null,
  answer     text,
  status     text not null default 'new' check (status in ('new','answered','published','dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
alter table public.questions enable row level security;
create policy qs_anon_ins on public.questions for insert to anon with check (true);
create policy qs_staff_all on public.questions for all to authenticated using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.questions for each row execute function public.set_updated_at();

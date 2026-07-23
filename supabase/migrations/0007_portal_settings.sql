-- Key-value settings for portal integrations (calendar feed token, Google ICS URL).
create table public.portal_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.portal_settings enable row level security;
create policy ps_read  on public.portal_settings for select to authenticated using (public.is_portal_user());
create policy ps_ins   on public.portal_settings for insert to authenticated with check (public.is_portal_admin());
create policy ps_upd   on public.portal_settings for update to authenticated using (public.is_portal_admin()) with check (public.is_portal_admin());
create policy ps_del   on public.portal_settings for delete to authenticated using (public.is_portal_admin());
create trigger set_updated_at before update on public.portal_settings
  for each row execute function public.set_updated_at();

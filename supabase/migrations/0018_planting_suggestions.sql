-- Public suggestions for new planting sites (Pawpaw Pathways etc.).
create table public.planting_suggestions (
  id            uuid primary key default gen_random_uuid(),
  garden_id     uuid references public.gardens(id) on delete set null,
  name          text not null,
  phone         text,
  email         text,
  location_text text not null,
  land_relation text,
  notes         text,
  status        text not null default 'new' check (status in ('new','contacted','planted','dismissed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);
alter table public.planting_suggestions enable row level security;
create policy psg_anon_ins on public.planting_suggestions for insert to anon with check (true);
create policy psg_staff_all on public.planting_suggestions for all to authenticated
  using (public.is_portal_user()) with check (public.is_portal_user());
create trigger set_updated_at before update on public.planting_suggestions
  for each row execute function public.set_updated_at();

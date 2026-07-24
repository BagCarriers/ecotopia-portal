-- Add the "Tree Nets" marketing service (hand-woven, made to order by the team).
-- New row in public.service_settings so it appears on the public cards and in
-- manage-services.html automatically. Idempotent.
-- Applied live via the Management API (see docs/OPERATIONS.md), not `supabase db push`.

insert into public.service_settings (slug, name, active)
values ('tree_nets', 'Tree Nets', true)
on conflict (slug) do nothing;

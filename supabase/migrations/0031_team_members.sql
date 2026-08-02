-- 0031: the about.html team grid becomes portal-managed content.
-- Public listing only: a row here grants no portal access. Logins live in
-- portal_users and are managed on the Users page.

create table if not exists public.team_members (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  role       text not null,
  photo_path text,
  sort       integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

alter table public.team_members enable row level security;

drop policy if exists tm_anon_read on public.team_members;
create policy tm_anon_read on public.team_members
  for select to anon using (true);

drop policy if exists tm_staff_read on public.team_members;
create policy tm_staff_read on public.team_members
  for select to authenticated using (true);

-- is_portal_user(), not using(true): an inactive auth account must not be able
-- to edit content that renders on the public site.
drop policy if exists tm_staff_write on public.team_members;
create policy tm_staff_write on public.team_members
  for all to authenticated using (is_portal_user()) with check (is_portal_user());

drop trigger if exists team_members_set_updated_at on public.team_members;
create trigger team_members_set_updated_at
  before update on public.team_members
  for each row execute function public.set_updated_at();

-- Seed the eleven members currently hardcoded in about.html, in their present
-- order, with their existing repo photos. This reproduces the live page exactly,
-- so shipping this feature changes nothing a visitor sees.
--
-- Seed only when the table is empty. "on conflict do nothing" would not help
-- here: there is no unique constraint to conflict on, so a re-apply would insert
-- eleven duplicates with fresh ids. The emptiness guard also means that once
-- Jordan edits or removes a member, a re-apply will not resurrect the original,
-- unless every row is removed first: on a truncated or fully emptied table the
-- guard sees no rows and reinserts all eleven as active, republishing people who
-- were deliberately taken off the public page.
--
-- The guard takes no lock, so two applies running at the same time would both
-- see an empty table and both insert. Immaterial for a migration applied by hand
-- by one person, but it is the one way the idempotency claim can fail.
insert into public.team_members (name, role, photo_path, sort)
select v.name, v.role, v.photo_path, v.sort
from (values
  ('Jordan Sesame Wild', 'Founder, Manager, Ecological Landscape Designer, Permaculturist, Project Scout, and President of WildOnes Nonprofit.', 'static:team-jordan.jpg', 1),
  ('Jenna Rose Wild', 'Cofounder, Herbalist, Medicine Woman and Guide, Nursery Caretaker, Ecological Landscape Designer, and a Holistic Birth and Postpartum Doula.', 'static:team-jenna.jpg', 2),
  ('Kat Weakland', 'Community Food Systems Consultant, Botanical Weaver, and down-to-earth Garden Mentor.', 'static:team-kat.jpg', 3),
  ('Samuel Mohnkern', 'Landscape Designer, Ecosystem Steward, Arborist, and Invasive Plant Remover. Contracting through his neighboring business Restoration LandCare.', 'static:team-samuel.jpg', 4),
  ('Joshua Ritchey', 'Lead Landscape and Garden Tender.', 'static:team-joshua.jpg', 5),
  ('Jordan Sneed', 'Pawpaw Seedling Grower and Ecological Landscaper for his nearby neighborhoods of Juniata, Juniata Gap, Wehnwood, and Fairview.', 'static:team-jordansneed.jpg', 6),
  ('Tricia Lynn', 'Ecological Landscaper for her neighborhoods of East End, Greenwood, Little Italy, Downtown, Centre City, Dutch Hill, 6th Ward, AASD School District, and Columbia Park.', 'static:team-tricia.jpg', 7),
  ('John Peacefire', 'Ecological Landscaper for his nearby neighborhoods of Lakemont, Frankstown, and Garden Heights.', 'static:team-john.jpg', 8),
  ('Brendan', 'Ecological Landscaper for his nearby neighborhoods of Llyswen, Mansion Park, Knickerbocker, and Highland Park.', 'static:team-brendan.jpg', 9),
  ('Emily Evey', 'Program Coordinator.', 'static:team-emily.jpg', 10),
  ('Russ Replogle', 'Tractor and Mower service for Lawn to Meadow and Food Forest Conversion.', 'static:team-russ.jpg', 11)
) as v(name, role, photo_path, sort)
where not exists (select 1 from public.team_members);

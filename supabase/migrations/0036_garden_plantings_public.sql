-- Corrective migration. 0035 gave garden_plantings an unqualified anon select
-- policy (gpl_anon_read ... using (true)). Postgres RLS is row level only, so that
-- policy handed anonymous visitors the note column as well, and note is staff
-- authored free text: "replaced the six the Hartmans' dog dug up", "donor asked us
-- not to publicize this one", "client has not paid for these yet". Restricting the
-- select list in the JavaScript would be theatre, because the publishable key ships
-- in the page source and anyone can request
-- /rest/v1/garden_plantings?select=note directly.
--
-- garden_plantings would have been the first table in this repo to put staff
-- authored free text behind an ungated anon read. Every other table with a note or
-- notes column (planting_suggestions, observations, checkins, jobs, clients) has no
-- anon select policy at all, per 0001_init.sql:277, "anon: exactly what the 4
-- public pages need, nothing more".
--
-- The fix is the shape this repo already proved for volunteers in 0001: drop the
-- anon policy so the table is staff only, and give anon a view of just the columns
-- the public pages need. gpl_staff_all is untouched, so staff keep the whole table
-- including the note.

-- Step 1: the table joins its siblings. With RLS enabled and no policy for anon,
-- an anon request returns an empty set rather than rows. There is no need to revoke
-- the schema wide table grant Supabase issues to anon; RLS is what gates the rows,
-- and every other staff table in this database is protected exactly this way.
drop policy if exists gpl_anon_read on public.garden_plantings;

-- Step 2: the public view.
--
-- Columns are the six the public pages need. The names are copied verbatim from the
-- table so the existing snake_case to camelCase mapper in assets/data.js handles the
-- view with no special casing. note is the column this migration exists to withhold;
-- created_at and updated_at are withheld too, for the reason below.
--
-- created_at and updated_at are deliberately excluded. They are staff workflow
-- metadata, not facts about the planting: they record when somebody typed the row
-- in and when they last edited it. planted_on is the date the public cares about
-- and is already here. Publishing the edit timestamps would leak the shape of
-- internal record keeping, for instance that a particular garden's numbers were
-- revised the day after a grant report went out, and no public page has a use for
-- them. The same "nothing more" rule that removed note removes these.
--
-- security_invoker is pinned to false. The view must read the table with its
-- owner's rights, because anon deliberately has no policy on the table now; an
-- invoker rights view would return zero rows to every visitor and quietly break the
-- public garden pages. This is the same security definer behaviour volunteers_public
-- has relied on since 0001, where it comes from the Postgres default rather than
-- from anything written down. Stating it explicitly is the one place this migration
-- departs from that precedent: the default is easy to flip by accident and invisible
-- in review, and Supabase's advisor flags such views, so the intent should be in the
-- source rather than assumed. Exposing exactly these six columns of a table with no
-- per row visibility rules is the whole point of the view.
--
-- Dropped before creation rather than relying on create or replace alone. create or
-- replace view can only append columns; it refuses to remove, rename or reorder one.
-- So a later revision of this file that changed the column list would fail on any
-- database where the older view already existed, which is the exact re-runnability
-- 0035 set out to guarantee. No cascade: nothing depends on this view today, and if
-- something ever does, this migration should fail loudly rather than silently
-- destroy it.
drop view if exists public.garden_plantings_public;
create view public.garden_plantings_public with (security_invoker = false) as
  select id, garden_id, species_id, species_label, quantity, planted_on
    from public.garden_plantings;

-- revoke before grant, and this is not belt and braces. Supabase ships default
-- privileges that grant anon and authenticated ALL privileges on new tables and
-- views in the public schema, so the view arrives with insert, update and delete
-- already attached. A view this simple is auto updatable, and because it runs with
-- its owner's rights those writes reach the base table as postgres, which owns the
-- table and is therefore not subject to its RLS. Without these revokes the view
-- would have replaced a read hole with a far worse write hole: this exact request,
-- with the publishable key and nothing else, rewrote a live row before the revokes
-- were added.
--
--   curl -X PATCH ".../rest/v1/garden_plantings_public?id=eq.<id>" \
--        -H "apikey: <anon>" -d '{"quantity":777}'   ->  200, quantity now 777
--
-- Note this is a property of granting anon anything on a security definer view, not
-- of this migration. public.volunteers_public from 0001 had the same exposure, found
-- while testing this file and fixed in 0037.
revoke all on public.garden_plantings_public from anon, authenticated;
grant select on public.garden_plantings_public to anon, authenticated;

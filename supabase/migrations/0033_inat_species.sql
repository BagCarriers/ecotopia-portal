-- iNaturalist enrichment for the plant catalogue.
--
-- Additive only. photo_path keeps its exact current meaning: 'static:<file>' is a
-- repo asset under assets/img/plants/, anything else is a gallery-bucket object.
-- iNaturalist images are written as plants/<uuid>.jpg, which the existing
-- renderers already handle, so nothing about display changes here.
--
-- LOAD-BEARING: a row with photo_path set and inat_photo_id NULL is Jordan's own
-- photograph. The nightly sync must never modify one. See isOwnPhoto in
-- supabase/functions/_shared/inat-logic.js and its mutation-proven test.
--
-- inat_establishment is 'introduced', 'native', or NULL. NULL means iNaturalist
-- has no Pennsylvania listing, which is NOT evidence of being native: measured on
-- the live API, Quercus alba and Rudbeckia hirta return nothing at all.

alter table public.plant_species add column if not exists inat_taxon_id          integer;
alter table public.plant_species add column if not exists inat_match             text;
alter table public.plant_species add column if not exists inat_matched_name      text;
alter table public.plant_species add column if not exists inat_establishment     text;
alter table public.plant_species add column if not exists inat_conservation      text;
alter table public.plant_species add column if not exists inat_photo_id          bigint;
alter table public.plant_species add column if not exists inat_photo_license     text;
alter table public.plant_species add column if not exists inat_photo_attribution text;
alter table public.plant_species add column if not exists inat_photo_source_url  text;
alter table public.plant_species add column if not exists inat_photo_status      text;
alter table public.plant_species add column if not exists inat_synced_at         timestamptz;

alter table public.plant_species drop constraint if exists plant_species_inat_match_chk;
alter table public.plant_species add constraint plant_species_inat_match_chk
  check (inat_match is null or inat_match in ('exact', 'fuzzy', 'manual', 'none'));

alter table public.plant_species drop constraint if exists plant_species_inat_photo_status_chk;
alter table public.plant_species add constraint plant_species_inat_photo_status_chk
  check (inat_photo_status is null or inat_photo_status in ('auto', 'approved', 'rejected'));

alter table public.plant_species drop constraint if exists plant_species_inat_establishment_chk;
alter table public.plant_species add constraint plant_species_inat_establishment_chk
  check (inat_establishment is null or inat_establishment in ('introduced', 'native'));

-- No index. The table holds 50 rows; a sequential scan is faster than any index
-- lookup at this size and an index here would be pure maintenance cost.

-- No new RLS policy. The existing sp_anon_read (gated on active) and sp_staff_all
-- cover these columns, and no anonymous write path is introduced.

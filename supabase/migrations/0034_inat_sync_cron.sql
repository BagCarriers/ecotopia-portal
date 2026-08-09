-- Nightly iNaturalist sync at 10:00 UTC.
--
-- ---------------------------------------------------------------------------
-- DO NOT APPLY THIS FILE YET.
--
-- Writing plant_species.photo_path publishes. plants.html reads the table live
-- over the anon key, so there is no separate publish step on this site: the row
-- write IS the publication. The licence allowlist this job fills from includes
-- CC-BY and CC-BY-SA, both of which require the credit to be displayed, and the
-- function refuses any photograph with no attribution string at all. The credit
-- line on plants.html is committed but not yet deployed, so scheduling this job
-- today would put uncredited Creative Commons photographs on a live storefront.
-- That already happened once on this project: 33 photos went live uncredited and
-- had to be rolled back.
--
-- Apply this file only once all three are true:
--   1. the photo credit line is deployed and rendering on the live plants.html,
--   2. the review grid on manage-plants.html is deployed,
--   3. someone has confirmed 1 by looking at the live page, not at the repo.
-- ---------------------------------------------------------------------------
--
-- SUBSTITUTE THE TOKEN BEFORE APPLYING. REPLACE_WITH_INAT_SYNC_TOKEN below is a
-- placeholder; the live value is the INAT_SYNC_TOKEN edge function secret, which
-- is already set on this project. The committed file must never carry the real
-- value. The applied job always does: pg_cron stores the command verbatim in
-- cron.job, so the token sits in cleartext in the same database the service role
-- protects. That is the same trade grant-scan-nightly already makes here.
-- Rotating the token means setting the secret AND re-running this schedule with
-- the new value. The two must move together or the nightly call starts getting
-- 401s that nothing will notice (see the observability note at the bottom).
--
-- Timing: 10:00 UTC, an hour after grant-scan-nightly at 09:00 UTC, so the two
-- never contend. pg_cron schedules are UTC.
--
-- No Authorization header is sent and none is needed: inat-sync is deployed
-- --no-verify-jwt (pinned in supabase/config.toml) and authorises the cron
-- caller on the X-Scan-Token header alone, the same shape as grant-scan.

-- Both already exist on this project (grant-scan-nightly uses them). Named here
-- so the file states its own dependencies; if not exists makes it a no-op.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- cron.schedule is itself an upsert on jobname, so this guard is belt and
-- braces. It is here so a re-apply visibly replaces the job rather than looking
-- like it might have left two.
select cron.unschedule('inat-sync-nightly')
  where exists (select 1 from cron.job where jobname = 'inat-sync-nightly');

select cron.schedule(
  'inat-sync-nightly',
  '0 10 * * *',
  $$
  select net.http_post(
    url := 'https://wibnryfinfwbwwgsyojr.supabase.co/functions/v1/inat-sync',
    headers := '{"Content-Type": "application/json", "X-Scan-Token": "REPLACE_WITH_INAT_SYNC_TOKEN"}'::jsonb,
    body := '{"action": "sync"}'::jsonb,
    timeout_milliseconds := 240000
  );
  $$
);

-- ---------------------------------------------------------------------------
-- Why timeout_milliseconds is set here when grant-scan-nightly does not set it
--
-- net.http_post defaults to a 5000 ms timeout. inat-sync paces itself at 1100 ms
-- per iNaturalist call to stay inside that free API's 60-per-minute limit, and a
-- resolvable species costs two calls, so roughly 2.2 seconds each. The verified
-- 50 row run took about 130 seconds. Left at the default, pg_net would abort the
-- connection about two species in, every night, forever. Whether an aborted
-- client also tears down the edge function is not something this file can
-- assert, because it has not been measured on this project; the timeout is set
-- wide enough that the question never has to be answered.
--
-- ---------------------------------------------------------------------------
-- Known constraint: the run has no batch limit
--
-- Neither pass caps how many rows it selects. resolveAndEnrich takes every
-- species with inat_taxon_id null, and fillPhotos takes every resolved species
-- with photo_path null. Cost is therefore linear in the backlog. That is fine
-- for this catalogue of 50 species, but a few hundred unresolved ones would
-- exceed the edge function's wall clock and the run would be killed part way
-- through.
--
-- Nothing is corrupted when that happens. Each row is its own committed UPDATE,
-- and selection is driven by inat_taxon_id being null, so the next night simply
-- resumes where the last one stopped. The rate-limit path is deliberately built
-- the same way: it returns 429 with the partial counts rather than pretending
-- the run finished. Capping the batch means changing the edge function, which is
-- a code change and not this file's job. It is written down here so whoever
-- grows the catalogue knows the ceiling exists before they hit it.
--
-- ---------------------------------------------------------------------------
-- Observability: this cron job will report success either way
--
-- net.http_post is asynchronous. It queues the request and returns an id
-- immediately, so cron.job_run_details records this job as succeeded whatever
-- the function answers, including a 401, a 429 or a timeout. Read the outcome
-- from net._http_response or from the function logs, never from the cron
-- history:
--
--   select jobname, schedule, active from cron.job order by jobname;
--   select id, status_code, error_msg, created
--     from net._http_response order by id desc limit 5;

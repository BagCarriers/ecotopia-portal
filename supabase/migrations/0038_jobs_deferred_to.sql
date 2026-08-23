-- Jobs a client has pushed to a future season.
--
-- Jordan (2026-08-23): "This one woman said she no longer has money in her budget
-- for this year and will need to push the project back to Spring of 2027."
--
-- Free text rather than a year integer or a date, deliberately. What staff know
-- is "Spring 2027" or "after the barn is finished", not a day, and a date column
-- would force them to invent precision they do not have. The board reads it back
-- verbatim on the card.
--
-- The parked state itself is jobs.status = 'deferred'. status has no check
-- constraint, so no constraint change is needed here; the anon insert policy is
-- pinned to status = 'inquiry' and is deliberately left alone, so the public
-- intake form cannot create a job that is already parked.
alter table public.jobs add column if not exists deferred_to text;

comment on column public.jobs.deferred_to is
  'Season or timeframe a deferred job is reserved for, e.g. "Spring 2027". Free text; only meaningful when status = ''deferred''.';

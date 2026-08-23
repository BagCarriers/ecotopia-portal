/**
 * Ecotopia Portal - job pipeline lanes, stages and service types.
 *
 * Pure functions only: no network, no DOM, no Supabase client. jobs.html and
 * dashboard.html both need to know which jobs count as real pipeline, so the
 * decision lives here once and is tested by node --test.
 *
 * Written in the same universal style as assets/mapping.js, so the one file loads
 * in the browser via a script tag and in Node via require, both reading
 * globalThis.EcoPipeline.
 *
 * Jobs are the camelCase shape EcoMapping.fromDbAll produces: type, status,
 * deferredTo.
 */
(function (root) {
  // Stages, in board order. 'deferred' is last because it is where work leaves
  // the flow sideways rather than a step on the way to complete.
  const STATUSES = [
    { key: 'inquiry',    label: 'Inquiry' },
    { key: 'site_visit', label: 'Site Visit' },
    { key: 'proposal',   label: 'Proposal' },
    { key: 'active',     label: 'Active' },
    { key: 'complete',   label: 'Complete' },
    { key: 'deferred',   label: 'Reserved' },
  ];

  // All eight service types seen in the live database on 2026-08-23. The intake
  // forms and the Google Form import write these; the New Job form offers them
  // too, so a staff-created job pills the same as an inquiry-created one.
  const TYPE_MAP = {
    pollinator_garden:      { label: 'Pollinator Garden',   cls: 'pill-pollinator' },
    lawn_to_meadow:         { label: 'Lawn to Meadow',      cls: 'pill-meadow' },
    meadow_conversion:      { label: 'Meadow Conversion',   cls: 'pill-meadow' },
    rain_garden:            { label: 'Rain Garden',         cls: 'pill-rain' },
    ecological_landscaping: { label: 'Eco Landscaping',     cls: 'pill-eco' },
    general_landscaping:    { label: 'General Landscaping', cls: 'pill-eco' },
    invasive_removal:       { label: 'Invasive Removal',    cls: 'pill-invasive' },
    herb_garden:            { label: 'Herb Garden',         cls: 'pill-herb' },
    living_willow:          { label: 'Living Willow',       cls: 'pill-willow' },
    project_request:        { label: 'Project Request',     cls: 'pill-request' },
    card_game:              { label: 'Card Game',           cls: 'pill-other' },
    other:                  { label: 'Other',               cls: 'pill-other' },
  };

  // Work that only happens if the state releases grant money. Jordan asked for
  // these to be kept apart from jobs "willing to pay us", because a board that
  // mixes them overstates the pipeline he can actually bank on.
  const GRANT_LANE_TYPES = ['lawn_to_meadow'];

  const statusKeys = new Set(STATUSES.map(s => s.key));

  // An unmapped type still has to read like English on the card. Intake can grow
  // a new service type before anyone edits this file, and raw snake_case in front
  // of the client is the exact bug this module was written to end.
  const titleCase = (s) => String(s)
    .split('_').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  function typeInfo(type) {
    const key = String(type || '').trim();
    if (TYPE_MAP[key]) return TYPE_MAP[key];
    if (!key) return { label: 'Unspecified', cls: 'pill-other' };
    return { label: titleCase(key), cls: 'pill-other' };
  }

  function isGrantDependent(job) {
    return GRANT_LANE_TYPES.includes(String((job && job.type) || '').trim());
  }

  function splitLanes(jobs) {
    const paying = [];
    const grant = [];
    for (const j of jobs || []) (isGrantDependent(j) ? grant : paying).push(j);
    return { paying, grant };
  }

  // Returns a column per stage plus anything whose status matches no stage.
  // Before this existed such a job matched no column and left the board with no
  // error anywhere; adding a sixth status makes that failure more reachable, so
  // the caller is handed the strays to render rather than losing them.
  function groupByStatus(jobs) {
    const columns = {};
    for (const st of STATUSES) columns[st.key] = [];
    const unknown = [];
    for (const j of jobs || []) {
      const st = String((j && j.status) || '').trim();
      if (statusKeys.has(st)) columns[st].push(j);
      else unknown.push(j);
    }
    return { columns, unknown };
  }

  function reservedLabel(job) {
    if (!job || job.status !== 'deferred') return '';
    const when = String(job.deferredTo || '').trim();
    return when ? 'Reserved: ' + when : 'Reserved';
  }

  root.EcoPipeline = {
    STATUSES, TYPE_MAP, GRANT_LANE_TYPES,
    typeInfo, isGrantDependent, splitLanes, groupByStatus, reservedLabel,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/**
 * Job pipeline lane, stage and type logic.
 *
 * Jordan's ask (2026-08-23) was two-part: keep Lawn to Meadow inquiries in their
 * own category because they depend on state grant money and are not guaranteed,
 * and have somewhere to park jobs a client has pushed to a future season. Both
 * are decisions about which bucket a job belongs in, which is logic, so it lives
 * here rather than inline in jobs.html where nothing can test it.
 */
const test = require('node:test');
const assert = require('node:assert');
require('../assets/pipeline.js');
const P = globalThis.EcoPipeline;

// Mirrors the real spread queried out of prod on 2026-08-23: pollinator_garden
// dominates, lawn_to_meadow sits at two different stages (which is exactly why a
// single "Lawn to Meadow" column could not work), and one job is already parked.
const JOBS = [
  { id: 'a', type: 'pollinator_garden',  status: 'proposal' },
  { id: 'b', type: 'pollinator_garden',  status: 'site_visit' },
  { id: 'c', type: 'lawn_to_meadow',     status: 'inquiry' },
  { id: 'd', type: 'lawn_to_meadow',     status: 'site_visit' },
  { id: 'e', type: 'project_request',    status: 'inquiry' },
  { id: 'f', type: 'rain_garden',        status: 'site_visit' },
  { id: 'g', type: 'living_willow',      status: 'proposal' },
  { id: 'h', type: 'general_landscaping', status: 'deferred', deferredTo: 'Spring 2027' },
];

// ── Lanes ────────────────────────────────────────────────────────────────

test('lawn to meadow jobs leave the paying lane entirely', () => {
  // The point of the split: Jordan's main board should count only work that can
  // actually pay. Four of the eight jobs here are grant-dependent or parked.
  const { paying, grant } = P.splitLanes(JOBS);
  assert.deepStrictEqual(grant.map(j => j.id), ['c', 'd']);
  assert.ok(!paying.some(j => j.type === 'lawn_to_meadow'));
});

test('a lawn to meadow job keeps its real stage inside its own lane', () => {
  // This is the reason the grant work is a lane and not a column. Job d is at
  // site visit and must still read as site visit, not as "Lawn to Meadow".
  const { grant } = P.splitLanes(JOBS);
  const cols = P.groupByStatus(grant).columns;
  assert.deepStrictEqual(cols.inquiry.map(j => j.id), ['c']);
  assert.deepStrictEqual(cols.site_visit.map(j => j.id), ['d']);
});

test('splitting loses no job', () => {
  // A silent drop here would quietly hide real leads from the only page that
  // shows them, so assert the arithmetic rather than trusting the filter.
  const { paying, grant } = P.splitLanes(JOBS);
  assert.strictEqual(paying.length + grant.length, JOBS.length);
});

test('an empty board splits into two empty lanes, not undefined', () => {
  assert.deepStrictEqual(P.splitLanes([]), { paying: [], grant: [] });
});

// ── Stages ───────────────────────────────────────────────────────────────

test('every stage gets an array even when nothing is in it', () => {
  // renderKanban maps over the columns; a missing key would throw on .length and
  // take the whole board down rather than showing an empty column.
  const cols = P.groupByStatus([]).columns;
  for (const st of P.STATUSES) assert.deepStrictEqual(cols[st.key], []);
});

test('reserved is a real stage, so parked jobs are on the board', () => {
  const cols = P.groupByStatus(JOBS).columns;
  assert.deepStrictEqual(cols.deferred.map(j => j.id), ['h']);
});

test('a job with an unrecognised status surfaces instead of vanishing', () => {
  // Before this module a status outside the hardcoded list matched no column and
  // the job disappeared from the board with no error anywhere. Expanding the
  // status vocabulary makes that more likely, so it now has to be visible.
  const odd = [{ id: 'x', type: 'other', status: 'on_hold' }];
  const { columns, unknown } = P.groupByStatus(odd);
  assert.deepStrictEqual(unknown.map(j => j.id), ['x']);
  assert.ok(Object.values(columns).every(c => c.length === 0));
});

// ── Reserved badge ───────────────────────────────────────────────────────

test('a parked job reads back the season it was pushed to', () => {
  assert.strictEqual(P.reservedLabel(JOBS[7]), 'Reserved: Spring 2027');
});

test('a parked job with no season still reads as reserved', () => {
  // Staff will drag before they type. The badge must not render "Reserved: ".
  assert.strictEqual(P.reservedLabel({ status: 'deferred' }), 'Reserved');
  assert.strictEqual(P.reservedLabel({ status: 'deferred', deferredTo: '   ' }), 'Reserved');
});

test('a job that is not reserved has no badge', () => {
  assert.strictEqual(P.reservedLabel({ status: 'active', deferredTo: 'Spring 2027' }), '');
});

// ── Types ────────────────────────────────────────────────────────────────

test('every type live in the database has a human label', () => {
  // The bug in Jordan's screenshot: TYPE_MAP held 5 types, intake writes 8, so
  // 21 of 24 cards showed him raw snake_case. These are the 8 seen in prod.
  const live = ['pollinator_garden', 'lawn_to_meadow', 'project_request',
                'general_landscaping', 'living_willow', 'meadow_conversion',
                'rain_garden', 'other'];
  for (const t of live) {
    const info = P.typeInfo(t);
    assert.ok(info.label && !info.label.includes('_'), `${t} has no label`);
    assert.ok(info.cls, `${t} has no pill class`);
  }
});

test('an unmapped type degrades to readable words, not snake_case', () => {
  // Intake can grow a new service type before anyone updates this file.
  const info = P.typeInfo('hedge_row_planting');
  assert.strictEqual(info.label, 'Hedge Row Planting');
  assert.ok(info.cls);
});

test('a job with no type at all does not blow up the card', () => {
  const info = P.typeInfo(undefined);
  assert.ok(info.label);
  assert.ok(info.cls);
});

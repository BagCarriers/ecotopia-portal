const test = require('node:test');
const assert = require('node:assert');
require('../assets/mapping.js');
const { toDb, fromDb, fromDbAll } = globalThis.EcoMapping;

test('toDb converts camelCase top-level keys to snake_case', () => {
  assert.deepStrictEqual(
    toDb({ gardenId: 'g1', estMinutes: 30, sqft: 100, qrToken: 'x' }),
    { garden_id: 'g1', est_minutes: 30, sqft: 100, qr_token: 'x' }
  );
});

test('fromDb converts snake_case top-level keys to camelCase', () => {
  assert.deepStrictEqual(
    fromDb({ garden_id: 'g1', next_due: 'T', created_at: 'C', name: 'n' }),
    { gardenId: 'g1', nextDue: 'T', createdAt: 'C', name: 'n' }
  );
});

test('jsonb values pass through untouched (no deep key mapping)', () => {
  const row = fromDb({ activity_log: [{ ts: 'T1', note: 'hi' }], skills: ['planting'] });
  assert.deepStrictEqual(row.activityLog, [{ ts: 'T1', note: 'hi' }]);
  assert.deepStrictEqual(row.skills, ['planting']);
});

test('fromDbAll maps arrays and tolerates null', () => {
  assert.deepStrictEqual(fromDbAll(null), []);
  assert.deepStrictEqual(fromDbAll([{ a_b: 1 }]), [{ aB: 1 }]);
});

test('toDb passes null/undefined/non-objects through', () => {
  assert.strictEqual(toDb(null), null);
});

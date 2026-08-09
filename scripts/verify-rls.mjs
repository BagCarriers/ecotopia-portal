// Verifies the anon key can do exactly what the public pages need and nothing more.
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/verify-rls.mjs
// NOTE: inserts test rows (name RLS-TEST). Delete them afterwards:
//   delete from intake_submissions where name = 'RLS-TEST';
//   delete from volunteer_applications where name = 'RLS-TEST';
//   delete from checkins where notes = 'RLS-TEST';
//   delete from jobs where title = 'RLS-TEST';
// The view write checks below are supposed to be rejected, so on a healthy database
// they insert nothing. If one of them FAILS it inserted, so also run:
//   delete from volunteers where name = 'RLS-TEST';
//   delete from garden_plantings where species_label = 'RLS-TEST';
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY'); process.exit(2); }

// This harness sends writes on purpose, and every one of them is supposed to be
// refused. Handed a privileged key they all succeed instead, so the run stops being
// a test and becomes an unattended mutation of production: it inserts into four
// tables and PATCHes a real garden. That is not hypothetical, it happened here on
// 2026-08-09 and renamed a live garden to "y". Refuse the key rather than trust the
// operator to have exported the right one.
const keyRole = (k) => {
  if (k.startsWith('sb_secret')) return 'secret';
  const parts = k.split('.');
  if (parts.length !== 3) return null;               // publishable key, not a JWT
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role ?? null; }
  catch { return null; }
};
const role = keyRole(KEY);
if (role && role !== 'anon') {
  console.error(`Refusing to run: the key in SUPABASE_ANON_KEY carries role "${role}", not "anon".`);
  console.error('This script writes, and expects every write to be rejected. A privileged key');
  console.error('would let those writes through and change live data.');
  process.exit(2);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message); }
}
const get = (p) => fetch(`${URL_}/rest/v1/${p}`, { headers: H });
const post = (p, body) => fetch(`${URL_}/rest/v1/${p}`, {
  method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body),
});
const patch = (p, body) => fetch(`${URL_}/rest/v1/${p}`, {
  method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body),
});
const del = (p) => fetch(`${URL_}/rest/v1/${p}`, { method: 'DELETE', headers: H });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// A row id that cannot exist, so PATCH and DELETE probes can never touch real data.
// The point of those probes is the privilege check, which PostgREST performs before
// it ever looks at the filter: a database that still allows the write answers 204
// even when nothing matches, and one that does not answers 401.
const NO_MATCH = 'id=eq.00000000-0000-0000-0000-000000000000';

// Views are the blind spot this file had until 2026-08-09. Both public views are
// security definer, so they read their base table as the owner and bypass its RLS.
// That is deliberate and is the only reason anon can see anything through them. The
// cost is that a write through such a view also bypasses RLS, and Supabase's default
// privileges grant anon insert, update and delete on every new view in public. So a
// view is only read only if someone revoked those, and nothing about reading it
// reveals whether anyone did.
//
// volunteers_public shipped writable from 0001 until 0037. It went unnoticed for
// exactly as long as this harness checked reads and not writes: an anon POST to it
// returned 201 and created a real row in the PII table the view exists to hide.
async function checkViewIsReadOnly(view, insertBody) {
  await check(`anon CANNOT insert into ${view}`, async () => {
    const r = await post(view, insertBody);
    assert(r.status >= 400, `insert allowed (status ${r.status}), row may need deleting`);
  });
  await check(`anon CANNOT update ${view}`, async () => {
    const r = await patch(`${view}?${NO_MATCH}`, insertBody);
    assert(r.status >= 400, `update allowed (status ${r.status})`);
  });
  await check(`anon CANNOT delete from ${view}`, async () => {
    const r = await del(`${view}?${NO_MATCH}`);
    assert(r.status >= 400, `delete allowed (status ${r.status})`);
  });
}

await check('anon reads gardens (200)', async () => {
  const r = await get('gardens?select=id'); assert(r.status === 200, `status ${r.status}`);
});
await check('anon sees zero clients rows', async () => {
  const r = await get('clients?select=id'); const rows = await r.json();
  assert(r.status === 200 && Array.isArray(rows) && rows.length === 0, `got ${r.status} / ${rows.length ?? 'non-array'}`);
});
await check('anon sees zero volunteers rows', async () => {
  const r = await get('volunteers?select=id'); const rows = await r.json();
  assert(rows.length === 0, `leaked ${rows.length} rows`);
});
await check('anon sees zero invoices rows', async () => {
  const r = await get('invoices?select=id'); const rows = await r.json();
  assert(rows.length === 0, `leaked ${rows.length} rows`);
});
await check('anon reads volunteers_public (200)', async () => {
  const r = await get('volunteers_public?select=name'); assert(r.status === 200, `status ${r.status}`);
  // The public view must not expose PII columns like phone.
  const p = await get('volunteers_public?select=phone');
  assert(p.status >= 400, `phone column readable (status ${p.status})`);
});
await checkViewIsReadOnly('volunteers_public', { name: 'RLS-TEST' });

// garden_plantings holds a staff-authored note column, so unlike gardens or tasks the
// table itself is closed to anon and the public reads the view. RLS is row level, so
// a select policy on the table could not have withheld the note; only the projection
// can. See 0036.
await check('anon sees zero garden_plantings rows', async () => {
  const r = await get('garden_plantings?select=id'); const rows = await r.json();
  assert(Array.isArray(rows) && rows.length === 0, `leaked ${rows.length ?? 'non-array'} rows`);
});
await check('anon CANNOT read garden_plantings.note', async () => {
  const r = await get('garden_plantings?select=note'); const rows = await r.json();
  assert(r.status >= 400 || (Array.isArray(rows) && rows.length === 0), `note readable (status ${r.status})`);
});
await check('anon reads garden_plantings_public (200)', async () => {
  const r = await get('garden_plantings_public?select=species_label');
  assert(r.status === 200, `status ${r.status}`);
  // The whole reason the view exists: the note must not be one of its columns, so
  // asking for it is a schema error rather than an empty result.
  const n = await get('garden_plantings_public?select=note');
  assert(n.status === 400, `note column reachable on the view (status ${n.status})`);
});
// Prefer a real garden_id so the insert would genuinely succeed if privileges
// allowed it, rather than failing on a not-null violation and passing vacuously.
const gardenList = await get('gardens?select=id&limit=1');
const gardenRows = await gardenList.json().catch(() => []);
const gardenId = Array.isArray(gardenRows) && gardenRows.length ? gardenRows[0].id : null;
await checkViewIsReadOnly('garden_plantings_public', {
  garden_id: gardenId, species_label: 'RLS-TEST', quantity: 1, planted_on: '2026-01-01',
});

await check('anon CANNOT insert clients', async () => {
  const r = await post('clients', { name: 'RLS-TEST' }); assert(r.status >= 400, `status ${r.status}`);
});
await check('anon CANNOT update gardens', async () => {
  // Prefer targeting a real row so the policy is genuinely exercised; fall back
  // to a no-match filter when the DB is empty (passes vacuously in that case).
  const list = await get('gardens?select=id,name&limit=1');
  const rows = await list.json().catch(() => []);
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  const path = row ? `gardens?id=eq.${row.id}` : 'gardens?name=eq.__nomatch__';
  // Write the row's own current name back, not a new value. If the policy holds this
  // is rejected and the payload is irrelevant; if it does not, the check still fails
  // loudly but the garden is not left renamed. An earlier version sent {name:'y'}
  // and did exactly that to a live row.
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ name: row ? row.name : 'y' }),
  });
  const body = await r.json().catch(() => []);
  assert(r.status >= 400 || (Array.isArray(body) && body.length === 0), `status ${r.status}`);
});
await check('anon CAN insert intake submission', async () => {
  const r = await post('intake_submissions', { name: 'RLS-TEST', phone: '000' });
  assert(r.status === 201, `status ${r.status}`);
});
await check('anon CAN insert volunteer application', async () => {
  const r = await post('volunteer_applications', { name: 'RLS-TEST' });
  assert(r.status === 201, `status ${r.status}`);
});
await check('anon CAN insert checkin', async () => {
  const r = await post('checkins', { notes: 'RLS-TEST', type: 'walkin' });
  assert(r.status === 201, `status ${r.status}`);
});
await check('anon CAN insert inquiry job only', async () => {
  const ok = await post('jobs', { title: 'RLS-TEST', status: 'inquiry' });
  assert(ok.status === 201, `inquiry insert status ${ok.status}`);
  const bad = await post('jobs', { title: 'RLS-TEST', status: 'active' });
  assert(bad.status >= 400, `active insert allowed (status ${bad.status})`);
});
console.log(failures ? `\n${failures} FAILURES` : '\nAll RLS checks passed.');
process.exit(failures ? 1 : 0);

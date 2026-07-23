// Verifies the anon key can do exactly what the public pages need and nothing more.
// Usage: SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/verify-rls.mjs
// NOTE: inserts test rows (name RLS-TEST). Delete them afterwards:
//   delete from intake_submissions where name = 'RLS-TEST';
//   delete from volunteer_applications where name = 'RLS-TEST';
//   delete from checkins where notes = 'RLS-TEST';
//   delete from jobs where title = 'RLS-TEST';
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY'); process.exit(2); }
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
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

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
});
await check('anon CANNOT insert clients', async () => {
  const r = await post('clients', { name: 'RLS-TEST' }); assert(r.status >= 400, `status ${r.status}`);
});
await check('anon CANNOT update gardens', async () => {
  const r = await fetch(`${URL_}/rest/v1/gardens?name=eq.x`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ name: 'y' }),
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

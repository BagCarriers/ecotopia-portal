# Portal-Managed Team Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Meet the team" section on `about.html` editable from the portal, so Jordan can change a name, role, or photo and add or remove people without a deploy.

**Architecture:** A new `team_members` table with anon read and `is_portal_user()` writes, seeded with the eleven current members and their existing repo photos. `about.html` renders from it; a new `manage-team.html` handles CRUD, built from `manage-plants.html`, which already solves photo upload, `static:` resolution, and delete-with-storage-cleanup.

**Tech Stack:** Static HTML, no build. Vanilla JS browser globals. Supabase Postgres + Storage. `node --test` for the suite.

## Global Constraints

- **No em dashes anywhere** (`—`, `–`), in code, copy, docs, or commit messages.
- `esc()` every DB or anon-supplied string interpolated into `innerHTML`. `about.html` is public.
- Write policy is `is_portal_user()`, **never `using (true)`**. Migration 0028 shipped the loose form and needed patching in 0029; this project has an inactive auth account that would otherwise gain write access to public content.
- Attach the `set_updated_at` trigger **at table creation**. 0028 declared an `updated_at` and forgot it, fixed later in 0030.
- `photo_path` convention: `static:<file>` is a repo asset under `assets/img/team/`, charset-guarded so it cannot escape the folder. Any other value is a `gallery` bucket path.
- Migrations applied live via the Management API with **curl, not python urllib** (Cloudflare blocks urllib with HTTP 403 / error 1010). Token: `security find-generic-password -s "Supabase CLI" -w`, POST to `https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query` with `{"query":"..."}`.
- **The Supabase MCP tools point at a DIFFERENT project. Do not use them.**
- **Do not touch live auth.** No minting sessions, creating users, or generating login links.

## Live-system cautions

**The site went public on 2026-08-02 and is taking real orders on PRODUCTION Square keys.** `ecotopianearthcare.com` is live.

The intended day-one result of this whole feature is **no visible change**: the seed reproduces the current team section exactly, photos included. If the public page looks different after deploy, something is wrong.

### Ordering is not optional

The previous feature caused two live breakages by running a schema change ahead of the code that depends on it. Here the dependency runs the other way, so:

**Migration first (Task 1), then the page that reads it (Task 3), then deploy (Task 5).** Deploying an `about.html` that queries a table which does not exist would empty the team section on a live public site.

Task 1 is purely additive, so it is safe to apply on its own and leaves the current hardcoded page working untouched.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0031_team_members.sql` (create) | Table, three policies, trigger, seed of the current eleven |
| `assets/data.js` (modify) | `getTeamMembers` / `getPublicTeam` / add / update / remove / `teamPhotoUrl` |
| `assets/team.js` (create) | `teamInitials(name)` and `teamPhotoSrc(photoPath)`, shared by the public page and the portal, and unit-testable in Node |
| `tests/team.test.js` (create) | Unit tests for both helpers |
| `about.html` (modify) | Render the grid from the table instead of hardcoded figures |
| `manage-team.html` (create) | Portal CRUD page |
| `assets/nav.js` (modify) | One nav entry |
| `docs/OPERATIONS.md` (modify) | Document the table, the convention, and the seed |

Putting the two helpers in `assets/team.js` rather than duplicating them into both pages is deliberate: `teamInitials` is the one piece of real logic in this feature, and a copy in each page is a drift bug waiting to happen. It follows the `assets/pricing.js` precedent, which exists for the same reason and is loadable in both the browser and Node.

---

### Task 1: Migration 0031

**Files:**
- Create: `supabase/migrations/0031_team_members.sql`

**Interfaces:**
- Consumes: existing `is_portal_user()` and `set_updated_at()` (both verified present in production).
- Produces: table `public.team_members` with columns `id, name, role, photo_path, sort, active, created_at, updated_at`, seeded with 11 rows.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0031_team_members.sql`:

```sql
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
insert into public.team_members (name, role, photo_path, sort) values
  ('Jordan Sesame Wild', 'Founder, Manager, Ecological Landscape Designer, Permaculturist, Project Scout, and President of WildOnes Nonprofit.', 'static:team-jordan.jpg', 1),
  ('Jenna Rose Wild', 'Cofounder, Herbalist, Medicine Woman and Guide, Nursery Caretaker, Ecological Landscape Designer, and a Holistic Birth and Postpartum Doula.', 'static:team-jenna.jpg', 2)
on conflict do nothing;
```

**The two rows above are a template, not the full seed.** Extract all eleven with their exact role text from the live `about.html` using the command in Step 2, and write them all into the insert before applying. Copying bios by hand risks a typo on a public page.

- [ ] **Step 2: Generate the seed rows from the real markup**

```bash
cd /Users/bagcarriers/GitHub/ecotopia-portal
python3 - <<'PY'
import re
h = open('about.html').read()
cards = re.findall(
    r'<img src="assets/img/team/([^"]+)"[^>]*alt="[^"]*"[\s\S]*?<h3>([^<]+)</h3>\s*<p>([^<]+)</p>', h)
print(f"-- {len(cards)} members")
for i, (f, name, role) in enumerate(cards, 1):
    n = name.strip().replace("'", "''")
    r = role.strip().replace("'", "''")
    print(f"  ('{n}', '{r}', 'static:{f}', {i}),")
PY
```

Expected: 11 lines. Paste them into the insert, changing the last line's trailing comma to `on conflict do nothing;`.

Sanity-check the names against: Jordan Sesame Wild, Jenna Rose Wild, Kat Weakland, Samuel Mohnkern, Joshua Ritchey, Jordan Sneed, Tricia Lynn, John Peacefire, Brendan, Emily Evey, Russ Replogle.

- [ ] **Step 3: Apply it**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
python3 -c "import json;print(json.dumps({'query':open('supabase/migrations/0031_team_members.sql').read()}))" > /tmp/mig31.json
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data @/tmp/mig31.json
```

Expected: `[]`. The API returns only the last statement's result set.

- [ ] **Step 4: Verify**

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"select sort, name, photo_path, active from team_members order by sort;"}'
curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
 -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
 -d '{"query":"select policyname, cmd, qual from pg_policies where tablename='"'"'team_members'"'"' order by policyname;"}'
```

Expected: 11 rows, sort 1 to 11, every `photo_path` beginning `static:team-`, all `active` true. Three policies, with `tm_staff_write` showing `is_portal_user()`.

Re-run Step 3 once and confirm it still returns `[]` and still shows 11 rows, proving the migration is re-runnable.

- [ ] **Step 5: Verify anon can read it**

```bash
ANON=$(grep -oE "SUPABASE_ANON_KEY['\"]?\s*[:=]\s*['\"][^'\"]+" assets/config.js | sed -E "s/.*['\"]//")
curl -s "https://wibnryfinfwbwwgsyojr.supabase.co/rest/v1/team_members?select=name&order=sort" \
 -H "apikey: $ANON" | head -c 200
```

Expected: a JSON array of names. The public page depends on this.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0031_team_members.sql
git commit -m "feat: migration 0031, portal-managed team members"
```

---

### Task 2: Shared helpers and their tests

**Files:**
- Create: `assets/team.js`
- Create: `tests/team.test.js`
- Modify: `assets/data.js` (beside the plant catalog methods, around line 262)

**Interfaces:**
- Consumes: `DataStore.esc`, and the `list` / `insert` / `update` helpers already in `assets/data.js`.
- Produces:
  - `globalThis.EcoTeam.teamInitials(name: string) -> string` (1 or 2 uppercase letters, `''` for empty input)
  - `globalThis.EcoTeam.teamPhotoSrc(photoPath: string|null, publicUrl: (p: string) => string) -> string|null`
  - `DataStore.getTeamMembers()` (staff, all rows), `DataStore.getPublicTeam()` (active only, sorted), `DataStore.addTeamMember(row)`, `DataStore.updateTeamMember(id, changes)`, `DataStore.removeTeamMember(id)`, `DataStore.teamPhotoUrl(path)`

- [ ] **Step 1: Write the failing tests**

Create `tests/team.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
require('../assets/team.js');
const { teamInitials, teamPhotoSrc } = globalThis.EcoTeam;

test('teamInitials takes the first and last word', () => {
  assert.strictEqual(teamInitials('Jordan Sesame Wild'), 'JW');
  assert.strictEqual(teamInitials('Jenna Rose Wild'), 'JW');
  assert.strictEqual(teamInitials('Kat Weakland'), 'KW');
});

test('teamInitials gives one letter for a single-word name', () => {
  assert.strictEqual(teamInitials('Brendan'), 'B');
});

test('teamInitials handles hyphens, extra spaces and case', () => {
  assert.strictEqual(teamInitials('mary-jane  o\'neill'), 'MO');
  assert.strictEqual(teamInitials('  Russ   Replogle  '), 'RR');
});

test('teamInitials is empty for empty or missing input', () => {
  assert.strictEqual(teamInitials(''), '');
  assert.strictEqual(teamInitials(null), '');
  assert.strictEqual(teamInitials(undefined), '');
});

test('teamPhotoSrc resolves a static: path to the repo folder', () => {
  const url = (p) => 'BUCKET/' + p;
  assert.strictEqual(teamPhotoSrc('static:team-jordan.jpg', url), 'assets/img/team/team-jordan.jpg');
});

test('teamPhotoSrc refuses a static: path that tries to escape the folder', () => {
  const url = (p) => 'BUCKET/' + p;
  assert.strictEqual(teamPhotoSrc('static:../../etc/passwd', url), null);
  assert.strictEqual(teamPhotoSrc('static:a/b.jpg', url), null);
});

test('teamPhotoSrc sends any other value to the bucket', () => {
  const url = (p) => 'BUCKET/' + p;
  assert.strictEqual(teamPhotoSrc('team/abc-123.jpg', url), 'BUCKET/team/abc-123.jpg');
});

test('teamPhotoSrc returns null when there is no photo', () => {
  const url = (p) => 'BUCKET/' + p;
  assert.strictEqual(teamPhotoSrc(null, url), null);
  assert.strictEqual(teamPhotoSrc('', url), null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../assets/team.js'`

- [ ] **Step 3: Write the helpers**

Create `assets/team.js`:

```js
/**
 * Ecotopia - team member display helpers, shared by about.html and manage-team.html.
 * Kept in one file rather than copied into both pages: teamInitials is the only real
 * logic in the feature, and two copies would drift. Loadable in the browser (script
 * tag) and in Node (require) for tests, the same as assets/pricing.js.
 */
(function (root) {
  // First letter of the first word plus first letter of the last word. A single-word
  // name gives one letter. Used for the placeholder tile when a member has no photo.
  function teamInitials(name) {
    const words = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const first = words[0][0];
    const last = words.length > 1 ? words[words.length - 1][0] : '';
    return (first + last).toUpperCase();
  }

  // 'static:<file>' is a repo asset under assets/img/team/. The charset guard means a
  // crafted value cannot escape that folder. Anything else is a gallery-bucket object,
  // resolved by the caller's publicUrl function so this file needs no Supabase client.
  function teamPhotoSrc(photoPath, publicUrl) {
    if (!photoPath) return null;
    const p = String(photoPath);
    if (p.slice(0, 7) === 'static:') {
      const file = p.slice(7);
      return /^[A-Za-z0-9._-]+$/.test(file) ? 'assets/img/team/' + file : null;
    }
    return publicUrl(p);
  }

  root.EcoTeam = { teamInitials, teamPhotoSrc };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: PASS, the 8 new tests plus the 20 existing ones.

- [ ] **Step 5: Add the DataStore methods**

In `assets/data.js`, after the plant catalog block (the `plantPhotoUrl` method around line 292):

```js
    // Team members (staff-editable, rendered on the public about page). Public
    // listing only: a row here grants no portal access. The public page reads
    // active rows over anon; staff methods use the authenticated policy and see
    // hidden rows too. Uploads land in the gallery bucket under team/<uuid>.jpg;
    // 'static:<file>' paths are repo assets and are never touched in storage.
    getTeamMembers: () => list('team_members', 'sort'),
    getPublicTeam: async () =>
      fromDbAll(unwrap(await sb.from('team_members').select('*')
        .eq('active', true).order('sort').order('name'))),
    addTeamMember: (r) => insert('team_members', r),
    updateTeamMember: (id, ch) => update('team_members', id, ch),
    removeTeamMember: async (id) => {
      unwrap(await sb.from('team_members').delete().eq('id', id));
    },
    teamPhotoUrl: (photoPath) =>
      sb.storage.from('gallery').getPublicUrl(photoPath).data.publicUrl, // sync
```

Check the surrounding `list` / `insert` / `update` helpers take the arguments used here before assuming; match whatever the plant methods immediately above do.

- [ ] **Step 6: Verify the file still parses**

Run: `node --check assets/data.js && node --check assets/team.js`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add assets/team.js tests/team.test.js assets/data.js
git commit -m "feat: team display helpers and data access"
```

---

### Task 3: Public team grid

**Files:**
- Modify: `about.html` (script tags near line 20, `.team-card` CSS around line 43, the team section markup at lines 86 to roughly 200)

**Interfaces:**
- Consumes: `EcoTeam.teamInitials`, `EcoTeam.teamPhotoSrc`, `DataStore.getPublicTeam()`, `DataStore.teamPhotoUrl`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Load the helper AND data.js**

`about.html` currently loads `supabase.js`, `config.js`, `supabase-client.js`, `mapping.js` and `site.js` at lines 22 to 26. **It does not load `assets/data.js`**, which is where `getPublicTeam` and `teamPhotoUrl` live, so both tags are needed:

```html
<script src="assets/data.js"></script>
<script src="assets/team.js"></script>
```

Put them after `mapping.js` and before `site.js`, matching the order other pages use. Several public pages already load `data.js`, so this is not a new pattern.

- [ ] **Step 2: Add the initials tile style**

Beside the existing `.team-card img` rule:

```css
.team-card .team-initials {
  width: 100%; aspect-ratio: 1 / 1; display: flex;
  align-items: center; justify-content: center;
  background: var(--cream); color: var(--green-dark);
  font-family: 'Fraunces', serif; font-size: 3rem; line-height: 1;
  letter-spacing: 0.02em;
}
```

- [ ] **Step 3: Replace the hardcoded figures with a container**

Replace the eleven `<figure class="team-card reveal">` blocks inside `<div class="team-grid">` with nothing, leaving:

```html
      <div class="team-grid" id="teamGrid"></div>
```

Keep the surrounding section, eyebrow, heading and lead paragraph exactly as they are.

- [ ] **Step 4: Render from the table**

In the page's inline script:

```js
  // The team grid is portal-managed content. Everything here comes from the
  // database, so every value is escaped before it reaches innerHTML.
  async function renderTeam() {
    const grid = document.getElementById('teamGrid');
    if (!grid) return;
    let members = [];
    try { members = await DataStore.getPublicTeam(); } catch (e) { members = []; }
    if (!members.length) { grid.innerHTML = ''; return; }
    grid.innerHTML = members.map(function (m) {
      const src = EcoTeam.teamPhotoSrc(m.photoPath, DataStore.teamPhotoUrl);
      const visual = src
        ? '<img src="' + esc(src) + '" alt="' + esc(m.name) + '" loading="lazy" width="400" height="400">'
        : '<div class="team-initials" aria-hidden="true">' + esc(EcoTeam.teamInitials(m.name)) + '</div>';
      return '<figure class="team-card reveal">' + visual +
        '<figcaption><h3>' + esc(m.name) + '</h3>' +
        '<p>' + esc(m.role) + '</p></figcaption></figure>';
    }).join('');
  }
```

Call `renderTeam()` where the page does its other startup work.

**The cards carry `class="reveal"`, and the scroll-animation observer in `assets/site.js:468` runs before they exist.** It selects `.reveal:not([data-r])` and stamps `data-r` on what it observes, so it is idempotent and safe to re-run. Whatever function wraps that block needs calling again after `renderTeam()` resolves, or the eleven cards stay invisible at opacity 0. Read `assets/site.js` around line 458 to find its exported name before wiring this.

This is the single most likely way to ship a blank team section, so verify it in a browser rather than by reading.

Note the property names are camelCase (`photoPath`, not `photo_path`): `DataStore` maps rows through `EcoMapping.fromDbAll`.

- [ ] **Step 5: Confirm the page renders the same eleven people**

Serve the repo locally and load `about.html`, or extract the inline script and run it in Node against the live anon endpoint. Either way, assert:

- eleven cards render
- the first two are Jordan Sesame Wild then Jenna Rose Wild
- every card has an `<img>`, none has an initials tile (all eleven are seeded with photos)
- the rendered HTML matches the pre-change markup in name and role text

- [ ] **Step 6: Verify the inline script parses**

```bash
python3 - <<'PY' > /tmp/about.inline.js
import re
h=open('about.html').read()
print('\n'.join(re.findall(r'<script(?![^>]*src=)[^>]*>([\s\S]*?)</script>', h)))
PY
node --check /tmp/about.inline.js
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add about.html
git commit -m "feat: about page renders the team from the database"
```

---

### Task 4: Portal manage-team page

**Files:**
- Create: `manage-team.html`
- Modify: `assets/nav.js` (the `links` array near line 7)

**Interfaces:**
- Consumes: everything from Task 2, plus `DataStore.resizeImage(file, 1600)`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Build the page from manage-plants.html**

Copy `manage-plants.html` as the starting point and strip it to the team's fields. It already implements every mechanism needed: photo upload with resize, `static:` resolution, delete-with-storage-cleanup, an active toggle, and sort ordering. Keep its structure, class names and comment voice so the two pages read as one system.

The table lists: photo thumbnail, name, role, sort, a Show-on-website pill, and row actions.

The editor form has: name, role, photo (upload or replace), sort, and a "Show on website" checkbox.

Upload and delete helpers, adapted from the plant equivalents:

```js
async function uploadTeamPhoto(file) {
  const blob = await DataStore.resizeImage(file, 1600);
  const path = `team/${crypto.randomUUID()}.jpg`;
  const up = await window.ecoSupabase.storage.from('gallery')
    .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
  if (up.error) throw new Error(up.error.message);
  return path;
}
// Best-effort removal of a gallery object. 'static:' paths are the eleven original
// repo files and must never be deleted from storage, because they are not in storage.
async function removeTeamPhotoObject(path) {
  if (!path || String(path).slice(0, 7) === 'static:') return;
  try { await window.ecoSupabase.storage.from('gallery').remove([path]); } catch (e) { /* ignore */ }
}
```

Deleting a member calls `removeTeamPhotoObject(member.photoPath)` and then `DataStore.removeTeamMember(id)`. Replacing a photo removes the old object the same way, so unused uploads do not accumulate.

- [ ] **Step 2: Add the "logins are elsewhere" line**

Under the page heading, in the same muted style `manage-plants.html` uses for its own note:

```html
<p class="page-note">Everyone here appears on the public About page. This does not
create a portal login: sign-in accounts are managed on the Users page.</p>
```

- [ ] **Step 3: Add the nav entry**

In `assets/nav.js`, in the `links` array beside the other content managers:

```js
    { href: 'manage-team.html', label: 'Team', icon: '🧑‍🌾' },
```

Place it near `manage-plants.html` and `manage-shop.html` rather than at the end, so related pages sit together. Check how those two are labelled in the array and match the convention.

- [ ] **Step 4: Verify the inline scripts parse**

```bash
python3 - <<'PY' > /tmp/mt.inline.js
import re
h=open('manage-team.html').read()
print('\n'.join(re.findall(r'<script(?![^>]*src=)[^>]*>([\s\S]*?)</script>', h)))
PY
node --check /tmp/mt.inline.js && node --check assets/nav.js
```
Expected: clean.

- [ ] **Step 5: Verify writes work, and that deleting a `static:` member spares the repo file**

You cannot sign in to the portal, so exercise the data path directly rather than claiming it works by inspection. **Do not modify any of the eleven seeded rows.** Create your own.

Give the throwaway row a `static:` photo path, so the delete actually exercises the guard in `removeTeamPhotoObject` rather than only the happy path:

```bash
TOKEN=$(security find-generic-password -s "Supabase CLI" -w)
Q() { curl -s -X POST "https://api.supabase.com/v1/projects/wibnryfinfwbwwgsyojr/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"query\":\"$1\"}"; }
Q "insert into team_members (name, role, photo_path, sort) values ('ZZ TEST MEMBER','Tester','static:team-jordan.jpg',99) returning id, name;"
Q "update team_members set role = 'Tester Two' where name = 'ZZ TEST MEMBER' returning role, updated_at;"
Q "delete from team_members where name = 'ZZ TEST MEMBER' returning name;"
Q "select count(*) as should_be_11 from team_members;"
```

The `update` must return a non-null `updated_at`, which proves the trigger from Task 1 is attached.

Then confirm the shared repo file was not collateral damage:

```bash
ls -la assets/img/team/team-jordan.jpg
curl -s -o /dev/null -w "live file: HTTP %{http_code}\n" https://ecotopianearthcare.com/assets/img/team/team-jordan.jpg
```

Both must still succeed. A `static:` path names a file in the repo, not an object in the bucket, so nothing in storage should ever have been touched; this check catches a delete helper that forgot the guard.

- [ ] **Step 6: Verify anon cannot write**

```bash
ANON=$(grep -oE "SUPABASE_ANON_KEY['\"]?\s*[:=]\s*['\"][^'\"]+" assets/config.js | sed -E "s/.*['\"]//")
curl -s -X PATCH "https://wibnryfinfwbwwgsyojr.supabase.co/rest/v1/team_members?name=eq.Brendan" \
 -H "apikey: $ANON" -H "Content-Type: application/json" \
 -H "Prefer: return=representation" -d '{"role":"HACKED"}'
```

Expected: an empty array or a permission error, and `Brendan`'s role unchanged when you read it back. **If this succeeds, stop: the write policy is wrong.**

- [ ] **Step 7: Commit**

```bash
git add manage-team.html assets/nav.js
git commit -m "feat: portal page for managing team members"
```

---

### Task 5: Documentation and deploy

**Files:**
- Modify: `docs/OPERATIONS.md`

- [ ] **Step 1: Document it**

Add a "Team members" section covering: the table and its columns; that a row is public listing content only and grants no portal access; the three policies and that writes are gated on `is_portal_user()`; the `static:` versus bucket convention and that `static:` files are never deleted from storage; that uploads go to `gallery` under `team/<uuid>.jpg` and are resized to 1600px; that a member with no photo renders an initials tile; and that `about.html` shows only `active` rows ordered by `sort`.

Update the migration repair note from 0001-0030 to 0001-0031.

Read each sentence back against the line it describes before committing. Two review rounds on the previous feature each found a confidently wrong statement in this file.

- [ ] **Step 2: Deploy**

```bash
netlify deploy --prod --dir=.
```

- [ ] **Step 3: Verify the public page is unchanged**

```bash
curl -s https://ecotopianearthcare.com/about.html -o /tmp/live-about.html
grep -c "team-card" /tmp/live-about.html
for n in "Jordan Sesame Wild" "Jenna Rose Wild" "Russ Replogle" "Brendan"; do
  printf "  %-20s %s\n" "$n" "$(grep -c "$n" /tmp/live-about.html)"
done
```

The grid is rendered by JavaScript, so `curl` will show the empty container rather than eleven cards. **Confirm it in a real browser instead**: load `https://ecotopianearthcare.com/about.html`, count eleven cards, and check the photos load and the order starts with Jordan then Jenna.

If the section is empty in the browser, the most likely cause is the anon read policy or a JS error; check the console before changing anything.

- [ ] **Step 4: Commit**

```bash
git add docs/OPERATIONS.md
git commit -m "docs: portal-managed team members"
```

---

## After this ships

Jordan can add, edit, hide, reorder and remove team members from the portal. Nothing about the public page changes on day one; the seed reproduces it exactly.

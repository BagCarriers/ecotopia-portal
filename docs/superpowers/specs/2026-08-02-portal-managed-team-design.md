# Portal-managed team page

Design approved 2026-08-02. The "Meet the team" section on `about.html` becomes editable from the portal, so Jordan can change a name, role, or photo, and add or remove people, without a developer.

## Why

The eleven team members are hardcoded as `<figure>` blocks in `about.html`, with photos as repo files under `assets/img/team/`. Every change is a code edit and a deploy. People join, leave, and change roles more often than the site gets deployed.

## Decisions

1. **A team member is public listing content only.** It grants no portal access. Logins stay on the Users page, and the manage-team page says so in one line of copy, at the point where Jordan would otherwise assume otherwise.
2. **Both a "Show on website" toggle and a real Delete.** The toggle covers the common case, someone taking a season off, without losing their bio or photo. Delete covers a genuine mistake, such as a duplicate row.
3. **A member with no photo renders a cream tile with their initials.** Jordan can list a new hire the day they start and photograph them later, and the grid keeps its rhythm.

## Data model

New table `public.team_members`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk, default `gen_random_uuid()` | |
| `name` | text not null | |
| `role` | text not null | the blurb under the name |
| `photo_path` | text | null renders initials |
| `sort` | integer not null default 0 | display order, founders first |
| `active` | boolean not null default true | the "Show on website" toggle |
| `created_at` | timestamptz not null default now() | |
| `updated_at` | timestamptz | maintained by the `set_updated_at` trigger |

**RLS, matching the other public-content tables:**

- `tm_anon_read`: anon SELECT, `using (active)`
- `tm_staff_read`: authenticated SELECT, `using (true)`
- `tm_staff_write`: authenticated ALL, `using (is_portal_user()) with check (is_portal_user())`

**Corrected after implementation.** This design originally specified `tm_anon_read` as
`using (true)`, which is what migration 0031 shipped. That was wrong: it left a hidden
member's name, role and photo readable by anyone holding the anon key, so the
`.eq('active', true)` in `DataStore.getPublicTeam` was a client-side filter rather than a
boundary, and the hide toggle did not actually hide anyone. Migration 0032 scopes the
policy to `using (active)`, matching every sibling content table (`plant_species`,
`plant_kits` and `merch_items` gate anon on `active`; `events` gates on `is_public`).
`tm_staff_read` is deliberately left at `using (true)` so the portal can still list
hidden rows for unhiding.

The write gate is `is_portal_user()`, not `using (true)`. Migration 0028 shipped a settings table with the looser policy and it had to be patched in 0029; the project has an inactive auth user who would otherwise have write access to public-facing content.

Attach the `set_updated_at` trigger at creation. Migration 0028 declared an `updated_at` and forgot the trigger, which had to be fixed in 0030.

## Photo handling

`photo_path` follows the convention already used by gardens and plants:

- `static:team-jordan.jpg` resolves to the repo file `assets/img/team/team-jordan.jpg`
- any other value is a path in the public `gallery` bucket

Uploads reuse the existing helpers rather than reimplementing them: `DataStore.resizeImage(file, 1600)` downscales, and the object is stored at `team/<uuid>.jpg`. Deleting a member best-effort removes its bucket object, and never touches a `static:` file.

Cropping needs no new work. `.team-card img` is already `aspect-ratio: 1 / 1; object-fit: cover`, so any aspect ratio is center-cropped to a square. Note this is a center crop, so an off-centre subject can lose the top of a head. That is existing site-wide behavior and is accepted.

## Public page

`about.html` renders the team grid from the table instead of hardcoded markup: filtered to `active`, ordered by `sort`, then `name` as a stable tiebreak.

Every value from the database is `esc()`d. This is a public page.

`alt` text is the member's name, matching the current markup.

Initials come from the name: first letter of the first word, plus first letter of the last word if there is more than one. Single-word names give one letter. The tile uses the cream background the `img` rule already sets.

## Portal page

New `manage-team.html`, built from `manage-plants.html`, which already solves photo upload with resize, `static:` resolution, delete-with-storage-cleanup, an active toggle, and sort ordering.

Per member: name, role, photo (upload or replace), sort, "Show on website" toggle, Delete.

Add the nav entry alongside the other content managers.

One line of copy: portal logins are managed on the Users page, not here.

## Migration 0031

Creates the table, policies, and trigger, then seeds the eleven current members with their existing `static:` photo paths and `sort` 1 through 11 in their present order:

1. Jordan Sesame Wild, 2. Jenna Rose Wild, 3. Kat Weakland, 4. Samuel Mohnkern, 5. Joshua Ritchey, 6. Jordan Sneed, 7. Tricia Lynn, 8. John Peacefire, 9. Brendan, 10. Emily Evey, 11. Russ Replogle

Roles are copied verbatim from the current markup. Nobody retypes eleven bios.

**The seed reproduces the current page exactly, so the public site does not change appearance the day this ships.** That matters: the domain went public on 2026-08-02 and is taking real orders.

## Testing

Added to the existing `npm test` suite:

1. The initials helper: two words, one word, three words, hyphenated surname, empty string.
2. `photo_path` resolution: a `static:` value resolves to the repo path, a bucket path resolves to a storage URL, null resolves to no image.

Live checks, read-only except where noted:

3. Anon can SELECT `team_members`.
4. Anon cannot write, verified with a real anon-key PATCH that must affect no rows.
5. Deleting a seeded member leaves its repo file untouched, verified on a throwaway row rather than a real one.

Plus the existing `node --check` pass over extracted inline scripts.

## Rollout

1. Apply migration 0031 via the Management API, using curl rather than urllib.
2. Deploy the site.

**Order matters.** The migration is purely additive and the new `about.html` requires the table, so the migration must land first. Deploying the page before the table exists would empty the team section on a live site. Two schema-before-code mistakes on the previous feature caused live breakages; the rule is additive schema first, then the code that reads it.

## Out of scope

- Linking team members to `portal_users`, `volunteers`, or job assignments. Decision 1 keeps this a public listing.
- Per-member detail pages. The grid is the whole feature.
- Drag-to-reorder. A numeric `sort` field matches every other manage page.

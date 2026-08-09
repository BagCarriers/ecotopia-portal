# Garden planting records

Date: 2026-08-09
Status: approved design, not yet planned
Repo: ecotopia-portal

## Purpose

Keep a record of what the team has planted at each community garden: what, how many, where
and when. It answers "we planted 2,400 native plants across nine sites since 2024", which is
the sentence grant applications are built on, and it gives the public garden cards something
real to say.

## Scope

This spec was originally half of a combined mapping-and-plantings design. Investigating the
client's Google My Maps showed the geography half is three times the size it looked (see
`2026-08-09-garden-geography-findings.md`), so the two were split. **Plantings ship first**,
because they have no external dependency and every month of delay is a month of planting
history nobody captured.

Out of scope, deliberately: anything to do with maps or coordinates; attributing plantings
to individual volunteers; tracking survival against iNaturalist observations. Each was
considered and dropped.

## Current state, measured

- **No planting record exists.** `planting_suggestions` is the public "suggest a site" form
  and is unrelated.
- Nine gardens exist in `gardens`. The client's own map shows twenty-nine sites, so the log
  will cover nine of them until the geography spec lands. This is a known, accepted gap, not
  an oversight.
- There is **no historical planting data to import.** The Pawpaw map's "Pawpaw Plantings"
  layer holds 100 placemarks, but none carry a description and most are named "Point 40" or
  "Point 47". They are location dots, with no species, date or count. The log starts empty.
- `plant_species` holds 50 wildflowers. The habitat kits reference American Plum, Buttonbush
  and Summersweet, which are not among them.

## Schema

Migration `0035_garden_plantings.sql`, additive only. New table `garden_plantings`:

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | uuid pk | |
| `garden_id` | uuid not null | FK `gardens(id)` on delete cascade |
| `species_id` | uuid | FK `plant_species(id)` on delete set null, nullable. An optional link to the shop, never the name itself |
| `species_label` | text **not null** | What was planted, always. `check (length(trim(species_label)) > 0)` |
| `quantity` | integer not null | `check (quantity > 0)` |
| `planted_on` | date not null | |
| `note` | text | |
| `created_at` | timestamptz not null default now() | |

**`species_label` is mandatory and `species_id` is decoration.** The label is the durable
record of what went into the ground; the foreign key only adds "and it happens to be in our
shop". Choosing a catalogue species in the picker fills the label from its common name, so
staff never type it twice, but the label is what every surface renders.

This is deliberately simpler than the obvious alternative, a nullable label with a
"one-of-two must be present" constraint. That version gives two ways to name a plant and
forces every reader to handle both. Here there is one.

**A planting must be able to name a species outside the catalogue.** The kits already
reference trees and shrubs that are not among the 50 catalogue wildflowers. Requiring a
foreign key would make a large share of real plantings unloggable.

**On delete set null for `species_id`, not cascade.** Deleting a species from the catalogue
must not erase the historical fact that it was planted. The row keeps its label, quantity and
date, and simply stops linking to a shop page.

RLS follows the sibling content tables exactly: anonymous select, staff all via
`is_portal_user()`. No anonymous write path.

An index on `garden_id` is worth having here, unlike the 50-row `plant_species` case: this
table grows without bound and is always read per garden.

## Portal

**Per garden.** `garden-detail.html` gains a Plantings section following the existing
`section-header` pattern used by Maintenance Tasks at line 407. Add, edit and delete rows.
The species field is a picker over `plant_species` with a free-text fallback; choosing a
catalogue species fills `species_label` with its common name.

**Totals.** A single line: total plants and distinct species, for the current year and all
time, across all gardens. This exists because deriving that figure by hand from a list is
exactly the friction that stops a grant application getting written.

## Public

Each garden card on `community-gardens.html` gains a summary line, for example "412 native
plants, 23 species", with the species names behind a disclosure so a well-planted site
cannot wreck the card layout. Cards for gardens with no plantings show nothing at all,
rather than a zero.

Every value reaching `innerHTML` passes through `esc()`, per the repo convention.
`species_label` and `note` are staff-entered free text and are untrusted.

## Testing

Following the existing `node --test` pattern:

- A planting with a blank or whitespace-only `species_label` is rejected, whether or not a
  `species_id` is present.
- Quantity must be positive; zero and negative are rejected.
- Deleting a catalogue species leaves its planting rows intact, with the label still
  readable and the link gone.
- Totals arithmetic: distinct species counted correctly when the same species is planted at
  several gardens and on several dates, and quantities summed across both.
- `esc()` covers `species_label` and `note` on both the portal and the public surface.
- A garden with no plantings renders no summary line at all, not "0 plants".

## Failure modes

| Failure | Behaviour |
| --- | --- |
| A species is deleted from the catalogue | Planting rows survive with their label; only the shop link disappears |
| A garden is deleted | Its plantings cascade away with it, which is correct: they described that site |
| Staff enter an implausible quantity | Accepted if positive. This is a record of what a human says they planted, not a validated inventory |
| A planting names a species outside the catalogue | Normal, expected, and the reason the label is free text |

## Open questions

None blocking. The historical-data question raised in the earlier combined draft is settled:
no structured planting history exists to import.

One thing to watch rather than decide now: the log covers nine gardens while the client's map
shows twenty-nine. If Jordan starts logging plantings at sites the portal does not know
about, that pressure is the signal that the geography spec has become urgent.

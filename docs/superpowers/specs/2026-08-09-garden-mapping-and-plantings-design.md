# Garden mapping and planting records

Date: 2026-08-09
Status: approved design, not yet planned
Repo: ecotopia-portal

## Purpose

Give every community garden a real coordinate, show them on a map the public can browse,
and keep a record of what the team has planted at each one.

Two independent units in one spec. The map works without the plantings and the plantings
work without the map, but each makes the other worth more, and both are small.

## Current state, measured

- Nine gardens. Eight carry a real street address; the ninth, Pawpaw Pathways and Zebra
  Swallowtail Trails, is a route across Blair and neighbouring counties rather than a place.
- No garden has coordinates. `gardens` holds `name, address, sqft, qr_token, description,
  map_mid, form_url, photo_path` and nothing spatial.
- Only Reciprocity Community Food Forest records an area, 60,984 sq ft.
- One garden has its own map (`map_mid`, the Pawpaw trail). The overview map on
  `community-gardens.html:49` is a hardcoded Google My Maps embed that no code can drive.
- **No planting record exists.** `planting_suggestions` is the public "suggest a site" form
  and is a different thing entirely.

## Scope

In scope: coordinates on gardens, a staff pin-dropping map, a public garden map, a planting
event log, portal editing for it, a public summary per garden, and a staff totals line.

Out of scope, deliberately: mapping individual beds or zones inside a garden; replacing the
Pawpaw trail embed; survival tracking against iNaturalist observations; attributing
plantings to individual volunteers. Each was considered and dropped to keep this shippable.

## Decisions taken

**Leaflet with OpenStreetMap tiles, loaded from CDN.** No API key, no billing account, no
vendor relationship, free at any volume. It matches the existing CDN pattern already used
for `qrcodejs`. The alternative, the Google Maps JavaScript API, is the same product
currently costing this business roughly 300 dollars a fortnight on another client, and it
would need a Cloud project, a restricted key and a card on file for nine pins.

**OpenStreetMap requires a visible "(c) OpenStreetMap contributors" credit.** Same class of
obligation as the iNaturalist photo credits shipped on 2026-08-09, and it is satisfied the
same way: a real, legible line, not a hidden one.

**No geocoding service.** Staff drop the pin by hand, with the address shown beside the map
for reference. For nine one-time placements this is faster than integrating a geocoder, and
a hand-placed pin is more accurate than a geocoded street address for a rain garden sitting
behind a library.

**Coordinates are nullable, and that is load-bearing.** Pawpaw Pathways is a trail, so it
keeps its existing `map_mid` embed, gets no coordinates, and does not appear as a pin. A
garden on private land can also be deliberately left off the map. The public map renders
only gardens that have coordinates; every garden keeps its card either way.

**A planting may name a species outside the catalogue.** The habitat kits already reference
American Plum, Buttonbush and Summersweet, none of which are among the 50 catalogue
wildflowers. Requiring a foreign key to `plant_species` would make a large share of real
plantings unloggable, so the schema accepts either a catalogue reference or free text.

## Schema

Migration `0035_garden_mapping_and_plantings.sql`, additive only.

On `gardens`:

| Column | Type | Meaning |
| --- | --- | --- |
| `lat` | `numeric(9,6)` | Latitude, null when the garden is not mapped |
| `lng` | `numeric(9,6)` | Longitude, null when the garden is not mapped |

`numeric(9,6)` gives about 0.1 m resolution, far more than a garden pin needs, and avoids
floating point drift on a value staff will compare by eye.

New table `garden_plantings`:

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | uuid pk | |
| `garden_id` | uuid not null | FK `gardens(id)` on delete cascade |
| `species_id` | uuid | FK `plant_species(id)` on delete set null, nullable. An optional link to the catalogue, never the name itself |
| `species_label` | text **not null** | What was planted, always. `check (length(trim(species_label)) > 0)` |
| `quantity` | integer not null | `check (quantity > 0)` |
| `planted_on` | date not null | |
| `note` | text | |
| `created_at` | timestamptz not null default now() | |

**`species_label` is mandatory and `species_id` is decoration.** The label is the durable
record of what went in the ground; the foreign key only says "and it happens to be in our
shop". Choosing a catalogue species in the picker fills the label from its common name, so
staff never type it twice, but the label is what every surface renders.

This is deliberately simpler than the obvious alternative, a nullable label with a
"one-of-two must be present" constraint. That version has two ways to name a plant and every
reader has to handle both. Here there is one.

**On delete set null for `species_id`, not cascade.** Deleting a species from the catalogue
must not erase the historical fact that it was planted. The row keeps its label, quantity and
date, and simply stops linking to a shop page.

RLS follows the sibling content tables exactly: anonymous select, staff all via
`is_portal_user()`. No anonymous write path.

## The map

**Portal, garden add and edit.** `gardens.html` already has an add form at line 116 and
`garden-detail.html` an edit section at line 251. Both gain a small Leaflet map with a
single draggable marker. Dropping or dragging the marker sets the `lat` and `lng` inputs; a
"clear pin" control nulls them. The map opens centred on Blair County when a garden has no
coordinates yet.

**Public, `community-gardens.html`.** The hardcoded Google My Maps overview iframe at line
49 is replaced by a Leaflet map reading `gardens` over anon. One marker per garden with
coordinates; the popup shows the name and links to that garden's card lower on the page.
Per-garden `map_mid` embeds inside the cards, rendered by `gardenCardInner` at line 133, are
left exactly as they are, so the Pawpaw trail map is untouched.

Replacing only the overview map is the point: it is the one map that should reflect the
database and currently cannot.

## Plantings

**Portal.** `garden-detail.html` gains a Plantings section following the existing
`section-header` pattern used by Maintenance Tasks at line 407. Add, edit and delete rows.
The species field is a picker over `plant_species` with a free-text fallback; choosing a
catalogue species fills `species_label` with its common name automatically.

**Portal totals.** A single line above the per-garden list: total plants and distinct
species across all gardens, for the current year and all time. This exists because "we
planted 2,400 native plants across nine sites" is the sentence that goes into a grant
application, and deriving it by hand from a list is exactly the friction that stops it being
written.

**Public.** Each garden card gains a summary line, for example "412 native plants, 23
species", with the species names behind a disclosure so a well-planted site cannot wreck the
card layout. Cards for gardens with no plantings show nothing rather than a zero.

Every value reaching `innerHTML` passes through `esc()`, per the repo convention. Planting
notes and `species_label` are staff-entered free text and are untrusted.

## Testing

Following the existing `node --test` pattern:

- A planting with a blank or whitespace-only `species_label` is rejected, whether or not a
  `species_id` is present.
- Quantity must be positive.
- Deleting a catalogue species leaves its planting rows intact, with the label still
  readable and the link gone.
- The public map renders a marker only for gardens with both `lat` and `lng`, and a garden
  with one of the two set is treated as unmapped rather than plotted at a wrong point.
- Totals arithmetic: distinct species counted correctly when the same species is planted at
  several gardens and on several dates.
- `esc()` covers `species_label` and `note` on both the portal and public surfaces.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| CDN unreachable, so Leaflet does not load | The garden cards still render; the map area shows a short "map unavailable" line rather than an empty box |
| A garden has `lat` but not `lng` | Treated as unmapped, never plotted |
| A species is deleted from the catalogue | Planting rows survive with their `species_label` |
| Staff enter an implausible coordinate | Visible immediately, since the pin is placed on a map rather than typed |

## Open questions

1. **Historical plantings.** Does Jordan have records of what is already in the ground at
   these nine sites? If a spreadsheet exists, importing it is a small addition and makes the
   public summary useful on day one instead of a year from now. If not, the log starts empty
   and fills as the team plants. This spec assumes it starts empty.
2. **Private sites.** All nine current gardens are parks, libraries and churches, so public
   pins are uncontroversial. If a garden on private residential land is ever added, the
   nullable coordinates are the mechanism for leaving it off the map, but nobody has decided
   whether that should be a deliberate toggle rather than simply omitting the pin.

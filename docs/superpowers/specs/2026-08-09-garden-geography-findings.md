# Garden geography: research findings, ahead of a spec

Date: 2026-08-09
Status: research only, no design approved yet
Repo: ecotopia-portal

This is not a spec. It records what the client's existing Google My Maps actually contain,
so the eventual geography spec starts from measured fact rather than assumption. It exists
because that investigation tripled the apparent size of the work and forced a split: the
planting log ships first, as `2026-08-09-garden-plantings-design.md`.

## What was measured

Both maps are already public, since they are embedded on the live site. Google My Maps
exports KML at `https://www.google.com/maps/d/kml?mid=<mid>&forcekml=1`. Fetched 2026-08-09.

**Eco-Community Gardens** (`mid 1svkTJPU3IDO2qzA2r2Lezr03P4Ol5Wg`), one layer, 109 placemarks:

| Geometry | Count |
| --- | --- |
| Points (garden sites) | 29 |
| Polygons (areas within sites) | 79 |
| Lines | 1 |

**Pawpaw Pathways** (`mid 1MWDTLstCAOrHauRWVuwRsVcpFmUaTOQ`), three layers, 154 placemarks:
Waterways (49), Pawpaw Plantings (100), Zebra Swallowtail current population (5). 102 points,
51 lines, 1 polygon.

## The four findings that matter

**1. The portal knows about nine gardens. The map has twenty-nine.** Sites present on the
map and absent from the database include the Nehemiah Project, 7th Ave Church, Oak Ave,
Beale Avenue, Pleasant Valley Elementary, and several Bellwood locations (Bicycle Trail,
Bridge, The Church / Artisan Gallery). The public community gardens page is therefore
showing under a third of the client's actual work.

**2. The 79 polygons are per-feature, not per-site, and every one is named.** Examples:
`Altoona (Reciprocity) Food Forest`, `Rain Garden a`, `Rain Garden B`, `Riparian Buffer`,
`Meadow`, `Altoona (Holy-Trinity) Fruit Trees`. Zero unnamed. Areas run from 5 m2 to
8,816 m2, median 83 m2 (about 900 sq ft).

This is the thing that changes the design. Mapping zones *inside* a garden was ruled out as
too expensive at the start of the brainstorm; the client has already done it by hand for 79
areas. Importing that work is cheap. Building a drawing tool so he can redo it is not.

**3. There is no structured planting history.** The "Pawpaw Plantings" layer sounds like
exactly what was wanted, but none of its 100 placemarks carry a description and most are
named "Point 40", "Point 47". They are location dots: no species (all pawpaw by
definition), no dates, no counts. Nothing to import.

**4. KML placemarks carry no stable identifier.** Re-importing after the client edits his
map would have to match on name and geometry, which is guesswork. This is what makes an
ongoing sync a bad idea rather than merely more work.

## Decisions already taken

**One-time import; the portal becomes the source of truth afterwards.** Frank chose this
over an ongoing sync, consistent with the rule set after the Star Bev and B&A catalogue-sync
work: one system owns the data, the other is a vessel.

**That decision has a cost the spec must pay.** "The portal owns it" means the client has to
be able to maintain 79 polygons there. Dragging a pin is trivial; editing polygons needs a
real drawing tool (Leaflet-Geoman or Leaflet.draw). Importing his shapes and leaving him
unable to redraw one would take away a tool he uses and not replace it, which is the worst
available outcome.

**Leaflet with OpenStreetMap tiles, from CDN.** No API key, no billing account, free at any
volume, and it matches the existing CDN pattern used for `qrcodejs`. The Google Maps
JavaScript API is the same product costing this business roughly 300 dollars a fortnight on
another client. OSM requires a visible "(c) OpenStreetMap contributors" credit, the same
class of obligation as the iNaturalist photo credits.

## Hazards the spec must handle

- **Duplicate gardens.** Map names do not match database names: `Altoona Food Forest -
  Reciprocity Community Food Forest` against `Reciprocity Community Food Forest`. A careless
  import creates 29 new rows alongside the existing 9. The match has to be human-reviewed.
- **Pawpaw Pathways is a route, not a point**, and should keep its existing `map_mid` trail
  embed rather than being forced into a pin.
- **Private land.** All 29 current sites are parks, libraries, churches and schools, so
  public pins are uncontroversial. That may not hold for site 30.
- The overview map hardcoded at `community-gardens.html:49` is the one map that should
  reflect the database and currently cannot. Per-garden `map_mid` embeds rendered by
  `gardenCardInner` at line 133 are a separate thing and should be left alone.

## What this unblocks

Garden coordinates are the sole blocker on the iNaturalist garden biodiversity feeds, which
are already designed in `2026-08-08-inaturalist-species-enrichment-design.md` under spec B.

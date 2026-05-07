# 3DEP LiDAR Phase 1 — Verification Findings (Pre-Build)

> Status: **Stopped before code.** The Phase 1 brief assumed 3DEP LiDAR
> would give reliable roof-feature extraction across the RSS service
> footprint (FL, MN, TX). Verification against the live Microsoft
> Planetary Computer STAC catalog says otherwise. This document records
> what we tested, what we found, and what to do instead.

## What we verified

### 1. Collection ID confirmed

`3dep-lidar-dsm` is the correct STAC collection ID. The catalog also
exposes 9 sibling 3DEP collections (`hag`, `intensity`, `dtm`, `copc`,
etc.). Brief was correct on this point.

API surface confirmed:
- Search: `POST https://planetarycomputer.microsoft.com/api/stac/v1/search`
- Body: `{ "collections": ["3dep-lidar-dsm"], "intersects": {Point}, "limit": N }`
- Response: standard STAC ItemCollection with `features[].assets.data.href`
  pointing at COG URLs

### 2. Coverage is spotty across the RSS footprint

Tested against the three exact addresses the brief named:

| Property | Lat / Lng | 3DEP DSM coverage |
|---|---|---|
| Orlando downtown | 28.5384, -81.3792 | **None** |
| Clermont, FL | 28.5544, -81.7711 | **None** |
| Lakeland, FL | 28.0395, -81.9498 | **None** |

Bbox-widening reveals the actual pattern: **3DEP coverage is
project-by-project**, not blanket. Central FL has exactly two captures
indexed in MPC right now:

- `FL_Upper_Saint_Johns_2017_LAS_2019` (Brevard / Indian River, lat ~28.07–28.61)
- `FL_PeaceRiver_2014_LAS_2018` (southern Polk, lat ~27.65–27.87)

Lakeland (28.04) is in the **gap between** these two projects. Orlando,
Kissimmee, Tampa metro, Sarasota: none of the major FL urban areas RSS
operates in have current 3DEP DSM coverage.

A sanity check against TX San Antonio returned 1 item
(`TX_Central_B2_2017`). Same project-driven pattern — not blanket.

### 3. Captures are 5–11 years old

Where coverage *does* exist, the captures are stale:

| Project | Year captured | Years stale |
|---|---|---|
| FL_Upper_Saint_Johns_2017 | 2017 | 9 yrs |
| FL_PeaceRiver_2014 | 2014 | 12 yrs |
| TX_Central_B2_2017 | 2017 | 9 yrs |

For a FL contractor whose addresses cycle post-hurricane (Ian 2022, Idalia
2023), any roof modified or replaced since the LiDAR capture won't
appear in the DSM. This is the same staleness problem we already
mitigate on Solar API imagery (the "imagery 6y old" warning chip), but
worse — Solar refreshes every 1–2 years, 3DEP refreshes every 5–10.

### 4. Resolution is borderline for roof-feature extraction

3DEP DSM at 2m GSD means each elevation cell averages a 4 m² ground
footprint. A typical residential roof ridge is ~30 cm thick. You can
derive **overall slope direction** from a 2m DSM (the brief's pitch-
inference goal), but you **cannot reliably extract individual ridge
positions, eave edges, or hip lines** — the cell averaging blurs them.

The seamless national 3DEP DEM is even worse — 10m or 30m resolution.
Useful for storm overland flow analysis, useless for roof geometry.

## What this means for the Phase 1 plan

The brief's success criteria were:

> Aggregate results show median absolute pitch delta of >2 degrees vs
> Solar API on complex roofs (proving Solar's inference is wrong).
> Surface area calculations diverge by 5–15% on complex roofs (proving
> the pricing impact is real).

**These can't be measured.** The 10-address ground-truth set lives
inside `scripts/eval-truth/` — those are real customer addresses in the
FL metros where RSS operates. None of them have 3DEP DSM coverage.
`getLidarRoofMetrics` would return `null` on every single fixture.

The brief explicitly anticipated this:

> If the eval results don't show meaningful divergence, that's still a
> successful Phase 1 — we'll know not to invest further.

We're at that conclusion before writing the code. Building the eval
harness still produces the same answer (`null` × 10 fixtures), just at
the cost of 2–3 hours of dev time and a `geotiff` dep we'd have to
maintain.

## Recommendation

**Do not proceed with 3DEP Phase 1 as scoped.** The data isn't there
for the customer base. Three real alternatives, each genuinely useful:

### Option A — Nearmap or EagleView fresh-imagery upgrade tier

Real, FL-comprehensive, sub-foot resolution, refreshed every 3–6 months.
Already used by adjusters writing the carrier-side estimates RSS
competes against. Gates Solar-mask under-trace correction with a
$1–5/lookup premium tier the rep can opt into for high-stakes claims.
Pricing model: surcharge billed per-estimate, not flat platform fee.

### Option B — Sentinel-2 change detection via Microsoft Planetary Computer

We confirmed Sentinel-2 *does* have full FL coverage with 10m optical
imagery refreshed every 5 days. Useless for roof tracing, **excellent
for "is this roof different than it was 6 weeks ago"** — pull
pre-storm + post-storm imagery for the same address, flag visible
changes. Pairs with the BigQuery NOAA storm history we already have.
Free, no marginal cost, no new dep.

### Option C — Build our own training set + roof-pitch model

JobNimbus integration (Phase 2 in the strategic plan) gives us tens of
thousands of closed-job addresses with rep-confirmed pitch, sqft, and
material. After 6 months that's a labeled dataset bigger than any
public LiDAR collection covering RSS's exact properties. Train a small
roof-pitch model on the satellite tiles + rep ground truth; deploy via
Modal at <$0.01/inference. **This is the moat.** 3DEP would have been a
nice supplement to it but isn't a substitute.

## What we shipped

- This document, recording the verification findings so we don't
  re-litigate the same conclusion in 3 weeks.
- No code changes. No new deps. No new lib/, no new app/api/, no scripts/.

## Order of preference if you still want LiDAR-grade pitch data

1. **Nearmap API** — paid, but covers FL densely and refreshes quarterly.
2. **EagleView Direct API** — paid, but matches the carrier reports
   adjusters are already comparing to.
3. **3DEP** — keep on the watch list; FL coverage *will* improve
   post-2025 hurricane recovery flights, just not today.
4. **County-level GIS** — Polk, Hillsborough, Orange counties publish
   property elevation contour data at parcel resolution. Free, but every
   county is a different schema and update cadence.

## When 3DEP becomes worth revisiting

Three triggers, any of which:

1. Microsoft Planetary Computer adds a new FL 3DEP project covering
   Tampa / Orlando / Lakeland metros (check the catalog quarterly via
   `curl https://planetarycomputer.microsoft.com/api/stac/v1/collections | grep -i FL`).
2. RSS expands into a state with comprehensive 3DEP coverage (CO, UT,
   parts of CA — all have wall-to-wall 1m DSM today).
3. The brief widens to Phase 2 (async enrichment) and we want LiDAR as
   one of N parallel signals — at which point sparse coverage is fine
   because Solar API still carries the rest.

Until then, the time is better spent on JobNimbus integration + a
proprietary roof-pitch model trained on rep ground truth. That's the
moat the brief was actually trying to build, with data we'll definitely
have.

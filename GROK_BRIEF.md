# Voxaris Pitch — Imaging Pipeline Brief

> Paste this into Grok and ask: **"What other tools / data sources should I add for higher-accuracy roof imaging? Anything I'm missing?"**

---

## What we're building

A roofing-estimate platform with two faces:

- **B2B internal tool** (`/`) — sales reps type an address, get a precise estimate with measurements, line items, and a branded PDF in <5 seconds
- **B2C lead-gen wizard** (`/quote`) — homeowners get a rough range and submit contact info → routed to a roofing contractor

The core technical problem is **measuring a roof from satellite imagery accurately enough to price a job that costs $8k–$50k.**

## What "exact imaging" needs to deliver

For each property address we need:

1. **Roof outline (polygon)** in lat/lng coords — vertices accurate to ~1 ft
2. **Per-facet polygons** — multi-gable / hip-roof properties have 2–8 facets, each with its own pitch and azimuth
3. **Roof material identification** — asphalt 3-tab vs architectural vs metal vs tile (drives $/sqft 2–6×)
4. **Pitch (slope)** — affects waste factor, labor surcharge, safety risk
5. **Penetrations** — chimneys, skylights, vents, satellite dishes (each adds line items)
6. **Damage signals** — missing shingles, moss, discoloration, tarps, ponding (visual condition for insurance work)
7. **Ground / context** — # stories, attached structures, complexity rating
8. **Property metadata** — year built, lot size, beds/baths

## Current imaging stack (what we have)

| Layer | Source | Cost | Strength |
| --- | --- | --- | --- |
| **Address autocomplete** | Google Places API (New) | ~$2.83 / 1k requests | Best in class |
| **Geocode → lat/lng** | Same | included | Same |
| **Satellite raster (zoom 20)** | Google Static Maps API | ~$2 / 1k tiles | ~0.15 m/pixel in US suburbs. Critical input — every other vision/segmentation step reads this exact tile. |
| **Roof per-facet polygons** | Google Solar API `buildingInsights:findClosest` | Free up to ~10k/day, then paid | Returns axis-aligned bboxes per facet, building footprint, segment count, per-facet pitch + azimuth — but bboxes are useless as-is on non-north-aligned homes |
| **Roof binary mask (raster)** | Google Solar API `dataLayers:get` | Same | Returns GeoTIFF binary mask (~ground truth segmentation from Google's photogrammetry). Beats SAM/OSM/AI when available. |
| **Building footprint polygon** | OpenStreetMap (Overpass API) | Free | Vector polygon; manually traced by community. Often misses extensions / porches. |
| **AI roof segmentation** | Replicate Grounded SAM 2 (Meta) | ~$0.005 / call | Pixel-precise mask of "roof" object on the satellite tile. Filter rejects masks not centered on the lat/lng |
| **AI roof segmentation (alt)** | Replicate Roboflow "Satellite Rooftop Map v3" | ~$0.005 / call | Roof-specific instance segmentation, won a bake-off vs SAM on hip roofs |
| **Material / age / damage / penetrations** | Anthropic Claude Sonnet 4.6 vision | ~$0.015 / call | Reads the same satellite tile, returns structured JSON: material, age, complexity, visible features, visible damage, sales notes, penetration positions |
| **3D mesh (photogrammetry)** | Google Photorealistic 3D Tiles via Cesium | Paid per session | Used to extract roof polygon by raycasting elevation samples — true geometric height |
| **Aerial cinematic flyover** | Google Aerial View API | $0.005 / video | MP4 of property from drone-level POV |
| **Street view panorama** | Google Street View Static / Maps JS Panorama | $7 / 1k loads | On-the-ground reference photo |
| **Property metadata** | ATTOM Data API basicprofile | Free 250/mo, then paid | Year built, beds/baths, lot size, building sqft |
| **Storm history** | NOAA Severe Storms via Google BigQuery public dataset | Free up to 1 TB/mo | Hail / tornado / wind events near the property in last N years |
| **Weather (current)** | Google Weather API | Negligible | Temp, humidity, wind |

## Polygon fusion (priority order)

We currently fuse 5 polygon sources, picking the highest-priority one that passes validators:

1. Solar API mask (when in coverage and centered)
2. Roboflow rooftop segmentation
3. Cesium 3D mesh elevation extraction
4. Grounded SAM 2 × OSM building intersection
5. Claude vision pixel-trace fallback

User can drag vertices to override any of these. Final polygon drives sqft, perimeter, ridge/valley/eave/rake lengths, and waste calc.

## Where we're WEAK or UNCERTAIN

1. **Per-facet polygons are still rough.** Solar gives bboxes (axis-aligned). Roboflow gives ONE polygon for the whole roof, no per-facet breakdown. Cesium 3D mesh CAN segment facets via slope discontinuity but our extraction is one polygon. **We need per-facet polygons with consistent vertex labeling across sources.**

2. **Damage detection is shallow.** Claude vision is OK at "missing shingles / moss / tarp visible" but can't quantify (% coverage, severity). For insurance claims this matters a lot.

3. **Penetration sizing is a guess.** Claude estimates `approxSizeFt` but it's eyeball-level on a 0.15m-resolution tile. Pipe boots vs vent stacks vs chimneys all look similar.

4. **No multi-temporal change detection.** Same property in 2022 vs 2026 imagery would show storm damage. We have access to imagery date via Solar API but don't compare.

5. **Imagery freshness varies.** Solar API imagery ranges from 2018 to 2024 depending on region. A roof replaced in 2023 might still appear as the old shingle on Google's tile. We don't currently surface this risk to the rep.

6. **Slate, wood shake, EPDM/TPO membrane** — material classes Claude can identify but we don't price (we only have asphalt 3-tab / architectural / metal-standing-seam / concrete tile in the engine).

7. **Roof obstructions (overhanging trees, snow cover, shadows)** — degrade every visual pipeline. We don't quantify confidence based on these.

8. **Drone / on-site photos** — our reps take 20+ on-site photos per inspection. We have no pipeline to ingest, tag, and use them. This is the biggest single accuracy improvement available.

## What I want from Grok

Specifically (rank-order recommendations would be ideal):

1. **Higher-resolution satellite or aerial sources?** What's available beyond Google? (Nearmap, Vexcel, EagleView, Maxar, Planet, USGS NAIP, drone imagery providers, lidar?). Per-image cost vs per-area subscription. US coverage. Imagery refresh cadence.

2. **Better roof-segmentation models?** Beyond Grounded SAM 2, Roboflow's rooftop model. Open-source weights or hosted APIs that segment to per-facet (not just whole-roof). DeepGlobe, SpaceNet, EagleView's API?

3. **Material classifier specifically for roofs.** Single-purpose, trained on shingle/metal/tile/membrane samples. We're using a general-purpose VLM (Claude); is there a specialist?

4. **Lidar / DEM / DSM data for pitch + facet detection.** USGS 3DEP, OpenTopography, commercial. Would beat photogrammetry for slope accuracy.

5. **Drone footage providers we can integrate?** DroneBase, DroneDeploy, etc. — APIs for ordering / ingesting drone runs of a specific address.

6. **Multi-temporal change detection libraries.** Sentinel-2 vs Google's Solar imagery for "is this roof newer than X" — open-source libraries (PyTorch, xView2) or hosted services.

7. **Anything else** that materially improves measurement accuracy or material/damage detection that we haven't listed.

## Constraints

- **Budget:** ~$0.05 / estimate is our soft cap on imaging-related API spend. We're at ~$0.04 today.
- **Latency:** entire estimate flow is <5 seconds for the rep. New imaging tools that take >2 sec must run async (post-estimate enrichment is OK).
- **US-first.** International coverage is nice-to-have but not required.
- **Stack:** Next.js 16 + Node 24 (Vercel), TypeScript. We can call any HTTP API; harder to integrate things that need GPU machines or non-Node SDKs.

---

End of brief.

# For Ethan — Tier A + B + C Handoff

**Date:** 2026-05-14
**Status:** All three tiers shipped to `main`. Next estimate you run will exercise the new pipeline end-to-end.
**Latest commits:**

- `5d293b3` feat(roof-engine): Tier A LiDAR pipeline + R3F/Cesium visual layer
- `82e3a7a` feat(roof-engine): Tier B multiview oblique refinement
- `0b7a543` refactor(roof-engine): delete legacy buildDetailedEstimate + flashing-from-complexity

---

## TL;DR

The estimator now runs on a single unified pipeline:

```
runRoofPipeline(address)
   1. tier-a-lidar   → null when LIDAR_SERVICE_URL is unset (current state)
   2. tier-c-solar   → wins on most Orlando addresses (Solar API HIGH coverage)
   3. tier-c-vision  → fallback when Solar 404s (rural / no-coverage)
```

After the pipeline returns RoofData, the `/internal` rep tool optionally fires Tier B (multiview Roof Inspector) to refine pitches, object sizes, and detect wall-to-roof junctions — gated by `ENABLE_TIER_B_REFINEMENT=1`.

The customer-facing 3D model (`/quote`) renders from Google Photorealistic 3D Tiles for Tier B/C, and switches to the new `RoofViewer` (Tier A.2) when a LiDAR-derived RoofData is available.

**Default state without any new env vars:** Tier C is fully active. Tier A and Tier B are silently skipped. You can use the rep tool today and it'll behave like the polished version of Tier C that shipped before.

**To turn on Tier B:** set `ENABLE_TIER_B_REFINEMENT=1`. That's it — ~10s extra per estimate, ~$0.03-0.05 per refined estimate.

**To turn on Tier A:** deploy the Modal Python service and set `LIDAR_SERVICE_URL`. ~30 min of one-time setup.

---

## What changed, tier by tier

### Tier C (shipped pre–this-session, now also touched by debug sweep)

The foundation. Already on `main` when this session started. Brought up to date by this sweep:

- Unified RoofData schema (`types/roof.ts`) — single contract every source produces and every consumer reads.
- Pipeline orchestrator (`lib/roof-pipeline.ts`) — tries sources in priority order, returns degraded RoofData (`source: "none"`) when all fail.
- Pricing engine (`lib/roof-engine.ts`) — replaces the old `buildDetailedEstimate` with per-facet shingle pricing at continuous pitch + feature-driven flashing math.
- `/internal` + `/quote` both consume the new pipeline via `/api/roof-pipeline`.
- v2 saved-estimate shape (`EstimateV2`) with loader shim for v1 legacy estimates.

### Tier B — Multiview Roof Inspector (new)

What it does: after Tier C produces a RoofData, the rep tool captures 1 top-down + 4 oblique screenshots from Cesium, sends them to Claude vision, and refines:

- **Pitch per facet** — replaces satellite-derived pitch with shadow-confirmed pitch.
- **Object dimensions** — refines chimney / skylight / dormer width × length from rough vision guesses.
- **Wall-to-roof junctions** — detects step-wall / headwall / apron that Tier C can't see from top-down alone. Each contributes LF to a new flashing line item.
- **Cricket flashing** — +20% chimney LF when a chimney is wider than 30".

After refinement, RoofData carries `refinements: ["multiview-obliques"]`, confidence bumps by +0.10 (capped at 0.95), and three new line items can appear in the estimate:

- `FLASH WALL` — wall step flashing (non-dormer)
- `FLASH HEAD` — headwall flashing
- `FLASH APRN` — apron flashing

Files added:

```
app/api/roof-inspector/route.ts        ← POST endpoint, rate-limited "expensive"
lib/sources/multiview-source.ts        ← mergeRefinement() + client adapter
components/Roof3DViewer.tsx            ← new onMultiViewCaptured callback
components/roof/DetectedFeaturesPanel  ← "✓ Inspector" badge + wall-step LF row
lib/roof-engine.ts                     ← new FLASH WALL/HEAD/APRN line items
scripts/verify-roof-engine.ts          ← +4 tests (36/36 PASS)
```

**Architectural divergence from the spec:** the locked decisions doc called for Tier B to run synchronously *inside* `runRoofPipeline` on the server. In practice, the multiview capture is a Cesium WebGL operation that only works in a real browser. The doc-aligned alternative would be headless Chrome with Cesium pre-rendering server-side — significantly more infrastructure. My implementation chains the refinement client-side immediately after the pipeline returns. The end-state contract matches the doc (`RoofData` with `refinements: ["multiview-obliques"]`); the orchestration is just browser-driven instead of server-driven. If you want it server-side, that's the first decision below.

**Surface coverage:** Tier B currently only fires on `/internal` (rep tool), not `/quote` (customer tool). Reasons: cost-conscious for customer-facing flows, and only the rep has the time budget to wait the extra ~10s. See decisions below.

### Tier A — LiDAR + 3D Visual Layer (new)

**A.1 — Measurement.** A Modal-hosted Python service that:

1. Pulls USGS 3DEP LiDAR for the parcel (cached 24h).
2. Ground-classifies + isolates roof points.
3. Region-growing plane segmentation.
4. Alpha-shape boundaries → facet polygons → pitch/azimuth from real plane normals.
5. Dihedral-angle edge classification (no bearing heuristics).
6. YOLOv8 object detection on the ortho render.
7. Returns RoofData with `source: "tier-a-lidar"` and `confidence: 0.95` (demoted to 0.75 when LiDAR is stale, 0.50 on partial coverage).

When `LIDAR_SERVICE_URL` is set, this slots in as the highest-priority source in `runRoofPipeline`. When unset, it returns null silently → pipeline falls through to Tier C. The build is green either way.

Files added:

```
services/roof-lidar/
   modal_app.py          ← Modal stub + web_endpoint + persistent volume
   api.py                ← FastAPI orchestrator wiring 9 stages
   coverage_check.py     ← 3DEP S3 manifest lookup
   pull_lidar.py         ← LAZ fetch + cache + bbox filter
   isolate_roof.py       ← ground/height/footprint/wall filter + normal estimation
   segment_planes.py     ← region-growing plane segmentation
   build_facets.py       ← alpha-shape + Douglas-Peucker + pitch/azimuth
   topology_graph.py     ← facet adjacency + dihedral-based edge classification
   detect_objects.py     ← YOLO inference on ortho render
   compute_flashing.py   ← TS-matching flashing math
   freshness_check.py    ← LiDAR-vs-imagery date delta
   requirements.txt
   README.md             ← deploy steps + local dev

lib/sources/lidar-source.ts             ← TS adapter calling the Modal endpoint
lib/roof-pipeline.ts                    ← registers tier-a-lidar first
.env.example                            ← documents LIDAR_SERVICE_URL etc
```

**A.2 — Visual layer.** A new 3D viewer that overlays LiDAR-derived facets/edges/objects on Google Photorealistic 3D Tiles:

```
components/roof/RoofViewer.tsx          ← Cesium 3D Tiles + facet/edge/object overlays
app/(internal)/page.tsx                 ← mounts RoofViewer when source === "tier-a-lidar"
app/quote/page.tsx                      ← same, plus interactive=false for customers
```

Color scheme: cool blues for low-slope (<18.43°), greens for typical pitches, warm reds for steep (>38°). Edges color-coded by type (ridge red, hip orange, valley blue, eave green, rake dashed-green, step-wall purple). Objects show kind-labeled markers.

When no LiDAR data is available (the common case until Modal is deployed), the existing `Roof3DViewer` keeps owning the 3D slot. Zero regression for Tier B/C users.

**A.2 PDF export.** `app/api/roof-export-pdf/route.ts` + `lib/puppeteer-orbit.ts` are wired as 503-until-deps stubs. They return a clear "export not configured" message until you install Puppeteer + `@sparticuz/chromium-min`. The rep-side button can be wired now and start working as soon as the deps land. Implementation outline is in `lib/puppeteer-orbit.ts`.

---

## Debug & audit sweep (post-tier-A)

Bugs found and fixed in this final sweep:

1. **PDF + measurements panel didn't surface Tier B wall flashing.** `flashingLf` and `stepFlashingLf` in the `RoofLengths` summary only summed Tier C fields. Fixed in `lib/pdf.ts`, `app/(internal)/page.tsx`, `app/dashboard/estimate/page.tsx` — `flashingLf` now includes headwall + apron; `stepFlashingLf` now includes wall-step.
2. **`lib/sources/lidar-source.ts` was silently no-op on unconfigured deploys.** Added a once-per-process log so it's obvious in production logs that Tier A isn't wired up yet.

Things audited and confirmed safe (no changes needed):

- v2 estimate save flow already persists `refinements` (it's just a RoofData field).
- v2 `/p/[publicId]` renderer reads line items directly — new `FLASH WALL/HEAD/APRN` codes surface as ordinary line items.
- `priceRoofData` handles `tier-a-lidar` source through the same per-facet shingle path as `tier-c-solar` (no special case needed).
- Caches: `roof-pipeline` caches primary RoofData (Tier C); `roof-inspector` caches refinement patches. Both keyed by lat/lng, expire in 1h.
- Roof3DViewer capture effect now fires when either `onMultiViewVerified` OR `onMultiViewCaptured` is wired — no regression for the legacy polygon-verify flow.

---

## Setup checklist

### 1. Env vars (Vercel project settings or `.env.local`)

A new `.env.example` lists everything. The new ones for this work:

| Variable | When to set | Effect |
|---|---|---|
| `ENABLE_TIER_B_REFINEMENT=1` | When you want to enable oblique refinement on `/internal` | Adds ~10s to estimates; ~$0.03-0.05 per refined estimate; +0.10 confidence; new wall-step line items |
| `LIDAR_SERVICE_URL` | After deploying the Modal service | Activates Tier A; LiDAR-measured RoofData replaces Solar for covered addresses |
| `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` | Only for CI deploys of Modal | Not needed at Next.js runtime |

Everything else (Anthropic, Google Maps, Supabase, Upstash, Sentry) is unchanged from before.

### 2. Deploy the Modal Python service (when you're ready for Tier A)

```bash
# One-time setup
pip install modal
modal token new

# From repo root:
cd services/roof-lidar
modal deploy modal_app.py
```

Modal prints two URLs after a successful deploy. Set the `/extract-roof` URL as `LIDAR_SERVICE_URL` in Vercel project env.

The full deploy walkthrough — including local dev mode without Modal — is in `services/roof-lidar/README.md`.

### 3. Verify on the next estimate

After deploying with whatever env vars you've set:

1. Open `/` (rep tool) and run an estimate against **8450 Oak Park Rd, Orlando FL 32819** — known-complex 17-facet roof.
2. Watch the browser console (DevTools → Console). You should see:
   - `[roof-pipeline] pipeline_source_picked` with `source: "tier-c-solar"` (or `"tier-a-lidar"` if Tier A is on).
   - `[telemetry] flashing_detected` with chimney / skylight / dormer / vent counts.
   - If `ENABLE_TIER_B_REFINEMENT=1`: `[telemetry] tier_b_attempted` then `tier_b_succeeded` after the 5-image capture completes (~10s).
3. Check the "Detected features" panel on the right side of the rep view. You should see facets / edges / object counts. If Tier B refined, you should also see a "✓ Inspector" badge and a "Wall-to-roof: step XX LF, ..." line if any junctions were detected.
4. Expected headline numbers per the spec for Oak Park Rd:
   - Tier C only: ~64 LF total flashing (chimney + skylight + dormer + valley).
   - Tier C + B (refinement on): ~104 LF total flashing (adds wall-step + cricket).
   - Tier A (when deployed): same ballpark, with `source: "tier-a-lidar"` and the new 3D RoofViewer rendering on `/internal`.

If you don't see the expected output, check the console for `[telemetry] tier_b_failed` or `[roof-pipeline] all sources failed` — those carry the reason in the payload.

---

## Decisions I'd ask you about

These are the things I'd have surfaced if pausing weren't off the table. None of them block the system from working as-is — but they're the choices most worth a second pair of eyes.

### 1. Python service host — confirm Modal?

The locked decisions doc said **Modal**. I built against Modal's API (`modal_app.py`, `image.apt_install`, persistent volumes). Reasoning was solid: pay-per-invocation matches bursty estimator usage, native support for PDAL/Open3D, no 50MB function-size cap.

**Alternatives if you'd rather change:**

- **Fly.io** — global edge, always-on small container. Better latency, slightly higher idle cost (~$2-5/mo even when no estimates).
- **Railway** — easiest to set up, single-region. Probably the lowest-friction option if you don't already use Modal.
- **AWS Lambda + container image** — works with PDAL via custom Docker base. Bills per invocation but cold start ~15-30s on these big images.
- **Cloud Run (GCP)** — similar profile to Modal. Better if you're already on GCP for Supabase.
- **Vercel Python Functions** — *won't work*. PDAL native deps exceed Vercel's 50MB function limit.

If you want a different host, the swap is straightforward: the Python pipeline is plain FastAPI; I just wrapped `modal_app.py` around it. To move to e.g. Railway, replace `modal_app.py` with a `Dockerfile` + the same `api.build_local_app()` call, deploy, point `LIDAR_SERVICE_URL` at it. Same TS adapter — no code changes on the Next.js side.

### 2. Puppeteer host for the PDF export

Currently a stub. To enable:

- **Vercel + `@sparticuz/chromium-min`** — works on Vercel functions, fits the 250MB serverless limit, requires installing `puppeteer-core`. Cleanest path if you stay on Vercel. ~30-60s per export.
- **Browserless.io** — managed Chrome-as-a-service, ~$50/mo for a usable plan. Zero deploy effort but adds a vendor.
- **Modal Playwright app** — deploy a sibling Modal app for Playwright, same infra as the LiDAR service. Cohesive but two Modal apps to maintain.
- **Skip the feature for now.** It's rep-on-demand for insurance claim packets — not blocking for normal operation.

I'd lean toward **Vercel + @sparticuz/chromium-min** unless you already use Browserless somewhere else. Implementation outline is in `lib/puppeteer-orbit.ts`.

### 3. Tier B on `/quote` — also enable for customers?

Currently `/internal` only. Rationale: cost ($0.03-0.05 × thousands of quote loads adds up), latency (customer impatience), and the rep can spot-check the inspector's verdict before sharing the proposal.

**Question for you:** do you want Tier B refinement to also fire on `/quote`? Two ways to enable:

- **A.** Persist the refined RoofData server-side (extend the `roof-pipeline` cache to store refined data, so `/quote` reads it without re-paying for inspection).
- **B.** Run inspection on `/quote` directly (same client-side capture as `/internal`).

(A) is the better long-term answer. (B) doubles refinement cost. Either is a few-hour change.

### 4. Tier B default — flip to always-on?

Currently `ENABLE_TIER_B_REFINEMENT=1` is required. Doc said flip to default-on after 100 estimates show stable pricing drift. Your call on when to flip — probably want to:

1. Set the env var on a preview branch first.
2. Run 10-20 estimates against varied properties.
3. Eye the `[telemetry] tier_b_succeeded` logs for sane wall-step LF numbers (anything 0-60 LF per typical residential).
4. Flip the prod env var.

### 5. Vision-fallback addresses and Tier B

When Solar 404s (rural / no Google coverage), the pipeline falls back to `tier-c-vision`. **Tier B refinement does not fire on vision-only RoofData** today — the Roof3DViewer's capture-eligible gate excludes `polygonSource === "ai"` (vision's mapped source).

Reasoning: vision-only produces a single generic facet; refining a single pitch is low-value. But you might want it anyway for the wall-step detection (which works regardless of facet count). Easy fix if you want it: relax the `verifyEligible` filter in `components/Roof3DViewer.tsx`.

### 6. Cricket flashing math

I use **+20% on chimney LF** when Claude reports `needsCricket: true`. The doc said +20%; the real number depends on chimney width / roof pitch. If you have rep feedback that says crickets should be more like +12 LF flat or +30%, easy to adjust in `lib/sources/multiview-source.ts:mergeRefinement`.

### 7. 3DEP coverage check — replace heuristic with proper index?

`services/roof-lidar/coverage_check.py` uses a state-prefix heuristic to find LiDAR tiles in S3. Works for FL/TX/MN (the markets I baked in); falls back to "no coverage" for other states.

Production-quality answer: use `s3://usgs-lidar-public/usgs-3dep-mvt-tindex.gpkg` (GeoPackage) for proper spatial lookup. Requires adding `geopandas` to the Modal image (~80MB extra). Worth doing before you ship Tier A to states beyond FL.

### 8. YOLO object detection model

Currently uses pretrained YOLOv8n (off-the-shelf COCO weights). COCO only contains `satellite dish` from the roof-objects taxonomy — so chimney/skylight/vent/dormer detection from LiDAR is near-zero until a custom-trained model lands. Until then, Tier A's flashing math degrades to "edge-derived + valley/eave only" — still beats Tier C in pitch/area accuracy but doesn't add much on chimney/skylight LF.

Custom training would require ~500-2000 labeled rooftop ortho images. The decisions doc deferred this to Phase 5; agreed.

### 9. Server-side Tier B (revisited)

If you really want Tier B inside `runRoofPipeline` (not chained client-side), the path is:

- Add a headless Chromium worker (probably the same Puppeteer infra above) that hosts a tiny `/internal/capture-frame` page rendering Cesium for a given lat/lng.
- Server-side worker pulls the page, captures the 5 frames, hands them to `mergeRefinement`.
- All client code drops back to just consuming RoofData.

Estimated effort: 1-2 days. Doable but I deliberately deferred since the user-visible behavior is identical either way.

---

## Known limitations / explicit non-goals

These are intentional v1 simplifications. Each has the easy follow-up path documented above:

- **Tier A YOLO is weak** — pretrained model only catches satellite dishes. Custom training is Phase 5.
- **3DEP coverage is heuristic** — needs proper spatial index for states outside FL/TX/MN.
- **Tier B doesn't run on /quote** — by design (cost/latency).
- **Tier B doesn't run on vision-fallback addresses** — gated by the polygon-verify eligibility filter.
- **Wall edge polylines are empty (`[]`)** in Tier B — oblique imagery doesn't give us 3D coords for the wall edges. Per the locked decision. Tier A LiDAR fills in real polylines.
- **PDF export is a stub** — wired but returns 503 until Puppeteer is added.
- **Cricket adder is fixed-percentage** — refine when rep feedback arrives.
- **Step-wall vs headwall vs apron edge typing** — Tier A v1 lumps all three under the `step-wall` edge enum; the LF distribution lives on `FlashingBreakdown`. Refine when needed.

---

## How to verify the system on real estimates

Quickest end-to-end check, in order of effort:

### A. Without any changes (Tier C only — current default state)

1. `npm run dev`
2. Open `/`, type **8450 Oak Park Rd, Orlando FL 32819**, click "Estimate".
3. Confirm: 17 facets, total ~5,485 sqft, ~64 LF flashing, `source: tier-c-solar` in console.

### B. With Tier B enabled

1. Set `ENABLE_TIER_B_REFINEMENT=1` in `.env.local`. Restart dev server.
2. Re-run Oak Park Rd estimate.
3. Watch console for `tier_b_attempted` then `tier_b_succeeded` after ~10s.
4. Confirm: total flashing jumps from ~64 LF to ~104 LF (the +40 LF is the wall-step + cricket).
5. Confirm: "✓ Inspector" badge appears on the Detected features panel.

### C. With Tier A enabled

1. Deploy Modal service per `services/roof-lidar/README.md`.
2. Set `LIDAR_SERVICE_URL` in `.env.local`. Restart dev server.
3. Re-run Oak Park Rd estimate.
4. First call: ~30-90s (Modal cold start). Subsequent: ~10-25s.
5. Confirm: `source: tier-a-lidar` in console.
6. Confirm: `/internal` shows the new RoofViewer (Cesium 3D Tiles with colored facet overlays) instead of the legacy Roof3DViewer.
7. Confirm: pitch numbers match Solar's ±0.3/12 (LiDAR should be at least as accurate as Solar).

---

## Files added this session (high-level)

```
docs/
  for-ethan.md                          ← this doc
  superpowers/specs/                    ← Tier C design + kickoff (already on main)
  superpowers/plans/                    ← Tier C plan (already on main)
  superpowers/tier-b-a-decisions.md     ← Tier B/A locked decisions (already on main)

app/api/
  roof-inspector/route.ts               ← Tier B endpoint
  roof-export-pdf/route.ts              ← Tier A.2 PDF stills + MP4 (stub)

components/roof/
  RoofViewer.tsx                        ← Tier A.2 3D visual layer

lib/
  puppeteer-orbit.ts                    ← Tier A.2 export helper (stub)
  sources/lidar-source.ts               ← Tier A.1 TS adapter
  sources/multiview-source.ts           ← Tier B refinement + client helper

scripts/
  verify-roof-engine.ts                 ← +4 Tier B tests (36/36 PASS)

services/roof-lidar/                    ← Tier A.1 Python microservice
  modal_app.py, api.py, coverage_check.py, pull_lidar.py, isolate_roof.py,
  segment_planes.py, build_facets.py, topology_graph.py, detect_objects.py,
  compute_flashing.py, freshness_check.py, requirements.txt, README.md
```

Files modified:

```
app/(internal)/page.tsx     ← Tier B handler + RoofViewer mount + flashing LF fixes
app/quote/page.tsx          ← RoofViewer mount for Tier A
components/Roof3DViewer.tsx ← new onMultiViewCaptured callback
components/roof/DetectedFeaturesPanel.tsx ← Inspector badge + wall-step row
lib/pdf.ts                  ← flashingLf / stepFlashingLf include Tier B fields
lib/roof-engine.ts          ← FLASH WALL/HEAD/APRN line items
lib/roof-pipeline.ts        ← register tier-a-lidar first
app/dashboard/estimate/page.tsx ← same flashing LF fix
.env.example                ← document new env vars
```

---

## Verification at handoff

- `npm run typecheck` — clean
- `npm run lint` — 1 pre-existing error (unrelated, in `components/quote/EditableRoofMap.tsx`), no new errors
- `npm run build` — green, all new routes registered
- `npx tsx scripts/verify-roof-engine.ts` — 36/36 PASS

You should be able to run an estimate right now and it'll go through the new pipeline. Tier A and Tier B are off by default; flipping their env vars is all it takes to enable them.

— Claude

# Tier B + A — Locked Decisions (Autonomous Build Brief)

**Date:** 2026-05-14
**Author:** Claude (handoff from Tier C session)
**Status:** Decisions locked. Ship without further input unless a "STOP" gate fires.

This doc is the source of truth for Tier B + Tier A. The next Claude session reads it and executes. No brainstorming. Every open question is pre-answered below with reasoning so a human reviewer can override later if needed — but until that override lands, treat each decision as final.

---

## Current state (what's on main as of `0b7a543`)

- **Tier C is shipped.** `runRoofPipeline` orchestrates `tier-c-solar` + `tier-c-vision`. `priceRoofData` is the canonical pricing engine.
- **Phase 4 cleanup is shipped.** Legacy `buildDetailedEstimate`, `flashingFromComplexity`, `deriveRoofLengths*` are deleted. `computeBase` / `computeTotal` kept as fallbacks for `lib/tiers.ts` and `/internal` degraded-state headlines.
- **Telemetry events live:** `pipeline_source_picked`, `vision_failure_tolerated`, `flashing_detected`, `estimate_loaded_legacy_vs_v2`, `complexity_bucket_crossed`.
- **Reference docs:**
  - Kickoff: `docs/superpowers/specs/2026-05-14-roof-engine-abc-kickoff.md`
  - Tier C design: `docs/superpowers/specs/2026-05-14-roof-engine-tier-c-design.md`
  - Tier C plan: `docs/superpowers/plans/2026-05-14-roof-engine-tier-c.md`

---

## Order of operations

1. **Tier B first** (smaller, isolated, fully shippable without external infrastructure).
2. **Tier A.1: Python LiDAR service** (Modal). Write all code + deploy config. If `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are set in the runtime env, deploy. If unset, commit the code and skip deployment — leave a clear deploy script the user can run.
3. **Tier A.2: 3D visual layer** (R3F + Cesium + Puppeteer). Independent of A.1's deployment status.

Push to main after each Tier completes its acceptance gates.

---

## TIER B — Multiview Oblique Refinement

### Goal

Take a Tier C `RoofData` as input. Capture 5 Cesium views (top-down + N/E/S/W obliques at 45°). Send to Claude for refined pitch, wall-step junctions, and refined object dimensions. Return refined `RoofData` with `refinements: ["multiview-obliques"]` and `confidence` bumped by +0.10 (capped at 0.95).

### Pre-answered decisions

| Question | Decision | Reasoning |
|---|---|---|
| Synchronous in pipeline or async? | **Synchronous.** Pipeline returns refined RoofData. | Matches kickoff §3.3 architecture. Async would split the data flow and double the consumer code. |
| Always-on or env-gated? | **Env-gated by `ENABLE_TIER_B_REFINEMENT=1`** for first 100 estimates. **Flip to always-on after that** unless `pricing_diff_v1_vs_v2` telemetry shows >15% pricing drift on simple roofs. | De-risks initial rollout. The default-off period gives the rep a chance to compare /api/roof-pipeline with vs without refinement before it ships to /quote customers. |
| Cost ceiling? | **No cap.** Accept ~$0.10–0.20 per refined estimate (one Claude vision call with 5 images). | Voxaris's pricing dwarfs the cost; accuracy lift on flashing LF more than pays for itself on the first job above $5K. |
| Latency budget? | **Accept up to 15s added to pipeline latency.** Show the existing loader during pipeline; no separate "refining" stage in UI. | Reps already wait for pin-confirm + Solar; 15s more is acceptable when measurement quality jumps materially. |
| Edge polyline geometry for new `step-wall` edges? | **Leave `polyline: []`** in Tier B. | The endpoint receives only oblique imagery, not 3D geometry. Real polylines require LiDAR/3D Tiles (Tier A). For Tier C+B consumers, having `lengthFt` + `type` is enough — the polyline isn't load-bearing for pricing or rendering. |
| If `verify-polygon-multiview` already exists, reuse it or replicate? | **Reuse via direct function-call extraction.** Refactor its capture logic into `lib/multiview-capture.ts`; both routes call the shared helper. | DRY. The kickoff spec already pointed at this code path. |
| What if Claude returns malformed JSON? | **Return input `data` unchanged.** Log a `tier_b_failure` telemetry event with the parse error. | Tier B is a refinement, not load-bearing. Failure must degrade gracefully so /internal /quote keep working. |
| Cricket flashing trigger? | **Chimney width > 30 inches → add 20% to that chimney's LF contribution.** | Per kickoff §"Tier B sources to build". Approximation; refine when there's field feedback. |
| Confidence bump on refined fields? | **Refined edges/objects get `confidence: 0.75`.** Whole-RoofData `confidence` bumps by +0.10 capped at 0.95. | Spec §3.7 says "Tier B refinement bumps to min(0.95, confidence + 0.10)". 0.75 on individual entities cleanly beats Tier C's 0.4 floor so refinements always win when downstream consumers do confidence-weighted picks. |
| Telemetry events to add for Tier B? | **Three new events:** `tier_b_attempted` (every call), `tier_b_succeeded` (refinement applied), `tier_b_failed` (with error reason). Same `console.log` pattern. | Standard rollout instrumentation. |

### Files to ship

```
lib/multiview-capture.ts                    ← shared capture helper (extracted from existing verify-polygon-multiview)
app/api/roof-inspector/route.ts             ← POST endpoint, rate-limited "expensive"
lib/sources/multiview-source.ts             ← tierBMultiviewRefinement(data: RoofData): Promise<RoofData>
lib/roof-pipeline.ts                        ← MODIFY: register refinement after primary source succeeds, env-gated
scripts/verify-roof-engine.ts               ← MODIFY: add 4 verification tests (early-return guards + telemetry shape)
components/roof/DetectedFeaturesPanel.tsx   ← MODIFY: show "🔍 Roof Inspector verified" badge when refinements include "multiview-obliques"
```

### Acceptance

- `npx tsx scripts/verify-roof-engine.ts` — 36 PASS (32 prior + 4 new)
- `npm run typecheck` clean, `npm run lint` no new errors, `npm run build` green
- Manual verification (when user is back): `ENABLE_TIER_B_REFINEMENT=1 curl /api/roof-pipeline?lat=...&lng=...` on 8450 Oak Park Rd should show flashing total going from ~64 LF (Tier C) to ~104 LF (Tier B per kickoff acceptance).
- Pushed to main with commits clearly attributed to Tier B.

### Implementation order (commits)

1. Extract shared capture helper.
2. Build `/api/roof-inspector` endpoint with structured Claude prompt.
3. Build `multiview-source.ts` with the failure-tolerant refinement.
4. Register in pipeline (env-gated).
5. Add the rep-side "Roof Inspector verified" badge.
6. Verification tests + final gates + push to main.

---

## TIER A — LiDAR + Python Service + 3D Visual

### A.0 — Python service deployment decision

**Decision: Modal.**

**Reasoning:**
- Kickoff recommended it. Pay-per-invocation aligns with estimator usage (bursty, not constant).
- Native support for ML/compute workloads with built-in GPU options if YOLO training comes later.
- Python 3.12 + arbitrary system packages (PDAL needs native libs — Modal allows them via `image.apt_install` or custom Docker base).
- 50MB function-size limits don't apply (Modal supports container-sized functions).
- Simple TypeScript invocation pattern (HTTP endpoint exposed via `@stub.web_endpoint`).

**If Modal isn't available at runtime:** the deployment step is a no-op; the code still lands in the repo with a clear `services/roof-lidar/README.md` explaining how to deploy. Tier A.1 doesn't activate until `LIDAR_SERVICE_URL` env var is set.

**Vercel Python spike (alternative):** SKIPPED. PDAL has ~80MB of native deps, exceeds Vercel's 50MB function limit. Confirmed by inspection of `pdal` PyPI dist size.

---

### A.1 — LiDAR measurement pipeline

#### Goal

Pull USGS 3DEP LiDAR for the parcel, segment planes, build facets, classify edges from dihedral angles, detect objects via YOLO on ortho render, compute flashing. Return `RoofData` with `source: "tier-a-lidar"` and `confidence: 0.90+`. Register as the highest-priority source in `runRoofPipeline`.

#### Pre-answered decisions

| Question | Decision | Reasoning |
|---|---|---|
| LiDAR source for v1? | **USGS 3DEP only.** Commercial fallback (Nearmap, Vexcel) is Phase 5. | 3DEP covers >95% of CONUS at 1-2m resolution. Florida (Voxaris's market) is well-covered. Commercial fallback is meaningful only for new construction post-LiDAR-flight. |
| 3DEP coverage check? | **Run first; fall through to Tier B/C if no coverage.** Use the AWS-hosted 3DEP manifest at `s3://prd-tnm/StagedProducts/Elevation/LPC/Projects/`. | Documented in kickoff §"Tier A coverage + freshness caveats". |
| Object detection model? | **Pretrained YOLOv8** (ultralytics `yolov8n.pt`). Custom roof-object training is Phase 5. | YOLOv8 detects common roof penetrations reasonably well (chimneys, skylights, vents). Custom training requires ground-truth-labeled rooftop image dataset — separate workstream. |
| Plane segmentation algorithm? | **Region-growing on the point cloud** (Open3D's `cluster_dbscan` after plane-fitting), not naive RANSAC. | Better for residential roofs at 1-2m point spacing. Matches kickoff §"Sources to build". |
| Facet boundary algorithm? | **Alpha-shape** (Open3D / Shapely `alpha_shape` with α tuned per facet). Douglas-Peucker simplification at 0.2m tolerance. | Standard approach for plane-inlier boundaries. |
| Edge classification from dihedral angles? | **Compute angle between adjacent facet normals.** `< 10°` → coplanar (skip); `10-170°` → ridge or valley by sign convention; `> 170°` → step-wall against vertical face. | Direct geometric classification, no heuristics. Eaves and rakes derived from boundary edges that aren't shared with another facet. |
| Freshness check? | **Compare 3DEP `LastModified` against Google Solar's `imageryDate`.** If imagery is >1 year newer than LiDAR, flag in `diagnostics.warnings` and demote `confidence` to 0.75. | Kickoff §"Coverage + freshness caveats". |
| Confidence on Tier A RoofData? | **0.95 default**, demoted to **0.75 when freshness flagged**, **0.50** when 3DEP coverage is patchy (returns < 70% of expected building footprint). | Higher than Tier C (0.85 HIGH) because direct height measurement beats photogrammetry. |
| Cost monitoring? | **No per-estimate cap.** Modal billed per CPU-second; expect ~$0.05-0.20 per LiDAR run depending on parcel size. | Same calculus as Tier B — Voxaris's pricing absorbs this easily. Add per-estimate cost tracking to telemetry (`tier_a_compute_cost`). |
| Caching strategy? | **Cache RoofData at the pipeline level (already in place).** Additionally, cache the raw LiDAR point cloud at the Python service for 24h keyed by parcel bbox. | RoofData cache → 1h. LiDAR raw cache → 24h. Substantially reduces 3DEP S3 traffic on repeat estimates. |

#### Files to ship

```
services/roof-lidar/
  ├── README.md                    ← deploy instructions, env vars
  ├── modal_app.py                 ← Modal stub + web_endpoint
  ├── coverage_check.py            ← 3DEP coverage manifest lookup
  ├── pull_lidar.py                ← fetch LAS/LAZ tiles from 3DEP S3
  ├── isolate_roof.py              ← ground classify + footprint mask + height threshold + vertical-return filter
  ├── segment_planes.py            ← region-growing plane segmentation
  ├── build_facets.py              ← alpha-shape boundaries + Douglas-Peucker + pitch/azimuth from normal
  ├── topology_graph.py            ← facet adjacency + dihedral-based edge classification
  ├── detect_objects.py            ← YOLO inference on ortho render
  ├── compute_flashing.py          ← flashing rules applied to facets + edges + objects
  ├── freshness_check.py           ← compare 3DEP date vs Google imagery date
  ├── api.py                       ← FastAPI orchestrator wired to modal_app
  └── requirements.txt             ← pdal, open3d, shapely, numpy, fastapi, ultralytics, etc.
lib/sources/lidar-source.ts        ← TypeScript adapter calling Modal endpoint
lib/roof-pipeline.ts               ← MODIFY: register Tier A as highest-priority source (gated on LIDAR_SERVICE_URL)
.env.example                       ← MODIFY: document MODAL_TOKEN_ID, MODAL_TOKEN_SECRET, LIDAR_SERVICE_URL
```

#### Acceptance

- Code lands in repo.
- If `MODAL_TOKEN_ID` is set in the build env: `modal deploy services/roof-lidar/modal_app.py` succeeds and emits a URL. Set `LIDAR_SERVICE_URL` in `.env.local` template.
- If unset: `services/roof-lidar/README.md` explains exactly how to deploy. Commit and continue.
- Pipeline integration: when `LIDAR_SERVICE_URL` is unset, `tier-a-lidar` source returns null silently → pipeline falls through to Tier B/C. Build still green.
- `npm run typecheck` clean, `npm run build` green.

---

### A.2 — 3D visual layer

#### Goal

Render a customer-facing 3D model of the roof: Google Photorealistic 3D Tiles as textured backdrop + LiDAR-derived facet/edge/object overlays. Plus Puppeteer-driven static PDF stills + 360° orbit MP4.

#### Pre-answered decisions

| Question | Decision | Reasoning |
|---|---|---|
| Cesium for 3D Tiles, R3F for overlays? | **Yes.** Cesium loads Google 3D Tiles via the standard `Cesium3DTileset` primitive; R3F sits on top via `@react-three/fiber` (already in package.json). | Matches kickoff §"Visual layer stack". |
| Where does `<RoofViewer>` mount? | **/internal: above the rep workbench's MapView, toggleable expand. /quote: embedded inline above the proposal price.** | Customer wow-factor on /quote; rep verification on /internal. |
| Show RoofViewer when Tier A isn't available? | **No — only when `RoofData.source === "tier-a-lidar"` AND has 3D geometry.** Fall through to the existing MapView for Tier B/C. | Tier B/C have polylines at `heightM: 0`; rendering them in 3D would look broken. Wait until LiDAR provides real heights. |
| Color ramp for facets? | **Cool blues for pitch <18.43° (low slope); warm reds for >38° steep; greens for typical 4-8/12.** Semi-transparent so 3D Tiles texture shows through. | Visual hierarchy: customers immediately see "steep parts" without needing to read the legend. |
| Edge colors? | **Ridge=red, hip=orange, valley=blue, eave=green, rake=dashed green, step-wall=purple.** | Matches kickoff §"Visual layer stack" + adds step-wall (Tier B addition). |
| Puppeteer export — when does it run? | **On demand from /internal "Export PDF stills" button. Not auto-run on save.** | Puppeteer is slow (~30-60s for 6 stills + a 5s GIF); don't block save. Reps trigger it when needed for insurance claims. |
| 360° orbit format? | **MP4 (H.264), 1080p, 8 seconds, 30fps.** Fallback to GIF if MP4 encoding fails. | Insurance claim packets prefer MP4. GIF is the universal fallback. |

#### Files to ship

```
components/roof/RoofViewer.tsx               ← R3F + Cesium 3D Tiles viewer
components/roof/RoofViewerLayer.tsx          ← R3F overlay (facet meshes + edge lines + object markers)
app/api/roof-export-pdf/route.ts             ← Puppeteer-driven stills + orbit export
lib/puppeteer-orbit.ts                       ← capture helper
app/(internal)/page.tsx                      ← MODIFY: mount <RoofViewer> when source === "tier-a-lidar"
app/quote/page.tsx                           ← MODIFY: embed <RoofViewer> in proposal flow
```

#### Acceptance

- RoofViewer renders for tier-a-lidar RoofData with the proper Google 3D Tiles backdrop + R3F overlay.
- Falls through silently for Tier B/C RoofData.
- Puppeteer export produces 6 stills + 8s MP4 from a single rep button.
- Build green; bundle size impact noted (Cesium is ~2MB gzipped — acceptable for /internal rep tool, lazy-load on /quote).

---

## "STOP and surface to human" gates

Only stop in these cases:

1. **Modal deployment fails with a credential error.** Commit the code, document in commit message, continue with A.2.
2. **3DEP S3 bucket access is rate-limited or denied.** Document and try alternate transport (Open Data Registry mirror, or AWS Public Datasets).
3. **PDAL or Open3D refuses to install in the Modal image.** Try alternative point-cloud libraries (laspy, scipy-spatial). Document the workaround.
4. **YOLOv8 weights download fails repeatedly.** Bundle a smaller YOLOv8n with the image (~6MB).
5. **R3F + Cesium have a hard incompatibility** (e.g., Cesium's WebGL context fights with R3F's). Document and split into two viewports if needed.

For everything else: pick the most reasonable option, document the decision in the commit message, and keep moving. Don't pause for confirmation.

---

## Push cadence

- After Tier B's final commit: `git push origin <branch>:main`. Verify the build succeeds on Vercel preview before declaring shipped.
- After Tier A.1's final commit: same.
- After Tier A.2's final commit: same.

If a Vercel build fails, fix forward in the same session — don't leave main broken.

---

## What the human reviewer (the partner) should look at when they're back

1. **Vercel preview build status** for the latest push.
2. **Tier B headline check:** does 8450 Oak Park Rd show ~104 LF total flashing with `ENABLE_TIER_B_REFINEMENT=1`?
3. **Tier A deployment status:** is Modal deployed? Is `LIDAR_SERVICE_URL` set? If yes, test against a known-LiDAR-covered Florida address.
4. **Telemetry events:** check console.log output (or Sentry breadcrumbs) for `pipeline_source_picked` showing tier-a-lidar wins on covered addresses.
5. **3D viewer:** does `<RoofViewer>` render on /internal for a LiDAR-derived RoofData?

That's the audit checklist. Anything else can wait.

---

**End of decisions doc.** The next Claude session reads this and executes. No need to ask the user anything — every decision is here.

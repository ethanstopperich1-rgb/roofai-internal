# Next Steps — Voxaris Pitch

**Generated:** 2026-05-15 (end-of-day audit)
**Status of `main`:** all phase work shipped, awaiting Modal redeploy
to activate Point2Roof + Phase 1/2/3 Python tuning.

This is the live "where are we / what's next" doc. The older
[stack-report.md](stack-report.md) and [for-ethan.md](for-ethan.md)
are marked stale and reference this one.

---

## TL;DR

- All code for the reconstruction-pipeline upgrade is on `main`.
- Nothing is **active in production** for Point2Roof, Phase 1
  footprint clipping, Phase 2 PolyFit, or Phase 3 segmentation
  tuning — **all of it requires a Modal redeploy** which the
  partner is working on.
- TypeScript side (renderer, picker, lead → dashboard, sqft
  provenance) is fully live on Vercel and consistent.
- One UI lie was found and fixed: the 3D renderer's legend
  hardcoded "USGS LiDAR" regardless of which source was active
  (Solar toggle showed Solar facets with a "USGS LiDAR" badge).
  Now source-aware.

---

## What's already on `main` and live in production

These work right now without any infra changes:

### TypeScript / Vercel side
1. **Cross-source roof rendering** — same renderer for LiDAR + Solar,
   toggle button switches between them, agreement chip surfaces
   inter-source disagreement.
2. **PCA-based hip geometry** — no flat tabletop; rectangular
   roofs render with a proper ridge line, square roofs with a
   pyramid apex.
3. **Uniform ridge height** — all quads share one ridge height so
   adjacent slopes meet cleanly. Per-quad pitch falls out of
   geometry (long sides shallower, hip ends steeper).
4. **Wall extrusion removed** — synthetic walls at a 2.6m default
   were a cosmetic; they fought visually with the roof mesh.
5. **Eave/rake/step-wall edges suppressed** — the "floating green
   rectangles" the user flagged are gone. Only ridge/hip/valley
   render, and only when the mesh comes from the same source
   (Point2Roof path).
6. **Renderer pre-wire for Point2Roof mesh** — when `meshSource
   === "point2roof"` AND polygons have heightM, the renderer
   skips the synthetic frustum and renders `data.facets[]`
   directly. Activates the moment Modal returns real mesh data.
7. **Visible meshSource diagnostic chip** — small chip in the
   renderer's legend showing which reconstruction tier produced
   the geometry (`point2roof (real)` / `polyfit (real)` /
   `frustum fallback` / `solar tier-c`).
8. **Source-aware legend label** — "✓ Measured · {Source}" now
   reflects the active source (USGS LiDAR / Google Solar /
   Aerial vision) instead of hardcoding "USGS LiDAR".
9. **Mesh-authoritative sqft on /quote** — polygon edits no
   longer override the per-facet mesh measurement. "Wrong roof?"
   button still rebuilds the mesh against the new building.
   Caption reads "Measured from N roof facets — per-facet
   pitch + slope" when the displayed number is the mesh value.
10. **Phase 1 picker** — multi-source parcel polygon (Solar mask
    → MS Buildings → OSM → Solar segments → synthetic fallback)
    with IoU disagreement check + 0.5m buffer. Wired into
    `lib/roof-pipeline.ts`. Lives in `lib/sources/parcel-polygon.ts`.
11. **`/api/parcel-polygon` route** — new endpoint exposing the
    picker. `/api/microsoft-building` preserved as deprecated
    shim (byte-identical response shape) for the 4 known
    consumers; Phase 1.5 migrates them and removes the shim.
12. **Lead → dashboard sqft consistency** — `/api/leads` accepts
    `estimatedSqft` which `/quote` populates with
    `roofData.totals.totalRoofAreaSqft` (mesh value). Dashboard
    leads table renders `lead.estimated_sqft` directly. End-to-
    end consistent.

### Python / Modal side (in repo, not yet deployed)
All Phase 1/2/3 Python work + Point2Roof vendoring lives in
`services/roof-lidar/` and `services/roof-lidar/vendor/point2roof/`
but Modal is still running the pre-Phase-F image. **Nothing
activates until Modal redeploys.**

---

## The Modal redeploy — what activates the moment it lands

### 1. Phase F — formalized AEQD coordinate frame
- `services/roof-lidar/coord_frame.py` (single source of truth for
  forward/inverse AEQD transforms).
- `build_facets.py` no longer uses a cheap-flat-earth approximation;
  exact pyproj round-trip.
- Regression test: `services/roof-lidar/scripts/verify_coord_roundtrip.py`.

### 2. Phase 1 — tight footprint clipping
- `isolate_roof.py`: conditional class-6 enforcement (when ≥200
  class-6 points exist, take ONLY class-6; otherwise loose
  negative filter). Wall-filter threshold tightened from 0.35 →
  0.30 to compensate for the smaller 0.5m polygon buffer.
- `lib/roof-pipeline.ts::buildParcelPolygon` now delegates to
  the multi-source picker with 0.5m buffer (was 1.5-2.5m
  buffer, single-source Solar-only).

### 3. Phase 2+3 — Point2Roof + CGAL PolyFit + segmentation tuning
- `services/roof-lidar/regularize_planes.py` orchestrates a three-
  tier reconstruction chain:
    1. **Point2Roof** (PRIMARY, MIT) — vendored deep-learning
       roof reconstruction. Requires CUDA + the pc_util C++/CUDA
       extension built at image-build time.
    2. **CGAL PolyFit** (SECONDARY, GPL) — current stub returns
       None pending binding-API verification on Modal.
    3. **Alpha-shape fallback** — current production path
       (`build_facets_from_planes`); never fails.
- `segment_planes.py` tunings: `MIN_FACET_POINTS` 80 → 20
  (catches small dormers + hip triangles at QL2 density),
  plane-distance threshold 0.20m, coplanar-merge pass after
  region growing.
- `api.py` sets `meshSource` on RoofData based on which tier
  won. The TS renderer pre-wire reads this field to decide
  between real-mesh and synthetic-frustum paths.

### 4. GPU on `run_extract`
- `modal_app.py` switches `cpu=2.0` to `gpu="T4"`. Marginal cost
  ~$0.001-0.005 per estimate. CUDA toolkit + pc_util extension
  built at image-build time.

---

## How to deploy + verify (for the partner)

1. **One-time:** add `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` to
   GitHub Secrets (Settings → Secrets and variables → Actions).
   See [modal-github-deploy.md](modal-github-deploy.md) for the
   walkthrough.
2. **Deploy:** GitHub → Actions tab → "Deploy Modal LiDAR
   Service" → Run workflow. First build is 10-15 min because of
   CUDA toolkit + pc_util install.
3. **Watch the build log** for `WARN: pc_util build failed —
   Point2Roof tier will fall through`. If present, Point2Roof
   is dormant; runtime falls back to alpha-shape; no production
   regression. The image still deploys successfully.
4. **Verify with one estimate:** open `/internal`, run Oak Park
   Rd. Look at the diagnostic chip in the 3D model's lower-
   left:
   - 🟢 `mesh: point2roof (real)` → Point2Roof firing
   - 🟡 `mesh: frustum fallback` → fallback active, dig into
     Modal logs for the failure reason
5. **Aggregate `[polyfit-failure]` log lines** from Modal after
   ~50 estimates for the 2-4 week corpus review.

---

## What's left to do — by priority

### IMMEDIATE (waiting on Modal redeploy)
- **Validate Point2Roof inference on real 3DEP data.** First
  deploy will tell us whether the CUDA build succeeds + whether
  the model output for our specific density (~2-4 pts/m²) is
  sane. If poor, the fallback chain protects production while
  we iterate on the model wrapper.
- **Confirm the meshSource chip turns green** for at least one
  test address. If amber for everything, that's the diagnosis
  starting point.

### NEXT SPRINT (after Point2Roof is validated)
1. **Phase 1.5 cleanup** — migrate the 4 known consumers off
   `/api/microsoft-building` to `/api/parcel-polygon`, delete
   the deprecated shim. Tracked in
   [phase-1.5-tracking.md](phase-1.5-tracking.md).
2. **Phase 1.6 — OSM source** — the picker has a placeholder
   for OSM but no fetcher yet. Filling this in covers rural
   addresses where MS Buildings has gaps.
3. **CGAL PolyFit binding verification** — the secondary tier
   currently returns None. Verify which CGAL Python binding
   actually exposes `Polygonal_surface_reconstruction_3` and
   flip the stub to the real call. Or replace with
   LiangliangNan's PolyFit standalone bindings.
4. **Failure-corpus aggregator** — small script that greps
   `[polyfit-failure]` log lines from Modal and produces a
   summary (which tier won per address, common failure
   reasons). Drives the 2-4 week review.

### MEDIUM TERM
1. **Multi-wing roof support** — the synthetic frustum can't
   render L-shapes / T-shapes properly. Once Point2Roof's
   real-mesh path is reliable, multi-wing rendering is solved
   automatically (the mesh has multiple ridge segments by
   construction). If Point2Roof is unreliable for our data, a
   proper straight-skeleton algorithm in the synthetic path is
   the alternative (~1-2 days of code).
2. **Tier B multi-view inspector re-wire** — currently dormant
   because the new renderer doesn't emit `onMultiViewCaptured`
   (the legacy Roof3DViewer did). When re-enabled, Tier B
   refinement catches wall-step flashing + improves chimney/
   skylight LF. Env var `ENABLE_TIER_B_REFINEMENT=1` gates it.
3. **YOLO custom training** — pretrained YOLOv8n on COCO only
   detects satellite dishes from roof orthos. A 500-2000-image
   labeled rooftop dataset would let us detect chimneys,
   skylights, vents, dormers — improving the flashing math
   significantly.

### LONGER TERM / RESEARCH
1. **EagleView or Roofr integration** for bid-grade precision on
   high-value contracts. ~$15-25 per report; would let the rep
   trigger a paid measurement on demand.
2. **Customer ground-truth photo upload** — Hover-style "snap 4
   photos from the corners" flow that Claude vision can compare
   to the measured mesh.
3. **Renderer interactivity polish** — hover-to-highlight per
   facet exists; could add dimension labels (eave length, ridge
   length), shaded materials per pitch, exportable orbit video.

---

## Known limitations worth being honest about

1. **USGS 3DEP coverage is patchy + stale.** Tier A LiDAR works
   for FL/TX/MN but most of rural US doesn't have recent QL2
   coverage. Tier C Solar is the workhorse for general traffic.
2. **Point2Roof's training distribution is European + dense.**
   Our 3DEP QL2 residential FL data is unlike RoofN3D. The
   model might generalize poorly on first encounter. The
   fallback chain protects production regardless.
3. **The synthetic frustum can't render multi-wing roofs.** Oak
   Park Rd looks like 17 actual facets — a multi-wing hip with
   side extensions. The synthetic single-ridge approximation
   can never render that correctly. Real-mesh path (Point2Roof)
   is the only fix.
4. **Vendored Point2Roof is in maintenance mode.** 7 total
   commits, no recent activity. PyTorch ABI changes between
   1.8 and current might break it; we pin torch==2.1.2 in the
   Modal image to match the vendored snapshot.

---

## Files to know about

| File | Purpose |
|---|---|
| `components/roof/RoofRenderer.tsx` | 3D blueprint renderer (~1600 lines). Dual-path: frustum + real-mesh. |
| `lib/roof-pipeline.ts` | Tier orchestrator; `runRoofPipeline` (serial) + `runRoofPipelineCompare` (parallel). |
| `lib/sources/parcel-polygon.ts` | Phase 1 multi-source picker. |
| `lib/sources/ms-buildings.ts` | Azure-based MS Buildings with 3-tier cache. |
| `services/roof-lidar/api.py` | Modal entrypoint orchestrator. |
| `services/roof-lidar/regularize_planes.py` | Phase 2 reconstruction chain (Point2Roof → PolyFit → fallback). |
| `services/roof-lidar/point2roof_wrapper.py` | Vendored Point2Roof inference wrapper. |
| `services/roof-lidar/modal_app.py` | Modal image config (GPU, CUDA toolkit, pc_util build). |
| `.github/workflows/deploy-modal.yml` | Auto + manual Modal deploy. |
| `types/roof.ts` | Canonical RoofData / Facet / PricedEstimate types. |

---

## Cost per estimate today

| Path | Cost |
|---|---|
| Cache hit (within 1h) | ~$0 |
| Solar coverage, no LiDAR | ~$0.075 |
| Solar + LiDAR coverage | ~$0.175 |
| Vision fallback | ~$0.115 |
| **Add T4 GPU on `run_extract`** | +$0.001-0.005 |
| **Tier B inspector** (env-gated) | +$0.04 |

Modal redeploy adds the T4 cost (negligible). No other cost
changes from today's `main`.

---

## How to know if something's broken

1. Check `/api/lidar-health` — if `state: configured`, the Modal
   endpoint is reachable.
2. Run an estimate, look at the mesh-source chip in the renderer.
   Amber = synthetic frustum (probably normal, Point2Roof not
   yet deployed or failed).
3. Look at the Modal app logs for the most recent `run_extract`
   invocation. Search for `regularize+point2roof:` or
   `[polyfit-failure]`.
4. Vercel logs: search for `[roof-pipeline]` for orchestrator
   decisions, `[tier-a-lidar]` for LiDAR-adapter decisions,
   `[deprecated]` for callers of the old MS Buildings route.

---

## Tomorrow's recommended starting point

1. **Has the Modal redeploy happened?** Check GitHub Actions tab
   for "Deploy Modal LiDAR Service" run.
2. **If yes:** check the mesh-source chip on one estimate.
   If green → Point2Roof works for this address. Test 3-5 more
   diverse addresses (suburban, urban dense, rural). Send any
   that look bad to me with the screenshot + the Modal log.
   If amber → grep the Modal log for the specific failure
   reason. Most likely: pc_util CUDA build failed (the line
   we documented to look for). Send me the build error from
   the GitHub Action run and we'll pin a different CUDA/torch
   combo.
3. **If no:** make sure secrets are set, push the deploy through
   the GitHub UI.

After that the work list above is in priority order.

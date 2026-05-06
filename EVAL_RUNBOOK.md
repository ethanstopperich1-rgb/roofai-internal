# Eval runbook — outline accuracy

The product's #1 reported issue is outline accuracy. This runbook gets you
from "I think it's bad" to "Roboflow scores 0.68 IoU on suburban, Solar
mask scores 0.91 — here's the priority chain change that helps."

Without a measurement, every fix is guesswork. With one, fixes become
falsifiable.

## What ships in this commit

1. **`/eval-trace`** — in-app annotation page (dev only).
   Hand-trace the correct roof polygon on the same Google zoom-20 satellite
   tile the production pipeline runs on.

2. **`scripts/eval-truth/`** — directory of hand-traced ground-truth
   polygons (one JSON per address). Checked into git so the eval is
   reproducible across the team.

3. **`scripts/eval-truth.ts`** — the eval harness. Hits each polygon
   source individually (`/api/solar-mask`, `/api/building`, `/api/roboflow`,
   `/api/microsoft-building`, `/api/sam-refine`), scores each one against
   the ground truth using IoU + area ratio + Hausdorff distance, and
   prints a per-address breakdown plus a summary table.

4. **`Roof3DViewer.tsx` fix** — the polygon outline overlay was setting
   both `clampToGround: true` and `classificationType: CESIUM_3D_TILE`.
   These fight on a 3D Tileset; the outline could end up painted at
   ground level instead of on the roof. Classification alone is the
   correct primitive — the outline now drapes onto the photogrammetric
   mesh as intended.

## What you do (one-time setup)

### 1. Trace 10 ground-truth addresses

```sh
npm run dev
```

Open http://localhost:3000/eval-trace.

For each address, follow the on-screen flow:

1. Type the address into the input → pick from autocomplete.
2. The map centers at zoom 20 over the property.
3. Click **Draw fresh** in the top-right of the map.
4. Click around the actual roof perimeter (eaves, not the building
   footprint — include eave overhang). Click your *first* vertex again
   to close the polygon.
5. Drag vertices to fine-tune. Right-click to remove a vertex.
6. (Optional) Edit the slug or add notes ("complex hip + dormers").
7. Click **Save ground truth**.

The file lands at `scripts/eval-truth/<slug>.json`. Commit them.

**Pick a representative mix:**

- 3 simple (rectangular ranch, single gable)
- 3 medium (L-shape, attached garage, hip)
- 2 complex (multi-wing, dormers)
- 2 hard (rural with stale imagery, dense urban with trees)

Use addresses your roofing customers would actually quote — failing
houses you've seen, varied roof shapes, varied geographies. **Do not
cherry-pick easy ones**; the eval is only useful when it reflects
production traffic. ~10 minutes per address with practice.

### 2. Run the eval

In another terminal (keep `npm run dev` running):

```sh
npm run eval:truth
```

You'll see per-address output like:

```
tn-beulah-rose  (465 Beulah Rose Dr, Murfreesboro, TN 37128, USA)
  truth: 2987 sqft, 14 verts
  source              IoU   AreaRatio   Hausdorff_m      ms
  ------------------------------------------------------------
  solar-mask         0.91        0.99           1.6    1240
  roboflow           0.68        1.07           5.8     980
  sam-refine         0.74        0.93           4.1    8200
  ms-buildings       0.82        0.91           3.2     310
  osm                  —           —             —      180   (no result)
```

…then a summary table at the bottom averaging across all addresses.

### 3. Read the numbers

The summary tells you which source to trust on which house type. Decision
rules to apply:

- **Avg IoU < 0.6 on a source** → that source is hurting more than it
  helps in the priority chain. Drop it or lower its priority.
- **Avg IoU > 0.85 on a source** → leave it where it is or promote it.
- **Wide gap between p50 and p90** (e.g. p50 0.80, p90 0.40) →
  source is bimodal: great when it works, terrible when it fails.
  Add a confidence-based gate.
- **Area ratio < 0.85** → systematic under-trace (missing eave overhang,
  wings).
- **Area ratio > 1.15** → over-trace into yard.

## What this unblocks

### Decisions you can now make data-driven

1. **Roboflow vs alternatives**. If Roboflow's avg IoU is below 0.7, it's
   worth pricing the alternatives I flagged: a custom Roboflow keypoint/
   polygon model trained on your labeled US residential set, or a paid
   roof-API like HOVER / EagleView / Roofr as a fallback when Solar
   misses. With a number you can budget the upgrade.

2. **Source priority chain**. The current chain in `app/(internal)/page.tsx:350–420`
   is hardcoded. Once you have IoU per source, sort by avg IoU instead
   of intuition. The recent "demote Solar facets" commit is exactly this
   kind of decision — but unmeasured.

3. **"Moderate confidence" threshold**. The chip in `app/(internal)/page.tsx:553–593`
   uses an IoU 0.7 threshold for cross-source consensus. With ground
   truth you can verify whether 0.7 is the right cutoff or if you should
   tighten/loosen it.

### Regression coverage

Run `npm run eval:truth` before and after every meaningful change to the
outline pipeline. If avg IoU drops, the change regressed accuracy — even
if it shipped a new feature. This is how you stop accuracy fixes from
silently un-fixing themselves.

## Things I deliberately did NOT change

I held back on changes that need your eval data to justify. After you
have at least 5 ground truths in `scripts/eval-truth/` and one full eval
run, come back to these:

1. **Default Cesium 3D viewer to top-down ortho when polygon is shown.**
   Your own code at `Roof3DViewer.tsx:314–317` admits the perspective
   parallax shift. The orbit-perspective view is the source of customer
   "shifted" complaints. But the orbit is also the visually impressive
   sales demo — defaulting to ortho is a UX call you should make, not me.

2. **Densify mesh height sampling.** `Roof3DViewer.tsx:445–457` samples 5
   points around the address to set the camera pivot. With a denser grid
   over the actual polygon footprint, you can extract a real ridge height
   and feed it into `lib/parametric-roof.ts` instead of computing ridge
   height from polygon shape + assumed pitch. That would directly fix
   the "4.7 ft peak" failure on the Murfreesboro property. Risk: changes
   measurement values; needs eval data to confirm it improves vs current.

3. **Replace Roboflow Satellite Rooftop Map v3.** Generic public model.
   The notched polygon in your screenshot is what this model produces on
   residential at zoom 20. Two paths: (a) custom Roboflow keypoint model
   trained on ~500 hand-labeled US residential roofs (~$0 ongoing, ~1
   week of labeling); (b) license a roof-API as a fallback (~$0.30–1.50
   per call, drop-in replacement when Solar has no coverage). The eval
   data tells you which path is justified.

4. **Eliminate the satellite-vs-3D-tiles georeferencing drift.** This is
   the deeper "3D shifted" cause. Real fix: detect the polygon centroid
   on both the 2D satellite tile AND the projected 3D mesh, compute the
   offset, and shift the polygon before draping. Non-trivial; needs
   measurement of the offset distribution first (which the eval gives
   you indirectly via Hausdorff in 2D — extend it to 3D once you've
   confirmed the 2D pipeline works).

## Files added / changed

- `app/(internal)/eval-trace/page.tsx` — annotation UI (new)
- `app/api/eval-truth/save/route.ts` — saves polygons to disk (new, dev-only)
- `app/api/eval-truth/list/route.ts` — lists saved polygons (new, dev-only)
- `scripts/eval-truth.ts` — eval harness (new)
- `scripts/eval-truth/README.md` — directory README (new)
- `package.json` — adds `npm run eval:truth`
- `components/Roof3DViewer.tsx` — removes `clampToGround: true` from
  polygon outline polyline (it was fighting `classificationType:
  CESIUM_3D_TILE`)

## Caveats

- The annotation page is dev-only. The save endpoint refuses POSTs in
  production via a `NODE_ENV !== "production"` guard.
- `sam-refine` calls Replicate (paid). Each eval run uses ~1 SAM call
  per address. At 10 addresses that's ~$0.20–0.50 depending on Replicate
  pricing — fine for occasional runs, not for a CI loop.
- The eval reuses the cache layer in `lib/cache.ts`, so re-running
  against the same address is fast (and free) on subsequent runs. Bypass
  with `redis-cli FLUSHDB` if you want to force a re-fetch.
- Trace on the **same imagery the pipeline sees** (Google Static Maps
  zoom 20). MapView already loads this — don't switch to Bing/Mapbox/
  Vexcel for tracing or your "errors" will partly reflect imagery
  offset, not pipeline error.

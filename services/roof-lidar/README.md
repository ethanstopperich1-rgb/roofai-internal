# Voxaris Pitch — Tier A LiDAR Service

Python microservice that pulls USGS 3DEP LiDAR point clouds for a parcel,
segments roof planes, builds facets + edges + objects + flashing, and
returns a `RoofData`-shaped JSON payload to the Next.js app via HTTP.

Designed to deploy on **Modal** ([modal.com](https://modal.com)). See the
locked decisions doc at `docs/superpowers/tier-b-a-decisions.md` for why.

---

## Deployment

### Prerequisites

1. A Modal account.
2. Modal CLI installed locally: `pip install modal`.
3. Authenticate: `modal token new`.
4. Set the tokens in your Next.js project env (Vercel project env or `.env.local`):
   ```
   MODAL_TOKEN_ID=ak-...
   MODAL_TOKEN_SECRET=as-...
   ```

### Deploy

From the repo root:

```bash
cd services/roof-lidar
modal deploy modal_app.py
```

Modal will:

1. Build the container image (~3-5 min cold; installs PDAL, Open3D, Torch).
2. Push it to Modal's registry.
3. Emit **four** web endpoint URLs — one per `@modal.fastapi_endpoint`:
   - `https://<workspace>--voxaris-roof-lidar-submit.modal.run`         ← async POST
   - `https://<workspace>--voxaris-roof-lidar-result.modal.run`         ← async GET poll
   - `https://<workspace>--voxaris-roof-lidar-extract-roof.modal.run`   ← legacy sync (deprecated)
   - `https://<workspace>--voxaris-roof-lidar-health.modal.run`         ← liveness probe

**Important: Modal uses subdomain-per-function, not path-per-function.**
Each endpoint lives at its own hostname. The TS adapter auto-derives
`result` and `health` from whichever `submit`-form URL you supply.

### Wire up the Next.js app

Set the **submit** endpoint URL as `LIDAR_SERVICE_URL` in the Next.js project env:

```
LIDAR_SERVICE_URL=https://<workspace>--voxaris-roof-lidar-submit.modal.run
```

The TS-side `lib/sources/lidar-source.ts` parses this URL, extracts the
`<workspace>--<app>` prefix, and rebuilds the `result` + `health` subdomains
automatically. Confirm it's working by hitting `/api/lidar-health` from
the Next.js app — green chip = ready, red chip = wrong URL / unreachable.

**Escape-hatch override.** If your deploy doesn't match the standard
Modal `<ws>--<app>-<fn>.modal.run` pattern (e.g. you reverse-proxied
the service behind your own domain, or future Modal CLI versions
emit different hostnames), set these three explicitly to skip the
auto-derivation:

```
LIDAR_SUBMIT_URL=...
LIDAR_RESULT_URL=...
LIDAR_HEALTH_URL=...
```

Without `LIDAR_SERVICE_URL` (and no overrides), `runRoofPipeline` skips
Tier A and falls through to Tier B/C — silent skip, build stays green.

### Verify the URL is correct

The most common deploy bug: pasting any URL other than the **submit**
subdomain, or assuming Modal uses path routing. To sanity-check:

```bash
# Should return 200 with {"ok": true, "service": "voxaris-roof-lidar"}
curl https://<workspace>--voxaris-roof-lidar-health.modal.run/

# Should return 200 with {"call_id": "fc-..."}
curl -X POST https://<workspace>--voxaris-roof-lidar-submit.modal.run/ \
  -H "Content-Type: application/json" \
  -d '{"lat": 28.5, "lng": -81.4, "address": "test"}'
```

If the **result** URL returns `405 Method Not Allowed` on a GET, it
means you accidentally pointed `LIDAR_SERVICE_URL` at the **submit**
subdomain *and* the auto-derivation didn't kick in (older adapter, or
a future Modal naming change). Set `LIDAR_RESULT_URL` explicitly.

---

## Local development (no Modal)

Run the FastAPI app standalone:

```bash
cd services/roof-lidar
pip install -r requirements.txt
python modal_app.py
```

This boots a local server at `http://localhost:8000`. POST to `/extract-roof`
with `{ "lat": ..., "lng": ..., "address": "..." }` to test the pipeline
without Modal billing.

Set `LIDAR_SERVICE_URL=http://localhost:8000/extract-roof` to point the
Next.js app at the local server.

---

## Pipeline stages

```
coverage_check.py   → 3DEP S3 tile manifest lookup. Returns tile IDs + flight date.
pull_lidar.py       → Fetch LAZ tiles. Cached 24h per parcel bbox.
isolate_roof.py     → Ground classify → height filter → footprint mask → vertical-return filter.
segment_planes.py   → Region-growing plane segmentation on point cloud.
build_facets.py     → Alpha-shape boundaries + Douglas-Peucker + pitch/azimuth.
topology_graph.py   → Facet adjacency + dihedral angle → ridge/hip/valley/eave/rake/step-wall.
detect_objects.py   → YOLO inference on ortho render → chimney/skylight/vent.
compute_flashing.py → FlashingBreakdown matching the TS schema.
freshness_check.py  → LiDAR vs Google imagery date — flag stale captures.
api.py              → FastAPI orchestrator wiring all stages.
```

---

## Known gaps to close post-deploy

These are deliberate v1 simplifications — the production team should
address them as the service rolls out:

1. **CRS handling in `pull_lidar.py`.** Many 3DEP LAZ files are in
   state-plane or UTM projections; we currently treat their XY as if
   they were lat/lng. Symptoms: bbox filter looks empty, or downstream
   facet polygons land far from the geocoded address. Fix: read the
   LAS file's CRS header and reproject with pyproj before bbox filtering.

2. **Heuristic state-prefix coverage check in `coverage_check.py`.**
   The current S3 list-prefix approach only handles a few states. Swap
   in `s3://usgs-lidar-public/usgs-3dep-mvt-tindex.gpkg` once geopandas
   is added to `requirements.txt`.

3. **YOLOv8n class taxonomy** in `detect_objects.py`. The pretrained
   model only detects "satellite dish" from the roof-object world.
   Replace with a custom-trained model once a labeled rooftop image
   dataset is built. Until then, Tier A chimney/skylight counts will
   be near-zero — flashing math degrades to edge-derived only.

4. **Ridge vs valley disambiguation in `topology_graph.py`.** The
   current heuristic resolves ambiguous cases as "ridge"; should refine
   by reading back into inlier-point Z values (high edge = ridge, low
   edge = valley).

---

## Tier A confidence levels

Set by `api.py` based on stage outcomes:

| Condition | Confidence |
|---|---|
| Full pipeline succeeded | 0.95 |
| Freshness check flagged (imagery > LiDAR by 1+ year) | 0.75 |
| Coverage < 70% of expected building | 0.50 |
| Any earlier stage failed → degraded RoofData with `source: "none"` | 0.0 |

The TS adapter (`lib/sources/lidar-source.ts`) unpacks `source: "none"`
into a null return so the pipeline falls through to Tier B/C.

---

## Cost characteristics

- **Cold start:** 30-90s (image pull + Open3D/Torch init).
- **Warm invocation:** 5-25s end-to-end, dominated by:
  - LAZ fetch from 3DEP S3 (cached after first hit on a parcel)
  - Plane segmentation (DBSCAN on normals)
  - YOLO inference on the ortho render
- **Modal billing:** ~$0.05-0.20 per call.
- **3DEP S3:** free (public dataset, no egress charges within AWS).

Cache configuration:

- **RoofData pipeline cache** (Next.js side): 1h per address.
- **LAZ tile cache** (Modal volume): 24h per tile S3 key.

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
3. Emit two web endpoint URLs:
   - `https://<workspace>--voxaris-roof-lidar-extract-roof.modal.run`
   - `https://<workspace>--voxaris-roof-lidar-health.modal.run`

### Wire up the Next.js app

Set the extract endpoint URL as `LIDAR_SERVICE_URL` in the Next.js project env:

```
LIDAR_SERVICE_URL=https://<workspace>--voxaris-roof-lidar-extract-roof.modal.run
```

The TS-side `lib/sources/lidar-source.ts` only activates when this var is set.
Without it, `runRoofPipeline` skips Tier A and falls through to Tier B/C.

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

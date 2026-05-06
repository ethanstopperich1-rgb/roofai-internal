/**
 * Microsoft Building Footprints lookup — open-data building polygons for
 * areas where OSM doesn't have coverage (rural TN, etc).
 *
 * Microsoft published ~3.2M Tennessee building polygons in 2018-2023 under
 * the ODbL license. We pre-extract the Nashville-metro subset at build
 * time (see scripts/build-ms-buildings-tn.ts) and ship it as a gzipped
 * static asset under public/data/. At runtime this module loads the file
 * once per Function instance, builds an in-memory bbox index, and answers
 * lookups by lat/lng.
 *
 * Coverage caveat: ONLY Nashville-area TN. Building outside the bbox
 * (currently lat 35.7-36.2, lng -86.9 to -86.3) returns null. To expand,
 * edit the bbox in the build script + re-run + redeploy.
 *
 * Position accuracy: Microsoft's footprints are ML-extracted from satellite
 * imagery, so they're sometimes off by 1-3m vs ground truth. Adequate for
 * "give the AI a starting outline" — the Roboflow/SAM refinement step
 * snaps the actual edges if needed.
 */

import { debug } from "@/lib/debug";
import { readFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { join } from "node:path";

const gunzipAsync = promisify(gunzip);

interface CompactBuilding {
  /** [minLng, minLat, maxLng, maxLat] */
  b: [number, number, number, number];
  /** Flat polygon ring: [lng1, lat1, lng2, lat2, ...] */
  p: number[];
}

interface DataFile {
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  sourceUrl: string;
  license: string;
  builtAt: string;
  count: number;
  buildings: CompactBuilding[];
}

const DATA_PATH = join(process.cwd(), "public", "data", "ms-buildings-tn-nashville.json.gz");

let _data: DataFile | null = null;
let _loadingPromise: Promise<DataFile | null> | null = null;

async function loadData(): Promise<DataFile | null> {
  if (_data) return _data;
  if (_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    try {
      const compressed = await readFile(DATA_PATH);
      const buf = await gunzipAsync(compressed);
      const parsed = JSON.parse(buf.toString("utf8")) as DataFile;
      debug(
        `[ms-buildings] loaded ${parsed.count.toLocaleString()} buildings (built ${parsed.builtAt})`,
      );
      _data = parsed;
      return parsed;
    } catch (err) {
      console.warn("[ms-buildings] failed to load data file:", err);
      return null;
    } finally {
      _loadingPromise = null;
    }
  })();
  return _loadingPromise;
}

/**
 * Point-in-polygon (ray casting). Polygon is a flat array [x1, y1, x2, y2, ...].
 */
function pointInFlatPolygon(x: number, y: number, flat: number[]): boolean {
  let inside = false;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[i * 2], yi = flat[i * 2 + 1];
    const xj = flat[j * 2], yj = flat[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Squared distance from a point to the closest vertex of the polygon —
 * used as a tiebreaker when no polygon contains the geocoded point
 * (Microsoft footprints are sometimes off by a few meters; we still want
 * to return the building "the point was meant to be on").
 */
function minSquaredDistToVertex(x: number, y: number, flat: number[]): number {
  let best = Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    const dx = flat[i] - x;
    const dy = flat[i + 1] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return best;
}

/**
 * Convert a flat ring `[lng1, lat1, ...]` to the canonical lat/lng
 * polygon shape used by the rest of the pipeline.
 */
function flatToLatLng(flat: number[]): Array<{ lat: number; lng: number }> {
  const out: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i < flat.length; i += 2) {
    out.push({ lng: flat[i], lat: flat[i + 1] });
  }
  return out;
}

export interface MicrosoftBuildingResult {
  polygon: Array<{ lat: number; lng: number }>;
  source: "microsoft-buildings";
  /** True when the geocoded point is actually inside the polygon; false
   *  when we picked the nearest building because no polygon contained
   *  the point (Microsoft positional drift). */
  contained: boolean;
}

/**
 * Look up the Microsoft building footprint for a given (lat, lng).
 *
 * Strategy:
 *   1. Filter to buildings whose bbox contains the point (fast scan)
 *   2. Among those, pick one whose POLYGON contains the point
 *   3. If none qualify (Microsoft drift / point on driveway), expand to
 *      buildings within ~25m bbox-to-point distance and pick the closest.
 *
 * Returns null when:
 *   - lat/lng is outside the pre-extracted Nashville bbox (no coverage)
 *   - data file failed to load
 *   - no building found within 25m of the point
 */
export async function fetchMicrosoftBuildingPolygon(opts: {
  lat: number;
  lng: number;
}): Promise<MicrosoftBuildingResult | null> {
  const { lat, lng } = opts;
  const data = await loadData();
  if (!data) return null;

  const { bbox } = data;
  if (lat < bbox.minLat || lat > bbox.maxLat || lng < bbox.minLng || lng > bbox.maxLng) {
    debug(
      `[ms-buildings] (${lat.toFixed(4)}, ${lng.toFixed(4)}) outside coverage bbox`,
    );
    return null;
  }

  // Pass 1: bbox contains point + polygon contains point (the easy case)
  for (const b of data.buildings) {
    if (lng < b.b[0] || lng > b.b[2] || lat < b.b[1] || lat > b.b[3]) continue;
    if (pointInFlatPolygon(lng, lat, b.p)) {
      return {
        polygon: flatToLatLng(b.p),
        source: "microsoft-buildings",
        contained: true,
      };
    }
  }

  // Pass 2: nearest building within ~25m. Microsoft footprints can drift
  // 1-3m vs ground truth, OR the geocoded address point can land on a
  // driveway/lawn just outside the actual roof. 25m generous threshold.
  // ~25m at TN latitude (~36°N) ≈ 0.000225° lat, 0.000278° lng.
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const radiusLng = 25 / (111_320 * cosLat);
  const radiusLat = 25 / 111_320;
  let bestPoly: number[] | null = null;
  let bestDistSq = Infinity;
  const radiusLngSq = radiusLng * radiusLng;
  for (const b of data.buildings) {
    if (b.b[0] > lng + radiusLng || b.b[2] < lng - radiusLng) continue;
    if (b.b[1] > lat + radiusLat || b.b[3] < lat - radiusLat) continue;
    const d2 = minSquaredDistToVertex(lng, lat, b.p);
    if (d2 < bestDistSq && d2 < radiusLngSq) {
      bestDistSq = d2;
      bestPoly = b.p;
    }
  }
  if (!bestPoly) {
    debug(
      `[ms-buildings] no building within 25m of (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
    );
    return null;
  }

  return {
    polygon: flatToLatLng(bestPoly),
    source: "microsoft-buildings",
    contained: false,
  };
}

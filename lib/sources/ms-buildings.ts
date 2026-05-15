/**
 * lib/sources/ms-buildings.ts
 *
 * Microsoft Global ML Building Footprints — Azure-hosted, ML-derived
 * building polygons covering ~125M+ US buildings (refreshed quarterly).
 * Used as the second-priority parcel-polygon source by Phase 1's
 * `pickBestParcelPolygon` picker (after Solar mask, before OSM).
 *
 * Three-tier cache:
 *
 *   Hot (per-address, Upstash)
 *     Key: `ms:bldg:{lat5},{lng5}`  (5-decimal precision, ~1.1m)
 *     Value: `{polygon, contained}` or `{empty: true}`
 *     TTL: 30 days on hit, 1 hour on Azure failure (so transient outages
 *          self-heal within ~1 hour, not 24)
 *
 *   Warm (per-quadkey-16, Upstash)
 *     Key: `ms:tile16:{quadkey}` (~600m tiles, ~50-200 buildings each,
 *          fits comfortably under Upstash's 1 MB value limit)
 *     Value: { buildings: BuildingRecord[], fetchedAt: ISO }
 *     TTL: 7 days
 *
 *   Cold (per-quadkey-9, Modal volume)
 *     Path: /cache/prewarmed_metros/{quadkey9}.geojsonl.gz
 *     Populated by scripts/prewarm_ms_buildings.py at deploy time for
 *     metros listed in config/prewarmed_metros.json. CI check enforces
 *     that every metro's quadkeys appear in the volume manifest before
 *     a PR can merge — see scripts/check-prewarm-manifest.ts.
 *
 * This module runs in Next.js Function (Node.js runtime). The cold tier
 * lookup goes through an HTTP endpoint exposed by the Modal service
 * (services/roof-lidar/), since Next.js doesn't have direct filesystem
 * access to the Modal volume.
 *
 * Phase 1 NOTE: this module replaces lib/microsoft-buildings.ts (the
 * Nashville-scoped TSV implementation). The legacy file is deleted in
 * the same PR. The /api/microsoft-building HTTP route is preserved as
 * a thin deprecated shim around `fetchMsBuildingsOnly` — see Phase 1.5
 * tracking issue for full removal once the four known consumers
 * migrate.
 */

import { getCached, getCachedByKey, setCached, setCachedByKey } from "@/lib/cache";

export type LatLng = { lat: number; lng: number };

/** Backwards-compatible result shape — preserves the API contract of the
 *  old `lib/microsoft-buildings.ts` for any callers that import the type
 *  directly. The picker emits `source: "ms_buildings"` internally; the
 *  public type continues to use the legacy `"microsoft-buildings"` enum
 *  string. A future cleanup PR can unify the enum across the codebase. */
export interface MicrosoftBuildingResult {
  polygon: LatLng[];
  source: "microsoft-buildings";
  /** True when the geocoded point is actually inside the polygon; false
   *  when we picked the nearest containing building (positional drift). */
  contained: boolean;
}

/** Internal richer record stored in warm-tier cache. The shim and picker
 *  consume different subsets — `fetchMsBuildingsOnly` returns the public
 *  shape; the picker also reads `areaSqft` for the residential bounds
 *  check. */
interface BuildingRecord {
  polygon: LatLng[];
  centroidLat: number;
  centroidLng: number;
  areaSqft: number;
}

// ─── Cache TTLs ──────────────────────────────────────────────────────

const HOT_HIT_TTL_S = 60 * 60 * 24 * 30;   // 30 days
const HOT_AZURE_FAIL_TTL_S = 60 * 60;       // 1 hour (transient self-heal)
const WARM_TTL_S = 60 * 60 * 24 * 7;        // 7 days

// ─── Residential bounds (Phase 1 picker refinement) ──────────────────
// Hard reject: anything outside [200, 20000] sqft. Tag as
// `likely_outbuilding`: 200 <= area < 600 (shed / detached garage).
// Don't reject sub-600 — let the picker decide whether it's the right
// building. Just flag for the failure corpus.

const MIN_AREA_SQFT = 200;
const MAX_AREA_SQFT = 20_000;
export const OUTBUILDING_MAX_SQFT = 600;

// ─── Public API ──────────────────────────────────────────────────────

/**
 * MS-Buildings-only fetch — for the deprecated /api/microsoft-building
 * shim and any caller that explicitly wants MS Buildings semantics (no
 * fallback to other sources). Picker uses `fetchMsBuildings` instead.
 *
 * Returns null on no-coverage / Azure failure / empty cache hit.
 */
export async function fetchMsBuildingsOnly(opts: {
  lat: number;
  lng: number;
}): Promise<MicrosoftBuildingResult | null> {
  const result = await fetchBuildingRecord(opts.lat, opts.lng);
  if (!result) return null;
  return {
    polygon: result.record.polygon,
    source: "microsoft-buildings",
    contained: result.contained,
  };
}

/**
 * Picker-integration fetch — returns the richer record so the picker
 * can run its area / disagreement checks. Same lookup path as
 * `fetchMsBuildingsOnly`; just exposes more fields.
 */
export async function fetchMsBuildings(opts: {
  lat: number;
  lng: number;
}): Promise<{
  polygon: LatLng[];
  contained: boolean;
  areaSqft: number;
  /** True when polygon area is below OUTBUILDING_MAX_SQFT — the picker
   *  surfaces this to diagnostics without rejecting. */
  likelyOutbuilding: boolean;
} | null> {
  const result = await fetchBuildingRecord(opts.lat, opts.lng);
  if (!result) return null;
  return {
    polygon: result.record.polygon,
    contained: result.contained,
    areaSqft: result.record.areaSqft,
    likelyOutbuilding: result.record.areaSqft < OUTBUILDING_MAX_SQFT,
  };
}

// ─── Lookup orchestration ────────────────────────────────────────────

interface FetchResult {
  record: BuildingRecord;
  contained: boolean;
}

async function fetchBuildingRecord(
  lat: number,
  lng: number,
): Promise<FetchResult | null> {
  // 1. Hot cache (per-address, lat/lng-keyed at 5 decimals via cache.ts).
  const hot = await getCached<HotCacheEntry>("ms-bldg", lat, lng);
  if (hot) {
    if (hot.empty) return null;
    if (hot.record) {
      // `contained` is optional on HotCacheEntry but always written
      // alongside `record` by writeHotCache. Default false defensively.
      return { record: hot.record, contained: hot.contained ?? false };
    }
  }

  // 2. Warm cache (per-quadkey-16, in-tile lookup).
  const q16 = latLngToQuadkey(lat, lng, 16);
  const warm = await getCachedByKey<WarmCacheEntry>(`ms:tile16:${q16}`);
  if (warm) {
    const hit = selectFromTile(warm.buildings, lat, lng);
    await writeHotCache(lat, lng, hit);
    return hit;
  }

  // 3. Cold tier (Modal-volume prewarmed + Azure fallback). The Modal
  //    service exposes the cold + Azure paths behind a single endpoint
  //    so the Next.js side only needs one HTTP call.
  try {
    const tile = await fetchTileFromLidarService(q16);
    if (tile) {
      await setCachedByKey<WarmCacheEntry>(
        `ms:tile16:${q16}`,
        { buildings: tile.buildings, fetchedAt: new Date().toISOString() },
        WARM_TTL_S,
      );
      const hit = selectFromTile(tile.buildings, lat, lng);
      await writeHotCache(lat, lng, hit);
      return hit;
    }
  } catch (err) {
    console.warn("[ms-buildings] cold fetch failed:", err);
  }

  // 4. Total miss / Azure failure — cache empty sentinel with short TTL
  //    so transient outages don't black-hole this address for 30 days.
  await setCached<HotCacheEntry>(
    "ms-bldg",
    lat,
    lng,
    { empty: true },
    HOT_AZURE_FAIL_TTL_S,
  );
  return null;
}

// ─── Hot cache types + helpers ───────────────────────────────────────

interface HotCacheEntry {
  empty?: boolean;
  record?: BuildingRecord;
  contained?: boolean;
}

interface WarmCacheEntry {
  buildings: BuildingRecord[];
  fetchedAt: string;
}

async function writeHotCache(
  lat: number,
  lng: number,
  hit: FetchResult | null,
): Promise<void> {
  if (hit) {
    await setCached<HotCacheEntry>(
      "ms-bldg",
      lat,
      lng,
      { record: hit.record, contained: hit.contained },
      HOT_HIT_TTL_S,
    );
  } else {
    // Tile loaded but no building contains this point (rural geocode on
    // empty land). Still cache the empty result — 30d TTL is fine here
    // since the answer is durable: MS Buildings can't add a new building
    // to a tile without a release bump, which we control via config.
    await setCached<HotCacheEntry>(
      "ms-bldg",
      lat,
      lng,
      { empty: true },
      HOT_HIT_TTL_S,
    );
  }
}

// ─── Tile-to-result selection (Phase 1 refinement #5) ────────────────
//
// When multiple polygons in the tile contain (lat, lng) — most common
// case: shared-wall townhomes, but also tightly-packed urban blocks
// where MS's ML misses gaps — prefer the LARGEST area that contains
// the point. That's the most likely target building per the user
// refinement: "smallest-area tiebreak inverts this exactly wrong."
//
// When NO polygon contains the point (geocode lands on driveway or
// MS positional drift), fall back to the largest polygon within a
// 60m bbox radius. This matches the rural-friendly fallback the old
// module had but with the area-prefer tiebreak (not nearest-vertex).

function selectFromTile(
  buildings: BuildingRecord[],
  lat: number,
  lng: number,
): FetchResult | null {
  if (buildings.length === 0) return null;

  // Pass 1: polygons whose ring contains the geocode.
  const containing: BuildingRecord[] = [];
  for (const b of buildings) {
    if (pointInPolygon(lat, lng, b.polygon)) containing.push(b);
  }
  if (containing.length > 0) {
    // Largest among containers. Residential targets in shared-wall
    // / townhome geometries are the larger structure (the main house),
    // not the smaller (the attached garage).
    let best = containing[0];
    for (const b of containing) {
      if (b.areaSqft > best.areaSqft) best = b;
    }
    if (best.areaSqft < MIN_AREA_SQFT || best.areaSqft > MAX_AREA_SQFT) {
      return null;
    }
    return { record: best, contained: true };
  }

  // Pass 2: positional-drift fallback. Look within ~60m and pick the
  // largest. The 60m radius matches the legacy fallback for rural
  // parcels where the geocode pin lands on the driveway.
  const RADIUS_M = 60.0;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const radiusLng = RADIUS_M / (111_320 * cosLat);
  const radiusLat = RADIUS_M / 111_320;
  const nearby = buildings.filter(
    (b) =>
      Math.abs(b.centroidLat - lat) <= radiusLat &&
      Math.abs(b.centroidLng - lng) <= radiusLng &&
      b.areaSqft >= MIN_AREA_SQFT &&
      b.areaSqft <= MAX_AREA_SQFT,
  );
  if (nearby.length === 0) return null;
  let best = nearby[0];
  for (const b of nearby) {
    if (b.areaSqft > best.areaSqft) best = b;
  }
  return { record: best, contained: false };
}

// ─── Cold tier: HTTP call to Modal service ───────────────────────────
//
// The Modal service holds the prewarmed quadkey-9 tiles on its volume
// AND has the Azure fetch path when a quadkey-9 misses. The Next.js
// side calls it once; the service decides whether to read the prewarmed
// file or proxy to Azure. This keeps Azure credentials + the parquet
// parsing in Python (where geopandas / shapely are already deps).
//
// When the service isn't reachable, return null and the orchestrator
// caches an empty sentinel with the short Azure-failure TTL.

const TILE_FETCH_TIMEOUT_MS = 12_000;

async function fetchTileFromLidarService(
  quadkey16: string,
): Promise<{ buildings: BuildingRecord[] } | null> {
  const baseUrl = process.env.MS_BUILDINGS_SERVICE_URL;
  if (!baseUrl) {
    // No service configured — Phase 1 deploys can run without it; the
    // hot+warm caches still work, just no cold-tier resolution. Log
    // once-per-process so an unconfigured production deploy is visible.
    logServiceUnconfiguredOnce();
    return null;
  }
  const url = `${baseUrl.replace(/\/$/, "")}/ms-buildings-tile?quadkey16=${encodeURIComponent(quadkey16)}`;
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (resp.status === 404) return { buildings: [] }; // tile genuinely empty
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.warn(
      "[ms-buildings] cold fetch non-ok",
      resp.status,
      body.slice(0, 300),
    );
    return null;
  }
  const data = (await resp.json()) as { buildings: BuildingRecord[] };
  return data;
}

let _serviceUnconfiguredLogged = false;
function logServiceUnconfiguredOnce(): void {
  if (_serviceUnconfiguredLogged) return;
  _serviceUnconfiguredLogged = true;
  console.log(
    "[ms-buildings] MS_BUILDINGS_SERVICE_URL not set — cold tier disabled. " +
      "Hot + warm caches still work; tile misses go to negative cache.",
  );
}

// ─── Geometry helpers ────────────────────────────────────────────────

/** Ray-casting point-in-polygon for a closed ring of LatLng. */
function pointInPolygon(lat: number, lng: number, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng;
    const yi = ring[i].lat;
    const xj = ring[j].lng;
    const yj = ring[j].lat;
    if (
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Bing-style quadkey at a target zoom level. Matches the MS Buildings
 *  partitioning scheme. Same algorithm used by Microsoft's downloader
 *  reference at:
 *    https://learn.microsoft.com/en-us/bingmaps/articles/bing-maps-tile-system */
export function latLngToQuadkey(
  lat: number,
  lng: number,
  zoom: number,
): string {
  const { tileX, tileY } = latLngToTileXY(lat, lng, zoom);
  return tileXYToQuadkey(tileX, tileY, zoom);
}

function latLngToTileXY(
  lat: number,
  lng: number,
  zoom: number,
): { tileX: number; tileY: number } {
  const latClamped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  const lngClamped = Math.max(Math.min(lng, 180.0), -180.0);
  const sinLat = Math.sin((latClamped * Math.PI) / 180);
  const x = (lngClamped + 180) / 360;
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  const mapSize = 256 << zoom; // 256 * 2^zoom
  const pixelX = Math.min(Math.max(x * mapSize + 0.5, 0), mapSize - 1);
  const pixelY = Math.min(Math.max(y * mapSize + 0.5, 0), mapSize - 1);
  return { tileX: Math.floor(pixelX / 256), tileY: Math.floor(pixelY / 256) };
}

function tileXYToQuadkey(tileX: number, tileY: number, zoom: number): string {
  let quadkey = "";
  for (let i = zoom; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((tileX & mask) !== 0) digit++;
    if ((tileY & mask) !== 0) digit += 2;
    quadkey += digit.toString();
  }
  return quadkey;
}

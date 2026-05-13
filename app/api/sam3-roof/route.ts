import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { fetchSatelliteImage } from "@/lib/satellite-tile";
import {
  reconcileRoofPolygon,
  type ReconciledRoof,
} from "@/lib/reconcile-roof-polygon";
import { getCached, setCached } from "@/lib/cache";
import { polygonAreaSqft } from "@/lib/polygon";
import { fetchBuildingPolygon } from "@/lib/buildings";
import type { SolarSummary } from "@/types/estimate";
import type { SolarMaskPolygon } from "@/lib/solar-mask";
// fetchBuildingPolygon is used here ONLY as a tile-centering aid when
// Solar disagrees with the geocoded address by more than SOLAR_DRIFT_THRESHOLD_M,
// or when Solar has no coverage for the region. Its residence-aware ranker
// (drops outbuildings, prefers addr:housenumber matches) makes it a stronger
// signal than Solar's "closest building" in those cases. The reconciler
// still owns its own GIS lookup for cross-checking SAM3's trace.

export const runtime = "nodejs";
// 90s allows for SAM3 cold starts (which can take 30-60s on Roboflow's
// serverless infra) plus reconciliation + GIS lookups. Vast majority of
// calls complete in 5-10s; the headroom only matters for cold starts.
export const maxDuration = 90;

/**
 * GET /api/sam3-roof?lat=..&lng=..
 *
 * Custom SAM3 roof segmenter via Roboflow Workflows. Calls our fine-tuned
 * SAM3 model with a per-latitude `pixels_per_unit` calibration, then runs
 * the result through `reconcileRoofPolygon` to substitute the GIS footprint
 * when SAM3 fails (occlusion, wrong building, over-trace).
 *
 * Designed to slot in at Tier 1 of the polygon priority chain — Solar mask
 * fires only as a fallback when this returns 404.
 *
 * Kill switch: set SAM3_ENABLED=false to disable instantly without redeploy
 * (the route returns 503; client falls through to Solar mask). Useful if
 * we see a regression in production telemetry.
 *
 * Cached server-side per lat/lng for 6h.
 */

/**
 * Roboflow workflow config — workflow URL, prompt, and confidence floor.
 * Centralized in lib/roboflow-workflow-config so app/api/healthz/route.ts
 * shares the exact same URL when probing for the workflow's existence.
 *
 * Override at deploy time via:
 *   ROBOFLOW_SAM3_WORKFLOW_URL   when the workflow is republished
 *   ROBOFLOW_SAM3_PROMPT         when tuning segmentation prompt
 *   ROBOFLOW_SAM3_CONFIDENCE     when tuning the mask confidence floor
 */
import {
  SAM3_WORKFLOW_URL as ROBOFLOW_WORKFLOW_URL,
  SAM3_PROMPT,
  SAM3_CONFIDENCE,
} from "@/lib/roboflow-workflow-config";

interface Sam3CachedResult extends ReconciledRoof {
  /** When this run actually called Roboflow (vs served from cache). */
  computedAt: string;
}

/** Pixels per FOOT for a given latitude at the supplied zoom and scale.
 *  Web Mercator: m/px = 156543.03392 × cos(lat) / 2^(zoom + log2(scale)).
 *  At the default zoom 20 / scale 2 → effective zoom 21. When the tile is
 *  fetched at zoom 19 / scale 2 (rural-fallback path), effective zoom 20
 *  and ground resolution is exactly half — pixelsPerFoot must follow,
 *  otherwise SAM3's `pixels_per_unit` calibration is off by 2× and the
 *  prompt/area heuristics misfire. */
function pixelsPerFoot(lat: number, zoom = 20, scale = 2): number {
  const effectiveZoom = zoom + Math.log2(scale);
  const mPerPx =
    (156_543.03392 * Math.cos((lat * Math.PI) / 180)) /
    Math.pow(2, effectiveZoom);
  const ftPerPx = mPerPx * 3.28084;
  return 1 / ftPerPx;
}

/**
 * Douglas-Peucker polyline simplification. Recursively keeps the point
 * with the largest perpendicular distance from the chord between the
 * endpoints; if that distance is below `epsilon`, the chord replaces
 * everything in between.
 *
 * SAM3 returns dense per-pixel boundary (often 300+ verts on a single
 * residential roof). At zoom 20 scale 2 (0.06 m/px), epsilon=8 keeps
 * the polygon visually identical to <0.5m and typically reduces vertex
 * count by 90%+ — restoring usable editable-map performance.
 */
function douglasPeucker(
  points: Array<[number, number]>,
  epsilon: number,
): Array<[number, number]> {
  if (points.length < 3) return points;
  const perpDist = (p: [number, number], a: [number, number], b: [number, number]) => {
    const num = Math.abs(
      (b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0],
    );
    const den = Math.hypot(b[1] - a[1], b[0] - a[0]) || 1;
    return num / den;
  };
  let dmax = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1]);
    if (d > dmax) {
      dmax = d;
      index = i;
    }
  }
  if (dmax > epsilon) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [points[0], points[points.length - 1]];
}

/** Convert pixel polygon to lat/lng using the projection of the tile the
 *  polygon was traced on. Tile size for the geo-projection is `tilePx`
 *  (defaults to 1280 = 640px × scale 2). When the workflow returns image
 *  dimensions different from `tilePx` (e.g. it resized internally), we
 *  scale pixel coords back to that frame before applying the projection.
 *
 *  `zoom` and `scale` must match the satellite tile the polygon came
 *  from — at zoom 19 scale 2 ground frame is twice as wide (per pixel),
 *  so using zoom 20 here would shrink the polygon by 2× and place it
 *  in roughly the right spot but at half real size. */
function pixelPolygonToLatLng(opts: {
  pixels: Array<[number, number]>;
  centerLat: number;
  centerLng: number;
  zoom?: number;
  scale?: number;
  /** Width of the image the polygon was traced on (defaults to 1280 —
   *  our default tile size of 640px × scale 2). */
  imageWidth?: number;
  /** Height of the image the polygon was traced on (defaults to 1280). */
  imageHeight?: number;
}): Array<{ lat: number; lng: number }> {
  const {
    pixels,
    centerLat,
    centerLng,
    zoom = 20,
    scale = 2,
    imageWidth = 1280,
    imageHeight = 1280,
  } = opts;
  const effectiveZoom = zoom + Math.log2(scale);
  const mPerPx =
    (156_543.03392 * Math.cos((centerLat * Math.PI) / 180)) /
    Math.pow(2, effectiveZoom);
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  // Ground frame width in px for this zoom/scale combo. At zoom 20 scale
  // 2 → 1280 px wide (640 sizePx × 2). At zoom 19 scale 2 → 1280 px wide
  // but each px covers twice the ground.
  const tilePx = 640 * scale;
  const xScale = tilePx / imageWidth;
  const yScale = tilePx / imageHeight;
  return pixels.map(([x, y]) => {
    const dxM = (x - imageWidth / 2) * xScale * mPerPx;
    const dyM = (imageHeight / 2 - y) * yScale * mPerPx;
    return {
      lat: centerLat + dyM / 111_320,
      lng: centerLng + dxM / (111_320 * cosLat),
    };
  });
}

interface ExtractedPrediction {
  pixels: Array<[number, number]>;
  /** Original area in pixel² as reported by Roboflow. Used for tie-breaking
   *  and diagnostics. */
  pixelArea: number;
}

/** Shoelace area for a pixel polygon. Used as a fallback when Roboflow's
 *  workflow response is missing `area_px` — without this fallback we'd
 *  use `pixels.length` (vertex count), which fundamentally breaks the
 *  area-vs-vertex distinction the residence picker depends on. Returns
 *  the absolute area in square pixels.
 *
 *  Per code review: a Roboflow workflow schema change that drops
 *  `area_px` should NOT silently switch the residence picker from
 *  "prefer larger building" to "prefer more-jagged building." */
function pixelPolygonArea(pixels: Array<[number, number]>): number {
  if (pixels.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pixels.length; i++) {
    const [ax, ay] = pixels[i];
    const [bx, by] = pixels[(i + 1) % pixels.length];
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
}

interface ExtractedPolygons {
  predictions: ExtractedPrediction[];
  /** Width of the image the polygons were traced on, per the workflow
   *  response. Used to scale pixel coords back to our 1280-px ground frame
   *  before the geo-projection. Defaults to 1280 if the response doesn't
   *  include image dimensions. */
  imageWidth: number;
  imageHeight: number;
}

/** Extract ALL polygons from the Roboflow Workflow response.
 *
 *  Real shape, observed via local Python SDK test (2026-05-07):
 *    [
 *      {
 *        "annotated_crop": "<base64>",
 *        "roof_areas_sqft": {
 *          "image": { "width": ..., "height": ... },
 *          "predictions": [
 *            {
 *              "points": [{ "x": ..., "y": ... }, ...],
 *              "area_px": ...,
 *              "confidence": ...,
 *              ...
 *            }
 *          ]
 *        }
 *      }
 *    ]
 *
 *  Returns ALL predictions (each with their pixel polygon) so the route
 *  can pick the right one using app-side context (Solar buildingCenter,
 *  MS Buildings, etc.) — Roboflow's image-space heuristics aren't enough
 *  on edge cases like setback rural houses.
 */
function extractAllPolygons(data: unknown): ExtractedPolygons | null {
  if (!data) return null;

  // Response can be either a list (current shape) or an object with an
  // `outputs` array (older shape). Normalise to a single output object.
  let firstOutput: Record<string, unknown> | null = null;
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    firstOutput = data[0] as Record<string, unknown>;
  } else if (typeof data === "object") {
    const root = data as Record<string, unknown>;
    if (Array.isArray(root.outputs) && root.outputs.length > 0 && typeof root.outputs[0] === "object") {
      firstOutput = root.outputs[0] as Record<string, unknown>;
    } else {
      // Top-level object might itself be the output (no outputs wrapper)
      firstOutput = root;
    }
  }
  if (!firstOutput) return null;

  // Primary path: roof_areas_sqft.predictions[].points  (current workflow)
  const roofAreas = firstOutput.roof_areas_sqft;
  if (roofAreas && typeof roofAreas === "object") {
    const ra = roofAreas as Record<string, unknown>;
    const preds = Array.isArray(ra.predictions) ? ra.predictions : null;
    if (preds && preds.length > 0) {
      const img =
        ra.image && typeof ra.image === "object"
          ? (ra.image as Record<string, unknown>)
          : null;
      const imageWidth =
        typeof img?.width === "number" && img.width > 0 ? img.width : 1280;
      const imageHeight =
        typeof img?.height === "number" && img.height > 0 ? img.height : 1280;

      const predictions: ExtractedPrediction[] = [];
      for (const p of preds) {
        if (!p || typeof p !== "object") continue;
        const pred = p as Record<string, unknown>;
        const points = pred.points;
        const pixels = coercePolygon(points);
        if (!pixels || pixels.length < 3) continue;
        const pixelArea =
          typeof pred.area_px === "number" && pred.area_px > 0
            ? pred.area_px
            : pixelPolygonArea(pixels);
        predictions.push({ pixels, pixelArea });
      }
      if (predictions.length > 0) {
        return { predictions, imageWidth, imageHeight };
      }
    }
  }

  // Fallback paths for older / alternate workflow shapes. These don't
  // give us image dimensions, so we assume our 1280-px ground frame.
  const candidates: unknown[] = [
    firstOutput.roof_polygons,
    firstOutput.predictions,
    firstOutput.polygons,
    firstOutput.polygon,
  ];
  for (const c of candidates) {
    const poly = coercePolygon(c);
    if (poly) {
      return {
        predictions: [{ pixels: poly, pixelArea: pixelPolygonArea(poly) }],
        imageWidth: 1280,
        imageHeight: 1280,
      };
    }
  }

  return null;
}

/** Convert various shapes ({points: [{x,y}]}, {points: [[x,y]]}, [[x,y]],
 *  [{x,y}]) into a normalized [[x, y], ...] array. */
function coercePolygon(input: unknown): Array<[number, number]> | null {
  if (!input) return null;

  // Case: array of {points: ...} (predictions array — pick the largest)
  if (Array.isArray(input)) {
    if (input.length === 0) return null;

    // [[x, y], ...]
    if (Array.isArray(input[0]) && input[0].length === 2) {
      const out: Array<[number, number]> = [];
      for (const p of input) {
        if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") {
          out.push([p[0], p[1]]);
        }
      }
      return out.length >= 3 ? out : null;
    }

    // [{x, y}, ...]
    if (input[0] && typeof input[0] === "object" && "x" in input[0]) {
      const out: Array<[number, number]> = [];
      for (const p of input) {
        if (p && typeof (p as { x?: unknown }).x === "number" && typeof (p as { y?: unknown }).y === "number") {
          const px = p as { x: number; y: number };
          out.push([px.x, px.y]);
        }
      }
      return out.length >= 3 ? out : null;
    }

    // [{points: ...}, ...] — array of predictions; pick the largest by point count
    if (input[0] && typeof input[0] === "object" && "points" in input[0]) {
      let best: Array<[number, number]> | null = null;
      for (const pred of input) {
        const pts = (pred as { points?: unknown }).points;
        const poly = coercePolygon(pts);
        if (poly && (!best || poly.length > best.length)) best = poly;
      }
      return best;
    }
  }

  // Case: object with .points
  if (typeof input === "object" && input !== null && "points" in (input as object)) {
    return coercePolygon((input as { points: unknown }).points);
  }

  return null;
}

type ResolvedCenter = {
  lat: number;
  lng: number;
  /** Provenance string for logs / response diagnostics. Stable values:
   *    "click-override"
   *    "solar-buildingCenter" | "solar-buildingCenter-direct"
   *    "solar-mask-centroid"
   *    "osm-centroid-after-solar-drift" | "osm-centroid-no-solar"
   *    "address-solar-drift-fallback" | "address" */
  source: string;
  /** Zoom level the satellite tile should be fetched at. Lower means a
   *  wider ground frame — used when we're not confident the building
   *  centre is correct, so the SAM3 picker still has a chance to find
   *  the right structure even if our centre is off. */
  zoomHint: 19 | 20;
  /** Distance (m) from the geocoded address to the resolved centre.
   *  Surfaced in logs to spot-check pipeline behaviour over time. */
  driftFromAddressM: number;
  /** When Solar findClosest returned a centre, the distance (m) from
   *  the geocoded address to Solar's suggestion — regardless of whether
   *  we ended up using it. Lets us audit Solar's accuracy retroactively. */
  solarSuggestedDriftM: number | null;
};

/** Solar findClosest returns the closest building to the query point.
 *  On rural setback parcels (and dense suburban lots with outbuildings)
 *  "closest" can be an outbuilding rather than the residence. When
 *  Solar's returned centre is further than this from the geocoded
 *  address, we treat Solar's pick as suspect and fall through to OSM /
 *  a widened tile. 40m is wider than typical residential building
 *  diameters (≤30m) so it doesn't trip on normal addresses where Solar
 *  picked the same building as the geocoder, but tight enough to catch
 *  the shop-vs-house case (typically 50-150m of separation). */
const SOLAR_DRIFT_THRESHOLD_M = 40;

function metersBetween(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const cosLat = Math.cos((aLat * Math.PI) / 180);
  const dLatM = (bLat - aLat) * 111_320;
  const dLngM = (bLng - aLng) * 111_320 * cosLat;
  return Math.hypot(dLatM, dLngM);
}

function centroidLatLng(
  poly: ReadonlyArray<{ lat: number; lng: number }>,
): { lat: number; lng: number } {
  let cLat = 0;
  let cLng = 0;
  for (const v of poly) {
    cLat += v.lat;
    cLng += v.lng;
  }
  return { lat: cLat / poly.length, lng: cLng / poly.length };
}

/** Resolve the best available "actual building centre" for the address.
 *
 *  Why this function exists: Google's geocoder gives us a lat/lng near
 *  the addressed building, but at zoom 20 / scale 2 the ground frame is
 *  only ~84 m across. If the geocoder sits 50 m off the actual roof
 *  (which happens on rural setback lots and some non-ROOFTOP precision
 *  results) the building can fall outside the tile and SAM3 can't see
 *  it. So we try to refine the centre before fetching.
 *
 *  Cascade:
 *    1. Solar findClosest's buildingCenter (cached → direct). When
 *       Solar's centre is within SOLAR_DRIFT_THRESHOLD_M of the
 *       geocoded address, Solar identified the same building Google's
 *       geocoder pointed at — trust it.
 *    2. If Solar's centre is FURTHER than the threshold, Solar may have
 *       picked an outbuilding closer to the road. Skip Solar mask (same
 *       data source, same potential bias) and try OSM via
 *       fetchBuildingPolygon — its residence-aware ranker drops
 *       outbuildings and prefers `addr:housenumber` matches. Falling
 *       through to a wider zoom 19 tile centred on the geocoded address
 *       if OSM has no coverage.
 *    3. If Solar didn't return anything at all (no coverage), try Solar
 *       mask, then OSM, then geocoded.
 *
 *  Result on the rural FL failure mode:
 *    - Solar returns shop centre (60m from geocoded address)
 *    - Drift > 40m → fall through to OSM
 *    - OSM finds house polygon at the addressed point (addr:housenumber
 *      match short-circuits the ranker)
 *    - Tile centred on house, SAM3 traces house. */
async function resolveBuildingCenter(
  lat: number,
  lng: number,
  houseNumber: string | undefined,
): Promise<ResolvedCenter> {
  // ─── 1. Solar findClosest (cached, then direct) ──────────────────────
  // Solar buildingCenter is Google's "what building is at this point"
  // signal. Cache first (cheap), then a direct API call (Solar is keyed
  // separately from the /api/solar route that populates the cache, so
  // we may race ahead of it on the very first request for an address).
  let solarCenter: { lat: number; lng: number } | null = null;
  const solarCached = await getCached<SolarSummary>("solar", lat, lng).catch(() => null);
  if (solarCached?.buildingCenter) {
    solarCenter = {
      lat: solarCached.buildingCenter.lat,
      lng: solarCached.buildingCenter.lng,
    };
  } else {
    const solarKey =
      process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
    if (solarKey) {
      try {
        const url =
          `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
          `?location.latitude=${lat}&location.longitude=${lng}` +
          `&requiredQuality=HIGH&key=${solarKey}`;
        const res = await fetch(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            center?: { latitude?: number; longitude?: number };
          };
          if (
            typeof data.center?.latitude === "number" &&
            typeof data.center?.longitude === "number"
          ) {
            solarCenter = {
              lat: data.center.latitude,
              lng: data.center.longitude,
            };
          }
        }
      } catch {
        // fall through to other sources
      }
    }
  }

  const solarDriftM = solarCenter
    ? metersBetween(lat, lng, solarCenter.lat, solarCenter.lng)
    : null;

  // Solar agrees with the geocoder — trust it, normal path.
  if (solarCenter && solarDriftM !== null && solarDriftM <= SOLAR_DRIFT_THRESHOLD_M) {
    return {
      lat: solarCenter.lat,
      lng: solarCenter.lng,
      source: solarCached?.buildingCenter
        ? "solar-buildingCenter"
        : "solar-buildingCenter-direct",
      zoomHint: 20,
      driftFromAddressM: solarDriftM,
      solarSuggestedDriftM: solarDriftM,
    };
  }

  // ─── 2. Solar disagreed by > threshold → OSM, then widened geocode ──
  // Solar mask comes from the same data source as findClosest — if
  // findClosest picked an outbuilding for this address, the mask will
  // too. Skip it. OSM is independent.
  if (solarCenter) {
    const osm = await fetchBuildingPolygon({ lat, lng, houseNumber }).catch(() => null);
    if (osm && osm.latLng.length >= 3) {
      const c = centroidLatLng(osm.latLng);
      return {
        lat: c.lat,
        lng: c.lng,
        source: "osm-centroid-after-solar-drift",
        zoomHint: 20,
        driftFromAddressM: metersBetween(lat, lng, c.lat, c.lng),
        solarSuggestedDriftM: solarDriftM,
      };
    }
    // OSM blank — drop to zoom 19 around the geocoded address. The wider
    // ground frame (~168 m across vs ~84 m) usually contains both Solar's
    // (wrong) pick and the actual house, so the picker's
    // residence-aware scoring can choose between them.
    return {
      lat,
      lng,
      source: "address-solar-drift-fallback",
      zoomHint: 19,
      driftFromAddressM: 0,
      solarSuggestedDriftM: solarDriftM,
    };
  }

  // ─── 3. No Solar findClosest result — try Solar mask, then OSM ──────
  // Solar mask is sometimes populated even when findClosest isn't (e.g.
  // edge of coverage). Use its centroid if available.
  const solarMask = await getCached<SolarMaskPolygon | null>(
    "solar-mask",
    lat,
    lng,
  ).catch(() => null);
  if (solarMask?.latLng?.length) {
    const c = centroidLatLng(solarMask.latLng);
    return {
      lat: c.lat,
      lng: c.lng,
      source: "solar-mask-centroid",
      zoomHint: 20,
      driftFromAddressM: metersBetween(lat, lng, c.lat, c.lng),
      solarSuggestedDriftM: null,
    };
  }

  // OSM as the last refinement step before bare geocode. Universal
  // coverage (modulo data gaps), residence-aware ranker, free.
  const osm = await fetchBuildingPolygon({ lat, lng, houseNumber }).catch(() => null);
  if (osm && osm.latLng.length >= 3) {
    const c = centroidLatLng(osm.latLng);
    return {
      lat: c.lat,
      lng: c.lng,
      source: "osm-centroid-no-solar",
      zoomHint: 20,
      driftFromAddressM: metersBetween(lat, lng, c.lat, c.lng),
      solarSuggestedDriftM: null,
    };
  }

  // Bare geocoded address — no refinement source returned anything. Stay
  // at zoom 20: without Solar drift we have no positive signal that the
  // centre is wrong, and the wider frame at zoom 19 has its own costs
  // (the picker has to discriminate between more buildings, with lower
  // pixel density per building).
  return {
    lat,
    lng,
    source: "address",
    zoomHint: 20,
    driftFromAddressM: 0,
    solarSuggestedDriftM: null,
  };
}

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "expensive");
  if (__rl) return __rl;

  // Kill switch — disable SAM3 in prod without a redeploy if telemetry
  // shows a regression. Defaults to enabled.
  if (process.env.SAM3_ENABLED === "false") {
    return NextResponse.json(
      { error: "sam3_disabled", message: "SAM3 disabled via kill switch" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  // Optional ?address= — full formatted address from the geocoder. We only
  // need the leading house number for OSM `addr:housenumber` matching, so
  // extract just that (digits with an optional letter suffix, e.g.
  // "1234A 17½"). Falls through silently when address is absent or doesn't
  // start with a number (e.g. POI names, ranches without a street number).
  const addressParam = searchParams.get("address") ?? "";
  const houseNumberMatch = addressParam.trim().match(/^(\d+[A-Za-z]?)/);
  const houseNumber = houseNumberMatch ? houseNumberMatch[1] : undefined;

  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "missing_roboflow_key" },
      { status: 503 },
    );
  }
  const googleMapsKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleMapsKey) {
    return NextResponse.json(
      { error: "missing_google_key" },
      { status: 503 },
    );
  }

  // Diagnostic mode — bypass cache so toggling the flag takes effect on
  // the next call. Set SAM3_DIAGNOSTIC_MODE=true in Vercel env to enable.
  const diagnosticMode = process.env.SAM3_DIAGNOSTIC_MODE === "true";
  // ?nocache=1 query param — surgical cache-bust for testing workflow
  // changes without flipping diagnostic mode. Reconciler still runs.
  const noCache = searchParams.get("nocache") === "1";

  // ?clickLat=X&clickLng=Y override — when the rep clicks the right
  // building on the satellite tile (after auto-detection picks wrong),
  // we re-fetch SAM3 with the tile centered EXACTLY on that click. This
  // bypasses resolveBuildingCenter entirely. Cache is also bypassed so
  // the override takes effect immediately rather than serving the bad
  // cached result.
  //
  // Hardening (per code review):
  //   1. Require BOTH params present + non-empty (don't let "" → 0)
  //   2. Validate coordinate ranges (lat ∈ [-90, 90], lng ∈ [-180, 180])
  //   3. Cap distance from geocoded address at 150 m — prevents a
  //      hostile caller from forcing Google Static Maps + Roboflow
  //      calls at arbitrary coordinates (cost-abuse vector). 150m is
  //      generous for rural parcels with deep setbacks while still
  //      tight enough that any click outside the property is rejected.
  const clickLatRaw = searchParams.get("clickLat");
  const clickLngRaw = searchParams.get("clickLng");
  let clickLat = NaN;
  let clickLng = NaN;
  let hasClickOverride = false;
  if (
    clickLatRaw != null &&
    clickLatRaw.trim() !== "" &&
    clickLngRaw != null &&
    clickLngRaw.trim() !== ""
  ) {
    const parsedLat = Number(clickLatRaw);
    const parsedLng = Number(clickLngRaw);
    if (
      !Number.isFinite(parsedLat) ||
      !Number.isFinite(parsedLng) ||
      parsedLat < -90 ||
      parsedLat > 90 ||
      parsedLng < -180 ||
      parsedLng > 180
    ) {
      return NextResponse.json(
        { error: "invalid_click_coords", message: "Click coords out of range." },
        { status: 400 },
      );
    }
    // Distance from geocoded address. 150m cap.
    const dLatM = (parsedLat - lat) * 111_320;
    const dLngM =
      (parsedLng - lng) * 111_320 * Math.cos((lat * Math.PI) / 180);
    const distM = Math.hypot(dLatM, dLngM);
    if (distM > 150) {
      console.warn(
        `[sam3-roof] click override rejected — ${distM.toFixed(0)}m from ` +
          `address (${lat.toFixed(5)}, ${lng.toFixed(5)}), max 150m`,
      );
      return NextResponse.json(
        {
          error: "click_too_far",
          message: `Click is ${distM.toFixed(0)}m from address; max 150m.`,
        },
        { status: 400 },
      );
    }
    clickLat = parsedLat;
    clickLng = parsedLng;
    hasClickOverride = true;
  }

  const skipCache = diagnosticMode || noCache || hasClickOverride;

  if (!skipCache) {
    const cached = await getCached<Sam3CachedResult | null>("sam3-roof", lat, lng);
    if (cached !== null) {
      if (cached === undefined) {
        return NextResponse.json(
          { error: "no_polygon", message: "SAM3 + GIS both failed for this address." },
          { status: 404 },
        );
      }
      return NextResponse.json(cached);
    }
  }

  // ─── Resolve where the actual building is ─────────────────────────────
  // Geocoded addresses often sit on the road, not on the house. Centre
  // the satellite tile on the resolved building location so SAM3 sees
  // the target building dead-centre and the picker can trivially pick it.
  const tileCenter: ResolvedCenter = hasClickOverride
    ? {
        lat: clickLat,
        lng: clickLng,
        source: "click-override",
        zoomHint: 20,
        driftFromAddressM: metersBetween(lat, lng, clickLat, clickLng),
        solarSuggestedDriftM: null,
      }
    : await resolveBuildingCenter(lat, lng, houseNumber);
  // Structured single-line log so it's greppable in Vercel logs:
  //   key=value pairs let us run `vercel logs | grep tile_center_source=`
  //   and compute fallback-rate / drift distribution over time.
  console.log(
    `[sam3-roof] tile_center_source=${tileCenter.source} ` +
      `zoom=${tileCenter.zoomHint} ` +
      `center_lat=${tileCenter.lat.toFixed(6)} ` +
      `center_lng=${tileCenter.lng.toFixed(6)} ` +
      `addr_lat=${lat.toFixed(6)} ` +
      `addr_lng=${lng.toFixed(6)} ` +
      `drift_from_addr_m=${tileCenter.driftFromAddressM.toFixed(1)} ` +
      `solar_suggested_drift_m=${
        tileCenter.solarSuggestedDriftM !== null
          ? tileCenter.solarSuggestedDriftM.toFixed(1)
          : "n/a"
      }`,
  );

  // ─── Fetch the satellite tile ─────────────────────────────────────────
  const tileZoom = tileCenter.zoomHint;
  const tileScale = 2;
  const img = await fetchSatelliteImage({
    lat: tileCenter.lat,
    lng: tileCenter.lng,
    googleApiKey: googleMapsKey,
    sizePx: 640,
    zoom: tileZoom,
    scale: tileScale,
  });
  if (!img) {
    return NextResponse.json(
      { error: "satellite_unavailable" },
      { status: 502 },
    );
  }

  // ─── Call the Roboflow SAM3 workflow ──────────────────────────────────
  let workflowJson: unknown = null;
  // Captured failure reason — surfaced in the JSON response when the
  // workflow call doesn't return a usable polygon, so the rep / developer
  // can see *why* in DevTools without digging through Vercel logs.
  let workflowError: string | null = null;
  try {
    // Roboflow docs recommend Authorization: Bearer header over body-based
    // api_key for serverless inference. Pass both for belt-and-suspenders —
    // either method should authenticate; some serverless endpoints reject
    // body-only auth despite older docs implying it works.
    // Request body matches the shape the Python SDK posts (visible in the
    // Roboflow workflow "Deploy" panel under API → Python):
    //
    //   client.run_workflow(
    //     workspace_name=..., workflow_id=...,
    //     images={"image": <bytes/base64/url>},
    //     parameters={"prompt": "...", "pixels_per_unit": 1, "confidence": 0.3},
    //   )
    //
    // -> POST body:
    //   {
    //     api_key: "...",
    //     inputs: { image: { type: "base64", value: ... }, prompt: "...",
    //               pixels_per_unit: ..., confidence: ... }
    //   }
    //
    // Roboflow's serverless workflow runtime expects EVERY input under a
    // single `inputs` object — `image`, `prompt`, `pixels_per_unit`, and
    // `confidence` are all sibling keys there. The SDK's `images=` and
    // `parameters=` kwargs are a client-side ergonomic split; the wire
    // format merges them. (We confirmed this against the Python SDK source
    // — `inference_sdk.http.client.InferenceHTTPClient.run_workflow` builds
    // the body as `{"api_key": ..., "inputs": {...images, ...parameters}}`.)
    const res = await fetch(ROBOFLOW_WORKFLOW_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: {
          image: { type: "base64", value: img.base64 },
          prompt: SAM3_PROMPT,
          pixels_per_unit: pixelsPerFoot(lat, tileZoom, tileScale),
          confidence: SAM3_CONFIDENCE,
        },
      }),
      // 75s timeout — Roboflow serverless cold starts can take 30-60s
      // when the model hasn't been called recently. Most warm calls
      // complete in 5-10s. Keeps 15s headroom under our 90s maxDuration
      // for reconciliation + GIS fetches.
      signal: AbortSignal.timeout(75_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      workflowError = `workflow_http_${res.status}: ${text.slice(0, 200)}`;
      console.warn(
        `[sam3-roof] Roboflow returned ${res.status} for (${lat}, ${lng}) ` +
          `at ${ROBOFLOW_WORKFLOW_URL}: ${text.slice(0, 300)}`,
      );
    } else {
      workflowJson = await res.json().catch(() => null);
      if (workflowJson === null) {
        workflowError = "workflow_response_not_json";
      }
    }
  } catch (err) {
    workflowError = `workflow_fetch_error: ${err instanceof Error ? err.message : "unknown"}`;
    console.warn(`[sam3-roof] workflow call failed for (${lat}, ${lng}):`, err);
  }

  const extracted = extractAllPolygons(workflowJson);
  if (!extracted) {
    // Helpful shape diagnostic — works whether response is array or object.
    let topLevelHint = "<none>";
    if (Array.isArray(workflowJson) && workflowJson.length > 0 && typeof workflowJson[0] === "object") {
      topLevelHint = `array, item[0] keys: ${Object.keys(workflowJson[0] as object).join(",")}`;
    } else if (workflowJson && typeof workflowJson === "object") {
      topLevelHint = Object.keys(workflowJson as object).join(",");
    }
    console.warn(
      `[sam3-roof] could not extract polygon from workflow response for (${lat}, ${lng}). ` +
        `Top-level keys: ${topLevelHint}`,
    );
    if (!workflowError) {
      workflowError = `workflow_no_polygon (top-level keys: ${topLevelHint})`;
    }
  }

  // ─── Pick the best prediction ─────────────────────────────────────────
  // Because we re-centred the satellite tile on the resolved building
  // centre, the target building is at image centre. So "closest to image
  // centre" = "closest to the actual house". No separate reference lookup
  // needed.
  let pickedPixels: Array<[number, number]> | null = null;
  if (extracted && extracted.predictions.length > 0) {
    const refPx = extracted.imageWidth / 2;
    const refPy = extracted.imageHeight / 2;

    // Compute per-prediction centroid + distance to image center.
    const summaries: Array<{
      idx: number;
      distPx: number;
      areaPx: number;
    }> = [];
    for (let i = 0; i < extracted.predictions.length; i++) {
      const pred = extracted.predictions[i];
      let cx = 0;
      let cy = 0;
      for (const [x, y] of pred.pixels) {
        cx += x;
        cy += y;
      }
      cx /= pred.pixels.length;
      cy /= pred.pixels.length;
      const dx = cx - refPx;
      const dy = cy - refPy;
      const distPx = Math.sqrt(dx * dx + dy * dy);
      summaries.push({ idx: i, distPx, areaPx: pred.pixelArea });
    }

    // Residence-aware picker. Used to be "closest to image center" which
    // failed on rural parcels where the building resolution returned an
    // outbuilding's centroid as the tile center — SAM3 then saw the
    // shop near center and the house at the edge of frame, picked the
    // shop (closest), and we traced the wrong building.
    //
    // Strategy (mirrors lib/buildings.ts):
    //   - At zoom 20 scale 2, 1 px ≈ 0.066m so 1 px² ≈ 0.0044 m². An
    //     80 m² residence floor ≈ 18,000 px².
    //   - Filter predictions with pixelArea < that residence floor
    //     (sheds, AC pads).
    //   - Rural-mode switch: if the closest passing prediction is small
    //     and within ~7m of image center, but a ≥1.6× larger
    //     prediction exists within ~26m of center, prefer the larger.
    //   - Otherwise pick closest-to-center.
    //
    // When the satellite tile is fetched at zoom 19 (rural-fallback path
    // from resolveBuildingCenter), every threshold here that's expressed
    // in pixels has to scale: an 80 m² building at zoom 19 covers ~1/4
    // the pixels it did at zoom 20, and a 26 m radius is ~1/2 as many
    // pixels. Without that scaling the filter eats every prediction and
    // we fall back to closest-to-center, which is exactly the failure
    // mode this picker exists to avoid.
    const zoomScaleFactor = Math.pow(2, 20 - tileZoom);
    const RESIDENCE_MIN_PX2 = Math.round(
      18_000 / (zoomScaleFactor * zoomScaleFactor),
    );
    const NEAR_CENTER_PX = 100 / zoomScaleFactor;
    const RURAL_PROBE_PX = 400 / zoomScaleFactor;
    const sizable = summaries.filter((s) => s.areaPx >= RESIDENCE_MIN_PX2);
    const pool = sizable.length > 0 ? sizable : summaries;
    pool.sort((a, b) => a.distPx - b.distPx);
    const closest = pool[0];
    let chosenIdx = closest.idx;
    if (closest.distPx < NEAR_CENTER_PX) {
      const SIZE_DOMINANCE = 1.6;
      let bestRural: (typeof closest) | null = null;
      for (const s of pool) {
        if (s.idx === closest.idx) continue;
        if (s.distPx > RURAL_PROBE_PX) continue;
        if (s.areaPx >= closest.areaPx * SIZE_DOMINANCE) {
          if (!bestRural || s.areaPx > bestRural.areaPx) bestRural = s;
        }
      }
      if (bestRural) chosenIdx = bestRural.idx;
    }
    const bestIdx = chosenIdx;
    const bestDistSqPx = (() => {
      const found = summaries.find((s) => s.idx === bestIdx);
      return found ? found.distPx * found.distPx : Infinity;
    })();

    if (bestIdx >= 0) {
      const chosen = extracted.predictions[bestIdx];
      const epsilon = Number(process.env.SAM3_SIMPLIFY_EPSILON ?? "6");
      pickedPixels =
        chosen.pixels.length > 8 && epsilon > 0
          ? douglasPeucker(chosen.pixels, epsilon)
          : chosen.pixels;
      const distPx = Math.sqrt(bestDistSqPx);
      const effectiveZoom = tileZoom + Math.log2(tileScale);
      const mPerPx =
        (156_543.03392 * Math.cos((tileCenter.lat * Math.PI) / 180)) /
        Math.pow(2, effectiveZoom);
      const groundFramePx = 640 * tileScale;
      const distM = distPx * mPerPx * (groundFramePx / extracted.imageWidth);
      const altSummary = summaries
        .sort((a, b) => a.distPx - b.distPx)
        .slice(0, 5)
        .map((s) => `[${s.idx}: ${s.distPx.toFixed(0)}px ${s.areaPx.toFixed(0)}area]`)
        .join(" ");
      console.log(
        `[sam3-roof] picked prediction ${bestIdx + 1}/${extracted.predictions.length} ` +
          `(${distM.toFixed(1)}m from image center [${tileCenter.source}], ` +
          `${pickedPixels.length} verts) | candidates: ${altSummary}`,
      );
    }
  }

  // Convert the picked polygon to lat/lng using the SAME centre we used
  // for the tile fetch. Polygon coords from Roboflow are in the workflow
  // image's pixel space, which is centred on tileCenter.lat/lng — not
  // the original geocoded address.
  const sam3LatLng = pickedPixels && extracted
    ? pixelPolygonToLatLng({
        pixels: pickedPixels,
        centerLat: tileCenter.lat,
        centerLng: tileCenter.lng,
        zoom: tileZoom,
        scale: tileScale,
        imageWidth: extracted.imageWidth,
        imageHeight: extracted.imageHeight,
      })
    : null;

  // ─── Diagnostic mode — bypass reconciler when SAM3 returns anything ───
  // When SAM3_DIAGNOSTIC_MODE=true, return the raw SAM3 polygon as-is with
  // ALL reconciliation gates bypassed: no area-ratio check, no centroid
  // drift check, no min/max sqft sanity bounds. Lets you SEE exactly what
  // SAM3 produced (vs the GIS substitute the reconciler would normally
  // return on failure). Use only for diagnosis — toggle off afterward.
  if (diagnosticMode && sam3LatLng && sam3LatLng.length >= 3) {
    const sqft = Math.round(polygonAreaSqft(sam3LatLng));
    // Compute polygon centroid and distance from the geocoded address.
    // This is the diagnostic the user actually needs — tells us whether
    // SAM3 placed the polygon ON the building (small distance), OFFSET
    // by a consistent amount (conversion bug), or somewhere else
    // entirely (wrong building / model issue).
    let cLat = 0;
    let cLng = 0;
    for (const v of sam3LatLng) {
      cLat += v.lat;
      cLng += v.lng;
    }
    cLat /= sam3LatLng.length;
    cLng /= sam3LatLng.length;
    const cosLatHere = Math.cos((tileCenter.lat * Math.PI) / 180);
    const dLatM = (cLat - tileCenter.lat) * 111_320;
    const dLngM = (cLng - tileCenter.lng) * 111_320 * cosLatHere;
    const distM = Math.hypot(dLatM, dLngM);
    const bearingDeg = ((Math.atan2(dLngM, dLatM) * 180) / Math.PI + 360) % 360;
    console.log(
      `[sam3-roof] DIAGNOSTIC MODE: returning raw SAM3 polygon ` +
        `(${sam3LatLng.length} verts, ${sqft} sqft) — reconciler bypassed`,
    );
    console.log(
      `[sam3-roof] DIAGNOSTIC: tile centered on ${tileCenter.source}, ` +
        `polygon centroid=(${cLat.toFixed(6)}, ${cLng.toFixed(6)}), ` +
        `distance from tile center=${distM.toFixed(1)}m at bearing ${bearingDeg.toFixed(0)}°, ` +
        `first point=(${sam3LatLng[0].lat.toFixed(6)}, ${sam3LatLng[0].lng.toFixed(6)})`,
    );
    return NextResponse.json({
      polygon: sam3LatLng,
      footprintSqft: sqft,
      source: "sam3",
      reason: "DIAGNOSTIC MODE — raw SAM3 polygon, all reconciliation gates bypassed",
      diagnostics: {
        sam3Sqft: sqft,
        gisSqft: null,
        areaRatio: null,
        iou: null,
        gisSource: null,
        sam3CentroidNearAddress: null,
        diagnosticMode: true,
      },
      computedAt: new Date().toISOString(),
    });
  }

  // ─── Reconcile with GIS footprint ─────────────────────────────────────
  // Pass tileCenter as the reference point so the reconciler's proximity
  // check (CATASTROPHIC_DRIFT_M = 15m) uses the actual building location,
  // not the geocoded address. Without this, SAM3 polygons on setback
  // houses would falsely fail "wrong building" because they're correctly
  // 30m from the road-side address.
  const reconciled = await reconcileRoofPolygon({
    lat,
    lng,
    referenceLat: tileCenter.lat,
    referenceLng: tileCenter.lng,
    sam3Polygon: sam3LatLng,
    houseNumber,
  });

  if (!reconciled) {
    // Cache the miss as `null` so we don't re-call Roboflow on retry storms.
    // Sentinel pattern matches /api/microsoft-building, /api/solar-mask.
    if (!skipCache) {
      await setCached<Sam3CachedResult | null>("sam3-roof", lat, lng, null);
    }
    return NextResponse.json(
      {
        error: "no_polygon",
        message: "SAM3 + GIS both failed for this address.",
        // Surface the workflow failure reason in the response so the rep
        // can diagnose without checking Vercel logs. Wrong workspace name,
        // expired workflow ID, missing inputs, and API-key permission
        // problems all land here as a short identifying string.
        workflowError,
        workflowUrl: ROBOFLOW_WORKFLOW_URL,
      },
      { status: 404 },
    );
  }

  const result: Sam3CachedResult = {
    ...reconciled,
    computedAt: new Date().toISOString(),
  };
  if (!skipCache) {
    await setCached("sam3-roof", lat, lng, result);
  }

  console.log(
    `[sam3-roof] (${lat.toFixed(5)}, ${lng.toFixed(5)}) → source=${result.source} ` +
      `sqft=${result.footprintSqft} ratio=${result.diagnostics.areaRatio?.toFixed(2) ?? "n/a"} ` +
      `iou=${result.diagnostics.iou?.toFixed(2) ?? "n/a"} reason="${result.reason}"`,
  );

  return NextResponse.json(result);
}

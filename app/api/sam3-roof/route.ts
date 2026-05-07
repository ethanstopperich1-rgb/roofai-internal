import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { fetchSatelliteImage } from "@/lib/satellite-tile";
import {
  reconcileRoofPolygon,
  type ReconciledRoof,
} from "@/lib/reconcile-roof-polygon";
import { getCached, setCached } from "@/lib/cache";
import { polygonAreaSqft } from "@/lib/polygon";
import type { SolarSummary } from "@/types/estimate";
import type { SolarMaskPolygon } from "@/lib/solar-mask";
import { fetchMicrosoftBuildingPolygon } from "@/lib/microsoft-buildings";
import { fetchBuildingPolygon } from "@/lib/buildings";

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

const ROBOFLOW_WORKFLOW_URL =
  "https://serverless.roboflow.com/infer/workflows/bradens-workspace/sam3-roof-segmentation-test-1778124556737";

const SAM3_PROMPT = "entire house roof";

interface Sam3CachedResult extends ReconciledRoof {
  /** When this run actually called Roboflow (vs served from cache). */
  computedAt: string;
}

/** Pixels per FOOT at zoom 20 / scale 2 for a given latitude.
 *  Web Mercator: m/px = 156543.03392 × cos(lat) / 2^21. */
function pixelsPerFoot(lat: number): number {
  const mPerPx = (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, 21);
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

/** Convert pixel polygon to lat/lng using the same projection as the rest
 *  of the pipeline (zoom 20, scale 2 → 1280×1280 ground frame). When the
 *  workflow returns image dimensions different from 1280 (e.g. it resized
 *  internally), we scale pixel coords back to the 1280 frame before
 *  applying the geo-projection. */
function pixelPolygonToLatLng(opts: {
  pixels: Array<[number, number]>;
  centerLat: number;
  centerLng: number;
  /** Width of the image the polygon was traced on (defaults to 1280 — our
   *  zoom-20 scale-2 tile size). */
  imageWidth?: number;
  /** Height of the image the polygon was traced on (defaults to 1280). */
  imageHeight?: number;
}): Array<{ lat: number; lng: number }> {
  const {
    pixels,
    centerLat,
    centerLng,
    imageWidth = 1280,
    imageHeight = 1280,
  } = opts;
  const mPerPx = (156_543.03392 * Math.cos((centerLat * Math.PI) / 180)) / Math.pow(2, 21);
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  // Polygon coords are in `imageWidth × imageHeight` space. We project
  // each axis independently relative to the image centre, treating the
  // image as covering 1280px worth of ground in each axis (Google Static
  // Maps zoom-20 scale-2 frame). When the source image isn't 1280, the
  // ratio (1280/imageWidth) stretches the polygon back to ground frame.
  const xScale = 1280 / imageWidth;
  const yScale = 1280 / imageHeight;
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
          typeof pred.area_px === "number" ? pred.area_px : pixels.length;
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
        predictions: [{ pixels: poly, pixelArea: poly.length }],
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

/** Resolve the best available "actual building center" for the address.
 *
 *  The geocoded address often sits on the road rather than on the actual
 *  house — particularly true for setback rural / suburban properties.
 *  Centering the satellite tile on this resolved point puts the target
 *  building in the centre of the image, dramatically improving SAM3's
 *  segmentation AND making "closest to image center" trivially correct
 *  for the picker.
 *
 *  Fallback chain:
 *    1. Solar findClosest's buildingCenter (cached if /api/solar fired)
 *    2. Solar mask polygon centroid (cached if /api/solar-mask fired)
 *    3. Microsoft Buildings polygon centroid
 *    4. OSM Overpass polygon centroid
 *    5. Geocoded address (no recentering)
 */
async function resolveBuildingCenter(
  lat: number,
  lng: number,
): Promise<{ lat: number; lng: number; source: string }> {
  // 1. Solar findClosest's buildingCenter (try Redis cache first, fall
  //    through to a direct Solar API call if the cache is empty).
  //
  //    Why the direct call — the page fires /api/solar AND /api/sam3-roof
  //    in parallel. /api/sam3-roof reaches resolveBuildingCenter at the
  //    very start of the route (before its 5-15s Roboflow workflow), so
  //    /api/solar typically hasn't finished and written to cache yet.
  //    Without a direct fallback we end up using the address as the
  //    reference, which is exactly what we're trying to avoid.
  const solarCached = await getCached<SolarSummary>("solar", lat, lng).catch(() => null);
  if (solarCached?.buildingCenter) {
    return {
      lat: solarCached.buildingCenter.lat,
      lng: solarCached.buildingCenter.lng,
      source: "solar-buildingCenter",
    };
  }
  // Cache miss — call Solar findClosest directly. Just need data.center;
  // we don't need to parse the full SolarSummary here. /api/solar will
  // race-write the full summary into cache shortly anyway.
  if (!solarCached) {
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
            return {
              lat: data.center.latitude,
              lng: data.center.longitude,
              source: "solar-buildingCenter-direct",
            };
          }
        }
      } catch {
        // fall through to other sources
      }
    }
  }

  // 2. Solar mask polygon centroid (also Redis-cached when /api/solar-mask fired)
  const solarMask = await getCached<SolarMaskPolygon | null>(
    "solar-mask",
    lat,
    lng,
  ).catch(() => null);
  if (solarMask?.latLng?.length) {
    let cLat = 0;
    let cLng = 0;
    for (const v of solarMask.latLng) {
      cLat += v.lat;
      cLng += v.lng;
    }
    return {
      lat: cLat / solarMask.latLng.length,
      lng: cLng / solarMask.latLng.length,
      source: "solar-mask-centroid",
    };
  }

  // 3. Microsoft Buildings (precomputed local file — fast)
  const ms = await fetchMicrosoftBuildingPolygon({ lat, lng }).catch(() => null);
  if (ms?.polygon?.length) {
    let cLat = 0;
    let cLng = 0;
    for (const v of ms.polygon) {
      cLat += v.lat;
      cLng += v.lng;
    }
    return {
      lat: cLat / ms.polygon.length,
      lng: cLng / ms.polygon.length,
      source: "ms-buildings-centroid",
    };
  }

  // 4. OSM Overpass (slower, requires network) — User-Agent fix should
  //    have unblocked this for FL addresses
  const osm = await fetchBuildingPolygon({ lat, lng }).catch(() => null);
  if (osm?.latLng?.length) {
    let cLat = 0;
    let cLng = 0;
    for (const v of osm.latLng) {
      cLat += v.lat;
      cLng += v.lng;
    }
    return {
      lat: cLat / osm.latLng.length,
      lng: cLng / osm.latLng.length,
      source: "osm-centroid",
    };
  }

  // 5. Last resort — use the geocoded address itself
  return { lat, lng, source: "address" };
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
  const skipCache = diagnosticMode || noCache;

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
  const tileCenter = await resolveBuildingCenter(lat, lng);
  console.log(
    `[sam3-roof] tile centered on ${tileCenter.source}: ` +
      `(${tileCenter.lat.toFixed(6)}, ${tileCenter.lng.toFixed(6)}) ` +
      `for address (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
  );

  // ─── Fetch the satellite tile ─────────────────────────────────────────
  const img = await fetchSatelliteImage({
    lat: tileCenter.lat,
    lng: tileCenter.lng,
    googleApiKey: googleMapsKey,
    sizePx: 640,
    zoom: 20,
    scale: 2,
  });
  if (!img) {
    return NextResponse.json(
      { error: "satellite_unavailable" },
      { status: 502 },
    );
  }

  // ─── Call the Roboflow SAM3 workflow ──────────────────────────────────
  let workflowJson: unknown = null;
  try {
    // Roboflow docs recommend Authorization: Bearer header over body-based
    // api_key for serverless inference. Pass both for belt-and-suspenders —
    // either method should authenticate; some serverless endpoints reject
    // body-only auth despite older docs implying it works.
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
          pixels_per_unit: pixelsPerFoot(lat),
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
      console.warn(
        `[sam3-roof] Roboflow returned ${res.status} for (${lat}, ${lng}): ${text.slice(0, 300)}`,
      );
    } else {
      workflowJson = await res.json().catch(() => null);
    }
  } catch (err) {
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

    let bestIdx = -1;
    let bestDistSqPx = Infinity;
    const summaries: Array<{ idx: number; distPx: number; areaPx: number }> = [];
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
      const dSq = dx * dx + dy * dy;
      summaries.push({ idx: i, distPx: Math.sqrt(dSq), areaPx: pred.pixelArea });
      if (dSq < bestDistSqPx) {
        bestDistSqPx = dSq;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const chosen = extracted.predictions[bestIdx];
      const epsilon = Number(process.env.SAM3_SIMPLIFY_EPSILON ?? "6");
      pickedPixels =
        chosen.pixels.length > 8 && epsilon > 0
          ? douglasPeucker(chosen.pixels, epsilon)
          : chosen.pixels;
      const distPx = Math.sqrt(bestDistSqPx);
      const mPerPx =
        (156_543.03392 * Math.cos((tileCenter.lat * Math.PI) / 180)) /
        Math.pow(2, 21);
      const distM = distPx * mPerPx * (1280 / extracted.imageWidth);
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
  });

  if (!reconciled) {
    // Cache the miss as `null` so we don't re-call Roboflow on retry storms.
    // Sentinel pattern matches /api/microsoft-building, /api/solar-mask.
    if (!skipCache) {
      await setCached<Sam3CachedResult | null>("sam3-roof", lat, lng, null);
    }
    return NextResponse.json(
      { error: "no_polygon", message: "SAM3 + GIS both failed for this address." },
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

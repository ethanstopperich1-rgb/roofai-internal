import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { fetchSatelliteImage } from "@/lib/satellite-tile";
import {
  reconcileRoofPolygon,
  type ReconciledRoof,
} from "@/lib/reconcile-roof-polygon";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 60;

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

/** Convert pixel polygon (1280×1280 image space) to lat/lng using the
 *  same projection as the rest of the pipeline (zoom 20, scale 2). */
function pixelPolygonToLatLng(opts: {
  pixels: Array<[number, number]>;
  centerLat: number;
  centerLng: number;
  imagePixels?: number;
}): Array<{ lat: number; lng: number }> {
  const { pixels, centerLat, centerLng, imagePixels = 1280 } = opts;
  const mPerPx = (156_543.03392 * Math.cos((centerLat * Math.PI) / 180)) / Math.pow(2, 21);
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  return pixels.map(([x, y]) => {
    const dxM = (x - imagePixels / 2) * mPerPx;
    const dyM = (imagePixels / 2 - y) * mPerPx;
    return {
      lat: centerLat + dyM / 111_320,
      lng: centerLng + dxM / (111_320 * cosLat),
    };
  });
}

/** Best-effort polygon extractor for the Roboflow Workflow response.
 *  The response shape is workflow-specific and changes when blocks are
 *  edited in the Roboflow UI — we look in the most likely places and
 *  log the raw payload when nothing parses, so a shape change is a
 *  one-line fix instead of a debugging session.
 *
 *  Expected shapes (any of these works):
 *    1. outputs[0].roof_polygons[].points = [{x, y}, ...] or [[x, y], ...]
 *    2. outputs[0].predictions[].points    = same
 *    3. predictions[].points               = same (top-level)
 *    4. outputs[0].polygon                 = [[x, y], ...]
 */
function extractPolygonPixels(data: unknown): Array<[number, number]> | null {
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;

  const candidates: unknown[] = [];
  const outputsArr = Array.isArray(root.outputs) ? root.outputs : null;
  const firstOutput =
    outputsArr && outputsArr.length > 0 && typeof outputsArr[0] === "object"
      ? (outputsArr[0] as Record<string, unknown>)
      : null;

  // Direct `outputs[0]` access
  if (firstOutput) {
    candidates.push(firstOutput.roof_polygons);
    candidates.push(firstOutput.predictions);
    candidates.push(firstOutput.polygons);
    candidates.push(firstOutput.polygon);
  }
  // Top-level fallbacks
  candidates.push(root.predictions);
  candidates.push(root.polygons);
  candidates.push(root.polygon);

  for (const c of candidates) {
    const poly = coercePolygon(c);
    if (poly) return poly;
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

  // ─── Fetch the satellite tile ─────────────────────────────────────────
  const img = await fetchSatelliteImage({
    lat,
    lng,
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
    const res = await fetch(ROBOFLOW_WORKFLOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: {
          image: { type: "base64", value: img.base64 },
          prompt: SAM3_PROMPT,
          pixels_per_unit: pixelsPerFoot(lat),
        },
      }),
      signal: AbortSignal.timeout(45_000),
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

  const polygonPixels = extractPolygonPixels(workflowJson);
  if (!polygonPixels) {
    console.warn(
      `[sam3-roof] could not extract polygon from workflow response for (${lat}, ${lng}). ` +
        `Top-level keys: ${
          workflowJson && typeof workflowJson === "object"
            ? Object.keys(workflowJson as object).join(",")
            : "<none>"
        }`,
    );
  }

  const sam3LatLng = polygonPixels
    ? pixelPolygonToLatLng({
        pixels: polygonPixels,
        centerLat: lat,
        centerLng: lng,
      })
    : null;

  // ─── Reconcile with GIS footprint ─────────────────────────────────────
  const reconciled = await reconcileRoofPolygon({
    lat,
    lng,
    sam3Polygon: sam3LatLng,
  });

  if (!reconciled) {
    // Cache the miss as `null` so we don't re-call Roboflow on retry storms.
    // Sentinel pattern matches /api/microsoft-building, /api/solar-mask.
    await setCached<Sam3CachedResult | null>("sam3-roof", lat, lng, null);
    return NextResponse.json(
      { error: "no_polygon", message: "SAM3 + GIS both failed for this address." },
      { status: 404 },
    );
  }

  const result: Sam3CachedResult = {
    ...reconciled,
    computedAt: new Date().toISOString(),
  };
  await setCached("sam3-roof", lat, lng, result);

  console.log(
    `[sam3-roof] (${lat.toFixed(5)}, ${lng.toFixed(5)}) → source=${result.source} ` +
      `sqft=${result.footprintSqft} ratio=${result.diagnostics.areaRatio?.toFixed(2) ?? "n/a"} ` +
      `iou=${result.diagnostics.iou?.toFixed(2) ?? "n/a"} reason="${result.reason}"`,
  );

  return NextResponse.json(result);
}

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { fetchSatelliteImage } from "@/lib/satellite-tile";
import {
  reconcileRoofPolygon,
  type ReconciledRoof,
} from "@/lib/reconcile-roof-polygon";
import { getCached, setCached } from "@/lib/cache";
import { polygonAreaSqft } from "@/lib/polygon";

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

interface ExtractedPolygon {
  pixels: Array<[number, number]>;
  /** Width of the image the polygon was traced on, per the workflow
   *  response. Used to scale pixel coords back to our 1280-px ground frame
   *  before the geo-projection. Defaults to 1280 if the response doesn't
   *  include image dimensions. */
  imageWidth: number;
  imageHeight: number;
}

/** Extract the polygon from the Roboflow Workflow response.
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
 *  We pick the largest prediction by `area_px` (handles multi-detection
 *  cases where SAM3 segments multiple roofs and we want the main one).
 *  Falls back to older parser shapes if the new path isn't present, so
 *  the route survives future workflow restructures.
 */
function extractPolygonPixels(data: unknown): ExtractedPolygon | null {
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
      // Pick the largest by area_px (or by point count as fallback).
      let best: Record<string, unknown> | null = null;
      let bestArea = -Infinity;
      for (const p of preds) {
        if (!p || typeof p !== "object") continue;
        const pred = p as Record<string, unknown>;
        const area =
          typeof pred.area_px === "number"
            ? pred.area_px
            : Array.isArray(pred.points)
              ? pred.points.length
              : 0;
        if (area > bestArea) {
          bestArea = area;
          best = pred;
        }
      }
      const points = best?.points;
      const pixels = coercePolygon(points);
      if (pixels) {
        const img =
          ra.image && typeof ra.image === "object"
            ? (ra.image as Record<string, unknown>)
            : null;
        const imageWidth =
          typeof img?.width === "number" && img.width > 0 ? img.width : 1280;
        const imageHeight =
          typeof img?.height === "number" && img.height > 0 ? img.height : 1280;
        return { pixels, imageWidth, imageHeight };
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
      return { pixels: poly, imageWidth: 1280, imageHeight: 1280 };
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

  if (!diagnosticMode) {
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

  const extracted = extractPolygonPixels(workflowJson);
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
  } else {
    console.log(
      `[sam3-roof] extracted polygon: ${extracted.pixels.length} verts in ` +
        `${extracted.imageWidth}×${extracted.imageHeight} image space`,
    );
  }

  const sam3LatLng = extracted
    ? pixelPolygonToLatLng({
        pixels: extracted.pixels,
        centerLat: lat,
        centerLng: lng,
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
    const cosLatHere = Math.cos((lat * Math.PI) / 180);
    const dLatM = (cLat - lat) * 111_320;
    const dLngM = (cLng - lng) * 111_320 * cosLatHere;
    const distM = Math.hypot(dLatM, dLngM);
    const bearingDeg = ((Math.atan2(dLngM, dLatM) * 180) / Math.PI + 360) % 360;
    console.log(
      `[sam3-roof] DIAGNOSTIC MODE: returning raw SAM3 polygon ` +
        `(${sam3LatLng.length} verts, ${sqft} sqft) for (${lat.toFixed(5)}, ${lng.toFixed(5)}) — ` +
        `reconciler bypassed`,
    );
    console.log(
      `[sam3-roof] DIAGNOSTIC: polygon centroid=(${cLat.toFixed(6)}, ${cLng.toFixed(6)}), ` +
        `distance from address=${distM.toFixed(1)}m at bearing ${bearingDeg.toFixed(0)}°, ` +
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
  const reconciled = await reconcileRoofPolygon({
    lat,
    lng,
    sam3Polygon: sam3LatLng,
  });

  if (!reconciled) {
    // Cache the miss as `null` so we don't re-call Roboflow on retry storms.
    // Sentinel pattern matches /api/microsoft-building, /api/solar-mask.
    if (!diagnosticMode) {
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
  if (!diagnosticMode) {
    await setCached("sam3-roof", lat, lng, result);
  }

  console.log(
    `[sam3-roof] (${lat.toFixed(5)}, ${lng.toFixed(5)}) → source=${result.source} ` +
      `sqft=${result.footprintSqft} ratio=${result.diagnostics.areaRatio?.toFixed(2) ?? "n/a"} ` +
      `iou=${result.diagnostics.iou?.toFixed(2) ?? "n/a"} reason="${result.reason}"`,
  );

  return NextResponse.json(result);
}

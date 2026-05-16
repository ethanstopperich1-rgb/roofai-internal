import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { rateLimit } from "@/lib/ratelimit";
import { fetchSatelliteImage } from "@/lib/satellite-tile";
import { getCached, setCached, CACHE_TTL } from "@/lib/cache";
import { polygonAreaSqft } from "@/lib/polygon";
import {
  SAM2_WORKFLOW_URL,
  SAM2_CLASSES,
  SAM2_PROMPT_CLASSES,
  SAM2_CONFIDENCE,
  isSam2Configured,
} from "@/lib/roboflow-workflow-config";
import type { SurfaceClass, SurfacePolygon } from "@/types/estimate";

export const runtime = "nodejs";
// Same 90s ceiling as /api/sam3-roof — SAM2 also runs through Roboflow
// serverless which can cold-start in the 30-60s range. The pipeline
// caller fan-outs this call in parallel with Solar and treats any error
// as a soft-fail, so timing out is bounded.
export const maxDuration = 90;

/**
 * GET /api/sam2-surfaces?lat=..&lng=..&sam3Polygon=<JSON>
 *
 * Phase 2 — SAM2 classifies each surface INSIDE the SAM3 outline:
 * main shingle, flat roof, screened lanai, garage, skylight, solar
 * panel, plus non-roof bleed-throughs (pool, driveway, lawn). Outputs
 * lat/lng polygons with per-surface areaSqft + confidence.
 *
 * This is strictly additive — the customer-facing sqft number stays
 * owned by Solar API's per-facet `areaSqftSloped` sum. Surfaces feed
 * the rep visualization layer + future per-surface pricing (subtract
 * lanai screen from shingle area, etc.).
 *
 * Graceful degradation contract:
 *   - SAM2 not configured (env var unset) → 200 with empty surfaces.
 *   - Roboflow 500 / timeout / malformed response → 200 with empty
 *     surfaces (NOT a 5xx — Phase 2 must never block Phase 1).
 *   - Invalid inputs (bad lat/lng, missing/short polygon) → 400.
 *
 * Cached per (lat, lng) for 30 days. Surfaces change rarely — when a
 * new shingle is installed the outline polygon stays the same; the
 * sub-region classes don't shift. Monthly TTL is generous; rep can
 * force re-fetch with ?nocache=1.
 */

/** ────────────────────────────────────────────────────────────────────
 *  Pixel ↔ lat/lng projection helpers. Mirror /api/sam3-roof's
 *  `pixelPolygonToLatLng` (around line 155-195) so the two routes
 *  agree on the ground-frame math. Web Mercator inverse: for a tile
 *  centered at (centerLat, centerLng) with effective zoom Z and image
 *  dimensions imageWidth × imageHeight px, each px offset from image
 *  center corresponds to a known meter offset on the ground; meters
 *  convert to degrees via 111,320 m / deg (lat) and 111,320 × cos(lat)
 *  m / deg (lng). When the workflow returns image dims different from
 *  our tile size, we rescale pixel coords back to the ground frame
 *  first — same fix that bit us on sam3-roof before.
 *  ──────────────────────────────────────────────────────────────────── */
function pixelPolygonToLatLng(opts: {
  pixels: Array<[number, number]>;
  centerLat: number;
  centerLng: number;
  zoom: number;
  scale: number;
  imageWidth: number;
  imageHeight: number;
}): Array<{ lat: number; lng: number }> {
  const {
    pixels,
    centerLat,
    centerLng,
    zoom,
    scale,
    imageWidth,
    imageHeight,
  } = opts;
  const effectiveZoom = zoom + Math.log2(scale);
  const mPerPx =
    (156_543.03392 * Math.cos((centerLat * Math.PI) / 180)) /
    Math.pow(2, effectiveZoom);
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
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

/** Parse `sam3Polygon` query param. Accepts a JSON-encoded array of
 *  {lat, lng} pairs. Returns null on any malformed input — caller
 *  emits a 400. The polygon needs ≥3 vertices to define a region;
 *  anything less is degenerate and can't be a roof outline. */
function parseSam3Polygon(
  raw: string | null,
): Array<{ lat: number; lng: number }> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length < 3) return null;
    const out: Array<{ lat: number; lng: number }> = [];
    for (const v of parsed) {
      if (
        !v ||
        typeof v !== "object" ||
        typeof v.lat !== "number" ||
        typeof v.lng !== "number" ||
        !Number.isFinite(v.lat) ||
        !Number.isFinite(v.lng)
      ) {
        return null;
      }
      out.push({ lat: v.lat, lng: v.lng });
    }
    return out;
  } catch {
    return null;
  }
}

/** Compute lat/lng bbox of a polygon. Returns sw / ne corners + the
 *  center. Used to size the satellite tile so SAM2 sees the full
 *  outline with a 10% pad of breathing room. */
function polygonBbox(poly: Array<{ lat: number; lng: number }>): {
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
  centerLat: number;
  centerLng: number;
} {
  let swLat = Infinity;
  let swLng = Infinity;
  let neLat = -Infinity;
  let neLng = -Infinity;
  for (const v of poly) {
    if (v.lat < swLat) swLat = v.lat;
    if (v.lng < swLng) swLng = v.lng;
    if (v.lat > neLat) neLat = v.lat;
    if (v.lng > neLng) neLng = v.lng;
  }
  return {
    swLat,
    swLng,
    neLat,
    neLng,
    centerLat: (swLat + neLat) / 2,
    centerLng: (swLng + neLng) / 2,
  };
}

/** Decide what zoom to fetch the satellite tile at so the SAM3 polygon
 *  plus a 10% pad fits inside a 640×640 tile (at scale 2 → 1280 px
 *  ground frame). Conservative — always at most zoom 20 because that's
 *  the highest Google Static Maps ground resolution we trust. */
function chooseZoom(bbox: ReturnType<typeof polygonBbox>): number {
  // Width of the bbox in meters, padded 10%.
  const cosLat = Math.cos((bbox.centerLat * Math.PI) / 180);
  const widthM = (bbox.neLng - bbox.swLng) * 111_320 * cosLat * 1.1;
  const heightM = (bbox.neLat - bbox.swLat) * 111_320 * 1.1;
  const longestM = Math.max(widthM, heightM, 10); // floor to avoid div/0
  // mPerPx at scale=2 effective zoom Z: 156543 * cos(lat) / 2^(Z+1)
  // We need 1280 px to cover longestM → mPerPx = longestM / 1280.
  const targetMPerPx = longestM / 1280;
  const num = 156_543.03392 * cosLat;
  const z = Math.log2(num / targetMPerPx) - 1;
  return Math.min(20, Math.max(17, Math.round(z)));
}

interface ExtractedSurface {
  pixels: Array<[number, number]>;
  pixelArea: number;
  className: string;
  confidence: number;
}

/** Compute shoelace area in px². Used as fallback when Roboflow omits
 *  an `area_px` field. Mirrors the SAM3 route's helper. */
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

/** Normalize the various pixel-polygon shapes Roboflow can emit
 *  ({points: [{x,y}]}, [[x,y]], etc.) into [[x,y], ...]. Same shape
 *  permissiveness the SAM3 route uses for forward-compat with workflow
 *  schema changes. */
function coercePoints(input: unknown): Array<[number, number]> | null {
  if (!input) return null;
  if (Array.isArray(input)) {
    if (input.length === 0) return null;
    if (Array.isArray(input[0]) && input[0].length >= 2) {
      const out: Array<[number, number]> = [];
      for (const p of input) {
        if (
          Array.isArray(p) &&
          typeof p[0] === "number" &&
          typeof p[1] === "number"
        ) {
          out.push([p[0], p[1]]);
        }
      }
      return out.length >= 3 ? out : null;
    }
    if (input[0] && typeof input[0] === "object" && "x" in input[0]) {
      const out: Array<[number, number]> = [];
      for (const p of input) {
        const pp = p as { x?: unknown; y?: unknown };
        if (typeof pp.x === "number" && typeof pp.y === "number") {
          out.push([pp.x, pp.y]);
        }
      }
      return out.length >= 3 ? out : null;
    }
  }
  return null;
}

/** Extract predictions from the workflow response. We accept several
 *  shapes because the Roboflow workflow author may pick any of the
 *  prompted-segmentation blocks (Grounded SAM, SAM2 with prompt, etc.)
 *  and the output schemas vary slightly. Look for predictions under
 *  these top-level keys, in order: predictions, surfaces, segments,
 *  output.predictions. Each prediction can carry `points`, `polygon`,
 *  or `mask`; class string is at `class`, `class_name`, or `label`. */
function extractSurfaces(data: unknown): {
  surfaces: ExtractedSurface[];
  imageWidth: number;
  imageHeight: number;
} | null {
  if (!data) return null;
  let root: Record<string, unknown> | null = null;
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
    root = data[0] as Record<string, unknown>;
  } else if (typeof data === "object") {
    root = data as Record<string, unknown>;
  }
  if (!root) return null;

  // Some workflows nest under .outputs[0]
  if (Array.isArray(root.outputs) && root.outputs.length > 0 && typeof root.outputs[0] === "object") {
    root = root.outputs[0] as Record<string, unknown>;
  }

  // Find the predictions array — try common keys in priority order.
  let predsContainer: Record<string, unknown> | null = null;
  let predsArr: unknown[] | null = null;
  const candidateKeys = [
    "surfaces",
    "predictions",
    "segments",
    "roof_surfaces",
    "output",
  ];
  for (const k of candidateKeys) {
    const v = root[k];
    if (Array.isArray(v) && v.length > 0) {
      predsArr = v;
      predsContainer = root;
      break;
    }
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).predictions;
      if (Array.isArray(inner) && inner.length > 0) {
        predsArr = inner;
        predsContainer = v as Record<string, unknown>;
        break;
      }
    }
  }
  if (!predsArr) return null;

  // Image dims — needed to scale pixel polygons back to our 1280px
  // ground frame. Default to 1280 (our tile size at scale=2) when the
  // workflow doesn't include them.
  let imageWidth = 1280;
  let imageHeight = 1280;
  const img =
    predsContainer && typeof predsContainer.image === "object"
      ? (predsContainer.image as Record<string, unknown>)
      : null;
  if (img && typeof img.width === "number" && img.width > 0) {
    imageWidth = img.width;
  }
  if (img && typeof img.height === "number" && img.height > 0) {
    imageHeight = img.height;
  }

  const surfaces: ExtractedSurface[] = [];
  for (const p of predsArr) {
    if (!p || typeof p !== "object") continue;
    const pred = p as Record<string, unknown>;
    const points =
      coercePoints(pred.points) ??
      coercePoints(pred.polygon) ??
      coercePoints(pred.mask);
    if (!points) continue;
    const classRaw =
      (typeof pred.class === "string" && pred.class) ||
      (typeof pred.class_name === "string" && pred.class_name) ||
      (typeof pred.label === "string" && pred.label) ||
      "unknown";
    const confidence =
      typeof pred.confidence === "number" && Number.isFinite(pred.confidence)
        ? pred.confidence
        : 0.5;
    const pixelArea =
      typeof pred.area_px === "number" && pred.area_px > 0
        ? pred.area_px
        : pixelPolygonArea(points);
    surfaces.push({ pixels: points, pixelArea, className: classRaw, confidence });
  }
  return { surfaces, imageWidth, imageHeight };
}

/** Map an arbitrary class string from the workflow to our SurfaceClass
 *  enum. Roboflow class names may come back with slight variations
 *  ("Shingle Roof", "main-shingle", "MAIN_SHINGLE") — normalize and
 *  match. Anything we don't recognize bucket as "unknown" rather than
 *  drop, so the rep can see + correct the misclassification. */
function normalizeClass(raw: string): SurfaceClass {
  const k = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const known: SurfaceClass[] = [
    "main_shingle",
    "flat_roof",
    "lanai_screen",
    "garage",
    "skylight",
    "solar_panel",
    "pool",
    "driveway",
    "lawn",
  ];
  for (const c of known) {
    if (k === c) return c;
  }
  // Common aliases — Roboflow workflow authors may use synonyms.
  if (k.includes("shingle")) return "main_shingle";
  if (k.includes("flat") || k.includes("membrane") || k.includes("tpo"))
    return "flat_roof";
  if (k.includes("lanai") || k.includes("screen") || k.includes("cage"))
    return "lanai_screen";
  if (k.includes("garage")) return "garage";
  if (k.includes("skylight")) return "skylight";
  if (k.includes("solar") || k.includes("panel") || k.includes("pv"))
    return "solar_panel";
  if (k.includes("pool")) return "pool";
  if (k.includes("drive")) return "driveway";
  if (k.includes("lawn") || k.includes("grass")) return "lawn";
  return "unknown";
}

interface Sam2CachedResult {
  surfaces: SurfacePolygon[];
  imageryDate: string | null;
  computedAt: string;
}

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return NextResponse.json(
      { error: "lat & lng required (lat ∈ [-90, 90], lng ∈ [-180, 180])" },
      { status: 400 },
    );
  }

  // ─── Gate: SAM2 not configured ───────────────────────────────────────
  // Graceful no-op. The pipeline fans this out in parallel with Solar
  // and treats empty surfaces as "Phase 2 not active." No upstream call,
  // no error logged — Phase 2 is strictly additive.
  if (!isSam2Configured()) {
    console.warn(
      "sam2: gate=not_configured reason=ROBOFLOW_SAM2_WORKFLOW_URL_unset " +
        `lat=${lat.toFixed(5)} lng=${lng.toFixed(5)}`,
    );
    return NextResponse.json({
      surfaces: [],
      reason: "sam2_not_configured",
      imageryDate: null,
      computedAt: new Date().toISOString(),
    });
  }

  const sam3PolygonRaw = searchParams.get("sam3Polygon");
  const sam3Polygon = parseSam3Polygon(sam3PolygonRaw);
  if (!sam3Polygon) {
    return NextResponse.json(
      {
        error:
          "sam3Polygon required (JSON-encoded array of {lat,lng}, >=3 vertices)",
      },
      { status: 400 },
    );
  }

  const noCache = searchParams.get("nocache") === "1";

  // Cache scope — bump when the workflow's class list / output schema
  // changes materially so old results don't ghost the new classes.
  const CACHE_SCOPE = "sam2-surfaces-v1";
  if (!noCache) {
    const cached = await getCached<Sam2CachedResult>(CACHE_SCOPE, lat, lng);
    if (cached) {
      return NextResponse.json(cached);
    }
  }

  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    // No API key — degrade rather than 503; the pipeline shouldn't
    // crash on missing Phase 2 credentials.
    console.warn(
      "sam2: gate=missing_roboflow_key " +
        `lat=${lat.toFixed(5)} lng=${lng.toFixed(5)}`,
    );
    return NextResponse.json({
      surfaces: [],
      reason: "missing_roboflow_key",
      imageryDate: null,
      computedAt: new Date().toISOString(),
    });
  }
  const googleMapsKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleMapsKey) {
    console.warn(
      "sam2: gate=missing_google_key " +
        `lat=${lat.toFixed(5)} lng=${lng.toFixed(5)}`,
    );
    return NextResponse.json({
      surfaces: [],
      reason: "missing_google_key",
      imageryDate: null,
      computedAt: new Date().toISOString(),
    });
  }

  // ─── Compute tile center + zoom from SAM3 polygon ────────────────────
  // We center the tile on the polygon's bbox center (not the caller's
  // lat/lng, which is the geocoded address — may be on the road, not on
  // the roof). Zoom is chosen so the polygon plus 10% pad fits in the
  // tile. SAM2 then sees the whole roof in frame with neighbours blurred.
  const bbox = polygonBbox(sam3Polygon);
  const tileZoom = chooseZoom(bbox);
  const tileScale = 2 as 1 | 2;

  const img = await fetchSatelliteImage({
    lat: bbox.centerLat,
    lng: bbox.centerLng,
    googleApiKey: googleMapsKey,
    sizePx: 640,
    zoom: tileZoom,
    scale: tileScale,
  });
  if (!img) {
    // Soft fail — the customer-facing pipeline shouldn't 5xx because a
    // Static Maps fetch hiccupped. Return empty surfaces and move on.
    console.warn(
      "sam2: gate=satellite_unavailable " +
        `lat=${lat.toFixed(5)} lng=${lng.toFixed(5)}`,
    );
    return NextResponse.json({
      surfaces: [],
      reason: "satellite_unavailable",
      imageryDate: null,
      computedAt: new Date().toISOString(),
    });
  }

  // ─── Call SAM2 workflow ──────────────────────────────────────────────
  // Body shape mirrors SAM3's call (api_key + inputs). The class list
  // is passed as a comma-separated prompt — the actual input names
  // depend on the workflow the user builds, but Roboflow's prompted-
  // segmentation blocks all accept a `prompt` input by convention. If
  // the user names their inputs differently the route still functions;
  // they just won't filter on classes server-side.
  let workflowJson: unknown = null;
  let workflowError: string | null = null;
  try {
    const res = await fetch(SAM2_WORKFLOW_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: {
          image: { type: "base64", value: img.base64 },
          // Comma-separated class list. The workflow author's prompt
          // block reads this and filters predictions by class. If their
          // workflow doesn't use a prompt input, this is ignored.
          prompt: SAM2_PROMPT_CLASSES.join(", "),
          // Same convention as SAM3 — pass classes explicitly too in
          // case the workflow uses a multi-class input. Natural-language
          // strings (e.g. "main shingle roof") perform far better with
          // SAM3's text-prompted segmenter than snake_case enum strings;
          // normalizeClass() maps responses back to SurfaceClass.
          classes: SAM2_PROMPT_CLASSES,
          confidence: SAM2_CONFIDENCE,
        },
      }),
      signal: AbortSignal.timeout(75_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      workflowError = `workflow_http_${res.status}: ${text.slice(0, 200)}`;
      console.warn(
        `sam2: workflow returned ${res.status} for (${lat}, ${lng}) ` +
          `at ${SAM2_WORKFLOW_URL}: ${text.slice(0, 300)}`,
      );
    } else {
      workflowJson = await res.json().catch(() => null);
      if (workflowJson === null) {
        workflowError = "workflow_response_not_json";
      }
    }
  } catch (err) {
    workflowError = `workflow_fetch_error: ${
      err instanceof Error ? err.message : "unknown"
    }`;
    console.warn(`sam2: workflow call failed for (${lat}, ${lng}):`, err);
  }

  if (workflowError) {
    // 10% sampled to Sentry — same policy as sam3-roof so we can spot
    // rate spikes without burning Sentry quota when a workflow is
    // mis-published. Empty surfaces returned, never throws.
    if (Math.random() < 0.1) {
      Sentry.captureMessage("sam2-surfaces workflow error", {
        level: "warning",
        tags: {
          "sam2.outcome": "workflow_error",
          "sam2.workflow_error": workflowError,
        },
      });
    }
    const result: Sam2CachedResult = {
      surfaces: [],
      imageryDate: img.imageryDate,
      computedAt: new Date().toISOString(),
    };
    return NextResponse.json({ ...result, reason: workflowError });
  }

  const extracted = extractSurfaces(workflowJson);
  if (!extracted || extracted.surfaces.length === 0) {
    if (Math.random() < 0.1) {
      Sentry.captureMessage("sam2-surfaces no predictions", {
        level: "warning",
        tags: { "sam2.outcome": "no_predictions" },
      });
    }
    const result: Sam2CachedResult = {
      surfaces: [],
      imageryDate: img.imageryDate,
      computedAt: new Date().toISOString(),
    };
    if (!noCache) {
      await setCached(CACHE_SCOPE, lat, lng, result, CACHE_TTL.monthly);
    }
    return NextResponse.json({ ...result, reason: "no_predictions" });
  }

  // ─── Project pixel polygons back to lat/lng ──────────────────────────
  const surfaces: SurfacePolygon[] = [];
  for (const s of extracted.surfaces) {
    const polygonLatLng = pixelPolygonToLatLng({
      pixels: s.pixels,
      centerLat: bbox.centerLat,
      centerLng: bbox.centerLng,
      zoom: tileZoom,
      scale: tileScale,
      imageWidth: extracted.imageWidth,
      imageHeight: extracted.imageHeight,
    });
    if (polygonLatLng.length < 3) continue;
    surfaces.push({
      class: normalizeClass(s.className),
      polygon: polygonLatLng,
      areaSqft: polygonAreaSqft(polygonLatLng),
      confidence: s.confidence,
    });
  }

  const result: Sam2CachedResult = {
    surfaces,
    imageryDate: img.imageryDate,
    computedAt: new Date().toISOString(),
  };
  if (!noCache) {
    await setCached(CACHE_SCOPE, lat, lng, result, CACHE_TTL.monthly);
  }

  console.log(
    `sam2: (${lat.toFixed(5)}, ${lng.toFixed(5)}) → ${surfaces.length} surfaces ` +
      `[${surfaces.map((s) => `${s.class}:${s.areaSqft.toFixed(0)}sqft`).join(", ")}]`,
  );

  return NextResponse.json(result);
}

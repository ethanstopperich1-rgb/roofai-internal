/**
 * /api/gemini-roof — V2 vision pipeline endpoint.
 *
 * Replaces the SAM3 + reconciler cascade. Single Gemini 3 Pro Image
 * call with structured-output schema gets us: outline polygon, facets,
 * linear features (ridge/hip/valley/rake/eave), and rooftop objects.
 * In parallel, Google Solar API gives us authoritative pitch + azimuth
 * per plane, which we match to Gemini's facets by spatial proximity.
 *
 * The geometry module (lib/roof-geometry) handles all the pixel →
 * lat/lng → sqft / linear-feet math. This route is a thin orchestrator
 * — fetch tile → call Gemini + Solar in parallel → process → return.
 *
 * GET ?lat=X&lng=Y[&address=...&skipCache=1]
 * POST { lat, lng, address?, skipCache? }
 */

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { fetchWithTimeout } from "@/lib/safe-fetch";
import { getCached, setCached } from "@/lib/cache";
import { fetchGisFootprint } from "@/lib/reconcile-roof-polygon";
import { polygonAreaSqft } from "@/lib/polygon";
import { rotateAllFacets } from "@/lib/solar-facets";
import { classifyEdges } from "@/lib/roof-engine";
import type { Facet, Edge, Material } from "@/types/roof";
import {
  buildTileMetadata,
  pixelPolygonToLatLng,
  processVisionOutput,
  reconcileGeminiAgainstSolar,
  type ReconciliationResult,
  type RoofMeasurements,
  type SolarPlaneMatch,
  type VisionRoofOutput,
} from "@/lib/roof-geometry";
import {
  GEMINI_ROOF_PROMPT,
  GEMINI_ROOF_SCHEMA,
} from "@/lib/gemini-roof-prompt";

export const runtime = "nodejs";
export const maxDuration = 60;

const TILE_ZOOM = 20;
const TILE_SCALE = 2 as const;
const TILE_SIZE_PX = 640; // Google `size=640x640`; image becomes 1280×1280 at scale=2
const GEMINI_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-3-pro-image-preview";
const CACHE_SCOPE = "gemini-roof-v1";

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }
  | { inlineData: { mimeType: string; data: string } };

type Confidence = "high" | "medium" | "low";

interface GeminiPredictionRaw {
  outline?: Array<{ x: number; y: number }>;
  facets?: Array<{
    letter: string;
    polygon: Array<{ x: number; y: number }>;
    orientation: string;
    confidence: Confidence;
  }>;
  roof_lines?: Array<{
    start: { x: number; y: number };
    end: { x: number; y: number };
    is_perimeter: boolean;
  }>;
  objects?: Array<{
    kind:
      | "vent"
      | "chimney"
      | "hvac_unit"
      | "skylight"
      | "plumbing_boot"
      | "satellite_dish"
      | "solar_panel";
    center: { x: number; y: number };
    bbox: { x: number; y: number; width: number; height: number };
    confidence: Confidence;
  }>;
}

interface SolarSegment {
  pitchDegrees?: number;
  azimuthDegrees?: number;
  stats?: { areaMeters2?: number; groundAreaMeters2?: number };
  boundingBox?: {
    sw: { latitude: number; longitude: number };
    ne: { latitude: number; longitude: number };
  };
}

interface SolarResponse {
  center?: { latitude: number; longitude: number };
  /** Whole-building bbox. Google's photogrammetric building model
   *  emits this alongside `center` — used to pick a tile zoom level
   *  that makes the target building dominate the frame. */
  boundingBox?: {
    sw: { latitude: number; longitude: number };
    ne: { latitude: number; longitude: number };
  };
  solarPotential?: {
    roofSegmentStats?: SolarSegment[];
    wholeRoofStats?: { groundAreaMeters2?: number };
    maxArrayPanelsCount?: number;
    maxSunshineHoursPerYear?: number;
  };
  imageryDate?: { year: number; month: number; day: number };
  imageryQuality?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface ParsedInputs {
  lat: number;
  lng: number;
  address: string | null;
  skipCache: boolean;
  /** When true, the lat/lng is the customer's confirmed pin position.
   *  The route uses this as the EXACT tile center — no Solar-bbox
   *  recentering, no zoom auto-pick from building dimensions. */
  pinConfirmed: boolean;
  /** When true, echo raw Gemini-text into the response for diagnostics. */
  debug: boolean;
}

function parseInputs(req: Request, body: unknown): ParsedInputs | NextResponse {
  if (req.method === "GET") {
    const u = new URL(req.url);
    const lat = Number(u.searchParams.get("lat"));
    const lng = Number(u.searchParams.get("lng"));
    const address = u.searchParams.get("address");
    const skipCache = u.searchParams.get("skipCache") === "1";
    const pinConfirmed = u.searchParams.get("pinConfirmed") === "1";
    const debug = u.searchParams.get("debug") === "1";
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
    }
    return { lat, lng, address, skipCache, pinConfirmed, debug };
  }
  const b = body as {
    lat?: number;
    lng?: number;
    address?: string;
    skipCache?: boolean;
    pinConfirmed?: boolean;
    debug?: boolean;
  };
  if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }
  return {
    lat: Number(b.lat),
    lng: Number(b.lng),
    address: b.address ?? null,
    skipCache: !!b.skipCache,
    pinConfirmed: !!b.pinConfirmed,
    debug: !!b.debug,
  };
}

async function fetchGoogleStaticTile(
  lat: number,
  lng: number,
  apiKey: string,
  zoom: number = TILE_ZOOM,
): Promise<{ base64: string; mimeType: "image/png" }> {
  const url =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=${zoom}` +
    `&size=${TILE_SIZE_PX}x${TILE_SIZE_PX}&scale=${TILE_SCALE}` +
    `&maptype=satellite&key=${apiKey}`;
  const res = await fetchWithTimeout(url, { timeoutMs: 15_000, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`google_static_${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: "image/png" };
}

/**
 * Pick an optimal zoom level so the target building dominates the
 * frame. Solar API's `boundingBox` gives us the building's lat/lng
 * extent; we want the building's longest dimension to occupy roughly
 * 50–65% of the 1280-px tile width.
 *
 * Reasoning: at zoom 20 (our prior default), a typical residential
 * building (~12m wide) occupies only ~14% of the tile. The surrounding
 * 86% is yard / driveway / neighbors — plenty of room for Gemini's
 * visual attention to wander to a brighter neighboring roof. At a
 * tighter zoom the target building physically dominates the frame
 * and the wrong-building failure mode collapses to near zero.
 *
 * Clamped to [19, 22]:
 *   - Zoom 22 is Google's max for satellite imagery in most US regions;
 *     pushing further returns a blurred upscale.
 *   - Zoom 19 is the floor — below that we lose roof-edge detail.
 *
 * The 20% padding factor is added to the building bbox so eaves and
 * roof overhangs don't get cropped at the tile edges.
 */
function pickOptimalZoom(
  bbox: NonNullable<SolarResponse["boundingBox"]>,
  centerLat: number,
): number {
  const M_PER_DEG_LAT = 111_320;
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const widthM = (bbox.ne.longitude - bbox.sw.longitude) * 111_320 * cosLat;
  const heightM = (bbox.ne.latitude - bbox.sw.latitude) * M_PER_DEG_LAT;
  const longestM = Math.max(widthM, heightM, 8) * 1.2; // 20% padding
  const TARGET_FRACTION = 0.55;
  const tilePx = TILE_SIZE_PX * TILE_SCALE; // 1280
  const targetTileM = longestM / TARGET_FRACTION;
  const targetMPerPx = targetTileM / tilePx;
  // metersPerPixel = 156543.03392 × cos(lat) / 2^(Z + scale − 1)
  // Solve for Z: Z = log2(num / mPerPx) − (scale − 1)
  const num = 156_543.03392 * cosLat;
  const z = Math.log2(num / targetMPerPx) - (TILE_SCALE - 1);
  return Math.min(22, Math.max(19, Math.round(z)));
}

interface GeminiMultimodalResult {
  /** Base64-encoded painted image returned by Gemini (PNG). */
  paintedImageBase64: string | null;
  /** Parsed Layer 2 object detection. May be empty if Gemini omitted it. */
  objects: Array<{
    type: string;
    center_pixel: [number, number] | { x: number; y: number };
    bounding_box: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  /** Raw text part for debugging when JSON parse fails. */
  rawText: string | null;
}

/**
 * Multimodal Gemini call. Requests BOTH an annotated image (cyan
 * roof-overlay paint) AND JSON object-detection in one round trip via
 * `responseModalities: ["IMAGE", "TEXT"]`. This is the V3 architecture
 * — the painted image IS the visual we show the customer; the objects
 * JSON drives the rich-data layer. Solar runs in parallel for the
 * headline measurement number.
 */
async function callGeminiMultimodal(
  tileBase64: string,
  apiKey: string,
): Promise<GeminiMultimodalResult> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        parts: [
          { text: GEMINI_ROOF_PROMPT },
          { inline_data: { mime_type: "image/png", data: tileBase64 } },
        ] satisfies GeminiPart[],
      },
    ],
    generationConfig: {
      temperature: 0,
      // Multimodal: tell Gemini to return BOTH a painted image AND a
      // text response. `responseSchema` can't be used here — it
      // conflicts with image generation — so we parse the text part
      // loosely below.
      responseModalities: ["IMAGE", "TEXT"],
    },
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 75_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gemini_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          inline_data?: { mime_type: string; data: string };
          inlineData?: { mimeType: string; data: string };
        }>;
      };
    }>;
  };

  let paintedImageBase64: string | null = null;
  let rawText: string | null = null;
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inline_data ?? part.inlineData;
    if (inline?.data && !paintedImageBase64) {
      paintedImageBase64 = inline.data;
    }
    if (part.text && !rawText) {
      rawText = part.text;
    }
  }

  // Parse objects out of the text part. Gemini may return:
  //   - Pure JSON: { "objects": [...] }
  //   - Markdown-fenced JSON: ```json\n{...}\n```
  //   - JSON embedded in prose
  // Strip code fences first, then look for the first {...} block.
  let objects: GeminiMultimodalResult["objects"] = [];
  if (rawText) {
    let candidate = rawText.trim();
    candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(jsonSlice) as { objects?: typeof objects };
        if (Array.isArray(parsed.objects)) objects = parsed.objects;
      } catch {
        // Soft-fail — leave objects empty. The painted image is still useful.
      }
    }
  }

  return { paintedImageBase64, objects, rawText };
}

// Legacy single-modality call retained for non-pin-confirmed paths.
// Returns the older structured-output shape (outline/facets/lines/objects).
async function callGemini(
  tileBase64: string,
  apiKey: string,
): Promise<GeminiPredictionRaw> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        parts: [
          { text: GEMINI_ROOF_PROMPT },
          {
            inline_data: {
              mime_type: "image/png",
              data: tileBase64,
            },
          },
        ] satisfies GeminiPart[],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: GEMINI_ROOF_SCHEMA,
    },
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 55_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gemini_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("gemini_no_text_in_response");
  }
  let parsed: GeminiPredictionRaw;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`gemini_invalid_json: ${err instanceof Error ? err.message : "?"}`);
  }
  return parsed;
}

async function callSolar(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<SolarResponse | null> {
  const requiredQuality = process.env.SOLAR_REQUIRED_QUALITY ?? "LOW";
  const url =
    `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
    `?location.latitude=${lat}&location.longitude=${lng}` +
    `&requiredQuality=${requiredQuality}&key=${apiKey}`;
  try {
    const res = await fetchWithTimeout(url, { timeoutMs: 15_000, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as SolarResponse;
  } catch {
    return null;
  }
}

function solarToPlaneMatches(solar: SolarResponse | null): SolarPlaneMatch[] {
  const segs = solar?.solarPotential?.roofSegmentStats ?? [];
  return segs
    .filter((s) => s.boundingBox && typeof s.pitchDegrees === "number")
    .map((s) => {
      const bb = s.boundingBox!;
      const centerLat = (bb.sw.latitude + bb.ne.latitude) / 2;
      const centerLng = (bb.sw.longitude + bb.ne.longitude) / 2;
      const areaM2 = s.stats?.areaMeters2 ?? 0;
      return {
        centerLat,
        centerLng,
        pitchDegrees: s.pitchDegrees ?? 0,
        azimuthDeg: s.azimuthDegrees ?? 0,
        solarAreaSqft: areaM2 * 10.7639,
      };
    });
}

function normalizeGeminiOutput(raw: GeminiPredictionRaw): VisionRoofOutput {
  return {
    outlinePx: raw.outline ?? [],
    facets: (raw.facets ?? []).map((f) => ({
      letter: f.letter,
      polygonPx: f.polygon,
      orientation: f.orientation,
      confidence: f.confidence ?? "medium",
    })),
    roofLines: (raw.roof_lines ?? []).map((lf) => ({
      startPx: lf.start,
      endPx: lf.end,
      isPerimeter: lf.is_perimeter,
    })),
    objects: (raw.objects ?? []).map((o) => ({
      kind: o.kind,
      centerPx: o.center,
      bboxPx: o.bbox,
      confidence: o.confidence ?? "medium",
    })),
  };
}

/**
 * Convert the raw Google Solar response into the shape `classifyEdges`
 * expects (Facet[] with rotated polygons). Mirrors what /api/solar +
 * lib/sources/solar-source.ts do internally — inlined here so the V3
 * route doesn't have to roundtrip through the HTTP /api/solar endpoint
 * to get real edge measurements.
 */
function buildFacetsFromSolar(
  solar: SolarResponse | null,
): { facets: Facet[]; dominantAzimuthDeg: number | null } {
  const segs = solar?.solarPotential?.roofSegmentStats ?? [];
  if (segs.length === 0) return { facets: [], dominantAzimuthDeg: null };

  // Per-segment enriched data (matches lib/sources/solar-source.ts shape)
  const enriched = segs.map((s) => {
    const bb = s.boundingBox;
    return {
      pitchDegrees: s.pitchDegrees ?? 0,
      azimuthDegrees: s.azimuthDegrees ?? 0,
      areaSqft: Math.round((s.stats?.areaMeters2 ?? 0) * 10.7639),
      groundAreaSqft: Math.round((s.stats?.groundAreaMeters2 ?? 0) * 10.7639),
      bboxLatLng: bb
        ? {
            swLat: bb.sw.latitude,
            swLng: bb.sw.longitude,
            neLat: bb.ne.latitude,
            neLng: bb.ne.longitude,
          }
        : { swLat: 0, swLng: 0, neLat: 0, neLng: 0 },
    };
  });

  // Area-weighted dominant azimuth, mod 90, double-angle averaged.
  // Mirrors the helper inside /api/solar/route.ts so edges classify
  // consistently across the two consumers.
  let sumX = 0;
  let sumY = 0;
  let totalA = 0;
  for (const s of enriched) {
    if (s.areaSqft <= 0) continue;
    const a = ((s.azimuthDegrees % 90) + 90) % 90;
    const rad = (a * Math.PI) / 90;
    sumX += Math.cos(rad) * s.areaSqft;
    sumY += Math.sin(rad) * s.areaSqft;
    totalA += s.areaSqft;
  }
  let dominantAzimuthDeg: number | null = null;
  if (totalA > 0) {
    const avg = (Math.atan2(sumY, sumX) * 90) / Math.PI / 2;
    dominantAzimuthDeg = ((avg % 90) + 90) % 90;
  }

  // Rotate per-facet bboxes to the building's true axis (otherwise the
  // edges are all axis-aligned and the edge classifier reports
  // garbage). rotateAllFacets returns lat/lng polygons in the same
  // order as the input enriched segments.
  const segmentPolygons = rotateAllFacets(enriched, dominantAzimuthDeg);

  const facets: Facet[] = enriched.map((seg, idx) => {
    const polygon = segmentPolygons[idx] ?? [];
    const pitchRad = (seg.pitchDegrees * Math.PI) / 180;
    const azRad = (seg.azimuthDegrees * Math.PI) / 180;
    return {
      id: `facet-${idx}`,
      polygon,
      normal: {
        x: Math.sin(pitchRad) * Math.sin(azRad),
        y: Math.sin(pitchRad) * Math.cos(azRad),
        z: Math.cos(pitchRad),
      },
      pitchDegrees: seg.pitchDegrees,
      azimuthDeg: seg.azimuthDegrees,
      areaSqftSloped: seg.areaSqft,
      areaSqftFootprint: seg.groundAreaSqft,
      material: null as Material | null,
      isLowSlope: seg.pitchDegrees < 18.43,
    };
  });

  return { facets, dominantAzimuthDeg };
}

/** Sum classified edges into EagleView-style totals (ridges + hips merged
 *  to match EagleView's "Total Ridges/Hips" field; valleys, rakes, eaves
 *  separate). */
function sumEdgesByType(edges: Edge[]): {
  ridgesHipsLf: number;
  valleysLf: number;
  rakesLf: number;
  eavesLf: number;
} {
  let r = 0,
    v = 0,
    k = 0,
    e = 0;
  for (const edge of edges) {
    if (edge.type === "ridge" || edge.type === "hip") r += edge.lengthFt;
    else if (edge.type === "valley") v += edge.lengthFt;
    else if (edge.type === "rake") k += edge.lengthFt;
    else if (edge.type === "eave") e += edge.lengthFt;
  }
  return {
    ridgesHipsLf: Math.round(r),
    valleysLf: Math.round(v),
    rakesLf: Math.round(k),
    eavesLf: Math.round(e),
  };
}

function imageryDateString(
  d: SolarResponse["imageryDate"] | undefined,
): string | null {
  if (!d?.year) return null;
  const m = String(d.month ?? 1).padStart(2, "0");
  const day = String(d.day ?? 1).padStart(2, "0");
  return `${d.year}-${m}-${day}`;
}

// ─── Route handlers ──────────────────────────────────────────────────

/** V3 (holy-grail) response shape — pin-confirmed customer flow. */
export interface GeminiRoofResponseV3 {
  /** Customer-facing solar measurements (sqft, pitch, facets, etc).
   *  When imagery quality is MEDIUM/LOW and Solar's photogrammetric
   *  footprint is suspiciously low vs OSM, the `sqft` + `footprintSqft`
   *  fields here are GIS-corrected (see `correction` for the audit
   *  trail). The customer always sees the corrected number — the raw
   *  Solar values are preserved under `correction.solarRawSqft` etc. */
  solar: {
    sqft: number | null;
    footprintSqft: number | null;
    pitchDegrees: number | null;
    segmentCount: number;
    imageryQuality: string | null;
    imageryDate: string | null;
  };
  /** Undercount-correction audit trail. `applied: true` means we
   *  swapped Solar's footprint for the GIS footprint × Solar slope.
   *  Null when correction didn't run (HIGH imagery / GIS unavailable /
   *  GIS failed validation). */
  correction: {
    applied: boolean;
    reason: string;
    /** Raw Solar values before correction. */
    solarRawSlopedSqft: number;
    solarRawFootprintSqft: number;
    /** GIS source (OSM or MS Buildings) + its footprint area. */
    gisSource: string | null;
    gisFootprintSqft: number | null;
    /** Multiplier applied to GIS footprint to get the corrected sloped
     *  area: solarRawSloped / solarRawFootprint. */
    slopeFactor: number | null;
  } | null;
  /** Tile metadata so the frontend can position the painted image
   *  exactly where Google Maps would put a satellite tile. */
  tile: {
    centerLat: number;
    centerLng: number;
    zoom: number;
    widthPx: number;
    heightPx: number;
  };
  /** Base64-encoded PNG returned by Gemini — cyan-painted roof
   *  overlay drawn directly onto the satellite tile. The frontend
   *  shows this in place of the raw tile. Null when Gemini failed
   *  but Solar succeeded — customer still gets the headline number. */
  paintedImageBase64: string | null;
  /** Rooftop objects detected by Gemini (vents, chimneys, skylights,
   *  HVAC, solar panels, etc). Empty array when Gemini failed. */
  objects: Array<{
    type: string;
    centerPx: { x: number; y: number };
    bboxPx: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  /** Derived totals from `objects[]` + tile GSD. Mirrors EagleView's
   *  "Roof Penetrations: 3 · Perimeter 6 ft · Area 0.8 sq ft" block. */
  penetrationTotals: {
    count: number;
    perimeterFt: number;
    areaSqft: number;
  };
  /** EagleView-equivalent edge lengths derived from Solar's per-facet
   *  azimuth + adjacency (production roof-engine classifier). Null
   *  fields when Solar didn't return enough segments to classify. */
  edges: {
    ridgesHipsLf: number | null;
    valleysLf: number | null;
    rakesLf: number | null;
    eavesLf: number | null;
  };
  /** Second-opinion edge totals from Gemini direct line detection.
   *  Cheaper to compute (cheap Flash call, $0.005) but vision-fuzzy;
   *  Solar's geometric classification is generally more reliable on
   *  HIGH imagery. Use these when Solar has too few segments to
   *  classify well (MEDIUM/LOW imagery on complex roofs).
   *  `linesCount` is the raw count Gemini returned. */
  geminiEdges: {
    ridgesHipsLf: number;
    valleysLf: number;
    rakesLf: number;
    eavesLf: number;
    linesCount: number;
  } | null;
  /** Per-facet breakdown from Solar (one entry per roofSegmentStats).
   *  Empty array when Solar returned no segments. */
  facets: Array<{
    pitchDegrees: number;
    pitchOnTwelve: string;
    azimuthDegrees: number;
    compassDirection: string;
    slopedSqft: number;
    footprintSqft: number;
  }>;
  /** Whole-roof derived fields — also mirror EagleView. */
  derived: {
    stories: number;
    estimatedAtticSqft: number | null;
    predominantCompass: string | null;
    complexity: "simple" | "moderate" | "complex";
  };
  /** Solar-API-only metrics: how much PV would fit, annual sunshine. */
  solarPotential: {
    maxPanels: number | null;
    annualSunshineHours: number | null;
  };
  /** Gemini's visual analysis (separate from Solar's measurement). */
  geminiAnalysis: {
    facetCountEstimate: {
      count: number;
      complexity: "simple" | "moderate" | "complex";
      confidence: number;
    } | null;
    roofMaterial: { type: string; confidence: number } | null;
    conditionHints: Array<{ hint: string; confidence: number }>;
  };
  modelVersion: string;
  computedAt: string;
}

/** V2 (legacy) response shape — retained for the existing test harness +
 *  any non-pin callers. The route gates on `pinConfirmed` to choose. */
export interface GeminiRoofResponse {
  measurements: RoofMeasurements;
  reconciliation: ReconciliationResult;
  imageryDate: string | null;
  imageryQuality: string | null;
  modelVersion: string;
  computedAt: string;
}

const PIN_TILE_ZOOM = 21; // Fixed zoom for pin-confirmed flow; building dominates frame
const CACHE_SCOPE_V3 = "gemini-roof-v3-rich-edges";

/** Cheap text-only model used solely for object detection alongside
 *  the painted-image call. Pro Image is expensive ($0.075/call) and
 *  returns no text in multimodal mode — so we fan out a second call
 *  to gemini-2.5-flash (~$0.005) with structured JSON output for the
 *  vents/chimneys/skylights chips. */
const GEMINI_OBJECTS_MODEL = process.env.GEMINI_OBJECTS_MODEL ?? "gemini-2.5-flash";

const GEMINI_OBJECTS_PROMPT = `Analyze this 1280x1280 aerial satellite image of a residential roof. The target building is centered at pixel (640, 640). Only consider the central building — ignore neighboring roofs, yards, and ground objects.

Return four pieces of data:

1) objects[] — every rooftop fixture you can directly see. Types: vent, chimney, hvac_unit, skylight, plumbing_boot, satellite_dish, solar_panel. Include center pixel, bounding box, and confidence (float 0.0–1.0). Do not infer objects under tree canopy.

2) facet_count_estimate — how many distinct roof planes are visible on the central building (count gable ends, hip sides, dormer sides, addition wings separately). Also classify complexity: simple (2–4 planes), moderate (5–10), complex (11+). Confidence reflects how confidently you can resolve plane boundaries given imagery clarity.

3) roof_material — predominant covering material visible on the roof surface. Choose the most likely type from the enum. asphalt_shingle_architectural is the FL residential default unless you see clear tile (concrete or clay barrel) or metal seams. Confidence float.

4) condition_hints[] — discrete visible signals of roof condition. Each is an observable feature, not an overall grade. Include only hints you can directly see in the imagery. Use uniform_clean only when the roof appears entirely intact with no notable issues. Empty array is valid.

Confidence on every field is float 0.0–1.0 reflecting your certainty about that specific call.`;

// ─── Gemini line-detection sidecar (third Flash call) ──────────────────
//
// Solar's per-facet edge classification works well on HIGH imagery but
// misses ~30-50% of edges on MEDIUM/LOW (Solar only returns 6 segments
// for Jupiter's actual 34-facet roof — most ridges/hips are hidden in
// the segment-union boundary). This sidecar asks Gemini to find every
// visible roof line and classify it directly from the image. The math
// layer converts pixel → lat/lng → linear feet with slope correction.
//
// Output is OPTIONAL on the V3 response — when populated it's a
// second-opinion overlay against Solar's geometric classification.

const GEMINI_LINES_MODEL = "gemini-2.5-flash";

const GEMINI_LINES_PROMPT = `Identify every prominent roof line visible on the central building's roof in this 1280x1280 aerial satellite image. The target building is centered at pixel (640, 640). Ignore neighboring roofs.

Look for these line types:
- ridge: HORIZONTAL line at the very top where two roof planes meet at the peak (no plane visible on one side from above)
- hip: SLOPED line where two roof planes meet running down from a peak to a building corner
- valley: SLOPED line where two roof planes meet downward (water flows along it — typically a concave V seen from above)
- rake: SLOPED edge along a gable end where the roof drops to open air on one side
- eave: HORIZONTAL outer perimeter edge where the roof meets the gutter line at the bottom of each plane

For each line return its type, start pixel, end pixel, and confidence (float 0.0–1.0).

Only include lines on the central building. Skip neighbors, ground, vegetation. Use pixel coordinates in [0, 1279]; origin top-left.`;

const GEMINI_LINES_SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: {
            type: "STRING",
            enum: ["ridge", "hip", "valley", "rake", "eave"],
          },
          start_pixel: { type: "ARRAY", items: { type: "NUMBER" } },
          end_pixel: { type: "ARRAY", items: { type: "NUMBER" } },
          confidence: { type: "NUMBER", description: "Float 0.0–1.0" },
        },
        required: ["type", "start_pixel", "end_pixel", "confidence"],
      },
    },
  },
  required: ["lines"],
} as const;

interface GeminiLineDetection {
  type: "ridge" | "hip" | "valley" | "rake" | "eave";
  start_pixel: [number, number];
  end_pixel: [number, number];
  confidence: number;
}

async function callGeminiLines(
  tileBase64: string,
  apiKey: string,
): Promise<GeminiLineDetection[]> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_LINES_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        parts: [
          { text: GEMINI_LINES_PROMPT },
          { inline_data: { mime_type: "image/png", data: tileBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: GEMINI_LINES_SCHEMA,
    },
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gemini_lines_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { lines?: GeminiLineDetection[] };
    return parsed.lines ?? [];
  } catch {
    return [];
  }
}

/**
 * Pixel-space line segment → linear feet using the tile's GSD + slope
 * correction. Ridge + eave are horizontal in 3D so projected length
 * equals true length. Hip/valley/rake are sloped — multiply by
 * (1 / cos(avgPitch)) so the measurement reflects the diagonal run.
 */
function gemLineLengthFt(
  startPx: [number, number],
  endPx: [number, number],
  mPerPx: number,
  avgPitchDeg: number | null,
  isSloped: boolean,
): number {
  const dx = endPx[0] - startPx[0];
  const dy = endPx[1] - startPx[1];
  const runPx = Math.hypot(dx, dy);
  const runM = runPx * mPerPx;
  const runFt = runM * 3.28084;
  if (isSloped && avgPitchDeg != null && avgPitchDeg > 0 && avgPitchDeg < 80) {
    return runFt / Math.cos((avgPitchDeg * Math.PI) / 180);
  }
  return runFt;
}

interface GeminiRichDataResult {
  objects: GeminiMultimodalResult["objects"];
  facetCountEstimate: {
    count: number;
    complexity: "simple" | "moderate" | "complex";
    confidence: number;
  } | null;
  roofMaterial: { type: string; confidence: number } | null;
  conditionHints: Array<{ hint: string; confidence: number }>;
  /** Raw text returned by Gemini. Surfaced for the ?debug=1 path so the
   *  route can echo what the model actually emitted. */
  rawText: string | null;
}

async function callGeminiRichData(
  tileBase64: string,
  apiKey: string,
): Promise<GeminiRichDataResult> {
  const empty: GeminiRichDataResult = {
    objects: [],
    facetCountEstimate: null,
    roofMaterial: null,
    conditionHints: [],
    rawText: null,
  };
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_OBJECTS_MODEL}:generateContent?key=${apiKey}`;
  // Use the broader schema from lib/gemini-roof-prompt.ts which covers
  // objects + facets + material + condition.
  const body = {
    contents: [
      {
        parts: [
          { text: GEMINI_OBJECTS_PROMPT },
          { inline_data: { mime_type: "image/png", data: tileBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: GEMINI_ROOF_SCHEMA,
    },
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`gemini_rich_${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.warn("[gemini-rich] no_text_in_response");
    return empty;
  }
  try {
    const parsed = JSON.parse(text) as {
      objects?: GeminiMultimodalResult["objects"];
      facet_count_estimate?: GeminiRichDataResult["facetCountEstimate"];
      roof_material?: GeminiRichDataResult["roofMaterial"];
      condition_hints?: GeminiRichDataResult["conditionHints"];
    };
    console.log(
      `[gemini-rich] parsed objects=${parsed.objects?.length ?? 0} ` +
        `facetEst=${parsed.facet_count_estimate ? "yes" : "no"} ` +
        `material=${parsed.roof_material ? parsed.roof_material.type : "no"} ` +
        `hints=${parsed.condition_hints?.length ?? 0}`,
    );
    return {
      objects: parsed.objects ?? [],
      facetCountEstimate: parsed.facet_count_estimate ?? null,
      roofMaterial: parsed.roof_material ?? null,
      conditionHints: parsed.condition_hints ?? [],
      rawText: text,
    };
  } catch (err) {
    console.warn(
      "[gemini-rich] parse_failed",
      err instanceof Error ? err.message : String(err),
      `text_preview=${text.slice(0, 200)}`,
    );
    return { ...empty, rawText: text };
  }
}

/**
 * V3 handler — pin-confirmed customer flow ("the holy grail").
 *
 * The customer has dragged a pin onto the center of their roof. We:
 *   1. Refetch a Google Static Maps tile centered EXACTLY on the pin
 *      at fixed zoom 21 (1280×1280 px after scale=2).
 *   2. Call Solar API in parallel for measurement data.
 *   3. Call Gemini in multimodal mode — returns a cyan-painted version
 *      of the tile + JSON of rooftop objects.
 *   4. Return: painted image + Solar measurements + objects.
 *
 * No reconciliation, no Solar-bbox recentering, no centroid drift
 * tolerance — the pin IS the source of truth.
 */
async function handleV3Pinned(
  lat: number,
  lng: number,
  skipCache: boolean,
  debug: boolean = false,
): Promise<NextResponse> {
  if (!skipCache) {
    const cached = await getCached<GeminiRoofResponseV3>(CACHE_SCOPE_V3, lat, lng);
    if (cached) return NextResponse.json(cached);
  }

  const googleKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleKey) {
    return NextResponse.json({ error: "missing_google_key" }, { status: 503 });
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return NextResponse.json({ error: "missing_gemini_key" }, { status: 503 });
  }

  // Pin = tile center. Fixed zoom 21. No Solar recentering.
  const [tile, solar] = await Promise.all([
    fetchGoogleStaticTile(lat, lng, googleKey, PIN_TILE_ZOOM),
    callSolar(lat, lng, googleKey),
  ]);

  // Fire both Gemini calls in parallel:
  //   - Multimodal (paints the cyan overlay) — Pro Image, ~$0.075
  //   - Text-only object detection — Flash, ~$0.005
  // The multimodal call returns the image but no text; the cheap
  // text-only call always returns the objects JSON via structured
  // schema. Both run concurrently so total wall-clock = max(both),
  // not sum.
  let paintedImageBase64: string | null = null;
  let objects: GeminiRoofResponseV3["objects"] = [];
  let geminiAnalysis: GeminiRoofResponseV3["geminiAnalysis"] = {
    facetCountEstimate: null,
    roofMaterial: null,
    conditionHints: [],
  };
  let geminiRawText: string | null = null;
  let geminiRichErr: string | null = null;
  const [paintedResult, richResult, linesResult] = await Promise.allSettled([
    callGeminiMultimodal(tile.base64, geminiKey),
    callGeminiRichData(tile.base64, geminiKey),
    callGeminiLines(tile.base64, geminiKey),
  ]);

  if (paintedResult.status === "fulfilled") {
    paintedImageBase64 = paintedResult.value.paintedImageBase64;
  } else {
    console.warn(
      "[gemini-roof v3] painted_call_failed",
      paintedResult.reason instanceof Error
        ? paintedResult.reason.message
        : String(paintedResult.reason),
    );
  }

  if (richResult.status === "fulfilled") {
    const rich = richResult.value;
    objects = rich.objects.map((o) => {
      const center = Array.isArray(o.center_pixel)
        ? { x: o.center_pixel[0], y: o.center_pixel[1] }
        : o.center_pixel;
      return {
        type: o.type,
        centerPx: center,
        bboxPx: o.bounding_box,
        confidence: o.confidence,
      };
    });
    geminiAnalysis = {
      facetCountEstimate: rich.facetCountEstimate,
      roofMaterial: rich.roofMaterial,
      conditionHints: rich.conditionHints,
    };
    geminiRawText = rich.rawText;
  } else {
    geminiRichErr =
      richResult.reason instanceof Error
        ? `${richResult.reason.name}: ${richResult.reason.message}`
        : String(richResult.reason);
    console.warn("[gemini-roof v3] rich_data_call_failed", geminiRichErr);
  }

  // Stash for processing after avgPitchDeg is computed below.
  const linesValue =
    linesResult.status === "fulfilled" ? linesResult.value : null;
  if (linesResult.status === "rejected") {
    console.warn(
      "[gemini-roof v3] lines_call_failed",
      linesResult.reason instanceof Error
        ? linesResult.reason.message
        : String(linesResult.reason),
    );
  }

  console.log(
    `[gemini-roof v3] pinned (${lat.toFixed(5)},${lng.toFixed(5)}) ` +
      `painted=${paintedImageBase64 ? "yes" : "no"} objects=${objects.length}`,
  );

  const totalSlopedM2 = (solar?.solarPotential?.roofSegmentStats ?? []).reduce(
    (s, seg) => s + (seg.stats?.areaMeters2 ?? 0),
    0,
  );
  const totalFootprintM2 =
    solar?.solarPotential?.wholeRoofStats?.groundAreaMeters2 ?? 0;
  const avgPitchDeg = (() => {
    const segs = solar?.solarPotential?.roofSegmentStats ?? [];
    if (segs.length === 0 || totalSlopedM2 === 0) return null;
    return (
      segs.reduce(
        (s, seg) => s + (seg.pitchDegrees ?? 0) * (seg.stats?.areaMeters2 ?? 0),
        0,
      ) / totalSlopedM2
    );
  })();

  // Convert Gemini's pixel line segments to linear feet, slope-corrected.
  let geminiEdges: GeminiRoofResponseV3["geminiEdges"] = null;
  if (linesValue && linesValue.length > 0) {
    const tileCosLatLocal = Math.cos((lat * Math.PI) / 180);
    const tileMPerPxLocal =
      (156_543.03392 * tileCosLatLocal) /
      Math.pow(2, PIN_TILE_ZOOM + TILE_SCALE - 1);
    let r = 0;
    let v = 0;
    let k = 0;
    let e = 0;
    for (const ln of linesValue) {
      const isSloped =
        ln.type === "hip" || ln.type === "valley" || ln.type === "rake";
      const lf = gemLineLengthFt(
        ln.start_pixel,
        ln.end_pixel,
        tileMPerPxLocal,
        avgPitchDeg,
        isSloped,
      );
      if (ln.type === "ridge" || ln.type === "hip") r += lf;
      else if (ln.type === "valley") v += lf;
      else if (ln.type === "rake") k += lf;
      else if (ln.type === "eave") e += lf;
    }
    geminiEdges = {
      ridgesHipsLf: Math.round(r),
      valleysLf: Math.round(v),
      rakesLf: Math.round(k),
      eavesLf: Math.round(e),
      linesCount: linesValue.length,
    };
    console.log(
      `[gemini-roof v3] gemini_lines count=${linesValue.length} ` +
        `ridges+hips=${Math.round(r)}ft valleys=${Math.round(v)}ft ` +
        `rakes=${Math.round(k)}ft eaves=${Math.round(e)}ft`,
    );
  }

  // Raw Solar values (in sqft).
  const solarRawSloped = totalSlopedM2 > 0 ? Math.round(totalSlopedM2 * 10.7639) : 0;
  const solarRawFootprint = totalFootprintM2 > 0 ? Math.round(totalFootprintM2 * 10.7639) : 0;

  // ─── Undercount correction (ported from lib/roof-pipeline.ts) ─────
  // Solar's photogrammetric model can dramatically undercount complex
  // roofs on MEDIUM/LOW imagery (Jupiter case: 1,721 sqft on a 3,654
  // sqft building, -53%). When imagery quality is below HIGH AND
  // Solar's footprint is suspiciously small vs the OSM/MS-Buildings
  // building polygon, swap in `GIS footprint × Solar slope ratio` as
  // the corrected sloped area. Solar's measured pitch is solid even
  // on MEDIUM imagery — only the AREA is unreliable.
  //
  // HIGH-imagery cases (Solar.imageryQuality === "HIGH") pass through
  // unchanged because Solar is already accurate (Orlando: -2.3%,
  // Oak Park: +1.6%, Winter Garden: trusted).
  let correction: GeminiRoofResponseV3["correction"] = null;
  let finalSlopedSqft = solarRawSloped;
  let finalFootprintSqft = solarRawFootprint;

  // Confidence proxy: HIGH = 0.85, MEDIUM = 0.70, LOW = 0.55. Same
  // mapping as production solar-source.ts.
  const solarConfidence =
    solar?.imageryQuality === "HIGH"
      ? 0.85
      : solar?.imageryQuality === "MEDIUM"
        ? 0.7
        : solar?.imageryQuality === "LOW"
          ? 0.55
          : 0.5;
  const solarBelowHigh = solarConfidence < 0.85;
  const haveRawValues = solarRawSloped > 0 && solarRawFootprint > 0;

  if (solarBelowHigh && haveRawValues) {
    try {
      const hn = undefined; // pin-confirmed flow has no street-number context
      const gis = await fetchGisFootprint(lat, lng, hn);
      if (gis) {
        const gisSqft = polygonAreaSqft(gis.polygon);
        const ratio = solarRawFootprint / gisSqft;

        // Validate GIS polygon — residential bounds + centroid near pin.
        const gisIsResidential = gisSqft >= 600 && gisSqft <= 12_000;
        const cosLat = Math.cos((lat * Math.PI) / 180);
        const gisCLat =
          gis.polygon.reduce((s, p) => s + p.lat, 0) / gis.polygon.length;
        const gisCLng =
          gis.polygon.reduce((s, p) => s + p.lng, 0) / gis.polygon.length;
        const dLatM = (gisCLat - lat) * 111_320;
        const dLngM = (gisCLng - lng) * 111_320 * cosLat;
        const gisOffsetM = Math.hypot(dLatM, dLngM);
        const gisCentroidNearPin = gisOffsetM <= 25;
        const solarUndercounting = ratio < 0.6;

        if (gisIsResidential && gisCentroidNearPin && solarUndercounting) {
          const slopeFactor = solarRawSloped / solarRawFootprint;
          const correctedSloped = Math.round(gisSqft * slopeFactor);
          finalSlopedSqft = correctedSloped;
          finalFootprintSqft = Math.round(gisSqft);
          correction = {
            applied: true,
            reason:
              `Solar imagery ${solar?.imageryQuality ?? "?"} undercounted: ` +
              `${solarRawFootprint} sqft → ${Math.round(gisSqft)} sqft footprint ` +
              `(${gis.source} GIS, slope factor ${slopeFactor.toFixed(3)})`,
            solarRawSlopedSqft: solarRawSloped,
            solarRawFootprintSqft: solarRawFootprint,
            gisSource: gis.source,
            gisFootprintSqft: Math.round(gisSqft),
            slopeFactor: Number(slopeFactor.toFixed(3)),
          };
          console.log(
            `[gemini-roof v3] solar_undercount_corrected ` +
              `gis=${gis.source} solar_footprint=${solarRawFootprint} ` +
              `gis_sqft=${Math.round(gisSqft)} ratio=${ratio.toFixed(2)} ` +
              `final_sqft=${correctedSloped}`,
          );
        } else if (gis) {
          // GIS was fetched but didn't meet correction criteria. Record
          // why so the audit trail explains the no-op.
          const why = !gisIsResidential
            ? `GIS ${Math.round(gisSqft)} sqft outside residential bounds [600,12000]`
            : !gisCentroidNearPin
              ? `GIS centroid ${gisOffsetM.toFixed(0)}m from pin (>25m)`
              : `Solar not undercounting (ratio ${ratio.toFixed(2)} ≥ 0.6)`;
          correction = {
            applied: false,
            reason: `Correction skipped: ${why}`,
            solarRawSlopedSqft: solarRawSloped,
            solarRawFootprintSqft: solarRawFootprint,
            gisSource: gis.source,
            gisFootprintSqft: Math.round(gisSqft),
            slopeFactor: null,
          };
        }
      } else {
        correction = {
          applied: false,
          reason: "No GIS footprint available (OSM + MS Buildings both empty).",
          solarRawSlopedSqft: solarRawSloped,
          solarRawFootprintSqft: solarRawFootprint,
          gisSource: null,
          gisFootprintSqft: null,
          slopeFactor: null,
        };
      }
    } catch (err) {
      console.warn(
        "[gemini-roof v3] undercount_check_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ─── Derived totals (penetrations, facets, edges, attic, stories) ──
  //
  // The customer-facing report needs to mirror EagleView's anatomy
  // section. Everything below is computed deterministically from data
  // we already have on the server — no extra API calls.

  // Tile GSD (meters per pixel) at the pin location/zoom. Used to
  // convert Gemini's pixel bboxes into feet for penetration totals.
  const tileCosLat = Math.cos((lat * Math.PI) / 180);
  const tileMPerPx =
    (156_543.03392 * tileCosLat) / Math.pow(2, PIN_TILE_ZOOM + TILE_SCALE - 1);
  const M_TO_FT = 3.28084;

  // Penetration totals (perimeter + area) from Gemini's object bboxes.
  let penetrationPerimeterFt = 0;
  let penetrationAreaSqft = 0;
  for (const o of objects) {
    const wFt = o.bboxPx.width * tileMPerPx * M_TO_FT;
    const hFt = o.bboxPx.height * tileMPerPx * M_TO_FT;
    penetrationPerimeterFt += 2 * (wFt + hFt);
    penetrationAreaSqft += wFt * hFt;
  }
  const penetrationTotals = {
    count: objects.length,
    perimeterFt: Math.round(penetrationPerimeterFt * 10) / 10,
    areaSqft: Math.round(penetrationAreaSqft * 10) / 10,
  };

  // Per-facet breakdown from Solar's roofSegmentStats.
  function azToCompass(az: number): string {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return dirs[Math.round(((az % 360) + 360) % 360 / 45) % 8];
  }
  function degreesToOnTwelve(deg: number): string {
    if (deg <= 0) return "flat";
    if (deg >= 80) return "vertical";
    const rise = Math.tan((deg * Math.PI) / 180) * 12;
    return `${Math.max(1, Math.round(rise))}/12`;
  }
  const segments = solar?.solarPotential?.roofSegmentStats ?? [];
  const facets: GeminiRoofResponseV3["facets"] = segments
    .filter((s) => typeof s.pitchDegrees === "number")
    .map((s) => {
      const pitchDegrees = s.pitchDegrees ?? 0;
      const azimuthDegrees = s.azimuthDegrees ?? 0;
      const slopedSqft = Math.round(((s.stats?.areaMeters2 ?? 0) * 10.7639) * 10) / 10;
      const footprintSqft = Math.round(((s.stats?.groundAreaMeters2 ?? 0) * 10.7639) * 10) / 10;
      return {
        pitchDegrees,
        pitchOnTwelve: degreesToOnTwelve(pitchDegrees),
        azimuthDegrees,
        compassDirection: azToCompass(azimuthDegrees),
        slopedSqft,
        footprintSqft,
      };
    });

  // EagleView-equivalent edge totals — derived from Solar's per-facet
  // adjacency using the production roof-engine classifier.
  //
  // The classifier walks every facet polygon edge, detects pairs of
  // edges shared between adjacent facets (those are interior:
  // ridge/hip/valley), and classifies them using the building's
  // dominant azimuth + the edge bearing. Open edges (no shared
  // partner) become eave or rake based on whether they're parallel
  // or perpendicular to the dominant axis.
  //
  // This is what production /estimate uses; we're just plumbing it
  // through the V3 endpoint. On HIGH-imagery cases the numbers are
  // accurate enough to use for material orders. On MEDIUM/LOW (e.g.
  // Jupiter's 6 segments), Solar's per-facet geometry is coarser so
  // these are approximations — but they're principled approximations
  // rooted in actual photogrammetry rather than the prior heuristics.
  const { facets: rawFacets, dominantAzimuthDeg } = buildFacetsFromSolar(solar);
  const classifiedEdges = classifyEdges(rawFacets, dominantAzimuthDeg);
  const edges: GeminiRoofResponseV3["edges"] =
    classifiedEdges.length === 0
      ? { ridgesHipsLf: null, valleysLf: null, rakesLf: null, eavesLf: null }
      : sumEdgesByType(classifiedEdges);

  // Predominant compass direction (area-weighted).
  let predominantCompass: string | null = null;
  if (facets.length > 0) {
    const byDir = new Map<string, number>();
    for (const f of facets) {
      byDir.set(f.compassDirection, (byDir.get(f.compassDirection) ?? 0) + f.slopedSqft);
    }
    let best: string | null = null;
    let bestArea = -1;
    byDir.forEach((area, dir) => {
      if (area > bestArea) {
        best = dir;
        bestArea = area;
      }
    });
    predominantCompass = best;
  }

  // Stories heuristic — steep + compact → 2-story, sprawling shallow → 1.
  const stories =
    avgPitchDeg != null && avgPitchDeg >= 26.6 && finalFootprintSqft > 0 && finalFootprintSqft <= 2_000
      ? 2
      : 1;

  // Estimated attic — footprint × 0.91 (chimney/utility chase allowance).
  const estimatedAtticSqft =
    finalFootprintSqft > 0 ? Math.round(finalFootprintSqft * 0.91) : null;

  // Complexity (derived; prefer Gemini's call when available).
  const complexity: "simple" | "moderate" | "complex" =
    geminiAnalysis.facetCountEstimate?.complexity ??
    (facets.length >= 11 ? "complex" : facets.length >= 5 ? "moderate" : "simple");

  const result: GeminiRoofResponseV3 = {
    solar: {
      sqft: finalSlopedSqft > 0 ? finalSlopedSqft : null,
      footprintSqft: finalFootprintSqft > 0 ? finalFootprintSqft : null,
      pitchDegrees: avgPitchDeg,
      segmentCount: solar?.solarPotential?.roofSegmentStats?.length ?? 0,
      imageryQuality: solar?.imageryQuality ?? null,
      imageryDate: imageryDateString(solar?.imageryDate),
    },
    correction,
    tile: {
      centerLat: lat,
      centerLng: lng,
      zoom: PIN_TILE_ZOOM,
      widthPx: TILE_SIZE_PX * TILE_SCALE,
      heightPx: TILE_SIZE_PX * TILE_SCALE,
    },
    paintedImageBase64,
    objects,
    penetrationTotals,
    edges,
    geminiEdges,
    facets,
    derived: {
      stories,
      estimatedAtticSqft,
      predominantCompass,
      complexity,
    },
    solarPotential: {
      maxPanels: solar?.solarPotential?.maxArrayPanelsCount ?? null,
      annualSunshineHours: solar?.solarPotential?.maxSunshineHoursPerYear ?? null,
    },
    geminiAnalysis,
    modelVersion: GEMINI_MODEL,
    computedAt: new Date().toISOString(),
  };

  // 30-day cache. Pin-confirmed → safe to long-cache; the pin is
  // stable for a given building. If a rep re-pins, the lat/lng
  // changes and the cache key changes.
  await setCached(CACHE_SCOPE_V3, lat, lng, result, 60 * 60 * 24 * 30);
  if (debug) {
    // Echo the raw Gemini text + any caught error in the response.
    // Diagnostic-only — never shown to customers, never cached.
    return NextResponse.json({
      ...result,
      _debug: { geminiRawText, geminiRichErr },
    });
  }
  return NextResponse.json(result);
}

async function handle(
  lat: number,
  lng: number,
  skipCache: boolean,
): Promise<NextResponse> {
  if (!skipCache) {
    const cached = await getCached<GeminiRoofResponse>(CACHE_SCOPE, lat, lng);
    if (cached) {
      return NextResponse.json(cached);
    }
  }

  const googleKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleKey) {
    return NextResponse.json(
      { error: "missing_google_key" },
      { status: 503 },
    );
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return NextResponse.json(
      { error: "missing_gemini_key" },
      { status: 503 },
    );
  }

  // 1. Call Solar FIRST. The Jupiter failure (2026-05-16) showed
  //    that Gemini wanders to brighter neighboring roofs at the
  //    default zoom 20 because the target building only occupies ~14%
  //    of the tile. Solar's `boundingBox` + `center` let us pick a
  //    tighter zoom (typically 21) and recenter the tile on the actual
  //    photogrammetric building center — so the target building
  //    dominates 50–65% of the frame and Gemini physically can't grab
  //    a neighbor.
  //
  //    Solar is fast (~1–2s) and free. The Solar-first sequencing
  //    costs a small amount of latency vs the prior parallel path but
  //    is the only way to get the wrong-building failure under control.
  //    If Solar fails (rural / no coverage), we fall back to the prior
  //    geocoded-center + zoom 20 behavior.
  const solar = await callSolar(lat, lng, googleKey);

  let tileCenterLat = lat;
  let tileCenterLng = lng;
  let tileZoom = TILE_ZOOM;
  if (solar?.boundingBox && solar?.center) {
    tileCenterLat = solar.center.latitude;
    tileCenterLng = solar.center.longitude;
    tileZoom = pickOptimalZoom(solar.boundingBox, tileCenterLat);
    console.log(
      `[gemini-roof] solar_bbox_recenter from=(${lat.toFixed(5)},${lng.toFixed(5)}) ` +
        `to=(${tileCenterLat.toFixed(5)},${tileCenterLng.toFixed(5)}) ` +
        `zoom=${tileZoom} (was ${TILE_ZOOM})`,
    );
  } else {
    console.warn(
      "[gemini-roof] solar_bbox_unavailable — falling back to geocoded center + zoom 20",
    );
  }

  // 2. Fetch the tile at the building-centered location/zoom.
  const tile = await fetchGoogleStaticTile(
    tileCenterLat,
    tileCenterLng,
    googleKey,
    tileZoom,
  );
  const tileMeta = buildTileMetadata({
    centerLat: tileCenterLat,
    centerLng: tileCenterLng,
    zoom: tileZoom,
    scale: TILE_SCALE,
    sizePx: TILE_SIZE_PX,
  });

  // 3. Call Gemini with the recentered/rezoomed tile.
  const geminiResult = await callGemini(tile.base64, geminiKey).catch(
    (err) => err instanceof Error ? err : new Error(String(err)),
  );
  if (geminiResult instanceof Error) {
    console.warn("[gemini-roof] gemini_failed", geminiResult.message);
    return NextResponse.json(
      { error: "gemini_failed", detail: geminiResult.message },
      { status: 502 },
    );
  }
  const geminiRaw = geminiResult;

  const vision = normalizeGeminiOutput(geminiRaw);
  if (vision.outlinePx.length < 3) {
    // The revised prompt (2026-05-16) tells Gemini to return empty
    // arrays when no roof is identifiable within a 400-px radius of
    // the tile center, instead of fabricating a polygon on a nearby
    // wrong building. Honor that by surfacing a 422 with a clear
    // "manual review needed" signal — caller treats this as a soft
    // failure, not an error.
    return NextResponse.json(
      {
        error: "no_roof_identifiable",
        detail:
          "Gemini could not identify a roof within 400px of the tile center. Manual review needed.",
      },
      { status: 422 },
    );
  }

  // 3. Reconcile Gemini outline against Solar's ground truth BEFORE
  //    running the geometry math. The reconciler either accepts
  //    Gemini's polygon, clips it to Solar's bbox (over-trace recovery),
  //    or replaces it entirely with Solar's bbox-derived polygon
  //    (under-trace or wrong-building recovery). The result is always
  //    a usable polygon.
  let reconciliation: ReconciliationResult | null = null;
  const wholeRoofAreaM2 = solar?.solarPotential?.wholeRoofStats?.groundAreaMeters2;
  if (
    solar?.center &&
    solar?.boundingBox &&
    typeof wholeRoofAreaM2 === "number" &&
    wholeRoofAreaM2 > 0
  ) {
    const geminiOutlineLatLng = pixelPolygonToLatLng(vision.outlinePx, tileMeta);
    reconciliation = reconcileGeminiAgainstSolar({
      geminiOutline: geminiOutlineLatLng,
      solarBuildingCenter: {
        lat: solar.center.latitude,
        lng: solar.center.longitude,
      },
      solarWholeRoofAreaSqft: wholeRoofAreaM2 * 10.7639,
      solarBoundingBox: {
        sw: {
          lat: solar.boundingBox.sw.latitude,
          lng: solar.boundingBox.sw.longitude,
        },
        ne: {
          lat: solar.boundingBox.ne.latitude,
          lng: solar.boundingBox.ne.longitude,
        },
      },
    });
    console.log(
      `[gemini-roof] reconcile result=${reconciliation.outlineSource} ` +
        `accept=${reconciliation.acceptedAsIs} ` +
        `ratio=${reconciliation.diagnostics.areaRatio.toFixed(2)} ` +
        `centroid_off=${reconciliation.diagnostics.centroidDistanceM.toFixed(1)}m`,
    );
  }

  // 4. Process: pixels → measurements, enriched with Solar.
  const solarPlanes = solarToPlaneMatches(solar);
  const measurements = processVisionOutput({
    vision,
    tile: tileMeta,
    solarPlanes,
  });

  // Override the geometry's outlinePolygon with the reconciled polygon
  // when the reconciler ran. The facets / linear features / objects
  // stay as Gemini produced them — they're additive intelligence even
  // when the outline got rejected.
  if (reconciliation) {
    measurements.outlinePolygon = reconciliation.finalOutline;
  }

  const result: GeminiRoofResponse = {
    measurements,
    reconciliation: reconciliation ?? {
      acceptedAsIs: true,
      reason: "Solar wholeRoofStats unavailable — accepted Gemini outline by default.",
      fallback: null,
      finalOutline: measurements.outlinePolygon,
      outlineSource: "gemini",
      diagnostics: { geminiAreaSqft: 0, solarAreaSqft: 0, areaRatio: 0, centroidDistanceM: 0 },
    },
    imageryDate: imageryDateString(solar?.imageryDate),
    imageryQuality: solar?.imageryQuality ?? null,
    modelVersion: GEMINI_MODEL,
    computedAt: new Date().toISOString(),
  };

  await setCached(CACHE_SCOPE, lat, lng, result, 60 * 60 * 24 * 30);
  return NextResponse.json(result);
}

export async function GET(req: Request): Promise<NextResponse> {
  const rl = await rateLimit(req, "standard");
  if (rl) return rl;
  const parsed = parseInputs(req, null);
  if (parsed instanceof NextResponse) return parsed;
  try {
    return await (parsed.pinConfirmed
      ? handleV3Pinned(parsed.lat, parsed.lng, parsed.skipCache, parsed.debug)
      : handle(parsed.lat, parsed.lng, parsed.skipCache));
  } catch (err) {
    console.error("[gemini-roof] unhandled", err);
    return NextResponse.json(
      { error: "internal", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const rl = await rateLimit(req, "standard");
  if (rl) return rl;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }
  const parsed = parseInputs(req, body);
  if (parsed instanceof NextResponse) return parsed;
  try {
    return await (parsed.pinConfirmed
      ? handleV3Pinned(parsed.lat, parsed.lng, parsed.skipCache, parsed.debug)
      : handle(parsed.lat, parsed.lng, parsed.skipCache));
  } catch (err) {
    console.error("[gemini-roof] unhandled", err);
    return NextResponse.json(
      { error: "internal", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

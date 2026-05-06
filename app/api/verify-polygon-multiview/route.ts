import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { getCached, setCached } from "@/lib/cache";
import { sunPositionAt } from "@/lib/sun-position";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/verify-polygon-multiview
 *
 * Multi-view extension of /api/verify-polygon. Receives:
 *   - top-down orthographic screenshot (with halfWidthM ground extent)
 *   - 4 oblique screenshots (N/E/S/W) of the same property
 *   - candidate polygon in lat/lng
 *
 * Pipeline:
 *   1. For each image, project the polygon to that image's pixel coords:
 *      - top-down: orthographic projection using halfWidthM
 *      - obliques: approximate using a simple meters-to-screen transform
 *        (good enough for "is this polygon roughly on the roof?" checks)
 *   2. Composite the polygon as red translucent fill + outline + vertex dots
 *   3. Send all 5 composited images to Claude with a verification prompt
 *      that explicitly asks for cross-view consistency (the polygon must
 *      match the roof in the top-down AND in all 4 obliques)
 *   4. Parse strict JSON response: { ok, confidence, reason }
 *
 * Cost: 1 Claude vision call with 5 images, ~$0.02-0.04.
 * Latency: ~3-6s.
 * Cached per polygon hash for 1h.
 *
 * This is the rebuilt version of tiles3d-vision (deleted earlier in
 * adb30f9). Key difference: Claude is asked to VERIFY a candidate polygon,
 * not draw one from scratch. LLMs are much better at "does this drawn
 * outline match the building" than "produce pixel-precise polygon vertices."
 */

const MODEL = "claude-sonnet-4-6";

// Chain-of-thought system prompt. The previous version asked Claude to
// return a verdict directly; reps reported polygons that were clearly on
// fence lines slipping through with ok:true. Forcing CoT inspection +
// listing specific issues makes the model's reasoning explicit and gives
// downstream code a structured signal (`issues[]`) to surface to the rep.
const SYSTEM_PROMPT = `You are an expert roof estimator with decades of experience reading aerial imagery for residential properties. Your job is to verify whether a candidate red polygon overlay correctly outlines the eaves of a single target house.

You will be shown FIVE images of the same property, each overlaid with a translucent red polygon + red vertex dots:

  IMAGE 1 — TOP-DOWN ORTHOGRAPHIC (no perspective). Centre = geocoded address.
  IMAGES 2-5 — 4 OBLIQUE VIEWS at 45° pitch from N / E / S / W.

The 4 obliques exist so you can:
  (a) disambiguate the target from neighbours,
  (b) see wings / sections hidden in top-down,
  (c) verify polygon edges sit at EAVE HEIGHT (not at ground level on a fence / lawn).

────────────────────────────────────────────────────────────
THINK STEP BY STEP, then return strict JSON.
────────────────────────────────────────────────────────────

Step 1 — LOCATE THE TARGET HOUSE.
   The geocoded address is at the centre of the top-down image. The 4 obliques are framed on the same ground point. Using the obliques, identify which physical building is the target. Note nearby neighbours, detached garages, and outbuildings — the polygon must NOT include those.

Step 2 — IDENTIFY THE ACTUAL ROOF EAVES.
   Eaves are the lower edges of the roof where it meets the walls. In obliques they appear as a sharp shadow line at the top of the wall surface. In top-down they're the discrete edges of the roof shape (different colour/texture from surrounding terrain).

Step 3 — WALK EACH RED EDGE.
   For each segment of the polygon, ask: is this edge sitting on the actual eave, or somewhere else? Common mis-placements:
   - On a FENCE or hedge perimeter (look for picket/wood texture in obliques; red line is at GROUND level, not roof level)
   - On a DRIVEWAY (paved hard surface, flat, no shadow line)
   - On a DECK or patio (wood texture but flat, not raised)
   - On a POOL (water surface)
   - On the LAWN (grass texture, no eave shadow)
   - On a NEIGHBOUR'S roof or detached structure
   - MISSING a wing — polygon ends short of an obvious roof edge visible in obliques

Step 4 — COVERAGE CHECK.
   Does the polygon cover ALL of the target roof (including all wings / sections / dormers / garage if attached)? Or is part of the actual roof outside the polygon?

Step 5 — FORM A VERDICT.
   • ok=true ONLY when the polygon is on the eaves on every edge AND covers the full roof. Sub-1m edge wiggle is acceptable; multi-meter mis-placement is not.
   • ok=false when ANY edge is clearly off the roof, or the polygon misses a roof section.
   • Confidence reflects cross-view agreement: 0.9+ = same verdict from all 5 views; 0.5–0.8 = ambiguous (e.g. obliques disagree); <0.5 = you can't tell.
   • For the CRITICAL FAILURE MODES (yard perimeter, fence-traced, driveway-traced, wrong building): use confidence ≥ 0.85 when you can see them clearly in the obliques. Don't be hesitant — a fence-traced polygon at eave height is rare; ground-level fence lines are obvious in oblique views.

Return STRICTLY this JSON object, no preamble, no markdown fences:
{
  "ok": <boolean>,
  "confidence": <0..1>,
  "reason": "<one short clause summarising the verdict>",
  "issues": ["<short specific issue, one per array item>"]
}

  • reason — single phrase like "matches roof in all 5 views", "south edge on driveway", "polygon is the lot perimeter not the roof"
  • issues — ZERO or more strings, each pointing to one concrete problem you found. Empty array if ok=true. Examples: ["south edge on driveway, ~3m off eave", "missing west wing visible in oblique-W", "polygon traces backyard fence at ground level"]`;

interface RequestBody {
  lat?: number;
  lng?: number;
  address?: string;
  source?: string;
  polygon?: Array<{ lat: number; lng: number }>;
  topDown?: { base64?: string; halfWidthM?: number };
  obliques?: Array<{ base64?: string; headingDeg?: number }>;
  /** Optional — ISO date of the underlying satellite imagery (Solar
   *  API's `imageryDate`). When passed, the verify prompt receives the
   *  predicted shadow direction for that date so Claude can disregard
   *  shadow-cast regions when judging eave edges. */
  imageryDate?: string | null;
  /** Optional sanity context — Solar's reported building footprint area
   *  in sqft. When passed, included in the prompt so Claude can compare
   *  the polygon's footprint against the known building footprint and
   *  flag obvious size mismatches. */
  expectedFootprintSqft?: number;
}

interface VerifyResult {
  ok: boolean;
  confidence: number;
  reason: string;
  /** Concrete issues Claude found — empty when ok:true. Surfaced to the
   *  rep so they know what to fix if they want to manually edit. */
  issues: string[];
  source?: string;
}

/**
 * Project a polygon to top-down image pixel coordinates given the
 * image's ground half-width (the orthographic frustum extent).
 */
function projectPolygonToTopDown(
  polygon: Array<{ lat: number; lng: number }>,
  imgWidth: number,
  imgHeight: number,
  centerLat: number,
  centerLng: number,
  halfWidthM: number,
): Array<[number, number]> {
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const M_PER_DEG_LAT = 111_320;
  // Ground covered by the image: width = halfWidthM * 2.
  // Height has the same scale (orthographic, square ground for square image).
  // halfHeightM = halfWidthM * (imgHeight / imgWidth)
  const halfHeightM = halfWidthM * (imgHeight / imgWidth);
  return polygon.map((v) => {
    const dxM = (v.lng - centerLng) * M_PER_DEG_LAT * cosLat;
    const dyM = (v.lat - centerLat) * M_PER_DEG_LAT;
    // dx maps to image x (right), dy maps to NEGATIVE image y (image y grows down)
    const px = imgWidth / 2 + (dxM / (halfWidthM * 2)) * imgWidth;
    const py = imgHeight / 2 - (dyM / (halfHeightM * 2)) * imgHeight;
    return [px, py];
  });
}

/**
 * Project a polygon to oblique view image pixel coordinates. Cesium's
 * oblique view at HeadingPitchRange(headingDeg, -45°, range) places the
 * camera at (range·cos45° horizontal, range·sin45° vertical) from the
 * pivot, looking at the pivot. We use a simplified pinhole projection
 * adequate for "is the polygon roughly on the roof?" — exact pixel-
 * precision isn't needed here because Claude is verifying shape match,
 * not measuring.
 */
function projectPolygonToOblique(
  polygon: Array<{ lat: number; lng: number }>,
  imgWidth: number,
  imgHeight: number,
  centerLat: number,
  centerLng: number,
  headingDeg: number,
  rangeM: number,
  pitchDeg: number,
): Array<[number, number]> {
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const M_PER_DEG_LAT = 111_320;

  // Camera position relative to pivot in ENU meters
  const headingRad = (headingDeg * Math.PI) / 180;
  const pitchRad = (pitchDeg * Math.PI) / 180; // pitch is negative (looking down)
  // Cesium HeadingPitchRange: heading = bearing of camera FROM pivot, measured clockwise from north.
  // Camera is at heading+180° from pivot (so it can look TOWARD pivot at heading bearing).
  // Horizontal distance from pivot: range * cos(|pitch|)
  // Vertical: range * sin(|pitch|) above pivot
  const horizM = rangeM * Math.cos(pitchRad);
  const upM = rangeM * Math.sin(-pitchRad); // pitch is negative; -(-x) = x; want positive height
  // Camera ENU position: opposite direction of heading
  const camE = -horizM * Math.sin(headingRad);
  const camN = -horizM * Math.cos(headingRad);
  const camU = upM;

  // Forward vector (pivot - camera, normalised)
  const fE = -camE / rangeM;
  const fN = -camN / rangeM;
  const fU = -camU / rangeM;
  // Right vector: cross(forward, up) — using ENU "up" = (0,0,1)
  const rE = fN * 1 - fU * 0;
  const rN = fU * 0 - fE * 1;
  const rU = fE * 0 - fN * 0;
  const rLen = Math.hypot(rE, rN, rU) || 1;
  const rxE = rE / rLen, rxN = rN / rLen, rxU = rU / rLen;
  // Up vector: cross(right, forward)
  const uE = rxN * fU - rxU * fN;
  const uN = rxU * fE - rxE * fU;
  const uU = rxE * fN - rxN * fE;

  // Cesium default Camera FOV ~60° (vertical). We approximate.
  const fovYRad = (60 * Math.PI) / 180;
  const tanHalfFovY = Math.tan(fovYRad / 2);
  const aspect = imgWidth / imgHeight;

  return polygon.map((v) => {
    // Vertex ENU position (relative to pivot at lat, lng, height=0)
    const dxM = (v.lng - centerLng) * M_PER_DEG_LAT * cosLat;
    const dyM = (v.lat - centerLat) * M_PER_DEG_LAT;
    // Vertex relative to camera
    const relE = dxM - camE;
    const relN = dyM - camN;
    const relU = 0 - camU;
    // Project onto camera axes
    const z = relE * fE + relN * fN + relU * fU; // forward
    const x = relE * rxE + relN * rxN + relU * rxU; // right
    const y = relE * uE + relN * uN + relU * uU;    // up
    if (z <= 0.1) return [imgWidth / 2, imgHeight / 2]; // behind camera; shouldn't happen
    const ndcX = x / (z * tanHalfFovY * aspect);
    const ndcY = y / (z * tanHalfFovY);
    const px = imgWidth / 2 + (ndcX * imgWidth) / 2;
    const py = imgHeight / 2 - (ndcY * imgHeight) / 2;
    return [px, py];
  });
}

function buildOverlaySvg(pixelPolygon: Array<[number, number]>, w: number, h: number): string {
  const dPath =
    pixelPolygon
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ") + " Z";
  const dots = pixelPolygon
    .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="#ff3b30" stroke="white" stroke-width="2" />`)
    .join("");
  // Centre crosshair
  const cx = w / 2;
  const cy = h / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path d="${dPath}" fill="rgba(255,59,48,0.18)" stroke="#ff3b30" stroke-width="4" />
    ${dots}
    <circle cx="${cx}" cy="${cy}" r="14" fill="none" stroke="#ff3b30" stroke-width="3" />
    <circle cx="${cx}" cy="${cy}" r="4" fill="#ff3b30" stroke="white" stroke-width="2" />
  </svg>`;
}

async function compositeImageWithOverlay(
  imageBase64: string,
  pixelPolygon: Array<[number, number]>,
): Promise<{ base64: string; mediaType: "image/jpeg" } | null> {
  try {
    const buf = Buffer.from(imageBase64, "base64");
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 1280;
    const h = meta.height ?? 1280;
    const svg = Buffer.from(buildOverlaySvg(pixelPolygon, w, h));
    const out = await sharp(buf)
      .composite([{ input: svg, top: 0, left: 0 }])
      .jpeg({ quality: 80 })
      .toBuffer();
    return { base64: out.toString("base64"), mediaType: "image/jpeg" };
  } catch (err) {
    console.warn("[verify-multiview] composite error:", err);
    return null;
  }
}

async function callClaude(opts: {
  apiKey: string;
  topDown: string;
  obliques: Array<{ base64: string; headingDeg: number }>;
  source?: string;
  polygonAreaSqft: number | null;
  expectedFootprintSqft: number | null;
  /** Predicted shadow azimuth from sun position at the imagery's capture
   *  date. When passed, included in the prompt so Claude can disregard
   *  shadow-cast regions when scoring eave edges. */
  shadowAzimuthDeg: number | null;
}): Promise<VerifyResult | null> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const oblOrder = [...opts.obliques].sort((a, b) => a.headingDeg - b.headingDeg);
  const obliqueLabel = (h: number) =>
    h < 45 || h >= 315 ? "north"
    : h < 135 ? "east"
    : h < 225 ? "south"
    : "west";

  // Dynamic context block sent before the images. Gives Claude size
  // priors so it can flag "polygon is 3× larger than the known building
  // footprint" without having to pixel-measure.
  const contextLines: string[] = [];
  if (opts.source) contextLines.push(`• Polygon source: ${opts.source}`);
  if (opts.polygonAreaSqft != null) {
    contextLines.push(`• Polygon footprint: ${Math.round(opts.polygonAreaSqft).toLocaleString()} sqft`);
  }
  if (opts.expectedFootprintSqft != null) {
    contextLines.push(`• Expected building footprint (from Solar API): ${Math.round(opts.expectedFootprintSqft).toLocaleString()} sqft`);
  }
  if (
    opts.polygonAreaSqft != null &&
    opts.expectedFootprintSqft != null &&
    opts.expectedFootprintSqft > 0
  ) {
    const ratio = opts.polygonAreaSqft / opts.expectedFootprintSqft;
    contextLines.push(`• Size ratio: ${ratio.toFixed(2)}× expected (1.0–1.2× is normal eave overhang; >1.5× suggests over-trace)`);
  }
  // Sun / shadow direction. Aerial imagery often has tree/structure shadows
  // cast onto the roof or yard that AI segmenters misread as roof edges.
  // Telling Claude where shadows fall lets it disregard shadow-aligned
  // false eaves rather than flagging them as misplaced polygon edges.
  if (opts.shadowAzimuthDeg != null && isFinite(opts.shadowAzimuthDeg)) {
    const az = opts.shadowAzimuthDeg;
    const dir =
      az < 22.5 || az >= 337.5 ? "north"
      : az < 67.5 ? "northeast"
      : az < 112.5 ? "east"
      : az < 157.5 ? "southeast"
      : az < 202.5 ? "south"
      : az < 247.5 ? "southwest"
      : az < 292.5 ? "west"
      : "northwest";
    contextLines.push(
      `• Shadow direction: shadows cast roughly to the ${dir} (sun azimuth ~${(((az + 180) % 360)).toFixed(0)}°). Disregard shadow-cast regions when judging where the eave actually is.`,
    );
  }
  const contextText =
    contextLines.length > 0
      ? `Context for this verification:\n${contextLines.join("\n")}\n\n`
      : "";

  const message = await client.messages.create({
    model: MODEL,
    // Up from 250 — chain-of-thought response with `issues` array can
    // run longer than a single-line verdict.
    max_tokens: 600,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Cache the static system prompt across calls — every estimate
        // sends the same instructions, so the prefix hits Anthropic's
        // 5-minute cache for ~90% input-token discount.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${contextText}IMAGE 1 — TOP-DOWN ORTHOGRAPHIC:`,
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: opts.topDown },
          },
          ...oblOrder.flatMap((o, i) => [
            {
              type: "text" as const,
              text: `IMAGE ${i + 2} — OBLIQUE FROM ${obliqueLabel(o.headingDeg).toUpperCase()}:`,
            },
            {
              type: "image" as const,
              source: { type: "base64" as const, media_type: "image/jpeg" as const, data: o.base64 },
            },
          ]),
          {
            type: "text",
            text: "Verify the red polygon following the step-by-step approach in your instructions. Return strict JSON only.",
          },
        ],
      },
    ],
  });
  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") return null;
  const trimmed = block.text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
    } else {
      return null;
    }
  }
  const v = parsed as Record<string, unknown>;
  const rawIssues = Array.isArray(v.issues) ? v.issues : [];
  const issues: string[] = [];
  for (const it of rawIssues) {
    if (typeof it === "string" && it.trim()) issues.push(it.trim());
  }
  return {
    ok: v.ok === true,
    confidence:
      typeof v.confidence === "number"
        ? Math.max(0, Math.min(1, v.confidence))
        : 0.5,
    reason: typeof v.reason === "string" ? v.reason : "",
    issues,
  };
}

const VERIFY_OBLIQUE_RANGE_M = 130;
const VERIFY_OBLIQUE_PITCH_DEG = -45;

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "expensive");
  if (__rl) return __rl;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 503 });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }
  const polygon = body.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return NextResponse.json({ error: "polygon required" }, { status: 400 });
  }
  const topDown = body.topDown?.base64;
  const halfWidthM = body.topDown?.halfWidthM;
  if (!topDown || typeof halfWidthM !== "number") {
    return NextResponse.json({ error: "topDown required" }, { status: 400 });
  }
  const obliques: Array<{ base64: string; headingDeg: number }> = [];
  for (const o of body.obliques ?? []) {
    if (typeof o.base64 === "string" && typeof o.headingDeg === "number") {
      obliques.push({ base64: o.base64, headingDeg: o.headingDeg });
    }
  }
  if (obliques.length < 1) {
    return NextResponse.json({ error: "at least one oblique required" }, { status: 400 });
  }

  const polyHash = polygon
    .map((v) => `${v.lat.toFixed(5)},${v.lng.toFixed(5)}`)
    .join("|");
  const cacheKey = `verify-mv:${polyHash}`;
  const cached = await getCached<VerifyResult>(cacheKey, lat, lng);
  if (cached) {
    return NextResponse.json({ ...cached, source: body.source, cached: true });
  }

  // Composite polygon overlay onto each image. We need image dims from
  // each captured image to project polygon → pixels, so unpack once.
  const topDownBuf = Buffer.from(topDown, "base64");
  const topDownMeta = await sharp(topDownBuf).metadata();
  const tdW = topDownMeta.width ?? 1280;
  const tdH = topDownMeta.height ?? 1280;
  const topDownPx = projectPolygonToTopDown(polygon, tdW, tdH, lat, lng, halfWidthM);
  const topDownComposite = await compositeImageWithOverlay(topDown, topDownPx);
  if (!topDownComposite) {
    return NextResponse.json({ error: "composite_failed" }, { status: 502 });
  }

  const compositedObliques: Array<{ base64: string; headingDeg: number }> = [];
  for (const o of obliques) {
    const buf = Buffer.from(o.base64, "base64");
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 1280;
    const h = meta.height ?? 1280;
    const px = projectPolygonToOblique(
      polygon, w, h, lat, lng,
      o.headingDeg, VERIFY_OBLIQUE_RANGE_M, VERIFY_OBLIQUE_PITCH_DEG,
    );
    const compo = await compositeImageWithOverlay(o.base64, px);
    if (compo) compositedObliques.push({ base64: compo.base64, headingDeg: o.headingDeg });
  }

  // Compute polygon footprint area (top-down sqft) so Claude can size-check
  // against Solar's reported building footprint.
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const M_PER_DEG_LAT = 111_320;
  let signedArea2DegSq = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    signedArea2DegSq += a.lng * b.lat - b.lng * a.lat;
  }
  const polygonAreaSqM =
    (Math.abs(signedArea2DegSq) / 2) *
    (M_PER_DEG_LAT * M_PER_DEG_LAT) *
    cosLat;
  const polygonAreaSqft = polygonAreaSqM * 10.7639;

  // Compute shadow azimuth from the imagery date when available. Solar API
  // doesn't return time-of-day so sunPositionAt assumes solar noon — fine
  // for shadow-direction (off by <30° vs actual capture time), which is
  // all the verify prompt needs.
  let shadowAzimuthDeg: number | null = null;
  if (typeof body.imageryDate === "string" && body.imageryDate.length >= 10) {
    const sun = sunPositionAt({ lat, lng, isoDate: body.imageryDate });
    if (sun && sun.altitudeDeg > 5) {
      // Skip when the sun is below the horizon — would mean imagery date
      // is wrong / future-dated; better to omit shadow context than mislead.
      shadowAzimuthDeg = sun.shadowAzimuthDeg;
    }
  }

  let result: VerifyResult | null = null;
  try {
    result = await callClaude({
      apiKey,
      topDown: topDownComposite.base64,
      obliques: compositedObliques,
      source: body.source,
      polygonAreaSqft,
      expectedFootprintSqft:
        typeof body.expectedFootprintSqft === "number" &&
        isFinite(body.expectedFootprintSqft)
          ? body.expectedFootprintSqft
          : null,
      shadowAzimuthDeg,
    });
  } catch (err) {
    console.error("[verify-multiview] claude error:", err);
    return NextResponse.json(
      { error: "claude_error", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }
  if (!result) {
    return NextResponse.json(
      { error: "no_result", message: "Claude returned no parseable JSON" },
      { status: 502 },
    );
  }
  console.log(
    `[verify-multiview] [${body.source ?? "?"}] ok=${result.ok} conf=${result.confidence.toFixed(2)} reason="${result.reason}" issues=${result.issues.length} obliques=${compositedObliques.length}`,
  );
  await setCached(cacheKey, lat, lng, result);
  return NextResponse.json({ ...result, source: body.source });
}

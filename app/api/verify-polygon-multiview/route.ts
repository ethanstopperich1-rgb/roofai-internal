import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { getCached, setCached } from "@/lib/cache";

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

const SYSTEM_PROMPT = `You are an expert roof estimator verifying a candidate polygon outline against five views of a residential property.

You will be shown FIVE images of the same single house, all overlaid with a translucent red polygon outline + red vertex dots:

  IMAGE 1 — TOP-DOWN ORTHOGRAPHIC (no perspective distortion). The image centre is the geocoded address.
  IMAGES 2-5 — 4 OBLIQUE VIEWS at 45° tilt from north / east / south / west.

The 4 obliques exist so you can disambiguate the target house from neighbours, see wings/sections that might be hidden in top-down, and verify the polygon's edges actually trace the building's eaves (not the lawn / driveway / deck / pool / pergola / detached structures).

VERIFY whether the red polygon correctly outlines the SINGLE target house at the centre of the property:
  • Polygon traces the EAVES of the actual roof (not yard, driveway, deck, pool, etc)
  • Polygon is on the building under the geocoded address pin (centre of top-down image)
  • Polygon covers the FULL roof of the target building (no missed wings/sections)
  • Polygon doesn't include detached structures (separate sheds, pool houses, neighbour buildings)

Return ONLY this strict JSON, no preamble, no markdown fences:
{
  "ok": <boolean>,
  "confidence": <0..1>,
  "reason": "<one short clause>"
}

  • ok: true if the polygon is acceptable as a final roof outline (tiny edge inaccuracies of ~1m are fine; anything more is not)
  • confidence: 0..1, how strongly the 4 obliques + top-down agree with each other. 0.9+ = clean cross-view agreement. 0.5-0.8 = some ambiguity. <0.5 = significant disagreement, you'd want a second opinion.
  • reason: one short clause. Examples: "matches roof in all 5 views", "missing west wing visible in oblique-W", "polygon includes attached deck on south side", "wrong building — neighbour to the east", "polygon on driveway not roof"`;

interface RequestBody {
  lat?: number;
  lng?: number;
  address?: string;
  source?: string;
  polygon?: Array<{ lat: number; lng: number }>;
  topDown?: { base64?: string; halfWidthM?: number };
  obliques?: Array<{ base64?: string; headingDeg?: number }>;
}

interface VerifyResult {
  ok: boolean;
  confidence: number;
  reason: string;
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
}): Promise<VerifyResult | null> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const oblOrder = [...opts.obliques].sort((a, b) => a.headingDeg - b.headingDeg);
  const obliqueLabel = (h: number) =>
    h < 45 || h >= 315 ? "north"
    : h < 135 ? "east"
    : h < 225 ? "south"
    : "west";
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 250,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "IMAGE 1 — TOP-DOWN ORTHOGRAPHIC:" },
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
            text: "Verify the red polygon. Return strict JSON only.",
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
  return {
    ok: v.ok === true,
    confidence:
      typeof v.confidence === "number"
        ? Math.max(0, Math.min(1, v.confidence))
        : 0.5,
    reason: typeof v.reason === "string" ? v.reason : "",
  };
}

const VERIFY_OBLIQUE_RANGE_M = 130;
const VERIFY_OBLIQUE_PITCH_DEG = -45;

export async function POST(req: Request) {
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

  let result: VerifyResult | null = null;
  try {
    result = await callClaude({
      apiKey,
      topDown: topDownComposite.base64,
      obliques: compositedObliques,
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
    `[verify-multiview] [${body.source ?? "?"}] ok=${result.ok} conf=${result.confidence.toFixed(2)} reason="${result.reason}" obliques=${compositedObliques.length}`,
  );
  await setCached(cacheKey, lat, lng, result);
  return NextResponse.json({ ...result, source: body.source });
}

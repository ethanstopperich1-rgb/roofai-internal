import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/verify-polygon
 *
 * Body: { lat, lng, polygon: Array<{lat, lng}>, source }
 *
 * Pattern C of the 3D-fusion plan: independent verification by Claude.
 *
 * Pipeline:
 *   1. Fetch the satellite tile at this lat/lng (zoom 20, 1280×1280)
 *   2. Composite the polygon as a translucent red outline + dot vertices
 *      onto the tile
 *   3. Send to Claude with a yes/no verification prompt
 *   4. Return { ok, confidence, reason }
 *
 * Cost: ~$0.005 per call. Latency ~2-3s. Cached per polygon hash for 1h
 * (rep can re-trigger by editing or refreshing).
 *
 * This complements Patterns A (mesh height-fraction) and B (mesh edge
 * snap) — Claude catches semantic errors A/B can't, e.g.:
 *   - Polygon traced on a NEIGHBOUR'S house at correct roof height (A
 *     can't tell, says 100% at roof height; Claude can see the address
 *     marker is on the wrong building)
 *   - Polygon mostly on roof but extends over a clearly-not-roof area
 *     like a covered patio (B's edge snap may have failed there)
 *   - Wrong building selected on a multi-building parcel
 *
 * Returns 503 when ANTHROPIC_API_KEY missing (skips verification but
 * doesn't break the pipeline — Patterns A+B still gate the polygon).
 */

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are an expert roof estimator verifying that an AI-generated polygon outline correctly traces the roof of a single residential property.

You will be shown ONE image: a top-down satellite tile (~75m × 75m at zoom 20) with the candidate polygon overlaid as a red translucent outline + red vertex dots. The center of the image is the geocoded address (also marked with a small red pin).

Verify whether the red polygon correctly outlines the SINGLE target house at the centre of the image. The polygon should:
  • Trace the eaves of the actual roof (not yard, driveway, deck, pool)
  • Be on the building under the centre red pin (not a neighbour)
  • Cover the FULL roof of the target building (no missed wings/sections)

Return ONLY this strict JSON, no preamble, no markdown fences:
{
  "ok": <boolean>,
  "confidence": <0..1>,
  "reason": "<one short clause: what is wrong if !ok, or 'matches roof' if ok>"
}

  • ok: true if the polygon is acceptable as a final outline for a roofing estimate (small edge inaccuracies of ~1m OK, anything larger is not).
  • confidence: 0..1, how certain you are. 0.9+ = clear case. 0.5-0.8 = some ambiguity. <0.5 = you'd want a second opinion.
  • reason: one short clause. Examples: "matches roof", "extends over deck on south side", "wrong building — neighbour", "missing west wing", "polygon on lawn".`;

interface RequestBody {
  lat?: number;
  lng?: number;
  polygon?: Array<{ lat: number; lng: number }>;
  source?: string;
}

interface VerifyResult {
  ok: boolean;
  confidence: number;
  reason: string;
  source?: string;
}

const SATELLITE_ZOOM = 20;
const SATELLITE_SIZE = 640;
const SATELLITE_SCALE = 2;
const SATELLITE_PIXELS = SATELLITE_SIZE * SATELLITE_SCALE;

/** Project a lat/lng point to pixel coordinates on the zoom-20 scale-2
 *  satellite tile centered at (centerLat, centerLng). */
function latLngToPixel(
  lat: number,
  lng: number,
  centerLat: number,
  centerLng: number,
): [number, number] {
  const mPerPx =
    (156_543.03392 * Math.cos((centerLat * Math.PI) / 180)) /
    Math.pow(2, SATELLITE_ZOOM) /
    SATELLITE_SCALE;
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const dx = (lng - centerLng) * 111_320 * cosLat;
  const dy = (lat - centerLat) * 111_320;
  return [SATELLITE_PIXELS / 2 + dx / mPerPx, SATELLITE_PIXELS / 2 - dy / mPerPx];
}

async function fetchSatelliteTile(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<Buffer | null> {
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${SATELLITE_ZOOM}&size=${SATELLITE_SIZE}x${SATELLITE_SIZE}&scale=${SATELLITE_SCALE}&maptype=satellite&key=${apiKey}`;
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

/** Build an SVG polygon overlay sized to the satellite tile. Translucent
 *  red fill + bright red outline + small red dots at each vertex, plus a
 *  centre crosshair so Claude can see exactly where the geocoded address is. */
function buildOverlaySvg(
  pixelPolygon: Array<[number, number]>,
  size = SATELLITE_PIXELS,
): string {
  const dPath =
    pixelPolygon
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ") + " Z";
  const dots = pixelPolygon
    .map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="#ff3b30" stroke="white" stroke-width="2" />`)
    .join("");
  const cx = size / 2;
  const cy = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <path d="${dPath}" fill="rgba(255,59,48,0.20)" stroke="#ff3b30" stroke-width="4" />
    ${dots}
    <circle cx="${cx}" cy="${cy}" r="14" fill="none" stroke="#ff3b30" stroke-width="3" />
    <circle cx="${cx}" cy="${cy}" r="4" fill="#ff3b30" stroke="white" stroke-width="2" />
  </svg>`;
}

async function compositeTileWithOverlay(
  tile: Buffer,
  pixelPolygon: Array<[number, number]>,
): Promise<Buffer> {
  const svg = Buffer.from(buildOverlaySvg(pixelPolygon));
  return await sharp(tile)
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function callClaude(opts: {
  apiKey: string;
  imageBase64: string;
}): Promise<VerifyResult | null> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: opts.imageBase64 },
          },
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
      try {
        parsed = JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
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

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "expensive");
  if (__rl) return __rl;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing ANTHROPIC_API_KEY" },
      { status: 503 },
    );
  }
  const googleKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleKey) {
    return NextResponse.json({ error: "Missing Google Maps key" }, { status: 503 });
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

  // Cache key: polygon hash + lat/lng. Different polygons on the same address
  // get separate cache entries.
  const polyHash = polygon
    .map((v) => `${v.lat.toFixed(5)},${v.lng.toFixed(5)}`)
    .join("|");
  const cacheKey = `verify-polygon:${polyHash}`;
  const cached = getCached<VerifyResult>(cacheKey, lat, lng);
  if (cached) {
    return NextResponse.json({ ...cached, source: body.source, cached: true });
  }

  const tile = await fetchSatelliteTile(lat, lng, googleKey);
  if (!tile) {
    return NextResponse.json(
      { error: "satellite_fetch_failed" },
      { status: 502 },
    );
  }

  const pixelPolygon = polygon.map((v) => latLngToPixel(v.lat, v.lng, lat, lng));
  const composited = await compositeTileWithOverlay(tile, pixelPolygon);
  const imageBase64 = composited.toString("base64");

  let result: VerifyResult | null = null;
  try {
    result = await callClaude({ apiKey, imageBase64 });
  } catch (err) {
    console.error("[verify-polygon] Claude error:", err);
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
    `[verify-polygon] [${body.source ?? "?"}] ok=${result.ok} conf=${result.confidence.toFixed(2)} reason="${result.reason}"`,
  );
  setCached(cacheKey, lat, lng, result);
  return NextResponse.json({ ...result, source: body.source });
}

/**
 * Claude vision wrapper. Given a base64 satellite image of a property,
 * returns structured roof signals (material, condition, complexity, damage).
 *
 * Falls back to a confident-low mock when ANTHROPIC_API_KEY is missing,
 * so the UI never has to handle a hard failure.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { RoofVision } from "@/types/estimate";

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are a roofing inspector analyzing aerial imagery for a sales rep at a roofing company. Your job is to extract structured visual signals from a satellite image of a single residential property. The image is 640x640 pixels with the property roughly centered.

Return ONLY valid minified JSON matching this exact schema, no preamble, no markdown fences:

{
  "currentMaterial": "asphalt-3tab" | "asphalt-architectural" | "metal-standing-seam" | "tile-concrete" | "wood-shake" | "flat-membrane" | "unknown",
  "estimatedAge": "new" | "moderate" | "aged" | "very-aged" | "unknown",
  "estimatedAgeYears": number,
  "complexity": "simple" | "moderate" | "complex",
  "visibleFeatures": Array<"chimney" | "skylight" | "dormer" | "solar-panels" | "satellite-dish" | "vents" | "complex-geometry">,
  "visibleDamage": Array<"missing-shingles" | "moss-algae" | "discoloration" | "tarp-visible" | "ponding" | "none">,
  "penetrations": Array<{ "kind": "vent" | "chimney" | "skylight" | "stack" | "satellite-dish" | "other", "x": number, "y": number, "approxSizeFt"?: number }>,
  "roofPolygon": Array<[number, number]>,
  "salesNotes": string,
  "confidence": number
}

Rules:
- Always pick a material — never "unknown" unless the image is unreadable.
- estimatedAgeYears is your best integer guess based on visual condition (5..30).
- complexity: simple = simple gable/hip; moderate = a few cuts, dormers, or wings; complex = many segments, intersections, multiple wings.
- penetrations: list every roof penetration you can see (vents, chimneys, skylights, plumbing stacks, satellite dishes). x/y are pixel coordinates in the 640x640 image (0,0 = top-left). approxSizeFt is your best guess of the diameter in feet (typical: vent 0.5-1, stack 0.5, chimney 2-4, skylight 2-4). Limit to 12 most prominent.
- roofPolygon: a TIGHT outline of just the roof material. STRICT REQUIREMENTS:
   * USE EXACTLY 4-8 VERTICES. Do not use 9+. Residential roofs are rectangular, L-shaped, or T-shaped — never oval, never round, never hexagonal. If you're tempted to draw a curve, you're tracing wrong (probably hitting tree shadow). Snap to a small number of straight edges.
   * EVERY edge must be either roughly parallel or roughly perpendicular to one other edge (rectilinear). Diagonal edges only at 45° corners on octagonal additions. No free-form polygons.
   * Each vertex must sit ON the actual roof line (gutter / eave / rake / ridge end) visible in the image. NOT on the lawn, driveway, deck, or shadow.
   * UNDER-TRACE AGGRESSIVELY. If the boundary is ambiguous (tree shadow, low contrast, dark eave shadow), pull the vertex INWARD toward the clearly-visible roof. A polygon 15% smaller than the truth is acceptable; a polygon larger than the truth is a failure.
   * Typical residential roof in this image will fill 8-25% of the tile area. If you find yourself drawing a polygon larger than 30% of the image, you are wrong — restart and trace more conservatively.
   * Forbidden inclusions: driveways, lawns, decks, patios, pools, pergolas, sheds, chimneys-that-stick-out, tree canopy, tree shadows, neighboring roofs.
   * If two unconnected roof sections exist (main house + detached garage), return the polygon for the LARGEST one only.
   * If you cannot confidently see the roof boundary, return an empty array (better than guessing).
   * Vertices in clockwise order. Pixel coordinates in the 640x640 image (0,0 = top-left).
- salesNotes: ONE sentence a sales rep can say to the homeowner — what you'd notice walking the roof. Be concrete, no fluff.
- confidence is 0..1.`;

const USER_PROMPT = `Analyze this aerial photo of a residential property. Return strict JSON per the system schema.`;

const MOCK_VISION: RoofVision = {
  currentMaterial: "asphalt-architectural",
  estimatedAge: "moderate",
  estimatedAgeYears: 14,
  complexity: "moderate",
  visibleFeatures: ["vents", "chimney"],
  visibleDamage: ["none"],
  penetrations: [],
  roofPolygon: [],
  salesNotes: "Mock vision result — set ANTHROPIC_API_KEY to enable Claude.",
  confidence: 0.3,
};

function cleanPenetrations(input: unknown): RoofVision["penetrations"] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(["vent", "chimney", "skylight", "stack", "satellite-dish", "other"]);
  const out: RoofVision["penetrations"] = [];
  for (const raw of input) {
    const item = raw as Record<string, unknown>;
    const kind =
      typeof item.kind === "string" && allowed.has(item.kind) ? item.kind : "other";
    const x = typeof item.x === "number" ? Math.max(0, Math.min(640, item.x)) : null;
    const y = typeof item.y === "number" ? Math.max(0, Math.min(640, item.y)) : null;
    if (x == null || y == null) continue;
    const approxSizeFt =
      typeof item.approxSizeFt === "number"
        ? Math.max(0.25, Math.min(8, item.approxSizeFt))
        : undefined;
    out.push({
      kind: kind as RoofVision["penetrations"][number]["kind"],
      x,
      y,
      approxSizeFt,
    });
    if (out.length >= 12) break;
  }
  return out;
}

function cleanRoofPolygon(input: unknown): Array<[number, number]> {
  if (!Array.isArray(input)) return [];
  const out: Array<[number, number]> = [];
  for (const raw of input) {
    if (!Array.isArray(raw) || raw.length !== 2) continue;
    const x = typeof raw[0] === "number" ? raw[0] : null;
    const y = typeof raw[1] === "number" ? raw[1] : null;
    if (x == null || y == null) continue;
    if (x < 0 || x > 640 || y < 0 || y > 640) continue;
    out.push([Math.round(x), Math.round(y)]);
    if (out.length >= 16) break;
  }
  if (out.length < 3) return [];

  // Sanity check: reject polygons that exceed plausible residential roof
  // size. At zoom 20 the 640×640 tile spans ~78×78m on the ground (~6,500
  // sf at typical mid-US latitudes), so a 1,500–2,500 sf residential roof
  // takes 23–38% of the tile. We cap at 20% as a hard "this is wrong"
  // threshold — anything above is almost certainly Claude painting yard +
  // house + driveway, and we'd rather drop it and fall through to OSM /
  // manual draw than hand the rep an inflated 6,000 sf polygon.
  let area = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    const b = out[(i + 1) % out.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  area = Math.abs(area) / 2;
  const fillFraction = area / (640 * 640);
  if (fillFraction > 0.20) {
    console.warn(
      `[anthropic] roof polygon too large (${(fillFraction * 100).toFixed(0)}% of tile) — discarding`,
    );
    return [];
  }
  return out;
}

function clean(json: unknown): RoofVision {
  const v = (json && typeof json === "object" ? json : {}) as Partial<RoofVision> & {
    penetrations?: unknown;
    roofPolygon?: unknown;
  };
  return {
    currentMaterial: v.currentMaterial ?? "unknown",
    estimatedAge: v.estimatedAge ?? "unknown",
    estimatedAgeYears:
      typeof v.estimatedAgeYears === "number"
        ? Math.max(0, Math.min(40, Math.round(v.estimatedAgeYears)))
        : 12,
    complexity: v.complexity ?? "moderate",
    visibleFeatures: Array.isArray(v.visibleFeatures) ? v.visibleFeatures : [],
    visibleDamage: Array.isArray(v.visibleDamage) ? v.visibleDamage : ["none"],
    penetrations: cleanPenetrations(v.penetrations),
    roofPolygon: cleanRoofPolygon(v.roofPolygon),
    salesNotes: typeof v.salesNotes === "string" ? v.salesNotes : "",
    confidence:
      typeof v.confidence === "number" ? Math.max(0, Math.min(1, v.confidence)) : 0.5,
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function analyzeRoofImage(opts: {
  imageBase64: string;
  imageMimeType: "image/png" | "image/jpeg";
}): Promise<RoofVision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return MOCK_VISION;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: opts.imageMimeType,
                data: opts.imageBase64,
              },
            },
            { type: "text", text: USER_PROMPT },
          ],
        },
      ],
    });

    const block = message.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return MOCK_VISION;
    const parsed = extractJson(block.text);
    if (!parsed) return MOCK_VISION;
    return clean(parsed);
  } catch (err) {
    console.error("[anthropic] vision error:", err);
    return MOCK_VISION;
  }
}

/**
 * Vision QA gate. Renders a polygon as a red outline composited onto the
 * satellite tile and asks Claude to grade whether it actually traces the
 * roof (vs. yard, neighbour, etc.). Returns confidence 0..1 and a brief
 * reason. The sam-refine route uses this to reject polygons SAM produced
 * but that don't actually match the building — typically when the geocoded
 * point landed on tree shadow and SAM segmented the wrong region.
 *
 * Cost: ~$0.005–0.01 per call (one Claude vision message). Latency: 1–2s.
 * Skipped when ANTHROPIC_API_KEY is missing — we return high confidence
 * so the polygon flows through unchallenged.
 */
export async function validateRoofPolygon(opts: {
  /** Satellite image (the same one fed to SAM/Claude), base64 PNG */
  imageBase64: string;
  /** Polygon in pixel coords on that image (matches the image size) */
  polygon: Array<[number, number]>;
  /** Image width/height in pixels (square assumed). Default 1280 (scale=2). */
  imagePixels?: number;
}): Promise<{ confidence: number; reason: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { confidence: 0.8, reason: "anthropic_key_missing — gate skipped" };
  }
  if (!opts.polygon || opts.polygon.length < 3) {
    return { confidence: 0, reason: "polygon_invalid" };
  }

  const size = opts.imagePixels ?? 1280;

  // Composite the polygon as a translucent red overlay on the satellite tile
  let overlaidBase64: string;
  try {
    const sharp = (await import("sharp")).default;
    const points = opts.polygon.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(" ");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <polygon points="${points}" fill="rgba(255,40,40,0.18)" stroke="#ff2828" stroke-width="4" stroke-linejoin="round" />
    </svg>`;
    const imgBuf = Buffer.from(opts.imageBase64, "base64");
    const composed = await sharp(imgBuf)
      .resize(size, size, { fit: "fill" })
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();
    overlaidBase64 = composed.toString("base64");
  } catch (err) {
    console.warn("[anthropic] polygon overlay failed:", err);
    // Fall back to sending the bare image — Claude can still reason about
    // pixel coords if we describe the polygon in text. Lower accuracy.
    overlaidBase64 = opts.imageBase64;
  }

  const QA_PROMPT = `You are roof-estimator QA. The image is a satellite view of a single residential property; a RED outline marks what was identified as "the main roof of the centred building."

Grade ONLY whether that red outline correctly traces the actual roof material of the centred building. It is NOT a comparison against any other source — judge what you see.

Strict JSON, no preamble:
{ "confidence": <0..1>, "reason": "<one short clause>" }

Scoring:
- 0.85–1.0: outline tracks the roof eaves tightly. Tiny over/under is fine.
- 0.55–0.85: roughly right shape and right building, but loose by 5–15 ft.
- 0.30–0.55: covers the right house but bleeds significantly into yard / driveway / shadow / neighbour.
- <0.30: wrong building, wildly oversized, or missing >50% of the actual roof.`;

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: overlaidBase64 },
            },
            { type: "text", text: QA_PROMPT },
          ],
        },
      ],
    });
    const block = message.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return { confidence: 0.5, reason: "no_text" };
    const parsed = extractJson(block.text);
    if (!parsed || typeof parsed !== "object") return { confidence: 0.5, reason: "parse_fail" };
    const v = parsed as { confidence?: unknown; reason?: unknown };
    const confidence =
      typeof v.confidence === "number" ? Math.max(0, Math.min(1, v.confidence)) : 0.5;
    const reason = typeof v.reason === "string" ? v.reason : "no_reason";
    return { confidence, reason };
  } catch (err) {
    console.error("[anthropic] validatePolygon error:", err);
    return { confidence: 0.6, reason: "validate_error" };
  }
}

/**
 * Fetch the satellite tile from Google Static Maps and return base64.
 */
export async function fetchSatelliteImage(opts: {
  lat: number;
  lng: number;
  apiKey: string;
  size?: number;
  zoom?: number;
}): Promise<{ base64: string; mimeType: "image/png" } | null> {
  const { lat, lng, apiKey, size = 640, zoom = 20 } = opts;
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${size}x${size}&maptype=satellite&key=${apiKey}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString("base64"), mimeType: "image/png" };
  } catch (err) {
    console.error("[anthropic] static map fetch error:", err);
    return null;
  }
}

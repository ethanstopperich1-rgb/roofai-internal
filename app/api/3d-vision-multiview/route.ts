import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/3d-vision-multiview
 *
 * Body:
 * {
 *   address: string,
 *   topDown: { base64: string, halfWidthM: number },  // orthographic top-down
 *   obliques: Array<{ base64: string, headingDeg: number }>,  // N/E/S/W obliques
 * }
 *
 * The 5 images are photogrammetric renders of the same property from
 * different angles, all centred on the geocoded address (which is marked
 * with a red pin in every view). Claude looks at all 5 to disambiguate
 * the target house and produces a polygon traced ON THE TOP-DOWN VIEW
 * (which the client can reverse-project to lat/lng deterministically using
 * the orthographic projection — `halfWidthM` is the ground half-width that
 * the top-down image covers, so each pixel maps to a known meter offset).
 *
 * Returns: { polygon: Array<[xPx, yPx]>, sqftEstimate: number, confidence: number, reason: string }
 *
 * The polygon is in TOP-DOWN PIXEL COORDS (origin top-left). The client
 * then reverse-projects each vertex to lat/lng.
 */

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are an expert roof estimator inspecting a property to produce an EagleView-quality roof outline. You will be shown FIVE photogrammetric renders of the same residential property:

  IMAGE 1 — TOP-DOWN ORTHOGRAPHIC: a true top-down view, no perspective distortion. The red pin marks the centre of the target house.
  IMAGES 2–5 — OBLIQUE VIEWS: the same property from north, east, south, and west at a 45° tilt. Use these to (a) confirm WHICH building is the target, (b) verify roof shape from multiple angles, (c) catch wings/sections you might miss in top-down.

Trace the EXACT roof outline of the SINGLE target house (under the red pin in every view). Include the full footprint of the actual roof — the entire main building, plus any attached wings, garages, or sections that share a single connected roof structure.

EXCLUDE: detached structures (separate sheds/pool houses), neighbouring houses, driveways, lawns, decks, pools, pergolas. If the target has an attached garage, include it; if it's a separate building, exclude it.

Use the 4 oblique views to TRIPLE-CHECK your trace before responding:
  • Does the polygon's outline match the eaves you can see from each oblique?
  • Are you missing a wing that's visible from one angle but obscured from another?
  • Is the polygon definitely on the marked house and not a neighbour?

Return ONLY this strict JSON, no preamble, no markdown fences:

{
  "polygon": [[x1, y1], [x2, y2], ...],
  "sqftEstimate": <number>,
  "confidence": <0..1>,
  "reason": "<one short clause about agreement across views>"
}

  • polygon: 4–14 vertices, clockwise, in TOP-DOWN IMAGE PIXEL COORDS (origin = top-left, x = right, y = down). Image is square, side length = the image you receive.
  • sqftEstimate: your best guess at the FOOTPRINT square footage (not slope-area).
  • confidence: 0..1 — how strongly the 4 oblique views agree with your top-down trace. 0.9+ = all 4 obliques cleanly match. 0.5–0.8 = some wings unclear. <0.5 = significant disagreement, you would not bet on this.
  • Vertices must be rectilinear (parallel/perpendicular) where the roof is rectilinear, which is ~95% of residential cases.`;

async function callClaude(opts: {
  apiKey: string;
  topDownBase64: string;
  obliques: Array<{ base64: string; headingDeg: number }>;
  address: string;
}): Promise<{
  polygon: Array<[number, number]>;
  sqftEstimate: number;
  confidence: number;
  reason: string;
} | null> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const oblOrder = [...opts.obliques].sort((a, b) => a.headingDeg - b.headingDeg);
  const obliqueLabel = (h: number) =>
    h < 45 || h >= 315 ? "north"
    : h < 135 ? "east"
    : h < 225 ? "south"
    : "west";

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Address: ${opts.address}\n\nIMAGE 1 — TOP-DOWN ORTHOGRAPHIC:`,
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: opts.topDownBase64 },
          },
          ...oblOrder.flatMap((o, i) => [
            {
              type: "text" as const,
              text: `IMAGE ${i + 2} — OBLIQUE FROM ${obliqueLabel(o.headingDeg).toUpperCase()}:`,
            },
            {
              type: "image" as const,
              source: { type: "base64" as const, media_type: "image/png" as const, data: o.base64 },
            },
          ]),
          {
            type: "text",
            text: "Return strict JSON per system prompt. Take your time across all 5 views before tracing.",
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
  if (!Array.isArray(v.polygon)) return null;
  const polygon: Array<[number, number]> = [];
  for (const p of v.polygon) {
    if (!Array.isArray(p) || p.length !== 2) continue;
    const x = typeof p[0] === "number" ? p[0] : null;
    const y = typeof p[1] === "number" ? p[1] : null;
    if (x == null || y == null) continue;
    polygon.push([x, y]);
  }
  if (polygon.length < 3) return null;
  return {
    polygon,
    sqftEstimate: typeof v.sqftEstimate === "number" ? v.sqftEstimate : 0,
    confidence:
      typeof v.confidence === "number" ? Math.max(0, Math.min(1, v.confidence)) : 0.5,
    reason: typeof v.reason === "string" ? v.reason : "",
  };
}

interface RequestBody {
  address?: string;
  topDown?: { base64?: string; halfWidthM?: number };
  obliques?: Array<{ base64?: string; headingDeg?: number }>;
}

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

  const topDown = body.topDown?.base64;
  if (!topDown) {
    return NextResponse.json({ error: "topDown.base64 required" }, { status: 400 });
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

  try {
    const result = await callClaude({
      apiKey,
      topDownBase64: topDown,
      obliques,
      address: body.address ?? "(no address)",
    });
    if (!result) {
      return NextResponse.json({ error: "no_polygon", message: "Claude returned no polygon" }, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[3d-vision-multiview] error:", err);
    return NextResponse.json(
      { error: "claude_error", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 },
    );
  }
}

// app/api/roof-inspector/route.ts
//
// Tier B — Multiview Roof Inspector.
//
// POST { roofData, topDown, obliques, imageryDate? }
// → { refined: RoofData, patch: InspectorPatch, latencyMs }
//
// Pipeline:
//   1. Validate inputs.
//   2. Build context block from Tier C RoofData (so Claude knows what
//      facets/objects/edges exist and can refine *those* by id rather than
//      starting from scratch).
//   3. Call Claude vision (sonnet-4-6) with 1 top-down + 4 obliques. Asks
//      for STRICT JSON patch (per-facet pitch, per-object dimensions, new
//      wall-to-roof junctions).
//   4. mergeRefinement applies the patch deterministically + re-computes
//      flashing + totals.
//   5. Cache by (roofData hash) for 1h.
//
// Cost: ~$0.03-0.05 per call (5 images). Cached aggressively.

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { rateLimit } from "@/lib/ratelimit";
import { getCached, setCached } from "@/lib/cache";
import type { RoofData } from "@/types/roof";
import {
  mergeRefinement,
  type InspectorPatch,
  type Side,
  type WallJunctionType,
} from "@/lib/sources/multiview-source";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are an expert roof estimator inspecting aerial imagery to refine a measurement that another system already produced. Your job is to *patch* the existing data using what the oblique views reveal — NOT to redo the measurement from scratch.

You will be shown FIVE images of the same residential property:
  IMAGE 1 — TOP-DOWN ORTHOGRAPHIC (no perspective). Centre = property address.
  IMAGES 2-5 — 4 OBLIQUE VIEWS at 45° from N / E / S / W.

The user message includes a JSON CONTEXT block describing the existing facets (with ids), existing objects (chimneys/skylights/dormers/vents), and overall stats. Use the ids when refining — DO NOT invent new ids.

────────────────────────────────────────────────────────────
THINK STEP BY STEP, then return strict JSON.
────────────────────────────────────────────────────────────

Step 1 — PITCH REFINEMENT.
   For each facet in the context, look at it across the 4 obliques. Shadow length + roof-to-eave height gives you pitch. The existing pitchDegrees came from satellite-only data and may be off by 5-10° on some facets. Common rises in residential: 4/12 (18.4°), 5/12 (22.6°), 6/12 (26.6°), 7/12 (30.3°), 8/12 (33.7°), 9/12 (36.9°), 10/12 (39.8°), 12/12 (45°). Only emit a facet entry when you're MORE confident than the existing value. If unsure, skip.

Step 2 — OBJECT DIMENSIONS.
   Each chimney/skylight/dormer in context has dimensionsFt that was a rough vision guess. Use the obliques to refine. Typical sizes:
   - Chimney width: 18"-48" (1.5-4 ft)
   - Skylight: 2x4 ft (most common) or 4x4 ft (large)
   - Dormer cheek wall length: 4-8 ft
   Only emit refinements when the existing dimension looks wrong by >25%.

Step 3 — WALL-TO-ROOF JUNCTIONS (the most important Tier B signal).
   Scan the obliques for places where a roof surface butts against a higher wall — these need step flashing the Tier C system can't detect:
   - "step-wall": attached garage roof meeting the main house wall, or split-level junctions. Step flashing runs along the slope of the roof, with one piece per shingle course.
   - "headwall": top of the lower roof meets a vertical wall (one continuous metal piece across the top).
   - "apron": bottom of an upper roof meets a vertical wall above a lower roof surface (one continuous piece at the eave of the upper section).
   For each junction emit: type, lengthFt (your best estimate from oblique scale), side (which cardinal side of the building it's on — used for visual placement only). If a chimney's width is >30 inches (2.5 ft), set needsCricket: true on a step-wall entry for that chimney.

Step 4 — FORM OUTPUT.
   Return STRICTLY this JSON object, no preamble, no markdown fences:
{
  "facets": [{ "id": "facet-0", "pitchDegrees": 26.6 }],
  "objects": [{ "id": "obj-2", "dimensionsFt": { "width": 3, "length": 4 } }],
  "wallJunctions": [{ "type": "step-wall", "lengthFt": 22, "side": "south" }],
  "notes": "<one short clause — what you saw that the top-down missed>"
}

All four top-level fields are OPTIONAL. Emit an empty array (or omit entirely) when there's nothing to refine. NEVER emit a facets/objects entry whose id isn't in the context. NEVER invent new objects — Tier C has already detected them; you only refine sizes.`;

interface RequestBody {
  roofData?: RoofData;
  topDown?: { base64?: string; halfWidthM?: number };
  obliques?: Array<{ base64?: string; headingDeg?: number }>;
  imageryDate?: string | null;
}

const VALID_SIDES: ReadonlySet<Side> = new Set(["north", "east", "south", "west"]);
const VALID_WALL_TYPES: ReadonlySet<WallJunctionType> = new Set([
  "step-wall", "headwall", "apron",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + validate the Claude response into an InspectorPatch. Drops
 * malformed entries silently — Tier B is best-effort additive refinement,
 * not load-bearing, so silent skip is preferable to throwing.
 */
function parsePatch(raw: unknown): InspectorPatch {
  if (!isRecord(raw)) return {};
  const out: InspectorPatch = {};

  if (Array.isArray(raw.facets)) {
    const facets: NonNullable<InspectorPatch["facets"]> = [];
    for (const f of raw.facets) {
      if (!isRecord(f)) continue;
      if (typeof f.id !== "string") continue;
      const p = Number(f.pitchDegrees);
      if (Number.isFinite(p) && p >= 0 && p <= 70) {
        facets.push({ id: f.id, pitchDegrees: p });
      }
    }
    if (facets.length > 0) out.facets = facets;
  }

  if (Array.isArray(raw.objects)) {
    const objects: NonNullable<InspectorPatch["objects"]> = [];
    for (const o of raw.objects) {
      if (!isRecord(o)) continue;
      if (typeof o.id !== "string") continue;
      const d = isRecord(o.dimensionsFt) ? o.dimensionsFt : null;
      if (!d) continue;
      const w = Number(d.width);
      const l = Number(d.length);
      if (Number.isFinite(w) && Number.isFinite(l) && w > 0 && l > 0) {
        objects.push({ id: o.id, dimensionsFt: { width: w, length: l } });
      }
    }
    if (objects.length > 0) out.objects = objects;
  }

  if (Array.isArray(raw.wallJunctions)) {
    const wjs: NonNullable<InspectorPatch["wallJunctions"]> = [];
    for (const wj of raw.wallJunctions) {
      if (!isRecord(wj)) continue;
      const t = wj.type;
      const side = wj.side;
      const lf = Number(wj.lengthFt);
      if (
        typeof t === "string" && VALID_WALL_TYPES.has(t as WallJunctionType) &&
        typeof side === "string" && VALID_SIDES.has(side as Side) &&
        Number.isFinite(lf) && lf > 0 && lf < 400
      ) {
        wjs.push({
          type: t as WallJunctionType,
          side: side as Side,
          lengthFt: lf,
          needsCricket: wj.needsCricket === true,
        });
      }
    }
    if (wjs.length > 0) out.wallJunctions = wjs;
  }

  if (typeof raw.notes === "string" && raw.notes.trim()) {
    out.notes = raw.notes.trim().slice(0, 300);
  }
  return out;
}

/**
 * Build a compact JSON context block for Claude. Only includes the fields
 * the inspector needs to refine — not the full RoofData (avoids prompt
 * bloat and confuses the model with irrelevant detail).
 */
function buildContext(data: RoofData): string {
  return JSON.stringify({
    address: data.address.formatted,
    imageryDate: data.imageryDate,
    source: data.source,
    facets: data.facets.map((f) => ({
      id: f.id,
      pitchDegrees: Math.round(f.pitchDegrees * 10) / 10,
      areaSqftSloped: Math.round(f.areaSqftSloped),
      azimuthDeg: Math.round(f.azimuthDeg),
    })),
    objects: data.objects.map((o) => ({
      id: o.id,
      kind: o.kind,
      dimensionsFt: o.dimensionsFt,
    })),
    totals: {
      totalRoofAreaSqft: data.totals.totalRoofAreaSqft,
      facetsCount: data.totals.facetsCount,
      complexity: data.totals.complexity,
    },
  });
}

/**
 * Stable hash of the inputs that drive the inspector output. Used as the
 * cache key so the same address+roofData hits don't re-pay for Claude.
 * Doesn't include the images themselves (which would be huge) — the
 * roofData identity is sufficient because Tier C is deterministic given
 * an address + capture date.
 */
function hashInputs(data: RoofData, imageryDate: string | null): string {
  const facets = data.facets
    .map((f) => `${f.id}:${f.pitchDegrees.toFixed(1)}:${f.areaSqftFootprint}`)
    .join("|");
  const objs = data.objects
    .map((o) => `${o.id}:${o.kind}:${o.dimensionsFt.width}x${o.dimensionsFt.length}`)
    .join("|");
  // Coords binned to 5 decimal places (~1m); imageryDate as tie-break.
  return [
    data.address.lat.toFixed(5),
    data.address.lng.toFixed(5),
    data.source,
    facets,
    objs,
    imageryDate ?? "",
  ].join("#");
}

interface CachedInspector {
  patch: InspectorPatch;
  latencyMs: number;
}

async function callClaude(opts: {
  apiKey: string;
  context: string;
  topDown: string;
  obliques: Array<{ base64: string; headingDeg: number }>;
}): Promise<{ patch: InspectorPatch; latencyMs: number } | null> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const t0 = Date.now();
  const sorted = [...opts.obliques].sort((a, b) => a.headingDeg - b.headingDeg);
  const label = (h: number) =>
    h < 45 || h >= 315 ? "north"
    : h < 135 ? "east"
    : h < 225 ? "south"
    : "west";

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        // Static system prompt — cache across calls for the prefix discount.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `CONTEXT:\n${opts.context}\n\nIMAGE 1 — TOP-DOWN ORTHOGRAPHIC:`,
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: opts.topDown },
          },
          ...sorted.flatMap((o, i) => [
            {
              type: "text" as const,
              text: `IMAGE ${i + 2} — OBLIQUE FROM ${label(o.headingDeg).toUpperCase()}:`,
            },
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/jpeg" as const,
                data: o.base64,
              },
            },
          ]),
          {
            type: "text",
            text: "Inspect the roof and return a refinement patch per your instructions. Strict JSON only.",
          },
        ],
      },
    ],
  });

  const latencyMs = Date.now() - t0;
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
  return { patch: parsePatch(parsed), latencyMs };
}

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "expensive");
  if (__rl) return __rl;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 503 });
  }
  // Env-gated rollout per docs/superpowers/tier-b-a-decisions.md.
  // When unset, the endpoint short-circuits returning the input RoofData
  // unchanged — same shape as the cached path so consumers don't branch.
  // Flip to always-on after first 100 estimates show stable pricing diff.
  const enabled = process.env.ENABLE_TIER_B_REFINEMENT === "1";

  let body: RequestBody;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const roofData = body.roofData;
  if (!isRecord(roofData) || (roofData as RoofData).source === "none") {
    return NextResponse.json({ error: "roofData required (non-degraded)" }, { status: 400 });
  }
  const rd = roofData as RoofData;
  if (rd.facets.length === 0) {
    return NextResponse.json({ error: "roofData has no facets to refine" }, { status: 400 });
  }
  if (rd.refinements.includes("multiview-obliques")) {
    // Already refined — no-op return. Idempotency: same RoofData in, same out.
    return NextResponse.json({
      refined: rd,
      patch: {} as InspectorPatch,
      latencyMs: 0,
      cached: true,
    });
  }
  console.log("[telemetry] tier_b_attempted", {
    address: rd.address.formatted,
    source: rd.source,
    facets: rd.facets.length,
    enabled,
  });
  if (!enabled) {
    // Rollout gate not flipped — return input unchanged so the client sees
    // the same shape as a successful no-op pass.
    return NextResponse.json({
      refined: rd,
      patch: {} as InspectorPatch,
      latencyMs: 0,
      gated: true,
    });
  }

  const topDown = body.topDown?.base64;
  if (typeof topDown !== "string" || topDown.length < 1000) {
    return NextResponse.json({ error: "topDown.base64 required" }, { status: 400 });
  }

  const obliques: Array<{ base64: string; headingDeg: number }> = [];
  for (const o of body.obliques ?? []) {
    if (typeof o.base64 === "string" && typeof o.headingDeg === "number") {
      obliques.push({ base64: o.base64, headingDeg: o.headingDeg });
    }
  }
  if (obliques.length === 0) {
    return NextResponse.json({ error: "at least one oblique required" }, { status: 400 });
  }

  const imageryDate = typeof body.imageryDate === "string" ? body.imageryDate : null;
  const cacheKey = `roof-inspector:${hashInputs(rd, imageryDate)}`;
  const cached = await getCached<CachedInspector>(cacheKey, rd.address.lat, rd.address.lng);
  if (cached) {
    const refined = mergeRefinement(rd, cached.patch);
    console.log("[roof-inspector] cache hit", {
      address: rd.address.formatted,
      facetsRefined: cached.patch.facets?.length ?? 0,
      wallJunctions: cached.patch.wallJunctions?.length ?? 0,
    });
    return NextResponse.json({
      refined,
      patch: cached.patch,
      latencyMs: cached.latencyMs,
      cached: true,
    });
  }

  let result: { patch: InspectorPatch; latencyMs: number } | null = null;
  try {
    result = await callClaude({
      apiKey,
      context: buildContext(rd),
      topDown,
      obliques,
    });
  } catch (err) {
    console.error("[roof-inspector] claude error:", err);
    console.log("[telemetry] tier_b_failed", {
      address: rd.address.formatted,
      reason: "claude_error",
      message: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json(
      { error: "claude_error", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }
  if (!result) {
    console.log("[telemetry] tier_b_failed", {
      address: rd.address.formatted,
      reason: "unparseable_json",
    });
    return NextResponse.json(
      { error: "no_result", message: "Claude returned no parseable JSON" },
      { status: 502 },
    );
  }

  const refined = mergeRefinement(rd, result.patch);

  console.log("[roof-inspector] refined", {
    address: rd.address.formatted,
    latencyMs: result.latencyMs,
    facetsRefined: result.patch.facets?.length ?? 0,
    objectsRefined: result.patch.objects?.length ?? 0,
    wallJunctions: result.patch.wallJunctions?.length ?? 0,
    wallStepLf: refined.flashing.wallStepLf,
    headwallLf: refined.flashing.headwallLf,
    apronLf: refined.flashing.apronLf,
  });

  console.log("[telemetry] tier_b_succeeded", {
    address: rd.address.formatted,
    source: rd.source,
    previousConfidence: rd.confidence,
    refinedConfidence: refined.confidence,
    wallStepLf: refined.flashing.wallStepLf,
    headwallLf: refined.flashing.headwallLf,
    apronLf: refined.flashing.apronLf,
    chimneyLfDelta: refined.flashing.chimneyLf - rd.flashing.chimneyLf,
    latencyMs: result.latencyMs,
  });

  await setCached(
    cacheKey,
    rd.address.lat,
    rd.address.lng,
    { patch: result.patch, latencyMs: result.latencyMs } satisfies CachedInspector,
    60 * 60,
  );

  return NextResponse.json({
    refined,
    patch: result.patch,
    latencyMs: result.latencyMs,
    cached: false,
  });
}

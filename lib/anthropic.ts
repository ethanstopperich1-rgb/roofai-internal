/**
 * Claude vision wrapper. Given a base64 satellite image of a property,
 * returns structured roof signals (material, condition, complexity, damage).
 *
 * Falls back to a confident-low mock when ANTHROPIC_API_KEY is missing,
 * so the UI never has to handle a hard failure.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { RoofVision } from "@/types/estimate";

const MODEL = "claude-sonnet-4-5";

const SYSTEM_PROMPT = `You are a roofing inspector analyzing aerial imagery for a sales rep at a roofing company. Your job is to extract structured visual signals from a satellite image of a single residential property.

Return ONLY valid minified JSON matching this exact schema, no preamble, no markdown fences:

{
  "currentMaterial": "asphalt-3tab" | "asphalt-architectural" | "metal-standing-seam" | "tile-concrete" | "wood-shake" | "flat-membrane" | "unknown",
  "estimatedAge": "new" | "moderate" | "aged" | "very-aged" | "unknown",
  "estimatedAgeYears": number,
  "complexity": "simple" | "moderate" | "complex",
  "visibleFeatures": Array<"chimney" | "skylight" | "dormer" | "solar-panels" | "satellite-dish" | "vents" | "complex-geometry">,
  "visibleDamage": Array<"missing-shingles" | "moss-algae" | "discoloration" | "tarp-visible" | "ponding" | "none">,
  "salesNotes": string,
  "confidence": number
}

Rules:
- Always pick a material — never "unknown" unless the image is unreadable.
- estimatedAgeYears is your best integer guess based on visual condition (5..30).
- complexity: simple = simple gable/hip; moderate = a few cuts, dormers, or wings; complex = many segments, intersections, multiple wings.
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
  salesNotes: "Mock vision result — set ANTHROPIC_API_KEY to enable Claude.",
  confidence: 0.3,
};

function clean(json: unknown): RoofVision {
  const v = (json && typeof json === "object" ? json : {}) as Partial<RoofVision>;
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

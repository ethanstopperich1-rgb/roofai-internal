import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import Replicate from "replicate";
import { generateText } from "ai";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/voice-note
 *
 * The "wow moment" demo feature. A roofing rep walks the property and
 * dictates 30 seconds: "Pretty bad granule loss on the back slope, two
 * missing shingles by the chimney, gutters look fine, customer wants
 * impact-rated tile, has State Farm, timeline is 60 days."
 *
 * We:
 *   1. Whisper-transcribe the audio (Replicate, ~$0.005/min)
 *   2. Claude-structure the transcript into estimate fields (Sonnet 4.6
 *      with structured JSON output, ~$0.002/call at typical length)
 *
 * Total cost: ~$0.01 per voice note. The estimate form auto-fills with
 * everything the rep just said. Closes the "fancy software" perception
 * gap in one shot.
 *
 * Request body (multipart/form-data):
 *   audio       — File (webm/mp4/mp3, ≤ 25 MB, ≤ 5 min)
 *   addressText — optional, the address already on screen
 *   currentSqft — optional, the auto-measured roof size for context
 *
 * Response:
 *   {
 *     transcript: string,
 *     structured: {
 *       material?: "asphalt-3tab" | "asphalt-architectural" | ...
 *       complexity?: "simple" | "moderate" | "complex"
 *       serviceType?: "reroof-tearoff" | "reroof-overlay" | "repair"
 *       ageYears?: number
 *       carrier?: "state-farm" | "allstate" | "citizens-fl" | ...
 *       insuranceClaim?: boolean
 *       customerName?: string
 *       notes?: string
 *       damageNotes?: string[]
 *       addOns?: { iceWater?: boolean, ridgeVent?: boolean, ... }
 *       timelineDays?: number
 *     }
 *   }
 *
 * Fields the model isn't sure about are omitted — the frontend merges
 * only the fields that came back, so existing rep-set values aren't
 * overwritten by a quiet "umm" in the audio.
 */

interface StructuredFields {
  material?:
    | "asphalt-3tab"
    | "asphalt-architectural"
    | "metal-standing-seam"
    | "tile-concrete";
  complexity?: "simple" | "moderate" | "complex";
  serviceType?: "new" | "reroof-tearoff" | "layover" | "repair";
  ageYears?: number;
  carrier?: string;
  insuranceClaim?: boolean;
  customerName?: string;
  notes?: string;
  damageNotes?: string[];
  addOns?: {
    iceWater?: boolean;
    ridgeVent?: boolean;
    gutters?: boolean;
    skylight?: boolean;
  };
  timelineDays?: number;
}

const STRUCTURE_PROMPT = `You are an experienced roofing estimator listening to a sales rep's voice
note from a property walkthrough. Extract structured estimate fields from
the transcript. Return ONLY valid JSON matching this schema — omit any
field you're not >80% confident about.

Schema (every field optional):
  material         "asphalt-3tab" | "asphalt-architectural" | "metal-standing-seam" | "tile-concrete"
  complexity       "simple" | "moderate" | "complex"   // single-pitch ranch=simple, hip+gable=moderate, multi-section+dormers=complex
  serviceType      "new" | "reroof-tearoff" | "layover" | "repair"   // "layover" = new shingles over existing layer
  ageYears         integer 0-50
  carrier          one of: "state-farm" "allstate" "usaa" "citizens" "travelers" "farmers" "liberty-mutual" "progressive" "nationwide" "other"
  insuranceClaim   true if rep mentions insurance, claim, adjuster, deductible, hail, storm damage
  customerName     just the name, no greeting
  notes            free-form notes from the rep, max 200 chars
  damageNotes      array of specific damage observations: "missing shingles", "granule loss", "lifted ridge cap", etc
  addOns           { iceWater?: bool, ridgeVent?: bool, gutters?: bool, skylight?: bool } — only the ones rep affirmatively wants
  timelineDays     integer 1-180, how soon they want the work done

Examples:
  "Tile roof, customer's mom has cancer wants it done in 2 weeks" → { material: "tile-concrete", timelineDays: 14 }
  "Just need a few shingles patched on the back slope" → { serviceType: "repair", damageNotes: ["missing shingles"] }
  "State Farm claim, Jenny Wong is the homeowner, 18 years old, definite tear-off" → { carrier: "state-farm", insuranceClaim: true, customerName: "Jenny Wong", ageYears: 18, serviceType: "reroof-tearoff" }

If the transcript is empty, mostly unintelligible, or unrelated to roofing, return {}.
Return ONLY the JSON object, no markdown, no preamble.`;

export async function POST(req: Request) {
  const limited = await rateLimit(req, "expensive");
  if (limited) return limited;

  if (!process.env.REPLICATE_API_TOKEN) {
    return NextResponse.json(
      { error: "REPLICATE_API_TOKEN not set" },
      { status: 503 },
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 503 },
    );
  }

  const form = await req.formData();
  const audio = form.get("audio");
  const addressText = (form.get("addressText") as string | null) ?? "";
  const currentSqft = (form.get("currentSqft") as string | null) ?? "";

  if (!(audio instanceof File)) {
    return NextResponse.json(
      { error: "audio field required" },
      { status: 400 },
    );
  }
  if (audio.size > 25 * 1024 * 1024) {
    return NextResponse.json(
      { error: "audio too large (max 25 MB)" },
      { status: 413 },
    );
  }
  if (audio.size < 1024) {
    return NextResponse.json(
      { error: "audio too short (silent recording?)" },
      { status: 400 },
    );
  }

  // ─── Step 1 — Whisper transcribe via Replicate ───────────────────────
  // Replicate's `openai/whisper` model accepts a base64 data URI as the
  // `audio` input. Latency: ~3-8s for a 30-second clip on a cold GPU,
  // ~1-2s warm. We use the `large-v3` checkpoint for best accuracy on
  // domain-specific terms (shingle, ridge cap, granule loss).
  const audioBuf = Buffer.from(await audio.arrayBuffer());
  const audioDataUri = `data:${audio.type || "audio/webm"};base64,${audioBuf.toString("base64")}`;
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

  let transcript = "";
  try {
    const whisperOut = (await replicate.run(
      "openai/whisper:cdd97b257f93cb89dede1c7584e3f3dfc969571b357dbcee08e793740bedd854",
      {
        input: {
          audio: audioDataUri,
          model: "large-v3",
          language: "en",
          translate: false,
          temperature: 0,
        },
      },
    )) as { transcription?: string } | string;

    transcript =
      typeof whisperOut === "string"
        ? whisperOut
        : (whisperOut?.transcription ?? "");
  } catch (err) {
    console.warn("[voice-note] whisper failed:", err);
    return NextResponse.json(
      { error: "transcription failed" },
      { status: 502 },
    );
  }

  if (!transcript || transcript.trim().length < 3) {
    return NextResponse.json(
      { transcript, structured: {}, warning: "no speech detected" },
    );
  }

  // ─── Step 2 — Claude structures into estimate fields ─────────────────
  const contextLines: string[] = [];
  if (addressText) contextLines.push(`Property address: ${addressText}`);
  if (currentSqft) contextLines.push(`Auto-measured roof: ${currentSqft} sqft`);

  const userMessage = [
    contextLines.length ? `Context (from the platform, not the rep):\n${contextLines.join("\n")}` : "",
    `Rep transcript:\n"""\n${transcript}\n"""`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // ─── Step 2 — structure the transcript into typed estimate fields ───
  //
  // PRIMARY: Vercel AI Gateway → Qwen3-235B-A22B (`alibaba/qwen-3-235b`).
  //   ~25x cheaper than Claude Sonnet 4.6 on input ($0.60/M vs $3.00/M)
  //   and ~12x on output ($1.20/M vs $15.00/M). Per-call cost drops
  //   from ~$0.002 → ~$0.00008. At RSS scale of 800 voice notes/day
  //   that's $48/mo → $2/mo for this specific step.
  //
  //   Qwen3-235B is Alibaba's MoE flagship — strong at structured JSON
  //   extraction (IFEval, BFCL function-calling within 2-3 pts of
  //   Sonnet), well-suited for short-transcript-to-schema work. The
  //   schema is shallow and the input is short, so we're nowhere near
  //   the failure modes where Qwen drops vs Sonnet (long-horizon
  //   spatial reasoning, multi-turn agentic planning).
  //
  // FALLBACK: Claude Sonnet 4.6 directly via Anthropic SDK.
  //   Triggered when the gateway call fails or returns un-parseable
  //   JSON. We never break the rep workflow over a cost optimization;
  //   if Qwen has a bad day the system gracefully pays Claude prices
  //   to deliver a working voice-note feature.
  let structured: StructuredFields = {};
  let structureSource: "qwen" | "claude-fallback" | "none" = "none";

  const parseClean = (raw: string): StructuredFields | null => {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    try {
      return JSON.parse(cleaned) as StructuredFields;
    } catch {
      return null;
    }
  };

  // PRIMARY — Qwen via Vercel AI Gateway
  try {
    const { text } = await generateText({
      model: "alibaba/qwen-3-235b",
      system: STRUCTURE_PROMPT,
      prompt: userMessage,
      maxOutputTokens: 800,
      temperature: 0.1,
    });
    const parsed = parseClean(text);
    if (parsed) {
      structured = parsed;
      structureSource = "qwen";
    } else {
      console.warn("[voice-note] qwen returned un-parseable JSON; raw:", text.slice(0, 200));
    }
  } catch (err) {
    console.warn("[voice-note] qwen structure failed (will try Claude fallback):", err);
  }

  // FALLBACK — Claude Sonnet 4.6 if Qwen failed or returned garbage
  if (structureSource === "none") {
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        system: STRUCTURE_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      });
      const block = resp.content.find((c) => c.type === "text");
      const raw = block && block.type === "text" ? block.text : "";
      const parsed = parseClean(raw);
      if (parsed) {
        structured = parsed;
        structureSource = "claude-fallback";
      } else {
        console.warn("[voice-note] claude fallback parse failed; raw:", raw.slice(0, 200));
      }
    } catch (err) {
      console.warn("[voice-note] claude fallback structure failed:", err);
      // Both Qwen + Claude failed. Return transcript only; rep can fill
      // the form manually. Don't 500 — they still got the transcribe.
    }
  }

  // Sanitize: clamp ageYears, drop unexpected enum values defensively
  if (structured.ageYears != null) {
    structured.ageYears = Math.max(
      0,
      Math.min(50, Math.round(structured.ageYears)),
    );
  }
  if (structured.timelineDays != null) {
    structured.timelineDays = Math.max(
      1,
      Math.min(180, Math.round(structured.timelineDays)),
    );
  }
  if (
    structured.complexity &&
    !["simple", "moderate", "complex"].includes(structured.complexity)
  ) {
    delete structured.complexity;
  }

  return NextResponse.json({ transcript, structured, structureSource });
}

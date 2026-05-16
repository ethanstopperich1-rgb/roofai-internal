/**
 * V3 validator — pin-confirmed multimodal Gemini call.
 *
 * Hits Gemini 3 Pro Image with the new V3 prompt asking for both:
 *   - A cyan-painted version of the satellite tile (Layer 1)
 *   - JSON of rooftop objects (Layer 2)
 *
 * The customer's pin lat/lng is the EXACT tile center. No reconciliation,
 * no Solar-bbox recentering — the pin IS the source of truth.
 *
 * Usage:
 *   npx tsx scripts/test-gemini-v3-pinned.ts
 *
 * Set FORCE_GEMINI=1 to bypass cache and burn a fresh ~$0.075 call.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  GEMINI_ROOF_PROMPT,
  GEMINI_ROOF_SCHEMA,
} from "../lib/gemini-roof-prompt";

const envPath = path.resolve(__dirname, "..", ".env.production");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3-pro-image-preview";
const PIN_TILE_ZOOM = 21;

interface TestCase {
  name: string;
  lat: number;
  lng: number;
  pinNote: string;
}

const CASES: TestCase[] = [
  {
    name: "813 Summerwood Dr Jupiter FL",
    lat: 26.93252,
    lng: -80.10804,
    pinNote: "geocoded ROOFTOP center — the hard case (palm canopy)",
  },
  {
    name: "2863 Newcomb Ct Orlando FL",
    lat: 28.5844052,
    lng: -81.17330439999999,
    pinNote: "small simple roof",
  },
  {
    name: "8450 Oak Park Rd Orlando FL",
    lat: 28.4885634,
    lng: -81.49980670000001,
    pinNote: "large complex residential",
  },
];

async function fetchGoogleTile(lat: number, lng: number, zoom: number): Promise<Buffer> {
  const key = process.env.GOOGLE_SERVER_KEY!;
  const url =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=${zoom}&size=640x640&scale=2` +
    `&maptype=satellite&key=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`google_static_${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

interface MultimodalResult {
  paintedImageBase64: string | null;
  objects: Array<{
    type: string;
    center_pixel: [number, number] | { x: number; y: number };
    bounding_box: { x: number; y: number; width: number; height: number };
    confidence: number;
  }>;
  rawText: string | null;
  latencyMs: number;
}

async function callGeminiMultimodal(tile: Buffer): Promise<MultimodalResult> {
  const key = process.env.GEMINI_API_KEY!;
  const t0 = Date.now();
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: GEMINI_ROOF_PROMPT },
              { inline_data: { mime_type: "image/png", data: tile.toString("base64") } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseModalities: ["IMAGE", "TEXT"],
        },
      }),
    },
  );
  const latencyMs = Date.now() - t0;
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`gemini_${r.status}: ${errText.slice(0, 500)}`);
  }
  const json = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; inline_data?: { mime_type: string; data: string }; inlineData?: { mimeType: string; data: string } }> } }>;
  };

  let paintedImageBase64: string | null = null;
  let rawText: string | null = null;
  for (const part of json.candidates?.[0]?.content?.parts ?? []) {
    const inline = part.inline_data ?? part.inlineData;
    if (inline?.data && !paintedImageBase64) paintedImageBase64 = inline.data;
    if (part.text && !rawText) rawText = part.text;
  }

  let objects: MultimodalResult["objects"] = [];
  if (rawText) {
    let candidate = rawText.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as { objects?: typeof objects };
        if (Array.isArray(parsed.objects)) objects = parsed.objects;
      } catch {
        // fall through with empty objects
      }
    }
  }

  return { paintedImageBase64, objects, rawText, latencyMs };
}

const OBJECTS_MODEL = "gemini-2.5-flash";
const OBJECTS_PROMPT = `Identify every rooftop object visible on the central building's roof in this aerial satellite image. The target building is centered at pixel (640, 640) in a 1280x1280 image.

Only include objects you can directly see on the central building's roof. Do not infer objects under tree canopy. Do not include objects on neighboring buildings, in yards, or on the ground.

Types: vent, chimney, hvac_unit, skylight, plumbing_boot, satellite_dish, solar_panel.

Return JSON with center_pixel [x, y], bounding_box {x, y, width, height}, and a confidence float 0.0–1.0 reflecting certainty about both type and presence.`;

async function callGeminiObjects(tile: Buffer): Promise<MultimodalResult["objects"]> {
  const key = process.env.GEMINI_API_KEY!;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${OBJECTS_MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: OBJECTS_PROMPT },
              { inline_data: { mime_type: "image/png", data: tile.toString("base64") } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: GEMINI_ROOF_SCHEMA,
        },
      }),
    },
  );
  if (!r.ok) return [];
  const json = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { objects?: MultimodalResult["objects"] };
    return parsed.objects ?? [];
  } catch {
    return [];
  }
}

async function run(c: TestCase): Promise<void> {
  const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  console.log(`\n${"=".repeat(72)}\n${c.name}`);
  console.log(`Pin: (${c.lat}, ${c.lng}) — ${c.pinNote}`);
  console.log("=".repeat(72));

  const forceGemini = process.env.FORCE_GEMINI === "1";
  const cachePath = `/tmp/v3-test-${slug}-result.json`;
  const paintedPath = `/tmp/v3-test-${slug}-painted.png`;
  const tilePath = `/tmp/v3-test-${slug}-tile.png`;

  let result: MultimodalResult;

  if (!forceGemini && fs.existsSync(cachePath)) {
    console.log("[cache] reusing cached result (FORCE_GEMINI=1 to refresh)");
    result = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } else {
    console.log(`[1/3] Fetching Google tile at zoom ${PIN_TILE_ZOOM}…`);
    const tile = await fetchGoogleTile(c.lat, c.lng, PIN_TILE_ZOOM);
    fs.writeFileSync(tilePath, tile);
    console.log(`    saved ${tilePath} (${tile.length} bytes)`);

    console.log("[2/3] Parallel: multimodal paint + text objects… (PAID ~$0.08)");
    const t0 = Date.now();
    const [mm, objs] = await Promise.all([
      callGeminiMultimodal(tile),
      callGeminiObjects(tile),
    ]);
    const totalMs = Date.now() - t0;
    // Prefer the text-only call's objects (always populated when Flash
    // succeeds). The multimodal call's objects[] is almost always empty
    // because Gemini Pro Image discards the text part in IMAGE+TEXT mode.
    result = { ...mm, objects: objs };
    fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
    console.log(`    total latency: ${totalMs}ms`);
  }

  console.log("[3/3] RESULT");
  console.log(`    painted image:   ${result.paintedImageBase64 ? `${Math.round(result.paintedImageBase64.length * 3 / 4)} bytes (decoded)` : "(none)"}`);
  console.log(`    objects:         ${result.objects.length}`);
  if (result.paintedImageBase64) {
    fs.writeFileSync(paintedPath, Buffer.from(result.paintedImageBase64, "base64"));
    console.log(`    painted saved:   ${paintedPath}`);
  }
  for (const o of result.objects.slice(0, 20)) {
    const c = Array.isArray(o.center_pixel)
      ? `(${o.center_pixel[0]}, ${o.center_pixel[1]})`
      : `(${o.center_pixel.x}, ${o.center_pixel.y})`;
    const conf =
      typeof o.confidence === "number"
        ? `${(o.confidence * 100).toFixed(0)}%`
        : String(o.confidence);
    console.log(
      `      [${o.type.padEnd(15)}] center=${c.padEnd(13)} bbox=${o.bounding_box.width}×${o.bounding_box.height} conf=${conf}`,
    );
  }
  if (result.objects.length === 0 && result.rawText) {
    console.log(`    rawText (first 200 chars): ${result.rawText.slice(0, 200).replace(/\n/g, " ")}`);
  }
}

async function main(): Promise<void> {
  console.log(`Model: ${GEMINI_MODEL}  zoom=${PIN_TILE_ZOOM}  responseModalities=[IMAGE, TEXT]`);
  for (const c of CASES) {
    try {
      await run(c);
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("\nAll artifacts: /tmp/v3-test-*");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

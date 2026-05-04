import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import exifr from "exifr";
import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import type { PhotoMeta, PhotoTag, PhotoTagKind } from "@/types/photo";

export const runtime = "nodejs";
export const maxDuration = 60;

const VALID_TAG_KINDS: PhotoTagKind[] = [
  "missing-shingles",
  "lifted-shingle",
  "hail-impact",
  "granule-loss",
  "moss-algae",
  "discoloration",
  "tarp",
  "ponding",
  "damaged-flashing",
  "damaged-vent",
  "damaged-chimney",
  "soffit-fascia-damage",
  "gutter-damage",
  "skylight-damage",
  "drip-edge",
  "ridge-vent",
  "valley",
  "general-context",
  "interior-leak",
  "other",
];

interface AnalysisOut {
  tags: PhotoTag[];
  caption: string;
}

/**
 * POST /api/photos
 * multipart/form-data with field "file"
 *
 * Stores the photo in Vercel Blob, parses EXIF (GPS + timestamp + camera),
 * runs Claude vision against a downscaled JPEG to extract damage tags +
 * a one-sentence caption. Returns full PhotoMeta.
 */
export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN not set on server" },
      { status: 503 },
    );
  }
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file field required" }, { status: 400 });
  }
  if (file.size > 12 * 1024 * 1024) {
    return NextResponse.json({ error: "max 12MB" }, { status: 413 });
  }

  const ab = await file.arrayBuffer();
  const buf = Buffer.from(ab);

  // ─── EXIF ──────────────────────────────────────────────────────────────
  let takenAt = new Date().toISOString();
  let lat: number | undefined;
  let lng: number | undefined;
  let bearingDeg: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const exif = await exifr.parse(buf, {
      gps: true,
      pick: [
        "DateTimeOriginal",
        "CreateDate",
        "GPSLatitude",
        "GPSLongitude",
        "GPSImgDirection",
        "ExifImageWidth",
        "ExifImageHeight",
        "ImageWidth",
        "ImageHeight",
      ],
    });
    if (exif?.DateTimeOriginal instanceof Date) {
      takenAt = exif.DateTimeOriginal.toISOString();
    } else if (exif?.CreateDate instanceof Date) {
      takenAt = exif.CreateDate.toISOString();
    }
    if (typeof exif?.latitude === "number") lat = exif.latitude;
    if (typeof exif?.longitude === "number") lng = exif.longitude;
    if (typeof exif?.GPSImgDirection === "number") bearingDeg = exif.GPSImgDirection;
    width = exif?.ExifImageWidth ?? exif?.ImageWidth;
    height = exif?.ExifImageHeight ?? exif?.ImageHeight;
  } catch (err) {
    console.warn("[photos] EXIF parse failed:", err);
  }

  // Fall back to sharp metadata if EXIF didn't give us dimensions
  if (!width || !height) {
    try {
      const m = await sharp(buf).metadata();
      width = width ?? m.width;
      height = height ?? m.height;
    } catch {
      // ignore
    }
  }

  // ─── Upload to Vercel Blob ─────────────────────────────────────────────
  const id = `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const ext = file.name.split(".").pop() || "jpg";
  const blob = await put(`photos/${id}.${ext}`, buf, {
    access: "public",
    addRandomSuffix: false,
    contentType: file.type || "image/jpeg",
  });

  // ─── Claude vision tag pass ───────────────────────────────────────────
  let analysis: AnalysisOut = { tags: [], caption: "" };
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      // Downscale + re-encode as JPEG to keep tokens cheap
      const small = await sharp(buf)
        .rotate()
        .resize(1024, 1024, { fit: "inside" })
        .jpeg({ quality: 80 })
        .toBuffer();
      const b64 = small.toString("base64");
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const sysPrompt = `You are a roofing damage analyst reviewing a single field-inspection photo for an insurance-claim packet. Output STRICT JSON only, no prose:

{
  "tags": [{ "kind": "<one of ${VALID_TAG_KINDS.join("|")}>", "confidence": 0..1, "caption": "<<= 80 chars>" }],
  "caption": "<one sentence describing what's in this photo, 80-160 chars>"
}

Rules:
- Up to 4 tags ranked by relevance.
- Use "general-context" when the photo shows the house/roof at a distance with no specific damage visible.
- Use "interior-leak" only when interior ceiling / wall water damage is visible.
- Confidence < 0.4 → drop the tag entirely.
- Caption must be factual and specific to what is actually visible.`;
      const resp = await anthropic.messages.create({
        model: "claude-sonnet-4-5-20251022",
        max_tokens: 600,
        system: sysPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: b64 },
              },
              {
                type: "text",
                text: "Analyze this field photo. Output the JSON object only.",
              },
            ],
          },
        ],
      });
      const text =
        resp.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { text: string }).text)
          .join("\n") || "";
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]) as AnalysisOut;
        analysis = {
          tags: (parsed.tags ?? [])
            .filter(
              (t) =>
                VALID_TAG_KINDS.includes(t.kind as PhotoTagKind) &&
                typeof t.confidence === "number" &&
                t.confidence >= 0.4,
            )
            .slice(0, 4),
          caption: parsed.caption?.toString().slice(0, 200) ?? "",
        };
      }
    } catch (err) {
      console.error("[photos] vision tagging failed:", err);
    }
  }

  // ─── Claim-ready heuristic ────────────────────────────────────────────
  const takenAtMs = Date.parse(takenAt);
  const ageDays = (Date.now() - takenAtMs) / (1000 * 60 * 60 * 24);
  const claimReady =
    !!takenAt &&
    !!lat &&
    !!lng &&
    Number.isFinite(takenAtMs) &&
    ageDays >= 0 &&
    ageDays < 730; // <2yr old

  const meta: PhotoMeta = {
    id,
    url: blob.url,
    filename: file.name,
    takenAt,
    uploadedAt: new Date().toISOString(),
    sizeBytes: file.size,
    width,
    height,
    location: lat != null && lng != null ? { lat, lng, bearingDeg } : undefined,
    tags: analysis.tags,
    caption: analysis.caption || undefined,
    claimReady,
  };
  return NextResponse.json(meta);
}

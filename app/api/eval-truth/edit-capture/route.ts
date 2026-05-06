import { NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Capture a rep's manually-edited polygon as a future training/eval datapoint.
 *
 * Triggered by `/app/(internal)/page.tsx` after 5 seconds of no edits — at
 * that point the rep has stopped iterating on vertex placement and the
 * polygon is treated as their authoritative answer for that address.
 *
 * Storage:
 *   - Dev: writes JSON to `scripts/eval-truth/edits/<timestamp>-<slug>.json`.
 *   - Prod (Vercel): writes to Vercel Blob if BLOB_READ_WRITE_TOKEN is set,
 *     otherwise no-ops with a warning. Vercel functions don't have writable
 *     filesystem access at runtime.
 *
 * The captured `originalSource` lets us later compute "Roboflow IoU vs
 * rep-corrected truth" by source — which is the per-source-per-geography
 * accuracy intelligence we currently lack. After enough edits accumulate
 * (~300+), this becomes the labeled corpus for fine-tuning a custom
 * Roboflow model.
 *
 * Failures are non-fatal — the rep's primary work (sending the estimate)
 * never depends on this endpoint succeeding.
 */

interface Body {
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  originalSource?: string;
  polygon?: Array<{ lat: number; lng: number }>;
}

function sanitizeSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "unknown"
  );
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.lat !== "number" ||
    typeof body.lng !== "number" ||
    !Array.isArray(body.polygon) ||
    body.polygon.length < 3
  ) {
    return NextResponse.json(
      { error: "missing_fields", required: ["lat", "lng", "polygon (>=3 verts)"] },
      { status: 400 },
    );
  }

  const slug = sanitizeSlug(
    body.address || `addr-${body.lat.toFixed(5)}-${body.lng.toFixed(5)}`,
  );
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}-${slug}.json`;

  const payload = {
    capturedAt: new Date().toISOString(),
    address: body.address ?? null,
    lat: body.lat,
    lng: body.lng,
    originalSource: body.originalSource ?? "unknown",
    polygon: body.polygon,
  };

  // Vercel runtime: writable filesystem isn't available. Use Vercel Blob
  // when configured; otherwise log and no-op so we never break the rep's
  // primary flow.
  if (process.env.NODE_ENV === "production") {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      console.warn(
        "[edit-capture] BLOB_READ_WRITE_TOKEN not set — skipping persistence",
      );
      return NextResponse.json({ ok: true, persisted: false });
    }
    try {
      // Lazy-load to avoid pulling Vercel Blob into dev where it's unused.
      const { put } = await import("@vercel/blob");
      const blob = await put(`eval-truth/edits/${filename}`, JSON.stringify(payload, null, 2), {
        access: "public",
        contentType: "application/json",
        token: blobToken,
      });
      return NextResponse.json({ ok: true, persisted: true, url: blob.url });
    } catch (err) {
      console.warn("[edit-capture] Vercel Blob write failed:", err);
      return NextResponse.json({ ok: true, persisted: false });
    }
  }

  // Dev: write to local filesystem
  const dir = join(process.cwd(), "scripts", "eval-truth", "edits");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), JSON.stringify(payload, null, 2) + "\n", "utf8");
    return NextResponse.json({
      ok: true,
      persisted: true,
      file: `scripts/eval-truth/edits/${filename}`,
    });
  } catch (err) {
    console.warn("[edit-capture] dev filesystem write failed:", err);
    return NextResponse.json({ ok: true, persisted: false });
  }
}

import { NextResponse } from "next/server";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Save a hand-traced ground-truth polygon for an address.
 *
 * Writes to `scripts/eval-truth/<slug>.json` so `scripts/eval-truth.ts`
 * can pick them up later. The slug is sanitized from a user-provided
 * label (or auto-derived from the address). Files are kept in-repo
 * alongside the eval harness; check them in if you want regression
 * coverage on the same addresses across commits.
 *
 * Dev-only — guarded behind NODE_ENV !== "production" to avoid exposing
 * a filesystem write endpoint on a real deployment.
 */

interface SaveBody {
  slug?: string;
  address?: string;
  lat?: number;
  lng?: number;
  polygon?: Array<{ lat: number; lng: number }>;
  notes?: string;
}

function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "eval-truth save disabled in production" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as SaveBody | null;
  if (!body) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { address, lat, lng, polygon, notes } = body;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Array.isArray(polygon) ||
    polygon.length < 3
  ) {
    return NextResponse.json(
      { error: "missing_fields", required: ["lat", "lng", "polygon (>=3 verts)"] },
      { status: 400 },
    );
  }

  const slug =
    sanitizeSlug(body.slug || address || `addr-${lat.toFixed(5)}-${lng.toFixed(5)}`) ||
    `addr-${Date.now()}`;

  const dir = join(process.cwd(), "scripts", "eval-truth");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${slug}.json`);

  const payload = {
    slug,
    address: address ?? null,
    lat,
    lng,
    polygon,
    notes: notes ?? null,
    savedAt: new Date().toISOString(),
  };

  await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return NextResponse.json({ ok: true, slug, file: `scripts/eval-truth/${slug}.json` });
}

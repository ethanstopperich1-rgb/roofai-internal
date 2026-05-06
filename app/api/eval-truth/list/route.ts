import { NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * List ground-truth annotations saved under scripts/eval-truth/.
 * Returns a thin summary per file so the annotation UI can show
 * "you've already traced these N addresses."
 */
export async function GET() {
  const dir = join(process.cwd(), "scripts", "eval-truth");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return NextResponse.json({ entries: [] });
  }

  const entries = await Promise.all(
    files.map(async (f) => {
      try {
        const raw = await readFile(join(dir, f), "utf8");
        const data = JSON.parse(raw) as {
          slug?: string;
          address?: string | null;
          lat?: number;
          lng?: number;
          polygon?: Array<{ lat: number; lng: number }>;
          savedAt?: string;
        };
        return {
          slug: data.slug ?? f.replace(/\.json$/, ""),
          address: data.address ?? null,
          lat: data.lat ?? null,
          lng: data.lng ?? null,
          vertices: data.polygon?.length ?? 0,
          savedAt: data.savedAt ?? null,
        };
      } catch {
        return null;
      }
    }),
  );

  return NextResponse.json({
    entries: entries.filter((e): e is NonNullable<typeof e> => e != null),
  });
}

// app/api/debug/roof-pipeline/route.ts
import { NextResponse } from "next/server";
import { runRoofPipeline } from "@/lib/roof-pipeline";

export const runtime = "nodejs";

/**
 * Temporary debug route for Phase 1 verification. Removed at end of Phase 3.
 *
 * Usage:
 *   GET /api/debug/roof-pipeline?lat=28.4815&lng=-81.4720&nocache=1&address=...
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const address = searchParams.get("address") ?? "debug";
  const nocache = searchParams.get("nocache") === "1";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }
  const data = await runRoofPipeline({
    address: { formatted: address, lat, lng },
    nocache,
  });
  return NextResponse.json(data);
}

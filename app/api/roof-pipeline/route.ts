// app/api/roof-pipeline/route.ts
import { NextResponse } from "next/server";
import { runRoofPipeline } from "@/lib/roof-pipeline";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Production roof-pipeline endpoint used by /internal and /quote pages.
 * Same shape as the debug route, but rate-limited via the standard bucket
 * (60 req/min/IP) since the underlying pipeline fans out to Google Solar,
 * BigQuery, and other quota'd services.
 *
 * Usage:
 *   GET /api/roof-pipeline?lat=28.4815&lng=-81.4720&address=...&nocache=1
 */
export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const address = searchParams.get("address") ?? "";
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

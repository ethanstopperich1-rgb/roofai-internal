// app/api/roof-pipeline/route.ts
import { NextResponse } from "next/server";
import { runRoofPipeline, runRoofPipelineCompare } from "@/lib/roof-pipeline";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * Production roof-pipeline endpoint used by /internal and /quote pages.
 *
 * Default mode (?compare unset): returns a single RoofData payload — the
 * winning source from the serial Tier A → C pipeline. Backwards-compatible
 * with all existing callers.
 *
 * Cross-compare mode (?compare=1): runs Tier A (LiDAR) and Tier C (Solar)
 * IN PARALLEL on the same address and returns both RoofData payloads plus
 * agreement metrics. Used by the new dual-source 3D viewer so the customer
 * /quote and rep /internal UIs can let users toggle between Solar's and
 * LiDAR's measurements with a button. Total wall time = max(lidar, solar),
 * not sum.
 *
 * Both modes are rate-limited via the standard bucket (60 req/min/IP).
 *
 * Usage:
 *   GET /api/roof-pipeline?lat=28.4815&lng=-81.4720&address=...&nocache=1
 *   GET /api/roof-pipeline?lat=28.4815&lng=-81.4720&address=...&compare=1
 */
export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const address = searchParams.get("address") ?? "";
  const nocache = searchParams.get("nocache") === "1";
  const compare = searchParams.get("compare") === "1";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  if (compare) {
    const result = await runRoofPipelineCompare({
      address: { formatted: address, lat, lng },
      nocache,
    });
    return NextResponse.json(result);
  }

  const data = await runRoofPipeline({
    address: { formatted: address, lat, lng },
    nocache,
  });
  return NextResponse.json(data);
}

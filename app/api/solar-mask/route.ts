import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { fetchSolarRoofMask, type SolarMaskPolygon } from "@/lib/solar-mask";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/solar-mask?lat=..&lng=..
 *
 * Returns a single roof polygon derived from Google Solar API's mask
 * GeoTIFF — the same data Project Sunroof uses for solar-array sizing.
 * Beats SAM/OSM/AI for any property in Solar coverage (which is most of
 * the US, EU, JP, AU). Returns 404 when Solar has no coverage.
 *
 * Cached server-side per lat/lng for 24h (data layers update infrequently).
 */
export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  const apiKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json({ error: "Missing Google key" }, { status: 503 });
  }

  const cached = await getCached<SolarMaskPolygon | null>("solar-mask", lat, lng);
  if (cached !== null) {
    if (cached === undefined) {
      return NextResponse.json(
        { error: "no_coverage", message: "Solar mask not available for this address." },
        { status: 404 },
      );
    }
    return NextResponse.json(cached);
  }

  const result = await fetchSolarRoofMask({ lat, lng, apiKey });
  if (!result) {
    await setCached<SolarMaskPolygon | null>("solar-mask", lat, lng, null);
    return NextResponse.json(
      { error: "no_coverage", message: "Solar mask not available for this address." },
      { status: 404 },
    );
  }

  await setCached("solar-mask", lat, lng, result);
  return NextResponse.json(result);
}

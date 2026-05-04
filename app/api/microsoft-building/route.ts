import { NextResponse } from "next/server";
import { fetchMicrosoftBuildingPolygon, type MicrosoftBuildingResult } from "@/lib/microsoft-buildings";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * GET /api/microsoft-building?lat=..&lng=..
 *
 * Microsoft Building Footprints lookup — open-data building polygons
 * extracted from satellite imagery via ML, covering rural areas where
 * OSM has no coverage. ODbL license.
 *
 * Currently scoped to the Nashville metro bbox (lat 35.7-36.2,
 * lng -86.9 to -86.3). Returns 404 outside that bbox; expand by editing
 * scripts/build-ms-buildings-tn.ts and re-running the build.
 *
 * Cached server-side per lat/lng for 6h.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  const cached = getCached<MicrosoftBuildingResult | null>("ms-buildings", lat, lng);
  if (cached !== null) {
    if (cached === undefined) {
      return NextResponse.json(
        { error: "no_coverage", message: "No Microsoft Building Footprint near this address." },
        { status: 404 },
      );
    }
    return NextResponse.json(cached);
  }

  const result = await fetchMicrosoftBuildingPolygon({ lat, lng });
  if (!result) {
    setCached<MicrosoftBuildingResult | null>("ms-buildings", lat, lng, null);
    return NextResponse.json(
      { error: "no_coverage", message: "No Microsoft Building Footprint near this address." },
      { status: 404 },
    );
  }

  setCached("ms-buildings", lat, lng, result);
  return NextResponse.json(result);
}

import { NextResponse } from "next/server";
import { fetchBuildingPolygon, type BuildingPolygon } from "@/lib/buildings";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/building?lat=..&lng=..
 * Returns the OpenStreetMap building polygon containing or nearest to
 * the given lat/lng. Cached server-side per lat/lng for 6h.
 *
 * { polygon: Array<{ lat, lng }>, source: "osm", osmId?: number } | { error }
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  const cached = await getCached<BuildingPolygon | null>("building", lat, lng);
  if (cached !== null) {
    if (cached === undefined) {
      return NextResponse.json(
        { error: "no_building", message: "OSM has no building near this address." },
        { status: 404 },
      );
    }
    return NextResponse.json(cached);
  }

  const result = await fetchBuildingPolygon({ lat, lng });
  if (!result) {
    await setCached<BuildingPolygon | null>("building", lat, lng, null);
    return NextResponse.json(
      { error: "no_building", message: "OSM has no building near this address." },
      { status: 404 },
    );
  }

  await setCached("building", lat, lng, result);
  return NextResponse.json(result);
}

import { NextResponse } from "next/server";
import {
  refineRoofWithGroundedSam,
  type GroundedRoofPolygon,
} from "@/lib/grounded-sam";
import { fetchBuildingPolygon } from "@/lib/buildings";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * POST /api/sam-refine
 * Body: { lat, lng }
 *
 * Compound roof-refinement pipeline:
 *   1. (parallel) Fetch OSM building polygon if available
 *   2. (parallel) Run Grounded SAM with text prompt "main residential roof"
 *      (negative: trees, lawn, driveway, deck, pool, shadows)
 *   3. Sanity-check the SAM polygon against the OSM footprint:
 *      - If OSM exists and SAM polygon's centroid lands outside OSM
 *        (off the building), drop SAM and fall back to OSM.
 *      - Otherwise return SAM polygon (tight roof outline).
 *   4. If SAM fails entirely, return OSM polygon when we have one.
 *
 * Cached 6h per lat/lng. Latency ~5-10s.
 */
type Body = { lat?: number; lng?: number };

function pointInPolygon(
  lat: number,
  lng: number,
  poly: Array<{ lat: number; lng: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat;
    const xj = poly[j].lng, yj = poly[j].lat;
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function centroidOf(poly: Array<{ lat: number; lng: number }>): {
  lat: number;
  lng: number;
} {
  let lat = 0, lng = 0;
  for (const v of poly) { lat += v.lat; lng += v.lng; }
  return { lat: lat / poly.length, lng: lng / poly.length };
}

interface SamRefineCachedResult {
  polygon: Array<{ lat: number; lng: number }>;
  source: "sam-grounded" | "sam-clipped-osm" | "osm-fallback";
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  if (!process.env.REPLICATE_API_TOKEN) {
    return NextResponse.json(
      { error: "Missing REPLICATE_API_TOKEN" },
      { status: 503 },
    );
  }
  const googleMapsKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleMapsKey) {
    return NextResponse.json(
      { error: "Missing Google Maps key" },
      { status: 503 },
    );
  }

  const cached = getCached<SamRefineCachedResult>("sam-refine", lat, lng);
  if (cached) return NextResponse.json(cached);

  // Run OSM lookup + Grounded SAM in parallel. SAM throws specific errors
  // for credit / token issues that we want to surface as proper HTTP codes;
  // anything else collapses to "null result" so the chain still works.
  let osmResult: Awaited<ReturnType<typeof fetchBuildingPolygon>> | null = null;
  let samResult: Awaited<ReturnType<typeof refineRoofWithGroundedSam>> = null;
  try {
    [osmResult, samResult] = await Promise.all([
      fetchBuildingPolygon({ lat, lng }).catch(() => null),
      refineRoofWithGroundedSam({ lat, lng, googleMapsKey }),
    ]);
  } catch (err) {
    const code = err instanceof Error ? err.message : "unknown";
    if (code === "REPLICATE_NO_CREDIT") {
      return NextResponse.json(
        {
          error: "no_credit",
          message:
            "Replicate trial credit exhausted. Add billing at replicate.com/account/billing.",
        },
        { status: 402 },
      );
    }
    if (code === "REPLICATE_UNAUTHORIZED") {
      return NextResponse.json(
        { error: "bad_token", message: "Invalid REPLICATE_API_TOKEN." },
        { status: 401 },
      );
    }
    // Other failures: try to recover via OSM only
    osmResult = await fetchBuildingPolygon({ lat, lng }).catch(() => null);
    samResult = null;
  }

  // If SAM returned a polygon, sanity-check it against OSM
  if (samResult) {
    if (osmResult) {
      const c = centroidOf(samResult.latLng);
      if (pointInPolygon(c.lat, c.lng, osmResult.latLng)) {
        // SAM polygon's centroid is on the OSM building → trust SAM
        const result: SamRefineCachedResult = {
          polygon: samResult.latLng,
          source: "sam-grounded",
        };
        setCached("sam-refine", lat, lng, result);
        return NextResponse.json(result);
      }
      // SAM picked something off-building (e.g., a neighbour, the road).
      // Fall back to OSM.
      console.warn(
        "[sam-refine] SAM centroid landed off the OSM building — using OSM",
      );
      const result: SamRefineCachedResult = {
        polygon: osmResult.latLng,
        source: "osm-fallback",
      };
      setCached("sam-refine", lat, lng, result);
      return NextResponse.json(result);
    }
    // No OSM to validate against — trust SAM
    const result: SamRefineCachedResult = {
      polygon: samResult.latLng,
      source: "sam-grounded",
    };
    setCached("sam-refine", lat, lng, result);
    return NextResponse.json(result);
  }

  // SAM failed; if OSM has a building, return that
  if (osmResult) {
    const result: SamRefineCachedResult = {
      polygon: osmResult.latLng,
      source: "osm-fallback",
    };
    setCached("sam-refine", lat, lng, result);
    return NextResponse.json(result);
  }

  return NextResponse.json(
    {
      error: "no_polygon",
      message: "Neither SAM nor OSM produced a usable roof polygon.",
    },
    { status: 502 },
  );
}

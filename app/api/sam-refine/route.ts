import { NextResponse } from "next/server";
import polygonClipping from "polygon-clipping";
import {
  refineRoofWithGroundedSam,
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

/**
 * Clip the SAM polygon to the OSM building polygon using polygon-clipping
 * (martinez algorithm, robust against degenerate input). Returns the
 * largest resulting region, since OSM × SAM occasionally splits the SAM
 * mask into multiple disjoint pieces (e.g. a porch shadow that bleeds
 * into the lawn gets cut off, leaving the main roof piece).
 */
function clipSamToOsm(
  sam: Array<{ lat: number; lng: number }>,
  osm: Array<{ lat: number; lng: number }>,
): Array<{ lat: number; lng: number }> | null {
  if (sam.length < 3 || osm.length < 3) return null;
  const samRing = sam.map((v) => [v.lng, v.lat] as [number, number]);
  const osmRing = osm.map((v) => [v.lng, v.lat] as [number, number]);
  // Close rings if not already closed
  if (samRing[0][0] !== samRing[samRing.length - 1][0] || samRing[0][1] !== samRing[samRing.length - 1][1]) {
    samRing.push(samRing[0]);
  }
  if (osmRing[0][0] !== osmRing[osmRing.length - 1][0] || osmRing[0][1] !== osmRing[osmRing.length - 1][1]) {
    osmRing.push(osmRing[0]);
  }
  let result: ReturnType<typeof polygonClipping.intersection>;
  try {
    result = polygonClipping.intersection([samRing], [osmRing]);
  } catch (err) {
    console.warn("[sam-refine] polygon intersection failed:", err);
    return null;
  }
  if (!result || result.length === 0) return null;
  // Pick the largest piece by shoelace area. (v1 ranked by vertex count,
  // which let a 6-vertex sliver beat a 4-vertex piece covering 95% of
  // the roof — exactly the failure mode where a porch shadow split the
  // mask and we kept the wrong half.)
  const ringArea = (ring: Array<[number, number]>): number => {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[i + 1];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
  };
  let best: typeof result[number] | null = null;
  let bestArea = 0;
  for (const piece of result) {
    if (!piece[0]) continue;
    const a = ringArea(piece[0]);
    if (a > bestArea) {
      bestArea = a;
      best = piece;
    }
  }
  if (!best || !best[0]) return null;
  // Drop the closing-vertex duplicate
  const ring = best[0];
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const verts = closed ? ring.slice(0, -1) : ring;
  if (verts.length < 3) return null;
  return verts.map((p) => ({ lng: p[0], lat: p[1] }));
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

  // If SAM returned a polygon, clip it against OSM when we have a building
  // footprint. This is the magic step: SAM identifies "roof" semantically,
  // OSM provides ground-truth building boundary, intersection drops every
  // pixel that's outside the actual building (driveway shadows, lawn,
  // neighbouring roofs the prompt didn't fully suppress).
  if (samResult) {
    if (osmResult) {
      const clipped = clipSamToOsm(samResult.latLng, osmResult.latLng);
      if (clipped && clipped.length >= 3) {
        console.log(
          `[sam-refine] clipped SAM (${samResult.latLng.length} verts) × OSM (${osmResult.latLng.length}) → ${clipped.length} verts`,
        );
        const result: SamRefineCachedResult = {
          polygon: clipped,
          source: "sam-clipped-osm",
        };
        setCached("sam-refine", lat, lng, result);
        return NextResponse.json(result);
      }
      // Intersection produced nothing — SAM and OSM didn't overlap, meaning
      // SAM picked up something off-building (e.g., a neighbour, the road).
      // Fall back to OSM.
      console.warn(
        "[sam-refine] SAM × OSM intersection empty — falling back to OSM",
      );
      const c = centroidOf(samResult.latLng);
      if (!pointInPolygon(c.lat, c.lng, osmResult.latLng)) {
        const result: SamRefineCachedResult = {
          polygon: osmResult.latLng,
          source: "osm-fallback",
        };
        setCached("sam-refine", lat, lng, result);
        return NextResponse.json(result);
      }
      // Centroid IS on building but intersection failed (degenerate poly).
      // Use raw SAM as last resort.
      const result: SamRefineCachedResult = {
        polygon: samResult.latLng,
        source: "sam-grounded",
      };
      setCached("sam-refine", lat, lng, result);
      return NextResponse.json(result);
    }
    // No OSM to validate against — trust SAM as-is. Without OSM clip the
    // polygon may include some yard/shadow, but it's the best we have.
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

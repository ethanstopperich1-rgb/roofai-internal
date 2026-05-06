import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import polygonClipping from "polygon-clipping";
import {
  refineRoofWithGroundedSam,
} from "@/lib/grounded-sam";
import { fetchBuildingPolygon } from "@/lib/buildings";
import { fetchSolarRoofMask } from "@/lib/solar-mask";
import { getCached, setCached } from "@/lib/cache";
import { fetchSatelliteImage, validateRoofPolygon } from "@/lib/anthropic";
import {
  bestOrthogonalize,
  polygonPrincipalAxisDeg,
  mergeNearbyVertices,
} from "@/lib/polygon";

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
  source:
    | "sam-grounded"
    | "sam-clipped-osm"
    | "sam-clipped-solar"
    | "osm-fallback"
    | "solar-fallback";
  /** Vision QA gate output (Claude). Low confidence (<0.45) blocks the
   *  polygon from being returned — the route falls through to whatever
   *  the next-priority source gives the client. */
  qa?: { confidence: number; reason: string };
}

/** Convert a lat/lng polygon to pixel coords on a zoom-20 scale-2 (1280×1280)
 *  satellite tile centered at (centerLat, centerLng). Used to feed the
 *  vision QA validator after SAM produces a polygon in lat/lng space. */
function latLngPolygonToPixels(
  poly: Array<{ lat: number; lng: number }>,
  centerLat: number,
  centerLng: number,
  imagePixels = 1280,
  scale = 2,
): Array<[number, number]> {
  const mPerPx =
    (156_543.03392 * Math.cos((centerLat * Math.PI) / 180)) / Math.pow(2, 20) / scale;
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  return poly.map((v) => {
    const dx = (v.lng - centerLng) * 111_320 * cosLat;
    const dy = (v.lat - centerLat) * 111_320;
    return [imagePixels / 2 + dx / mPerPx, imagePixels / 2 - dy / mPerPx];
  });
}

/** Run the QA gate against a polygon. Returns null if the polygon should be
 *  rejected (low confidence), otherwise the QA result for caller logging. */
async function runQaGate(opts: {
  polygon: Array<{ lat: number; lng: number }>;
  lat: number;
  lng: number;
  apiKey: string;
}): Promise<{ confidence: number; reason: string } | null> {
  const img = await fetchSatelliteImage({
    lat: opts.lat,
    lng: opts.lng,
    apiKey: opts.apiKey,
    size: 640,
    zoom: 20,
  });
  if (!img) return { confidence: 0.6, reason: "image_fetch_failed" };
  // Sample to scale=2 size for a tighter image (matches what SAM saw).
  const pixelPoly = latLngPolygonToPixels(opts.polygon, opts.lat, opts.lng, 1280, 2);
  const qa = await validateRoofPolygon({
    imageBase64: img.base64,
    polygon: pixelPoly,
    imagePixels: 1280,
  });
  console.log(`[sam-refine] QA gate: ${qa.confidence.toFixed(2)} — ${qa.reason}`);
  if (qa.confidence < 0.45) return null;
  return qa;
}

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "expensive");
  if (__rl) return __rl;
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

  const cached = await getCached<SamRefineCachedResult>("sam-refine", lat, lng);
  if (cached) return NextResponse.json(cached);

  // Run OSM + Solar mask + Grounded SAM in parallel. OSM is the preferred
  // guard polygon (hand-traced footprint), but coverage is uneven — only
  // ~50-60% of US residential addresses have OSM data, and suburban/rural
  // markets like central Florida get 0%. Solar mask (Project Sunroof's
  // photogrammetric roof segmentation) covers most of the US and serves
  // as a reliable SAM-guard fallback when OSM is missing. SAM throws
  // specific errors for credit / token issues that we surface as proper
  // HTTP codes; anything else collapses to "null result" so the chain
  // still works.
  let osmResult: Awaited<ReturnType<typeof fetchBuildingPolygon>> | null = null;
  let solarMaskResult: Awaited<ReturnType<typeof fetchSolarRoofMask>> = null;
  let samResult: Awaited<ReturnType<typeof refineRoofWithGroundedSam>> = null;
  try {
    [osmResult, solarMaskResult, samResult] = await Promise.all([
      fetchBuildingPolygon({ lat, lng }).catch(() => null),
      fetchSolarRoofMask({ lat, lng, apiKey: googleMapsKey }).catch(() => null),
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
    // Other failures: try to recover via OSM/Solar mask only
    [osmResult, solarMaskResult] = await Promise.all([
      fetchBuildingPolygon({ lat, lng }).catch(() => null),
      fetchSolarRoofMask({ lat, lng, apiKey: googleMapsKey }).catch(() => null),
    ]);
    samResult = null;
  }

  // Pick a guard polygon for SAM clipping. OSM > Solar mask. OSM is hand-
  // traced (most reliable when present); Solar mask is photogrammetric
  // (reliable, broader coverage). Either works as a clip target — the
  // intersection trims SAM bleed into lawn/shadows.
  const guard: { poly: Array<{ lat: number; lng: number }>; source: "osm" | "solar" } | null =
    osmResult
      ? { poly: osmResult.latLng, source: "osm" }
      : solarMaskResult
        ? { poly: solarMaskResult.latLng, source: "solar" }
        : null;

  // Build the candidate polygon (SAM × guard clip when available, fall
  // back through the chain), then run the QA gate at the end. Centralising
  // the gate at one spot avoids duplicating the validate-or-reject logic
  // at every return site.
  let candidate:
    | { polygon: Array<{ lat: number; lng: number }>; source: SamRefineCachedResult["source"] }
    | null = null;

  if (samResult) {
    if (guard) {
      const clipped = clipSamToOsm(samResult.latLng, guard.poly);
      if (clipped && clipped.length >= 3) {
        // Re-orthogonalize the clipped polygon using the guard polygon's
        // principal axis as a candidate. Polygon clipping reintroduces
        // jaggies at intersection corners, and the guard axis is usually
        // the most reliable building-axis signal we have for this property.
        const guardAxis = polygonPrincipalAxisDeg(guard.poly);
        const clippedPoints = clipped.map((v) => [v.lng, v.lat] as [number, number]);
        const reOrtho = bestOrthogonalize({
          poly: clippedPoints,
          candidateAxesDeg: [guardAxis],
          toleranceDeg: 14,
        });
        const finalPoints = mergeNearbyVertices(reOrtho.polygon, 1e-6);
        const finalLatLng = finalPoints.map(([lng, lat]) => ({ lat, lng }));
        console.log(
          `[sam-refine] clipped SAM (${samResult.latLng.length} verts) × ${guard.source.toUpperCase()} (${guard.poly.length}) → ortho@${reOrtho.chosenAxisDeg.toFixed(1)}° → ${finalLatLng.length} verts`,
        );
        candidate = {
          polygon: finalLatLng,
          source: guard.source === "osm" ? "sam-clipped-osm" : "sam-clipped-solar",
        };
      } else {
        console.warn(`[sam-refine] SAM × ${guard.source.toUpperCase()} intersection empty — checking centroid`);
        const c = centroidOf(samResult.latLng);
        if (!pointInPolygon(c.lat, c.lng, guard.poly)) {
          // SAM landed off-building — trust the guard
          candidate = {
            polygon: guard.poly,
            source: guard.source === "osm" ? "osm-fallback" : "solar-fallback",
          };
        } else {
          // Centroid on building but intersection degenerate — raw SAM
          candidate = { polygon: samResult.latLng, source: "sam-grounded" };
        }
      }
    } else {
      candidate = { polygon: samResult.latLng, source: "sam-grounded" };
    }
  } else if (guard) {
    candidate = {
      polygon: guard.poly,
      source: guard.source === "osm" ? "osm-fallback" : "solar-fallback",
    };
  }

  if (!candidate) {
    return NextResponse.json(
      {
        error: "no_polygon",
        message: "Neither SAM nor OSM produced a usable roof polygon.",
      },
      { status: 502 },
    );
  }

  // Vision QA gate. OSM polygons are human-traced and trusted; Solar mask
  // polygons are photogrammetric ground truth — skip the gate for both.
  // SAM/SAM-clipped go through Claude validation: confidence < 0.45 means
  // the polygon doesn't actually look like the centred building's roof,
  // so we discard it and return 502 (client falls through to the Claude
  // AI source or the manual draw mode).
  const isTrustedFallback =
    candidate.source === "osm-fallback" || candidate.source === "solar-fallback";
  let qa: { confidence: number; reason: string } | null = null;
  if (!isTrustedFallback) {
    qa = await runQaGate({
      polygon: candidate.polygon,
      lat,
      lng,
      apiKey: googleMapsKey,
    });
    if (!qa) {
      console.warn(
        `[sam-refine] QA gate REJECTED ${candidate.source} polygon — falling through`,
      );
      // If we have a guard polygon as backup, return it instead
      if (guard) {
        const result: SamRefineCachedResult = {
          polygon: guard.poly,
          source: guard.source === "osm" ? "osm-fallback" : "solar-fallback",
        };
        await setCached("sam-refine", lat, lng, result);
        return NextResponse.json(result);
      }
      return NextResponse.json(
        {
          error: "no_polygon",
          message: "SAM polygon failed QA validation; no OSM fallback available.",
        },
        { status: 502 },
      );
    }
  }

  const result: SamRefineCachedResult = {
    polygon: candidate.polygon,
    source: candidate.source,
    ...(qa && { qa }),
  };
  await setCached("sam-refine", lat, lng, result);
  return NextResponse.json(result);
}

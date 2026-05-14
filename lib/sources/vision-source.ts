// lib/sources/vision-source.ts
import type { RoofData, Facet } from "@/types/roof";
import type { RoofVision } from "@/types/estimate";
import {
  classifyEdges, computeFlashing, computeTotals,
} from "@/lib/roof-engine";
import { getMemoizedVision, type VisionFetcher } from "@/lib/cache/vision-request";
import { mapVisionMaterial, visionPenetrationsToObjects } from "./vision-mappers";

/**
 * Tier C vision-only fallback. Single-facet whole-roof RoofData when
 * Solar has no coverage. Lower confidence (0.40); per-facet pitch isn't
 * available — uses a 25° default until the vision prompt is enhanced
 * for estimatedPitchDegrees (deferred to Tier B+).
 */
export async function tierCVisionSource(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  requestId: string;
  visionFetcher?: VisionFetcher;
  /** Approximate footprint sqft for sizing the single facet. When the caller
   *  has a Microsoft Buildings or geocoded estimate, pass it; otherwise
   *  defaults to 2000 sqft. */
  estimatedFootprintSqft?: number;
}): Promise<RoofData | null> {
  const visionFetcher = opts.visionFetcher ?? defaultVisionFetcher;
  const vision = await getMemoizedVision({
    lat: opts.address.lat,
    lng: opts.address.lng,
    requestId: opts.requestId,
    fetcher: visionFetcher,
  });
  if (!vision) return null;
  // Empty roof polygon = vision couldn't identify the roof
  if (!vision.roofPolygon || vision.roofPolygon.length < 3) return null;

  const facet = visionToSingleFacet(opts.address, vision, opts.estimatedFootprintSqft ?? 2000);
  const facets = [facet];
  const edges = classifyEdges(facets, null);
  const objects = visionPenetrationsToObjects(opts.address, vision);
  const flashing = computeFlashing(facets, edges, objects);
  const totals = computeTotals(facets, edges, objects);

  return {
    address: opts.address,
    source: "tier-c-vision",
    refinements: [],
    confidence: 0.40,
    imageryDate: null,
    ageYearsEstimate: vision.estimatedAgeYears,
    ageBucket: vision.estimatedAge !== "unknown" ? vision.estimatedAge : null,
    facets, edges, objects, flashing, totals,
    diagnostics: {
      attempts: [],
      warnings: ["Vision-only fallback — no Solar coverage. Pitch and area are approximate."],
      needsReview: [],
    },
  };
}

function visionToSingleFacet(
  address: { lat: number; lng: number },
  vision: RoofVision,
  estimatedFootprintSqft: number,
): Facet {
  // vision.roofPolygon is in 640×640 pixel coords — we don't have the tile
  // bounds, so we synthesize a square lat/lng polygon around the address
  // sized to the footprint estimate. Tier B refinement supplies real
  // geometry. Pitch defaults to 25° (~6/12 typical residential average)
  // until the vision prompt adds estimatedPitchDegrees.
  const pitchDeg = 25;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const slopeRatio = 1 / Math.cos(pitchRad);
  const slopedArea = Math.round(estimatedFootprintSqft * slopeRatio);
  // 1 m ≈ 1/111320 degrees lat
  const sideM = Math.sqrt(estimatedFootprintSqft / 10.7639); // sqft -> m²
  const halfDeg = sideM / 2 / 111_320;
  // Synthetic default; vision-only fallback has no measured azimuth.
  const azimuthDeg = 180;
  const azRad = (azimuthDeg * Math.PI) / 180;
  return {
    id: "facet-0",
    polygon: [
      { lat: address.lat - halfDeg, lng: address.lng - halfDeg },
      { lat: address.lat - halfDeg, lng: address.lng + halfDeg },
      { lat: address.lat + halfDeg, lng: address.lng + halfDeg },
      { lat: address.lat + halfDeg, lng: address.lng - halfDeg },
    ],
    // Normal vector consistent with pitchDegrees + azimuthDeg (matches the
    // solar source's normal-from-pitch formula). Tier C single-facet
    // fallback so this normal isn't load-bearing, but keep it consistent
    // with the rest of the schema.
    normal: {
      x: Math.sin(pitchRad) * Math.sin(azRad),
      y: Math.sin(pitchRad) * Math.cos(azRad),
      z: Math.cos(pitchRad),
    },
    pitchDegrees: pitchDeg,
    azimuthDeg,
    areaSqftSloped: slopedArea,
    areaSqftFootprint: estimatedFootprintSqft,
    material: mapVisionMaterial(vision.currentMaterial),
    isLowSlope: pitchDeg < 18.43,
  };
}

// TODO(task-19): consumer should inject fetchers that avoid the HTTP self-call
// (call /api/vision route handler directly server-side).
async function defaultVisionFetcher(lat: number, lng: number): Promise<RoofVision | null> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/vision?lat=${lat}&lng=${lng}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

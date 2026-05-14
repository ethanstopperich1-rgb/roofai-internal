// lib/sources/vision-source.ts
import type { RoofData, Facet, Material } from "@/types/roof";
import type { RoofVision } from "@/types/estimate";
import {
  classifyEdges, computeFlashing, computeTotals,
} from "@/lib/roof-engine";
import { getMemoizedVision, type VisionFetcher } from "@/lib/cache/vision-request";

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
  return {
    id: "facet-0",
    polygon: [
      { lat: address.lat - halfDeg, lng: address.lng - halfDeg },
      { lat: address.lat - halfDeg, lng: address.lng + halfDeg },
      { lat: address.lat + halfDeg, lng: address.lng + halfDeg },
      { lat: address.lat + halfDeg, lng: address.lng - halfDeg },
    ],
    normal: { x: 0, y: 0, z: 1 },
    pitchDegrees: pitchDeg,
    azimuthDeg: 180,
    areaSqftSloped: slopedArea,
    areaSqftFootprint: estimatedFootprintSqft,
    material: mapVisionMaterial(vision.currentMaterial),
    isLowSlope: false,
  };
}

function visionPenetrationsToObjects(
  address: { lat: number; lng: number },
  vision: RoofVision,
): RoofData["objects"] {
  return vision.penetrations.map((p, idx) => ({
    id: `obj-${idx}`,
    kind: mapPenetrationKind(p.kind),
    position: { lat: address.lat, lng: address.lng, heightM: 0 },
    dimensionsFt: {
      width: p.approxSizeFt ?? defaultDimForKind(p.kind),
      length: p.approxSizeFt ?? defaultDimForKind(p.kind),
    },
    facetId: null,
  }));
}

function mapPenetrationKind(k: RoofVision["penetrations"][number]["kind"]): RoofData["objects"][number]["kind"] {
  if (k === "vent") return "vent";
  if (k === "chimney") return "chimney";
  if (k === "skylight") return "skylight";
  if (k === "stack") return "stack";
  if (k === "satellite-dish") return "satellite-dish";
  return "vent";
}

function defaultDimForKind(k: RoofVision["penetrations"][number]["kind"]): number {
  if (k === "chimney") return 3;
  if (k === "skylight") return 3;
  return 0.75;
}

function mapVisionMaterial(m: RoofVision["currentMaterial"]): Material | null {
  if (m === "unknown") return null;
  if (m === "asphalt-3tab") return "asphalt-3tab";
  if (m === "asphalt-architectural") return "asphalt-architectural";
  if (m === "metal-standing-seam") return "metal-standing-seam";
  if (m === "tile-concrete") return "tile-concrete";
  if (m === "wood-shake") return "wood-shake";
  if (m === "flat-membrane") return "flat-membrane";
  return null;
}

// TODO(task-19): consumer should inject fetchers that avoid the HTTP self-call
// (call /api/vision route handler directly server-side).
async function defaultVisionFetcher(lat: number, lng: number): Promise<RoofVision | null> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/vision?lat=${lat}&lng=${lng}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

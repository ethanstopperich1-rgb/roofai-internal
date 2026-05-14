// lib/sources/solar-source.ts
import type {
  RoofData, Facet, RoofObject, Material,
} from "@/types/roof";
import type { SolarSummary, RoofVision } from "@/types/estimate";
import {
  classifyEdges, computeFlashing, computeTotals,
} from "@/lib/roof-engine";
import { getMemoizedVision, type VisionFetcher } from "@/lib/cache/vision-request";

type SolarFetcher = (lat: number, lng: number) => Promise<SolarSummary | null>;

/**
 * Tier C Solar source. Fans /api/solar and /api/vision in parallel.
 * Returns null when Solar has no coverage (404 or zero segments).
 * Vision failure is tolerated: objects[] becomes empty and material
 * stays null, but the source still succeeds because Solar's facet
 * data is independently valuable.
 */
export async function tierCSolarSource(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  requestId: string;
  /** Injected fetcher for testability. Defaults to the real /api/solar. */
  solarFetcher?: SolarFetcher;
  /** Injected fetcher for vision. Defaults to the real /api/vision. */
  visionFetcher?: VisionFetcher;
}): Promise<RoofData | null> {
  const solarFetcher = opts.solarFetcher ?? defaultSolarFetcher;
  const visionFetcher = opts.visionFetcher ?? defaultVisionFetcher;

  const [solar, vision] = await Promise.all([
    solarFetcher(opts.address.lat, opts.address.lng).catch((err) => {
      console.warn("[solar-source] solar fetch failed:", err);
      return null;
    }),
    getMemoizedVision({
      lat: opts.address.lat,
      lng: opts.address.lng,
      requestId: opts.requestId,
      fetcher: visionFetcher,
    }),
  ]);

  if (!solar || solar.segmentCount === 0) return null;

  const facets = solarToFacets(solar, vision);
  const edges = classifyEdges(facets, solar.dominantAzimuthDeg);
  const objects = visionPenetrationsToObjects(opts.address, vision);
  const flashing = computeFlashing(facets, edges, objects);
  const totals = computeTotals(facets, edges, objects);

  const confidence =
    solar.imageryQuality === "HIGH" ? 0.85 :
    solar.imageryQuality === "MEDIUM" ? 0.70 :
    solar.imageryQuality === "LOW" ? 0.55 : 0.50;

  return {
    address: opts.address,
    source: "tier-c-solar",
    refinements: [],
    confidence,
    imageryDate: solar.imageryDate,
    ageYearsEstimate: vision?.estimatedAgeYears ?? null,
    ageBucket: vision && vision.estimatedAge !== "unknown" ? vision.estimatedAge : null,
    facets, edges, objects, flashing, totals,
    diagnostics: { attempts: [], warnings: [], needsReview: [] },
  };
}

function solarToFacets(solar: SolarSummary, vision: RoofVision | null): Facet[] {
  const material: Material | null = vision ? mapVisionMaterial(vision.currentMaterial) : null;
  return solar.segments.map((seg, idx) => {
    const polygon = solar.segmentPolygonsLatLng[idx] ?? [];
    const pitchDeg = seg.pitchDegrees;
    const pitchRad = (pitchDeg * Math.PI) / 180;
    const az = seg.azimuthDegrees;
    const azRad = (az * Math.PI) / 180;
    // Normal vector from pitch + azimuth (z up)
    const normal = {
      x: Math.sin(pitchRad) * Math.sin(azRad),
      y: Math.sin(pitchRad) * Math.cos(azRad),
      z: Math.cos(pitchRad),
    };
    return {
      id: `facet-${idx}`,
      polygon, normal,
      pitchDegrees: pitchDeg,
      azimuthDeg: az,
      areaSqftSloped: seg.areaSqft,
      areaSqftFootprint: seg.groundAreaSqft,
      material,
      isLowSlope: pitchDeg < 18.43, // < 4/12
    };
  });
}

function visionPenetrationsToObjects(
  address: { lat: number; lng: number },
  vision: RoofVision | null,
): RoofObject[] {
  if (!vision) return [];
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

function mapPenetrationKind(k: RoofVision["penetrations"][number]["kind"]): RoofObject["kind"] {
  if (k === "vent") return "vent";
  if (k === "chimney") return "chimney";
  if (k === "skylight") return "skylight";
  if (k === "stack") return "stack";
  if (k === "satellite-dish") return "satellite-dish";
  return "vent"; // "other" -> treat as vent
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
// (call route handlers / engine functions directly server-side). The
// NEXT_PUBLIC_BASE_URL fallback to localhost is fine for the debug route
// + local dev but fragile in Vercel SSR where the container's loopback
// may not resolve.
async function defaultSolarFetcher(lat: number, lng: number): Promise<SolarSummary | null> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/solar?lat=${lat}&lng=${lng}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json() as SolarSummary;
  if (data.segmentCount === 0) return null;
  return data;
}

async function defaultVisionFetcher(lat: number, lng: number): Promise<RoofVision | null> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/vision?lat=${lat}&lng=${lng}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

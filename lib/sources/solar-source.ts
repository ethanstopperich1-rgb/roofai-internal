// lib/sources/solar-source.ts
import type {
  RoofData, Facet, Material,
} from "@/types/roof";
import type { SolarSummary, RoofVision } from "@/types/estimate";
import {
  classifyEdges, computeFlashing, computeTotals,
} from "@/lib/roof-engine";
import { getMemoizedVision, type VisionFetcher } from "@/lib/cache/vision-request";
import { mapVisionMaterial, visionPenetrationsToObjects } from "./vision-mappers";
import { fetchSolarRoofMask } from "@/lib/solar-mask";
import { resolveBaseUrl } from "@/lib/base-url";

type SolarFetcher = (lat: number, lng: number) => Promise<SolarSummary | null>;
type MaskFetcher = (opts: {
  lat: number;
  lng: number;
  apiKey: string;
}) => Promise<{ latLng: Array<{ lat: number; lng: number }> } | null>;

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
  /** Injected fetcher for the pixel-accurate Solar mask outline.
   *  Defaults to the real fetchSolarRoofMask. */
  maskFetcher?: MaskFetcher;
}): Promise<RoofData | null> {
  const solarFetcher = opts.solarFetcher ?? defaultSolarFetcher;
  const visionFetcher = opts.visionFetcher ?? defaultVisionFetcher;
  const maskFetcher = opts.maskFetcher ?? defaultMaskFetcher;
  // SOLAR_MASK_OUTLINE=0 disables the dataLayers mask fetch. Default ON
  // because the mask is strictly tighter than findClosest bboxes on every
  // L-shape / non-rectangular roof — see /api/solar-mask + lib/solar-mask
  // for the pipeline (binary mask GeoTIFF → Moore-neighbor trace →
  // Douglas-Peucker → orthogonalize → lat/lng project). Costs one extra
  // Solar API call (~$0.005) per estimate; latency budget ~1-2s in parallel.
  const maskEnabled = process.env.SOLAR_MASK_OUTLINE !== "0";

  const [solar, vision, maskPromise] = await Promise.all([
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
    maskEnabled
      ? maskFetcher({
          lat: opts.address.lat,
          lng: opts.address.lng,
          apiKey:
            process.env.GOOGLE_SERVER_KEY ??
            process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ??
            "",
        }).catch((err) => {
          console.warn("[solar-source] mask fetch failed:", err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  if (!solar || solar.segmentCount === 0) return null;

  if (solar && solar.segmentCount > 0 && !vision) {
    console.log("[telemetry] vision_failure_tolerated", {
      address: opts.address.formatted,
      lat: opts.address.lat,
      lng: opts.address.lng,
      reason: "vision returned null (api down, key missing, or polygon empty)",
    });
  }

  const facets = solarToFacets(solar, vision);
  const edges = classifyEdges(facets, solar.dominantAzimuthDeg);
  const objects = visionPenetrationsToObjects(opts.address, vision);
  const flashing = computeFlashing(facets, edges, objects);
  const totals = computeTotals(facets, edges, objects);

  const confidence =
    solar.imageryQuality === "HIGH" ? 0.85 :
    solar.imageryQuality === "MEDIUM" ? 0.70 :
    solar.imageryQuality === "LOW" ? 0.55 : 0.50;

  // Mask outline: pixel-accurate boundary from dataLayers (overrides the
  // facet-union outline used by MapView + Roof3DViewer when present).
  // null when mask fetch failed, returned no roof component, or was
  // disabled via SOLAR_MASK_OUTLINE=0 — consumers fall back to the facet
  // union, matching prior behavior.
  const outlinePolygon = maskPromise?.latLng ?? null;
  if (outlinePolygon) {
    console.log("[telemetry] solar_mask_outline_used", {
      address: opts.address.formatted,
      vertices: outlinePolygon.length,
      imageryQuality: solar.imageryQuality,
    });
  }

  return {
    address: opts.address,
    source: "tier-c-solar",
    refinements: [],
    confidence,
    imageryDate: solar.imageryDate,
    ageYearsEstimate: vision?.estimatedAgeYears ?? null,
    ageBucket: vision && vision.estimatedAge !== "unknown" ? vision.estimatedAge : null,
    facets, edges, objects, flashing, totals,
    outlinePolygon,
    diagnostics: { attempts: [], warnings: [], needsReview: [] },
  };
}

async function defaultMaskFetcher(opts: {
  lat: number;
  lng: number;
  apiKey: string;
}): Promise<{ latLng: Array<{ lat: number; lng: number }> } | null> {
  if (!opts.apiKey) return null;
  const result = await fetchSolarRoofMask(opts);
  return result ? { latLng: result.latLng } : null;
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

// TODO(task-19): consumer should inject fetchers that avoid the HTTP self-call
// (call route handlers / engine functions directly server-side).
// resolveBaseUrl() handles the Vercel-vs-local resolution so self-calls
// actually reach the API in production.
async function defaultSolarFetcher(lat: number, lng: number): Promise<SolarSummary | null> {
  const res = await fetch(`${resolveBaseUrl()}/api/solar?lat=${lat}&lng=${lng}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json() as SolarSummary;
  if (data.segmentCount === 0) return null;
  return data;
}

async function defaultVisionFetcher(lat: number, lng: number): Promise<RoofVision | null> {
  const res = await fetch(`${resolveBaseUrl()}/api/vision?lat=${lat}&lng=${lng}`, {
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

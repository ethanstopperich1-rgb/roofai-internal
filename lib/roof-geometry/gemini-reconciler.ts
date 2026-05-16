/**
 * Gemini-vs-Solar reconciler. Validates a Gemini outline polygon against
 * Solar API's authoritative `wholeRoofStats` area + `center` building
 * location, then either accepts the polygon as-is or applies one of three
 * recovery paths.
 *
 * This is the keystone of the V2 hybrid: Gemini is the PRIMARY tracer
 * because it produces rich semantic data (per-facet polygons, line
 * detection, object identification) that Solar can't, but Gemini's
 * outline reliability is uneven on partially-shadowed FL residential
 * properties. The reconciler catches Gemini's worst failure modes
 * (wrong-building, severe under-trace, severe over-trace) using Solar
 * data we're already fetching — no new API calls, no new infrastructure.
 *
 * Thresholds derived from the 7-run Jupiter experiment (2026-05-16):
 *   - areaRatio < 0.7  → under-traced → expand_to_solar_bbox
 *   - areaRatio > 1.5  → over-traced  → clip_to_solar_bbox
 *   - centroid > 8 m   → wrong building → reject_use_solar
 *
 * Returns the FINAL outline polygon the caller should use, so the
 * orchestrator doesn't have to branch — reconciler always emits a
 * usable polygon (or null when even Solar is unusable).
 */

import type { LatLng } from "./coordinates";
import { haversineMeters } from "./coordinates";
import { polygonCentroidLatLng, polygonFootprintSqftLatLng } from "./polygons";
import { polygonIntersection } from "@/lib/polygon";

export type ReconcileFallback =
  | "expand_to_solar_bbox"
  | "clip_to_solar_bbox"
  | "reject_use_solar";

export type ReconcileOutlineSource =
  | "gemini" // accepted as-is
  | "gemini-clipped" // accepted after clipping to Solar bbox
  | "solar-bbox"; // Gemini rejected; using Solar's bbox-derived polygon

export interface ReconciliationInput {
  /** Gemini's outline polygon in lat/lng (after pixel→latlng conversion). */
  geminiOutline: LatLng[];
  /** Solar API's `data.center` — the photogrammetric building centroid. */
  solarBuildingCenter: { lat: number; lng: number };
  /** Solar API's `solarPotential.wholeRoofStats.areaMeters2` × 10.7639.
   *  Source of truth for the building's photogrammetric footprint area. */
  solarWholeRoofAreaSqft: number;
  /** Solar API's `boundingBox` — SW + NE corners of the building. Used
   *  to build the fallback polygon when Gemini is rejected and to clip
   *  Gemini's polygon when it over-traces. */
  solarBoundingBox: {
    sw: { lat: number; lng: number };
    ne: { lat: number; lng: number };
  };
}

export interface ReconciliationResult {
  /** Whether Gemini's polygon was accepted as-is (no fallback fired). */
  acceptedAsIs: boolean;
  /** Human-readable explanation surfaced in API diagnostics. */
  reason: string;
  /** Which fallback ran (if any). null when accepted. */
  fallback: ReconcileFallback | null;
  /** Which polygon the orchestrator should use. ALWAYS populated. */
  finalOutline: LatLng[];
  /** Provenance of `finalOutline` for the response payload. */
  outlineSource: ReconcileOutlineSource;
  /** Diagnostics for telemetry / accept-rate measurement. */
  diagnostics: {
    geminiAreaSqft: number;
    solarAreaSqft: number;
    areaRatio: number;
    centroidDistanceM: number;
  };
}

/** Convert Solar's bounding box (lat/lng corners) to a 4-vertex CCW
 *  polygon. Used as the fallback outline when Gemini is rejected
 *  outright, and as the clip target when Gemini over-traces. */
export function solarBboxToPolygon(
  bbox: ReconciliationInput["solarBoundingBox"],
): LatLng[] {
  return [
    { lat: bbox.sw.lat, lng: bbox.sw.lng }, // SW
    { lat: bbox.sw.lat, lng: bbox.ne.lng }, // SE
    { lat: bbox.ne.lat, lng: bbox.ne.lng }, // NE
    { lat: bbox.ne.lat, lng: bbox.sw.lng }, // NW
  ];
}

const AREA_RATIO_FLOOR = 0.7;
const AREA_RATIO_CEILING = 1.5;
const CENTROID_TOLERANCE_M = 8;

/**
 * Reconcile a Gemini outline against Solar's ground-truth data. Always
 * returns a usable polygon and clear diagnostics.
 */
export function reconcileGeminiAgainstSolar(
  input: ReconciliationInput,
): ReconciliationResult {
  const { geminiOutline, solarBuildingCenter, solarWholeRoofAreaSqft, solarBoundingBox } = input;

  const geminiAreaSqft = polygonFootprintSqftLatLng(geminiOutline);
  const solarAreaSqft = solarWholeRoofAreaSqft;
  const geminiCentroid = polygonCentroidLatLng(geminiOutline);
  const centroidDistanceM = haversineMeters(geminiCentroid, solarBuildingCenter);
  const areaRatio = solarAreaSqft > 0 ? geminiAreaSqft / solarAreaSqft : 0;

  const diagnostics = {
    geminiAreaSqft: Math.round(geminiAreaSqft),
    solarAreaSqft: Math.round(solarAreaSqft),
    areaRatio: Number(areaRatio.toFixed(3)),
    centroidDistanceM: Number(centroidDistanceM.toFixed(2)),
  };

  // ─── Reject paths (centroid first — most decisive) ──────────────────
  if (centroidDistanceM > CENTROID_TOLERANCE_M) {
    return {
      acceptedAsIs: false,
      reason: `Gemini centroid ${centroidDistanceM.toFixed(1)} m from Solar building center (>${CENTROID_TOLERANCE_M} m). Wrong building — using Solar bbox.`,
      fallback: "reject_use_solar",
      finalOutline: solarBboxToPolygon(solarBoundingBox),
      outlineSource: "solar-bbox",
      diagnostics,
    };
  }

  if (areaRatio < AREA_RATIO_FLOOR) {
    return {
      acceptedAsIs: false,
      reason: `Gemini under-traced (${(areaRatio * 100).toFixed(0)}% of Solar area). Expanding to Solar bbox.`,
      fallback: "expand_to_solar_bbox",
      finalOutline: solarBboxToPolygon(solarBoundingBox),
      outlineSource: "solar-bbox",
      diagnostics,
    };
  }

  if (areaRatio > AREA_RATIO_CEILING) {
    // Over-trace: clip to Solar bbox. polygonIntersection in lib/polygon
    // already takes LatLng[] arrays — no projection adapter needed.
    let clippedLatLng: LatLng[] = solarBboxToPolygon(solarBoundingBox);
    try {
      const clipped = polygonIntersection(
        geminiOutline,
        solarBboxToPolygon(solarBoundingBox),
      );
      if (clipped && clipped.length >= 3) {
        clippedLatLng = clipped;
      }
    } catch {
      // Intersection failure (degenerate geometry) — fall back to raw
      // Solar bbox. The diagnostics still record the over-trace ratio.
    }

    return {
      acceptedAsIs: false,
      reason: `Gemini over-traced (${(areaRatio * 100).toFixed(0)}% of Solar area). Clipped to Solar bbox.`,
      fallback: "clip_to_solar_bbox",
      finalOutline: clippedLatLng,
      outlineSource: "gemini-clipped",
      diagnostics,
    };
  }

  // ─── Accept path ────────────────────────────────────────────────────
  return {
    acceptedAsIs: true,
    reason: `Gemini outline reconciled — ${(areaRatio * 100).toFixed(0)}% area match, ${centroidDistanceM.toFixed(1)} m centroid offset.`,
    fallback: null,
    finalOutline: geminiOutline,
    outlineSource: "gemini",
    diagnostics,
  };
}

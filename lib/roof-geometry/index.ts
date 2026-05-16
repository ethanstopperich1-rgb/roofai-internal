/**
 * lib/roof-geometry — pure-math foundation for the V2 vision pipeline.
 *
 * Inputs: pixel coordinates from any vision model (Gemini, SAM3, etc.)
 * Outputs: real-world measurements (sqft, linear feet, pitch buckets)
 *
 * Zero dependencies on the rest of the codebase. No API calls. No
 * mutable state. Deterministic geometry — given the same vision output,
 * always returns the same measurements.
 *
 * One-call entrypoint: `processVisionOutput()`. Granular helpers are
 * re-exported for tests and edge cases.
 */

export { buildTileMetadata, tileBounds } from "./tile-metadata";
export type { TileMetadata, TileBounds } from "./tile-metadata";

export {
  pixelToLatLng,
  latLngToPixel,
  pixelPolygonToLatLng,
  haversineMeters,
} from "./coordinates";
export type { LatLng, PixelPoint } from "./coordinates";

export {
  pixelPolygonArea,
  pixelPolygonPerimeter,
  pixelPolygonCentroid,
  pixelPolygonFootprintSqft,
  polygonFootprintSqftLatLng,
  polygonSurfaceAreaSqft,
  polygonCentroidLatLng,
  pointInPolygon,
  slopeMultiplier,
} from "./polygons";

export {
  pixelSegmentLengthFt,
  latLngSegmentLengthFt,
  totalSegmentLengthFt,
} from "./polylines";
export type { PixelSegment, LatLngSegment } from "./polylines";

export {
  degreesToRise,
  riseToDegrees,
  degreesToOnTwelve,
  bucketByPitch,
  predominantPitchOnTwelve,
} from "./pitch";
export type { PitchOnTwelve } from "./pitch";

export {
  deriveLinearFeatures,
  matchPlanesByProximity,
} from "./plane-adjacency";
export type { LinearFeatureKind, RoofPlane, DerivedLinearFeature } from "./plane-adjacency";

export {
  reconcileGeminiAgainstSolar,
  solarBboxToPolygon,
} from "./gemini-reconciler";
export type {
  ReconciliationInput,
  ReconciliationResult,
  ReconcileFallback,
  ReconcileOutlineSource,
} from "./gemini-reconciler";

import type { LatLng, PixelPoint } from "./coordinates";
import type { LinearFeatureKind } from "./plane-adjacency";
import type { TileMetadata } from "./tile-metadata";
import { pixelToLatLng, pixelPolygonToLatLng } from "./coordinates";
import {
  pixelPolygonFootprintSqft,
  polygonFootprintSqftLatLng,
  polygonSurfaceAreaSqft,
  polygonCentroidLatLng,
  slopeMultiplier,
} from "./polygons";
import { latLngSegmentLengthFt } from "./polylines";
import {
  degreesToOnTwelve,
  predominantPitchOnTwelve,
} from "./pitch";

// ─── Vision output contract (Gemini structured-output schema) ────────

export type ConfidenceTier = "high" | "medium" | "low";

export interface VisionRoofFacet {
  letter: string;
  polygonPx: PixelPoint[];
  /** Compass orientation hint from Gemini, used only when no Solar
   *  match is found. N/NE/E/.../NW/flat. */
  orientation: string;
  /** Per-facet confidence from Gemini. Lets downstream consumers
   *  filter low-confidence detections (e.g. show only `high` + `medium`
   *  facets on the customer-facing breakdown table). */
  confidence: ConfidenceTier;
}

/**
 * Raw line segment from Gemini — pre-classification. The math layer
 * classifies these into ridge/hip/valley/rake/eave using Solar's
 * authoritative pitch + azimuth per adjacent plane.
 */
export interface VisionRoofLine {
  startPx: PixelPoint;
  endPx: PixelPoint;
  /** true = roof's outer edge (eave or rake); false = interior line
   *  between two planes (ridge, hip, or valley). */
  isPerimeter: boolean;
}

export type VisionRoofObjectKind =
  | "vent"
  | "chimney"
  | "hvac_unit"
  | "skylight"
  | "plumbing_boot"
  | "satellite_dish"
  | "solar_panel";

export interface VisionRoofObject {
  kind: VisionRoofObjectKind;
  centerPx: PixelPoint;
  bboxPx: { x: number; y: number; width: number; height: number };
  confidence: ConfidenceTier;
}

export interface VisionRoofOutput {
  outlinePx: PixelPoint[];
  facets: VisionRoofFacet[];
  /** Renamed from `linearFeatures` 2026-05-16: Gemini returns raw
   *  line segments now; classification is downstream. */
  roofLines: VisionRoofLine[];
  objects: VisionRoofObject[];
}

// ─── Solar plane match (optional enrichment) ────────────────────────

export interface SolarPlaneMatch {
  /** Centroid lat/lng of the Solar segment polygon. Used to spatially
   *  match Gemini's facets to Solar's plane decomposition. */
  centerLat: number;
  centerLng: number;
  pitchDegrees: number;
  azimuthDeg: number;
  /** Solar's reported sloped area for this plane (sqft). Used to
   *  cross-check / replace our derived per-facet area when Solar's
   *  photogrammetry is more accurate. */
  solarAreaSqft?: number;
}

// ─── Processed output (what the orchestrator returns) ───────────────

export interface MeasuredFacet {
  letter: string;
  polygon: LatLng[];
  centroid: LatLng;
  footprintSqft: number;
  sloppedSqft: number;
  pitchDegrees: number;
  pitchOnTwelve: ReturnType<typeof degreesToOnTwelve>;
  azimuthDeg: number;
  /** Where this facet's pitch came from. */
  pitchSource: "solar-match" | "gemini-orientation" | "default-flat";
  /** Gemini's self-reported confidence in this facet identification. */
  confidence: ConfidenceTier;
}

export interface MeasuredLinearFeature {
  kind: LinearFeatureKind;
  start: LatLng;
  end: LatLng;
  lengthFt: number;
}

export interface MeasuredObject {
  kind: VisionRoofObjectKind;
  center: LatLng;
  /** Approximate bounding-box width × height in feet (from tile GSD). */
  widthFt: number;
  heightFt: number;
  confidence: ConfidenceTier;
}

export interface RoofMeasurements {
  outlinePolygon: LatLng[];
  outlineFootprintSqft: number;
  /** Sum of per-facet sloped areas. */
  totalSlopedSqft: number;
  /** Sum of per-facet footprint areas (top-down projection). */
  totalFootprintSqft: number;
  facets: MeasuredFacet[];
  linearFeatures: MeasuredLinearFeature[];
  /** Totals by kind, in feet, slope-corrected per the abutting facet's
   *  pitch when the feature is sloped (hip/rake/valley). */
  linearFeatureTotalsFt: Record<LinearFeatureKind, number>;
  objects: MeasuredObject[];
  /** EagleView "Predominant Pitch" — bucket with the most sloped sqft. */
  predominantPitchOnTwelve: ReturnType<typeof degreesToOnTwelve>;
  /** Average pitch in degrees, weighted by sloped area. */
  averagePitchDegrees: number;
  /** Confidence flag — true when ≥80% of facets had a Solar match. */
  solarMatchedFraction: number;
}

const orientationToAzDeg: Record<string, number> = {
  N: 0, NE: 45, E: 90, SE: 135,
  S: 180, SW: 225, W: 270, NW: 315,
  flat: 0,
};

/**
 * Convert a Gemini "orientation" hint (NE / S / etc.) to azimuth deg.
 * Used as a fallback when a facet has no spatial Solar match.
 */
function orientationToAzimuth(o: string): number {
  return orientationToAzDeg[o.toUpperCase()] ?? 0;
}

/**
 * One-call orchestration: vision output + tile metadata + optional
 * Solar matches → unified RoofMeasurements.
 *
 * Solar enrichment is optional. When `solarPlanes` is empty, pitch
 * defaults from Gemini's orientation hint (flat = 0° pitch; cardinal
 * orientations get a conservative 22.6° = 5/12 default). When Solar
 * matches are available, each facet's pitch/azimuth is replaced with
 * Solar's authoritative measurement.
 */
export function processVisionOutput(opts: {
  vision: VisionRoofOutput;
  tile: TileMetadata;
  solarPlanes?: SolarPlaneMatch[];
}): RoofMeasurements {
  const { vision, tile, solarPlanes = [] } = opts;

  // Outline polygon → lat/lng + footprint sqft.
  const outlinePolygon = pixelPolygonToLatLng(vision.outlinePx, tile);
  const outlineFootprintSqft =
    vision.outlinePx.length >= 3
      ? pixelPolygonFootprintSqft(vision.outlinePx, tile.metersPerPixel)
      : 0;

  // Process each facet — convert polygon, attach pitch from best Solar
  // match (centroid within 5m), fall back to Gemini orientation hint.
  const facets: MeasuredFacet[] = vision.facets.map((vf) => {
    const polygon = pixelPolygonToLatLng(vf.polygonPx, tile);
    const centroid = polygonCentroidLatLng(polygon);
    let pitchDegrees: number;
    let azimuthDeg: number;
    let pitchSource: MeasuredFacet["pitchSource"];

    // Match radius: Solar bbox centroids and Gemini polygon centroids
    // can be 10–15m apart on complex/L-shaped roofs because Solar's
    // bbox shifts toward the larger sub-rectangle of the segment while
    // Gemini's centroid tracks the polygon shape exactly. 12m radius
    // captures these without admitting neighbor-building matches.
    const match = solarPlanes
      .map((s) => {
        const sc: LatLng = { lat: s.centerLat, lng: s.centerLng };
        return { s, distM: distanceM(centroid, sc) };
      })
      .filter((m) => m.distM <= 12)
      .sort((a, b) => a.distM - b.distM)[0]?.s;

    if (match) {
      pitchDegrees = match.pitchDegrees;
      azimuthDeg = match.azimuthDeg;
      pitchSource = "solar-match";
    } else if (vf.orientation.toLowerCase() === "flat") {
      pitchDegrees = 0;
      azimuthDeg = 0;
      pitchSource = "default-flat";
    } else {
      // Conservative 5/12 default for unmatched sloped facets — common
      // FL residential. Better than 0° (under-sizing material) and
      // less aggressive than 9/12 (over-sizing).
      pitchDegrees = 22.6;
      azimuthDeg = orientationToAzimuth(vf.orientation);
      pitchSource = "gemini-orientation";
    }

    const footprintSqft = polygonFootprintSqftLatLng(polygon);
    const sloppedSqft = polygonSurfaceAreaSqft(polygon, pitchDegrees);
    return {
      letter: vf.letter,
      polygon,
      centroid,
      footprintSqft,
      sloppedSqft,
      pitchDegrees,
      pitchOnTwelve: degreesToOnTwelve(pitchDegrees),
      azimuthDeg,
      pitchSource,
      confidence: vf.confidence,
    };
  });

  // ─── Classify Gemini's roof_lines using Solar/facet plane data ──────
  //
  // Gemini returns raw line segments + `isPerimeter` only. We classify
  // each line geometrically using adjacent plane data (Solar match
  // preferred; Gemini orientation hint as fallback). This is the right
  // division of labor: Gemini sees, math classifies.
  //
  // Rules:
  //   - PERIMETER lines (outer edge of roof, no facet on the other side):
  //       * If line is HORIZONTAL relative to the adjacent facet's
  //         downslope direction → EAVE
  //       * Otherwise (line rises with the slope) → RAKE
  //   - INTERIOR lines (shared boundary between two planes):
  //       * Both planes' azimuths roughly opposite (>150° diff) AND
  //         line is horizontal → RIDGE
  //       * Both planes' azimuths roughly opposite AND line is sloped
  //         → HIP
  //       * Both planes' azimuths similar (water drains together) →
  //         VALLEY
  //
  // Find adjacent facet(s) per line by nearest-centroid match; for
  // interior lines, the second-nearest facet is the other side.
  const totalSloped = facets.reduce((s, f) => s + f.sloppedSqft, 0);
  const avgPitchDeg =
    totalSloped > 0
      ? facets.reduce((s, f) => s + f.pitchDegrees * f.sloppedSqft, 0) / totalSloped
      : 0;

  function angleDiff(a: number, b: number): number {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }
  function edgeAzimuthDeg(a: LatLng, b: LatLng): number {
    const dLat = b.lat - a.lat;
    const dLng =
      (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
    const az = (Math.atan2(dLng, dLat) * 180) / Math.PI;
    return (az + 360) % 360;
  }
  function lineMidpoint(a: LatLng, b: LatLng): LatLng {
    return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
  }
  function nearestFacets(p: LatLng, n: number): MeasuredFacet[] {
    return facets
      .map((f) => ({ f, d: distanceM(p, f.centroid) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map((x) => x.f);
  }
  function isHorizontalLine(
    lineAz: number,
    planeAz: number,
    planePitchDeg: number,
  ): boolean {
    // An edge is "horizontal" (constant elevation along its length)
    // when its compass direction is perpendicular to the plane's
    // downslope direction. ±25° tolerance for irregular facets.
    return (
      angleDiff(angleDiff(lineAz, planeAz), 90) < 25 && planePitchDeg > 5
    );
  }

  const linearFeatures: MeasuredLinearFeature[] = vision.roofLines.map(
    (rl) => {
      const start = pixelToLatLng(rl.startPx, tile);
      const end = pixelToLatLng(rl.endPx, tile);
      const mid = lineMidpoint(start, end);
      const lineAz = edgeAzimuthDeg(start, end);

      let kind: LinearFeatureKind;
      if (rl.isPerimeter) {
        const [f1] = nearestFacets(mid, 1);
        if (f1 && isHorizontalLine(lineAz, f1.azimuthDeg, f1.pitchDegrees)) {
          kind = "eave";
        } else {
          kind = "rake";
        }
      } else {
        // Interior line — find the two flanking facets.
        const [f1, f2] = nearestFacets(mid, 2);
        if (f1 && f2) {
          const azDiff = angleDiff(f1.azimuthDeg, f2.azimuthDeg);
          if (azDiff > 150) {
            // Opposite-facing planes — ridge or hip.
            const maxPitch = Math.max(f1.pitchDegrees, f2.pitchDegrees);
            kind = isHorizontalLine(lineAz, f1.azimuthDeg, maxPitch)
              ? "ridge"
              : "hip";
          } else {
            // Similar-facing planes that share an edge = valley.
            kind = "valley";
          }
        } else {
          // Couldn't find two adjacent facets — assume hip (most common
          // interior line on residential roofs).
          kind = "hip";
        }
      }

      const useSlopeCorrection =
        kind === "hip" || kind === "rake" || kind === "valley";
      const lengthFt = latLngSegmentLengthFt(
        { start, end },
        useSlopeCorrection ? avgPitchDeg : null,
      );
      return { kind, start, end, lengthFt };
    },
  );

  const linearFeatureTotalsFt: Record<LinearFeatureKind, number> = {
    ridge: 0,
    hip: 0,
    valley: 0,
    rake: 0,
    eave: 0,
  };
  for (const lf of linearFeatures) {
    linearFeatureTotalsFt[lf.kind] += lf.lengthFt;
  }

  // Objects — convert center + bbox to lat/lng + feet dimensions.
  const M_TO_FT = 3.28084;
  const objects: MeasuredObject[] = vision.objects.map((o) => {
    const center = pixelToLatLng(o.centerPx, tile);
    const widthFt = o.bboxPx.width * tile.metersPerPixel * M_TO_FT;
    const heightFt = o.bboxPx.height * tile.metersPerPixel * M_TO_FT;
    return { kind: o.kind, center, widthFt, heightFt, confidence: o.confidence };
  });

  const matched = facets.filter((f) => f.pitchSource === "solar-match").length;
  const solarMatchedFraction = facets.length > 0 ? matched / facets.length : 0;

  // Headline area math — outline-derived, NOT facet-summed.
  //
  // Why: Gemini's per-facet polygons sometimes overlap or extend past
  // the outline (the prompt now enforces a partition constraint, but
  // the model isn't perfectly compliant). Summing per-facet footprints
  // double-counts overlap regions and inflates the total. The outline
  // itself is a single tight polygon — its shoelace area IS the
  // building footprint by construction.
  //
  // For the SLOPED total we still need per-facet pitch info (a 4/12
  // facet contributes less surface than an 8/12 facet of the same
  // footprint). Use a footprint-weighted average slope multiplier
  // across all facets so steep facets get appropriate weight without
  // requiring the facets to actually tile the outline.
  const totalFootprintSqftFromOutline = outlineFootprintSqft;
  const facetFootprintSum = facets.reduce((s, f) => s + f.footprintSqft, 0);
  const weightedSlopeMultiplier =
    facetFootprintSum > 0
      ? facets.reduce((s, f) => {
          const weight = f.footprintSqft / facetFootprintSum;
          return s + weight * (1 / Math.cos((f.pitchDegrees * Math.PI) / 180));
        }, 0)
      : 1;
  const totalSlopedSqftFromOutline =
    totalFootprintSqftFromOutline * weightedSlopeMultiplier;

  return {
    outlinePolygon,
    outlineFootprintSqft,
    totalSlopedSqft: totalSlopedSqftFromOutline,
    totalFootprintSqft: totalFootprintSqftFromOutline,
    facets,
    linearFeatures,
    linearFeatureTotalsFt,
    objects,
    predominantPitchOnTwelve: predominantPitchOnTwelve(
      facets.map((f) => ({
        pitchDegrees: f.pitchDegrees,
        areaSqftSloped: f.sloppedSqft,
      })),
    ),
    averagePitchDegrees: avgPitchDeg,
    solarMatchedFraction,
  };
}

function distanceM(a: LatLng, b: LatLng): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Re-export slope helper for direct use
export { slopeMultiplier as _slopeMultiplier };

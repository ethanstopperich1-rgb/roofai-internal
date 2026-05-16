/**
 * Derive ridges / hips / valleys / rakes / eaves from a set of roof
 * planes (each with pitch, azimuth, and a polygon).
 *
 * Two-plane adjacency rules (EagleView semantics):
 *   - Two planes meet along a shared edge:
 *       • Both pitches > 0 AND azimuths roughly OPPOSITE (180° ± 30°)
 *         and the edge is HORIZONTAL  → RIDGE
 *       • Both pitches > 0 AND azimuths roughly OPPOSITE
 *         and the edge is SLOPED      → HIP    (running up to a peak)
 *       • Both pitches > 0 AND azimuths roughly SAME
 *         and the edge is SLOPED      → VALLEY (running down)
 *   - One plane only (open edge):
 *       • Edge is HORIZONTAL at low elevation → EAVE
 *       • Edge is SLOPED (gable end)          → RAKE
 *
 * Gemini's linear-features output already attempts this classification.
 * This module exists for the case where Gemini omits or misclassifies a
 * feature — it can be re-derived from the facet polygons + Solar
 * pitches. Treat it as a verification + fallback layer, not the primary
 * source.
 */

import type { LatLng } from "./coordinates";
import { haversineMeters } from "./coordinates";
import { polygonCentroidLatLng } from "./polygons";

export type LinearFeatureKind = "ridge" | "hip" | "valley" | "rake" | "eave";

export interface RoofPlane {
  id: string;
  polygon: LatLng[];
  /** Pitch in degrees. 0 = flat, 90 = vertical (illegal in practice). */
  pitchDegrees: number;
  /** Compass azimuth of the plane's downslope direction, degrees from
   *  north. 0 = north-facing, 90 = east-facing, etc. */
  azimuthDeg: number;
}

export interface DerivedLinearFeature {
  kind: LinearFeatureKind;
  start: LatLng;
  end: LatLng;
  /** Plane IDs that contribute to this edge. 1 for open edges (rake /
   *  eave), 2 for shared edges (ridge / hip / valley). */
  planeIds: string[];
  /** Larger of the two abutting pitches; used for slope-corrected LF. */
  pitchDegrees: number;
}

/**
 * Two segments are coincident if both endpoints match within `eps`
 * meters in either orientation. Roof facet polygons share whole edges,
 * so coincidence is exact in clean data; `eps` covers floating-point
 * noise and pixel-to-lat-lng rounding.
 */
function segmentsCoincident(
  a1: LatLng, a2: LatLng,
  b1: LatLng, b2: LatLng,
  epsM = 0.5,
): boolean {
  const same = haversineMeters(a1, b1) < epsM && haversineMeters(a2, b2) < epsM;
  const reversed = haversineMeters(a1, b2) < epsM && haversineMeters(a2, b1) < epsM;
  return same || reversed;
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function isHorizontalSlope(
  pitchDeg: number,
  /** Edge azimuth from start→end, degrees. */
  edgeAzDeg: number,
  planeAzDeg: number,
): boolean {
  // An edge is "horizontal" (= constant elevation along its length)
  // when its azimuth is perpendicular to the plane's downslope
  // direction. ±25° tolerance for irregular facets.
  return angleDiff(angleDiff(edgeAzDeg, planeAzDeg), 90) < 25 && pitchDeg > 5;
}

function edgeAzimuthDeg(a: LatLng, b: LatLng): number {
  const dLat = b.lat - a.lat;
  const dLng =
    (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const az = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  return (az + 360) % 360;
}

/**
 * Walk every pair of plane edges. For each shared edge, classify as
 * ridge/hip/valley using azimuth comparison. For each unshared edge,
 * classify as rake/eave using the edge's orientation vs its plane's
 * downslope direction.
 */
export function deriveLinearFeatures(
  planes: RoofPlane[],
): DerivedLinearFeature[] {
  const out: DerivedLinearFeature[] = [];
  const claimedSharedEdges = new Set<string>();

  // Edge enumeration helper: (plane index, edge index) → start/end + meta
  type PlaneEdge = {
    planeIdx: number;
    edgeIdx: number;
    start: LatLng;
    end: LatLng;
  };
  const allEdges: PlaneEdge[] = [];
  for (let pi = 0; pi < planes.length; pi++) {
    const poly = planes[pi].polygon;
    for (let ei = 0; ei < poly.length; ei++) {
      const start = poly[ei];
      const end = poly[(ei + 1) % poly.length];
      allEdges.push({ planeIdx: pi, edgeIdx: ei, start, end });
    }
  }

  // 1. Shared edges (ridge / hip / valley).
  for (let i = 0; i < allEdges.length; i++) {
    for (let j = i + 1; j < allEdges.length; j++) {
      const a = allEdges[i];
      const b = allEdges[j];
      if (a.planeIdx === b.planeIdx) continue;
      if (!segmentsCoincident(a.start, a.end, b.start, b.end)) continue;
      const pa = planes[a.planeIdx];
      const pb = planes[b.planeIdx];
      const azDiff = angleDiff(pa.azimuthDeg, pb.azimuthDeg);
      const edgeAz = edgeAzimuthDeg(a.start, a.end);
      const maxPitch = Math.max(pa.pitchDegrees, pb.pitchDegrees);

      let kind: LinearFeatureKind;
      if (azDiff > 150) {
        // Opposite-facing planes — ridge or hip.
        kind = isHorizontalSlope(maxPitch, edgeAz, pa.azimuthDeg)
          ? "ridge"
          : "hip";
      } else {
        // Similar-facing planes that share an edge = valley (water
        // drainage channel between two roof sections).
        kind = "valley";
      }
      const key = [a.planeIdx, a.edgeIdx].sort().join("-");
      const key2 = [b.planeIdx, b.edgeIdx].sort().join("-");
      claimedSharedEdges.add(key);
      claimedSharedEdges.add(key2);
      out.push({
        kind,
        start: a.start,
        end: a.end,
        planeIds: [pa.id, pb.id],
        pitchDegrees: maxPitch,
      });
    }
  }

  // 2. Open edges (rake / eave) — every edge not yet claimed.
  for (const e of allEdges) {
    const key = [e.planeIdx, e.edgeIdx].sort().join("-");
    if (claimedSharedEdges.has(key)) continue;
    const plane = planes[e.planeIdx];
    const edgeAz = edgeAzimuthDeg(e.start, e.end);
    const kind: LinearFeatureKind = isHorizontalSlope(
      plane.pitchDegrees,
      edgeAz,
      plane.azimuthDeg,
    )
      ? "eave"
      : "rake";
    out.push({
      kind,
      start: e.start,
      end: e.end,
      planeIds: [plane.id],
      pitchDegrees: plane.pitchDegrees,
    });
  }

  return out;
}

/** Cheap centroid match helper — feed Gemini facet centroids + Solar
 *  plane centroids, return the matched pairs within `radiusM` meters.
 *  Used by the orchestrator to enrich Gemini facets with Solar's
 *  authoritative pitch + azimuth. */
export function matchPlanesByProximity<
  G extends { id: string; polygon: LatLng[] },
  S extends { id: string; polygon: LatLng[]; pitchDegrees: number; azimuthDeg: number },
>(
  geminiFacets: G[],
  solarPlanes: S[],
  radiusM = 5,
): Array<{ gemini: G; solar: S | null }> {
  const out: Array<{ gemini: G; solar: S | null }> = [];
  for (const g of geminiFacets) {
    const gc = polygonCentroidLatLng(g.polygon);
    let best: S | null = null;
    let bestD = Infinity;
    for (const s of solarPlanes) {
      const sc = polygonCentroidLatLng(s.polygon);
      const d = haversineMeters(gc, sc);
      if (d < bestD && d <= radiusM) {
        bestD = d;
        best = s;
      }
    }
    out.push({ gemini: g, solar: best });
  }
  return out;
}

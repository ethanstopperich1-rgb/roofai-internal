/**
 * Solar facet polygon synthesis from `findClosest` bboxes.
 *
 * Solar API returns one axis-aligned `boundingBox` per facet (lat/lng SW
 * + NE corners). On any house that isn't built facing exactly north,
 * drawing those bboxes as polygons looks visibly wrong — they're
 * cardinal-direction rectangles around roof faces that may run at any
 * angle. The route was discarding them entirely as a result, leaving
 * Solar's per-facet output unused except for area / pitch metadata.
 *
 * Trick: every facet has its own `azimuthDegrees`, and the building's
 * dominant ridge axis (`dominantAzimuthDeg`) tells us how much the
 * building is rotated from cardinal directions. Rotate each axis-aligned
 * bbox by that angle around its own centre, and the rectangle aligns
 * with the actual roof face. Still a rectangle (won't match L-shapes or
 * triangular hip facets), but structurally correct enough that summing
 * facets covers the building footprint and the per-facet rectangles
 * sit roughly on their own roof faces.
 *
 * This is intentionally cheaper than the alternative — `dataLayers:get`
 * (DSM raster, paid + slower) — and keeps Solar facets useful as a
 * priority-chain candidate when Roboflow gets demoted by the coverage
 * gate.
 */

import type { SolarSegment } from "@/types/estimate";

const M_PER_DEG_LAT = 111_320;

/** Rotate a single facet's axis-aligned bbox into a building-axis-aligned
 *  rectangle. Returns the 4 vertices in lat/lng (CCW from SW). */
export function rotateFacetBbox(
  segment: SolarSegment,
  buildingRotationDeg: number,
): Array<{ lat: number; lng: number }> | null {
  const { swLat, swLng, neLat, neLng } = segment.bboxLatLng;
  if (!isFinite(swLat) || !isFinite(swLng) || !isFinite(neLat) || !isFinite(neLng)) {
    return null;
  }
  if (swLat === 0 && swLng === 0 && neLat === 0 && neLng === 0) {
    // Degenerate placeholder (some facets come back without bbox)
    return null;
  }
  const cLat = (swLat + neLat) / 2;
  const cLng = (swLng + neLng) / 2;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const halfW = ((neLng - swLng) * M_PER_DEG_LAT * cosLat) / 2;
  const halfH = ((neLat - swLat) * M_PER_DEG_LAT) / 2;
  if (halfW <= 0 || halfH <= 0) return null;

  // Building rotation in radians. dominantAzimuthDeg is in [0, 90)
  // (mod-90 doubled-angle convention); use it directly as the rotation
  // applied to the cardinal-aligned bbox.
  const theta = (buildingRotationDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  // Local-meter corners around (0,0), CCW from SW:
  const corners: Array<[number, number]> = [
    [-halfW, -halfH],
    [+halfW, -halfH],
    [+halfW, +halfH],
    [-halfW, +halfH],
  ];

  return corners.map(([dx, dy]) => {
    const rx = dx * cosT - dy * sinT;
    const ry = dx * sinT + dy * cosT;
    return {
      lat: cLat + ry / M_PER_DEG_LAT,
      lng: cLng + rx / (M_PER_DEG_LAT * cosLat),
    };
  });
}

/** Rotate every facet bbox by the building's dominant axis. Skips
 *  facets with degenerate bboxes. */
export function rotateAllFacets(
  segments: SolarSegment[],
  buildingRotationDeg: number | null,
): Array<Array<{ lat: number; lng: number }>> {
  if (buildingRotationDeg == null || !segments.length) return [];
  const result: Array<Array<{ lat: number; lng: number }>> = [];
  for (const seg of segments) {
    const poly = rotateFacetBbox(seg, buildingRotationDeg);
    if (poly) result.push(poly);
  }
  return result;
}

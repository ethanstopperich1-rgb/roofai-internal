/**
 * Polygon geometry: shoelace area, perimeter, centroid, point-in-polygon.
 *
 * Operates in two modes:
 *   - PIXEL polygons (Cartesian, no Earth curvature) — used for in-tile
 *     measurements before lat/lng conversion.
 *   - LAT/LNG polygons (WGS84) — used for real-world output. Areas are
 *     computed via a local equirectangular projection, accurate to
 *     ~0.1% at residential-roof scale.
 *
 * Surface area = footprint × slope multiplier (1 / cos(pitchRad)). Each
 * facet carries its own pitch; the slope correction happens per-facet
 * inside polygonSurfaceAreaSqft().
 */

import type { LatLng, PixelPoint } from "./coordinates";

const SQM_TO_SQFT = 10.7639;

// ─── Pixel-space ─────────────────────────────────────────────────────

export function pixelPolygonArea(pixels: PixelPoint[]): number {
  if (pixels.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pixels.length; i++) {
    const j = (i + 1) % pixels.length;
    a += pixels[i].x * pixels[j].y - pixels[j].x * pixels[i].y;
  }
  return Math.abs(a) / 2;
}

export function pixelPolygonPerimeter(pixels: PixelPoint[]): number {
  if (pixels.length < 2) return 0;
  let p = 0;
  for (let i = 0; i < pixels.length; i++) {
    const j = (i + 1) % pixels.length;
    p += Math.hypot(pixels[j].x - pixels[i].x, pixels[j].y - pixels[i].y);
  }
  return p;
}

export function pixelPolygonCentroid(pixels: PixelPoint[]): PixelPoint {
  if (pixels.length === 0) return { x: 0, y: 0 };
  let sx = 0,
    sy = 0;
  for (const p of pixels) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / pixels.length, y: sy / pixels.length };
}

/**
 * Pixel-polygon area → square feet using the tile's meters-per-pixel.
 * This is the FOOTPRINT (top-down projection), not slope-corrected.
 */
export function pixelPolygonFootprintSqft(
  pixels: PixelPoint[],
  metersPerPixel: number,
): number {
  const areaPx = pixelPolygonArea(pixels);
  const areaM2 = areaPx * metersPerPixel * metersPerPixel;
  return areaM2 * SQM_TO_SQFT;
}

// ─── Lat/lng-space ───────────────────────────────────────────────────

const M_PER_DEG_LAT = 111_320;

/**
 * Footprint area of a lat/lng polygon in square feet. Uses a local
 * equirectangular projection anchored on the polygon's centroid —
 * accurate to ~0.1% at residential-roof scale, no external deps.
 */
export function polygonFootprintSqftLatLng(ring: LatLng[]): number {
  if (ring.length < 3) return 0;
  let cLat = 0;
  for (const p of ring) cLat += p.lat;
  cLat /= ring.length;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const M_PER_DEG_LNG = M_PER_DEG_LAT * cosLat;
  // Convert ring to local meters, shoelace, return sqft.
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const xi = ring[i].lng * M_PER_DEG_LNG;
    const yi = ring[i].lat * M_PER_DEG_LAT;
    const xj = ring[j].lng * M_PER_DEG_LNG;
    const yj = ring[j].lat * M_PER_DEG_LAT;
    a += xi * yj - xj * yi;
  }
  return (Math.abs(a) / 2) * SQM_TO_SQFT;
}

/**
 * Surface area = footprint × slope multiplier. Pitch in DEGREES.
 * Used per-facet after pitch is resolved (from Solar match or Gemini's
 * orientation estimate).
 */
export function polygonSurfaceAreaSqft(
  ring: LatLng[],
  pitchDegrees: number,
): number {
  const footprint = polygonFootprintSqftLatLng(ring);
  const slope = slopeMultiplier(pitchDegrees);
  return footprint * slope;
}

export function slopeMultiplier(pitchDegrees: number): number {
  if (!Number.isFinite(pitchDegrees) || pitchDegrees < 0 || pitchDegrees >= 90)
    return 1;
  return 1 / Math.cos((pitchDegrees * Math.PI) / 180);
}

export function polygonCentroidLatLng(ring: LatLng[]): LatLng {
  if (ring.length === 0) return { lat: 0, lng: 0 };
  let cLat = 0,
    cLng = 0;
  for (const p of ring) {
    cLat += p.lat;
    cLng += p.lng;
  }
  return { lat: cLat / ring.length, lng: cLng / ring.length };
}

/**
 * Point-in-polygon (lat/lng), ray-casting. Works for non-self-
 * intersecting rings; we don't expect self-intersecting roof outlines.
 */
export function pointInPolygon(point: LatLng, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng,
      yi = ring[i].lat;
    const xj = ring[j].lng,
      yj = ring[j].lat;
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

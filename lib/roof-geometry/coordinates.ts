/**
 * Bidirectional pixel ↔ lat/lng conversion for a Web Mercator tile.
 *
 * Uses the tile's `metersPerPixel` (computed in tile-metadata.ts) +
 * standard lat/lng-meter conversion. Identity-stable to ~7 decimal
 * places (round-trip error < 1 cm at zoom 20).
 */

import type { TileMetadata } from "./tile-metadata";

const M_PER_DEG_LAT = 111_320;

export interface PixelPoint {
  x: number;
  y: number;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Pixel coords (origin top-left, +y down) → WGS84 lat/lng.
 */
export function pixelToLatLng(pt: PixelPoint, meta: TileMetadata): LatLng {
  const cosLat = Math.cos((meta.centerLat * Math.PI) / 180);
  const M_PER_DEG_LNG = M_PER_DEG_LAT * cosLat;
  const dxM = (pt.x - meta.widthPx / 2) * meta.metersPerPixel;
  // Y is flipped: pixel-y increases downward, lat increases northward.
  const dyM = (meta.heightPx / 2 - pt.y) * meta.metersPerPixel;
  return {
    lat: meta.centerLat + dyM / M_PER_DEG_LAT,
    lng: meta.centerLng + dxM / M_PER_DEG_LNG,
  };
}

/**
 * WGS84 lat/lng → pixel coords on the tile (origin top-left).
 */
export function latLngToPixel(ll: LatLng, meta: TileMetadata): PixelPoint {
  const cosLat = Math.cos((meta.centerLat * Math.PI) / 180);
  const M_PER_DEG_LNG = M_PER_DEG_LAT * cosLat;
  const dxM = (ll.lng - meta.centerLng) * M_PER_DEG_LNG;
  const dyM = (ll.lat - meta.centerLat) * M_PER_DEG_LAT;
  return {
    x: meta.widthPx / 2 + dxM / meta.metersPerPixel,
    y: meta.heightPx / 2 - dyM / meta.metersPerPixel,
  };
}

/**
 * Convert a whole polygon (pixel-space) to lat/lng-space.
 */
export function pixelPolygonToLatLng(
  pixels: PixelPoint[],
  meta: TileMetadata,
): LatLng[] {
  return pixels.map((p) => pixelToLatLng(p, meta));
}

/**
 * Haversine distance between two lat/lng points, in meters. Used for
 * matching vision-detected polygons to Solar API plane centroids
 * (within `MATCH_RADIUS_M` ≈ 5m in the orchestrator).
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
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

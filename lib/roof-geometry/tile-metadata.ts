/**
 * Tile metadata + Ground Sample Distance (GSD) for Web Mercator tiles
 * served by Google Static Maps / Mapbox.
 *
 * The pipeline asks vision models (Gemini, SAM3) to return PIXEL
 * coordinates against a known tile. This module converts those pixels
 * into real-world coordinates using deterministic Web Mercator math —
 * no model uncertainty, no API calls.
 */

const EQUATORIAL_M_PER_PX_Z0 = 156_543.03392; // Web Mercator @ zoom 0 at equator

export interface TileMetadata {
  /** Center lat (WGS84). */
  centerLat: number;
  /** Center lng (WGS84). */
  centerLng: number;
  /** Zoom level requested from the tile provider (Google Static Maps: 0–22). */
  zoom: number;
  /** Retina scale factor. Google `scale=2` → 1, real px-per-tile-px = 2. */
  scale: 1 | 2;
  /** Width of the IMAGE in pixels (= sizePx × scale for Google). */
  widthPx: number;
  /** Height of the IMAGE in pixels. */
  heightPx: number;
  /** Meters per image pixel at the tile center. */
  metersPerPixel: number;
}

/**
 * Build a tile metadata bundle. `sizePx` is the value passed to Google
 * Static Maps' `size=NxN` param (max 640). `scale` is 1 or 2 — actual
 * image dimensions in pixels are `sizePx × scale`.
 *
 * Meters-per-pixel uses standard Web Mercator with cos(lat) latitude
 * compensation: at higher latitudes each pixel covers fewer ground
 * meters because of the projection's stretch toward the poles.
 */
export function buildTileMetadata(opts: {
  centerLat: number;
  centerLng: number;
  zoom: number;
  scale: 1 | 2;
  sizePx: number;
}): TileMetadata {
  const { centerLat, centerLng, zoom, scale, sizePx } = opts;
  const widthPx = sizePx * scale;
  const heightPx = sizePx * scale;
  // mPerPx at zoom Z scale S: 156543 × cos(lat) / 2^(Z + S − 1)
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const metersPerPixel =
    (EQUATORIAL_M_PER_PX_Z0 * cosLat) / Math.pow(2, zoom + scale - 1);
  return { centerLat, centerLng, zoom, scale, widthPx, heightPx, metersPerPixel };
}

/**
 * Bounding box of the tile in WGS84 lat/lng. Useful for spatial joins
 * against Solar API polygons or for clipping external datasets to the
 * tile frame.
 */
export interface TileBounds {
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
}

export function tileBounds(meta: TileMetadata): TileBounds {
  // Half-width of the tile in meters, then convert to deg lat/lng.
  const halfWidthM = (meta.widthPx / 2) * meta.metersPerPixel;
  const halfHeightM = (meta.heightPx / 2) * meta.metersPerPixel;
  const M_PER_DEG_LAT = 111_320;
  const cosLat = Math.cos((meta.centerLat * Math.PI) / 180);
  const M_PER_DEG_LNG = M_PER_DEG_LAT * cosLat;
  return {
    swLat: meta.centerLat - halfHeightM / M_PER_DEG_LAT,
    swLng: meta.centerLng - halfWidthM / M_PER_DEG_LNG,
    neLat: meta.centerLat + halfHeightM / M_PER_DEG_LAT,
    neLng: meta.centerLng + halfWidthM / M_PER_DEG_LNG,
  };
}

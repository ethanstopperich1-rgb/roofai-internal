/**
 * Google Solar API → roof polygon via the dataLayers:get mask GeoTIFF.
 *
 * Solar's `findClosest` endpoint (used elsewhere) returns axis-aligned
 * bounding boxes per facet — fine for facet count and per-facet pitch but
 * geometrically wrong on any non-north-aligned house. Its `dataLayers:get`
 * sibling exposes a binary roof mask raster (1 px = "is this roof?") at
 * arbitrary `pixelSizeMeters` resolution. The mask is GROUND TRUTH from
 * Google's photogrammetric segmentation — it's the same data Project
 * Sunroof uses to size solar arrays. Beats SAM/OSM/AI for any property in
 * Solar coverage (US, EU, JP, AU as of 2026).
 *
 * Pipeline:
 *   1. fetch dataLayers:get → mask URL
 *   2. download GeoTIFF, parse with `geotiff` package
 *   3. find the connected roof component closest to (or containing) center
 *   4. trace boundary (Moore-neighbor)
 *   5. simplify (Douglas-Peucker)
 *   6. orthogonalize + merge near-duplicate vertices
 *   7. project pixel coords → lat/lng using the GeoTIFF georeferencing
 */

import { debug } from "@/lib/debug";
import { fromArrayBuffer, type GeoTIFF, type GeoTIFFImage } from "geotiff";
import { mergeNearbyVertices, orthogonalizePolygon } from "./polygon";

export interface SolarMaskPolygon {
  /** Polygon vertices in lat/lng (closed implicitly — first ≠ last) */
  latLng: Array<{ lat: number; lng: number }>;
  source: "solar-mask";
  /** Mask area in mask-image pixels (proxy for confidence) */
  pixelArea: number;
  /** Pixel-resolution of the underlying mask, in meters per pixel */
  pixelSizeMeters: number;
}

interface DataLayersResponse {
  imageryDate?: { year?: number; month?: number; day?: number };
  imageryProcessedDate?: { year?: number; month?: number; day?: number };
  dsmUrl?: string;
  rgbUrl?: string;
  maskUrl?: string;
  annualFluxUrl?: string;
  imageryQuality?: string;
}

const FETCH_TIMEOUT_MS = 12_000;

async function fetchDataLayers(
  lat: number,
  lng: number,
  apiKey: string,
): Promise<DataLayersResponse | null> {
  // 25 m radius is enough to cover any single residential property and
  // keeps the GeoTIFF small (~200×200 at 0.25 m/px). We only need the
  // mask layer; LAYER view is the cheapest tier.
  const url =
    `https://solar.googleapis.com/v1/dataLayers:get` +
    `?location.latitude=${lat}&location.longitude=${lng}` +
    `&radiusMeters=25` +
    `&view=FULL_LAYERS` +
    `&requiredQuality=LOW` +
    `&pixelSizeMeters=0.25` +
    `&key=${apiKey}`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[solar-mask] dataLayers:get → ${res.status}`);
      return null;
    }
    return (await res.json()) as DataLayersResponse;
  } catch (err) {
    console.warn("[solar-mask] dataLayers fetch error:", err);
    return null;
  }
}

async function fetchMaskTiff(
  maskUrl: string,
  apiKey: string,
): Promise<ArrayBuffer | null> {
  // Solar API URLs come with auth params already, but we may need to
  // append our key when the URL doesn't include one.
  const sep = maskUrl.includes("?") ? "&" : "?";
  const url = maskUrl.includes("key=") ? maskUrl : `${maskUrl}${sep}key=${apiKey}`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[solar-mask] mask tiff → ${res.status}`);
      return null;
    }
    return await res.arrayBuffer();
  } catch (err) {
    console.warn("[solar-mask] mask tiff fetch error:", err);
    return null;
  }
}

async function readMaskRaster(buf: ArrayBuffer): Promise<{
  data: Uint8Array;
  width: number;
  height: number;
  bbox: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
} | null> {
  let tiff: GeoTIFF;
  try {
    tiff = await fromArrayBuffer(buf);
  } catch (err) {
    console.warn("[solar-mask] tiff parse error:", err);
    return null;
  }
  let image: GeoTIFFImage;
  try {
    image = await tiff.getImage();
  } catch (err) {
    console.warn("[solar-mask] tiff getImage error:", err);
    return null;
  }
  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox() as [number, number, number, number];
  let raster;
  try {
    const r = await image.readRasters({ interleave: true });
    raster = r as unknown as Uint8Array | Uint16Array | Float32Array;
  } catch (err) {
    console.warn("[solar-mask] readRasters error:", err);
    return null;
  }
  // Normalise to a binary 0/1 mask. Solar's mask returns building-id values
  // (0 = no roof, >0 = some segment id). We collapse to "is roof".
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    if (Number(raster[i]) > 0) mask[i] = 1;
  }
  return { data: mask, width, height, bbox };
}

/**
 * Flood-fill the connected component containing (or nearest to) the
 * centerpoint. Returns a mask containing ONLY that component. Used so
 * neighboring buildings in the radius don't bleed into the trace.
 */
function isolateCenterComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array | null {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);

  // Find a seed pixel: prefer the centerpoint, otherwise scan outward
  let seedX = -1, seedY = -1;
  if (mask[cy * width + cx]) {
    seedX = cx; seedY = cy;
  } else {
    // Spiral outward to find the nearest "1" pixel
    const maxR = Math.max(width, height);
    outer: for (let r = 1; r < maxR; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          if (mask[y * width + x]) {
            seedX = x; seedY = y;
            break outer;
          }
        }
      }
    }
  }
  if (seedX < 0) return null;

  // Flood fill (4-connectivity is fine for roof masks)
  const out = new Uint8Array(mask.length);
  const stack: number[] = [seedY * width + seedX];
  while (stack.length) {
    const idx = stack.pop()!;
    if (out[idx]) continue;
    if (!mask[idx]) continue;
    out[idx] = 1;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) stack.push(idx - 1);
    if (x < width - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - width);
    if (y < height - 1) stack.push(idx + width);
  }
  return out;
}

/** Moore-neighbor boundary trace — same algorithm as grounded-sam.ts */
function traceBoundary(
  mask: Uint8Array,
  width: number,
  height: number,
): Array<[number, number]> | null {
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        startX = x; startY = y;
        break outer;
      }
    }
  }
  if (startX < 0) return null;

  const isOn = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] > 0;

  const NEIGHBORS: Array<[number, number]> = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const boundary: Array<[number, number]> = [];
  let cx = startX, cy = startY;
  let prev = 6;
  let safety = width * height;
  do {
    boundary.push([cx, cy]);
    let found = false;
    for (let i = 1; i <= 8; i++) {
      const dirIdx = (prev + 5 + i) % 8;
      const [dx, dy] = NEIGHBORS[dirIdx];
      const nx = cx + dx, ny = cy + dy;
      if (isOn(nx, ny)) {
        cx = nx; cy = ny;
        prev = (dirIdx + 4) % 8;
        found = true;
        break;
      }
    }
    if (!found) break;
    safety--;
    if (safety <= 0) break;
    if (boundary.length > 8 && cx === startX && cy === startY) break;
  } while (true);

  return boundary.length >= 6 ? boundary : null;
}

function douglasPeucker(
  points: Array<[number, number]>,
  epsilon: number,
): Array<[number, number]> {
  if (points.length < 3) return points;
  const perpDist = (p: [number, number], a: [number, number], b: [number, number]) => {
    const num = Math.abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0]);
    const den = Math.hypot(b[1] - a[1], b[0] - a[0]) || 1;
    return num / den;
  };
  let dmax = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], points[0], points[points.length - 1]);
    if (d > dmax) { dmax = d; index = i; }
  }
  if (dmax > epsilon) {
    const left = douglasPeucker(points.slice(0, index + 1), epsilon);
    const right = douglasPeucker(points.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [points[0], points[points.length - 1]];
}

export async function fetchSolarRoofMask(opts: {
  lat: number;
  lng: number;
  apiKey: string;
}): Promise<SolarMaskPolygon | null> {
  const { lat, lng, apiKey } = opts;

  const dataLayers = await fetchDataLayers(lat, lng, apiKey);
  if (!dataLayers?.maskUrl) {
    console.warn("[solar-mask] no maskUrl in dataLayers response");
    return null;
  }
  const buf = await fetchMaskTiff(dataLayers.maskUrl, apiKey);
  if (!buf) return null;

  const raster = await readMaskRaster(buf);
  if (!raster) return null;
  const { data: rawMask, width, height, bbox } = raster;

  // Isolate the building under the centerpoint — drops neighbors in radius
  const mask = isolateCenterComponent(rawMask, width, height);
  if (!mask) {
    console.warn("[solar-mask] no roof component near centerpoint");
    return null;
  }

  let area = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) area++;
  if (area < 30) {
    console.warn(`[solar-mask] component too small (${area} px)`);
    return null;
  }

  const boundary = traceBoundary(mask, width, height);
  if (!boundary) return null;

  // DP epsilon ≈ 1 px since pixelSizeMeters=0.25 → 1 px ≈ 0.25 m, and we
  // want sub-meter edge fidelity. Then orthogonalize against dominant axis,
  // then merge near-duplicate vertices left by the snap.
  const simplified = douglasPeucker(boundary, 1.5);
  const ortho = mergeNearbyVertices(orthogonalizePolygon(simplified, 14), 1);
  if (ortho.length < 4) return null;

  // Project pixel coords → lat/lng. Solar's GeoTIFF is geographic (WGS84),
  // so bbox is [minLng, minLat, maxLng, maxLat]. Origin at top-left.
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const dLng = maxLng - minLng;
  const dLat = maxLat - minLat;
  const latLng = ortho.map(([x, y]) => ({
    lng: minLng + (x / width) * dLng,
    lat: maxLat - (y / height) * dLat,
  }));

  debug(
    `[solar-mask] traced ${ortho.length}-vertex polygon from ${width}×${height} mask (area ${area}px)`,
  );

  return {
    latLng,
    source: "solar-mask",
    pixelArea: area,
    pixelSizeMeters: 0.25,
  };
}

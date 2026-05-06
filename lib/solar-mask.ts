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
  // 40 m radius gives a 320×320 mask at 0.25 m/px. Larger than strictly
  // necessary for a single residential roof (~20m across), but the
  // margin matters: at the original 25m radius, the building outline
  // routinely touches the bbox edge, and the Moore-neighbor trace gets
  // stuck cycling at the corner where a flat top hits the image edge.
  // 40m gives ~10m of off-pixel margin all around, so the topmost-
  // leftmost on-pixel sits on the building's actual outline.
  const url =
    `https://solar.googleapis.com/v1/dataLayers:get` +
    `?location.latitude=${lat}&location.longitude=${lng}` +
    `&radiusMeters=40` +
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

/** Hole-fill a mask in-place. Anything 4-connected to the border is
 *  background; everything else (interior off-pixels) gets flipped on. */
function fillHoles(mask: Uint8Array, w: number, h: number): void {
  const visited = new Uint8Array(mask.length);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    if (!mask[x]) stack.push(x);
    const bot = (h - 1) * w + x;
    if (!mask[bot]) stack.push(bot);
  }
  for (let y = 0; y < h; y++) {
    const left = y * w;
    if (!mask[left]) stack.push(left);
    const right = y * w + (w - 1);
    if (!mask[right]) stack.push(right);
  }
  while (stack.length) {
    const idx = stack.pop()!;
    if (visited[idx]) continue;
    if (mask[idx]) continue;
    visited[idx] = 1;
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && !visited[i]) mask[i] = 1;
  }
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      const xs = Math.max(0, x - r);
      const xe = Math.min(w - 1, x + r);
      const ys = Math.max(0, y - r);
      const ye = Math.min(h - 1, y + r);
      for (let yy = ys; yy <= ye && !on; yy++) {
        const row = yy * w;
        for (let xx = xs; xx <= xe; xx++) {
          if (mask[row + xx]) { on = 1; break; }
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

function erode(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let off = 0;
      const xs = Math.max(0, x - r);
      const xe = Math.min(w - 1, x + r);
      const ys = Math.max(0, y - r);
      const ye = Math.min(h - 1, y + r);
      for (let yy = ys; yy <= ye && !off; yy++) {
        const row = yy * w;
        for (let xx = xs; xx <= xe; xx++) {
          if (!mask[row + xx]) { off = 1; break; }
        }
      }
      out[y * w + x] = off ? 0 : 1;
    }
  }
  return out;
}

/** Close = dilate then erode. Bridges 1-2 px gaps so the building's
 *  boundary forms a single 8-connected loop. */
function morphClose(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return erode(dilate(mask, w, h, r), w, h, r);
}

/**
 * Moore-neighbor boundary trace.
 *
 * Original: started at the topmost-leftmost on-pixel. Failure mode
 * observed against Solar mask in central Florida: the pixel on which
 * Moore lands is a 2-4 px protrusion at the bbox edge, the 8-connected
 * trace circles it for a few iterations, and the safety guard
 * (`length > 8 && back-at-start`) exits with 12 verts before reaching
 * the main building outline. DP then collapses the 4-cycle to 2 verts
 * and the route returns null silently.
 *
 * Fix: preprocess with morphological close + hole fill BEFORE tracing
 * (the same pattern grounded-sam.ts uses). Closing welds bbox-edge
 * protrusions into the main blob; hole-fill removes interior gaps from
 * chimneys/skylights/dormers. After preprocessing, the topmost-leftmost
 * on-pixel sits on a single connected outline and Moore-neighbor
 * traces the actual building perimeter cleanly.
 */
/**
 * Moore-neighbor boundary trace.
 *
 * Two bugs were silently breaking this on Solar mask GeoTIFFs:
 *
 * 1. **Wrong rotation convention.** The original `(prev + 5 + i) % 8`
 *    starts the search 5 directions clockwise of the arrival direction.
 *    On any topmost-leftmost on-pixel where the neighbors form a 2×2
 *    convex corner — i.e. the seed has on-neighbors E, SE, and S — the
 *    rotation order has the trace step into the corner and circle 4
 *    pixels indefinitely until the safety guard exits at 12 verts.
 *    The correct convention is `(prev + 1 + i) % 8`: start checking
 *    immediately CCW of where we came from. Empirically traced on FL
 *    residential roof masks: 12 verts → 373 verts.
 *
 * 2. **No preprocessing.** Solar's photogrammetric mask has minor
 *    speckles, dormers, and bbox-edge fragments that fragment the
 *    8-connected boundary into disjoint loops. Without a morph-close
 *    + hole-fill pass, the trace from any seed can land on a small
 *    sub-loop instead of the actual building outline.
 */
function traceBoundary(
  mask: Uint8Array,
  width: number,
  height: number,
): Array<[number, number]> | null {
  const cleaned = morphClose(mask, width, height, 3);
  fillHoles(cleaned, width, height);

  let startX = -1, startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cleaned[y * width + x]) {
        startX = x; startY = y;
        break outer;
      }
    }
  }
  if (startX < 0) return null;

  const isOn = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && cleaned[y * width + x] > 0;
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
      const dirIdx = (prev + 1 + i) % 8;
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

  // Project pixel coords → lat/lng.
  //
  // The original code assumed Solar's GeoTIFF was in WGS84 with the
  // bbox as [minLng, minLat, maxLng, maxLat]. It's not — Solar returns
  // a UTM-projected raster whose bbox is in meters (e.g. for FL,
  // [473872.75, 3143372.20, ...] is UTM zone 17N easting/northing).
  // Treating those numbers as degrees plants the polygon thousands of
  // km off in the Atlantic, giving IoU=0 against any real ground truth.
  //
  // Easier fix than UTM↔WGS84 conversion: the dataLayers:get request
  // is centered on the user's input lat/lng, so the center pixel of
  // the returned image is at (lat, lng). Each pixel is exactly
  // `pixelSizeMeters` (0.25 m) on a side. Convert pixel offsets from
  // center to meter offsets, then meter offsets to lat/lng deltas
  // using the standard ~111,320 m/° lat conversion (with cos(lat)
  // correction for lng).
  const PX = 0.25;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const M_PER_DEG_LAT = 111_320;
  const latLng = ortho.map(([x, y]) => {
    const dxM = (x - width / 2) * PX;
    const dyM = (y - height / 2) * PX; // image y grows DOWN; lat grows UP
    return {
      lat: lat - dyM / M_PER_DEG_LAT,
      lng: lng + dxM / (M_PER_DEG_LAT * cosLat),
    };
  });
  void bbox; // bbox kept in raster return value; not used for projection now

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

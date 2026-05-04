/**
 * Grounded SAM — text-prompted segmentation. Given a satellite tile,
 * we ask the model to mask "the main residential roof" while explicitly
 * excluding "trees, lawn, driveway, deck, pool, shadows."
 *
 * Pipeline overhead is one Replicate call + a binary-mask download +
 * pure-JS contour extraction. ~$0.005 per call, ~5-10s end-to-end.
 *
 * Returns the largest contiguous mask region as a simplified polygon
 * in lat/lng space (using the Static Maps zoom-20 projection). Caller
 * can intersect with the OSM building footprint to filter out any
 * stray segments that landed outside the actual building.
 */

import Replicate from "replicate";
import sharp from "sharp";
import { orthogonalizePolygon } from "./polygon";

// schananas/grounded_sam — Grounding DINO + SAM. Text prompt → mask URLs.
const MODEL =
  "schananas/grounded_sam:ee871c19efb1941f55f66a3d7d960428c8a5afcb77449547fe8e5a3ab9ebc21c";

// Static Maps caps `size` at 640. With `scale=2` Google returns a 1280×1280
// image at the same zoom — 4× the pixel count, free. We work entirely in
// the upscaled space so contour trace + DP are pixel-precise.
const IMAGE_TILE_PX = 640;
const IMAGE_SCALE = 2;
const IMAGE_PIXELS = IMAGE_TILE_PX * IMAGE_SCALE; // 1280
const IMAGE_ZOOM = 20;

// Tightly worded prompts. "rooftop shingles" performs noticeably better
// than just "roof" because Grounding DINO's training data treats "roof"
// as "the whole house including yard" sometimes. Negative prompt is a
// long explicit list — DINO downweights anything it matches here.
const POSITIVE_PROMPT =
  "rooftop shingles, roof material, the actual sloped roof surface only";
const NEGATIVE_PROMPT =
  "ground, lawn, grass, dirt, soil, trees, foliage, leaves, branches, " +
  "driveway, road, sidewalk, walkway, concrete, asphalt, " +
  "deck, patio, balcony, porch, pool, water, " +
  "shadow, dark area, vehicle, car, truck, " +
  "neighbouring building, wall, fence, chair, table, furniture";

export interface GroundedRoofPolygon {
  /** Polygon vertices in lat/lng */
  latLng: Array<{ lat: number; lng: number }>;
  /** Pixel polygon for diagnostics (1280×1280 image space @ scale=2) */
  pixels: Array<[number, number]>;
  /** Mask area in pixels (proxy for confidence in the mask) */
  pixelArea: number;
}

// Meters per pixel at given lat / zoom / scale. With scale=2 each pixel
// covers half the ground distance of the un-scaled tile.
const M_PER_PX = (lat: number, zoom = IMAGE_ZOOM, scale = IMAGE_SCALE) =>
  (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom) / scale;

function pixelToLatLng(opts: {
  x: number;
  y: number;
  centerLat: number;
  centerLng: number;
  imgSize?: number;
  zoom?: number;
  scale?: number;
}): { lat: number; lng: number } {
  const {
    x, y, centerLat, centerLng,
    imgSize = IMAGE_PIXELS, zoom = IMAGE_ZOOM, scale = IMAGE_SCALE,
  } = opts;
  const m = M_PER_PX(centerLat, zoom, scale);
  const dx = x - imgSize / 2;
  const dy = y - imgSize / 2;
  return {
    lat: centerLat + (-dy * m) / 111_320,
    lng: centerLng + (dx * m) / (111_320 * Math.cos((centerLat * Math.PI) / 180)),
  };
}

async function fetchSatelliteImage(opts: {
  lat: number;
  lng: number;
  apiKey: string;
}): Promise<{ base64: string; mimeType: "image/png" } | null> {
  // size= is capped at 640 by Google. scale=2 returns the same area at 1280×1280
  // — 4× pixel count, no extra cost. Critical for tight contour tracing.
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${opts.lat},${opts.lng}&zoom=${IMAGE_ZOOM}&size=${IMAGE_TILE_PX}x${IMAGE_TILE_PX}&scale=${IMAGE_SCALE}&maptype=satellite&key=${opts.apiKey}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString("base64"), mimeType: "image/png" };
  } catch (err) {
    console.error("[grounded-sam] static map fetch error:", err);
    return null;
  }
}

// ---------- Mask cleanup: hole-fill + morphological close ----------

/**
 * Fill interior holes (BG pixels enclosed by FG). We flood-fill the
 * background starting from every border pixel — anything still BG after
 * that is necessarily a hole and gets flipped to FG. Stops chimney /
 * skylight artifacts in the mask from showing up as concave bites in
 * the polygon outline.
 */
function fillHoles(mask: Uint8Array, w: number, h: number): void {
  const visited = new Uint8Array(mask.length);
  const stack: number[] = [];
  // Seed every border pixel that's currently background
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
  // Anything not reached from the border is an interior hole — fill it
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] && !visited[i]) mask[i] = 1;
  }
}

/** Morphological dilate by `r` pixels (Chebyshev/box neighborhood). */
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

/** Morphological erode by `r` pixels (inverse of dilate). */
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

/**
 * Morphological close = dilate then erode. Removes 1–2 px gaps and
 * jaggies on the boundary while preserving overall shape.
 */
function morphClose(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return erode(dilate(mask, w, h, r), w, h, r);
}

// ---------- Contour extraction (Moore-neighbor + Douglas-Peucker) ----------

function maskToPolygon(
  rawMask: Uint8Array,
  width: number,
  height: number,
): { polygon: Array<[number, number]>; area: number } | null {
  let area = 0;
  for (let i = 0; i < rawMask.length; i++) if (rawMask[i] > 0) area++;
  if (area < 800) return null; // ~0.05% of 1280² — under that the mask is noise

  // Step 1: morphological close (radius 3) — kills saw-tooth jaggies on
  // the boundary. Step 2: hole-fill — chimneys/skylights/dormers don't
  // bite chunks out of the polygon. Order matters: close first so we
  // don't fill noise as "holes."
  const closed = morphClose(rawMask, width, height, 3);
  fillHoles(closed, width, height);
  const mask = closed;

  // Recount area on the cleaned mask — drives the area-rank check below
  area = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0) area++;

  // Find leftmost-on pixel on the topmost-on row (a stable trace start)
  let startX = -1, startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 0) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX < 0) return null;

  const isOn = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] > 0;

  // Moore-neighbor boundary trace
  const NEIGHBORS: Array<[number, number]> = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const boundary: Array<[number, number]> = [];
  let cx = startX, cy = startY;
  let prev = 6; // came from above
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

  if (boundary.length < 6) return null;

  // Douglas-Peucker simplify. At scale=2 (pixels are half the physical
  // size of scale=1) we use epsilon=6 px ≈ 0.45 m of allowable edge
  // simplification — same physical tolerance the v1 pipeline used at
  // epsilon=3, but starting from a 4× higher-resolution mask so corners
  // sit much closer to the actual roof boundary.
  const simplified = douglasPeucker(boundary, 6);
  if (simplified.length < 4) return null;

  // Orthogonalize: snap edges to the dominant building axis. This is the step
  // that converts SAM's "blob with corners" trace into a clean rectilinear
  // outline indistinguishable from a hand-drafted measurement.
  const ortho = orthogonalizePolygon(simplified, 14);
  return { polygon: ortho, area };
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

// ---------- Public entry point ----------

export async function refineRoofWithGroundedSam(opts: {
  lat: number;
  lng: number;
  googleMapsKey: string;
}): Promise<GroundedRoofPolygon | null> {
  const replicateKey = process.env.REPLICATE_API_TOKEN;
  if (!replicateKey) {
    console.warn("[grounded-sam] REPLICATE_API_TOKEN not set");
    return null;
  }

  const img = await fetchSatelliteImage({
    lat: opts.lat,
    lng: opts.lng,
    apiKey: opts.googleMapsKey,
  });
  if (!img) {
    console.warn("[grounded-sam] failed to fetch satellite tile");
    return null;
  }

  const replicate = new Replicate({ auth: replicateKey, useFileOutput: false });
  const dataUri = `data:image/png;base64,${img.base64}`;

  let output: unknown;
  try {
    output = await replicate.run(MODEL, {
      input: {
        image: dataUri,
        mask_prompt: POSITIVE_PROMPT,
        negative_mask_prompt: NEGATIVE_PROMPT,
        // -ve = erosion. We send a 1280×1280 image (scale=2) so each
        // pixel is half the physical size of the v1 pipeline; -8 here
        // preserves the same ~0.6m gutter-shadow erosion that worked at
        // -4 in 640px space.
        adjustment_factor: -8,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[grounded-sam] call failed:", msg);
    if (/Insufficient credit/i.test(msg)) throw new Error("REPLICATE_NO_CREDIT");
    if (/401|Unauthenticated/i.test(msg)) throw new Error("REPLICATE_UNAUTHORIZED");
    return null;
  }

  // Output is an array of mask URLs (positive mask is index 0 typically;
  // grounded_sam returns the positive-prompt result and may include an
  // intermediate mask too — we'll pick the largest mask).
  const urls: string[] = [];
  if (Array.isArray(output)) {
    for (const v of output) if (typeof v === "string") urls.push(v);
  } else if (typeof output === "string") {
    urls.push(output);
  }
  if (urls.length === 0) {
    console.warn("[grounded-sam] no mask URLs in output:", typeof output);
    return null;
  }
  console.log(`[grounded-sam] received ${urls.length} mask URL(s)`);

  // Process each mask, keep the largest non-degenerate one
  let best: { polygon: Array<[number, number]>; area: number } | null = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const { data, info } = await sharp(buf)
        .resize(IMAGE_PIXELS, IMAGE_PIXELS, { fit: "fill" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const mask = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) mask[i] = data[i] > 127 ? 1 : 0;
      const candidate = maskToPolygon(mask, info.width, info.height);
      if (candidate && (!best || candidate.area > best.area)) {
        best = candidate;
      }
    } catch (err) {
      console.warn("[grounded-sam] mask processing failed:", err);
    }
  }
  if (!best) {
    console.warn("[grounded-sam] no usable polygons after mask processing");
    return null;
  }

  // Sanity check: roof shouldn't fill more than 70% of the tile (means
  // grounded_sam picked up the whole image / ground mask)
  const fillFraction = best.area / (IMAGE_PIXELS * IMAGE_PIXELS);
  if (fillFraction > 0.70) {
    console.warn(
      `[grounded-sam] mask too large (${(fillFraction * 100).toFixed(0)}% of image) — likely a ground mask`,
    );
    return null;
  }
  console.log(
    `[grounded-sam] roof polygon: ${best.polygon.length} vertices, ${(fillFraction * 100).toFixed(1)}% of tile`,
  );

  return {
    pixels: best.polygon,
    pixelArea: best.area,
    latLng: best.polygon.map(([x, y]) =>
      pixelToLatLng({
        x, y,
        centerLat: opts.lat,
        centerLng: opts.lng,
      }),
    ),
  };
}

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

// schananas/grounded_sam — Grounding DINO + SAM. Text prompt → mask URLs.
const MODEL =
  "schananas/grounded_sam:ee871c19efb1941f55f66a3d7d960428c8a5afcb77449547fe8e5a3ab9ebc21c";

const IMAGE_SIZE_PX = 640;
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
  /** Pixel polygon for diagnostics (640×640 image space) */
  pixels: Array<[number, number]>;
  /** Mask area in pixels (proxy for confidence in the mask) */
  pixelArea: number;
}

const M_PER_PX = (lat: number, zoom = IMAGE_ZOOM) =>
  (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);

function pixelToLatLng(opts: {
  x: number;
  y: number;
  centerLat: number;
  centerLng: number;
  imgSize?: number;
  zoom?: number;
}): { lat: number; lng: number } {
  const { x, y, centerLat, centerLng, imgSize = IMAGE_SIZE_PX, zoom = IMAGE_ZOOM } = opts;
  const m = M_PER_PX(centerLat, zoom);
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
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${opts.lat},${opts.lng}&zoom=${IMAGE_ZOOM}&size=${IMAGE_SIZE_PX}x${IMAGE_SIZE_PX}&maptype=satellite&key=${opts.apiKey}`;
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

// ---------- Contour extraction (Moore-neighbor + Douglas-Peucker) ----------

function maskToPolygon(
  mask: Uint8Array,
  width: number,
  height: number,
): { polygon: Array<[number, number]>; area: number } | null {
  let area = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0) area++;
  if (area < 200) return null;

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

  // Douglas-Peucker simplify (epsilon 4 px → clean polygon, no jaggies)
  const simplified = douglasPeucker(boundary, 4);
  if (simplified.length < 4) return null;
  return { polygon: simplified, area };
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
        // -ve = erosion. -4 keeps the outline just inside the eaves so
        // the gutter shadow doesn't bleed into the polygon.
        adjustment_factor: -4,
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
        .resize(IMAGE_SIZE_PX, IMAGE_SIZE_PX, { fit: "fill" })
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
  const fillFraction = best.area / (IMAGE_SIZE_PX * IMAGE_SIZE_PX);
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

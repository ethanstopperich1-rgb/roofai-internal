/**
 * Replicate wrapper — runs Meta's SAM 2 in automatic-mask-generation mode
 * over a satellite tile of a property, then post-processes the masks into
 * a small set of roof-segment polygons in lat/lng space.
 *
 * Flow:
 *   1) Fetch the Static Maps satellite tile (640×640, zoom 20) for the
 *      property's lat/lng. We already use this image for /api/vision.
 *   2) Send it to Replicate's SAM 2 model (auto-mask mode).
 *   3) Filter masks to only the ones that overlap the building center
 *      and look roof-shaped (area, aspect ratio).
 *   4) Extract each mask's contour as a simplified polygon in pixel space.
 *   5) Convert pixel polygons → lat/lng polygons using the standard
 *      meters-per-pixel-at-zoom formula.
 *
 * Cost: ~$0.002 per call. Cached aggressively in lib/cache.ts.
 * Latency: 10-30s typical (Replicate cold start + inference).
 */

import Replicate from "replicate";
import sharp from "sharp";

// SAM 2 large from Meta on Replicate. Output is a list of mask URLs (PNGs).
const MODEL =
  "meta/sam-2:fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83";

const IMAGE_SIZE_PX = 640;
const IMAGE_ZOOM = 20;

export interface RefinedPolygon {
  /** lat/lng vertices, CCW or CW (consumer should not assume) */
  latLng: Array<{ lat: number; lng: number }>;
  /** Pixel-space vertices (in 640×640 source image), for diagnostic UI */
  pixels: Array<[number, number]>;
  /** Area in pixels (used internally to rank/filter) */
  pixelArea: number;
}

export interface RefineResult {
  polygons: RefinedPolygon[];
  imageBase64: string;
  imageMimeType: "image/png";
  /** Raw model output URL list, kept for debugging */
  rawMaskUrls?: string[];
}

const M_PER_PX = (lat: number, zoom = IMAGE_ZOOM) =>
  (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);

function pixelToLatLng(opts: {
  x: number;
  y: number;
  centerLat: number;
  centerLng: number;
  imgSize: number;
  zoom: number;
}): { lat: number; lng: number } {
  const { x, y, centerLat, centerLng, imgSize, zoom } = opts;
  const mPerPx = M_PER_PX(centerLat, zoom);
  // Static Maps puts north up
  const dx = x - imgSize / 2;
  const dy = y - imgSize / 2;
  const dLatDeg = (-dy * mPerPx) / 111_320;
  const dLngDeg =
    (dx * mPerPx) / (111_320 * Math.cos((centerLat * Math.PI) / 180));
  return { lat: centerLat + dLatDeg, lng: centerLng + dLngDeg };
}

async function fetchSatelliteImage(opts: {
  lat: number;
  lng: number;
  apiKey: string;
  zoom?: number;
}): Promise<{ buffer: Buffer; base64: string } | null> {
  const zoom = opts.zoom ?? IMAGE_ZOOM;
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${opts.lat},${opts.lng}&zoom=${zoom}&size=${IMAGE_SIZE_PX}x${IMAGE_SIZE_PX}&maptype=satellite&key=${opts.apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, base64: buf.toString("base64") };
}

/**
 * Walk the binary mask boundary using a Moore-neighbor / contour-trace style
 * algorithm. We simplify to ~24 vertices per polygon via Douglas-Peucker.
 */
function maskToPolygon(
  mask: Uint8Array,
  width: number,
  height: number,
): { polygon: Array<[number, number]>; area: number } | null {
  // 1) Find a starting "on" pixel (top-left scan)
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) { start = i; break; }
  }
  if (start < 0) return null;

  // 2) Compute area
  let area = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0) area++;
  if (area < 200) return null; // ignore tiny masks (< ~3 sqm at zoom 20)

  // 3) Marching squares-ish: trace boundary by walking edges where on/off neighbors differ
  // Simpler approach: for each "on" pixel that has an off neighbor, it's a boundary pixel.
  // Use that as a starting point for an 8-neighbor boundary walk.
  const boundary: Array<[number, number]> = [];
  const seen = new Uint8Array(mask.length);
  const sx = start % width;
  const sy = Math.floor(start / width);

  // Find a true boundary cell first
  let bx = sx;
  let by = sy;
  while (bx > 0 && mask[by * width + (bx - 1)] > 0) bx--;
  // Now (bx, by) is leftmost "on" in row by — start tracing
  const isOn = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] > 0;

  // Moore-neighbor tracing
  // Order: E, NE, N, NW, W, SW, S, SE
  const NEIGHBORS: Array<[number, number]> = [
    [1, 0], [1, -1], [0, -1], [-1, -1],
    [-1, 0], [-1, 1], [0, 1], [1, 1],
  ];
  let cx = bx, cy = by;
  let prev = 4; // came from west
  let safety = width * height;
  do {
    boundary.push([cx, cy]);
    seen[cy * width + cx] = 1;
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
    // Stop when we return to start
    if (boundary.length > 4 && cx === bx && cy === by) break;
  } while (true);

  if (boundary.length < 6) return null;

  // 4) Simplify with Douglas-Peucker (~ ε of 4-6 px gives clean polygons)
  const simplified = douglasPeucker(boundary, 5);
  if (simplified.length < 4) return null;

  return { polygon: simplified, area };
}

function douglasPeucker(
  points: Array<[number, number]>,
  epsilon: number,
): Array<[number, number]> {
  if (points.length < 3) return points;

  const perpDist = (p: [number, number], a: [number, number], b: [number, number]) => {
    const [px, py] = p;
    const [ax, ay] = a;
    const [bx, by] = b;
    const num = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax);
    const den = Math.hypot(by - ay, bx - ax) || 1;
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

/**
 * Score each mask against soft heuristics (centeredness, aspect, edge contact),
 * drop only the masks that look obviously wrong (full-frame backgrounds, tiny
 * specks, image-spanning rectangles), and rank the rest. We keep at least the
 * top candidate even if it scores poorly so suburban / rural properties where
 * the building is off-center still get a polygon.
 */
function scoreAndRankMasks(
  candidates: Array<{ polygon: Array<[number, number]>; area: number }>,
  imgSize: number,
): Array<{ polygon: Array<[number, number]>; area: number; score: number }> {
  const totalArea = imgSize * imgSize;
  const center = imgSize / 2;

  const scored = candidates.map(({ polygon, area }) => {
    let cx = 0, cy = 0;
    let minX = imgSize, minY = imgSize, maxX = 0, maxY = 0;
    for (const [x, y] of polygon) {
      cx += x; cy += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    cx /= polygon.length; cy /= polygon.length;
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const ratio = Math.max(w, h) / Math.min(w, h);
    const distToCenter = Math.hypot(cx - center, cy - center);
    const fillFraction = area / totalArea;
    const touchesEdge =
      minX < 4 || minY < 4 || maxX > imgSize - 4 || maxY > imgSize - 4;

    // Soft score: closer to center + reasonable aspect + reasonable size = higher
    const centerScore = 1 - Math.min(1, distToCenter / (imgSize * 0.5));
    const aspectScore = ratio < 4 ? 1 : ratio < 8 ? 0.5 : 0.1;
    const sizeScore =
      fillFraction < 0.005 ? 0.2 :
      fillFraction < 0.50 ? 1 : 0.2; // large = probably not a roof
    const edgePenalty = touchesEdge ? 0.4 : 1;
    const score = centerScore * aspectScore * sizeScore * edgePenalty;

    return { polygon, area, score, fillFraction, ratio, touchesEdge };
  });

  // Drop only the obviously wrong:
  //   - tiny (< 0.3% of image)
  //   - background (> 65% of image)
  //   - silly-thin (> 12:1)
  const filtered = scored.filter(
    (m) => m.fillFraction >= 0.003 && m.fillFraction <= 0.65 && m.ratio <= 12,
  );

  filtered.sort((a, b) => b.score - a.score);
  return filtered;
}

/**
 * One pass of SAM at a specific zoom level. Returns null when no usable
 * polygons are produced — caller can retry at a different zoom.
 */
async function refineAtZoom(opts: {
  lat: number;
  lng: number;
  googleMapsKey: string;
  replicate: Replicate;
  zoom: number;
}): Promise<RefineResult | null> {
  const img = await fetchSatelliteImage({
    lat: opts.lat,
    lng: opts.lng,
    apiKey: opts.googleMapsKey,
    zoom: opts.zoom,
  });
  if (!img) return null;

  const dataUri = `data:image/png;base64,${img.base64}`;

  let output: unknown;
  try {
    output = await opts.replicate.run(MODEL, {
      // Match meta/sam-2 input schema exactly — passing fields not in
      // the schema (crop_n_layers, min_mask_region_area) was a latent bug.
      input: {
        image: dataUri,
        points_per_side: 32,
        pred_iou_thresh: 0.86,
        stability_score_thresh: 0.92,
        use_m2m: true,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[replicate] SAM call failed (zoom=${opts.zoom}):`, msg);
    if (/Insufficient credit/i.test(msg)) {
      throw new Error("REPLICATE_NO_CREDIT");
    }
    if (/401|Unauthenticated/i.test(msg)) {
      throw new Error("REPLICATE_UNAUTHORIZED");
    }
    return null;
  }

  const maskUrls: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("http")) maskUrls.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      for (const key of [
        "individual_masks",
        "masks",
        "mask_urls",
        "combined_mask",
        "output",
      ]) {
        if (obj[key]) collect(obj[key]);
      }
    }
  };
  collect(output);

  if (maskUrls.length === 0) {
    console.warn(`[replicate] zoom=${opts.zoom}: no mask URLs in output`);
    return null;
  }

  const candidates: Array<{ polygon: Array<[number, number]>; area: number }> = [];
  for (const url of maskUrls.slice(0, 30)) {
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
      const result = maskToPolygon(mask, info.width, info.height);
      if (result) candidates.push(result);
    } catch (err) {
      console.warn("[replicate] mask processing failed:", err);
    }
  }

  console.log(
    `[replicate] zoom=${opts.zoom}: SAM produced ${candidates.length} candidates`,
  );
  const ranked = scoreAndRankMasks(candidates, IMAGE_SIZE_PX);
  console.log(
    `[replicate] zoom=${opts.zoom}: ${ranked.length} survived; top score=${ranked[0]?.score.toFixed(2) ?? "n/a"}`,
  );

  const top = ranked.slice(0, 8);
  if (top.length === 0) return null;

  const polygons: RefinedPolygon[] = top.map(({ polygon, area }) => ({
    pixels: polygon,
    pixelArea: area,
    latLng: polygon.map(([x, y]) =>
      pixelToLatLng({
        x, y,
        centerLat: opts.lat,
        centerLng: opts.lng,
        imgSize: IMAGE_SIZE_PX,
        zoom: opts.zoom,
      }),
    ),
  }));

  return {
    polygons,
    imageBase64: img.base64,
    imageMimeType: "image/png",
    rawMaskUrls: maskUrls,
  };
}

/**
 * Public entry point. Tries SAM at zoom 20 first (best detail) and falls
 * back to zoom 19 if no roof is found — this rescues rural / suburban
 * properties where the geocode pins to the parcel center and the building
 * sits partly outside the zoom-20 frame.
 */
export async function refineRoofPolygons(opts: {
  lat: number;
  lng: number;
  googleMapsKey: string;
}): Promise<RefineResult | null> {
  const replicateKey = process.env.REPLICATE_API_TOKEN;
  if (!replicateKey) {
    console.warn("[replicate] REPLICATE_API_TOKEN not set");
    return null;
  }

  const replicate = new Replicate({ auth: replicateKey });

  // Don't bother retrying at zoom 19 if the SAM call itself failed
  // for a known reason (no credit, bad token) — the second attempt
  // would fail identically.
  let tight: RefineResult | null;
  try {
    tight = await refineAtZoom({ ...opts, replicate, zoom: 20 });
  } catch (err) {
    throw err;
  }
  if (tight) return tight;

  console.log("[replicate] zoom=20 produced no roof; retrying at zoom=19");
  return refineAtZoom({ ...opts, replicate, zoom: 19 });
}

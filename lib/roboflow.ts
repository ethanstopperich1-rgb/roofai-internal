/**
 * Roboflow Hosted Inference — roof-specific instance segmentation.
 *
 * Unlike SAM 2 (which is a general-purpose foundation model prompted with
 * points) Roboflow Universe hosts models trained specifically on roof
 * imagery. We use them as a parallel polygon source. The hosted inference
 * API takes a base64-encoded image and returns one prediction per detected
 * roof, each with confidence + polygon vertices in pixel space — no mask
 * tracing required, the model emits the polygon directly.
 *
 * Pipeline:
 *   1. fetch the same 1280×1280 zoom-20 satellite tile the rest of the
 *      polygon pipeline uses (so multi-source IoU comparisons line up)
 *   2. POST base64(image) to https://detect.roboflow.com/<slug>/<version>
 *   3. filter predictions by confidence + proximity to image center
 *      (= geocoded address — drops neighbour roofs and stray garages)
 *   4. simplify (Douglas-Peucker), orthogonalize (best-of-N axis), and
 *      project pixel coords → lat/lng via the standard Web Mercator math
 */

import { bestOrthogonalize, mergeNearbyVertices } from "./polygon";

// We send the same image the rest of the pipeline uses: zoom-20 scale-2
// from Google Static Maps, which gives 1280×1280 pixels of ground at
// ~0.075 m/px at typical residential latitudes. Switching this changes
// every "X pixels per meter" assumption downstream — DON'T tweak in
// isolation.
const IMAGE_TILE_PX = 640;
const IMAGE_SCALE = 2;
const IMAGE_PIXELS = IMAGE_TILE_PX * IMAGE_SCALE; // 1280
const IMAGE_ZOOM = 20;

// Drop predictions below this confidence — the curve flattens out around
// 0.4 on both candidate models we tested; below that they're picking up
// pavement, lawn, or shadows.
const MIN_CONFIDENCE = 0.4;

// Drop predictions whose center is more than this far from the geocoded
// address (= image center). At zoom 20 / scale 2 each pixel is ~0.075 m
// at mid-latitudes, so 480 px ≈ 36 m — generous enough to cover a single
// large suburban property's main building + attached garage, tight enough
// to reject the neighbour next door (typical lot width is ~15-25 m).
const MAX_CENTER_DIST_PX = 480;

export interface RoboflowModel {
  /** workspace/project slug — e.g. "satellite-rooftop-map" */
  slug: string;
  /** trained model version, e.g. 3 */
  version: number;
  /** Optional class allowlist. When set, predictions whose `class` is not
   *  in this set are dropped. Useful for multi-class models like Roof Seg 2
   *  (window/roof/solar-panel) where we only want the "roof" class. */
  classAllowlist?: string[];
}

export interface RoboflowRoofPolygon {
  /** Polygon vertices in lat/lng (open ring — first ≠ last) */
  latLng: Array<{ lat: number; lng: number }>;
  /** Same polygon in pixel space, for diagnostics / overlay */
  pixels: Array<[number, number]>;
  /** Model-reported confidence 0..1 */
  confidence: number;
  /** Model-reported class label */
  class: string;
  /** Pixel area of the polygon (for ranking when the model returns multiple) */
  pixelArea: number;
}

export interface RoboflowResult {
  /** All accepted polygons, sorted by descending pixel area. The first
   *  is the "primary" roof — typically the main house. Additional entries
   *  are attached/detached structures (garages, sheds, ADUs) that passed
   *  the confidence + proximity filters. */
  polygons: RoboflowRoofPolygon[];
  source: "roboflow";
  modelSlug: string;
  modelVersion: number;
}

interface RoboflowPrediction {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  class: string;
  class_id: number;
  detection_id: string;
  points?: Array<{ x: number; y: number }>;
}

interface RoboflowResponse {
  inference_id: string;
  time: number;
  image: { width: number; height: number };
  predictions: RoboflowPrediction[];
}

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
}): Promise<{ base64: string } | null> {
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${opts.lat},${opts.lng}&zoom=${IMAGE_ZOOM}&size=${IMAGE_TILE_PX}x${IMAGE_TILE_PX}&scale=${IMAGE_SCALE}&maptype=satellite&key=${opts.apiKey}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString("base64") };
  } catch (err) {
    console.error("[roboflow] static map fetch error:", err);
    return null;
  }
}

/**
 * Shoelace area for a polygon defined as [[x,y], ...]. Sign-agnostic.
 * Used both to rank competing predictions (largest = primary roof) and
 * to drop sliver predictions below a sanity threshold.
 */
function pixelPolygonArea(pts: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/**
 * Douglas-Peucker simplification — local copy until we move the version
 * in `solar-mask.ts` and `grounded-sam.ts` into `polygon.ts` (planned
 * cleanup; doing it now would touch unrelated files in this commit).
 *
 * Epsilon=4px at scale=2 gives ~0.3m of allowable corner shift, which is
 * roughly the noise floor of the model's polygon trace anyway.
 */
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

async function callRoboflow(opts: {
  base64: string;
  model: RoboflowModel;
  apiKey: string;
}): Promise<RoboflowResponse | null> {
  const url = `https://detect.roboflow.com/${opts.model.slug}/${opts.model.version}?api_key=${opts.apiKey}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // Roboflow's hosted inference expects the base64 string as the form
      // body (no key, no JSON wrapping) — see "Inference via base64" in
      // their hosted-API docs.
      body: opts.base64,
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[roboflow] ${opts.model.slug}/${opts.model.version} → ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as RoboflowResponse;
  } catch (err) {
    console.error("[roboflow] inference error:", err);
    return null;
  }
}

/**
 * Public entry point. Runs Roboflow inference on the satellite tile for
 * (lat, lng) and returns one polygon per detected roof structure, sorted
 * by area descending.
 *
 * Returns null when:
 *   - image fetch fails (Google key issue, network)
 *   - inference fails (Roboflow auth, model not deployed, network)
 *   - no predictions meet the confidence + proximity filter
 */
export async function refineRoofWithRoboflow(opts: {
  lat: number;
  lng: number;
  googleMapsKey: string;
  roboflowKey: string;
  model: RoboflowModel;
}): Promise<RoboflowResult | null> {
  const img = await fetchSatelliteImage({
    lat: opts.lat,
    lng: opts.lng,
    apiKey: opts.googleMapsKey,
  });
  if (!img) {
    console.warn("[roboflow] failed to fetch satellite tile");
    return null;
  }

  const resp = await callRoboflow({
    base64: img.base64,
    model: opts.model,
    apiKey: opts.roboflowKey,
  });
  if (!resp || !resp.predictions?.length) {
    console.warn(`[roboflow] no predictions from ${opts.model.slug}/${opts.model.version}`);
    return null;
  }

  // Roboflow reports image dimensions — usually 1280×1280 matching what we
  // sent, but if the model resizes internally the bbox + polygon coords
  // come back in the resized space. Scale to our canvas size before any
  // pixel-to-lat/lng math.
  const respW = resp.image?.width || IMAGE_PIXELS;
  const respH = resp.image?.height || IMAGE_PIXELS;
  const sx = IMAGE_PIXELS / respW;
  const sy = IMAGE_PIXELS / respH;

  const center = IMAGE_PIXELS / 2;
  const allow = opts.model.classAllowlist
    ? new Set(opts.model.classAllowlist.map((s) => s.toLowerCase()))
    : null;

  const accepted: RoboflowRoofPolygon[] = [];
  for (const pred of resp.predictions) {
    if (pred.confidence < MIN_CONFIDENCE) continue;
    if (allow && !allow.has(pred.class.toLowerCase())) continue;
    if (!pred.points || pred.points.length < 3) continue;

    // Reject predictions whose centroid is far from the geocoded address
    const cx = pred.x * sx;
    const cy = pred.y * sy;
    const dist = Math.hypot(cx - center, cy - center);
    if (dist > MAX_CENTER_DIST_PX) continue;

    // Convert prediction polygon to our canvas pixel space, simplify,
    // orthogonalize. Roboflow polygons are typically dense (every couple
    // of pixels along the boundary) — DP simplification is essential
    // before orthogonalization or we get axis-snap artifacts.
    const raw: Array<[number, number]> = pred.points.map((p) => [p.x * sx, p.y * sy]);
    const simplified = douglasPeucker(raw, 4);
    if (simplified.length < 4) continue;
    const orthoResult = bestOrthogonalize({ poly: simplified, toleranceDeg: 14 });
    const ortho = mergeNearbyVertices(orthoResult.polygon, 4);
    if (ortho.length < 4) continue;

    accepted.push({
      pixels: ortho,
      latLng: ortho.map(([x, y]) =>
        pixelToLatLng({
          x, y,
          centerLat: opts.lat,
          centerLng: opts.lng,
        }),
      ),
      confidence: pred.confidence,
      class: pred.class,
      pixelArea: pixelPolygonArea(ortho),
    });
  }

  if (accepted.length === 0) {
    console.warn(`[roboflow] all predictions filtered out (conf<${MIN_CONFIDENCE} or off-center) for ${opts.model.slug}/${opts.model.version}`);
    return null;
  }

  accepted.sort((a, b) => b.pixelArea - a.pixelArea);

  console.log(
    `[roboflow] ${opts.model.slug}/${opts.model.version} → ${accepted.length} polygon(s); primary: ${accepted[0].class} @ ${accepted[0].confidence.toFixed(2)}, ${accepted[0].pixels.length} verts`,
  );

  return {
    polygons: accepted,
    source: "roboflow",
    modelSlug: opts.model.slug,
    modelVersion: opts.model.version,
  };
}

/** Pre-defined candidate models for the bake-off. */
export const CANDIDATE_MODELS: Record<string, RoboflowModel> = {
  satelliteRooftopMap: {
    slug: "satellite-rooftop-map",
    version: 3,
    classAllowlist: ["rooftops", "roof"],
  },
  roofSeg2: {
    slug: "roof-seg-2",
    version: 1,
    classAllowlist: ["roof"],
  },
  roofSegmentationFinal: {
    slug: "roof-segmentation-final",
    version: 2,
    classAllowlist: ["flat", "gable", "hip", "shed", "roof"],
  },
};

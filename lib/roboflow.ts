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

import polygonClipping from "polygon-clipping";
import sharp from "sharp";
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

// Multi-rotation inference: feed the model the same satellite tile at
// multiple orientations and union the results. Roboflow's SegFormer/YOLO
// backbones train with axis-aligned augmentation but still have
// orientation bias — a wing missed at 0° sometimes appears at 90°. Costs
// N inference calls in parallel (~1.5s each); 0° + 90° gives the best
// detail-vs-cost tradeoff. Going to 180°/270° is mostly redundant for
// instance segmentation.
const ROTATION_DEGREES = [0, 90] as const;

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
 * Do two pixel polygons share any area? Used to cluster overlapping
 * Roboflow predictions: when the model splits a single L-shape roof
 * into per-wing predictions, the wings overlap at the ridge. Detached
 * structures (garage 5m away, neighbour) don't overlap, so they stay
 * separate. polygon-clipping handles degenerate cases (touching edges,
 * self-intersecting input) gracefully.
 */
function pixelPolygonsOverlap(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): boolean {
  if (a.length < 3 || b.length < 3) return false;
  const aRing: Array<[number, number]> = [...a, a[0]];
  const bRing: Array<[number, number]> = [...b, b[0]];
  try {
    const result = polygonClipping.intersection([aRing], [bRing]);
    return result.length > 0 && result[0]?.length > 0;
  } catch {
    return false;
  }
}

/**
 * Union N pixel polygons via polygon-clipping. Returns the largest piece
 * (rare but possible to get multiple disjoint outputs when input polygons
 * just-barely-touch). Returns null if all polygons are degenerate or if
 * the library throws on the input.
 */
function unionPixelPolygons(
  polys: Array<Array<[number, number]>>,
): Array<[number, number]> | null {
  if (polys.length === 0) return null;
  if (polys.length === 1) return polys[0];

  const toRing = (p: Array<[number, number]>): Array<[number, number]> =>
    p.length > 0 && (p[0][0] !== p[p.length - 1][0] || p[0][1] !== p[p.length - 1][1])
      ? [...p, p[0]]
      : p;

  let acc: ReturnType<typeof polygonClipping.union>;
  try {
    acc = polygonClipping.union([toRing(polys[0])]);
  } catch {
    return null;
  }
  for (let i = 1; i < polys.length; i++) {
    try {
      acc = polygonClipping.union(acc, [[toRing(polys[i])]]);
    } catch {
      // Skip on degenerate intermediate; keep accumulated result.
    }
  }
  if (!acc || acc.length === 0) return null;

  // Pick largest piece by shoelace area
  let bestRing: Array<[number, number]> | null = null;
  let bestArea = 0;
  for (const piece of acc) {
    const ring = piece[0];
    if (!ring || ring.length < 4) continue;
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    const area = Math.abs(sum) / 2;
    if (area > bestArea) {
      bestArea = area;
      // Drop the closing-vertex duplicate
      bestRing = ring.slice(0, -1) as Array<[number, number]>;
    }
  }
  return bestRing;
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

/**
 * Rotate a base64 PNG by `degrees` clockwise. Sharp preserves dimensions
 * for right-angle rotations of square inputs, so polygon projection stays
 * a clean linear transform (see `unrotatePoint90` below). Returns the
 * rotated image as base64 PNG, or null on encode error.
 */
async function rotateImageBase64(
  base64: string,
  degrees: number,
): Promise<string | null> {
  if (degrees === 0) return base64;
  try {
    const buf = Buffer.from(base64, "base64");
    const out = await sharp(buf).rotate(degrees).png().toBuffer();
    return out.toString("base64");
  } catch (err) {
    console.warn(`[roboflow] rotate ${degrees}° failed:`, err);
    return null;
  }
}

/**
 * Project a polygon vertex from a CW-rotated image frame back to the
 * original-orientation frame. Only handles 0/90/180/270 — the rotation
 * matrix is a permutation+sign-flip in those cases (no float precision loss).
 *
 * Math (image coords, origin top-left, x right, y down — what the model
 * returns and what sharp uses):
 *   90° CW forward:  (x, y) → (N - y, x)
 *   90° CW inverse:  (x', y') → (y', N - x')   ← what we apply here
 *   180° forward:    (x, y) → (N - x, N - y)   (self-inverse)
 *   270° CW forward: (x, y) → (y, N - x)
 *   270° CW inverse: (x', y') → (N - y', x')
 *
 * NOTE: an earlier version of this function had 90° and 270° INVERTED —
 * the formula labeled "inverse" was actually the forward transform.
 * Symptom: 90°-rotation predictions ended up at twice the offset from
 * their true position, slightly off-center; once unioned with the 0°
 * prediction the result spilled over the roof edge with jagged seams.
 * Fixed in commit history.
 */
function unrotatePoint(
  x: number,
  y: number,
  rotationDeg: number,
  N: number,
): [number, number] {
  switch (((rotationDeg % 360) + 360) % 360) {
    case 0:
      return [x, y];
    case 90:
      return [y, N - x];
    case 180:
      return [N - x, N - y];
    case 270:
      return [N - y, x];
    default:
      return [x, y];
  }
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
 * When `osmBuildingPolygon` is provided, the primary polygon gets clipped
 * to it as a Phase-C cleanup step (kills deck/yard creep that Roboflow
 * sometimes includes). The clip only applies when it retains ≥ 70% of the
 * Roboflow area — if OSM is significantly smaller, we assume OSM is
 * outdated/wrong (missing wing, demolished neighbour) and skip the clip.
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
  /** Optional OSM building footprint (lat/lng polygon). When supplied,
   *  the primary polygon is clipped to it (with a 70%-retention safety
   *  check). When omitted, no clip is applied. */
  osmBuildingPolygon?: Array<{ lat: number; lng: number }> | null;
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

  // Multi-rotation inference — run the model on the original tile and on
  // the same tile rotated 90° CW (configurable via ROTATION_DEGREES).
  // Predictions from rotated frames get projected back to the original
  // orientation before downstream filtering / clustering. Each rotation
  // is a separate inference call, fired in parallel for ~1.5s total.
  const rotationCalls = await Promise.all(
    ROTATION_DEGREES.map(async (deg) => {
      const rotatedB64 = await rotateImageBase64(img.base64, deg);
      if (!rotatedB64) return { deg, response: null };
      const response = await callRoboflow({
        base64: rotatedB64,
        model: opts.model,
        apiKey: opts.roboflowKey,
      });
      return { deg, response };
    }),
  );

  // Combine predictions across rotations. Each prediction gets its
  // polygon + bbox center projected back to the 0° frame, so downstream
  // filtering / clustering operates in a single canonical coordinate
  // system. Bounding-box width/height swap on 90°/270° (the model returned
  // the bbox in the rotated frame).
  const combinedPredictions: Array<RoboflowPrediction> = [];
  let respW = IMAGE_PIXELS;
  let respH = IMAGE_PIXELS;
  for (const { deg, response } of rotationCalls) {
    if (!response || !response.predictions?.length) continue;
    respW = response.image?.width || IMAGE_PIXELS;
    respH = response.image?.height || IMAGE_PIXELS;
    if (deg === 0) {
      combinedPredictions.push(...response.predictions);
      continue;
    }
    // Rotation in effect — project each prediction back to 0° frame
    for (const pred of response.predictions) {
      const projectedPoints =
        pred.points?.map((p) => {
          const [px, py] = unrotatePoint(p.x, p.y, deg, respW);
          return { x: px, y: py };
        }) ?? undefined;
      const [cx, cy] = unrotatePoint(pred.x, pred.y, deg, respW);
      const swapWH = deg === 90 || deg === 270;
      combinedPredictions.push({
        ...pred,
        x: cx,
        y: cy,
        width: swapWH ? pred.height : pred.width,
        height: swapWH ? pred.width : pred.height,
        points: projectedPoints,
      });
    }
  }

  if (combinedPredictions.length === 0) {
    console.warn(`[roboflow] no predictions across ${ROTATION_DEGREES.length} rotation(s) for ${opts.model.slug}/${opts.model.version}`);
    return null;
  }

  // Roboflow reports image dimensions — usually 1280×1280 matching what we
  // sent, but if the model resizes internally the bbox + polygon coords
  // come back in the resized space. Scale to our canvas size before any
  // pixel-to-lat/lng math.
  const sx = IMAGE_PIXELS / respW;
  const sy = IMAGE_PIXELS / respH;

  const center = IMAGE_PIXELS / 2;
  const allow = opts.model.classAllowlist
    ? new Set(opts.model.classAllowlist.map((s) => s.toLowerCase()))
    : null;

  const accepted: RoboflowRoofPolygon[] = [];
  for (const pred of combinedPredictions) {
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

  // Primary-polygon ranking. Earlier versions of this code sorted purely by
  // pixelArea descending — that backfires on rural addresses where the model
  // also detects the driveway+overhangs (large but wrong) and the actual
  // roof gets ranked second. The geocoded address lives at the image
  // centre, so a polygon CONTAINING the centre point is almost always the
  // target house. Diagnostic on 5385 Henley Rd, Mt. Juliet TN proved this:
  // four predictions, only one contained the centre (0.81 conf, 2m from
  // address); the other three were 20-42m off and the over-trace hex won
  // the area sort.
  //
  // Ranking now: (a) polygon contains image centre → strong signal,
  //              (b) higher confidence wins,
  //              (c) larger area as final tiebreaker.
  const cxImg = IMAGE_PIXELS / 2;
  const cyImg = IMAGE_PIXELS / 2;
  const containsCenter = (poly: Array<[number, number]>): boolean => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if ((yi > cyImg) !== (yj > cyImg) && cxImg < ((xj - xi) * (cyImg - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
  accepted.sort((a, b) => {
    const aContains = containsCenter(a.pixels);
    const bContains = containsCenter(b.pixels);
    if (aContains !== bContains) return aContains ? -1 : 1;
    if (Math.abs(a.confidence - b.confidence) > 0.05) return b.confidence - a.confidence;
    return b.pixelArea - a.pixelArea;
  });

  // Phase A + B: Cluster + iterative union of overlapping predictions.
  // Roboflow can split a single roof into multiple predictions — one per
  // wing on L/T houses, or front-half/back-half when the ridge is shadowed,
  // OR (with multi-rotation enabled) the same roof seen at 0° and 90°.
  //
  // Iterative-with-area-cap: try to union each overlapping candidate into
  // the primary one at a time. Reject any merge that expands area by more
  // than UNION_AREA_CAP — an over-trace prediction that picks up driveway
  // or yard would balloon the polygon, so we keep the working primary
  // and skip that candidate. (Empirical: on 2144 Carefree Ln a 90°
  // prediction added 60% area = drove polygon down into the driveway.)
  //
  // Predictions with no overlap stay standalone (detached garage, neighbour).
  const UNION_AREA_CAP = 1.4;
  const primaryOriginal = accepted[0];
  const standalone: typeof accepted = [];
  let workingPixels = primaryOriginal.pixels;
  let workingArea = pixelPolygonArea(workingPixels);
  let mergedCount = 1;
  for (let i = 1; i < accepted.length; i++) {
    const cand = accepted[i];
    if (!pixelPolygonsOverlap(workingPixels, cand.pixels)) {
      standalone.push(cand);
      continue;
    }
    const candidateUnion = unionPixelPolygons([workingPixels, cand.pixels]);
    if (!candidateUnion || candidateUnion.length < 4) continue;
    const candidateArea = pixelPolygonArea(candidateUnion);
    if (candidateArea > workingArea * UNION_AREA_CAP) {
      // Merging this candidate would balloon the polygon — skip it. The
      // candidate stays unused (not added to standalone either; it likely
      // describes the same area as the primary, just bigger/wonkier).
      console.log(
        `[roboflow] skip union: would expand area ${(candidateArea / workingArea).toFixed(2)}× (cap ${UNION_AREA_CAP}×)`,
      );
      continue;
    }
    workingPixels = candidateUnion;
    workingArea = candidateArea;
    mergedCount += 1;
  }

  let primary = primaryOriginal;
  if (mergedCount > 1) {
    // Re-simplify the working polygon (union output can have many short
    // edges where input polygons abutted). Skip orthogonalization: the
    // unioned shape may legitimately have non-axis edges from an angled wing.
    const simplified = douglasPeucker(workingPixels, 4);
    if (simplified.length >= 4) {
      const merged = mergeNearbyVertices(simplified, 4);
      if (merged.length >= 4) {
        primary = {
          ...primaryOriginal,
          pixels: merged,
          latLng: merged.map(([x, y]) =>
            pixelToLatLng({
              x, y,
              centerLat: opts.lat,
              centerLng: opts.lng,
            }),
          ),
          pixelArea: pixelPolygonArea(merged),
        };
        console.log(
          `[roboflow] unioned ${mergedCount} overlapping predictions → ${merged.length} verts`,
        );
      }
    }
  }

  // Phase C: OSM intersect cleanup. When an OSM building footprint is
  // provided AND clipping the primary to it retains most of the area,
  // use the clipped polygon (kills deck/driveway creep). When the clip
  // would lose >30% of the area, OSM is likely outdated or off — skip
  // and keep Roboflow's polygon.
  if (opts.osmBuildingPolygon && opts.osmBuildingPolygon.length >= 3) {
    const osmPixels = opts.osmBuildingPolygon.map((p) => {
      const m = M_PER_PX(opts.lat);
      const cosLat = Math.cos((opts.lat * Math.PI) / 180);
      const dx = (p.lng - opts.lng) * 111_320 * cosLat;
      const dy = (p.lat - opts.lat) * 111_320;
      return [IMAGE_PIXELS / 2 + dx / m, IMAGE_PIXELS / 2 - dy / m] as [number, number];
    });
    try {
      const primaryRing: Array<[number, number]> = [...primary.pixels, primary.pixels[0]];
      const osmRing: Array<[number, number]> = [...osmPixels, osmPixels[0]];
      const clipped = polygonClipping.intersection([primaryRing], [osmRing]);
      if (clipped.length > 0 && clipped[0][0] && clipped[0][0].length >= 4) {
        // Take the largest clip piece (rare to have multiple, but possible)
        let bestRing: Array<[number, number]> | null = null;
        let bestArea = 0;
        for (const piece of clipped) {
          const ring = piece[0];
          if (!ring || ring.length < 4) continue;
          let sum = 0;
          for (let i = 0; i < ring.length - 1; i++) {
            sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
          }
          const a = Math.abs(sum) / 2;
          if (a > bestArea) {
            bestArea = a;
            bestRing = ring.slice(0, -1) as Array<[number, number]>;
          }
        }
        if (bestRing && bestArea >= primary.pixelArea * 0.7) {
          // Clip retained ≥70% of Roboflow's area — accept the clip
          const simplifiedClip = douglasPeucker(bestRing, 4);
          const mergedClip = mergeNearbyVertices(simplifiedClip, 4);
          if (mergedClip.length >= 4) {
            primary = {
              ...primary,
              pixels: mergedClip,
              latLng: mergedClip.map(([x, y]) =>
                pixelToLatLng({ x, y, centerLat: opts.lat, centerLng: opts.lng }),
              ),
              pixelArea: pixelPolygonArea(mergedClip),
            };
            console.log(
              `[roboflow] OSM clip applied → ${mergedClip.length} verts, ${(bestArea / pixelPolygonArea(workingPixels) * 100).toFixed(0)}% retention`,
            );
          }
        } else {
          console.log(
            `[roboflow] OSM clip skipped: would retain only ${((bestArea / primary.pixelArea) * 100).toFixed(0)}% (< 70% threshold)`,
          );
        }
      }
    } catch (err) {
      console.warn("[roboflow] OSM clip failed:", err);
    }
  }

  const finalPolygons = [primary, ...standalone];
  console.log(
    `[roboflow] ${opts.model.slug}/${opts.model.version} → ${finalPolygons.length} polygon(s); primary: ${primary.class} @ ${primary.confidence.toFixed(2)}, ${primary.pixels.length} verts, containsAddr=${containsCenter(primary.pixels)}`,
  );

  return {
    polygons: finalPolygons,
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

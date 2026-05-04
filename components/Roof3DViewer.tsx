"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Box, RotateCw, Pause, Play, Crosshair, Sparkles } from "lucide-react";
import { bestOrthogonalize, mergeNearbyVertices } from "@/lib/polygon";

interface Props {
  lat: number;
  lng: number;
  address?: string;
  /** Roof polygon(s) in lat/lng. When supplied, drawn as a glowing outline
   *  draped over the 3D mesh using Cesium's CESIUM_3D_TILE classification. */
  polygons?: Array<Array<{ lat: number; lng: number }>>;
  /** Provenance — polygons sourced from "ai" (Claude vision) are typically
   *  inaccurate, so we render their outline at lower opacity to avoid drawing
   *  attention to a wonky shape. */
  polygonSource?:
    | "edited"
    | "tiles3d"
    | "solar-mask"
    | "roboflow"
    | "solar"
    | "sam"
    | "osm"
    | "microsoft-buildings"
    | "ai";
  /** Fired once we've extracted a roof polygon from the 3D Tiles mesh by
   *  sampling elevations and thresholding above ground. Highest-quality
   *  source we have for any property in 3D Tiles coverage — uses real
   *  geometric height data rather than 2D AI guessing on the satellite tile. */
  onTilesPolygonDetected?: (polygon: Array<{ lat: number; lng: number }>) => void;
  /** Pattern-A 3D fusion: when a non-tiles3d polygon is rendered (Roboflow,
   *  OSM, MS Buildings, etc.), we sample the 3D mesh heights INSIDE the
   *  polygon and report what fraction of those samples are at "roof
   *  height" (ground+2m to ground+10m). A polygon traced over an actual
   *  roof scores ~0.8-1.0; a polygon traced over a driveway/lawn/wrong
   *  building scores < 0.3. Caller can demote low-scoring sources in
   *  the priority chain so a confident Roboflow polygon doesn't get
   *  shipped when the mesh says it's mostly on the ground. */
  onPolygonValidated?: (score: number, samples: number) => void;
}

const PALETTE = [
  "#67dcff", // cyan
  "#5fe3b0", // mint
  "#c8a4ff", // lavender
  "#ffc878", // gold
  "#ffa8d9", // pink
  "#88e6ff", // sky
];

const CESIUM_VERSION = "1.141.0";
const CESIUM_BASE = `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VERSION}/Build/Cesium/`;

// Cesium is loaded entirely from CDN as a UMD bundle attached to window.Cesium.
// We never `import 'cesium'` — that would pull Cesium's WASM through Turbopack's
// strict-mode parser, which chokes on the binary blob (octal-escape error).
// The CDN bundle keeps WASM as binary fetched at runtime by Cesium itself.
type CesiumGlobal = typeof import("cesium");
declare global {
  interface Window {
    Cesium?: CesiumGlobal;
    CESIUM_BASE_URL?: string;
  }
}

// ============================================================================
// 3D Tiles → roof polygon extraction
// ----------------------------------------------------------------------------
// Sample elevations on a grid around the property, threshold "above ground"
// to find roof pixels, trace the connected component containing the
// centerpoint, simplify, orthogonalize. Pure geometric truth from the
// photogrammetric mesh — no AI, no satellite-image guessing.
// ============================================================================

const EXTRACT_RADIUS_M = 30;
const EXTRACT_GRID = 60; // 60x60 = 3,600 samples at 1m spacing
const ROOF_HEIGHT_MIN_M = 2.2; // anything > ground + this is roof candidate
// Cap roof "ceiling" — anything taller than ground + this is a TREE, not a roof.
// Typical residential 1-story roof peaks at ~5m above ground, 2-story at ~7-8m.
// We pick 10m as a generous cap that catches all reasonable residential roofs
// while excluding mature shade trees (often 12-15m+ in the Southeast US).
// Diagnosed on 5385 Henley Rd, Mt. Juliet TN: 95th-percentile ceiling was 17m
// above ground (a tall tree), causing the connected-component step to lock
// onto a tree blob instead of the actual roof.
const ROOF_HEIGHT_MAX_M = 10;

/** Convert (lat, lng, gridIndex) to a Cesium Cartographic at the cell center. */
function buildSamplingGrid(
  Cesium: CesiumGlobal,
  centerLat: number,
  centerLng: number,
): {
  carto: import("cesium").Cartographic[];
  gridSize: number;
  bbox: { south: number; north: number; west: number; east: number };
} {
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const dLat = EXTRACT_RADIUS_M / 111_320;
  const dLng = EXTRACT_RADIUS_M / (111_320 * cosLat);
  const south = centerLat - dLat;
  const north = centerLat + dLat;
  const west = centerLng - dLng;
  const east = centerLng + dLng;
  const carto: import("cesium").Cartographic[] = [];
  for (let row = 0; row < EXTRACT_GRID; row++) {
    for (let col = 0; col < EXTRACT_GRID; col++) {
      const lat = south + ((north - south) * (row + 0.5)) / EXTRACT_GRID;
      const lng = west + ((east - west) * (col + 0.5)) / EXTRACT_GRID;
      carto.push(Cesium.Cartographic.fromDegrees(lng, lat));
    }
  }
  return { carto, gridSize: EXTRACT_GRID, bbox: { south, north, west, east } };
}

/** Flood-fill the connected component containing the center pixel (or the
 *  nearest "on" pixel to it). Returns a mask containing ONLY that component. */
/**
 * Pick the largest connected component whose centroid is within
 * `proximityRadiusCells` of the image center, and return a mask
 * containing ONLY that component. Falls back to "component containing
 * center pixel" when no large nearby component is found.
 *
 * Why pick by area+proximity instead of just "component containing
 * center": on wooded rural properties, trees often scatter small
 * connected components NEAR the geocoded address — sometimes one
 * happens to land on the center pixel. The original "seed at center"
 * strategy would lock onto that tree component and miss the actual
 * roof a few cells away. Picking the LARGEST nearby component is a
 * stronger signal for "this is the building" because trees are
 * typically <100 cells while a residential roof is 200+ cells.
 *
 * MIN_COMPONENT_CELLS gates which components are even considered —
 * tiny tree blobs (chimneys, antennas, single tree branches above
 * threshold) get filtered out entirely.
 */
function isolateCenterComponent(
  mask: Uint8Array,
  width: number,
  height: number,
  proximityRadiusCells = 20,
  minComponentCells = 80,
): Uint8Array | null {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);

  // First pass: label connected components. visited[i] = component id (1+) or 0 = unvisited.
  const visited = new Uint16Array(mask.length);
  let nextId = 1;
  const components: Array<{
    id: number;
    cells: number;
    sumX: number;
    sumY: number;
  }> = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!mask[idx] || visited[idx]) continue;
      // Flood-fill this component
      const id = nextId++;
      const stack: number[] = [idx];
      let cells = 0, sumX = 0, sumY = 0;
      while (stack.length) {
        const i = stack.pop()!;
        if (visited[i] || !mask[i]) continue;
        visited[i] = id;
        cells++;
        const ix = i % width;
        const iy = (i - ix) / width;
        sumX += ix;
        sumY += iy;
        if (ix > 0) stack.push(i - 1);
        if (ix < width - 1) stack.push(i + 1);
        if (iy > 0) stack.push(i - width);
        if (iy < height - 1) stack.push(i + width);
      }
      components.push({ id, cells, sumX, sumY });
    }
  }

  if (components.length === 0) return null;

  // Pick largest component within proximity radius (centroid distance)
  let best: typeof components[number] | null = null;
  for (const c of components) {
    if (c.cells < minComponentCells) continue;
    const ccx = c.sumX / c.cells;
    const ccy = c.sumY / c.cells;
    const dist = Math.hypot(ccx - cx, ccy - cy);
    if (dist > proximityRadiusCells) continue;
    if (!best || c.cells > best.cells) best = c;
  }

  // Fallback: component containing center pixel, if nothing matched
  if (!best) {
    const centerComponent = visited[cy * width + cx];
    if (centerComponent > 0) {
      best = components.find((c) => c.id === centerComponent) ?? null;
    }
  }

  if (!best) return null;

  const out = new Uint8Array(mask.length);
  for (let i = 0; i < visited.length; i++) {
    if (visited[i] === best.id) out[i] = 1;
  }
  return out;
}

/** Morphological close (dilate then erode) to fill 1-pixel gaps from
 *  noisy sampling. Then fill interior holes (chimneys, skylights). */
function cleanMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  const dilate = (m: Uint8Array): Uint8Array => {
    const out = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let on = 0;
        for (let dy = -1; dy <= 1 && !on; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (m[ny * w + nx]) { on = 1; break; }
          }
        }
        out[y * w + x] = on;
      }
    }
    return out;
  };
  const erode = (m: Uint8Array): Uint8Array => {
    const out = new Uint8Array(m.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let off = 0;
        for (let dy = -1; dy <= 1 && !off; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) { off = 1; break; }
            if (!m[ny * w + nx]) { off = 1; break; }
          }
        }
        out[y * w + x] = off ? 0 : 1;
      }
    }
    return out;
  };
  // Close = dilate then erode
  const closed = erode(dilate(mask));
  // Fill holes via border flood fill of background, anything not reached = hole
  const visited = new Uint8Array(closed.length);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    if (!closed[x]) stack.push(x);
    if (!closed[(h - 1) * w + x]) stack.push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    if (!closed[y * w]) stack.push(y * w);
    if (!closed[y * w + (w - 1)]) stack.push(y * w + (w - 1));
  }
  while (stack.length) {
    const idx = stack.pop()!;
    if (visited[idx] || closed[idx]) continue;
    visited[idx] = 1;
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }
  for (let i = 0; i < closed.length; i++) {
    if (!closed[i] && !visited[i]) closed[i] = 1;
  }
  return closed;
}

/** Moore-neighbor boundary trace */
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
    const num = Math.abs(
      (b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0],
    );
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

interface ExtractedRoofPolygon {
  latLng: Array<{ lat: number; lng: number }>;
  groundHeightM: number;
  roofHeightM: number;
}

/**
 * Sample elevations on a grid from the loaded 3D tileset, threshold "above
 * ground" to build a binary roof mask, trace the boundary of the component
 * containing the property center, simplify and orthogonalize, project back
 * to lat/lng. The fundamental fix: uses real height data from the
 * photogrammetric mesh rather than guessing roof boundaries from a flat
 * satellite image.
 */
async function extractRoofPolygonFromTiles(opts: {
  Cesium: CesiumGlobal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewer: any;
  centerLat: number;
  centerLng: number;
}): Promise<ExtractedRoofPolygon | null> {
  const { Cesium, viewer, centerLat, centerLng } = opts;
  console.log(
    `[Roof3DViewer] extract starting at ${centerLat.toFixed(5)}, ${centerLng.toFixed(5)}`,
  );
  const grid = buildSamplingGrid(Cesium, centerLat, centerLng);

  // Sample heights from the loaded 3D tileset. This forces all relevant
  // tiles to load before resolving — can take 1-3s the first time.
  let sampled: import("cesium").Cartographic[];
  try {
    sampled = await viewer.scene.sampleHeightMostDetailed(grid.carto);
  } catch (err) {
    console.warn("[Roof3DViewer] sampleHeightMostDetailed failed:", err);
    return null;
  }

  // Pull heights into a flat array; mark missing samples as ground height
  const heights = new Float32Array(EXTRACT_GRID * EXTRACT_GRID);
  let validCount = 0;
  for (let i = 0; i < sampled.length; i++) {
    const h = sampled[i]?.height;
    if (typeof h === "number" && Number.isFinite(h)) {
      heights[i] = h;
      validCount++;
    } else {
      heights[i] = NaN;
    }
  }
  if (validCount < heights.length * 0.5) {
    console.warn(
      `[Roof3DViewer] only ${validCount}/${heights.length} samples valid — likely no 3D Tiles coverage`,
    );
    return null;
  }

  // Estimate ground level: 10th percentile of valid heights.
  const sorted = Array.from(heights).filter((h) => Number.isFinite(h)).sort((a, b) => a - b);
  const groundHeight = sorted[Math.floor(sorted.length * 0.1)];
  // Roof ceiling = HARD CAP at ground + ROOF_HEIGHT_MAX_M (10m), regardless of
  // what the percentile suggests. The previous "95th percentile of all heights"
  // approach broke on wooded properties: tall trees pushed the ceiling to
  // 15-17m above ground, so the mask included tree canopies, and the
  // connected-component step locked onto a tree blob near the geocoded center
  // instead of the actual roof. Hard-capping kills trees > 10m before they
  // contaminate the mask.
  const ceilingHeight = groundHeight + ROOF_HEIGHT_MAX_M;

  // Threshold to binary roof mask. h ∈ [ground + 2.2m, ground + 10m] = roof
  // candidate. Below 2.2m = ground noise / shrubs / vehicles. Above 10m = trees.
  const mask = new Uint8Array(EXTRACT_GRID * EXTRACT_GRID);
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (!Number.isFinite(h)) continue;
    if (h > groundHeight + ROOF_HEIGHT_MIN_M && h <= ceilingHeight) {
      mask[i] = 1;
    }
  }

  // Clean (close + hole-fill), isolate the component containing center.
  // proximityRadiusCells: bumped from 20 → 30 because rural geocoded
  // addresses are often parcel-centroid or street-frontage points, not
  // building-center points. A 20-cell (=20m) radius excluded the actual
  // house when its centroid was 25-30m from the geocoded address, leaving
  // only a small shed near the address as the "largest nearby" component.
  const cleaned = cleanMask(mask, EXTRACT_GRID, EXTRACT_GRID);
  const isolated = isolateCenterComponent(cleaned, EXTRACT_GRID, EXTRACT_GRID, 30);
  if (!isolated) {
    console.warn("[Roof3DViewer] no roof component near centerpoint");
    return null;
  }
  let area = 0;
  for (let i = 0; i < isolated.length; i++) if (isolated[i]) area++;
  // Validation gate: residential roofs are at minimum ~80m² (~860 sqft)
  // for the tiniest tiny-houses. Anything smaller is a shed, gazebo, or
  // detection noise — REJECT so Roboflow / lower-priority sources can win
  // instead of shipping a wrong tiny polygon to the rep. (The 30-cell
  // threshold below was too permissive; many false positives squeaked by.)
  if (area < 80) {
    console.warn(
      `[Roof3DViewer] component too small to be a residence (${area} cells = ~${area}m²); rejecting so Roboflow can win`,
    );
    return null;
  }

  // Trace, simplify, orthogonalize, merge dups.
  // Fallback chain: ortho (best) → simplified → raw boundary. On rural
  // properties with coarse photogrammetric mesh, the boundary trace can
  // produce an irregular shape that DP+ortho compress all the way down
  // to a line segment (2 vertices). When that happens we keep the less
  // pretty but at-least-valid earlier stages of the pipeline rather than
  // losing the source entirely. (Verified on 5385 Henley Rd, Mt. Juliet
  // TN — ortho collapsed to 2 verts, simplified had ~12, raw had ~40.)
  const boundary = traceBoundary(isolated, EXTRACT_GRID, EXTRACT_GRID);
  if (!boundary) {
    console.warn("[Roof3DViewer] boundary trace returned no perimeter");
    return null;
  }
  const simplified = douglasPeucker(boundary, 1.2);
  const orthoResult = bestOrthogonalize({ poly: simplified, toleranceDeg: 14 });
  const orthoMerged = mergeNearbyVertices(orthoResult.polygon, 1);

  let ortho: Array<[number, number]>;
  if (orthoMerged.length >= 4) {
    ortho = orthoMerged;
  } else if (simplified.length >= 4) {
    console.warn(
      `[Roof3DViewer] ortho collapsed to ${orthoMerged.length} verts; falling back to simplified ${simplified.length}-vert polygon`,
    );
    ortho = simplified;
  } else if (boundary.length >= 4) {
    console.warn(
      `[Roof3DViewer] simplify+ortho both collapsed; falling back to raw boundary (${boundary.length} verts)`,
    );
    ortho = boundary;
  } else {
    console.warn(
      `[Roof3DViewer] all reduction stages produced <4 vertices (boundary=${boundary.length}, simplified=${simplified.length}, ortho=${orthoMerged.length})`,
    );
    return null;
  }

  // Project grid (col, row) → lat/lng using the bbox we built the grid from
  const { south, north, west, east } = grid.bbox;
  const dLat = north - south;
  const dLng = east - west;
  const latLng = ortho.map(([col, row]) => ({
    lng: west + ((col + 0.5) / EXTRACT_GRID) * dLng,
    lat: south + ((row + 0.5) / EXTRACT_GRID) * dLat,
  }));

  console.log(
    `[Roof3DViewer] extracted ${ortho.length}-vertex polygon; ground=${groundHeight.toFixed(1)}m, roof≈${(ceilingHeight).toFixed(1)}m, area=${area} cells`,
  );

  return { latLng, groundHeightM: groundHeight, roofHeightM: ceilingHeight };
}

// ============================================================================
// Pattern A: 3D-mesh validation of a 2D-source polygon
// ----------------------------------------------------------------------------
// Sample mesh heights at points inside a candidate polygon, report what
// fraction land at "roof height" (ground+2m to ground+10m). Caller uses
// the score to demote low-confidence sources — a Roboflow polygon traced
// over a driveway or lawn shows up as fraction < 0.3 here, where a polygon
// correctly on a roof shows as 0.8+.
// ============================================================================

interface ValidationResult {
  score: number;        // 0..1; fraction of samples at roof height
  samples: number;      // total samples taken
  groundHeightM: number;
  roofMin: number;      // ground + 2m
  roofMax: number;      // ground + 10m
}

/** Polygon point-in-polygon (ray cast in lat/lng, accurate at house scale). */
function pointInPolygonLatLng(
  lat: number,
  lng: number,
  poly: Array<{ lat: number; lng: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat;
    const xj = poly[j].lng, yj = poly[j].lat;
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

async function validatePolygonAgainstMesh(opts: {
  Cesium: CesiumGlobal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewer: any;
  polygon: Array<{ lat: number; lng: number }>;
}): Promise<ValidationResult | null> {
  const { Cesium, viewer, polygon } = opts;
  if (polygon.length < 3) return null;

  // Build a sampling grid over the polygon's bbox, then keep only points
  // inside the polygon. ~40-100 samples is plenty to detect "is this on
  // a roof at all" without burning a budget on Cesium height queries.
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const p of polygon) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  // 10×10 grid = 100 candidate points; ~30-70 typically inside polygon
  const SAMPLES_PER_AXIS = 10;
  const carto: import("cesium").Cartographic[] = [];
  for (let i = 0; i < SAMPLES_PER_AXIS; i++) {
    for (let j = 0; j < SAMPLES_PER_AXIS; j++) {
      const lat = minLat + ((maxLat - minLat) * (i + 0.5)) / SAMPLES_PER_AXIS;
      const lng = minLng + ((maxLng - minLng) * (j + 0.5)) / SAMPLES_PER_AXIS;
      if (pointInPolygonLatLng(lat, lng, polygon)) {
        carto.push(Cesium.Cartographic.fromDegrees(lng, lat));
      }
    }
  }
  if (carto.length < 4) return null;

  let sampled: import("cesium").Cartographic[];
  try {
    sampled = await viewer.scene.sampleHeightMostDetailed(carto);
  } catch {
    return null;
  }

  const heights = sampled
    .map((c) => c?.height)
    .filter((h): h is number => typeof h === "number" && Number.isFinite(h));
  if (heights.length < 4) return null;

  // Estimate ground from the LOWEST samples — when the polygon mostly covers
  // a roof, "lowest samples" are the eaves at ground+2-3m, not 0. So we
  // sample BEYOND the polygon for true ground reference. Cheap version:
  // just use the 5th-percentile of all samples taken; if the polygon is
  // mostly roof this will be near eave height (~ground+2), if mostly lawn
  // it'll be near actual ground. The math still works either way for the
  // % roof-height calculation.
  const sortedH = [...heights].sort((a, b) => a - b);
  // Use the global lowest from a wider grid: query a few points outside
  // the polygon's bbox to anchor "true ground." Skip for now in the
  // interest of simplicity; the 5th percentile as ground is conservative
  // (gives a higher-than-actual ground, which makes the roof-height
  // window relatively narrower — false negatives, never false positives).
  const groundHeight = sortedH[Math.floor(sortedH.length * 0.05)];
  const roofMin = groundHeight + 2;
  const roofMax = groundHeight + 10;

  let atRoofHeight = 0;
  for (const h of heights) {
    if (h >= roofMin && h <= roofMax) atRoofHeight++;
  }
  return {
    score: atRoofHeight / heights.length,
    samples: heights.length,
    groundHeightM: groundHeight,
    roofMin,
    roofMax,
  };
}


let cesiumLoadPromise: Promise<CesiumGlobal> | null = null;
function loadCesium(): Promise<CesiumGlobal> {
  if (typeof window === "undefined") return Promise.reject(new Error("ssr"));
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (cesiumLoadPromise) return cesiumLoadPromise;

  window.CESIUM_BASE_URL = CESIUM_BASE;

  cesiumLoadPromise = new Promise((resolve, reject) => {
    // Stylesheet
    if (!document.querySelector("link[data-cesium-widgets]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${CESIUM_BASE}Widgets/widgets.css`;
      link.setAttribute("data-cesium-widgets", "true");
      document.head.appendChild(link);
    }
    // Runtime
    const existing = document.querySelector<HTMLScriptElement>(
      "script[data-cesium-runtime]",
    );
    const onReady = () => {
      if (window.Cesium) resolve(window.Cesium);
      else reject(new Error("Cesium loaded but window.Cesium missing"));
    };
    if (existing) {
      if (window.Cesium) onReady();
      else existing.addEventListener("load", onReady);
      return;
    }
    const script = document.createElement("script");
    script.src = `${CESIUM_BASE}Cesium.js`;
    script.async = true;
    script.setAttribute("data-cesium-runtime", "true");
    script.addEventListener("load", onReady);
    script.addEventListener("error", () =>
      reject(new Error("Cesium CDN script failed to load")),
    );
    document.head.appendChild(script);
  });
  return cesiumLoadPromise;
}

/**
 * Interactive 3D viewer over Google Photorealistic 3D Tiles.
 *
 * Renders the actual photogrammetric mesh of the property — same data Google
 * Earth uses — and drapes the roof polygon(s) onto the rooftop surface as
 * colored, glowing classifications. Auto-orbits the camera; click to pause.
 *
 * Cesium is loaded from CDN at runtime (not bundled). Requires
 * NEXT_PUBLIC_GOOGLE_MAPS_KEY with the Map Tiles API enabled in Google Cloud.
 */
export default function Roof3DViewer({
  lat,
  lng,
  address,
  polygons,
  polygonSource,
  onTilesPolygonDetected,
  onPolygonValidated,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const polygonEntitiesRef = useRef<unknown[]>([]);
  const tickHandlerRef = useRef<(() => void) | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const recenterRef = useRef<(() => void) | null>(null);
  const markerEntityRef = useRef<unknown>(null);
  // Pivot altitude (meters above WGS84 ellipsoid) for the camera orbit.
  // Defaults to 200m as a "more right than wrong" first-frame value: works
  // for most US locations from sea level to ~500m ground elevation. Once
  // the 3D Tiles extraction finishes, we sample the ACTUAL mesh ground
  // height and update this ref so the orbit pivots at the real roof level.
  // The original 30m default put the pivot underground anywhere inland
  // (Mt. Juliet TN at 170m elevation → pivot 140m underground → orbit
  // sweeps through the ground).
  const pivotAltitudeRef = useRef(200);
  const onTilesCallbackRef = useRef(onTilesPolygonDetected);
  onTilesCallbackRef.current = onTilesPolygonDetected;
  const onValidatedRef = useRef(onPolygonValidated);
  onValidatedRef.current = onPolygonValidated;
  // Cache of validated polygons so we don't re-validate the same polygon
  // every render. Keyed by source + first-vertex hash.
  const validatedPolygonRef = useRef<string | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "no-coverage" | "error">(
    "loading",
  );
  const [extracting, setExtracting] = useState(false);
  const [orbiting, setOrbiting] = useState(true);
  const orbitingRef = useRef(true);
  orbitingRef.current = orbiting;

  // -------- viewer init (runs once per mount) --------
  useEffect(() => {
    let cancelled = false;
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
    if (!apiKey) {
      setStatus("error");
      return;
    }

    (async () => {
      let Cesium: CesiumGlobal;
      try {
        Cesium = await loadCesium();
      } catch (err) {
        console.error("[Roof3DViewer] failed to load Cesium runtime:", err);
        if (!cancelled) setStatus("error");
        return;
      }
      if (cancelled || !containerRef.current) return;

      Cesium.GoogleMaps.defaultApiKey = apiKey;

      const viewer = new Cesium.Viewer(containerRef.current, {
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        animation: false,
        timeline: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
      });
      viewerRef.current = viewer;

      // Fade out the default star/sun/atmosphere — we want the rooftop, not space
      if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
      if (viewer.scene.sun) viewer.scene.sun.show = false;
      if (viewer.scene.moon) viewer.scene.moon.show = false;
      if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
      viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#070a10");
      viewer.scene.globe.show = false;
      // Hide Cesium's credit container entirely — by default it surfaces
      // "Powered by Google's Project Sunroof" + other dataset tags from the
      // 3D Tiles attributions. Keeping it dimmed (opacity 0.6) wasn't enough
      // to scrub the third-party tells from the proprietary UI.
      const cc = viewer.cesiumWidget.creditContainer as HTMLElement;
      cc.style.display = "none";
      cc.style.visibility = "hidden";
      cc.style.height = "0";
      cc.style.overflow = "hidden";

      // Camera controls left at Cesium defaults — user feedback was that the
      // tamed-inertia / no-look / clamped-zoom version felt worse than stock.
      // Stock controls: inertiaSpin/Translate/Zoom ≈ 0.9, free-look enabled,
      // zoom unbounded. Reverted on user request.

      try {
        const tileset = await Cesium.createGooglePhotorealistic3DTileset();
        if (cancelled) return;
        // Tighter LOD: the default maximumScreenSpaceError is 16 (low-detail
        // friendly). At residential property scale that means we get blurry
        // partially-rendered tiles for several seconds while the camera
        // settles. Drop to 8 — Google streams higher-resolution tiles
        // earlier and the "smear" effect resolves much faster.
        tileset.maximumScreenSpaceError = 8;
        viewer.scene.primitives.add(tileset);
        setStatus("ready");

        // Add a red ground-pin marker at the target address so every captured
        // multi-view image has the target unambiguously marked. Claude uses
        // this to disambiguate the right house from neighbours.
        const addMarker = () => {
          if (markerEntityRef.current) return;
          const ent = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(lng, lat, 0),
            point: {
              pixelSize: 18,
              color: Cesium.Color.fromCssColorString("#ff2828"),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 3,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
          markerEntityRef.current = ent;
        };
        addMarker();

        // Kick off the polygon extraction. Runs in the background so the
        // viewer is interactive while we sample 3,600 height points and
        // trace the roof boundary. ~2-4s end-to-end on first load.
        //
        // Side-benefit: `result.groundHeightM` is the mesh-sampled ground
        // elevation at the property — exactly what we need to fix the
        // camera orbit pivot. Default pivot was 30m above the WGS84
        // ellipsoid, which lands underground for any property above sea
        // level (Mt. Juliet TN at 170m → pivot 140m underground →
        // orbit sweeps through the ground). Once we know the real
        // ground height, we update pivotAltitudeRef and re-recenter.
        setExtracting(true);
        const extractPromise = extractRoofPolygonFromTiles({
          Cesium,
          viewer,
          centerLat: lat,
          centerLng: lng,
        })
          .then((result) => {
            if (cancelled) return;
            if (result && onTilesCallbackRef.current) {
              onTilesCallbackRef.current(result.latLng);
            }
            if (result && Number.isFinite(result.groundHeightM)) {
              // Pivot 5m above ground — keeps the rooftop centred in
              // frame for typical 1- and 2-story residential homes.
              pivotAltitudeRef.current = result.groundHeightM + 5;
              recenterRef.current?.();
            }
          })
          .catch((err) => console.warn("[Roof3DViewer] extract failed:", err))
          .finally(() => {
            if (!cancelled) setExtracting(false);
          });

        // After geometric extraction settles (or fails), run the multi-view
        // Claude analysis as the authoritative source. Claude can disambiguate
        // the target house from neighbours using the marker we render in
        // every view, AND triple-check from 4 cardinal angles. ~6-10s extra.
        // tiles3d-vision (Claude on multi-angle 3D mesh renders) was wired
        // here previously but consistently produced over-traced rectangles
        // even after camera pull-back + verification pass. Removed entirely;
        // see git history for the runMultiViewAnalysis flow if you want to
        // revive it later.
      } catch (err) {
        console.warn("[Roof3DViewer] no 3D Tiles coverage:", err);
        if (!cancelled) setStatus("no-coverage");
        return;
      }

      // Camera framing: 110 m range at -42° pitch on the corrected pivot.
      // The previous 180m / -35° was the "Goldilocks" tuning ON TOP of the
      // broken underground pivot — when the pivot was 140m below ground,
      // the broken-but-balanced view actually framed the building OK
      // (camera ended up just-above-ground). Now that the pivot is at the
      // actual roof level (groundHeightM + 5m), the old 180m range pulls
      // the camera 100m+ above ground; manual tilt-up sends it to space
      // and the building disappears from frame. 110m / -42° puts the
      // camera ~74m above ground, ~82m horizontal — closer drone-hover
      // feel where the building fills the frame and a manual tilt still
      // keeps the property in view.
      //
      // Pivot ALTITUDE comes from `pivotAltitudeRef` — meters above the
      // WGS84 ellipsoid. Initial default 200m is a coarse fallback; once
      // extractRoofPolygonFromTiles samples the real mesh ground height
      // (a few seconds in), we update the ref to (groundHeightM + 5m) and
      // re-pivot so the orbit centres on the actual roof.
      const recenter = () => {
        const center = Cesium.Cartesian3.fromDegrees(
          lng,
          lat,
          pivotAltitudeRef.current,
        );
        const transform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
        viewer.camera.lookAtTransform(
          transform,
          new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-42), 110),
        );
      };
      recenterRef.current = recenter;
      recenter();

      // Auto-orbit: rotate around the property at constant rate. Click cancels.
      armTimerRef.current = window.setTimeout(() => {
        if (cancelled) return;
        const tickHandler = () => {
          if (orbitingRef.current) viewer.camera.rotateRight(0.0018);
        };
        viewer.scene.preRender.addEventListener(tickHandler);
        tickHandlerRef.current = tickHandler;
      }, 600);

      viewer.screenSpaceEventHandler.setInputAction(() => {
        setOrbiting(false);
      }, Cesium.ScreenSpaceEventType.LEFT_DOWN);
    })().catch((err) => {
      console.error("[Roof3DViewer] init failed:", err);
      if (!cancelled) setStatus("error");
    });

    return () => {
      cancelled = true;
      if (armTimerRef.current) {
        window.clearTimeout(armTimerRef.current);
        armTimerRef.current = null;
      }
      const viewer = viewerRef.current as
        | {
            destroy: () => void;
            scene: { preRender: { removeEventListener: (h: () => void) => void } };
          }
        | null;
      if (viewer) {
        if (tickHandlerRef.current) {
          try {
            viewer.scene.preRender.removeEventListener(tickHandlerRef.current);
          } catch {
            /* already torn down */
          }
          tickHandlerRef.current = null;
        }
        try {
          viewer.destroy();
        } catch {
          /* viewer may already be torn down */
        }
      }
      viewerRef.current = null;
      polygonEntitiesRef.current = [];
    };
    // We deliberately omit lat/lng — re-init on coord change tears the whole
    // viewer down. The flyTo effect below handles minor coordinate updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------- recenter when lat/lng changes (without rebuilding viewer) --------
  // Reset pivotAltitudeRef to the conservative default — we don't know
  // the new property's ground height yet, and any previous value (set by
  // the previous extract) is from the wrong location. The next extract
  // call will refine to the actual mesh height.
  useEffect(() => {
    if (status !== "ready") return;
    pivotAltitudeRef.current = 200;
    recenterRef.current?.();
  }, [lat, lng, status]);

  // -------- redraw polygons when they change --------
  useEffect(() => {
    const viewer = viewerRef.current as
      | { entities: { add: (o: unknown) => unknown; remove: (e: unknown) => void } }
      | null;
    if (!viewer || status !== "ready") return;
    const Cesium = window.Cesium;
    if (!Cesium) return;

    for (const e of polygonEntitiesRef.current) {
      try {
        viewer.entities.remove(e);
      } catch {
        /* already removed */
      }
    }
    polygonEntitiesRef.current = [];
    if (!polygons || polygons.length === 0) return;

    // Outline ONLY — no fill polygon. With a filled `Polygon` +
    // CESIUM_3D_TILE classification, Cesium creates a vertical prism above
    // the polygon and paints every 3D Tile surface inside it: roof, walls,
    // ground. That made the 3D viewer look like the WHOLE HOUSE was wrapped
    // in colored film. The outline polyline is enough to mark the roof.
    // Visual treatment per source quality. SAM/OSM/Solar/edited: bold filled
    // polygon (paints the whole roof blue) + bright glowing outline. AI
    // (Claude) source: dim, no fill — the polygon is usually wrong for AI,
    // and a vivid wonky overlay ruins an otherwise clean photogrammetric view.
    // Visual treatment per source quality. The 0.35-alpha cyan fill used
    // to "paint" the entire roof solid — looked fake and hid the actual
    // photogrammetric texture. Now: thin glowing outline only by default,
    // so the real roof shows through. High-conf sources get a faint 0.08
    // tint just to confirm "this is what we measured."
    const isLowConf = polygonSource === "ai";
    const fillAlpha = isLowConf ? 0 : 0.08;
    const outlineWidth = isLowConf ? 2 : 5;
    const outlineAlpha = isLowConf ? 0.45 : 0.95;
    const glowPower = isLowConf ? 0.15 : 0.5;

    polygons.forEach((poly, idx) => {
      if (!poly || poly.length < 3) return;
      const colorHex = PALETTE[idx % PALETTE.length];
      const fill = Cesium.Color.fromCssColorString(colorHex).withAlpha(fillAlpha);
      const stroke = Cesium.Color.fromCssColorString(colorHex).withAlpha(outlineAlpha);

      const positions = Cesium.Cartesian3.fromDegreesArray(
        poly.flatMap((v) => [v.lng, v.lat]),
      );

      // Filled polygon — projected onto the 3D mesh as a colored region.
      // CESIUM_3D_TILE classification paints rooftop AND any vertical surface
      // the polygon's column passes through. For high-conf sources we accept
      // some wall-painting bleed because the visual ("the whole roof is blue")
      // is what the user wants. Skipped entirely for AI source where the
      // polygon is suspect.
      if (fillAlpha > 0) {
        const fillEntity = viewer.entities.add({
          polygon: {
            hierarchy: positions,
            material: fill,
            classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
          },
        });
        polygonEntitiesRef.current.push(fillEntity);
      }

      const closed = [...positions, positions[0]];
      const outlineEntity = viewer.entities.add({
        polyline: {
          positions: closed,
          width: outlineWidth,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower,
            color: stroke,
          }),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        },
      });
      polygonEntitiesRef.current.push(outlineEntity);
    });
  }, [polygons, polygonSource, status]);

  // -------- Pattern A: validate the active polygon against mesh heights --------
  // For non-tiles3d sources (Roboflow, OSM, MS Buildings, etc.), sample 3D
  // mesh heights inside the polygon. Score = % of samples at "roof height"
  // (ground+2m to ground+10m). Caller can demote sources whose score is low
  // — that's the case where Roboflow traced a driveway/lawn/wrong building
  // and the satellite-only model couldn't tell. Skip for tiles3d (already
  // mesh-derived) and "edited" (rep already approved by hand).
  useEffect(() => {
    const viewer = viewerRef.current as
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | any
      | null;
    if (!viewer || status !== "ready") return;
    if (!polygons || polygons.length === 0) return;
    if (!onValidatedRef.current) return;
    if (polygonSource === "tiles3d" || polygonSource === "edited") return;
    const Cesium = window.Cesium;
    if (!Cesium) return;

    // Validate only the largest (= primary) polygon. Standalone polygons
    // (detached garages, etc.) can have their own validation later if needed.
    const primary = polygons.reduce<Array<{ lat: number; lng: number }> | null>(
      (best, p) => {
        if (!p || p.length < 3) return best;
        return !best || p.length > best.length ? p : best;
      },
      null,
    );
    if (!primary) return;

    // Cache key — don't re-validate the same polygon if React re-renders
    const key = `${polygonSource}:${primary[0].lat.toFixed(5)},${primary[0].lng.toFixed(5)}:${primary.length}`;
    if (validatedPolygonRef.current === key) return;
    validatedPolygonRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        const result = await validatePolygonAgainstMesh({ Cesium, viewer, polygon: primary });
        if (cancelled || !result) return;
        console.log(
          `[Roof3DViewer] validation [${polygonSource}]: ${(result.score * 100).toFixed(0)}% of ${result.samples} samples at roof height (${result.roofMin.toFixed(1)}-${result.roofMax.toFixed(1)}m, ground=${result.groundHeightM.toFixed(1)}m)`,
        );
        onValidatedRef.current?.(result.score, result.samples);
      } catch (err) {
        console.warn("[Roof3DViewer] mesh validation failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [polygons, polygonSource, status]);

  return (
    <div className="relative rounded-2xl overflow-hidden border border-white/[0.07] bg-black/30 h-full min-h-[280px]">
      <div ref={containerRef} className="absolute inset-0" aria-label={address} />

      {status === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 pointer-events-none">
          <Loader2 size={18} className="animate-spin mb-2" />
          <div className="text-[12px] font-mono uppercase tracking-[0.14em]">
            Loading 3D mesh…
          </div>
        </div>
      )}
      {status === "no-coverage" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
          <div className="w-9 h-9 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-400 mb-2">
            <Box size={14} />
          </div>
          <div className="font-display text-[13px] font-semibold tracking-tight text-slate-200">
            3D mesh unavailable
          </div>
          <div className="text-[11.5px] text-slate-500 mt-1 max-w-[260px] leading-relaxed">
            Google hasn&apos;t flown this area for photogrammetry. Common in rural and exurban properties.
          </div>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
          <div className="font-display text-[13px] font-semibold tracking-tight text-slate-200">
            3D viewer unavailable
          </div>
          <div className="text-[11.5px] text-slate-500 mt-1 max-w-[260px] leading-relaxed">
            Set <code className="kbd mx-1">NEXT_PUBLIC_GOOGLE_MAPS_KEY</code> with the Map Tiles API enabled.
          </div>
        </div>
      )}

      {status === "ready" && extracting && (
        <div className="absolute inset-x-0 top-0 z-10 flex justify-center pointer-events-none">
          <div className="mt-3 flex items-center gap-2 rounded-full border border-cy-300/40 bg-[#07090d]/85 backdrop-blur-md px-4 py-1.5 shadow-2xl shadow-cy-300/20">
            <Sparkles size={13} className="text-cy-300 animate-pulse" />
            <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-cy-100">
              Generating<span className="generating-dots" />
            </span>
          </div>
        </div>
      )}
      {status === "ready" && (
        <div className="absolute top-2.5 right-2.5 z-10 flex gap-1.5">
          <button
            onClick={() => {
              recenterRef.current?.();
              setOrbiting(true);
            }}
            className="chip chip-accent backdrop-blur-md bg-[#07090d]/65"
            title="Recenter on property"
          >
            <Crosshair size={11} /> <span>Recenter</span>
          </button>
          <button
            onClick={() => setOrbiting((v) => !v)}
            className="chip chip-accent backdrop-blur-md bg-[#07090d]/65"
            title={orbiting ? "Pause orbit" : "Resume orbit"}
          >
            {orbiting ? <Pause size={11} /> : <Play size={11} />}
            <span>{orbiting ? "Orbiting" : "Paused"}</span>
          </button>
        </div>
      )}
      {status === "ready" && polygons && polygons.length > 0 && (
        <div className="absolute bottom-2.5 left-2.5 z-10 chip chip-accent backdrop-blur-md bg-[#07090d]/65">
          <RotateCw size={10} />
          {polygonSource === "ai"
            ? "Outline (low confidence)"
            : "Roof outline projected"}
        </div>
      )}
    </div>
  );
}

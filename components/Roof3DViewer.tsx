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
    | "ai";
  /** Fired once we've extracted a roof polygon from the 3D Tiles mesh by
   *  sampling elevations and thresholding above ground. Highest-quality
   *  source we have for any property in 3D Tiles coverage — uses real
   *  geometric height data rather than 2D AI guessing on the satellite tile. */
  onTilesPolygonDetected?: (polygon: Array<{ lat: number; lng: number }>) => void;
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
const ROOF_HEIGHT_THRESHOLD_M = 2.2; // anything > ground + this is roof

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
function isolateCenterComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array | null {
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  let seedX = -1, seedY = -1;
  if (mask[cy * width + cx]) {
    seedX = cx; seedY = cy;
  } else {
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
  const ceilingHeight = sorted[Math.floor(sorted.length * 0.95)];

  // Threshold to binary roof mask. Anything more than ROOF_HEIGHT_THRESHOLD_M
  // above ground = roof. Cap by ceilingHeight to avoid trees being labeled roof
  // (trees sometimes survive photogrammetry as tall blobs).
  const mask = new Uint8Array(EXTRACT_GRID * EXTRACT_GRID);
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (!Number.isFinite(h)) continue;
    if (h > groundHeight + ROOF_HEIGHT_THRESHOLD_M && h <= ceilingHeight + 1) {
      mask[i] = 1;
    }
  }

  // Clean (close + hole-fill), isolate the component containing center
  const cleaned = cleanMask(mask, EXTRACT_GRID, EXTRACT_GRID);
  const isolated = isolateCenterComponent(cleaned, EXTRACT_GRID, EXTRACT_GRID);
  if (!isolated) {
    console.warn("[Roof3DViewer] no roof component near centerpoint");
    return null;
  }
  let area = 0;
  for (let i = 0; i < isolated.length; i++) if (isolated[i]) area++;
  if (area < 30) {
    console.warn(`[Roof3DViewer] roof component too small (${area} cells)`);
    return null;
  }

  // Trace, simplify, orthogonalize, merge dups
  const boundary = traceBoundary(isolated, EXTRACT_GRID, EXTRACT_GRID);
  if (!boundary) return null;
  const simplified = douglasPeucker(boundary, 1.2);
  const orthoResult = bestOrthogonalize({ poly: simplified, toleranceDeg: 14 });
  const ortho = mergeNearbyVertices(orthoResult.polygon, 1);
  if (ortho.length < 4) return null;

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

      // Camera framing: 180 m radius at -35° pitch — original "drone hover"
      // framing the user explicitly preferred. Tightening (90 / 150 m) put
      // the camera inside the eaves; widening (250 m) lost the property in
      // the neighborhood. This is the Goldilocks setting; do not retune.
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
          new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), 180),
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
    const isLowConf = polygonSource === "ai";
    const fillAlpha = isLowConf ? 0 : 0.35;
    const outlineWidth = isLowConf ? 2 : 4;
    const outlineAlpha = isLowConf ? 0.45 : 1.0;
    const glowPower = isLowConf ? 0.15 : 0.35;

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

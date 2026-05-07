"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Box, RotateCw, Pause, Play, Crosshair, Square } from "lucide-react";
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
    | "sam3"
    | "solar-mask"
    | "roboflow"
    | "solar"
    | "sam"
    | "osm"
    | "microsoft-buildings"
    | "ai";
  /** When provided, the viewer captures top-down + 4 oblique screenshots
   *  of the loaded 3D mesh, POSTs them to /api/verify-polygon-multiview
   *  along with the active polygon, and reports Claude's verdict via this
   *  callback. Skipped when the rep edited (livePolygons in parent) since
   *  manual edits override AI verification. */
  onMultiViewVerified?: (result: { ok: boolean; confidence: number; reason: string; issues?: string[] }) => void;
  /** When true, the polygon outline is NOT drawn on the 3D mesh (used by
   *  the parent to hide the polygon while Claude verifies it — prevents
   *  the rep from seeing flicker as sources race). The polygon data is
   *  still passed via `polygons` so verification fires; only the visible
   *  Cesium entities are skipped. */
  polygonsHidden?: boolean;
  /** Optional sanity context for the multi-view verifier — Solar's
   *  reported building footprint area in sqft. When passed, Claude can
   *  size-check the candidate polygon against the known footprint and
   *  flag obvious over- or under-traces. */
  expectedFootprintSqft?: number | null;
  /** Optional ISO date of the underlying satellite imagery (Solar API's
   *  `imageryDate`). Forwarded to the multi-view verifier so it can
   *  compute predicted shadow direction and tell Claude to disregard
   *  shadow-cast regions when judging eaves. */
  imageryDate?: string | null;
  /** When false, the user cannot pan/zoom/rotate the camera and the
   *  Recenter / Top-Down / Orbit toggle buttons are hidden. The auto-orbit
   *  animation still runs (purely visual), but all tile requests are
   *  bounded by what the orbit needs — caps Map Tiles API cost on the
   *  customer-facing /quote page. Default true (rep workflow needs full
   *  interaction). */
  interactive?: boolean;
}

// Multi-view capture geometry. These constants control the camera poses used
// for verification screenshots; tuned to match what the model expects to see.
const VERIFY_TOPDOWN_HALF_WIDTH_M = 35;   // top-down covers ±35m around centerpoint
const VERIFY_TOPDOWN_ALTITUDE_M = 250;
const VERIFY_OBLIQUE_RANGE_M = 130;
const VERIFY_OBLIQUE_PITCH_DEG = -45;
const VERIFY_SETTLE_MS = 1200;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CapturedView { base64: string; width: number; height: number }
interface CapturedMultiView {
  topDown: CapturedView & { halfWidthM: number };
  obliques: Array<CapturedView & { headingDeg: number }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function captureCanvasPng(viewer: any): Promise<CapturedView | null> {
  // Force the framebuffer to match the canvas's CSS size before rendering.
  // Cesium's render loop calls resize() automatically, but in this codebase
  // the WebGL dimensions sometimes lag behind layout (e.g. canvas.width
  // observed at 0 even after the container is laid out). Without this,
  // toDataURL returns an empty PNG.
  viewer.resize();
  viewer.scene.render();
  await delay(60);
  viewer.scene.render();
  const canvas: HTMLCanvasElement = viewer.scene.canvas;
  if (canvas.width === 0 || canvas.height === 0) {
    console.warn(
      `[Roof3DViewer] capture aborted — canvas ${canvas.width}x${canvas.height}`,
    );
    return null;
  }
  const dataUrl = canvas.toDataURL("image/png");
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m) {
    console.warn(
      `[Roof3DViewer] capture aborted — toDataURL returned ${dataUrl.slice(0, 40)}`,
    );
    return null;
  }
  return { base64: m[1], width: canvas.width, height: canvas.height };
}

/**
 * Snap the camera to top-down orthographic + 4 oblique poses, capture each
 * frame as PNG. Used by the multi-view verification flow — Claude looks at
 * 5 images of the property + the candidate polygon overlaid on each, and
 * answers "does this match the actual roof?"
 *
 * Restores the user's previous camera state on exit (success or failure).
 * Disables ScreenSpaceCameraController inputs during capture so the user
 * can't move the camera mid-render.
 */
async function captureMultiViewForVerify(opts: {
  Cesium: CesiumGlobal;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  viewer: any;
  lat: number;
  lng: number;
}): Promise<CapturedMultiView | null> {
  const { Cesium, viewer, lat, lng } = opts;

  // Wait for the panel to finish its enter animation. The multi-view
  // effect fires as soon as status flips to "ready" + polygons land, but
  // the wrapping <section> may still be in its float-in animation, or
  // (in headless previews) the viewport may not yet be sized. Poll for
  // up to 15s — when Cesium's canvas reports non-zero CSS dimensions, the
  // framebuffer follows on next resize().
  const sizeStart = Date.now();
  let lastObserved = `${viewer.scene.canvas.width}x${viewer.scene.canvas.height}`;
  while (Date.now() - sizeStart < 15_000) {
    viewer.resize();
    const c = viewer.scene.canvas;
    lastObserved = `${c.width}x${c.height}`;
    if (c.width > 0 && c.height > 0) break;
    await delay(200);
  }
  if (
    viewer.scene.canvas.width === 0 ||
    viewer.scene.canvas.height === 0
  ) {
    console.warn(
      `[Roof3DViewer] capture aborted — canvas never sized (last ${lastObserved})`,
    );
    return null;
  }

  const saved = viewer.camera.position.clone();
  const savedHeading = viewer.camera.heading;
  const savedPitch = viewer.camera.pitch;
  const savedRoll = viewer.camera.roll;
  const ssc = viewer.scene.screenSpaceCameraController;
  const sscEnabled = ssc.enableInputs;
  ssc.enableInputs = false;

  try {
    // Top-down orthographic
    const center = Cesium.Cartesian3.fromDegrees(lng, lat, 0);
    const transform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    viewer.camera.lookAtTransform(
      transform,
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-89.9), VERIFY_TOPDOWN_ALTITUDE_M),
    );
    const canvas: HTMLCanvasElement = viewer.scene.canvas;
    const aspect = canvas.width / canvas.height;
    const orthoFrustum = new Cesium.OrthographicFrustum();
    orthoFrustum.width = VERIFY_TOPDOWN_HALF_WIDTH_M * 2;
    orthoFrustum.aspectRatio = aspect;
    orthoFrustum.near = 1;
    orthoFrustum.far = 5000;
    const previousFrustum = viewer.camera.frustum;
    viewer.camera.frustum = orthoFrustum;
    await delay(VERIFY_SETTLE_MS);
    const topDown = await captureCanvasPng(viewer);
    if (!topDown) return null;
    viewer.camera.frustum = previousFrustum;

    // 4 oblique views (N, E, S, W)
    const obliques: CapturedMultiView["obliques"] = [];
    for (const headingDeg of [0, 90, 180, 270]) {
      viewer.camera.lookAtTransform(
        transform,
        new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(headingDeg),
          Cesium.Math.toRadians(VERIFY_OBLIQUE_PITCH_DEG),
          VERIFY_OBLIQUE_RANGE_M,
        ),
      );
      await delay(VERIFY_SETTLE_MS);
      const cap = await captureCanvasPng(viewer);
      if (cap) obliques.push({ ...cap, headingDeg });
    }

    return {
      topDown: { ...topDown, halfWidthM: VERIFY_TOPDOWN_HALF_WIDTH_M },
      obliques,
    };
  } finally {
    try {
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      viewer.camera.position = saved;
      viewer.camera.setView({
        orientation: { heading: savedHeading, pitch: savedPitch, roll: savedRoll },
      });
    } catch {
      /* best-effort */
    }
    ssc.enableInputs = sscEnabled;
  }
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
  onMultiViewVerified,
  polygonsHidden,
  expectedFootprintSqft,
  imageryDate,
  interactive = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const polygonEntitiesRef = useRef<unknown[]>([]);
  const tickHandlerRef = useRef<(() => void) | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const recenterRef = useRef<(() => void) | null>(null);
  const markerEntityRef = useRef<unknown>(null);
  // Pivot altitude (meters above WGS84 ellipsoid) for the camera orbit.
  // 200m default works for most US locations from sea level to ~500m
  // ground elevation. Without mesh extraction we no longer auto-tune to
  // the actual ground; the camera framing constants below (110m / -42°)
  // are tuned for this default.
  const pivotAltitudeRef = useRef(200);
  const onVerifiedRef = useRef(onMultiViewVerified);
  onVerifiedRef.current = onMultiViewVerified;
  // Don't re-verify the same polygon on every render. Key by (source +
  // first vertex + length) and only fire once per unique polygon.
  const verifiedPolygonRef = useRef<string | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "no-coverage" | "error">(
    "loading",
  );
  const [orbiting, setOrbiting] = useState(true);
  const orbitingRef = useRef(true);
  orbitingRef.current = orbiting;
  // Top-down ortho view: fixes the perspective-camera parallax that shifts
  // the rendered roof off its lat/lng footprint at near-vertical pitch.
  // With ortho on, polygon (draped onto the mesh by lat/lng ray-down) and
  // the rendered roof line up. Tilted views still use perspective.
  const [topDown, setTopDown] = useState(false);
  const topDownRef = useRef(false);
  topDownRef.current = topDown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topDownActionsRef = useRef<{ enter: () => void; exit: () => void } | null>(null);
  // While the multi-view IIFE is running, the camera is jumping between
  // top-down ortho + 4 obliques and 3D Tiles haven't streamed for those
  // poses yet — the rep sees a flickering empty scene. Hide the viewer
  // behind a "Verifying outline…" overlay during capture.
  const [isCapturing, setIsCapturing] = useState(false);
  const isCapturingRef = useRef(false);
  isCapturingRef.current = isCapturing;

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
        // Required so canvas.toDataURL() returns a non-empty PNG. WebGL
        // discards the framebuffer after each frame by default; without
        // this, multi-view verification capture silently produces empty
        // images and the verify gate never fires.
        contextOptions: {
          webgl: { preserveDrawingBuffer: true },
        },
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

      // For non-interactive embeds (customer-facing /quote), lock all user
      // input. Auto-orbit animation still runs because it's programmatic,
      // but pan / zoom / rotate from the user are blocked. This caps tile
      // requests at what the orbit pose itself needs, since users can't
      // navigate to new areas requiring fresh tile loads.
      if (!interactive) {
        const ssc = viewer.scene.screenSpaceCameraController;
        ssc.enableRotate = false;
        ssc.enableTranslate = false;
        ssc.enableZoom = false;
        ssc.enableTilt = false;
        ssc.enableLook = false;
      }

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

        // Wait for the first batch of tiles to actually stream in before
        // declaring "ready". Without this, the multi-view verify effect
        // fires within milliseconds of the tileset being added, captures
        // an empty mesh, and Claude's verdict is meaningless. 12s cap so
        // spotty coverage doesn't hang the UI — beyond that we proceed
        // and let downstream gates handle a degraded mesh.
        await new Promise<void>((resolve) => {
          let done = false;
          let removeListener: (() => void) | null = null;
          let timer: number | null = null;
          const finish = () => {
            if (done) return;
            done = true;
            if (timer !== null) window.clearTimeout(timer);
            if (removeListener) removeListener();
            resolve();
          };
          removeListener = tileset.initialTilesLoaded.addEventListener(finish);
          timer = window.setTimeout(finish, 12_000);
        });
        if (cancelled) return;

        // Sample the actual mesh height around the address so the orbit
        // pivot sits on the building, not on the WGS84 ellipsoid 30m+
        // above local ground. Without this, zoom-in moves the camera up
        // toward the pivot (above the house) instead of toward the roof,
        // and tilting up to the horizon drops the house to the bottom of
        // the screen.
        //
        // Sample a 5-point cross around the address (center + 4 offsets
        // ~6m out) and take the MAX. Buildings are tall, so the highest
        // sample is almost certainly the roof; if the address geocoded
        // to the lawn rather than onto the building, one of the offset
        // points likely sits on a wall/roof and lifts the max.
        try {
          // ~6m offset in lat/lng terms
          const dLat = 6 / 111_320;
          const dLng = 6 / (111_320 * Math.cos((lat * Math.PI) / 180));
          const sampled = await viewer.scene.sampleHeightMostDetailed([
            Cesium.Cartographic.fromDegrees(lng, lat, 0),
            Cesium.Cartographic.fromDegrees(lng + dLng, lat, 0),
            Cesium.Cartographic.fromDegrees(lng - dLng, lat, 0),
            Cesium.Cartographic.fromDegrees(lng, lat + dLat, 0),
            Cesium.Cartographic.fromDegrees(lng, lat - dLat, 0),
          ]);
          let maxH: number | null = null;
          for (const pt of sampled) {
            const h = pt?.height;
            if (typeof h === "number" && isFinite(h)) {
              if (maxH == null || h > maxH) maxH = h;
            }
          }
          if (!cancelled && maxH != null) {
            // Pivot at the highest sampled surface − 2m biases toward the
            // middle of the building's vertical extent (between eave and
            // ridge for typical residential roofs).
            pivotAltitudeRef.current = maxH - 2;
          }
        } catch {
          /* fall through with default 200m — visible misalignment, but
             every other downstream pipeline still works */
        }
        if (cancelled) return;
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

        // Pivot-altitude correction. The default 200m pivot is a coarse
        // fallback — for any low-elevation property (Orlando ~30m, most of
        // FL/TX coast) it sits 150-170m above the actual roof, which
        // pushes the camera so high the orbit frames the whole
        // neighbourhood instead of the house.
        //
        // Pre-pivot the camera straight down at the address, then sample
        // the photorealistic mesh at that point to get the real ground
        // height. Update `pivotAltitudeRef` to ground+5m and re-pivot so
        // the orbit is centred on the actual roof.
        //
        // tiles3d mesh-data POLYGON extraction was removed in 6b00ecf
        // (inconsistent across rural properties). But sampling a single
        // height point is reliable and ~200ms — keeping it for camera
        // framing only.
        const sampleGroundAndRepivot = async () => {
          try {
            // Wait for tiles to actually render around the address —
            // sampleHeightMostDetailed needs streamed tiles to hit.
            await new Promise((r) => window.setTimeout(r, 600));
            const cart = Cesium.Cartographic.fromDegrees(lng, lat);
            const sampled = await viewer.scene.sampleHeightMostDetailed(
              [cart],
              [],
              4,
            );
            if (cancelled || !sampled?.[0]) return;
            const groundM = sampled[0].height;
            if (!Number.isFinite(groundM)) return;
            pivotAltitudeRef.current = groundM + 5;
            recenterRef.current?.();
          } catch (err) {
            console.warn("[Roof3DViewer] ground sample failed:", err);
          }
        };
        sampleGroundAndRepivot();
      } catch (err) {
        console.warn("[Roof3DViewer] no 3D Tiles coverage:", err);
        if (!cancelled) setStatus("no-coverage");
        return;
      }

      // Camera framing: 85 m range at -45° pitch on the corrected pivot.
      // Tightened from 110m / -42° (which framed too wide on lower
      // elevations after the post-pivot correction) — at 85m / -45° the
      // camera sits ~60m above ground, ~60m horizontal, which puts a
      // typical 40-50m residential lot squarely in frame with some yard
      // visible for context.
      //
      // Pivot ALTITUDE comes from `pivotAltitudeRef` — meters above the
      // WGS84 ellipsoid. Initial default 200m is a coarse fallback; the
      // post-tileset ground sample (sampleGroundAndRepivot above) updates
      // the ref to (groundHeightM + 5m) and calls recenter() to re-pivot
      // on the actual roof level.
      const recenter = () => {
        const center = Cesium.Cartesian3.fromDegrees(
          lng,
          lat,
          pivotAltitudeRef.current,
        );
        const transform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
        viewer.camera.lookAtTransform(
          transform,
          new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), 85),
        );
      };
      recenterRef.current = recenter;
      recenter();

      // Top-down ortho mode. Snaps to vertical with an OrthographicFrustum so
      // the polygon and roof line up (no perspective parallax). Save the
      // perspective frustum on enter so we can restore on exit.
      const TOP_DOWN_ALTITUDE_M = 250;
      const TOP_DOWN_HALF_WIDTH_M = 35;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let savedPerspectiveFrustum: any = null;
      const enterTopDown = () => {
        const center = Cesium.Cartesian3.fromDegrees(
          lng,
          lat,
          pivotAltitudeRef.current,
        );
        const transform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
        viewer.camera.lookAtTransform(
          transform,
          new Cesium.HeadingPitchRange(
            0,
            Cesium.Math.toRadians(-89.9),
            TOP_DOWN_ALTITUDE_M,
          ),
        );
        const canvas: HTMLCanvasElement = viewer.scene.canvas;
        const aspect = canvas.width / canvas.height;
        savedPerspectiveFrustum = viewer.camera.frustum.clone();
        const ortho = new Cesium.OrthographicFrustum();
        ortho.width = TOP_DOWN_HALF_WIDTH_M * 2;
        ortho.aspectRatio = aspect;
        ortho.near = 1;
        ortho.far = 5000;
        viewer.camera.frustum = ortho;
      };
      const exitTopDown = () => {
        if (savedPerspectiveFrustum) {
          viewer.camera.frustum = savedPerspectiveFrustum;
          savedPerspectiveFrustum = null;
        }
        viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
        recenter();
      };
      topDownActionsRef.current = { enter: enterTopDown, exit: exitTopDown };

      // Auto-orbit: rotate around the property at constant rate. Click cancels.
      armTimerRef.current = window.setTimeout(() => {
        if (cancelled) return;
        const tickHandler = () => {
          if (
            orbitingRef.current &&
            !topDownRef.current &&
            !isCapturingRef.current
          ) {
            viewer.camera.rotateRight(0.0018);
          }
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
    setTopDown(false);
    recenterRef.current?.();
  }, [lat, lng, status]);

  // -------- top-down toggle drives camera + frustum swap --------
  useEffect(() => {
    if (status !== "ready") return;
    const actions = topDownActionsRef.current;
    if (!actions) return;
    if (topDown) actions.enter(); else actions.exit();
  }, [topDown, status]);

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
    // polygonsHidden = true → hide the visible outline while parent waits
    // for Claude verification. Polygon data still flows through for the
    // multi-view verify effect; we just don't render the Cesium entities.
    if (polygonsHidden) return;

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
          // Drape onto the photogrammetric mesh via classification only.
          // `clampToGround: true` is for the WGS84 ellipsoid / terrain
          // provider; on a Tileset that's a no-op at best and at worst
          // fights the classification, painting the outline at ground
          // level instead of on the rooftop. Classification alone is the
          // right primitive here.
          classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        },
      });
      polygonEntitiesRef.current.push(outlineEntity);
    });
  }, [polygons, polygonSource, status, polygonsHidden]);

  // -------- Multi-view Claude verification --------
  // After the 3D mesh is loaded AND a polygon is rendered, capture top-down
  // + 4 oblique screenshots, send all 5 to Claude with a "does this polygon
  // match the actual roof?" prompt. Claude's verdict feeds back to the
  // parent which decides whether to ship the polygon or fall through.
  //
  // Skipped for:
  //   - "edited" (rep authoritative)
  //   - "ai" (Claude verifying Claude is circular)
  //   - "tiles3d" (legacy source no longer in chain; safety check)
  // Caching: verifiedPolygonRef prevents re-verification of the same polygon
  // on React re-renders.
  // Derive a stable identity key for the candidate polygon. The parent
  // re-creates the `polygons` array on every render, which would thrash
  // the effect below (cleanup → cancel capture → re-run → cancel again
  // → never finishes). Using a string-valued key as the effect dep means
  // the effect only re-runs when the actual polygon CONTENT changes, not
  // on every parent re-render.
  const primaryPolygon = polygons?.reduce<Array<{ lat: number; lng: number }> | null>(
    (best, p) => {
      if (!p || p.length < 3) return best;
      return !best || p.length > best.length ? p : best;
    },
    null,
  ) ?? null;
  const verifyEligible =
    !!primaryPolygon &&
    !!polygonSource &&
    polygonSource !== "edited" &&
    polygonSource !== "ai" &&
    polygonSource !== "tiles3d";
  const polygonVerifyKey =
    verifyEligible && primaryPolygon
      ? `${polygonSource}:${primaryPolygon[0].lat.toFixed(5)},${primaryPolygon[0].lng.toFixed(5)}:${primaryPolygon.length}`
      : null;

  useEffect(() => {
    if (!polygonVerifyKey || !primaryPolygon) return;
    const viewer = viewerRef.current as
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | any
      | null;
    if (!viewer || status !== "ready") return;
    if (!onVerifiedRef.current) return;
    const Cesium = window.Cesium;
    if (!Cesium) return;

    const key = polygonVerifyKey;
    const primary = primaryPolygon;
    if (verifiedPolygonRef.current === key) return;

    // Sequenced flow:
    //   1. Wait for the panel to finish float-in (420ms) + tiles to settle
    //      visually (~1s extra on top of initialTilesLoaded). Without this
    //      buffer the camera snap is racing CSS animation, the canvas may
    //      still be 0-wide, and Cesium tile streaming hasn't drawn the
    //      property's textures yet.
    //   2. Capture top-down + 4 obliques.
    //   3. Mark the polygon as "in-flight" so a re-render with the same
    //      polygon doesn't kick off a parallel capture, but DON'T mark
    //      until we've actually started capturing — this way, React 19
    //      strict-mode dev double-mounts cleanup-cancel the first
    //      attempt, then the second mount runs to completion. In prod
    //      (single mount) this still fires once.
    const SETTLE_MS = 1500;

    let cancelled = false;
    (async () => {
      console.log(`[Roof3DViewer] starting multi-view capture for [${polygonSource}]`);
      // Step 1: settle delay
      await delay(SETTLE_MS);
      if (cancelled) return;

      // Show "Verifying outline…" overlay while the camera jumps between
      // the 5 capture poses (tiles haven't streamed for those poses yet,
      // so the rep would otherwise see a flickering empty mesh).
      setIsCapturing(true);

      // Step 2: capture
      const captured = await captureMultiViewForVerify({
        Cesium,
        viewer,
        lat,
        lng,
      });

      // captureMultiViewForVerify always exits with lookAtTransform =
      // IDENTITY (its finally restores camera position + orientation but
      // not the orbit transform). Without re-establishing lookAt mode on
      // EVERY exit path, the screen-space camera controller falls back
      // to free-fly: scroll-zoom moves toward the cursor (often empty
      // sky above the house) instead of toward the orbit pivot. Always
      // recenter, then handle the success/failure branches.
      recenterRef.current?.();

      if (cancelled) {
        setIsCapturing(false);
        return;
      }
      if (!captured) {
        console.warn("[Roof3DViewer] multi-view capture failed");
        setIsCapturing(false);
        return;
      }

      // Step 3: mark as verified-in-flight (only after we have screenshots)
      // so a quick cancel doesn't poison the cache and prevent retry.
      verifiedPolygonRef.current = key;

      // Drop the overlay once the camera is back to the orbit pose; the
      // fetch can run in the background while the rep sees the live view.
      setIsCapturing(false);

      try {
        const res = await fetch("/api/verify-polygon-multiview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat,
            lng,
            address,
            source: polygonSource,
            polygon: primary,
            imageryDate: imageryDate ?? null,
            expectedFootprintSqft:
              typeof expectedFootprintSqft === "number" &&
              isFinite(expectedFootprintSqft)
                ? expectedFootprintSqft
                : undefined,
            topDown: {
              base64: captured.topDown.base64,
              halfWidthM: captured.topDown.halfWidthM,
            },
            obliques: captured.obliques.map((o) => ({
              base64: o.base64,
              headingDeg: o.headingDeg,
            })),
          }),
        });
        if (!res.ok) {
          console.warn("[Roof3DViewer] multi-view verify API error:", res.status);
          return;
        }
        const data = (await res.json()) as {
          ok?: boolean;
          confidence?: number;
          reason?: string;
          issues?: unknown;
        };
        if (cancelled) return;
        const issues: string[] = [];
        if (Array.isArray(data.issues)) {
          for (const it of data.issues) {
            if (typeof it === "string" && it.trim()) issues.push(it.trim());
          }
        }
        const result = {
          ok: !!data.ok,
          confidence: typeof data.confidence === "number" ? data.confidence : 0.5,
          reason: typeof data.reason === "string" ? data.reason : "",
          issues,
        };
        console.log(
          `[Roof3DViewer] multi-view Claude [${polygonSource}]: ok=${result.ok} conf=${result.confidence.toFixed(2)} — ${result.reason}` +
            (issues.length ? ` | issues: ${issues.join("; ")}` : ""),
        );
        onVerifiedRef.current?.(result);
      } catch (err) {
        console.warn("[Roof3DViewer] multi-view verify error:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // primaryPolygon is derived from polygonVerifyKey identity — when the
    // key is the same, primaryPolygon's contents are equivalent. We don't
    // include it in deps to avoid re-firing on parent array re-creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygonVerifyKey, status, lat, lng, address]);


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
      {status === "ready" && isCapturing && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#07090d]/80 backdrop-blur-sm pointer-events-none">
          <Loader2 size={18} className="animate-spin mb-2 text-slate-300" />
          <div className="text-[12px] font-mono uppercase tracking-[0.14em] text-slate-300">
            Verifying outline…
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

      {/* tiles3d "extracting" pill removed alongside the mesh-data extraction.
          The full-map "Generating…" overlay is now driven from the parent
          (page.tsx) via a verifying state — see C3 commit. */}
      {status === "ready" && interactive && (
        <div className="absolute top-2.5 right-2.5 z-10 flex gap-1.5">
          <button
            onClick={() => {
              setTopDown(false);
              recenterRef.current?.();
              setOrbiting(true);
            }}
            className="chip chip-accent backdrop-blur-md bg-[#07090d]/65"
            title="Recenter on property"
          >
            <Crosshair size={11} /> <span>Recenter</span>
          </button>
          <button
            onClick={() => {
              setTopDown((v) => !v);
              setOrbiting(false);
            }}
            aria-pressed={topDown}
            className="chip chip-accent backdrop-blur-md bg-[#07090d]/65"
            title={
              topDown
                ? "Exit top-down (orthographic)"
                : "Top-down view (orthographic — polygon lines up with roof)"
            }
          >
            <Square size={11} />
            <span>Top-Down</span>
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

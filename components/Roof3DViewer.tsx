"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Box, RotateCw, Pause, Play, Crosshair } from "lucide-react";

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
  polygonSource?: "edited" | "solar" | "sam" | "osm" | "ai";
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
export default function Roof3DViewer({ lat, lng, address, polygons, polygonSource }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const polygonEntitiesRef = useRef<unknown[]>([]);
  const tickHandlerRef = useRef<(() => void) | null>(null);
  const armTimerRef = useRef<number | null>(null);
  const recenterRef = useRef<(() => void) | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "no-coverage" | "error">(
    "loading",
  );
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
      (viewer.cesiumWidget.creditContainer as HTMLElement).style.opacity = "0.6";

      // Tame the default camera. Cesium's screenSpaceCameraController is tuned
      // for whole-globe navigation — at residential-property scale a small
      // mouse twitch sends the camera flying. Cuts inertia, locks zoom range,
      // and disables free-look so dragging only orbits.
      const ssc = viewer.scene.screenSpaceCameraController;
      ssc.inertiaSpin = 0.4;
      ssc.inertiaTranslate = 0.4;
      ssc.inertiaZoom = 0.4;
      ssc.minimumZoomDistance = 30;
      ssc.maximumZoomDistance = 600;
      ssc.enableLook = false;

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
      } catch (err) {
        console.warn("[Roof3DViewer] no 3D Tiles coverage:", err);
        if (!cancelled) setStatus("no-coverage");
        return;
      }

      // Camera framing: hover above the property with enough breathing room
      // to see the WHOLE roof + a strip of yard for context. 150 m radius
      // at -45° pitch puts the camera ~106 m horizontal × 106 m vertical
      // from the centerpoint — a "drone shot 30-40 ft off the ground from
      // 100 ft south of the property." Earlier 90 m was too close (camera
      // ended up clipping into the eaves), 180 m was too wide (whole block).
      const recenter = () => {
        const center = Cesium.Cartesian3.fromDegrees(lng, lat, 0);
        const transform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
        viewer.camera.lookAtTransform(
          transform,
          new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), 150),
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
  useEffect(() => {
    if (status !== "ready") return;
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
    // Outline width + opacity track source quality. A confident SAM/OSM/Solar
    // polygon gets a bright glowing outline (the visual "we measured this").
    // A Claude AI fallback gets a dim outline — the polygon is usually wrong
    // for that source, and a glowing wonky outline ruins an otherwise clean
    // photogrammetric view of the property.
    const isLowConf = polygonSource === "ai";
    const outlineWidth = isLowConf ? 2 : 4;
    const outlineAlpha = isLowConf ? 0.45 : 1.0;
    const glowPower = isLowConf ? 0.15 : 0.3;

    polygons.forEach((poly, idx) => {
      if (!poly || poly.length < 3) return;
      const colorHex = PALETTE[idx % PALETTE.length];
      const stroke = Cesium.Color.fromCssColorString(colorHex).withAlpha(outlineAlpha);

      const positions = Cesium.Cartesian3.fromDegreesArray(
        poly.flatMap((v) => [v.lng, v.lat]),
      );
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

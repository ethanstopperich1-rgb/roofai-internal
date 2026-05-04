"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Box, RotateCw, Pause, Play } from "lucide-react";

interface Props {
  lat: number;
  lng: number;
  address?: string;
  /** Roof polygon(s) in lat/lng. When supplied, drawn as a glowing outline
   *  draped over the 3D mesh using Cesium's CESIUM_3D_TILE classification. */
  polygons?: Array<Array<{ lat: number; lng: number }>>;
}

const PALETTE = [
  "#67dcff", // cyan
  "#5fe3b0", // mint
  "#c8a4ff", // lavender
  "#ffc878", // gold
  "#ffa8d9", // pink
  "#88e6ff", // sky
];

/**
 * Interactive 3D viewer over Google Photorealistic 3D Tiles.
 *
 * Renders the actual photogrammetric mesh of the property — same data Google
 * Earth uses — and drapes the roof polygon(s) onto the rooftop surface as
 * colored, glowing classifications. Auto-orbits the camera; click to pause.
 *
 * Cesium is heavy (~2.5MB gzipped), so this component is lazy-loaded by
 * PropertyContextPanel via next/dynamic. The Cesium runtime itself is also
 * `await import`-ed below so it never lands in the initial bundle.
 *
 * Requires NEXT_PUBLIC_GOOGLE_MAPS_KEY (must have "Map Tiles API" enabled
 * in the Google Cloud console — that's what powers Photorealistic 3D Tiles).
 */
export default function Roof3DViewer({ lat, lng, address, polygons }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const tilesetRef = useRef<unknown>(null);
  const polygonEntitiesRef = useRef<unknown[]>([]);
  const tickHandlerRef = useRef<(() => void) | null>(null);

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
      const Cesium = await import("cesium");
      // Required for Cesium to find its asset URLs (workers, glsl, css).
      // We point at Cesium's CDN so we don't need to copy the dist into
      // /public on every install. For a self-hosted production deploy,
      // copy node_modules/cesium/Build/Cesium → /public/cesium and set
      // CESIUM_BASE_URL = "/cesium/".
      (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL =
        "https://cdn.jsdelivr.net/npm/cesium@1.141.0/Build/Cesium/";
      // Pull the widgets CSS lazily too — same reason as above.
      if (!document.querySelector('link[data-cesium-widgets]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href =
          "https://cdn.jsdelivr.net/npm/cesium@1.141.0/Build/Cesium/Widgets/widgets.css";
        link.setAttribute("data-cesium-widgets", "true");
        document.head.appendChild(link);
      }

      Cesium.GoogleMaps.defaultApiKey = apiKey;

      if (cancelled || !containerRef.current) return;

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
      // Hide Cesium's bottom-left credit container — Google attribution still
      // shows in the credit display because the tileset contributes its own.
      (viewer.cesiumWidget.creditContainer as HTMLElement).style.opacity = "0.6";

      try {
        const tileset = await Cesium.createGooglePhotorealistic3DTileset();
        if (cancelled) return;
        viewer.scene.primitives.add(tileset);
        tilesetRef.current = tileset;
        setStatus("ready");
      } catch (err) {
        console.warn("[Roof3DViewer] no 3D Tiles coverage:", err);
        setStatus("no-coverage");
        return;
      }

      // Compass: north up. Tilt down ~45° so we see the roof clearly.
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lng, lat - 0.0008, 220),
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-40),
          roll: 0,
        },
        duration: 1.6,
      });

      // Auto-orbit: rotate the camera around the property at constant rate.
      // We use lookAtTransform once after the flyTo settles, then increment
      // heading per frame. User click cancels the orbit so they can free-look.
      let armedOrbit = false;
      const armOrbit = () => {
        if (armedOrbit || cancelled) return;
        armedOrbit = true;
        const center = Cesium.Cartesian3.fromDegrees(lng, lat, 30);
        const transform = Cesium.Transforms.eastNorthUpToFixedFrame(center);
        viewer.camera.lookAtTransform(
          transform,
          new Cesium.HeadingPitchRange(
            0,
            Cesium.Math.toRadians(-35),
            180, // 180m radius
          ),
        );
        const tickHandler = () => {
          if (orbitingRef.current) {
            viewer.camera.rotateRight(0.0018);
          }
        };
        viewer.scene.preRender.addEventListener(tickHandler);
        tickHandlerRef.current = tickHandler;
      };
      // Arm orbit ~2s after mount (after flyTo finishes)
      const armTimer = window.setTimeout(armOrbit, 1700);

      // Click → pause orbit + free-look
      viewer.screenSpaceEventHandler.setInputAction(() => {
        setOrbiting(false);
      }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

      // store cleanup
      viewerRef.current = { viewer, armTimer };
    })().catch((err) => {
      console.error("[Roof3DViewer] init failed:", err);
      setStatus("error");
    });

    return () => {
      cancelled = true;
      const ref = viewerRef.current as
        | { viewer: { destroy: () => void; scene: { preRender: { removeEventListener: (h: () => void) => void } } }; armTimer: number }
        | null;
      if (ref) {
        if (ref.armTimer) window.clearTimeout(ref.armTimer);
        if (tickHandlerRef.current) {
          ref.viewer.scene.preRender.removeEventListener(tickHandlerRef.current);
          tickHandlerRef.current = null;
        }
        try {
          ref.viewer.destroy();
        } catch {
          /* viewer may already be torn down */
        }
      }
      viewerRef.current = null;
      tilesetRef.current = null;
      polygonEntitiesRef.current = [];
    };
    // We deliberately omit lat/lng from deps — re-init on those would tear
    // the viewer down on every minor coordinate update. Address changes
    // are handled by the camera-flyTo effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------- camera fly when lat/lng changes (without rebuilding viewer) --------
  useEffect(() => {
    const ref = viewerRef.current as
      | { viewer: { camera: { flyTo: (opts: unknown) => void } } }
      | null;
    if (!ref || status !== "ready") return;
    (async () => {
      const Cesium = await import("cesium");
      ref.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lng, lat - 0.0008, 220),
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-40),
          roll: 0,
        },
        duration: 1.2,
      });
    })();
  }, [lat, lng, status]);

  // -------- redraw polygons when they change --------
  useEffect(() => {
    const ref = viewerRef.current as
      | { viewer: { entities: { add: (o: unknown) => unknown; remove: (e: unknown) => void } } }
      | null;
    if (!ref || status !== "ready") return;
    (async () => {
      const Cesium = await import("cesium");
      // Clear old entities
      for (const e of polygonEntitiesRef.current) {
        try {
          ref.viewer.entities.remove(e);
        } catch {
          /* already removed */
        }
      }
      polygonEntitiesRef.current = [];
      if (!polygons || polygons.length === 0) return;

      polygons.forEach((poly, idx) => {
        if (!poly || poly.length < 3) return;
        const colorHex = PALETTE[idx % PALETTE.length];
        const fill = Cesium.Color.fromCssColorString(colorHex).withAlpha(0.32);
        const stroke = Cesium.Color.fromCssColorString(colorHex);

        const positions = Cesium.Cartesian3.fromDegreesArray(
          poly.flatMap((v) => [v.lng, v.lat]),
        );

        // Filled polygon — projected onto the 3D mesh as a colored region.
        // CESIUM_3D_TILE classification means it paints whatever surface
        // (rooftop, wall, ground) the vertical column passes through.
        const fillEntity = ref.viewer.entities.add({
          polygon: {
            hierarchy: positions,
            material: fill,
            classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
          },
        });
        polygonEntitiesRef.current.push(fillEntity);

        // Glowing outline — draped polyline along the same path.
        const closed = [...positions, positions[0]];
        const outlineEntity = ref.viewer.entities.add({
          polyline: {
            positions: closed,
            width: 3,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.25,
              color: stroke,
            }),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
          },
        });
        polygonEntitiesRef.current.push(outlineEntity);
      });
    })();
  }, [polygons, status]);

  return (
    <div className="relative rounded-2xl overflow-hidden border border-white/[0.08] bg-black/40 h-72 sm:h-80">
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
        <button
          onClick={() => setOrbiting((v) => !v)}
          className="absolute top-2.5 right-2.5 z-10 chip chip-accent backdrop-blur-md bg-[#07090d]/65"
          title={orbiting ? "Pause orbit" : "Resume orbit"}
        >
          {orbiting ? <Pause size={11} /> : <Play size={11} />}
          <span>{orbiting ? "Orbiting" : "Paused"}</span>
        </button>
      )}
      {status === "ready" && polygons && polygons.length > 0 && (
        <div className="absolute bottom-2.5 left-2.5 z-10 chip chip-accent backdrop-blur-md bg-[#07090d]/65">
          <RotateCw size={10} /> Roof outline projected
        </div>
      )}
    </div>
  );
}

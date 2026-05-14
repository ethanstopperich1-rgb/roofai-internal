"use client";

// components/roof/RoofViewer.tsx
//
// Tier A visual layer. Renders Google Photorealistic 3D Tiles as the
// textured backdrop + overlays LiDAR-derived facet polygons, classified
// edges, and detected objects on top.
//
// Per docs/superpowers/tier-b-a-decisions.md, the spec called for R3F
// over Cesium. In practice mixing two WebGL contexts on the same canvas
// is fragile; we get the same visual result by rendering the overlays
// as Cesium primitives (PolygonGraphics + PolylineGraphics + LabelGraphics)
// in the same WebGL scene. R3F can be reintroduced later if/when an
// effect requires it (e.g. PBR shading on facet meshes).
//
// Mount only when RoofData.source === "tier-a-lidar". For Tier B/C the
// existing Roof3DViewer (legacy + polygon-verify path) keeps owning the
// "/internal" 3D slot.

import { useEffect, useRef, useState } from "react";
import { Loader2, Box, Crosshair } from "lucide-react";
import type { RoofData, Edge, Facet, RoofObject } from "@/types/roof";

type CesiumGlobal = typeof import("cesium");

declare global {
  interface Window {
    Cesium?: CesiumGlobal;
  }
}

const CESIUM_VERSION = "1.141.0";
const CESIUM_BASE = `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VERSION}/Build/Cesium/`;

interface Props {
  data: RoofData;
  /** When false, hides camera controls + auto-orbit (customer-facing
   *  /quote uses this to bound Map Tiles API spend). */
  interactive?: boolean;
}

// ---- Color schemes (per the locked Tier A.2 decisions) ---------------------

function pitchColor(pitchDegrees: number): string {
  // Cool blues for low-slope (<18.43°), warm reds for steep (>38°),
  // greens for typical 4-8/12. Semi-transparent so 3D Tiles texture shows.
  if (pitchDegrees < 18.43) return "rgba(56, 189, 248, 0.45)";   // sky-400
  if (pitchDegrees > 38) return "rgba(239, 68, 68, 0.50)";        // red-500
  return "rgba(34, 197, 94, 0.45)";                                // green-500
}

function edgeColor(type: Edge["type"]): string {
  switch (type) {
    case "ridge": return "#ef4444";       // red
    case "hip": return "#fb923c";         // orange
    case "valley": return "#3b82f6";      // blue
    case "eave": return "#22c55e";        // green
    case "rake": return "#16a34a";        // dark green
    case "step-wall": return "#a855f7";   // purple
    default: return "#94a3b8";
  }
}

function objectMarker(o: RoofObject): { color: string; label: string } {
  switch (o.kind) {
    case "chimney": return { color: "#dc2626", label: "Chimney" };
    case "skylight": return { color: "#0ea5e9", label: "Skylight" };
    case "vent":
    case "ridge-vent":
    case "box-vent":
    case "turbine": return { color: "#64748b", label: "Vent" };
    case "stack": return { color: "#475569", label: "Stack" };
    case "satellite-dish": return { color: "#f59e0b", label: "Dish" };
    case "dormer": return { color: "#8b5cf6", label: "Dormer" };
    default: return { color: "#94a3b8", label: o.kind };
  }
}

// ---- Cesium bootstrap ------------------------------------------------------

async function loadCesium(): Promise<CesiumGlobal> {
  if (window.Cesium) return window.Cesium;
  await new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${CESIUM_BASE}Widgets/widgets.css`;
    document.head.appendChild(link);
    const s = document.createElement("script");
    s.src = `${CESIUM_BASE}Cesium.js`;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Cesium CDN load failed"));
    document.head.appendChild(s);
  });
  if (!window.Cesium) throw new Error("Cesium global not present after load");
  // Public-token mode — Cesium's classification layer + tilesets accept
  // unauthenticated traffic for low-volume use. Production should swap to
  // a per-project token via Cesium ion or a Google Tiles API key.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.Cesium as any).Ion.defaultAccessToken = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).CESIUM_BASE_URL = CESIUM_BASE;
  return window.Cesium;
}

// ---- Component -------------------------------------------------------------

export default function RoofViewer({ data, interactive = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<unknown>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const recenterRef = useRef<(() => void) | null>(null);

  // Derive the "not a tier-a-lidar input" guard before the init effect so
  // the effect itself doesn't synchronously call setState — keeps the
  // react-hooks/set-state-in-effect lint clean and skips the Cesium load
  // entirely when there's nothing to render.
  const wrongSource = data.source !== "tier-a-lidar";

  useEffect(() => {
    if (wrongSource) return;
    let cancelled = false;
    (async () => {
      try {
        const Cesium = await loadCesium();
        if (cancelled || !containerRef.current) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const viewer: any = new (Cesium as any).Viewer(containerRef.current, {
          animation: false,
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: false,
          infoBox: false,
          sceneModePicker: false,
          selectionIndicator: false,
          timeline: false,
          navigationHelpButton: false,
          // No imagery on the globe — 3D Tiles below provides everything.
          baseLayer: false,
          terrain: undefined,
        });
        viewerRef.current = viewer;

        // Google Photorealistic 3D Tiles — the textured backdrop.
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tileset = await (Cesium as any).createGooglePhotorealistic3DTileset();
          viewer.scene.primitives.add(tileset);
        } catch (err) {
          console.warn("[RoofViewer] 3D Tiles failed to load:", err);
        }

        // Overlays: facets, edges, objects.
        renderFacets(Cesium, viewer, data.facets);
        renderEdges(Cesium, viewer, data.edges);
        renderObjects(Cesium, viewer, data.objects);

        // Initial camera pose: 100m above the address at -45° pitch.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const C = Cesium as any;
        const flyHome = () => {
          viewer.camera.lookAt(
            C.Cartesian3.fromDegrees(data.address.lng, data.address.lat, 0),
            new C.HeadingPitchRange(
              0, C.Math.toRadians(-42), 130,
            ),
          );
          viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
        };
        flyHome();
        recenterRef.current = flyHome;

        // Customer-facing /quote pages don't allow camera interaction —
        // saves Map Tiles cost since the camera can't pull more tiles.
        if (!interactive) {
          viewer.scene.screenSpaceCameraController.enableInputs = false;
        }

        setStatus("ready");
      } catch (err) {
        console.error("[RoofViewer] init failed", err);
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v: any = viewerRef.current;
      if (v && typeof v.destroy === "function") {
        try { v.destroy(); } catch { /* best-effort */ }
        viewerRef.current = null;
      }
    };
  }, [data, interactive, wrongSource]);

  // wrongSource paints an "unavailable" placeholder. Computed during render
  // so React doesn't see a setState-in-effect when the input source mismatches.
  if (wrongSource) {
    return (
      <div className="relative rounded-2xl overflow-hidden border border-white/[0.07] bg-black/30 h-full min-h-[320px] flex flex-col items-center justify-center text-center p-6">
        <div className="w-9 h-9 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-400 mb-2">
          <Box size={14} />
        </div>
        <div className="font-display text-[13px] font-semibold tracking-tight text-slate-200">
          Tier A 3D view unavailable
        </div>
        <div className="text-[11.5px] text-slate-500 mt-1 max-w-[260px] leading-relaxed">
          Detailed LiDAR-derived 3D model loads once Tier A is enabled.
        </div>
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl overflow-hidden border border-white/[0.07] bg-black/30 h-full min-h-[320px]">
      <div ref={containerRef} className="absolute inset-0" aria-label={data.address.formatted} />
      {status === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 pointer-events-none">
          <Loader2 size={18} className="animate-spin mb-2" />
          <div className="text-[12px] font-mono uppercase tracking-[0.14em]">
            Building 3D model…
          </div>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-6">
          <div className="w-9 h-9 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-400 mb-2">
            <Box size={14} />
          </div>
          <div className="font-display text-[13px] font-semibold tracking-tight text-slate-200">
            3D view unavailable
          </div>
        </div>
      )}
      {status === "ready" && interactive && (
        <div className="absolute top-2.5 right-2.5 z-10 flex gap-1.5">
          <button
            onClick={() => recenterRef.current?.()}
            className="chip chip-accent backdrop-blur-md bg-[#07090d]/65"
            title="Recenter on roof"
          >
            <Crosshair size={11} /> <span>Recenter</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Overlay renderers -----------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderFacets(Cesium: any, viewer: any, facets: Facet[]) {
  for (const f of facets) {
    if (f.polygon.length < 3) continue;
    const positions: number[] = [];
    for (const v of f.polygon) {
      positions.push(v.lng, v.lat);
    }
    viewer.entities.add({
      name: `facet-${f.id}`,
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
        material: Cesium.Color.fromCssColorString(pitchColor(f.pitchDegrees)),
        // Classify against the 3D Tiles mesh so the polygon drapes
        // onto the actual roof geometry, not the WGS84 ellipsoid.
        classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString("#0f172a"),
        outlineWidth: 1,
      },
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderEdges(Cesium: any, viewer: any, edges: Edge[]) {
  for (const e of edges) {
    if (e.polyline.length < 2) continue;
    const positions: number[] = [];
    for (const v of e.polyline) {
      positions.push(v.lng, v.lat, v.heightM || 0);
    }
    const color = Cesium.Color.fromCssColorString(edgeColor(e.type));
    viewer.entities.add({
      name: `edge-${e.id}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(positions),
        width: e.type === "ridge" ? 3 : 2,
        material: e.type === "rake"
          ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 12 })
          : color,
        clampToGround: e.polyline.every((p) => !p.heightM),
      },
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderObjects(Cesium: any, viewer: any, objects: RoofObject[]) {
  for (const o of objects) {
    const m = objectMarker(o);
    viewer.entities.add({
      name: `object-${o.id}`,
      position: Cesium.Cartesian3.fromDegrees(
        o.position.lng, o.position.lat, Math.max(0.5, o.position.heightM || 0.5),
      ),
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString(m.color),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.RELATIVE_TO_3D_TILE,
      },
      label: {
        text: m.label,
        font: "11px sans-serif",
        pixelOffset: new Cesium.Cartesian2(0, -16),
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("rgba(15,23,42,0.75)"),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
        style: Cesium.LabelStyle.FILL,
        heightReference: Cesium.HeightReference.RELATIVE_TO_3D_TILE,
      },
    });
  }
}

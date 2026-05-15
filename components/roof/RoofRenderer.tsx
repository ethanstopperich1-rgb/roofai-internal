"use client";

/**
 * components/roof/RoofRenderer.tsx
 *
 * Standalone 3D roof renderer for Tier A LiDAR output. Renders the
 * roof as a true 3D model — facets at the correct pitch/azimuth,
 * walls extruded down to ground, edges classified and color-coded,
 * detected objects as labeled markers — over a subtle blueprint grid.
 *
 * No photorealistic mesh underneath. The visual reads as an
 * engineering blueprint: precise, intentional, "we measured your
 * roof with USGS LiDAR" instead of competing with Google's
 * photogrammetric texture.
 */

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import * as THREE from "three";
import { Satellite, Box as BoxIcon, X } from "lucide-react";
import type { RoofData, Edge, Facet, RoofObject } from "@/types/roof";

const Canvas = dynamic(
  () => import("@react-three/fiber").then((m) => m.Canvas),
  { ssr: false },
);
const OrbitControls = dynamic(
  () => import("@react-three/drei").then((m) => m.OrbitControls),
  { ssr: false },
);

interface Props {
  /** Primary RoofData (the source that won the pipeline). Always
   *  rendered when no `solar` cross-source is provided. */
  data: RoofData;
  /** Optional second RoofData from the OTHER source (cross-compare mode).
   *  When supplied, a toggle button appears letting the user switch the
   *  rendered model between the two sources. */
  solar?: RoofData | null;
  /** Optional LiDAR alternate (when primary === solar). Symmetric with
   *  `solar` so callers can pass whichever pair they have. */
  lidar?: RoofData | null;
  /** Agreement metrics — when supplied, an overlay chip shows the
   *  measurement-agreement signal (sqft delta %, pitch delta). */
  agreement?: {
    bothPresent: boolean;
    sqftDeltaPct: number | null;
    pitchDeltaDegrees: number | null;
    facetCountDelta: number | null;
  } | null;
  /** Optional className for the outer container (sizing/styling). */
  className?: string;
}

export default function RoofRenderer({
  data,
  solar,
  lidar,
  agreement,
  className,
}: Props) {
  // Build the toggleable set of sources. We always include `data` (the
  // primary). If `solar` or `lidar` was passed AND it's a different
  // source from `data`, add it as a togglable alternate.
  const sources = useMemo(() => {
    const list: Array<{ label: string; key: "lidar" | "solar"; data: RoofData }> = [];
    const lidarData = data.source === "tier-a-lidar" ? data : lidar ?? null;
    const solarData =
      data.source === "tier-c-solar" || data.source === "tier-c-vision"
        ? data
        : solar ?? null;
    if (lidarData && lidarData.source !== "none" && lidarData.facets.length > 0) {
      list.push({ label: "LiDAR", key: "lidar", data: lidarData });
    }
    if (solarData && solarData.source !== "none" && solarData.facets.length > 0) {
      list.push({ label: "Solar", key: "solar", data: solarData });
    }
    return list;
  }, [data, solar, lidar]);

  // Default to primary's source.
  const initialKey: "lidar" | "solar" =
    data.source === "tier-a-lidar" ? "lidar" : "solar";
  const [activeKey, setActiveKey] = useState<"lidar" | "solar">(initialKey);
  const active = sources.find((s) => s.key === activeKey) ?? sources[0];

  // Facet selection state. activeFacetId === null = no selection (default).
  // Click a facet → see its pitch, azimuth, sqft in a side card. Click
  // outside or hit X to clear.
  const [activeFacetId, setActiveFacetId] = useState<string | null>(null);
  const [hoverFacetId, setHoverFacetId] = useState<string | null>(null);
  const activeFacet = active?.data.facets.find((f) => f.id === activeFacetId) ?? null;

  if (!active) return null;

  return (
    <div
      className={
        className ??
        "relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-black"
      }
    >
      <Canvas
        camera={{ position: [55, 38, 55], fov: 42 }}
        gl={{ antialias: true, alpha: false }}
        // Hard-remount via key on active.key so OrbitControls' autoRotate
        // restarts cleanly when the user toggles between sources.
        key={`canvas-${active.key}`}
      >
        <color attach="background" args={["#05070a"]} />
        <fog attach="fog" args={["#05070a", 60, 180]} />
        <RoofScene
          data={active.data}
          activeFacetId={activeFacetId}
          hoverFacetId={hoverFacetId}
          onFacetClick={setActiveFacetId}
          onFacetHover={setHoverFacetId}
        />
        <OrbitControls
          enablePan={false}
          enableZoom={true}
          enableRotate={true}
          autoRotate={true}
          autoRotateSpeed={0.45}
          minPolarAngle={Math.PI / 7}
          maxPolarAngle={Math.PI / 2.05}
          minDistance={20}
          maxDistance={120}
        />
      </Canvas>
      {/* Source toggle — only when 2+ sources are available. */}
      {sources.length > 1 && (
        <SourceToggle
          sources={sources}
          activeKey={activeKey}
          onChange={setActiveKey}
        />
      )}
      {/* Cross-source agreement chip — only when both sources resolved. */}
      {agreement?.bothPresent && (
        <AgreementChip agreement={agreement} />
      )}
      <BlueprintLegend data={active.data} />
      <BlueprintCorner />
      {/* Facet inspector — slides in from the right when a facet is
          clicked. Shows pitch (in /12 + degrees), azimuth (cardinal +
          degrees), sloped area, footprint area, and material guess. */}
      {activeFacet && (
        <FacetInspector
          facet={activeFacet}
          sourceLabel={active.label}
          onClose={() => setActiveFacetId(null)}
        />
      )}
    </div>
  );
}

// ─── Source toggle (LiDAR / Solar segmented chip) ────────────────────

function SourceToggle({
  sources,
  activeKey,
  onChange,
}: {
  sources: Array<{ label: string; key: "lidar" | "solar"; data: RoofData }>;
  activeKey: "lidar" | "solar";
  onChange: (k: "lidar" | "solar") => void;
}) {
  return (
    <div className="absolute top-3 right-3 z-10 inline-flex rounded-full border border-white/[0.08] bg-black/55 backdrop-blur-md p-0.5 text-[11px] font-mono uppercase tracking-[0.12em]">
      {sources.map((s) => {
        const active = s.key === activeKey;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onChange(s.key)}
            className={[
              "px-2.5 py-1 rounded-full transition-colors flex items-center gap-1.5",
              active
                ? "bg-cyan-400/15 text-cyan-200"
                : "text-white/55 hover:text-white/85",
            ].join(" ")}
            aria-pressed={active}
          >
            {s.key === "lidar" ? <BoxIcon size={11} /> : <Satellite size={11} />}
            <span>{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Agreement chip ───────────────────────────────────────────────────

function AgreementChip({
  agreement,
}: {
  agreement: {
    sqftDeltaPct: number | null;
    pitchDeltaDegrees: number | null;
    facetCountDelta: number | null;
  };
}) {
  const sqftPct = agreement.sqftDeltaPct ?? 0;
  // <5% = strong agreement, 5-15% = moderate, >15% = weak.
  const tone =
    sqftPct < 0.05
      ? "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-200"
      : sqftPct < 0.15
        ? "border-amber-300/30 bg-amber-300/[0.06] text-amber-200"
        : "border-rose-400/30 bg-rose-400/[0.06] text-rose-200";
  const label =
    sqftPct < 0.05
      ? "Strong agreement"
      : sqftPct < 0.15
        ? "Moderate agreement"
        : "Sources disagree";
  return (
    <div
      className={`absolute top-3 left-3 z-10 rounded-full border ${tone} px-2.5 py-1 text-[10.5px] font-mono uppercase tracking-[0.12em] backdrop-blur-md`}
    >
      <div>{label}</div>
      <div className="opacity-70 normal-case tracking-normal mt-0.5">
        Δ {(sqftPct * 100).toFixed(1)}% sqft
        {agreement.pitchDeltaDegrees != null && (
          <> · Δ {agreement.pitchDeltaDegrees.toFixed(1)}° pitch</>
        )}
      </div>
    </div>
  );
}

function RoofScene({
  data,
  activeFacetId,
  hoverFacetId,
  onFacetClick,
  onFacetHover,
}: {
  data: RoofData;
  activeFacetId: string | null;
  hoverFacetId: string | null;
  onFacetClick: (id: string | null) => void;
  onFacetHover: (id: string | null) => void;
}) {
  const projected = useMemo(() => projectRoof(data), [data]);

  return (
    <>
      {/* Lighting — soft hemisphere + two directional fills. Tier-A blue
          tone from below for the "blueprint glow" feel. */}
      <hemisphereLight args={["#e6ecf2", "#0a1a26", 0.55]} />
      <directionalLight position={[25, 35, 15]} intensity={0.7} />
      <directionalLight position={[-20, 22, -12]} intensity={0.3} />

      {/* Blueprint grid — two layers: bold every 10 units, fine every 1. */}
      <gridHelper
        args={[
          Math.max(60, projected.sceneSize * 2.5),
          Math.max(60, projected.sceneSize * 2.5),
          "#0e1822",
          "#0e1822",
        ]}
        position={[0, -0.01, 0]}
      />
      <gridHelper
        args={[
          Math.max(60, projected.sceneSize * 2.5),
          Math.max(6, Math.floor(projected.sceneSize / 5)),
          "#1c3245",
          "#16242f",
        ]}
        position={[0, 0, 0]}
      />

      {/* Building walls — extrude footprint down from eave height to
          ground. Reads as a real model, not floating shingles. */}
      {projected.footprint.length >= 3 && (
        <BuildingShell
          footprint={projected.footprint}
          eaveHeight={projected.eaveHeight}
        />
      )}

      {/* Facets at correct pitch + azimuth. Click to inspect; hover to
          highlight. The 3D scene swallows clicks on facets but lets
          background clicks bubble — wrap the meshes in a click-empty
          group that clears the selection. */}
      <group onPointerMissed={() => onFacetClick(null)}>
        {projected.facets.map((f) => (
          <FacetMesh
            key={f.id}
            facet={f}
            isActive={activeFacetId === f.id}
            isHover={hoverFacetId === f.id}
            onClick={() =>
              onFacetClick(activeFacetId === f.id ? null : f.id)
            }
            onHover={(over) => onFacetHover(over ? f.id : null)}
          />
        ))}
      </group>

      {/* Edge polylines from LiDAR topology, color-coded by classification. */}
      {projected.edges.map((e) => (
        <EdgeLine key={e.id} edge={e} />
      ))}

      {/* Detected objects (chimneys, skylights, vents) as labeled boxes. */}
      {projected.objects.map((o) => (
        <ObjectMarker key={o.id} obj={o} />
      ))}

      {/* North arrow on the ground. */}
      <NorthArrow size={Math.max(8, projected.sceneSize * 0.35)} />
    </>
  );
}

// ─── Building shell (extruded walls) ─────────────────────────────────

function BuildingShell({
  footprint,
  eaveHeight,
}: {
  footprint: THREE.Vector2[];
  eaveHeight: number;
}) {
  const shape = useMemo(() => {
    const s = new THREE.Shape(footprint);
    return s;
  }, [footprint]);
  const geom = useMemo(
    () =>
      new THREE.ExtrudeGeometry(shape, {
        depth: eaveHeight,
        bevelEnabled: false,
        curveSegments: 4,
      }),
    [shape, eaveHeight],
  );
  return (
    <>
      {/* Solid wall mass — dim graphite, semi-transparent so the facets
          on top remain the visual focus. The wall is for context, not
          competition. */}
      <mesh
        geometry={geom}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, eaveHeight, 0]}
      >
        <meshStandardMaterial
          color="#0a1219"
          metalness={0.0}
          roughness={0.95}
          transparent
          opacity={0.55}
        />
      </mesh>
      {/* Bright drafting outline on the wall edges so they read as
          blueprint lines even with the dim fill. */}
      <lineSegments
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, eaveHeight, 0]}
      >
        <edgesGeometry args={[geom]} />
        <lineBasicMaterial color="#4a8cb8" transparent opacity={0.7} />
      </lineSegments>
    </>
  );
}

// ─── Facet mesh ───────────────────────────────────────────────────────

interface Facet3D {
  id: string;
  shape: THREE.Shape;
  centroidX: number;
  centroidY: number;
  centroidZ: number;
  pitchRad: number;
  azimuthRad: number;
  color: string;
  outlineColor: string;
}

function FacetMesh({
  facet,
  isActive,
  isHover,
  onClick,
  onHover,
}: {
  facet: Facet3D;
  isActive: boolean;
  isHover: boolean;
  onClick: () => void;
  onHover: (over: boolean) => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const geom = useMemo(() => new THREE.ShapeGeometry(facet.shape), [facet.shape]);
  // Selection / hover visual: brighten + cyan outline when selected,
  // gentle emissive bump on hover. Subtle but unmistakable.
  const emissive = isActive ? "#22d3ee" : isHover ? "#1e3a52" : "#000000";
  const emissiveIntensity = isActive ? 0.4 : isHover ? 0.2 : 0;
  const outlineColor = isActive ? "#22d3ee" : facet.outlineColor;
  return (
    // Outer group — positioned at the facet's centroid in scene coords.
    <group position={[facet.centroidX, facet.centroidY, facet.centroidZ]}>
      {/* Middle group — yaw (azimuth) around Y. Compass-aligned. */}
      <group rotation-y={facet.azimuthRad}>
        {/* Inner group — flatten ShapeGeometry from the XY plane onto
            the XZ plane (-π/2 around X) and additionally tilt by the
            roof pitch around the local X axis. Composing this way keeps
            the down-slope direction aligned with the azimuth yaw above
            instead of getting tangled in Euler-angle order. */}
        <group rotation-x={-Math.PI / 2 + facet.pitchRad}>
          <mesh
            ref={ref}
            geometry={geom}
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              onHover(true);
              document.body.style.cursor = "pointer";
            }}
            onPointerOut={() => {
              onHover(false);
              document.body.style.cursor = "";
            }}
          >
            <meshStandardMaterial
              color={facet.color}
              side={THREE.DoubleSide}
              metalness={0.1}
              roughness={0.65}
              transparent
              opacity={isActive ? 0.98 : 0.92}
              emissive={emissive}
              emissiveIntensity={emissiveIntensity}
            />
          </mesh>
          {/* Crisp blueprint outline. */}
          <lineSegments>
            <edgesGeometry args={[geom]} />
            <lineBasicMaterial
              color={outlineColor}
              linewidth={isActive ? 2 : 1}
            />
          </lineSegments>
        </group>
      </group>
    </group>
  );
}

// ─── Edge polyline (ridge/hip/valley/eave/rake/step-wall) ────────────

interface Edge3D {
  id: string;
  type: Edge["type"];
  points: THREE.Vector3[];
  color: string;
  width: number;
}

function EdgeLine({ edge }: { edge: Edge3D }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setFromPoints(edge.points);
    return g;
  }, [edge.points]);
  return (
    <line>
      <primitive object={geom} attach="geometry" />
      <lineBasicMaterial
        color={edge.color}
        linewidth={edge.width}
        transparent
        opacity={0.9}
      />
    </line>
  );
}

// ─── Object marker (chimney, skylight, vent) ──────────────────────────

interface Object3D {
  id: string;
  kind: RoofObject["kind"];
  position: THREE.Vector3;
  size: THREE.Vector3;
  color: string;
}

function ObjectMarker({ obj }: { obj: Object3D }) {
  return (
    <mesh position={obj.position}>
      <boxGeometry args={[obj.size.x, obj.size.y, obj.size.z]} />
      <meshStandardMaterial
        color={obj.color}
        metalness={0.2}
        roughness={0.55}
        emissive={obj.color}
        emissiveIntensity={0.08}
      />
    </mesh>
  );
}

// ─── North arrow ──────────────────────────────────────────────────────

function NorthArrow({ size }: { size: number }) {
  // Triangle pointing -Z (which is "north" in our projection).
  const shape = useMemo(() => {
    const s = new THREE.Shape();
    s.moveTo(0, -size * 0.5);
    s.lineTo(size * 0.12, size * 0.1);
    s.lineTo(0, size * 0.02);
    s.lineTo(-size * 0.12, size * 0.1);
    s.closePath();
    return s;
  }, [size]);
  return (
    <group position={[-size * 0.9, 0.02, -size * 0.4]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <shapeGeometry args={[shape]} />
        <meshBasicMaterial color="#5c8db0" transparent opacity={0.7} />
      </mesh>
    </group>
  );
}

// ─── Overlay UI (legend + corner bracket) ─────────────────────────────

function BlueprintLegend({ data }: { data: RoofData }) {
  const totals = data.totals;
  return (
    <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between text-white pointer-events-none">
      <div className="space-y-0.5">
        <div className="text-[10.5px] font-mono uppercase tracking-[0.16em] text-cyan-300/80">
          ✓ Measured · USGS LiDAR
        </div>
        <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-white/40">
          confidence {Math.round((data.confidence ?? 0) * 100)}%
        </div>
      </div>
      <div className="text-right space-y-0.5">
        <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/60">
          {totals.facetsCount} planes ·{" "}
          {Math.round(totals.totalRoofAreaSqft).toLocaleString()} sqft
        </div>
        {totals.averagePitchDegrees > 0 && (
          <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/40">
            {formatPitch(totals.averagePitchDegrees)} avg pitch
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Facet inspector overlay ──────────────────────────────────────────

function FacetInspector({
  facet,
  sourceLabel,
  onClose,
}: {
  facet: Facet;
  sourceLabel: string;
  onClose: () => void;
}) {
  const pitchRise = Math.round(12 * Math.tan((facet.pitchDegrees * Math.PI) / 180));
  const cardinal = azimuthCardinal(facet.azimuthDeg);
  const facetIndex = facet.id.replace(/^facet-?/i, "") || facet.id;
  return (
    <div className="absolute top-[52px] right-3 z-20 w-[260px] rounded-2xl border border-cyan-400/25 bg-black/80 backdrop-blur-md text-white shadow-2xl overflow-hidden">
      {/* Header strip — cyan accent line under the title to match the
          selected facet's outline color in the 3D scene. */}
      <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1 h-3 bg-cyan-400 rounded-full" />
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300/70">
              Facet {facetIndex}
            </div>
            <div className="text-[10px] text-white/45 font-mono mt-0.5">
              {sourceLabel} source
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-white/55 hover:text-white/90 transition-colors"
          aria-label="Close facet inspector"
        >
          <X size={13} />
        </button>
      </div>
      <div className="p-4 space-y-3">
        <Row label="Pitch" value={`${pitchRise}/12 (${facet.pitchDegrees.toFixed(1)}°)`} />
        <Row label="Azimuth" value={`${cardinal} (${Math.round(facet.azimuthDeg)}°)`} />
        <Row
          label="Sloped area"
          value={`${Math.round(facet.areaSqftSloped).toLocaleString()} sqft`}
        />
        <Row
          label="Footprint"
          value={`${Math.round(facet.areaSqftFootprint).toLocaleString()} sqft`}
        />
        <Row
          label="Low slope"
          value={facet.isLowSlope ? "Yes (<2/12)" : "No"}
        />
        {facet.material && (
          <Row label="Material" value={prettyMaterial(facet.material)} />
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/45">
        {label}
      </div>
      <div className="text-[12.5px] font-medium text-white/90 tabular-nums">
        {value}
      </div>
    </div>
  );
}

function azimuthCardinal(deg: number): string {
  const a = ((deg % 360) + 360) % 360;
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return labels[Math.round(a / 45) % 8];
}

function prettyMaterial(m: string): string {
  switch (m) {
    case "asphalt-3tab": return "Asphalt (3-tab)";
    case "asphalt-architectural": return "Asphalt (architectural)";
    case "metal-standing-seam": return "Metal (standing seam)";
    case "tile-concrete": return "Concrete tile";
    case "wood-shake": return "Wood shake";
    case "flat-membrane": return "Flat membrane";
    default: return m;
  }
}

function BlueprintCorner() {
  return (
    <div className="absolute top-3 left-3 pointer-events-none">
      <div className="flex flex-col">
        <div className="h-3 w-3 border-l border-t border-cyan-400/40" />
      </div>
    </div>
  );
}

// ─── Projection: lat/lng → scene meters ──────────────────────────────

interface Projected {
  facets: Facet3D[];
  edges: Edge3D[];
  objects: Object3D[];
  footprint: THREE.Vector2[];
  eaveHeight: number;
  sceneSize: number;
}

function projectRoof(data: RoofData): Projected {
  const lat0 = data.address.lat;
  const lng0 = data.address.lng;
  const M_PER_DEG_LAT = 111_320;
  const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);

  const toScene = (lat: number, lng: number): [number, number] => [
    (lng - lng0) * M_PER_DEG_LNG,
    -(lat - lat0) * M_PER_DEG_LAT,
  ];

  // Eave height — a fixed reasonable default for residential. The
  // LiDAR data doesn't include ridge/eave Z (just facet pitches), so
  // we synthesize a building shell at a believable height.
  const eaveHeight = 2.6;

  let maxRange = 0;

  // Facets
  const facets: Facet3D[] = [];
  for (const f of data.facets) {
    if (!f.polygon || f.polygon.length < 3) continue;
    // Project lat/lng → scene coords (x_scene east meters, z_scene
    // south meters — note the negation in toScene).
    const ptsScene = f.polygon.map((v) => {
      const [x, z] = toScene(v.lat, v.lng);
      maxRange = Math.max(maxRange, Math.hypot(x, z));
      return [x, z] as [number, number];
    });
    const cx = ptsScene.reduce((s, p) => s + p[0], 0) / ptsScene.length;
    const cz = ptsScene.reduce((s, p) => s + p[1], 0) / ptsScene.length;

    // CRITICAL BUG FIX: the Shape's vertices MUST be local to the
    // centroid. Previously they were absolute scene coords, which then
    // got translated AGAIN by (cx, cz) when we positioned the parent
    // group — doubling every facet's distance from origin (= the
    // "facets scattered in 3D" symptom in the screenshots).
    //
    // We also negate the local-z (= shape-y) because ShapeGeometry is
    // built in the XY plane, and we rotate it by -π/2 around X to lay
    // it flat — that rotation takes shape-Y → -scene-Z. Pre-negating
    // keeps the polygon's compass orientation correct after flatten.
    const pts2dLocal = ptsScene.map(
      ([x, z]) => new THREE.Vector2(x - cx, -(z - cz)),
    );
    const shape = new THREE.Shape(pts2dLocal);

    const pitchRad = (f.pitchDegrees * Math.PI) / 180;
    // Compass azimuth runs clockwise from north; Three.js Y-rotation is
    // right-hand counterclockwise. Flip sign to match.
    const azimuthRad = -(((f.azimuthDeg ?? 0) * Math.PI) / 180);

    // Uniform centroid height — sit each facet a small constant above
    // the wall top. The pitch tilt naturally lifts the up-slope edge
    // and drops the down-slope edge; the OLD code added a per-facet
    // `radius * tan(pitch) * 0.35` lift which was what threw outlying
    // facets into the sky.
    const cy = eaveHeight + 0.25;

    facets.push({
      id: f.id,
      shape,
      centroidX: cx,
      centroidY: cy,
      centroidZ: cz,
      pitchRad,
      azimuthRad,
      color: colorForAzimuth(f.azimuthDeg ?? 0, f.pitchDegrees),
      outlineColor: outlineForPitch(f.pitchDegrees),
    });
  }

  // Edges. Ridges/hips/valleys ride at the ridge plane (higher than
  // eaves/rakes). Without 3D edge data (Tier C) we approximate:
  //   - ridge / hip / valley → ridge height (eave + 1.5m)
  //   - eave / rake / step-wall → eave height
  // This gets the visual reading right without needing per-vertex
  // heights from the source data.
  const edges: Edge3D[] = [];
  const ridgeHeight = eaveHeight + 1.5;
  for (const e of data.edges) {
    if (!e.polyline || e.polyline.length < 2) continue;
    const isRidgeLike =
      e.type === "ridge" || e.type === "hip" || e.type === "valley";
    const defaultY = isRidgeLike ? ridgeHeight : eaveHeight + 0.05;
    const points = e.polyline.map((v) => {
      const [x, z] = toScene(v.lat, v.lng);
      const y = v.heightM > 0 ? eaveHeight + v.heightM : defaultY;
      return new THREE.Vector3(x, y, z);
    });
    edges.push({
      id: e.id,
      type: e.type,
      points,
      color: edgeColor(e.type),
      width: e.type === "ridge" ? 3 : 2,
    });
  }

  // Objects
  const objects: Object3D[] = [];
  for (const o of data.objects) {
    const [x, z] = toScene(o.position.lat, o.position.lng);
    const wIn = Math.max(1.5, o.dimensionsFt.width || 2) * 0.3048;
    const lIn = Math.max(1.5, o.dimensionsFt.length || 2) * 0.3048;
    // Object height — chimneys taller, skylights flat.
    const h = o.kind === "chimney"
      ? 1.5
      : o.kind === "skylight"
        ? 0.15
        : 0.6;
    const y =
      o.position.heightM > 0 ? eaveHeight + o.position.heightM + h / 2 : eaveHeight + h / 2 + 0.5;
    objects.push({
      id: o.id,
      kind: o.kind,
      position: new THREE.Vector3(x, y, z),
      size: new THREE.Vector3(wIn, h, lIn),
      color: objectColor(o.kind),
    });
  }

  // Footprint — prefer the LiDAR / Solar outlinePolygon (tight), fall
  // back to the union of facet polygons' bounding hull.
  let footprint: THREE.Vector2[] = [];
  if (data.outlinePolygon && data.outlinePolygon.length >= 3) {
    footprint = data.outlinePolygon.map((v) => {
      const [x, z] = toScene(v.lat, v.lng);
      return new THREE.Vector2(x, z);
    });
  } else {
    // Convex hull of all facet vertices is a decent fallback shape.
    const all: THREE.Vector2[] = [];
    for (const f of data.facets) {
      for (const v of f.polygon) {
        const [x, z] = toScene(v.lat, v.lng);
        all.push(new THREE.Vector2(x, z));
      }
    }
    footprint = convexHull(all);
  }

  return {
    facets,
    edges,
    objects,
    footprint,
    eaveHeight,
    sceneSize: Math.max(15, maxRange),
  };
}

// Andrew's monotone chain. Small util — only used as the fallback when
// the LiDAR outlinePolygon is missing, so a real-roof Tier A response
// never reaches this path.
function convexHull(pts: THREE.Vector2[]): THREE.Vector2[] {
  if (pts.length < 3) return pts.slice();
  const sorted = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: THREE.Vector2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: THREE.Vector2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ─── Color helpers ────────────────────────────────────────────────────

function colorForAzimuth(azimuthDeg: number, pitchDeg: number): string {
  // Voxaris palette: north→teal, east→emerald, south→gold, west→rose.
  const corners: Array<[number, [number, number, number]]> = [
    [0, [56, 197, 238]],
    [90, [46, 204, 113]],
    [180, [212, 168, 67]],
    [270, [229, 78, 106]],
    [360, [56, 197, 238]],
  ];
  const a = ((azimuthDeg % 360) + 360) % 360;
  let lo = corners[0];
  let hi = corners[corners.length - 1];
  for (let i = 0; i < corners.length - 1; i++) {
    if (a >= corners[i][0] && a <= corners[i + 1][0]) {
      lo = corners[i];
      hi = corners[i + 1];
      break;
    }
  }
  const t = (a - lo[0]) / Math.max(1, hi[0] - lo[0]);
  const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * t);
  const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * t);
  const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * t);
  const sat = Math.min(1.0, 0.85 + pitchDeg / 200);
  const rr = Math.round(r * sat);
  const gg = Math.round(g * sat);
  const bb = Math.round(b * sat);
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

function outlineForPitch(pitchDeg: number): string {
  // Darker outline on steeper pitches so they pop visually.
  if (pitchDeg > 38) return "#3b1d1d";
  if (pitchDeg < 18.43) return "#0d2a3a";
  return "#0e2014";
}

function edgeColor(type: Edge["type"]): string {
  switch (type) {
    case "ridge": return "#ff5757";
    case "hip": return "#ff9d4d";
    case "valley": return "#3aa0ff";
    case "eave": return "#5fe4a3";
    case "rake": return "#28b97f";
    case "step-wall": return "#c084fc";
    default: return "#94a3b8";
  }
}

function objectColor(kind: RoofObject["kind"]): string {
  switch (kind) {
    case "chimney": return "#a14a3a";
    case "skylight": return "#5fd0ff";
    case "vent":
    case "ridge-vent":
    case "box-vent":
    case "turbine": return "#7a8794";
    case "stack": return "#525c66";
    case "satellite-dish": return "#d4a843";
    case "dormer": return "#8b5cf6";
    default: return "#94a3b8";
  }
}

function formatPitch(deg: number): string {
  const rise = Math.round(12 * Math.tan((deg * Math.PI) / 180));
  return `${rise}/12 (${Math.round(deg)}°)`;
}

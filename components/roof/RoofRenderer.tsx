"use client";

/**
 * components/roof/RoofRenderer.tsx
 *
 * Standalone 3D roof renderer for Tier A LiDAR output. Renders the
 * roof as a true 3D model — facets at the correct pitch/azimuth,
 * edges classified and color-coded, detected objects as labeled
 * markers — over a subtle blueprint grid. Walls intentionally NOT
 * synthesized: they were a cosmetic add at a fixed eave height with
 * no measurement backing and fought visually with the roof mesh.
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
  // Click a quad → see its matched pitch / azimuth / sqft in the inspector.
  const [activeFacetId, setActiveFacetId] = useState<string | null>(null);
  const [hoverFacetId, setHoverFacetId] = useState<string | null>(null);

  // Choose the BEST outline across both sources — this stays stable
  // across the LiDAR/Solar toggle so the building shell doesn't reshape
  // when the user flips sources. Heuristic: prefer the outline with
  // the most vertices in the [8, 40] range (more detail without
  // dataLayers-mask noise); fall back to whichever exists.
  const bestOutline = useMemo(() => {
    const candidates = [lidar?.outlinePolygon, solar?.outlinePolygon, data.outlinePolygon];
    const valid = candidates
      .filter(
        (p): p is Array<{ lat: number; lng: number }> =>
          Array.isArray(p) && p.length >= 3,
      )
      .sort((a, b) => {
        const aScore = a.length >= 8 && a.length <= 40 ? a.length + 1000 : a.length;
        const bScore = b.length >= 8 && b.length <= 40 ? b.length + 1000 : b.length;
        return bScore - aScore;
      });
    return valid[0] ?? null;
  }, [lidar, solar, data]);

  // Compute the projected scene at the parent level (was previously
  // inside RoofScene's useMemo) so the inspector can look up the
  // active quad's data — the source of truth is now the generated
  // quad, not the raw source facet.
  const projected = useMemo(
    () =>
      active
        ? projectRoof(active.data, { outlineOverride: bestOutline })
        : null,
    [active, bestOutline],
  );
  const activeQuad =
    projected?.roofQuads.find((q) => q.id === activeFacetId) ?? null;

  if (!active || !projected) return null;

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
          projected={projected}
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
      {/* Facet inspector — slides in from the right when a quad is
          clicked. Shows pitch (in /12 + degrees), azimuth (cardinal +
          degrees), and sloped area. Inherits source-facet sqft when
          the quad matched a source facet; falls back to estimating
          sqft from the quad's 4 corners otherwise. */}
      {activeQuad && (
        <FacetInspector
          quad={activeQuad}
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
  projected,
  activeFacetId,
  hoverFacetId,
  onFacetClick,
  onFacetHover,
}: {
  projected: Projected;
  activeFacetId: string | null;
  hoverFacetId: string | null;
  onFacetClick: (id: string | null) => void;
  onFacetHover: (id: string | null) => void;
}) {
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

      {/* Wall extrusion intentionally removed. The synthesized walls
          were a "make it look like a building" cosmetic — they didn't
          come from any measurement, just a fixed 2.6m default. They
          fought visually with the roof mesh and obscured the actual
          measured geometry. The roof mesh + ground grid alone read
          cleaner. */}

      {/* Roof mesh — generated from the building outline as a frustum
          (inset-polygon hip approximation). Each outline edge produces
          one quad facet that slopes inward + upward to a "ridge polygon"
          inset 35% toward the centroid. Each generated quad is
          color-matched to the closest source-data facet by azimuth,
          inheriting its pitch / id / color / material so the inspector
          click flow still works.
          ---
          Phase 2 note: when `data.meshSource === "polyfit"` and the
          Python side actually returns a watertight mesh with shared
          edges, this frustum approximation becomes redundant — we'd
          render the real facets directly from `data.facets[]`
          polygons. That wiring is fast-follow once PolyFit is
          verified in the Modal image (see services/roof-lidar/
          regularize_planes.py for current CGAL binding stub). Until
          then the frustum is the universal render path. */}
      <group onPointerMissed={() => onFacetClick(null)}>
        {projected.roofQuads.map((q) => (
          <RoofQuad
            key={q.id}
            quad={q}
            isActive={activeFacetId === q.id}
            isHover={hoverFacetId === q.id}
            onClick={() =>
              onFacetClick(activeFacetId === q.id ? null : q.id)
            }
            onHover={(over) => onFacetHover(over ? q.id : null)}
          />
        ))}
        {/* Ridge cap — flat polygon on top of the frustum that fills
            the inset polygon. Without this, you can see through the
            roof from above. */}
        {projected.ridgePolygon.length >= 3 && (
          <RidgeCap
            polygon={projected.ridgePolygon}
            height={projected.ridgeHeight + projected.eaveHeight}
          />
        )}
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

// ─── Generated roof quad (frustum approach) ──────────────────────────
//
// Each quad is one slope of the generated frustum hip-roof — defined by
// 4 corner points in scene meters (already at correct y heights). We
// build a BufferGeometry with 2 triangles, color it by the matched
// source-facet azimuth/pitch, and outline it for the blueprint feel.

interface RoofQuad3D {
  /** Stable id — `sourceFacetId` when matched, else `quad-<i>`. */
  id: string;
  /** 4 corners in scene coords, ordered: eaveA, eaveB, ridgeB, ridgeA.
   *  eave corners sit at y=eaveHeight; ridge corners at y=eave+rise. */
  corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  color: string;
  outlineColor: string;
  pitchDegrees: number;
  azimuthDeg: number;
  /** The original source facet this quad represents (for the inspector). */
  sourceFacet: Facet | null;
}

function RoofQuad({
  quad,
  isActive,
  isHover,
  onClick,
  onHover,
}: {
  quad: RoofQuad3D;
  isActive: boolean;
  isHover: boolean;
  onClick: () => void;
  onHover: (over: boolean) => void;
}) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const [a, b, c, d] = quad.corners;
    // Two triangles forming the quad: (a,b,c) and (a,c,d). Winding
    // matches a quad with outward normal facing up-and-out.
    const positions = new Float32Array([
      a.x, a.y, a.z,
      b.x, b.y, b.z,
      c.x, c.y, c.z,
      a.x, a.y, a.z,
      c.x, c.y, c.z,
      d.x, d.y, d.z,
    ]);
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.computeVertexNormals();
    return g;
  }, [quad.corners]);

  const outlineGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const [a, b, c, d] = quad.corners;
    // Closed loop a → b → c → d → a as line segments.
    const positions = new Float32Array([
      a.x, a.y, a.z, b.x, b.y, b.z,
      b.x, b.y, b.z, c.x, c.y, c.z,
      c.x, c.y, c.z, d.x, d.y, d.z,
      d.x, d.y, d.z, a.x, a.y, a.z,
    ]);
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [quad.corners]);

  const emissive = isActive ? "#22d3ee" : isHover ? "#1e3a52" : "#000000";
  const emissiveIntensity = isActive ? 0.4 : isHover ? 0.2 : 0;
  const outlineColor = isActive ? "#22d3ee" : quad.outlineColor;

  return (
    <group onPointerMissed={undefined}>
      <mesh
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
          color={quad.color}
          side={THREE.DoubleSide}
          metalness={0.1}
          roughness={0.65}
          transparent
          opacity={isActive ? 0.98 : 0.92}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
        />
      </mesh>
      <lineSegments geometry={outlineGeom}>
        <lineBasicMaterial
          color={outlineColor}
          linewidth={isActive ? 2 : 1}
        />
      </lineSegments>
    </group>
  );
}

// ─── Ridge cap (flat top of the frustum) ─────────────────────────────

function RidgeCap({
  polygon,
  height,
}: {
  polygon: THREE.Vector2[];
  height: number;
}) {
  const geom = useMemo(() => {
    const shape = new THREE.Shape(polygon);
    return new THREE.ShapeGeometry(shape);
  }, [polygon]);
  return (
    <>
      <mesh
        geometry={geom}
        // ShapeGeometry sits in XY plane; rotate -π/2 around X to lay
        // it flat on the XZ plane, then raise to the ridge height.
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, height, 0]}
      >
        <meshStandardMaterial
          color="#1a1f28"
          metalness={0.05}
          roughness={0.85}
          side={THREE.DoubleSide}
          transparent
          opacity={0.95}
        />
      </mesh>
      <lineSegments
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, height + 0.01, 0]}
      >
        <edgesGeometry args={[geom]} />
        <lineBasicMaterial color="#3a5c7a" transparent opacity={0.7} />
      </lineSegments>
    </>
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
  quad,
  sourceLabel,
  onClose,
}: {
  quad: RoofQuad3D;
  sourceLabel: string;
  onClose: () => void;
}) {
  const pitchDeg = quad.pitchDegrees;
  const pitchRise = Math.round(12 * Math.tan((pitchDeg * Math.PI) / 180));
  const cardinal = azimuthCardinal(quad.azimuthDeg);
  // Sqft: prefer the matched source facet's sloped area when available;
  // fall back to computing from the quad's 4 corners (trapezoid area /
  // cos(pitch) for sloped sqft).
  const slopedSqft =
    quad.sourceFacet?.areaSqftSloped ?? quadSlopedSqft(quad);
  const footprintSqft =
    quad.sourceFacet?.areaSqftFootprint ?? quadFootprintSqft(quad);
  const facetIndex = quad.id.replace(/^(facet-?|quad-?)/i, "") || quad.id;
  return (
    <div className="absolute top-[52px] right-3 z-20 w-[260px] rounded-2xl border border-cyan-400/25 bg-black/80 backdrop-blur-md text-white shadow-2xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1 h-3 bg-cyan-400 rounded-full" />
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-300/70">
              Facet {facetIndex}
            </div>
            <div className="text-[10px] text-white/45 font-mono mt-0.5">
              {sourceLabel} source
              {quad.sourceFacet ? "" : " · estimated"}
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
        <Row label="Pitch" value={`${pitchRise}/12 (${pitchDeg.toFixed(1)}°)`} />
        <Row label="Azimuth" value={`${cardinal} (${Math.round(quad.azimuthDeg)}°)`} />
        <Row
          label="Sloped area"
          value={`${Math.round(slopedSqft).toLocaleString()} sqft`}
        />
        <Row
          label="Footprint"
          value={`${Math.round(footprintSqft).toLocaleString()} sqft`}
        />
        <Row
          label="Low slope"
          value={pitchDeg < 9.46 ? "Yes (<2/12)" : "No"}
        />
        {quad.sourceFacet?.material && (
          <Row label="Material" value={prettyMaterial(quad.sourceFacet.material)} />
        )}
      </div>
    </div>
  );
}

/** Sloped sqft from a quad's 4 scene-meter corners. Triangulates into
 *  2 triangles and sums their areas in 3D, then converts m² → sqft. */
function quadSlopedSqft(quad: RoofQuad3D): number {
  const [a, b, c, d] = quad.corners;
  const triArea = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3) => {
    const u = new THREE.Vector3().subVectors(q, p);
    const v = new THREE.Vector3().subVectors(r, p);
    return new THREE.Vector3().crossVectors(u, v).length() / 2;
  };
  const m2 = triArea(a, b, c) + triArea(a, c, d);
  return m2 * 10.7639;
}

/** Footprint sqft: same area but projected to the XZ plane. */
function quadFootprintSqft(quad: RoofQuad3D): number {
  const flat = quad.corners.map((c) => new THREE.Vector2(c.x, c.z));
  const triArea2 = (p: THREE.Vector2, q: THREE.Vector2, r: THREE.Vector2) =>
    Math.abs((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y)) / 2;
  const m2 = triArea2(flat[0], flat[1], flat[2]) + triArea2(flat[0], flat[2], flat[3]);
  return m2 * 10.7639;
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
  /** One quad per building-outline edge — see generateFrustumRoof. */
  roofQuads: RoofQuad3D[];
  /** Inset polygon at ridge height — caps off the top of the frustum
   *  so you can't see through the roof from above. */
  ridgePolygon: THREE.Vector2[];
  /** Height (above eave) of the ridge polygon. */
  ridgeHeight: number;
  edges: Edge3D[];
  objects: Object3D[];
  footprint: THREE.Vector2[];
  eaveHeight: number;
  sceneSize: number;
}

function projectRoof(
  data: RoofData,
  opts: {
    /** Override outline polygon (lat/lng). Used by cross-compare mode
     *  to render a consistent building shell across both source toggles
     *  — we pick the best outline from LiDAR + Solar once and pass it
     *  to every render, so flipping the source doesn't reshape the wall. */
    outlineOverride?: Array<{ lat: number; lng: number }> | null;
  } = {},
): Projected {
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
  // Pass-through over source facets to compute sceneSize (for camera /
  // grid sizing). We DON'T render these directly — the visible roof is
  // generated from the outline below.
  for (const f of data.facets) {
    if (!f.polygon || f.polygon.length < 3) continue;
    for (const v of f.polygon) {
      const [x, z] = toScene(v.lat, v.lng);
      maxRange = Math.max(maxRange, Math.hypot(x, z));
    }
  }

  // Edges. Ridges/hips/valleys ride at the ridge plane (higher than
  // eaves/rakes). Without 3D edge data (Tier C) we approximate:
  //   - ridge / hip / valley → ridge height (eave + 1.5m)
  //   - eave / rake / step-wall → eave height
  // This gets the visual reading right without needing per-vertex
  // heights from the source data.
  const edges: Edge3D[] = [];
  const edgeRidgeHeight = eaveHeight + 1.5;
  for (const e of data.edges) {
    if (!e.polyline || e.polyline.length < 2) continue;
    const isRidgeLike =
      e.type === "ridge" || e.type === "hip" || e.type === "valley";
    const defaultY = isRidgeLike ? edgeRidgeHeight : eaveHeight + 0.05;
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

  // Footprint — prefer the cross-source outlineOverride (best across
  // LiDAR + Solar), else this source's own outlinePolygon, else fall
  // back to the union of facet polygons' bounding hull.
  let footprint: THREE.Vector2[] = [];
  const outlineSource =
    opts.outlineOverride && opts.outlineOverride.length >= 3
      ? opts.outlineOverride
      : data.outlinePolygon && data.outlinePolygon.length >= 3
        ? data.outlinePolygon
        : null;
  if (outlineSource) {
    footprint = outlineSource.map((v) => {
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

  // Generate the visible roof from the outline. One quad per outline
  // edge, each matched to the closest source-data facet by azimuth so
  // colors / pitch / inspector ids carry through.
  const { roofQuads, ridgePolygon, ridgeHeight } = generateFrustumRoof({
    footprint,
    sourceFacets: data.facets,
    eaveHeight,
  });

  return {
    roofQuads,
    ridgePolygon,
    ridgeHeight,
    edges,
    objects,
    footprint,
    eaveHeight,
    sceneSize: Math.max(15, maxRange),
  };
}

// ─── Frustum roof generator ──────────────────────────────────────────
//
// Treats the building outline as the eave line and generates one quad
// per outline edge. Each quad slopes inward + upward to a "ridge
// polygon" inset 35% toward the building centroid. The ridge polygon
// is filled with a flat cap (RidgeCap component).
//
// This is a "mansard hip" approximation — for a true hip roof, the
// ridge would collapse to a line (or to single points for square
// buildings). For most residential outlines it reads as a proper roof
// without needing a straight-skeleton algorithm. L-shaped and
// rectangular outlines both produce coherent results.
//
// Each generated quad is matched to the closest source-data facet by
// azimuth, inheriting its pitch (for slope steepness) and its id
// (so the FacetInspector still pops the source-data details on click).

const RIDGE_INSET_FRAC = 0.35;

function generateFrustumRoof(opts: {
  footprint: THREE.Vector2[];
  sourceFacets: Facet[];
  eaveHeight: number;
}): {
  roofQuads: RoofQuad3D[];
  ridgePolygon: THREE.Vector2[];
  ridgeHeight: number;
} {
  const { footprint, sourceFacets, eaveHeight } = opts;
  if (footprint.length < 3) {
    return { roofQuads: [], ridgePolygon: [], ridgeHeight: 0 };
  }

  // Centroid of the building outline.
  const fx = footprint.reduce((s, p) => s + p.x, 0) / footprint.length;
  const fy = footprint.reduce((s, p) => s + p.y, 0) / footprint.length;

  // Inset polygon — each vertex pulled `RIDGE_INSET_FRAC` toward the
  // centroid. This is the "ridge polygon" — top of the frustum.
  const inset = footprint.map(
    (v) =>
      new THREE.Vector2(
        v.x + RIDGE_INSET_FRAC * (fx - v.x),
        v.y + RIDGE_INSET_FRAC * (fy - v.y),
      ),
  );

  // Average pitch across source facets — used as a fallback when the
  // azimuth-match doesn't return a facet. Weighted by sloped area so
  // small noisy facets don't dominate.
  let totalArea = 0;
  let weightedPitch = 0;
  for (const f of sourceFacets) {
    const a = f.areaSqftSloped || 0;
    totalArea += a;
    weightedPitch += (f.pitchDegrees || 0) * a;
  }
  const avgPitchDeg = totalArea > 0 ? weightedPitch / totalArea : 22; // 22° ≈ 5/12

  // For each outline edge, generate a quad facet.
  const roofQuads: RoofQuad3D[] = [];
  let maxRidgeLift = 0;
  for (let i = 0; i < footprint.length; i++) {
    const next = (i + 1) % footprint.length;
    const eaveA = footprint[i];
    const eaveB = footprint[next];
    const ridgeA = inset[i];
    const ridgeB = inset[next];

    // Edge direction + outward normal. The outward normal is the
    // perpendicular to the edge, pointing AWAY from the centroid.
    const ex = eaveB.x - eaveA.x;
    const ey = eaveB.y - eaveA.y;
    const edgeLen = Math.hypot(ex, ey);
    if (edgeLen < 0.01) continue;
    // Edge midpoint
    const mx = (eaveA.x + eaveB.x) / 2;
    const my = (eaveA.y + eaveB.y) / 2;
    // Two candidate normals — pick the one pointing AWAY from centroid.
    const nx1 = -ey / edgeLen;
    const ny1 = ex / edgeLen;
    const outwardSign =
      (mx + nx1 - fx) * (mx + nx1 - fx) + (my + ny1 - fy) * (my + ny1 - fy) >
      (mx - fx) * (mx - fx) + (my - fy) * (my - fy)
        ? 1
        : -1;
    const nx = nx1 * outwardSign;
    const ny = ny1 * outwardSign;
    // Compass azimuth from outward normal. Scene-x = east, scene-z
    // (= our shape-y, positive southward). Compass 0 = north (-z),
    // 90 = east (+x), 180 = south (+z), 270 = west (-x).
    const azimuthDeg = scenenormalToCompass(nx, ny);

    // Match this quad to the closest source-data facet by azimuth.
    const matched = findClosestFacetByAzimuth(sourceFacets, azimuthDeg);
    const pitchDeg = matched?.pitchDegrees ?? avgPitchDeg;

    // Compute the rise from eave to ridge for this quad. The inset
    // distance (perpendicular from eave to ridge edge) times tan(pitch).
    const insetDist = pointToSegmentDistance(ridgeA, eaveA, eaveB);
    const rise = insetDist * Math.tan((pitchDeg * Math.PI) / 180);
    maxRidgeLift = Math.max(maxRidgeLift, rise);

    const ridgeY = eaveHeight + rise;
    const corners: [
      THREE.Vector3,
      THREE.Vector3,
      THREE.Vector3,
      THREE.Vector3,
    ] = [
      new THREE.Vector3(eaveA.x, eaveHeight, eaveA.y),
      new THREE.Vector3(eaveB.x, eaveHeight, eaveB.y),
      new THREE.Vector3(ridgeB.x, ridgeY, ridgeB.y),
      new THREE.Vector3(ridgeA.x, ridgeY, ridgeA.y),
    ];

    roofQuads.push({
      id: matched?.id ?? `quad-${i}`,
      corners,
      color: colorForAzimuth(azimuthDeg, pitchDeg),
      outlineColor: outlineForPitch(pitchDeg),
      pitchDegrees: pitchDeg,
      azimuthDeg,
      sourceFacet: matched,
    });
  }

  return {
    roofQuads,
    ridgePolygon: inset,
    ridgeHeight: maxRidgeLift,
  };
}

/** Compass azimuth (clockwise from north, degrees) for a 2D scene
 *  normal (x_east, y_south_meters). */
function scenenormalToCompass(nx: number, ny: number): number {
  // Scene-x = east, scene-z = our `ny` here (positive southward).
  // Compass:  0 = north (-z), 90 = east (+x), 180 = south (+z), 270 = west (-x).
  // atan2(east_component, north_component) → 0 when pointing north.
  // east_component = nx, north_component = -ny.
  const rad = Math.atan2(nx, -ny);
  const deg = (rad * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Find the source-data facet whose azimuth is closest to `targetDeg`
 *  on the compass circle. Returns null when no facets are available. */
function findClosestFacetByAzimuth(
  facets: Facet[],
  targetDeg: number,
): Facet | null {
  if (facets.length === 0) return null;
  let best: Facet | null = null;
  let bestDelta = Infinity;
  for (const f of facets) {
    let d = Math.abs((f.azimuthDeg ?? 0) - targetDeg) % 360;
    if (d > 180) d = 360 - d;
    if (d < bestDelta) {
      bestDelta = d;
      best = f;
    }
  }
  return best;
}

/** Perpendicular distance from point P to segment AB. */
function pointToSegmentDistance(
  p: THREE.Vector2,
  a: THREE.Vector2,
  b: THREE.Vector2,
): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq),
  );
  const closeX = a.x + t * abx;
  const closeY = a.y + t * aby;
  return Math.hypot(p.x - closeX, p.y - closeY);
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

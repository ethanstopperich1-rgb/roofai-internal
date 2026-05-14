"use client";

/**
 * components/roof/RoofRenderer.tsx
 *
 * Standalone 3D roof renderer for Tier A LiDAR output. Renders each
 * facet as its own tilted polygon at the correct pitch and azimuth,
 * color-coded by direction. No photorealistic mesh underneath — this
 * is the "engineering blueprint" view that says "we measured your
 * roof with USGS LiDAR" rather than competing with Google's
 * photogrammetric texture.
 *
 * Why this exists instead of overlaying onto Cesium's photogrammetric
 * mesh: when our measurement is slightly off (alpha-shape boundary,
 * facet count) the overlay creates an obvious visible mismatch.
 * Without a photo reference underneath, the same data reads as a
 * stylized accurate render. Same data, completely different perceived
 * quality.
 */

import { useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import * as THREE from "three";
import type { RoofData } from "@/types/roof";

// React-three-fiber must be client-side only — it touches `window`
// in module init. Dynamic-import the inner scene so SSR doesn't
// blow up.
const Canvas = dynamic(
  () => import("@react-three/fiber").then((m) => m.Canvas),
  { ssr: false },
);
const OrbitControls = dynamic(
  () => import("@react-three/drei").then((m) => m.OrbitControls),
  { ssr: false },
);

interface Props {
  data: RoofData;
  /** Optional className for the outer container (sizing/styling). */
  className?: string;
}

export default function RoofRenderer({ data, className }: Props) {
  if (data.source === "none" || data.facets.length === 0) return null;
  return (
    <div
      className={
        className ??
        "relative w-full aspect-[4/3] rounded-xl overflow-hidden bg-black"
      }
    >
      <Canvas
        camera={{ position: [40, 30, 40], fov: 50 }}
        gl={{ antialias: true, alpha: false }}
      >
        <color attach="background" args={["#06070a"]} />
        <RoofScene data={data} />
        <OrbitControls
          enablePan={false}
          enableZoom={true}
          enableRotate={true}
          autoRotate={true}
          autoRotateSpeed={0.6}
          minPolarAngle={Math.PI / 6}
          maxPolarAngle={Math.PI / 2.05}
        />
      </Canvas>
      <RoofRendererLegend data={data} />
    </div>
  );
}

/** The actual 3D scene. Separate from RoofRenderer so the dynamic
 *  imports above wrap the Canvas without touching the scene's
 *  three.js imports (which fail SSR if hoisted to the wrapper). */
function RoofScene({ data }: { data: RoofData }) {
  // Project all facet polygons to a shared local-meters frame
  // centered on the building. Each lat/lng vertex becomes (x_m, z_m)
  // — we use the three.js convention where +y is up and the roof
  // sits in the XZ plane.
  const { facets3d, sceneBounds } = useMemo(() => {
    return projectFacetsToScene(data);
  }, [data]);

  return (
    <>
      {/* Subtle hemisphere light from above — keeps facets readable
          without harsh shadows. Voxaris gold + cool from below. */}
      <hemisphereLight args={["#d4a843", "#0a1218", 0.45]} />
      {/* Directional fill so the facing-direction is visually clear. */}
      <directionalLight position={[20, 30, 10]} intensity={0.55} />
      <directionalLight position={[-15, 20, -10]} intensity={0.25} />

      {/* Ground reference grid at y=0. Subtle so the roof reads as
          the focus. */}
      <gridHelper
        args={[Math.max(40, sceneBounds.size * 1.5), 20, "#1a2228", "#0e1418"]}
        position={[0, 0.001, 0]}
      />

      {/* Facets */}
      {facets3d.map((f) => (
        <FacetMesh key={f.id} facet={f} />
      ))}

      {/* Origin marker — tiny dot at the building center for orientation. */}
      <mesh position={[0, 0, 0]}>
        <sphereGeometry args={[0.15, 8, 8]} />
        <meshBasicMaterial color="#d4a843" />
      </mesh>
    </>
  );
}

/** Render a single facet as a flat polygon at its correct pitch.
 *  Color is derived from the facet's azimuth so opposing slopes get
 *  visually distinct hues (north blue, south amber, east emerald,
 *  west violet — same convention as the rep tool's compass chip). */
function FacetMesh({ facet }: { facet: Facet3D }) {
  const ref = useRef<THREE.Mesh>(null);
  // Build geometry from the projected polygon. Use a ShapeGeometry
  // (Three.js's 2D polygon → 3D plane primitive) then rotate to the
  // facet's pitch and position at its centroid.
  return (
    <group position={[facet.centroidX, facet.centroidY, facet.centroidZ]}>
      <group
        rotation={[
          // Tilt about the X axis (roll) by the pitch angle so the
          // plane sits at the right slope. Direction-of-tilt is
          // handled by the second rotation below (yaw to azimuth).
          -facet.pitchRad,
          // Yaw: rotate around Y so the down-slope direction matches
          // the facet's azimuth.
          facet.azimuthRad,
          0,
        ]}
      >
        <mesh ref={ref}>
          <shapeGeometry args={[facet.shape]} />
          <meshStandardMaterial
            color={facet.color}
            side={THREE.DoubleSide}
            metalness={0.05}
            roughness={0.75}
            transparent
            opacity={0.92}
          />
        </mesh>
      </group>
    </group>
  );
}

/** Small overlay in the corner showing total sqft / pitch / facet
 *  count — gives the customer the actual numbers next to the
 *  3D visual. */
function RoofRendererLegend({ data }: { data: RoofData }) {
  const totals = data.totals;
  return (
    <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between text-white pointer-events-none">
      <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/55">
        ✓ Measured by USGS LiDAR
      </div>
      <div className="text-right">
        <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/55">
          {totals.facetsCount} planes ·{" "}
          {Math.round(totals.totalRoofAreaSqft).toLocaleString()} sqft
        </div>
        {totals.averagePitchDegrees > 0 && (
          <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-white/35">
            {formatPitch(totals.averagePitchDegrees)} avg pitch
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Projection + color helpers ──────────────────────────────────────

interface Facet3D {
  id: string;
  /** THREE.Shape — the 2D polygon outline used by ShapeGeometry. */
  shape: THREE.Shape;
  /** Centroid in scene meters. */
  centroidX: number;
  centroidY: number;
  centroidZ: number;
  /** Pitch and azimuth in radians (for the mesh rotation). */
  pitchRad: number;
  azimuthRad: number;
  /** Display color (Voxaris gradient: north→south = teal→gold). */
  color: string;
}

function projectFacetsToScene(data: RoofData): {
  facets3d: Facet3D[];
  sceneBounds: { size: number };
} {
  const lat0 = data.address.lat;
  const lng0 = data.address.lng;
  const M_PER_DEG_LAT = 111_320;
  const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);

  const facets3d: Facet3D[] = [];
  let maxRange = 0;
  for (const f of data.facets) {
    if (!f.polygon || f.polygon.length < 3) continue;
    // Project each lat/lng vertex into scene meters. Three.js's
    // ShapeGeometry takes 2D vertices in its Shape constructor; we
    // build the polygon in (xMeters, zMeters) — z negated so north
    // ends up "forward" in our default camera orientation.
    const pts2d = f.polygon.map((v) => {
      const x = (v.lng - lng0) * M_PER_DEG_LNG;
      const z = -(v.lat - lat0) * M_PER_DEG_LAT;
      maxRange = Math.max(maxRange, Math.hypot(x, z));
      return new THREE.Vector2(x, z);
    });
    const shape = new THREE.Shape(pts2d);

    const cx = pts2d.reduce((s, p) => s + p.x, 0) / pts2d.length;
    const cz = pts2d.reduce((s, p) => s + p.y, 0) / pts2d.length;

    // Hover the facet at a y position proportional to its pitch and
    // distance from origin — gives a perceived "lift" so steeper
    // facets sit higher in the scene than flat ones. Purely visual.
    const pitchRad = (f.pitchDegrees * Math.PI) / 180;
    const azimuthRad = (((f.azimuthDeg ?? 0) * Math.PI) / 180);
    // Synthetic "roof height" — assume building eave at 3m, ridge
    // ~5-8m depending on pitch. We don't have the real ridge from
    // the data so derive: cy = 3 + (radius * tan(pitch) * 0.5)
    const radius = Math.hypot(cx, cz);
    const cy = 3 + radius * Math.tan(pitchRad) * 0.4;

    facets3d.push({
      id: f.id,
      shape,
      centroidX: cx,
      centroidY: cy,
      centroidZ: cz,
      pitchRad,
      azimuthRad,
      color: colorForAzimuth(f.azimuthDeg ?? 0, f.pitchDegrees),
    });
  }
  return {
    facets3d,
    sceneBounds: { size: maxRange },
  };
}

/** Color a facet by its azimuth. Voxaris palette:
 *    north (0°)  → cool teal #38c5ee
 *    east  (90°) → emerald   #2ecc71
 *    south (180°)→ gold      #d4a843
 *    west  (270°)→ rose      #e54e6a
 *  Steeper pitches → slightly more saturated for visual depth. */
function colorForAzimuth(azimuthDeg: number, pitchDeg: number): string {
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
  // Saturation boost for steeper pitches (more visually distinct).
  const sat = Math.min(1.0, 0.85 + pitchDeg / 200);
  const rr = Math.round(r * sat);
  const gg = Math.round(g * sat);
  const bb = Math.round(b * sat);
  return `#${rr.toString(16).padStart(2, "0")}${gg.toString(16).padStart(2, "0")}${bb.toString(16).padStart(2, "0")}`;
}

function formatPitch(deg: number): string {
  const rise = Math.round(12 * Math.tan((deg * Math.PI) / 180));
  return `${rise}/12 (${Math.round(deg)}°)`;
}

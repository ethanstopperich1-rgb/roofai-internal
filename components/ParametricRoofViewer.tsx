"use client";

import { useMemo, useRef } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Edges } from "@react-three/drei";
import * as THREE from "three";
import { Layers, Ruler, RotateCw } from "lucide-react";
import {
  buildParametricRoof,
  type RoofEdge,
  type RoofMesh,
  type LL,
} from "@/lib/parametric-roof";

interface Props {
  /** Footprint polygon in lat/lng. Pass the unified polygon used elsewhere. */
  polygon: LL[] | null;
  /** Pitch as "5/12" / "8/12+" / number degrees. */
  pitch: string | number | null;
  /** Optional eave overhang in feet (default 1 ft). */
  eaveOverhangFt?: number;
  /** Compact mode for embedding in tighter cards. */
  compact?: boolean;
}

const EAVE_COLOR = "#67dcff";
const RIDGE_COLOR = "#5fe3b0";
const RAKE_COLOR = "#9ba8bf";

export default function ParametricRoofViewer({
  polygon,
  pitch,
  eaveOverhangFt = 1.0,
  compact = false,
}: Props) {
  const mesh: RoofMesh | null = useMemo(() => {
    if (!polygon || polygon.length < 3 || !pitch) return null;
    return buildParametricRoof(polygon, { pitch, eaveOverhangFt });
  }, [polygon, pitch, eaveOverhangFt]);

  if (!mesh) {
    return (
      <div className="glass rounded-3xl p-6 flex items-center justify-center text-slate-500 text-[13px] aspect-[4/3]">
        Pick an address to render the parametric roof
      </div>
    );
  }

  return (
    <div className="glass rounded-3xl overflow-hidden border border-white/[0.07]">
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.05]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-mint/10 border border-mint/20 flex items-center justify-center text-mint">
            <Layers size={12} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[13px]">
              Roof framing
            </div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              gables · ridges · eaves · rakes
            </div>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-2 text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500">
          <RotateCw size={11} className="text-cy-300" /> drag to orbit
        </div>
      </div>

      <div className={compact ? "h-[320px] relative" : "h-[440px] relative"}>
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{ position: [12, 9, 14], fov: 38, near: 0.1, far: 200 }}
          gl={{ antialias: true, alpha: true }}
          style={{ background: "transparent" }}
        >
          <SceneLights />
          <RoofMeshObject mesh={mesh} />
          <RoofEdgesOverlay edges={mesh.edges} />
          <FootprintGrid mesh={mesh} />
          <OrbitControls
            enablePan={false}
            minDistance={6}
            maxDistance={40}
            maxPolarAngle={Math.PI / 2 - 0.05}
            target={[0, 1.0, 0]}
          />
        </Canvas>

        {/* Stats overlay */}
        <div className="pointer-events-none absolute left-3 bottom-3 right-3 flex flex-wrap gap-1.5">
          <Stat value={mesh.stats.roofSurfaceSqft.toLocaleString()} unit="sf" label="surface" />
          <Stat value={mesh.stats.ridgeLf.toString()} unit="lf" label="ridge" />
          <Stat value={mesh.stats.eaveLf.toString()} unit="lf" label="eaves" />
          <Stat value={mesh.stats.rakeLf.toString()} unit="lf" label="rakes" />
          <Stat
            value={mesh.stats.ridgeHeightFt.toString()}
            unit="ft"
            label="ridge height"
            icon={<Ruler size={9} className="text-cy-300" />}
          />
        </div>
      </div>
    </div>
  );
}

/* ─── Scene pieces ─────────────────────────────────────────────────── */

function SceneLights() {
  const ref = useRef<THREE.DirectionalLight | null>(null);
  return (
    <>
      <ambientLight intensity={0.35} color={"#9bcafe"} />
      <hemisphereLight args={["#cfe9ff", "#0a0d12", 0.5]} />
      <directionalLight
        ref={ref}
        position={[10, 16, 8]}
        intensity={1.4}
        color={"#fff7e6"}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
    </>
  );
}

function RoofMeshObject({ mesh }: { mesh: RoofMesh }) {
  // Build a BufferGeometry from triangle vertex list. R3F coordinate convention:
  // X right, Y up, Z toward camera. Our roof math is X east, Y north, Z up,
  // so we map: roof.x → r3f.x, roof.z → r3f.y, roof.y → r3f.z.
  const geom = useMemo(() => {
    const positions = new Float32Array(mesh.triangles.length * 3);
    let i = 0;
    for (const v of mesh.triangles) {
      positions[i++] = v.x;
      positions[i++] = v.z;
      positions[i++] = -v.y;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.computeVertexNormals();
    return g;
  }, [mesh]);

  // Subtle drift on hover indicator — but we keep the mesh rock-still
  useFrame(() => {});

  return (
    <group>
      {/* Solid roof body */}
      <mesh geometry={geom} castShadow receiveShadow>
        <meshStandardMaterial
          color={"#2a2f3b"}
          roughness={0.55}
          metalness={0.18}
          flatShading
          side={THREE.DoubleSide}
        />
        <Edges color="#3a4356" threshold={15} />
      </mesh>
    </group>
  );
}

function RoofEdgesOverlay({ edges }: { edges: RoofEdge[] }) {
  return (
    <group>
      {edges.map((e, i) => (
        <EdgeLine key={i} edge={e} />
      ))}
    </group>
  );
}

function EdgeLine({ edge }: { edge: RoofEdge }) {
  const color =
    edge.kind === "eave"
      ? EAVE_COLOR
      : edge.kind === "ridge"
        ? RIDGE_COLOR
        : edge.kind === "valley"
          ? "#ff7a8a"
          : edge.kind === "hip"
            ? "#f3b14b"
            : RAKE_COLOR;
  const points = useMemo(
    () => [
      new THREE.Vector3(edge.a.x, edge.a.z, -edge.a.y),
      new THREE.Vector3(edge.b.x, edge.b.z, -edge.b.y),
    ],
    [edge],
  );
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints(points);
    return g;
  }, [points]);
  // Use lineSegments so each edge stays crisp regardless of camera distance
  return (
    <primitive
      object={(() => {
        const m = new THREE.LineBasicMaterial({
          color,
          linewidth: 2,
          transparent: true,
          opacity: edge.kind === "eave" || edge.kind === "ridge" ? 0.95 : 0.7,
        });
        const line = new THREE.LineSegments(geom, m);
        return line;
      })()}
    />
  );
}

function FootprintGrid({ mesh }: { mesh: RoofMesh }) {
  // 24m x 24m blueprint grid centered on roof, dim cyan
  const size = 32;
  const divisions = 16;
  const grid = useMemo(() => {
    const g = new THREE.GridHelper(size, divisions, "#1f2632", "#161b25");
    (g.material as THREE.Material).transparent = true;
    (g.material as THREE.Material).opacity = 0.55;
    g.position.y = -0.01;
    return g;
  }, []);
  void mesh;
  return <primitive object={grid} />;
}

/* ─── Floating stats chip ──────────────────────────────────────────── */

function Stat({
  value,
  unit,
  label,
  icon,
}: {
  value: string;
  unit: string;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border border-white/10 bg-black/55 backdrop-blur px-2.5 py-1.5 text-[10px] font-mono tabular tracking-[0.04em] text-slate-200 flex items-center gap-1.5"
      style={{ pointerEvents: "auto" }}
    >
      {icon}
      <span className="font-semibold">{value}</span>
      <span className="text-slate-500">{unit}</span>
      <span className="text-slate-500 uppercase tracking-[0.12em] text-[9px] ml-0.5">
        {label}
      </span>
    </div>
  );
}

/* helper export so other components can compute the same stats */
export function getRoofStats(polygon: LL[] | null, pitch: string | number | null) {
  if (!polygon || !pitch) return null;
  const r = buildParametricRoof(polygon, { pitch });
  return r?.stats ?? null;
}

export type { ThreeEvent };

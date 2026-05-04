"use client";

import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, ContactShadows } from "@react-three/drei";
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

/* ─── Edge palette (Voxaris cyan/mint accent) ─────────────────────────── */
const EAVE_COLOR = "#67dcff"; // cy-300
const RIDGE_COLOR = "#5fe3b0"; // mint
const HIP_COLOR = "#f3b14b"; // amber
const VALLEY_COLOR = "#ff7a8a"; // rose
const RAKE_COLOR = "#a8b1c2"; // slate-300

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

  // Camera framing — fit the model's footprint diagonal. Big buildings
  // (>20m radius like the 8,500sf Pocket Lane home) need a tighter angle
  // factor so the roof actually fills the viewport.
  const bbox = computeBoundingRadius(mesh);
  const camDist = Math.max(8, Math.min(80, bbox.r * 2.0));
  const camY = Math.max(5, Math.min(45, bbox.r * 0.95));

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

      <div
        className={compact ? "h-[320px] relative" : "h-[440px] relative"}
        style={{
          // Soft horizon gradient so the dark mesh isn't fighting the page bg
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(103,220,255,0.08) 0%, rgba(11,14,20,0.85) 55%, rgba(7,9,13,1) 100%)",
        }}
      >
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{ position: [camDist * 0.7, camY, camDist], fov: 36, near: 0.1, far: 400 }}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        >
          <SceneLights />
          {/* Suspense fallback prevents the canvas from rendering blank if any
              child loads asynchronously (drei sub-components, textures). */}
          <Suspense fallback={null}>
            {/* Ground plane — receives shadows + has a subtle gradient */}
            <GroundPlane />

            {/* Soft contact shadow under the building footprint */}
            <ContactShadows
              position={[0, 0.005, 0]}
              opacity={0.5}
              scale={Math.max(20, bbox.r * 4)}
              blur={2.2}
              far={Math.max(8, bbox.r * 2)}
              color="#000a14"
            />

            <RoofMeshObject mesh={mesh} />
            <RoofEdgesOverlay edges={mesh.edges} />
          </Suspense>

          <OrbitControls
            enablePan={false}
            minDistance={Math.max(4, bbox.r * 1.4)}
            maxDistance={Math.max(60, bbox.r * 6)}
            maxPolarAngle={Math.PI / 2 - 0.07}
            minPolarAngle={Math.PI / 8}
            target={[0, mesh.stats.ridgeHeightFt > 0 ? Math.min(3, bbox.r * 0.25) : 0, 0]}
            enableDamping
            dampingFactor={0.08}
            autoRotate
            autoRotateSpeed={0.45}
          />
        </Canvas>

        {/* Stats overlay */}
        <div className="pointer-events-none absolute left-3 bottom-3 right-3 flex flex-wrap gap-1.5">
          <Stat value={mesh.stats.roofSurfaceSqft.toLocaleString()} unit="sf" label="surface" />
          {mesh.stats.ridgeLf > 0 && (
            <Stat value={mesh.stats.ridgeLf.toString()} unit="lf" label="ridge" />
          )}
          {mesh.stats.hipLf > 0 && (
            <Stat value={mesh.stats.hipLf.toString()} unit="lf" label="hip" />
          )}
          <Stat value={mesh.stats.eaveLf.toString()} unit="lf" label="eaves" />
          {mesh.stats.rakeLf > 0 && (
            <Stat value={mesh.stats.rakeLf.toString()} unit="lf" label="rakes" />
          )}
          <Stat
            value={mesh.stats.ridgeHeightFt.toString()}
            unit="ft"
            label="peak"
            icon={<Ruler size={9} className="text-cy-300" />}
          />
        </div>
      </div>
    </div>
  );
}

/* ─── Scene pieces ─────────────────────────────────────────────────── */

function SceneLights() {
  return (
    <>
      {/* Cool ambient fill from the sky */}
      <hemisphereLight args={["#cee9ff", "#0a0d12", 0.7]} />
      {/* Warm key light from upper-left, cast soft shadow */}
      <directionalLight
        position={[14, 22, 10]}
        intensity={2.4}
        color={"#fff4d6"}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={80}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
        shadow-bias={-0.0006}
      />
      {/* Cool rim light from behind to separate the silhouette */}
      <directionalLight position={[-10, 10, -12]} intensity={0.55} color={"#67dcff"} />
      {/* Subtle fill underneath to keep eaves visible */}
      <pointLight position={[0, 4, 0]} intensity={0.25} color={"#a0d8ff"} />
    </>
  );
}

function RoofMeshObject({ mesh }: { mesh: RoofMesh }) {
  // Build BufferGeometry. R3F coords: X right / Y up / Z toward camera.
  // Roof math coords: X east / Y north / Z up. Map roof.x→x, roof.z→y, roof.y→-z.
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
  // Subtle barely-perceptible breathing keeps the surface alive
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime();
    ref.current.position.y = Math.sin(t * 0.6) * 0.015;
  });

  return (
    <mesh ref={ref} geometry={geom} castShadow receiveShadow>
      {/*
        Slate-blue PBR with brushed-metal feel — readable from any angle,
        hides the dark muddy look the previous flat-shaded grey had.
        Slight emissive on top so eaves stay readable in shadow.
      */}
      <meshStandardMaterial
        color={"#4a5468"}
        roughness={0.55}
        metalness={0.22}
        emissive={"#1a2436"}
        emissiveIntensity={0.85}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function RoofEdgesOverlay({ edges }: { edges: RoofEdge[] }) {
  // Build one consolidated LineSegments geometry — vastly fewer draw calls
  // than per-edge primitives. Per-edge color via vertexColors.
  const geom = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const colorFor = (kind: RoofEdge["kind"]) => {
      const c = new THREE.Color(
        kind === "eave"
          ? EAVE_COLOR
          : kind === "ridge"
            ? RIDGE_COLOR
            : kind === "hip"
              ? HIP_COLOR
              : kind === "valley"
                ? VALLEY_COLOR
                : RAKE_COLOR,
      );
      return [c.r, c.g, c.b];
    };
    for (const e of edges) {
      // Slight lift off the surface so lines don't z-fight with the mesh
      const lift = 0.02;
      positions.push(e.a.x, e.a.z + lift, -e.a.y);
      positions.push(e.b.x, e.b.z + lift, -e.b.y);
      const c = colorFor(e.kind);
      colors.push(...c, ...c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }, [edges]);

  const lines = useMemo(() => {
    const m = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    return new THREE.LineSegments(geom, m);
  }, [geom]);
  return <primitive object={lines} />;
}

function GroundPlane() {
  // Subtle dark disc with faint cyan grid
  const grid = useMemo(() => {
    const size = 64;
    const divisions = 32;
    const g = new THREE.GridHelper(size, divisions, "#1f2a3a", "#141b27");
    (g.material as THREE.Material).transparent = true;
    (g.material as THREE.Material).opacity = 0.55;
    g.position.y = -0.005;
    return g;
  }, []);
  return (
    <>
      <primitive object={grid} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.006, 0]} receiveShadow>
        <circleGeometry args={[40, 64]} />
        <meshStandardMaterial color={"#0a0e16"} roughness={1} metalness={0} />
      </mesh>
    </>
  );
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

/* helper: bounding radius for camera framing */
function computeBoundingRadius(mesh: RoofMesh): { r: number } {
  let max = 0;
  for (const v of mesh.triangles) {
    const d = Math.hypot(v.x, v.z, v.y);
    if (d > max) max = d;
  }
  return { r: Math.max(4, max) };
}

/* helper export so other components can compute the same stats */
export function getRoofStats(polygon: LL[] | null, pitch: string | number | null) {
  if (!polygon || !pitch) return null;
  const r = buildParametricRoof(polygon, { pitch });
  return r?.stats ?? null;
}

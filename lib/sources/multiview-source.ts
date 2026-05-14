// lib/sources/multiview-source.ts
// Tier B — multiview oblique refinement.
//
// Architecture: multiview capture is browser/WebGL only (Cesium toDataURL
// on a live 3D Tiles canvas), so unlike Tier C, Tier B can't run inside
// the server-side runRoofPipeline. The page captures images client-side
// then calls `/api/roof-inspector` which:
//
//   1. Asks Claude to inspect the 5 views (1 top-down + 4 obliques) and
//      emit a structured *patch* against the existing RoofData.
//   2. Applies the patch deterministically server-side (mergeRefinement
//      below). Re-computes flashing + totals from the refined inputs.
//   3. Returns a new RoofData with refinements: [...prev, "multiview-obliques"]
//      and confidence bumped by 0.10 (capped at 0.95).
//
// This module exports the *pure* merge function used by the API route
// plus the *client* helper that POSTs to it.

import type {
  Edge, Facet, RoofData, RoofObject,
} from "@/types/roof";
import { computeFlashing, computeTotals } from "@/lib/roof-engine";

/** Cardinal side names emitted by Claude for wall-to-roof junctions. */
export type Side = "north" | "east" | "south" | "west";
export type WallJunctionType = "step-wall" | "headwall" | "apron";

/** Patch shape returned by /api/roof-inspector. All fields optional —
 *  Claude only emits what it can confidently refine. */
export interface InspectorPatch {
  /** Per-facet pitch refinements, matched by facetId. */
  facets?: Array<{
    id: string;
    /** Refined pitch in degrees. */
    pitchDegrees: number;
  }>;
  /** Per-object dimension refinements, matched by objectId. */
  objects?: Array<{
    id: string;
    dimensionsFt: { width: number; length: number };
  }>;
  /** Wall-to-roof junctions Claude detected. Each contributes LF to the
   *  matching FlashingBreakdown field and adds a synthesized Edge. */
  wallJunctions?: Array<{
    type: WallJunctionType;
    lengthFt: number;
    /** Which side of the building. Used to synthesize a representative
     *  polyline at the perimeter edge of that side. */
    side: Side;
    /** Whether this junction needs a cricket flashing add (chimney > 30" wide
     *  per Tier B spec). Optional — only set when Claude detects one. */
    needsCricket?: boolean;
  }>;
  /** Free-form notes from the inspector — surfaced in diagnostics. */
  notes?: string;
}

/**
 * Apply a Tier B inspector patch to a Tier C RoofData. Pure function;
 * deterministic given the same inputs.
 *
 * - Facet pitches updated by id (unknown ids skipped silently).
 * - Object dimensions updated by id.
 * - Wall junction edges synthesized at the building bounding box edges
 *   (representative, not precise — only lengthFt is load-bearing).
 * - flashing + totals re-computed from the refined inputs.
 * - flashing.wallStepLf / headwallLf / apronLf populated from the patch.
 * - refinements gets "multiview-obliques" appended (deduped).
 * - confidence bumped to min(0.95, prev + 0.10).
 */
export function mergeRefinement(
  prev: RoofData,
  patch: InspectorPatch,
): RoofData {
  // No-op for degraded data — Tier B doesn't have anything to refine.
  if (prev.source === "none" || prev.facets.length === 0) return prev;

  // ---- Facets: pitch + isLowSlope ----------------------------------------
  const facetPatchById = new Map<string, number>();
  for (const fp of patch.facets ?? []) {
    if (typeof fp.pitchDegrees === "number" && Number.isFinite(fp.pitchDegrees)) {
      // Clamp 0..70deg (anything outside is a bad detection).
      const clamped = Math.max(0, Math.min(70, fp.pitchDegrees));
      facetPatchById.set(fp.id, clamped);
    }
  }
  const refinedFacets: Facet[] = prev.facets.map((f) => {
    const newPitch = facetPatchById.get(f.id);
    if (newPitch == null) return f;
    return {
      ...f,
      pitchDegrees: newPitch,
      // 4/12 = 18.43° low-slope threshold (Tier C convention).
      isLowSlope: newPitch < 18.43,
      // areaSqftSloped recomputed from footprint × sec(pitch). Footprint
      // is fixed by the polygon; sloped area depends on pitch.
      areaSqftSloped:
        f.areaSqftFootprint > 0
          ? f.areaSqftFootprint / Math.cos((newPitch * Math.PI) / 180)
          : f.areaSqftSloped,
    };
  });

  // ---- Objects: dimensions ----------------------------------------------
  const objPatchById = new Map<string, { width: number; length: number }>();
  for (const op of patch.objects ?? []) {
    const w = Number(op.dimensionsFt?.width);
    const l = Number(op.dimensionsFt?.length);
    if (Number.isFinite(w) && Number.isFinite(l) && w > 0 && l > 0) {
      objPatchById.set(op.id, {
        width: Math.max(0.25, Math.min(20, w)),
        length: Math.max(0.25, Math.min(40, l)),
      });
    }
  }
  const refinedObjects: RoofObject[] = prev.objects.map((o) => {
    const d = objPatchById.get(o.id);
    if (!d) return o;
    return { ...o, dimensionsFt: d };
  });

  // ---- Wall junctions: append edges + sum LF -----------------------------
  let wallStepLfDelta = 0;
  let headwallLfDelta = 0;
  let apronLfDelta = 0;
  const wallEdges: Edge[] = [];
  let nextEdgeId = prev.edges.length;
  for (const wj of patch.wallJunctions ?? []) {
    if (!Number.isFinite(wj.lengthFt) || wj.lengthFt <= 0) continue;
    const lf = Math.max(0, Math.min(400, wj.lengthFt));
    if (wj.type === "step-wall") wallStepLfDelta += lf;
    else if (wj.type === "headwall") headwallLfDelta += lf;
    else if (wj.type === "apron") apronLfDelta += lf;
    // Per docs/superpowers/tier-b-a-decisions.md: leave polyline empty —
    // oblique imagery doesn't give us 3D coordinates and only lengthFt
    // is load-bearing for downstream flashing math. Tier A LiDAR replaces
    // these with real polylines later.
    // All three Tier B wall-junction kinds (step-wall / headwall / apron)
    // map to the "step-wall" Edge enum — the FlashingBreakdown fields carry
    // the kind-specific LF separately. The Edge entry exists so consumers
    // counting edges (totals.edgesCount) see the wall presence.
    wallEdges.push({
      id: `edge-${nextEdgeId++}`,
      type: "step-wall",
      polyline: [],
      lengthFt: Math.round(lf),
      facetIds: [],
      // Inspector edges carry higher confidence than Tier C heuristic (0.4)
      // so Tier A LiDAR (0.95+) still wins, but these always beat Tier C.
      confidence: 0.75,
    });
  }

  const allEdges: Edge[] = [...prev.edges, ...wallEdges];

  // ---- Re-compute flashing + totals from refined inputs ------------------
  // computeFlashing handles chimney/skylight/dormer/valley/eave-derived LF.
  // We additively patch wallStepLf / headwallLf / apronLf with the Tier B
  // signals — those are zero under Tier C by design.
  const baseFlashing = computeFlashing(refinedFacets, allEdges, refinedObjects);

  // Cricket adder per the locked Tier B decision: a chimney wider than 30"
  // requires cricket flashing, modeled as +20% on that chimney's LF
  // contribution. We don't track per-chimney LF after the rollup, so we
  // apply the +20% to the total chimneyLf scaled by the fraction of
  // chimneys that needCricket. Approximation — refined when field feedback
  // lands.
  const cricketJunctions = (patch.wallJunctions ?? []).filter((wj) => wj.needsCricket);
  const totalChimneys = Math.max(1, refinedObjects.filter((o) => o.kind === "chimney").length);
  const cricketBoost = (cricketJunctions.length / totalChimneys) * 0.20;
  const chimneyLfWithCricket = Math.round(baseFlashing.chimneyLf * (1 + cricketBoost));

  const refinedFlashing = {
    ...baseFlashing,
    chimneyLf: chimneyLfWithCricket,
    wallStepLf: Math.round(wallStepLfDelta),
    headwallLf: Math.round(headwallLfDelta),
    apronLf: Math.round(apronLfDelta),
  };

  const refinedTotals = computeTotals(refinedFacets, allEdges, refinedObjects);

  // ---- Refinement bookkeeping --------------------------------------------
  const refinements = prev.refinements.includes("multiview-obliques")
    ? prev.refinements
    : [...prev.refinements, "multiview-obliques" as const];
  const confidence = Math.min(0.95, prev.confidence + 0.10);

  const warnings = [...prev.diagnostics.warnings];
  if (patch.notes && patch.notes.trim()) warnings.push(`Inspector: ${patch.notes.trim()}`);

  return {
    ...prev,
    source: prev.source,
    refinements,
    confidence,
    facets: refinedFacets,
    edges: allEdges,
    objects: refinedObjects,
    flashing: refinedFlashing,
    totals: refinedTotals,
    diagnostics: {
      ...prev.diagnostics,
      warnings,
    },
  };
}

// ---- Client helper ---------------------------------------------------------

/** Captured frames from Cesium — same shape as the polygon-verify flow. */
export interface CapturedMultiView {
  topDown: { base64: string; width: number; height: number; halfWidthM: number };
  obliques: Array<{ base64: string; width: number; height: number; headingDeg: number }>;
}

export interface RefineOptions {
  roofData: RoofData;
  captured: CapturedMultiView;
  imageryDate?: string | null;
  signal?: AbortSignal;
}

export interface RefineResult {
  refined: RoofData;
  patch: InspectorPatch;
  /** Latency in ms of the Claude inspector call (server-reported). */
  latencyMs?: number;
}

/**
 * Browser-side helper. POSTs the captured multiview frames + current
 * RoofData to /api/roof-inspector and returns the refined RoofData.
 *
 * Throws on network / server error. Callers should fall back to the
 * unrefined RoofData on error (Tier B is additive, not load-bearing).
 */
export async function refineRoofDataViaMultiview(
  opts: RefineOptions,
): Promise<RefineResult> {
  const res = await fetch("/api/roof-inspector", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: opts.signal,
    body: JSON.stringify({
      roofData: opts.roofData,
      topDown: opts.captured.topDown,
      obliques: opts.captured.obliques,
      imageryDate: opts.imageryDate ?? opts.roofData.imageryDate ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(`roof-inspector ${res.status}`);
  }
  const data = await res.json() as RefineResult;
  return data;
}

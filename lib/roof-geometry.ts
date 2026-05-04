/**
 * Roof geometry derivation — converts what we know about a roof
 * (sqft, building footprint, segment count, optional polygons, pitch)
 * into the line-feet measurements an EagleView Premium report shows:
 * eaves, rakes, ridges, hips, valleys, drip edge, IWS.
 *
 * When precise lat/lng polygons are available (Solar API segments, or
 * SAM-refined outlines), perimeter is computed via haversine.
 * Otherwise we fall back to footprint-aware heuristics — clearly
 * labeled in the UI as "estimated" until refined.
 */

import type { Complexity, Pitch } from "@/types/estimate";

export type RoofLengthSource = "polygons" | "footprint" | "heuristic";

export interface RoofLengths {
  /** Total exterior perimeter of the roof (eaves + rakes) */
  perimeterLf: number;
  /** Level lower edges (gutter line) */
  eavesLf: number;
  /** Sloped non-level edges */
  rakesLf: number;
  /** Upper convex edges shared between two pitched segments */
  ridgesLf: number;
  /** Diagonal convex edges (special ridge case) */
  hipsLf: number;
  /** Concave edges between adjacent segments */
  valleysLf: number;
  /** Eaves + rakes (everything that gets drip edge) */
  dripEdgeLf: number;
  /** Chimney / wall flashing estimate */
  flashingLf: number;
  /** Roof-to-wall step flashing estimate */
  stepFlashingLf: number;
  /** Ice & water shield needed (sqft) */
  iwsSqft: number;
  source: RoofLengthSource;
}

export interface WasteRow {
  pct: number;
  /** Area including waste */
  areaSqft: number;
  /** Squares (rounded up to nearest 1/3 like EagleView) */
  squares: number;
  isMeasured?: boolean;
  isSuggested?: boolean;
}

export interface WasteTable {
  measuredSqft: number;
  measuredSquares: number;
  suggestedPct: number;
  suggestedSqft: number;
  suggestedSquares: number;
  rows: WasteRow[];
}

const HAVERSINE_R_M = 6_371_000;

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * HAVERSINE_R_M * Math.asin(Math.sqrt(h));
}

const M_TO_FT = 3.28084;

export function polygonPerimeterFt(
  polygon: Array<{ lat: number; lng: number }>,
): number {
  if (!polygon || polygon.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    total += haversineMeters(a, b);
  }
  return total * M_TO_FT;
}

/**
 * Compute the union perimeter of a set of polygons by:
 *   1) summing each polygon's perimeter,
 *   2) subtracting 2× the length of every edge shared between two polygons
 *      (those edges are ridges/valleys, not exterior).
 * The shared-edge detection uses a tolerance because Solar API bounding
 * boxes from adjacent segments rarely line up to the millimeter.
 */
function unionPerimeterAndSharedEdges(
  polygons: Array<Array<{ lat: number; lng: number }>>,
): { exteriorFt: number; sharedFt: number } {
  const TOL_M = 0.6; // ~2 ft tolerance for edge-matching
  const edges: Array<{
    a: { lat: number; lng: number };
    b: { lat: number; lng: number };
    polyIdx: number;
    lengthFt: number;
  }> = [];

  for (let pIdx = 0; pIdx < polygons.length; pIdx++) {
    const poly = polygons[pIdx];
    if (!poly || poly.length < 2) continue;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const lengthFt = haversineMeters(a, b) * M_TO_FT;
      if (lengthFt > 0.5) {
        edges.push({ a, b, polyIdx: pIdx, lengthFt });
      }
    }
  }

  let exteriorFt = 0;
  let sharedFt = 0;
  const usedShared = new Set<number>();
  for (let i = 0; i < edges.length; i++) {
    if (usedShared.has(i)) continue;
    let matched = false;
    for (let j = i + 1; j < edges.length; j++) {
      if (usedShared.has(j)) continue;
      if (edges[i].polyIdx === edges[j].polyIdx) continue;
      const a1 = edges[i].a, b1 = edges[i].b;
      const a2 = edges[j].a, b2 = edges[j].b;
      const sameDir =
        haversineMeters(a1, a2) < TOL_M && haversineMeters(b1, b2) < TOL_M;
      const flipDir =
        haversineMeters(a1, b2) < TOL_M && haversineMeters(b1, a2) < TOL_M;
      if (sameDir || flipDir) {
        sharedFt += (edges[i].lengthFt + edges[j].lengthFt) / 2;
        usedShared.add(i);
        usedShared.add(j);
        matched = true;
        break;
      }
    }
    if (!matched) exteriorFt += edges[i].lengthFt;
  }
  return { exteriorFt, sharedFt };
}

/**
 * Distribute exterior perimeter into eaves vs rakes given an average pitch.
 * For typical residential roofs ~50/50, but at very low pitch eaves dominate
 * and at very steep pitch rakes dominate. This is a calibrated approximation.
 */
function eaveRakeSplit(perimeterFt: number, pitchDegrees: number): {
  eavesLf: number;
  rakesLf: number;
} {
  // 0° pitch → 100% eaves. 60°+ → 60/40 rakes.
  const t = Math.min(1, Math.max(0, pitchDegrees / 60));
  const eaveShare = 0.55 - 0.15 * t; // 0.55 → 0.40
  const eavesLf = Math.round(perimeterFt * eaveShare);
  const rakesLf = Math.round(perimeterFt - eavesLf);
  return { eavesLf, rakesLf };
}

/**
 * Distribute "shared edges" (between adjacent polygons) into ridges vs
 * valleys vs hips. We can't tell convex from concave from polygon data
 * alone, so we use a complexity-aware split: more complex roofs have
 * more valleys.
 */
function ridgeValleyHipSplit(sharedFt: number, complexity: Complexity): {
  ridgesLf: number;
  hipsLf: number;
  valleysLf: number;
} {
  // simple: mostly ridges, no valleys, few hips
  // moderate: balance of ridges + valleys, some hips
  // complex: more valleys, more hips
  const splits: Record<Complexity, { ridge: number; hip: number; valley: number }> = {
    simple: { ridge: 0.85, hip: 0.10, valley: 0.05 },
    moderate: { ridge: 0.55, hip: 0.20, valley: 0.25 },
    complex: { ridge: 0.40, hip: 0.25, valley: 0.35 },
  };
  const s = splits[complexity];
  return {
    ridgesLf: Math.round(sharedFt * s.ridge),
    hipsLf: Math.round(sharedFt * s.hip),
    valleysLf: Math.round(sharedFt * s.valley),
  };
}

function flashingFromComplexity(complexity: Complexity): {
  flashingLf: number;
  stepFlashingLf: number;
} {
  return complexity === "complex"
    ? { flashingLf: 6, stepFlashingLf: 12 }
    : complexity === "moderate"
      ? { flashingLf: 3, stepFlashingLf: 6 }
      : { flashingLf: 2, stepFlashingLf: 3 };
}

function iwsFromLengths(eavesLf: number, valleysLf: number): number {
  // 3 ft strip at eaves + 6 ft strip down both sides of each valley
  return Math.round(eavesLf * 3 + valleysLf * 6);
}

const PITCH_TO_DEG: Record<Pitch, number> = {
  "4/12": 18.43,
  "5/12": 22.62,
  "6/12": 26.57,
  "7/12": 30.26,
  "8/12+": 35.0,
};

export function deriveRoofLengthsFromPolygons(opts: {
  polygons: Array<Array<{ lat: number; lng: number }>>;
  pitchDegrees: number;
  complexity: Complexity;
}): RoofLengths {
  const { polygons, pitchDegrees, complexity } = opts;
  const { exteriorFt, sharedFt } = unionPerimeterAndSharedEdges(polygons);
  const perimeterLf = Math.round(exteriorFt);
  const { eavesLf, rakesLf } = eaveRakeSplit(perimeterLf, pitchDegrees);
  const { ridgesLf, hipsLf, valleysLf } = ridgeValleyHipSplit(sharedFt, complexity);
  const flashing = flashingFromComplexity(complexity);
  const iwsSqft = iwsFromLengths(eavesLf, valleysLf);
  return {
    perimeterLf,
    eavesLf,
    rakesLf,
    ridgesLf,
    hipsLf,
    valleysLf,
    dripEdgeLf: eavesLf + rakesLf,
    flashingLf: flashing.flashingLf,
    stepFlashingLf: flashing.stepFlashingLf,
    iwsSqft,
    source: "polygons",
  };
}

/**
 * When we don't have polygons (Solar API NOT_FOUND, no SAM yet), use a
 * footprint-aware heuristic. Less accurate; we label it "estimated" in UI.
 */
export function deriveRoofLengthsHeuristic(opts: {
  totalRoofSqft: number;
  buildingFootprintSqft?: number | null;
  segmentCount?: number;
  complexity?: Complexity;
  pitch?: Pitch | null;
}): RoofLengths {
  const complexity: Complexity = opts.complexity ?? "moderate";
  const pitchDegrees =
    opts.pitch && PITCH_TO_DEG[opts.pitch] ? PITCH_TO_DEG[opts.pitch] : 25;
  const segmentCount = opts.segmentCount ?? 4;

  // If we don't have a real footprint, derive from roof sqft and pitch
  const footprintSqft =
    opts.buildingFootprintSqft ??
    Math.round(opts.totalRoofSqft * Math.cos((pitchDegrees * Math.PI) / 180));

  // Roughly square building
  const sideLengthFt = Math.sqrt(footprintSqft);
  const perimeterLf = Math.round(sideLengthFt * 4 * 1.05);
  const { eavesLf, rakesLf } = eaveRakeSplit(perimeterLf, pitchDegrees);

  // Ridge + hip + valley scale with √footprint × segment-count factor
  const segFactor =
    segmentCount <= 2 ? 0.5 :
    segmentCount <= 4 ? 1.0 :
    segmentCount <= 6 ? 1.4 :
    1.8;
  const totalSharedLf = Math.round(sideLengthFt * segFactor * 0.9);

  const { ridgesLf, hipsLf, valleysLf } = ridgeValleyHipSplit(
    totalSharedLf,
    complexity,
  );
  const flashing = flashingFromComplexity(complexity);
  const iwsSqft = iwsFromLengths(eavesLf, valleysLf);

  return {
    perimeterLf,
    eavesLf,
    rakesLf,
    ridgesLf,
    hipsLf,
    valleysLf,
    dripEdgeLf: eavesLf + rakesLf,
    flashingLf: flashing.flashingLf,
    stepFlashingLf: flashing.stepFlashingLf,
    iwsSqft,
    source: opts.buildingFootprintSqft ? "footprint" : "heuristic",
  };
}

/**
 * EagleView-style waste calculation table.
 * Squares are rounded up to the nearest 1/3 to match how EagleView prints them.
 */
export function buildWasteTable(
  roofSqft: number,
  complexity: Complexity = "moderate",
): WasteTable {
  const PCTS = [0, 4, 7, 9, 11, 14, 19, 24, 29];
  const suggestedPct =
    complexity === "complex" ? 14 :
    complexity === "simple" ? 7 :
    11;

  const round3rd = (n: number) => Math.ceil(n * 3) / 3;

  const rows: WasteRow[] = PCTS.map((pct) => {
    const area = roofSqft * (1 + pct / 100);
    return {
      pct,
      areaSqft: Math.round(area),
      squares: round3rd(area / 100),
      isMeasured: pct === 0,
      isSuggested: pct === suggestedPct,
    };
  });

  const suggestedRow = rows.find((r) => r.isSuggested)!;
  return {
    measuredSqft: Math.round(roofSqft),
    measuredSquares: round3rd(roofSqft / 100),
    suggestedPct,
    suggestedSqft: suggestedRow.areaSqft,
    suggestedSquares: suggestedRow.squares,
    rows,
  };
}

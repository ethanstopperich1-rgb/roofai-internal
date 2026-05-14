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

import type { Complexity } from "@/types/estimate";

// RoofLengths / RoofLengthSource were duplicate definitions of the
// canonical types in types/estimate.ts — only used by the now-deleted
// deriveRoofLengths* functions. The canonical types are still
// re-exported from types/estimate.ts.

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

/**
 * Infer roof complexity from polygon shape — strictly geometric signal,
 * stronger than Vision's "complexity" guess from a noisy 640×640 thumbnail.
 *
 * Logic:
 *   - Multiple polygons (Solar facets): 1 facet → simple/moderate by vertex
 *     count; 2–3 facets → moderate; 4+ facets → complex.
 *   - Single polygon: convexity ratio (poly area / convex hull area) tells
 *     us whether it's a rectangle (≈ 1.0) or L/T/U-shaped (< 0.85). High
 *     vertex count after orthogonalization is also a complexity signal.
 *
 * Returns null if polygons are unusable (too few vertices), so the caller
 * can fall back to the existing complexity (Vision-derived or default).
 */
export function inferComplexityFromPolygons(
  polygons: Array<Array<{ lat: number; lng: number }>>,
): Complexity | null {
  if (!polygons || polygons.length === 0) return null;
  const valid = polygons.filter((p) => p.length >= 3);
  if (valid.length === 0) return null;

  if (valid.length >= 4) return "complex";
  if (valid.length >= 2) return "moderate";

  // Single-polygon: vertex count + convexity
  const poly = valid[0];
  const v = poly.length;

  // Convexity ratio in local meters (lat/lng skew negligible at house scale)
  const cLat = poly.reduce((s, p) => s + p.lat, 0) / v;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const pts = poly.map((p) => ({ x: p.lng * 111_320 * cosLat, y: p.lat * 111_320 }));
  const polyArea = (() => {
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  })();

  // Andrew's monotone-chain convex hull
  const sorted = [...pts].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (
    o: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const hullArea = (() => {
    let sum = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  })();
  const convexity = hullArea > 0 ? polyArea / hullArea : 1;

  // Decide
  if (v <= 5 && convexity > 0.95) return "simple";
  if (v >= 10 || convexity < 0.78) return "complex";
  return "moderate";
}


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
 * Industry-standard suggested waste % by complexity. Single source of truth
 * shared between the EagleView-style waste table (rep-facing UI) and the
 * line-item pricing engine (priceRoofData in lib/roof-engine.ts) so
 * the displayed "suggested waste" is also the waste actually applied to
 * shingle quantities. Without this, the panel said "14%" while the line
 * items used a hardcoded 12% — under-billed complex jobs by ~2%.
 *
 *   simple    7%   — rectangular ranch, single pitch, minimal cuts
 *   moderate 11%   — typical hip / cross-gable, 2-3 facets (default)
 *   complex  14%   — heavy cut-up: dormers, valleys, multi-section
 *
 * Anything beyond 14% is "extreme cut-up" territory (steep + complex +
 * many penetrations) — we let the rep manually bump the row in the
 * waste table for those rather than auto-suggesting a 19%+ default that
 * would silently over-bill the typical job.
 */
export function suggestedWastePct(complexity: Complexity = "moderate"): number {
  return (
    complexity === "complex" ? 14 :
    complexity === "simple" ? 7 :
    11
  );
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
  const suggestedPct = suggestedWastePct(complexity);

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

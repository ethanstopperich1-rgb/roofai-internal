// lib/roof-engine.ts
import type {
  ComplexityTier, Edge, Facet, FlashingBreakdown, RoofObject,
} from "@/types/roof";

/**
 * Compute flashing line items from facets + edges + objects.
 * Tier C: chimney/skylight/dormer perimeter math + per-edge LF rollup.
 * Wall-step / headwall / apron are zero in Tier C (Tier B+ signals).
 */
export function computeFlashing(
  _facets: Facet[],
  edges: Edge[],
  objects: RoofObject[],
): FlashingBreakdown {
  // _facets reserved for Tier B+ extension (wall-step detection)

  const chimneys = objects.filter((o) => o.kind === "chimney");
  const chimneyLf = chimneys.reduce(
    (s, c) => s + 2 * (c.dimensionsFt.width + c.dimensionsFt.length),
    0,
  );

  const skylights = objects.filter((o) => o.kind === "skylight");
  const skylightLf = skylights.reduce(
    (s, k) => s + 2 * (k.dimensionsFt.width + k.dimensionsFt.length),
    0,
  );

  const dormers = objects.filter((o) => o.kind === "dormer");
  const dormerStepLf = dormers.reduce(
    (s, d) => s + 2 * d.dimensionsFt.length,
    0,
  );

  const valleyLfRaw = edges
    .filter((e) => e.type === "valley")
    .reduce((s, e) => s + e.lengthFt, 0);
  const valleyLf = valleyLfRaw * 1.05;

  const eaveLf = edges
    .filter((e) => e.type === "eave")
    .reduce((s, e) => s + e.lengthFt, 0);
  const rakeLf = edges
    .filter((e) => e.type === "rake")
    .reduce((s, e) => s + e.lengthFt, 0);
  const dripEdgeLf = eaveLf + rakeLf;

  // Uses unrounded valleyLf so IWS doesn't accumulate rounding error.
  const iwsSqft = Math.round(eaveLf * 3 + valleyLf * 6);

  const pipeBootCount = objects.filter(
    (o) => o.kind === "vent" || o.kind === "stack",
  ).length;

  return {
    chimneyLf: Math.round(chimneyLf),
    skylightLf: Math.round(skylightLf),
    dormerStepLf: Math.round(dormerStepLf),
    wallStepLf: 0,
    headwallLf: 0,
    apronLf: 0,
    valleyLf: Math.round(valleyLf),
    dripEdgeLf: Math.round(dripEdgeLf),
    pipeBootCount,
    iwsSqft,
  };
}

/**
 * Andrew's monotone-chain convex hull on the union of facet polygons,
 * projected to local meters. Returns the convexity ratio
 * (poly area / convex hull area). 1.0 = fully convex; <0.78 = strong
 * reflex (L/T/U-shape).
 *
 * Used as a "cut-up" complexity signal — matches the existing
 * inferComplexityFromPolygons heuristic.
 */
export function computeUnionConvexity(facets: Facet[]): number {
  if (facets.length === 0) return 1;
  const allPts: Array<{ lat: number; lng: number }> = [];
  for (const f of facets) allPts.push(...f.polygon);
  if (allPts.length < 3) return 1;

  const cLat = allPts.reduce((s, p) => s + p.lat, 0) / allPts.length;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const pts = allPts.map((p) => ({
    x: p.lng * 111_320 * cosLat,
    y: p.lat * 111_320,
  }));

  // Total polygon area = sum of per-facet shoelace areas (footprint approx)
  let polyArea = 0;
  for (const f of facets) {
    const poly = f.polygon.map((p) => ({
      x: p.lng * 111_320 * cosLat,
      y: p.lat * 111_320,
    }));
    let sum = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      sum += a.x * b.y - b.x * a.y;
    }
    polyArea += Math.abs(sum) / 2;
  }

  // Convex hull (Andrew's monotone chain)
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
  let hullArea = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    hullArea += a.x * b.y - b.x * a.y;
  }
  hullArea = Math.abs(hullArea) / 2;
  return hullArea > 0 ? polyArea / hullArea : 1;
}

/**
 * Tier C complexity classifier — facet count + dormer count + valley LF +
 * reflex convexity. Tier B/A may replace with continuous signals.
 */
export function classifyComplexity(input: {
  facets: Facet[];
  edges: Edge[];
  objects: RoofObject[];
}): ComplexityTier {
  const facetCount = input.facets.length;
  const dormerCount = input.objects.filter((o) => o.kind === "dormer").length;
  const valleyLf = input.edges
    .filter((e) => e.type === "valley")
    .reduce((s, e) => s + e.lengthFt, 0);
  const hasReflex = computeUnionConvexity(input.facets) < 0.78;

  if (facetCount >= 6 || hasReflex || dormerCount >= 3 || valleyLf >= 60) {
    return "complex";
  }
  if (facetCount >= 3 || dormerCount >= 1 || valleyLf >= 20) {
    return "moderate";
  }
  return "simple";
}

export function suggestedWastePctTierC(c: ComplexityTier): number {
  return c === "complex" ? 14 : c === "simple" ? 7 : 11;
}

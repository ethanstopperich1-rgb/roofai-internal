// lib/roof-engine.ts
import type {
  ComplexityTier, Edge, Facet, FlashingBreakdown, Material, RoofObject, RoofTotals,
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
  // polyArea is sum-of-facet-areas, not the true union area. If facets
  // overlap in footprint, the ratio can exceed 1; clamp to keep the
  // metric in its documented [0, 1] range.
  return hullArea > 0 ? Math.min(1, polyArea / hullArea) : 1;
}

/** Tier C complexity-classifier thresholds. Mirrors the v1 heuristic so
 *  estimates don't shift on existing addresses just because the data path
 *  changed. Tier B/A replaces this with continuous signals. */
const TIER_C_COMPLEXITY_THRESHOLDS = {
  reflexConvexity: 0.78,
  complexFacetCount: 6,
  complexDormerCount: 3,
  complexValleyLf: 60,
  moderateFacetCount: 3,
  moderateDormerCount: 1,
  moderateValleyLf: 20,
} as const;

/**
 * Tier C complexity classifier — facet count + dormer count + valley LF +
 * reflex convexity. Tier B/A may replace with continuous signals.
 */
export function classifyComplexity(input: {
  facets: Facet[];
  edges: Edge[];
  objects: RoofObject[];
}): ComplexityTier {
  const T = TIER_C_COMPLEXITY_THRESHOLDS;
  const facetCount = input.facets.length;
  const dormerCount = input.objects.filter((o) => o.kind === "dormer").length;
  const valleyLf = input.edges
    .filter((e) => e.type === "valley")
    .reduce((s, e) => s + e.lengthFt, 0);
  const hasReflex = computeUnionConvexity(input.facets) < T.reflexConvexity;

  if (
    facetCount >= T.complexFacetCount ||
    hasReflex ||
    dormerCount >= T.complexDormerCount ||
    valleyLf >= T.complexValleyLf
  ) {
    return "complex";
  }
  if (
    facetCount >= T.moderateFacetCount ||
    dormerCount >= T.moderateDormerCount ||
    valleyLf >= T.moderateValleyLf
  ) {
    return "moderate";
  }
  return "simple";
}

export function suggestedWastePctTierC(c: ComplexityTier): number {
  return c === "complex" ? 14 : c === "simple" ? 7 : 11;
}

export function computeTotals(
  facets: Facet[],
  edges: Edge[],
  objects: RoofObject[],
  wasteOverridePct?: number,
): RoofTotals {
  const totalRoofAreaSqft = facets.reduce((s, f) => s + f.areaSqftSloped, 0);
  const totalFootprintSqft = facets.reduce((s, f) => s + f.areaSqftFootprint, 0);
  const totalSquares = Math.ceil((totalRoofAreaSqft / 100) * 3) / 3;
  const averagePitchDegrees = totalRoofAreaSqft > 0
    ? facets.reduce((s, f) => s + f.pitchDegrees * f.areaSqftSloped, 0) / totalRoofAreaSqft
    : 0;

  const complexity = classifyComplexity({ facets, edges, objects });
  // `??` would treat 0 as a valid override; in this domain a 0% waste is
  // always a bug (no roofing job has zero cut waste). Use a positivity
  // guard so accidental zeros fall through to the suggested value.
  const wastePct = (wasteOverridePct != null && wasteOverridePct > 0)
    ? wasteOverridePct
    : suggestedWastePctTierC(complexity);

  // Material consensus by area, ignoring null facets.
  // Ties broken by first-insertion order (deterministic via Map iteration).
  const materialVotes = new Map<Material | null, number>();
  for (const f of facets) {
    materialVotes.set(f.material, (materialVotes.get(f.material) ?? 0) + f.areaSqftSloped);
  }
  let predominantMaterial: Material | null = null;
  let topVote = -1;
  for (const [mat, area] of materialVotes) {
    if (mat !== null && area > topVote) {
      predominantMaterial = mat;
      topVote = area;
    }
  }

  return {
    facetsCount: facets.length,
    edgesCount: edges.length,
    objectsCount: objects.length,
    totalRoofAreaSqft: Math.round(totalRoofAreaSqft),
    totalFootprintSqft: Math.round(totalFootprintSqft),
    totalSquares,
    averagePitchDegrees: Math.round(averagePitchDegrees * 10) / 10,
    wastePct,
    complexity,
    predominantMaterial,
  };
}

const HAVERSINE_R_M = 6_371_000;
const M_TO_FT = 3.28084;
const SHARED_EDGE_TOL_M = 0.6;

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

function edgeBearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const f1 = toRad(a.lat), f2 = toRad(b.lat);
  const dl = toRad(b.lng - a.lng);
  const y = Math.sin(dl) * Math.cos(f2);
  const x =
    Math.cos(f1) * Math.sin(f2) -
    Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  // Edges are bidirectional, so 30 and 210 represent the same orientation.
  // Normalize to [0, 180).
  return ((bearing % 180) + 180) % 180;
}

function angularDistDeg(a: number, b: number): number {
  return Math.abs(((a - b + 90) % 180) - 90);
}

interface RawEdge {
  facetId: string;
  a: { lat: number; lng: number };
  b: { lat: number; lng: number };
  lengthFt: number;
  bearingDeg: number;
}

interface SharedPair {
  primary: RawEdge;
  partner: RawEdge;
}

/**
 * Tier C edge classification — heuristic, no 3D info available.
 *
 * For Tier C only. Tier B refines this via oblique inspection (typically
 * confidence > 0.7); Tier A computes true dihedral angles from LiDAR
 * normals (confidence > 0.95). When either of those run, their edges
 * win on confidence and override these.
 *
 * Heuristic: bearing-relative-to-dominantAzimuth + complexity-ratio
 * sanity caps. Accurate for ~70% of typical hip+gable houses; degrades
 * on irregular shapes. confidence set to 0.4 to ensure refinements
 * always win.
 */
export function classifyEdges(
  facets: Facet[],
  dominantAzimuthDeg: number | null,
): Edge[] {
  // 1. Walk every polygon edge.
  const raw: RawEdge[] = [];
  for (const f of facets) {
    for (let i = 0; i < f.polygon.length; i++) {
      const a = f.polygon[i];
      const b = f.polygon[(i + 1) % f.polygon.length];
      const lengthFt = haversineMeters(a, b) * M_TO_FT;
      if (lengthFt < 0.5) continue;
      raw.push({
        facetId: f.id, a, b, lengthFt,
        bearingDeg: edgeBearingDeg(a, b),
      });
    }
  }
  if (raw.length === 0) return [];

  // 2. Detect shared edges (pairwise, within tolerance).
  const sharedPairs: SharedPair[] = [];
  const sharedIndex = new Set<number>();
  for (let i = 0; i < raw.length; i++) {
    if (sharedIndex.has(i)) continue;
    for (let j = i + 1; j < raw.length; j++) {
      if (sharedIndex.has(j)) continue;
      if (raw[i].facetId === raw[j].facetId) continue;
      const sameDir =
        haversineMeters(raw[i].a, raw[j].a) < SHARED_EDGE_TOL_M &&
        haversineMeters(raw[i].b, raw[j].b) < SHARED_EDGE_TOL_M;
      const flipDir =
        haversineMeters(raw[i].a, raw[j].b) < SHARED_EDGE_TOL_M &&
        haversineMeters(raw[i].b, raw[j].a) < SHARED_EDGE_TOL_M;
      if (sameDir || flipDir) {
        sharedPairs.push({ primary: raw[i], partner: raw[j] });
        sharedIndex.add(i);
        sharedIndex.add(j);
        break;
      }
    }
  }
  const exterior: RawEdge[] = raw.filter((_, idx) => !sharedIndex.has(idx));

  // 3. Determine effective dominant axis.
  let axisDeg = dominantAzimuthDeg !== null
    ? ((dominantAzimuthDeg % 180) + 180) % 180
    : null;
  if (axisDeg === null && exterior.length >= 1) {
    const longest = [...exterior].sort((a, b) => b.lengthFt - a.lengthFt)[0];
    axisDeg = longest.bearingDeg;
  }
  const canUseBearing = axisDeg !== null && facets.length >= 2;

  // 4. Classify shared edges.
  let sharedClassified: Array<{ raw: SharedPair; type: "ridge" | "hip" | "valley" }> = [];
  if (canUseBearing && axisDeg !== null) {
    for (const pair of sharedPairs) {
      const dAxis = angularDistDeg(pair.primary.bearingDeg, axisDeg);
      const dPerp = angularDistDeg(pair.primary.bearingDeg, (axisDeg + 90) % 180);
      let type: "ridge" | "hip" | "valley";
      // At exactly 15° the bearing branch wins (ridge/valley over hip;
      // eave over rake).
      if (dAxis <= 15) type = "ridge";
      else if (dPerp <= 15) type = "valley";
      else type = "hip";
      sharedClassified.push({ raw: pair, type });
    }
    // Complexity-ratio sanity caps on ridges.
    const totalSharedLf = sharedPairs.reduce((s, p) => s + p.primary.lengthFt, 0);
    const complexity = classifyComplexity({ facets, edges: [], objects: [] });
    const ridgeCap = complexity === "complex" ? 0.40 : complexity === "moderate" ? 0.55 : 0.85;
    let ridgeLfAccum = 0;
    let ridgesAccepted = 0;
    sharedClassified = sharedClassified
      .sort((a, b) => b.raw.primary.lengthFt - a.raw.primary.lengthFt)
      .map((s) => {
        if (s.type !== "ridge") return s;
        // Always allow at least one ridge through — on a 2-facet gable the
        // only shared edge IS the ridge by definition, and the cap (which
        // exists to prevent runaway ridges on irregular roofs) would
        // otherwise demote it. After the first, apply the cap to subsequent
        // ridge candidates.
        if (ridgesAccepted === 0 ||
            ridgeLfAccum + s.raw.primary.lengthFt <= totalSharedLf * ridgeCap) {
          ridgeLfAccum += s.raw.primary.lengthFt;
          ridgesAccepted += 1;
          return s;
        }
        return { ...s, type: "hip" as const };
      });
  } else {
    const totalSharedLf = sharedPairs.reduce((s, p) => s + p.primary.lengthFt, 0);
    const ranked = [...sharedPairs].sort((a, b) => b.primary.lengthFt - a.primary.lengthFt);
    let consumed = 0;
    // `ratio` is the cumulative consumed BEFORE adding the current edge,
    // so the first (longest) shared edge always lands as a ridge — same
    // invariant as the bearing branch's first-ridge unconditional admit.
    for (const pair of ranked) {
      const ratio = consumed / Math.max(totalSharedLf, 1);
      let type: "ridge" | "hip" | "valley";
      if (ratio < 0.55) type = "ridge";
      else if (ratio < 0.75) type = "hip";
      else type = "valley";
      sharedClassified.push({ raw: pair, type });
      consumed += pair.primary.lengthFt;
    }
  }

  // 5. Classify exterior edges.
  const exteriorClassified: Array<{ raw: RawEdge; type: "eave" | "rake" }> = [];
  if (canUseBearing && axisDeg !== null) {
    for (const e of exterior) {
      const dAxis = angularDistDeg(e.bearingDeg, axisDeg);
      exteriorClassified.push({ raw: e, type: dAxis <= 15 ? "eave" : "rake" });
    }
  } else {
    const totalExteriorLf = exterior.reduce((s, e) => s + e.lengthFt, 0);
    const ranked = [...exterior].sort((a, b) => b.lengthFt - a.lengthFt);
    let eaveLf = 0;
    for (const e of ranked) {
      if (eaveLf + e.lengthFt <= totalExteriorLf * 0.55) {
        exteriorClassified.push({ raw: e, type: "eave" });
        eaveLf += e.lengthFt;
      } else {
        exteriorClassified.push({ raw: e, type: "rake" });
      }
    }
  }

  // 6. Emit Edge[] with confidence 0.4 and real polylines.
  let edgeId = 0;
  const result: Edge[] = [];
  for (const s of sharedClassified) {
    result.push({
      id: `edge-${edgeId++}`,
      type: s.type,
      polyline: [
        { lat: s.raw.primary.a.lat, lng: s.raw.primary.a.lng, heightM: 0 },
        { lat: s.raw.primary.b.lat, lng: s.raw.primary.b.lng, heightM: 0 },
      ],
      lengthFt: Math.round(s.raw.primary.lengthFt),
      facetIds: [s.raw.primary.facetId, s.raw.partner.facetId],
      confidence: 0.4,
    });
  }
  for (const e of exteriorClassified) {
    result.push({
      id: `edge-${edgeId++}`,
      type: e.type,
      polyline: [
        { lat: e.raw.a.lat, lng: e.raw.a.lng, heightM: 0 },
        { lat: e.raw.b.lat, lng: e.raw.b.lng, heightM: 0 },
      ],
      lengthFt: Math.round(e.raw.lengthFt),
      facetIds: [e.raw.facetId],
      confidence: 0.4,
    });
  }
  return result;
}

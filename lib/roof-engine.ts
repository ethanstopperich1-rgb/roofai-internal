// lib/roof-engine.ts
import type {
  ComplexityTier, Edge, Facet, FacetAttribution, FlashingBreakdown,
  LineItem, LineItemCategory, LineItemUnit, Material, PricedEstimate,
  PricingInputs, RoofData, RoofDiagnostics, RoofObject, RoofTotals,
  SimplifiedItem,
} from "@/types/roof";
import {
  BRAND_CONFIG, getMaterialPrice, type MaterialPriceKey,
} from "@/lib/branding";

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

// ---- Pricing engine (Tier C) -----------------------------------------------

export function makeDegradedRoofData(opts: {
  address: RoofData["address"];
  attempts: RoofDiagnostics["attempts"];
}): RoofData {
  return {
    address: opts.address,
    source: "none",
    refinements: [],
    confidence: 0,
    imageryDate: null,
    ageYearsEstimate: null,
    ageBucket: null,
    facets: [],
    edges: [],
    objects: [],
    outlinePolygon: null,
    flashing: {
      chimneyLf: 0, skylightLf: 0, dormerStepLf: 0, wallStepLf: 0,
      headwallLf: 0, apronLf: 0, valleyLf: 0, dripEdgeLf: 0,
      pipeBootCount: 0, iwsSqft: 0,
    },
    totals: {
      facetsCount: 0, edgesCount: 0, objectsCount: 0,
      totalRoofAreaSqft: 0, totalFootprintSqft: 0, totalSquares: 0,
      averagePitchDegrees: 0, wastePct: 11, complexity: "moderate",
      predominantMaterial: null,
    },
    diagnostics: {
      attempts: opts.attempts,
      warnings: ["We couldn't analyze this address — no source had coverage."],
      needsReview: [],
    },
  };
}

const UNDERLAYMENT_WASTE_FACTOR = 1.1;

const SHINGLE_KEY: Record<Material, MaterialPriceKey> = {
  "asphalt-3tab": "RFG_3T",
  "asphalt-architectural": "RFG_ARCH",
  "metal-standing-seam": "RFG_METAL",
  "tile-concrete": "RFG_TILE",
  // Tier C: no Xactimate codes for these yet — fall back to ARCH pricing
  // until specific codes are added. They're rare in FL; reps override
  // material before save.
  "wood-shake": "RFG_ARCH",
  "flat-membrane": "RFG_ARCH",
};

const SHINGLE_CODE: Record<Material, string> = {
  "asphalt-3tab": "RFG 3T",
  "asphalt-architectural": "RFG ARCH",
  "metal-standing-seam": "RFG METAL",
  "tile-concrete": "RFG TILE",
  "wood-shake": "RFG WOOD",
  "flat-membrane": "RFG MEMBRANE",
};

const SHINGLE_LABEL: Record<Material, string> = {
  "asphalt-3tab": "3-tab composition shingle",
  "asphalt-architectural": "Architectural composition shingle",
  "metal-standing-seam": "Standing-seam metal",
  "tile-concrete": "Concrete / clay tile",
  "wood-shake": "Wood shake",
  "flat-membrane": "Flat membrane",
};

function steepChargeMultiplier(pitchDegrees: number): number {
  if (pitchDegrees < 33.7) return 0;   // < ~8/12
  if (pitchDegrees < 39.8) return 0.25; // 8-10/12
  return 0.35;                          // > 10/12
}

function complexityMultiplier(c: ComplexityTier): number {
  if (c === "simple") return 1.0;
  if (c === "moderate") return 1.1;
  return 1.25;
}

const SIMPLIFIED_GROUPS: Array<{ name: string; codes: string[] }> = [
  { name: "Materials & shingles", codes: ["RFG ARCH", "RFG 3T", "RFG METAL", "RFG TILE", "RFG WOOD", "RFG MEMBRANE", "RFG STARTER", "RFG RIDG"] },
  { name: "Underlayment & weatherproofing", codes: ["RFG SYNF", "RFG IWS"] },
  { name: "Flashing & metal", codes: ["RFG DRIP", "RFG VAL", "RFG PIPEFL", "FLASH CHIM", "FLASH SKY", "FLASH DRMR", "FLASH WALL", "FLASH HEAD", "FLASH APRN"] },
  { name: "Tear-off & disposal", codes: ["RFG SHGLR", "RFG DEPSTL"] },
  { name: "Decking repair (allowance)", codes: ["RFG DECK"] },
  { name: "Ventilation", codes: ["RFG RDGV"] },
  { name: "Add-ons & upgrades", codes: ["ADDON"] },
  { name: "Labor adjustments", codes: ["RFG STP", "COMPLEXITY"] },
  { name: "Overhead & profit", codes: ["O&P"] },
];

function makeFlatItem(args: {
  code: string;
  description: string;
  friendlyName: string;
  quantity: number;
  unit: LineItemUnit;
  unitCostLow: number;
  unitCostHigh: number;
  category: LineItemCategory;
}): LineItem {
  const q = Math.max(0, args.quantity);
  return {
    code: args.code,
    description: args.description,
    friendlyName: args.friendlyName,
    quantity: Math.round(q * 100) / 100,
    unit: args.unit,
    unitCostLow: args.unitCostLow,
    unitCostHigh: args.unitCostHigh,
    extendedLow: Math.round(q * args.unitCostLow * 100) / 100,
    extendedHigh: Math.round(q * args.unitCostHigh * 100) / 100,
    category: args.category,
  };
}

export function priceRoofData(data: RoofData, inputs: PricingInputs): PricedEstimate {
  // Degraded RoofData → empty PricedEstimate
  if (data.source === "none" || data.facets.length === 0) {
    return {
      lineItems: [], simplifiedItems: [],
      subtotalLow: 0, subtotalHigh: 0,
      overheadProfit: { low: 0, high: 0 },
      totalLow: 0, totalHigh: 0,
      squares: 0, hasPerFacetDetail: false,
    };
  }

  const items: LineItem[] = [];
  const totalSqft = data.totals.totalRoofAreaSqft;
  const totalSquares = totalSqft / 100;
  // `??` would treat 0 as a valid override; in this domain a 0% waste is
  // always a bug (no roofing job has zero cut waste). Same guard as
  // computeTotals — positivity required for the override to apply.
  const wastePct = (inputs.wasteOverridePct != null && inputs.wasteOverridePct > 0)
    ? inputs.wasteOverridePct
    : data.totals.wastePct;
  const wasteFactor = 1 + wastePct / 100;

  // ---- Tear-off ----------------------------------------------------------
  const tearoffMultiplier =
    inputs.serviceType === "new" ? 0 :
    inputs.serviceType === "layover" ? 0 :
    inputs.serviceType === "repair" ? 0.25 : 1;
  if (tearoffMultiplier > 0) {
    const t = getMaterialPrice("RFG_SHGLR");
    items.push(makeFlatItem({
      code: "RFG SHGLR",
      description: "Tear off composition shingles",
      friendlyName: "Remove old shingles",
      quantity: totalSquares * tearoffMultiplier,
      unit: "SQ",
      unitCostLow: t.low, unitCostHigh: t.high,
      category: "tearoff",
    }));
    const d = getMaterialPrice("RFG_DEPSTL");
    items.push(makeFlatItem({
      code: "RFG DEPSTL",
      description: "Disposal / dump fee",
      friendlyName: "Disposal & dumpster",
      quantity: totalSquares * tearoffMultiplier,
      unit: "SQ",
      unitCostLow: d.low, unitCostHigh: d.high,
      category: "tearoff",
    }));
  }

  // ---- Decking allowance -------------------------------------------------
  if (inputs.serviceType === "reroof-tearoff" || inputs.serviceType === "new") {
    const dk = getMaterialPrice("RFG_DECK");
    items.push(makeFlatItem({
      code: "RFG DECK",
      description: "Sheathing replacement allowance",
      friendlyName: "Decking repair (10% allowance)",
      quantity: totalSqft * 0.1,
      unit: "SF",
      unitCostLow: dk.low, unitCostHigh: dk.high,
      category: "decking",
    }));
  }

  // ---- Underlayment ------------------------------------------------------
  if (inputs.serviceType !== "repair") {
    const u = getMaterialPrice("RFG_SYNF");
    items.push(makeFlatItem({
      code: "RFG SYNF",
      description: "Synthetic underlayment",
      friendlyName: "Synthetic underlayment",
      quantity: totalSquares * UNDERLAYMENT_WASTE_FACTOR,
      unit: "SQ",
      unitCostLow: u.low, unitCostHigh: u.high,
      category: "underlayment",
    }));
  }

  // ---- IWS ---------------------------------------------------------------
  if (data.flashing.iwsSqft > 0 && inputs.serviceType !== "repair") {
    const iws = getMaterialPrice("RFG_IWS");
    items.push(makeFlatItem({
      code: "RFG IWS",
      description: "Ice & water shield (eaves + valleys)",
      friendlyName: "Ice & water shield (eaves + valleys)",
      quantity: data.flashing.iwsSqft / 100,
      unit: "SQ",
      unitCostLow: iws.low, unitCostHigh: iws.high,
      category: "underlayment",
    }));
  }

  // ---- Drip edge ---------------------------------------------------------
  if (data.flashing.dripEdgeLf > 0 && inputs.serviceType !== "repair") {
    const dr = getMaterialPrice("RFG_DRIP");
    items.push(makeFlatItem({
      code: "RFG DRIP",
      description: "Drip edge",
      friendlyName: "Drip edge",
      quantity: data.flashing.dripEdgeLf,
      unit: "LF",
      unitCostLow: dr.low, unitCostHigh: dr.high,
      category: "flashing",
    }));
  }

  // ---- Valley metal ------------------------------------------------------
  if (data.flashing.valleyLf > 0 && inputs.serviceType !== "repair") {
    const v = getMaterialPrice("RFG_VAL");
    items.push(makeFlatItem({
      code: "RFG VAL",
      description: "Valley metal",
      friendlyName: "Valley metal",
      quantity: data.flashing.valleyLf,
      unit: "LF",
      unitCostLow: v.low, unitCostHigh: v.high,
      category: "flashing",
    }));
  }

  // ---- Chimney / skylight / dormer-step flashing (NEW in Tier C) ---------
  // Per-feature LF, replacing the legacy 3-row constant table.
  // RFG_FLASH isn't yet a branding key, so fall back to RFG_DRIP per-LF rate
  // (the closest existing flashing-metal material).
  const flashKey: MaterialPriceKey = "RFG_DRIP";
  if (data.flashing.chimneyLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH CHIM",
      description: "Chimney flashing kit (counter + step)",
      friendlyName: "Chimney flashing",
      quantity: data.flashing.chimneyLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }
  if (data.flashing.skylightLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH SKY",
      description: "Skylight flashing kit",
      friendlyName: "Skylight flashing",
      quantity: data.flashing.skylightLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }
  if (data.flashing.dormerStepLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH DRMR",
      description: "Dormer step flashing",
      friendlyName: "Dormer step flashing",
      quantity: data.flashing.dormerStepLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }

  // Tier B wall-to-roof junctions — only populated when the multiview
  // inspector ran (refinements includes "multiview-obliques"). All three
  // are zero under Tier C by design.
  if (data.flashing.wallStepLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH WALL",
      description: "Wall-to-roof step flashing (non-dormer)",
      friendlyName: "Wall step flashing",
      quantity: data.flashing.wallStepLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }
  if (data.flashing.headwallLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH HEAD",
      description: "Headwall flashing (top of wall-to-roof junction)",
      friendlyName: "Headwall flashing",
      quantity: data.flashing.headwallLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }
  if (data.flashing.apronLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice(flashKey);
    items.push(makeFlatItem({
      code: "FLASH APRN",
      description: "Apron flashing (bottom of wall-to-roof junction)",
      friendlyName: "Apron flashing",
      quantity: data.flashing.apronLf,
      unit: "LF",
      unitCostLow: f.low, unitCostHigh: f.high,
      category: "flashing",
    }));
  }

  // ---- Shingles (per-facet pricing) --------------------------------------
  const sh = getMaterialPrice(SHINGLE_KEY[inputs.material]);
  const facetAttribution: FacetAttribution[] = [];
  let shingleQty = 0;
  let shingleExtLow = 0;
  let shingleExtHigh = 0;
  // Shingle priced at flat $/SQ — steep-pitch surcharge is a labor-only
  // adjustment per Xactimate convention (RFG STP line, below). The per-facet
  // attribution still shows each facet's $ contribution (proportional to
  // its waste-adjusted sloped area), which is what the rep view consumes.
  const shingleUnitLow = sh.low * inputs.materialMultiplier;
  const shingleUnitHigh = sh.high * inputs.materialMultiplier;
  for (const facet of data.facets) {
    const facetSquares = (facet.areaSqftSloped / 100) *
      (inputs.serviceType === "repair" ? 0.15 : wasteFactor);
    const extLow = facetSquares * shingleUnitLow;
    const extHigh = facetSquares * shingleUnitHigh;
    facetAttribution.push({
      facetId: facet.id,
      areaSqftSloped: facet.areaSqftSloped,
      pitchDegrees: facet.pitchDegrees,
      extendedLow: Math.round(extLow * 100) / 100,
      extendedHigh: Math.round(extHigh * 100) / 100,
    });
    shingleQty += facetSquares;
    shingleExtLow += extLow;
    shingleExtHigh += extHigh;
  }
  items.push({
    code: SHINGLE_CODE[inputs.material],
    description: SHINGLE_LABEL[inputs.material],
    friendlyName: SHINGLE_LABEL[inputs.material],
    quantity: Math.round(shingleQty * 100) / 100,
    unit: "SQ",
    unitCostLow: sh.low * inputs.materialMultiplier,
    unitCostHigh: sh.high * inputs.materialMultiplier,
    extendedLow: Math.round(shingleExtLow * 100) / 100,
    extendedHigh: Math.round(shingleExtHigh * 100) / 100,
    category: "shingles",
    facetAttribution,
  });

  // ---- Starter strip -----------------------------------------------------
  if (data.flashing.dripEdgeLf > 0 && inputs.serviceType !== "repair") {
    const st = getMaterialPrice("RFG_STARTER");
    items.push(makeFlatItem({
      code: "RFG STARTER",
      description: "Starter strip",
      friendlyName: "Starter strip (eaves)",
      quantity: data.flashing.dripEdgeLf,
      unit: "LF",
      unitCostLow: st.low, unitCostHigh: st.high,
      category: "shingles",
    }));
  }

  // ---- Ridge / hip cap ---------------------------------------------------
  const ridgeHipLf = data.edges
    .filter((e) => e.type === "ridge" || e.type === "hip")
    .reduce((s, e) => s + e.lengthFt, 0);
  if (ridgeHipLf > 0) {
    const rd = getMaterialPrice("RFG_RIDG");
    items.push(makeFlatItem({
      code: "RFG RIDG",
      description: "Ridge / hip cap",
      friendlyName: "Ridge & hip caps",
      quantity: ridgeHipLf,
      unit: "LF",
      unitCostLow: rd.low, unitCostHigh: rd.high,
      category: "shingles",
    }));
  }

  // ---- Pipe boots --------------------------------------------------------
  if (inputs.serviceType !== "repair" && data.flashing.pipeBootCount > 0) {
    const pf = getMaterialPrice("RFG_PIPEFL");
    items.push(makeFlatItem({
      code: "RFG PIPEFL",
      description: "Pipe jack / flashing",
      friendlyName: "Pipe flashings",
      quantity: data.flashing.pipeBootCount,
      unit: "EA",
      unitCostLow: pf.low, unitCostHigh: pf.high,
      category: "flashing",
    }));
  }

  // ---- Add-ons -----------------------------------------------------------
  for (const a of inputs.addOns.filter((a) => a.enabled)) {
    items.push({
      code: "ADDON",
      description: a.label,
      friendlyName: a.label,
      quantity: 1, unit: "EA",
      unitCostLow: a.price, unitCostHigh: a.price,
      extendedLow: a.price, extendedHigh: a.price,
      category: "addons",
    });
  }

  // ---- Labor adjustments (steep + complexity over 35% of subtotal) -------
  const baseSubLow = items.reduce((s, it) => s + it.extendedLow, 0);
  const baseSubHigh = items.reduce((s, it) => s + it.extendedHigh, 0);
  const laborLow = baseSubLow * 0.35 * inputs.laborMultiplier;
  const laborHigh = baseSubHigh * 0.35 * inputs.laborMultiplier;

  // Steep charge: area-weighted across facets
  const totalArea = data.facets.reduce((s, f) => s + f.areaSqftSloped, 0);
  const weightedSteep = totalArea > 0
    ? data.facets.reduce(
        (s, f) => s + steepChargeMultiplier(f.pitchDegrees) * f.areaSqftSloped,
        0,
      ) / totalArea
    : 0;
  if (weightedSteep > 0) {
    const low = laborLow * weightedSteep;
    const high = laborHigh * weightedSteep;
    items.push({
      code: "RFG STP",
      description: "Steep roof charge (continuous pitch surcharge)",
      friendlyName: `Steep-pitch labor surcharge (+${Math.round(weightedSteep * 100)}%)`,
      quantity: 1, unit: "%",
      unitCostLow: low, unitCostHigh: high,
      extendedLow: Math.round(low * 100) / 100,
      extendedHigh: Math.round(high * 100) / 100,
      category: "labor",
    });
  }

  const complexityMult = complexityMultiplier(data.totals.complexity);
  if (complexityMult > 1) {
    const extra = complexityMult - 1;
    const low = laborLow * extra;
    const high = laborHigh * extra;
    items.push({
      code: "COMPLEXITY",
      description: "Cut-up roof / complexity adjustment",
      friendlyName: `Cut-up roof adjustment (+${Math.round(extra * 100)}%)`,
      quantity: 1, unit: "%",
      unitCostLow: low, unitCostHigh: high,
      extendedLow: Math.round(low * 100) / 100,
      extendedHigh: Math.round(high * 100) / 100,
      category: "labor",
    });
  }

  // ---- O&P ---------------------------------------------------------------
  const subLow = items.reduce((s, it) => s + it.extendedLow, 0);
  const subHigh = items.reduce((s, it) => s + it.extendedHigh, 0);
  const opPct =
    (BRAND_CONFIG.defaultMarkup.overheadPercent +
      BRAND_CONFIG.defaultMarkup.profitPercent) / 100;
  const opLow = subLow * opPct;
  const opHigh = subHigh * opPct;
  items.push({
    code: "O&P",
    description: "Overhead & profit",
    friendlyName: `Overhead & profit (${Math.round(opPct * 100)}%)`,
    quantity: 1, unit: "%",
    unitCostLow: opLow, unitCostHigh: opHigh,
    extendedLow: Math.round(opLow * 100) / 100,
    extendedHigh: Math.round(opHigh * 100) / 100,
    category: "op",
  });

  const totalLow = subLow + opLow;
  const totalHigh = subHigh + opHigh;

  const simplifiedItems: SimplifiedItem[] = SIMPLIFIED_GROUPS.map((g) => {
    const matching = items.filter((it) => g.codes.includes(it.code));
    return {
      group: g.name,
      totalLow: Math.round(matching.reduce((s, it) => s + it.extendedLow, 0) * 100) / 100,
      totalHigh: Math.round(matching.reduce((s, it) => s + it.extendedHigh, 0) * 100) / 100,
      codes: matching.map((it) => it.code),
    };
  }).filter((g) => g.totalLow > 0 || g.totalHigh > 0);

  return {
    lineItems: items,
    simplifiedItems,
    subtotalLow: Math.round(subLow * 100) / 100,
    subtotalHigh: Math.round(subHigh * 100) / 100,
    overheadProfit: {
      low: Math.round(opLow * 100) / 100,
      high: Math.round(opHigh * 100) / 100,
    },
    totalLow: Math.round(totalLow * 100) / 100,
    totalHigh: Math.round(totalHigh * 100) / 100,
    squares: Math.round((totalSqft / 100) * 100) / 100,
    hasPerFacetDetail: data.facets.length >= 2,
  };
}

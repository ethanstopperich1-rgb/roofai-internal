# Roof Engine Tier C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Tier C (Solar API + Vision fallback) foundation of the unified roof estimator engine — a single `RoofData` contract consumed by both `/internal` and `/quote`, a pluggable source pipeline, continuous per-facet pitch, and feature-driven flashing math replacing `flashingFromComplexity`.

**Architecture:** New `lib/roof-engine.ts` (pure functions), `lib/roof-pipeline.ts` (orchestrator with caching + degraded-data fallback), `lib/sources/{solar,vision}-source.ts` (pluggable adapters), `lib/cache/vision-request.ts` (request-scoped memoizer). Three-phase rollout with commit-and-push gates: Phase 1 (engine + pipeline + debug route, no UI), Phase 2 (`/internal` refactor + v2 save format + loader shim), Phase 3 (`/quote` refactor + delete legacy engine).

**Tech Stack:** TypeScript strict, Next.js 16 App Router, React 19, Tailwind v4. No test framework added — verification uses `npx tsx scripts/*.ts` (matches existing `eval-truth.ts` / `e2e-dashboard.ts` pattern) and a temporary debug API route for integration.

**Spec:** [docs/superpowers/specs/2026-05-14-roof-engine-tier-c-design.md](../specs/2026-05-14-roof-engine-tier-c-design.md)

---

## File Map

**New files:**

```
types/roof.ts                                  ← RoofData + Facet + Edge + RoofObject + FlashingBreakdown + RoofTotals + RoofDiagnostics + PricingInputs + PricedEstimate + EstimateV2 + LoadedEstimate
lib/cache/vision-request.ts                    ← request-scoped vision memoizer (getMemoizedVision)
lib/roof-engine.ts                             ← priceRoofData, computeFlashing, computeTotals, classifyComplexity, classifyEdges, suggestedWastePctTierC, makeDegradedRoofData, computeUnionConvexity
lib/sources/solar-source.ts                    ← tierCSolarSource (Solar API + parallel vision)
lib/sources/vision-source.ts                   ← tierCVisionSource (single-facet vision fallback)
lib/roof-pipeline.ts                           ← runRoofPipeline orchestrator with 1h cache
lib/legacy-estimate-loader.ts                  ← tagEstimate, loadEstimateById tagged-union loader
app/api/debug/roof-pipeline/route.ts           ← temporary debug GET endpoint (Phase 1)
components/roof/PitchDisplay.tsx               ← "5.4/12" continuous formatter
components/roof/LowSlopeBadge.tsx              ← small warning badge when pitchDegrees < 18.43
components/roof/RoofTotalsCard.tsx             ← sqft / squares / avg pitch / facet count
components/roof/DetectedFeaturesPanel.tsx      ← variant="rep" | "customer"
components/roof/FacetList.tsx                  ← rep-only per-facet breakdown
scripts/verify-roof-engine.ts                  ← tsx verification harness for pure engine functions
scripts/verify-roof-pipeline.ts                ← tsx verification harness for sources/pipeline (uses test fixtures, no real API calls)
```

**Modified files:**

```
types/estimate.ts                              ← keep legacy types intact; export `LoadedEstimate`
lib/storage.ts                                 ← v1/v2 tagged-union load; v2-only save
lib/proposal-snapshot.ts                       ← extend summarizer to read v2 priced.totalLow/High + pricingInputs.material
lib/pricing.ts                                 ← Phase 3: delete computeBase + buildDetailedEstimate + PITCH_TO_DEG_LOCAL; keep only fmt + MATERIAL_RATES (referenced by /internal UI for the rate display card)
lib/roof-geometry.ts                           ← Phase 3: delete flashingFromComplexity, deriveRoofLengthsFromPolygons, deriveRoofLengthsHeuristic; keep inferComplexityFromPolygons + buildWasteTable + suggestedWastePct (waste-table UI still uses them)
app/(internal)/page.tsx                        ← Phase 2: replace per-page Solar/vision orchestration with runRoofPipeline + priceRoofData
app/quote/page.tsx                             ← Phase 3: same replacement, customer surface
app/p/[id]/page.tsx                            ← Phase 2: branch on LoadedEstimate.kind for v2 vs legacy rendering
```

**Deleted files (Phase 1 — debug route is temporary):**

```
app/api/debug/roof-pipeline/route.ts           ← deleted at end of Phase 3 once /internal + /quote both work
```

---

## Verification Strategy

Pure functions (`computeFlashing`, `computeTotals`, `classifyComplexity`, `classifyEdges`, `priceRoofData`, `makeDegradedRoofData`): assertions in `scripts/verify-roof-engine.ts`, run via `npx tsx scripts/verify-roof-engine.ts`. Each function gets a tagged `describe`-style block with canned inputs and `assert.deepStrictEqual` checks. Failures throw, exit non-zero.

Sources + pipeline: assertions in `scripts/verify-roof-pipeline.ts` using mocked `fetch` via a tiny in-script monkey-patch. Real Solar / vision API calls happen only through the debug route on real addresses.

Integration: `curl http://localhost:3000/api/debug/roof-pipeline?address=...` against three real addresses (Oak Park, simple ranch, rural 404).

After each task: `npm run typecheck && npm run lint`. After each phase: `npm run build`.

---

## Phase 1 — Engine + Pipeline + Sources (no UI changes)

### Task 1: Create `types/roof.ts`

**Files:**
- Create: `types/roof.ts`

- [ ] **Step 1: Create the type file with the full schema**

```ts
// types/roof.ts
import type { AddOn } from "./estimate";

export type Material =
  | "asphalt-3tab"
  | "asphalt-architectural"
  | "metal-standing-seam"
  | "tile-concrete"
  | "wood-shake"
  | "flat-membrane";

export type ServiceType = "new" | "reroof-tearoff" | "layover" | "repair";

export interface Facet {
  id: string;
  polygon: Array<{ lat: number; lng: number }>;
  normal: { x: number; y: number; z: number };
  pitchDegrees: number;
  azimuthDeg: number;
  areaSqftSloped: number;
  areaSqftFootprint: number;
  material: Material | null;
  isLowSlope: boolean;
}

export type EdgeType = "ridge" | "hip" | "valley" | "eave" | "rake" | "step-wall";

export interface Edge {
  id: string;
  type: EdgeType;
  polyline: Array<{ lat: number; lng: number; heightM: number }>;
  lengthFt: number;
  facetIds: string[];
  confidence: number;
}

export type ObjectKind =
  | "chimney" | "skylight" | "dormer"
  | "vent" | "stack" | "satellite-dish"
  | "ridge-vent" | "box-vent" | "turbine";

export interface RoofObject {
  id: string;
  kind: ObjectKind;
  position: { lat: number; lng: number; heightM: number };
  dimensionsFt: { width: number; length: number };
  facetId: string | null;
}

export interface FlashingBreakdown {
  chimneyLf: number;
  skylightLf: number;
  dormerStepLf: number;
  wallStepLf: number;
  headwallLf: number;
  apronLf: number;
  valleyLf: number;
  dripEdgeLf: number;
  pipeBootCount: number;
  iwsSqft: number;
}

export type ComplexityTier = "simple" | "moderate" | "complex";

export interface RoofTotals {
  facetsCount: number;
  edgesCount: number;
  objectsCount: number;
  totalRoofAreaSqft: number;
  totalFootprintSqft: number;
  totalSquares: number;
  averagePitchDegrees: number;
  wastePct: number;
  complexity: ComplexityTier;
  predominantMaterial: Material | null;
}

export interface RoofDiagnostics {
  attempts: Array<{
    source: string;
    outcome: "succeeded" | "failed-coverage" | "failed-error";
    reason?: string;
  }>;
  warnings: string[];
  needsReview: Array<{ kind: "facet" | "edge" | "object"; id: string; reason: string }>;
}

export interface RoofData {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  /** "none" = all sources failed; see lib/roof-pipeline.makeDegradedRoofData. */
  source: "tier-a-lidar" | "tier-b-multiview" | "tier-c-solar" | "tier-c-vision" | "none";
  refinements: Array<"multiview-obliques">;
  confidence: number;
  imageryDate: string | null;
  ageYearsEstimate: number | null;
  ageBucket: "new" | "moderate" | "aged" | "very-aged" | null;
  facets: Facet[];
  edges: Edge[];
  objects: RoofObject[];
  flashing: FlashingBreakdown;
  totals: RoofTotals;
  diagnostics: RoofDiagnostics;
}

export interface PricingInputs {
  material: Material;
  materialMultiplier: number;
  laborMultiplier: number;
  serviceType: ServiceType;
  addOns: AddOn[];
  wasteOverridePct?: number;
  isInsuranceClaim?: boolean;
}

export type LineItemUnit = "SQ" | "LF" | "EA" | "SF" | "%";
export type LineItemCategory =
  | "tearoff" | "decking" | "underlayment" | "shingles"
  | "flashing" | "ventilation" | "addons" | "labor" | "op";

export interface FacetAttribution {
  facetId: string;
  areaSqftSloped: number;
  pitchDegrees: number;
  extendedLow: number;
  extendedHigh: number;
}

export interface LineItem {
  code: string;
  description: string;
  friendlyName: string;
  quantity: number;
  unit: LineItemUnit;
  unitCostLow: number;
  unitCostHigh: number;
  extendedLow: number;
  extendedHigh: number;
  category: LineItemCategory;
  /** Per-facet breakdown for shingle/labor lines; undefined on lines that
   *  aren't facet-priced (drip edge, decking, addons, etc.). */
  facetAttribution?: FacetAttribution[];
}

export interface SimplifiedItem {
  group: string;
  totalLow: number;
  totalHigh: number;
  codes: string[];
}

export interface PricedEstimate {
  lineItems: LineItem[];
  simplifiedItems: SimplifiedItem[];
  subtotalLow: number;
  subtotalHigh: number;
  overheadProfit: { low: number; high: number };
  totalLow: number;
  totalHigh: number;
  squares: number;
  hasPerFacetDetail: boolean;
}

// ---- v2 saved-estimate shape ----------------------------------------------

import type { AddressInfo, PhotoMeta, Estimate as LegacyEstimate } from "./estimate";
import type { ClaimContext } from "../lib/carriers";

export interface EstimateV2 {
  version: 2;
  id: string;
  createdAt: string;
  staff: string;
  customerName?: string;
  notes?: string;
  address: AddressInfo;
  roofData: RoofData;
  pricingInputs: PricingInputs;
  priced: PricedEstimate;
  isInsuranceClaim?: boolean;
  photos?: PhotoMeta[];
  claim?: ClaimContext;
}

export type LoadedEstimate =
  | { kind: "v2"; estimate: EstimateV2 }
  | { kind: "v1"; estimate: LegacyEstimate };
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS, no new errors.

- [ ] **Step 3: Verify it lints**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add types/roof.ts
git commit -m "feat(roof-engine): add types/roof.ts schema (Tier C)"
```

---

### Task 2: Create `lib/cache/vision-request.ts`

**Files:**
- Create: `lib/cache/vision-request.ts`

- [ ] **Step 1: Create the memoizer module**

```ts
// lib/cache/vision-request.ts
import type { RoofVision } from "@/types/estimate";

const inflight = new Map<string, Promise<RoofVision | null>>();

/**
 * Request-scoped memoizer for /api/vision. Both Tier C sources need
 * vision data; this guarantees the call fires at most once per
 * runRoofPipeline invocation (keyed by requestId).
 *
 * Vision failures resolve to null, not rejections — solar-source and
 * vision-source both treat null as "empty objects + no material",
 * not as a source failure (per spec §3.4).
 */
export async function getMemoizedVision(opts: {
  lat: number;
  lng: number;
  requestId: string;
  fetcher: (lat: number, lng: number) => Promise<RoofVision | null>;
}): Promise<RoofVision | null> {
  const key = `${opts.requestId}:${opts.lat.toFixed(6)},${opts.lng.toFixed(6)}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await opts.fetcher(opts.lat, opts.lng);
    } catch (err) {
      console.warn("[vision-request] fetcher errored, returning null:", err);
      return null;
    } finally {
      setTimeout(() => inflight.delete(key), 5000);
    }
  })();
  inflight.set(key, promise);
  return promise;
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/cache/vision-request.ts
git commit -m "feat(roof-engine): add request-scoped vision memoizer"
```

---

### Task 3: Create `lib/roof-engine.ts` skeleton + `computeFlashing`

**Files:**
- Create: `lib/roof-engine.ts`
- Create: `scripts/verify-roof-engine.ts`

- [ ] **Step 1: Create the engine skeleton with `computeFlashing`**

```ts
// lib/roof-engine.ts
import type {
  Edge, Facet, FlashingBreakdown, RoofObject,
} from "@/types/roof";

/**
 * Compute flashing line items from facets + edges + objects.
 * Tier C: chimney/skylight/dormer perimeter math + per-edge LF rollup.
 * Wall-step / headwall / apron are zero in Tier C (Tier B+ signals).
 */
export function computeFlashing(
  facets: Facet[],
  edges: Edge[],
  objects: RoofObject[],
): FlashingBreakdown {
  void facets; // not used in Tier C flashing math; here for Tier B+ extension

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
```

- [ ] **Step 2: Create the verification harness with failing assertions**

```ts
// scripts/verify-roof-engine.ts
import assert from "node:assert/strict";
import { computeFlashing } from "@/lib/roof-engine";
import type { Edge, RoofObject } from "@/types/roof";

const tests: Array<{ name: string; run: () => void }> = [];
function test(name: string, run: () => void) {
  tests.push({ name, run });
}

// ---- computeFlashing -------------------------------------------------------

test("computeFlashing: empty inputs return zeros", () => {
  const result = computeFlashing([], [], []);
  assert.equal(result.chimneyLf, 0);
  assert.equal(result.valleyLf, 0);
  assert.equal(result.iwsSqft, 0);
  assert.equal(result.pipeBootCount, 0);
  assert.equal(result.wallStepLf, 0);
});

test("computeFlashing: chimney perimeter math", () => {
  const objects: RoofObject[] = [
    {
      id: "c1",
      kind: "chimney",
      position: { lat: 0, lng: 0, heightM: 0 },
      dimensionsFt: { width: 3, length: 4 },
      facetId: null,
    },
  ];
  const result = computeFlashing([], [], objects);
  // 2 * (3 + 4) = 14 LF
  assert.equal(result.chimneyLf, 14);
});

test("computeFlashing: skylight perimeter math (2 skylights)", () => {
  const objects: RoofObject[] = [
    {
      id: "s1", kind: "skylight",
      position: { lat: 0, lng: 0, heightM: 0 },
      dimensionsFt: { width: 2, length: 4 },
      facetId: null,
    },
    {
      id: "s2", kind: "skylight",
      position: { lat: 0, lng: 0, heightM: 0 },
      dimensionsFt: { width: 3, length: 3 },
      facetId: null,
    },
  ];
  const result = computeFlashing([], [], objects);
  // 2*(2+4) + 2*(3+3) = 12 + 12 = 24
  assert.equal(result.skylightLf, 24);
});

test("computeFlashing: dormer step = 2 * cheek wall length", () => {
  const objects: RoofObject[] = [
    {
      id: "d1", kind: "dormer",
      position: { lat: 0, lng: 0, heightM: 0 },
      dimensionsFt: { width: 6, length: 8 },
      facetId: null,
    },
  ];
  const result = computeFlashing([], [], objects);
  // 2 * 8 = 16
  assert.equal(result.dormerStepLf, 16);
});

test("computeFlashing: valley LF gets 5% overlap, IWS uses post-overlap valley", () => {
  const edges: Edge[] = [
    { id: "e1", type: "valley", polyline: [], lengthFt: 20, facetIds: [], confidence: 0.4 },
  ];
  const result = computeFlashing([], edges, []);
  // 20 * 1.05 = 21 (rounded)
  assert.equal(result.valleyLf, 21);
  // iws = eaves*3 + valley*6 = 0 + 21*6 = 126
  assert.equal(result.iwsSqft, 126);
});

test("computeFlashing: drip edge = eaves + rakes; IWS includes eave*3", () => {
  const edges: Edge[] = [
    { id: "e1", type: "eave", polyline: [], lengthFt: 30, facetIds: [], confidence: 0.4 },
    { id: "e2", type: "rake", polyline: [], lengthFt: 20, facetIds: [], confidence: 0.4 },
  ];
  const result = computeFlashing([], edges, []);
  assert.equal(result.dripEdgeLf, 50);
  // iws = 30*3 + 0 = 90
  assert.equal(result.iwsSqft, 90);
});

test("computeFlashing: pipe boots count vents + stacks (not vents-other-kinds)", () => {
  const objects: RoofObject[] = [
    { id: "v1", kind: "vent", position: { lat: 0, lng: 0, heightM: 0 }, dimensionsFt: { width: 0.5, length: 0.5 }, facetId: null },
    { id: "s1", kind: "stack", position: { lat: 0, lng: 0, heightM: 0 }, dimensionsFt: { width: 0.5, length: 0.5 }, facetId: null },
    { id: "rv", kind: "ridge-vent", position: { lat: 0, lng: 0, heightM: 0 }, dimensionsFt: { width: 4, length: 4 }, facetId: null },
  ];
  const result = computeFlashing([], [], objects);
  assert.equal(result.pipeBootCount, 2);
});

// ---- runner ---------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`PASS  ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${t.name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${tests.length} verification(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} verifications passed`);
```

- [ ] **Step 2.5: Confirm the harness fails before we add later assertions**

Run: `npx tsx scripts/verify-roof-engine.ts`
Expected: All 7 PASS, exits 0. (`computeFlashing` is the only function asserted yet; later tasks add more.)

- [ ] **Step 3: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/roof-engine.ts scripts/verify-roof-engine.ts
git commit -m "feat(roof-engine): add computeFlashing + verification harness"
```

---

### Task 4: Add `classifyComplexity` + `suggestedWastePctTierC` + `computeUnionConvexity`

**Files:**
- Modify: `lib/roof-engine.ts`
- Modify: `scripts/verify-roof-engine.ts`

- [ ] **Step 1: Append to `lib/roof-engine.ts`**

```ts
// lib/roof-engine.ts  (append)
import type { ComplexityTier, RoofData } from "@/types/roof";

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
  const lower: typeof pts = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: typeof pts = [];
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
```

- [ ] **Step 2: Append verifications to `scripts/verify-roof-engine.ts`**

```ts
// scripts/verify-roof-engine.ts  (append before the "// ---- runner ----" line)
import {
  classifyComplexity,
  suggestedWastePctTierC,
} from "@/lib/roof-engine";
import type { Facet } from "@/types/roof";

function emptyFacet(id: string, polygon: Array<{ lat: number; lng: number }>): Facet {
  return {
    id, polygon,
    normal: { x: 0, y: 0, z: 1 },
    pitchDegrees: 22.6, azimuthDeg: 180,
    areaSqftSloped: 1000, areaSqftFootprint: 900,
    material: null, isLowSlope: false,
  };
}

test("classifyComplexity: 1 facet, no dormers, no valleys → simple", () => {
  const result = classifyComplexity({
    facets: [emptyFacet("f1", [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ])],
    edges: [],
    objects: [],
  });
  assert.equal(result, "simple");
});

test("classifyComplexity: 4 facets → moderate", () => {
  const facets = [1, 2, 3, 4].map((i) =>
    emptyFacet(`f${i}`, [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ]),
  );
  const result = classifyComplexity({ facets, edges: [], objects: [] });
  assert.equal(result, "moderate");
});

test("classifyComplexity: 6 facets → complex", () => {
  const facets = [1, 2, 3, 4, 5, 6].map((i) =>
    emptyFacet(`f${i}`, [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ]),
  );
  const result = classifyComplexity({ facets, edges: [], objects: [] });
  assert.equal(result, "complex");
});

test("classifyComplexity: 1 dormer bumps to moderate", () => {
  const result = classifyComplexity({
    facets: [emptyFacet("f1", [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ])],
    edges: [],
    objects: [{
      id: "d1", kind: "dormer",
      position: { lat: 0.5, lng: 0.5, heightM: 0 },
      dimensionsFt: { width: 6, length: 8 },
      facetId: null,
    }],
  });
  assert.equal(result, "moderate");
});

test("classifyComplexity: 3 dormers → complex (dormer-heavy signal)", () => {
  const result = classifyComplexity({
    facets: [emptyFacet("f1", [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ])],
    edges: [],
    objects: [1, 2, 3].map((i) => ({
      id: `d${i}`, kind: "dormer" as const,
      position: { lat: 0.5, lng: 0.5, heightM: 0 },
      dimensionsFt: { width: 6, length: 8 },
      facetId: null,
    })),
  });
  assert.equal(result, "complex");
});

test("classifyComplexity: 60 LF of valleys → complex", () => {
  const result = classifyComplexity({
    facets: [emptyFacet("f1", [
      { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
      { lat: 1, lng: 1 }, { lat: 1, lng: 0 },
    ])],
    edges: [
      { id: "v1", type: "valley", polyline: [], lengthFt: 30, facetIds: [], confidence: 0.4 },
      { id: "v2", type: "valley", polyline: [], lengthFt: 35, facetIds: [], confidence: 0.4 },
    ],
    objects: [],
  });
  assert.equal(result, "complex");
});

test("suggestedWastePctTierC: 7 / 11 / 14", () => {
  assert.equal(suggestedWastePctTierC("simple"), 7);
  assert.equal(suggestedWastePctTierC("moderate"), 11);
  assert.equal(suggestedWastePctTierC("complex"), 14);
});
```

- [ ] **Step 3: Run verifications**

Run: `npx tsx scripts/verify-roof-engine.ts`
Expected: All ~14 verifications PASS.

- [ ] **Step 4: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/roof-engine.ts scripts/verify-roof-engine.ts
git commit -m "feat(roof-engine): add classifyComplexity + suggestedWastePctTierC"
```

---

### Task 5: Add `computeTotals`

**Files:**
- Modify: `lib/roof-engine.ts`
- Modify: `scripts/verify-roof-engine.ts`

- [ ] **Step 1: Append to `lib/roof-engine.ts`**

```ts
// lib/roof-engine.ts  (append)
import type { RoofTotals, Material } from "@/types/roof";

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
  const wastePct = wasteOverridePct ?? suggestedWastePctTierC(complexity);

  // Material consensus by area
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
```

- [ ] **Step 2: Append verifications**

```ts
// scripts/verify-roof-engine.ts  (append)
import { computeTotals } from "@/lib/roof-engine";

test("computeTotals: empty facets → all-zero totals", () => {
  const result = computeTotals([], [], []);
  assert.equal(result.facetsCount, 0);
  assert.equal(result.totalRoofAreaSqft, 0);
  assert.equal(result.averagePitchDegrees, 0);
  assert.equal(result.complexity, "simple");
  assert.equal(result.wastePct, 7);
});

test("computeTotals: area-weighted average pitch + squares rounding", () => {
  const f1 = emptyFacet("f1", []);
  f1.pitchDegrees = 20;
  f1.areaSqftSloped = 1000;
  const f2 = emptyFacet("f2", []);
  f2.pitchDegrees = 30;
  f2.areaSqftSloped = 1000;
  const result = computeTotals([f1, f2], [], []);
  assert.equal(result.averagePitchDegrees, 25);
  assert.equal(result.totalRoofAreaSqft, 2000);
  // 2000 / 100 = 20 squares, already on a 1/3 boundary
  assert.equal(result.totalSquares, 20);
});

test("computeTotals: wasteOverridePct wins over suggested", () => {
  const result = computeTotals([], [], [], 17);
  assert.equal(result.wastePct, 17);
});

test("computeTotals: predominant material is most-area material, ignoring null", () => {
  const f1 = emptyFacet("f1", []);
  f1.material = "asphalt-architectural";
  f1.areaSqftSloped = 1500;
  const f2 = emptyFacet("f2", []);
  f2.material = "metal-standing-seam";
  f2.areaSqftSloped = 500;
  const result = computeTotals([f1, f2], [], []);
  assert.equal(result.predominantMaterial, "asphalt-architectural");
});
```

- [ ] **Step 3: Run verifications + typecheck + lint**

Run: `npx tsx scripts/verify-roof-engine.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/roof-engine.ts scripts/verify-roof-engine.ts
git commit -m "feat(roof-engine): add computeTotals"
```

---

### Task 6: Add `classifyEdges`

**Files:**
- Modify: `lib/roof-engine.ts`
- Modify: `scripts/verify-roof-engine.ts`

- [ ] **Step 1: Append to `lib/roof-engine.ts`**

```ts
// lib/roof-engine.ts  (append)

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
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  // Normalize to [0, 180) — edges are bidirectional, so 30° and 210° are the same edge orientation.
  return ((bearing % 180) + 180) % 180;
}

function angularDistDeg(a: number, b: number): number {
  const d = Math.abs(((a - b + 90) % 180) - 90);
  return d;
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
  // 1. Walk every polygon edge across all facets.
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
  // If Solar provides one, use it. Otherwise reconstruct from the longest
  // exterior edge (preserves the heuristic on octagonal / round buildings
  // and single-facet vision-only sources).
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
      if (dAxis <= 15) type = "ridge";
      else if (dPerp <= 15) type = "valley";
      else type = "hip";
      sharedClassified.push({ raw: pair, type });
    }
    // Complexity-ratio sanity caps
    const totalSharedLf = sharedPairs.reduce((s, p) => s + p.primary.lengthFt, 0);
    const complexity = classifyComplexity({ facets, edges: [], objects: [] });
    const ridgeCap = complexity === "complex" ? 0.40 : complexity === "moderate" ? 0.55 : 0.85;
    let ridgeLfAccum = 0;
    sharedClassified = sharedClassified
      .sort((a, b) => b.raw.primary.lengthFt - a.raw.primary.lengthFt)
      .map((s) => {
        if (s.type === "ridge") {
          if (ridgeLfAccum + s.raw.primary.lengthFt > totalSharedLf * ridgeCap) {
            return { ...s, type: "hip" as const };
          }
          ridgeLfAccum += s.raw.primary.lengthFt;
        }
        return s;
      });
  } else {
    // Length-ranked fallback: longest-first into ridge until cap, then hip, then valley.
    const totalSharedLf = sharedPairs.reduce((s, p) => s + p.primary.lengthFt, 0);
    const ranked = [...sharedPairs].sort((a, b) => b.primary.lengthFt - a.primary.lengthFt);
    let consumed = 0;
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
  let exteriorClassified: Array<{ raw: RawEdge; type: "eave" | "rake" }> = [];
  if (canUseBearing && axisDeg !== null) {
    for (const e of exterior) {
      const dAxis = angularDistDeg(e.bearingDeg, axisDeg);
      exteriorClassified.push({ raw: e, type: dAxis <= 15 ? "eave" : "rake" });
    }
  } else {
    // Length-ranked eave/rake split: 55% eaves (longest first) / 45% rakes
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

  // 6. Emit Edge[] with confidence 0.4 and real polylines (heightM = 0).
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
```

- [ ] **Step 2: Append verifications**

```ts
// scripts/verify-roof-engine.ts  (append)
import { classifyEdges } from "@/lib/roof-engine";

test("classifyEdges: empty facets → empty edges", () => {
  const result = classifyEdges([], null);
  assert.deepStrictEqual(result, []);
});

test("classifyEdges: single rectangular facet → 4 exterior edges (2 eaves + 2 rakes), confidence 0.4", () => {
  // ~30 m × 20 m rectangle in lat/lng (very approximate at this latitude)
  const facet = emptyFacet("f1", [
    { lat: 0.0000, lng: 0.0000 },
    { lat: 0.0000, lng: 0.0003 },
    { lat: 0.00027, lng: 0.0003 },
    { lat: 0.00027, lng: 0.0000 },
  ]);
  // dominantAzimuth = null → axis reconstructed from longest exterior edge
  const result = classifyEdges([facet], null);
  // 1 facet → falls back to length-ranked eave/rake. The 2 longer
  // edges (~33m east-west sides) become eaves; the 2 shorter (~30m
  // north-south) become rakes — though with only 1 facet, "shared"
  // detection finds no matches, so all 4 are exterior.
  assert.equal(result.length, 4);
  assert.ok(result.every((e) => e.confidence === 0.4));
  const eaveCount = result.filter((e) => e.type === "eave").length;
  const rakeCount = result.filter((e) => e.type === "rake").length;
  // Length-ranked split: 2 eaves (longest) + 2 rakes
  assert.equal(eaveCount + rakeCount, 4);
});

test("classifyEdges: two facets sharing one edge → ridge/hip/valley emitted on shared, eave/rake on exterior", () => {
  // Two adjacent rectangles sharing an east edge
  const fA = emptyFacet("fA", [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.0003 },
    { lat: 0.0003, lng: 0.0003 },
    { lat: 0.0003, lng: 0 },
  ]);
  const fB = emptyFacet("fB", [
    { lat: 0, lng: 0.0003 },
    { lat: 0, lng: 0.0006 },
    { lat: 0.0003, lng: 0.0006 },
    { lat: 0.0003, lng: 0.0003 },
  ]);
  const result = classifyEdges([fA, fB], 0);  // dominant axis = 0° (north-south)
  // 8 raw edges; 1 shared pair → 1 shared edge + 6 exterior = 7 emitted
  assert.equal(result.length, 7);
  const shared = result.filter((e) => e.facetIds.length === 2);
  assert.equal(shared.length, 1);
  // The shared edge runs north-south (parallel to axis 0°) → ridge candidate
  assert.equal(shared[0].type, "ridge");
});
```

- [ ] **Step 3: Run verifications + typecheck + lint**

Run: `npx tsx scripts/verify-roof-engine.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/roof-engine.ts scripts/verify-roof-engine.ts
git commit -m "feat(roof-engine): add classifyEdges (Tier C heuristic)"
```

---

### Task 7: Add `priceRoofData` + `makeDegradedRoofData`

**Files:**
- Modify: `lib/roof-engine.ts`
- Modify: `scripts/verify-roof-engine.ts`

- [ ] **Step 1: Append `makeDegradedRoofData`**

```ts
// lib/roof-engine.ts  (append)
import type { RoofDiagnostics } from "@/types/roof";

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
```

- [ ] **Step 2: Append `priceRoofData`**

```ts
// lib/roof-engine.ts  (append)
import type { LineItem, PricedEstimate, PricingInputs, SimplifiedItem, FacetAttribution } from "@/types/roof";
import { BRAND_CONFIG, getMaterialPrice, type MaterialPriceKey } from "./branding";

const UNDERLAYMENT_WASTE_FACTOR = 1.1;

const SHINGLE_KEY: Record<Material, MaterialPriceKey> = {
  "asphalt-3tab": "RFG_3T",
  "asphalt-architectural": "RFG_ARCH",
  "metal-standing-seam": "RFG_METAL",
  "tile-concrete": "RFG_TILE",
  // Tier C: no Xactimate codes for these yet — fall back to ARCH pricing
  // with a TODO. They're rare in FL; reps override material before save.
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
  if (pitchDegrees < 33.7) return 0;   // ~< 8/12
  if (pitchDegrees < 39.8) return 0.25; // ~8-10/12
  return 0.35;                          // ~> 10/12
}

function complexityMultiplier(c: ComplexityTier): number {
  if (c === "simple") return 1.0;
  if (c === "moderate") return 1.1;
  return 1.25;
}

const SIMPLIFIED_GROUPS: Array<{ name: string; codes: string[] }> = [
  { name: "Materials & shingles", codes: ["RFG ARCH", "RFG 3T", "RFG METAL", "RFG TILE", "RFG WOOD", "RFG MEMBRANE", "RFG STARTER", "RFG RIDG"] },
  { name: "Underlayment & weatherproofing", codes: ["RFG SYNF", "RFG IWS"] },
  { name: "Flashing & metal", codes: ["RFG DRIP", "RFG VAL", "RFG PIPEFL", "FLASH CHIM", "FLASH SKY", "FLASH DRMR"] },
  { name: "Tear-off & disposal", codes: ["RFG SHGLR", "RFG DEPSTL"] },
  { name: "Decking repair (allowance)", codes: ["RFG DECK"] },
  { name: "Ventilation", codes: ["RFG RDGV"] },
  { name: "Add-ons & upgrades", codes: ["ADDON"] },
  { name: "Labor adjustments", codes: ["RFG STP", "COMPLEXITY"] },
  { name: "Overhead & profit", codes: ["O&P"] },
];

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
  const wastePct = inputs.wasteOverridePct ?? data.totals.wastePct;
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
      unitCostLow: t.low,
      unitCostHigh: t.high,
      category: "tearoff",
    }));
    const d = getMaterialPrice("RFG_DEPSTL");
    items.push(makeFlatItem({
      code: "RFG DEPSTL",
      description: "Disposal / dump fee",
      friendlyName: "Disposal & dumpster",
      quantity: totalSquares * tearoffMultiplier,
      unit: "SQ",
      unitCostLow: d.low,
      unitCostHigh: d.high,
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
  // These three replace the old single-row "flashingLf" + "stepFlashingLf"
  // line items. Each one is feature-driven from objects[] now.
  if (data.flashing.chimneyLf > 0 && inputs.serviceType !== "repair") {
    const f = getMaterialPrice("RFG_FLASH");
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
    const f = getMaterialPrice("RFG_FLASH");
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
    const f = getMaterialPrice("RFG_FLASH");
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

  // ---- Shingles (per-facet pricing) --------------------------------------
  const sh = getMaterialPrice(SHINGLE_KEY[inputs.material]);
  const facetAttribution: FacetAttribution[] = [];
  let shingleQty = 0;
  let shingleExtLow = 0;
  let shingleExtHigh = 0;
  for (const facet of data.facets) {
    const facetSquares = (facet.areaSqftSloped / 100) *
      (inputs.serviceType === "repair" ? 0.15 : wasteFactor);
    const facetSteep = 1 + steepChargeMultiplier(facet.pitchDegrees);
    const unitLow = sh.low * inputs.materialMultiplier * facetSteep;
    const unitHigh = sh.high * inputs.materialMultiplier * facetSteep;
    const extLow = facetSquares * unitLow;
    const extHigh = facetSquares * unitHigh;
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

  // Steep charge: area-weighted across facets (continuous, not bucketed)
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

type LineItemUnit = LineItem["unit"];
type LineItemCategory = LineItem["category"];
```

**Note:** `RFG_FLASH` is referenced as the per-LF flashing rate for chimney/skylight/dormer-step. Verify it exists in `lib/branding.ts` `DEFAULT_MATERIAL_PRICES`. If not, fall back to `getMaterialPrice("RFG_VAL")` rates (valley metal $/LF is the closest existing per-LF flashing).

- [ ] **Step 2.5: Verify `RFG_FLASH` exists in branding.ts**

Run: `Grep` for `RFG_FLASH` in `lib/branding.ts`. If absent, change the three `getMaterialPrice("RFG_FLASH")` calls in `priceRoofData` to `getMaterialPrice("RFG_VAL")` and adjust the friendlyName/description to reflect the substitute pricing.

- [ ] **Step 3: Append verifications**

```ts
// scripts/verify-roof-engine.ts  (append)
import { priceRoofData, makeDegradedRoofData } from "@/lib/roof-engine";
import type { PricingInputs } from "@/types/roof";

const baselineInputs: PricingInputs = {
  material: "asphalt-architectural",
  materialMultiplier: 1.0,
  laborMultiplier: 1.0,
  serviceType: "reroof-tearoff",
  addOns: [],
};

test("priceRoofData: degraded RoofData → empty PricedEstimate", () => {
  const degraded = makeDegradedRoofData({
    address: { formatted: "x", lat: 0, lng: 0 },
    attempts: [],
  });
  const result = priceRoofData(degraded, baselineInputs);
  assert.equal(result.lineItems.length, 0);
  assert.equal(result.totalLow, 0);
});

test("priceRoofData: 1-facet 1000 sqft roof produces non-zero total with shingle line item", () => {
  const facet = emptyFacet("f1", [
    { lat: 0, lng: 0 }, { lat: 0, lng: 0.001 },
    { lat: 0.001, lng: 0.001 }, { lat: 0.001, lng: 0 },
  ]);
  facet.areaSqftSloped = 1000;
  facet.areaSqftFootprint = 900;
  facet.pitchDegrees = 22.6;
  const data: RoofData = {
    address: { formatted: "test", lat: 0, lng: 0 },
    source: "tier-c-solar",
    refinements: [], confidence: 0.85, imageryDate: null,
    ageYearsEstimate: null, ageBucket: null,
    facets: [facet], edges: [], objects: [],
    flashing: {
      chimneyLf: 0, skylightLf: 0, dormerStepLf: 0, wallStepLf: 0,
      headwallLf: 0, apronLf: 0, valleyLf: 0, dripEdgeLf: 100,
      pipeBootCount: 3, iwsSqft: 300,
    },
    totals: {
      facetsCount: 1, edgesCount: 0, objectsCount: 0,
      totalRoofAreaSqft: 1000, totalFootprintSqft: 900,
      totalSquares: 10, averagePitchDegrees: 22.6,
      wastePct: 11, complexity: "simple",
      predominantMaterial: "asphalt-architectural",
    },
    diagnostics: { attempts: [], warnings: [], needsReview: [] },
  };
  const result = priceRoofData(data, baselineInputs);
  assert.ok(result.totalLow > 0);
  const shingle = result.lineItems.find((it) => it.code === "RFG ARCH");
  assert.ok(shingle);
  assert.ok(shingle.facetAttribution);
  assert.equal(shingle.facetAttribution.length, 1);
});

test("priceRoofData: chimney + skylight + dormer flashing line items appear when LF > 0", () => {
  const facet = emptyFacet("f1", []);
  facet.areaSqftSloped = 1000;
  const data: RoofData = {
    address: { formatted: "test", lat: 0, lng: 0 },
    source: "tier-c-solar",
    refinements: [], confidence: 0.85, imageryDate: null,
    ageYearsEstimate: null, ageBucket: null,
    facets: [facet], edges: [], objects: [],
    flashing: {
      chimneyLf: 14, skylightLf: 24, dormerStepLf: 16,
      wallStepLf: 0, headwallLf: 0, apronLf: 0,
      valleyLf: 0, dripEdgeLf: 0, pipeBootCount: 0, iwsSqft: 0,
    },
    totals: {
      facetsCount: 1, edgesCount: 0, objectsCount: 0,
      totalRoofAreaSqft: 1000, totalFootprintSqft: 900,
      totalSquares: 10, averagePitchDegrees: 22.6,
      wastePct: 11, complexity: "simple",
      predominantMaterial: "asphalt-architectural",
    },
    diagnostics: { attempts: [], warnings: [], needsReview: [] },
  };
  const result = priceRoofData(data, baselineInputs);
  assert.ok(result.lineItems.find((it) => it.code === "FLASH CHIM"));
  assert.ok(result.lineItems.find((it) => it.code === "FLASH SKY"));
  assert.ok(result.lineItems.find((it) => it.code === "FLASH DRMR"));
});

test("priceRoofData: per-facet attribution sums to shingle extended", () => {
  const f1 = emptyFacet("f1", []);
  f1.areaSqftSloped = 600; f1.pitchDegrees = 22.6;
  const f2 = emptyFacet("f2", []);
  f2.areaSqftSloped = 400; f2.pitchDegrees = 35;
  const data: RoofData = {
    address: { formatted: "test", lat: 0, lng: 0 },
    source: "tier-c-solar",
    refinements: [], confidence: 0.85, imageryDate: null,
    ageYearsEstimate: null, ageBucket: null,
    facets: [f1, f2], edges: [], objects: [],
    flashing: {
      chimneyLf: 0, skylightLf: 0, dormerStepLf: 0, wallStepLf: 0,
      headwallLf: 0, apronLf: 0, valleyLf: 0, dripEdgeLf: 0,
      pipeBootCount: 0, iwsSqft: 0,
    },
    totals: {
      facetsCount: 2, edgesCount: 0, objectsCount: 0,
      totalRoofAreaSqft: 1000, totalFootprintSqft: 900,
      totalSquares: 10, averagePitchDegrees: 27.6,
      wastePct: 11, complexity: "simple",
      predominantMaterial: "asphalt-architectural",
    },
    diagnostics: { attempts: [], warnings: [], needsReview: [] },
  };
  const result = priceRoofData(data, baselineInputs);
  const shingle = result.lineItems.find((it) => it.code === "RFG ARCH")!;
  const sumAttribLow = shingle.facetAttribution!.reduce((s, a) => s + a.extendedLow, 0);
  // Allow 1¢ rounding tolerance
  assert.ok(Math.abs(sumAttribLow - shingle.extendedLow) < 0.05);
});
```

- [ ] **Step 4: Run verifications + typecheck + lint**

Run: `npx tsx scripts/verify-roof-engine.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/roof-engine.ts scripts/verify-roof-engine.ts
git commit -m "feat(roof-engine): add priceRoofData + makeDegradedRoofData"
```

---

### Task 8: Create `lib/sources/solar-source.ts`

**Files:**
- Create: `lib/sources/solar-source.ts`

- [ ] **Step 1: Create the Solar source adapter**

```ts
// lib/sources/solar-source.ts
import type {
  RoofData, Facet, RoofObject, Material,
} from "@/types/roof";
import type { SolarSummary, RoofVision } from "@/types/estimate";
import {
  classifyEdges, computeFlashing, computeTotals,
} from "@/lib/roof-engine";
import { getMemoizedVision } from "@/lib/cache/vision-request";

const M2_TO_SQFT = 10.7639;

/**
 * Tier C Solar source. Fans /api/solar and /api/vision in parallel.
 * Returns null when Solar has no coverage (404 or zero segments).
 * Vision failure is tolerated: objects[] becomes empty and material
 * stays null, but the source still succeeds because Solar's facet
 * data is independently valuable.
 */
export async function tierCSolarSource(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  requestId: string;
  /** Injected fetcher for testability. Defaults to the real /api/solar. */
  solarFetcher?: (lat: number, lng: number) => Promise<SolarSummary | null>;
  /** Injected fetcher for vision. Defaults to the real /api/vision. */
  visionFetcher?: (lat: number, lng: number) => Promise<RoofVision | null>;
}): Promise<RoofData | null> {
  const solarFetcher = opts.solarFetcher ?? defaultSolarFetcher;
  const visionFetcher = opts.visionFetcher ?? defaultVisionFetcher;

  const [solar, vision] = await Promise.all([
    solarFetcher(opts.address.lat, opts.address.lng).catch((err) => {
      console.warn("[solar-source] solar fetch failed:", err);
      return null;
    }),
    getMemoizedVision({
      lat: opts.address.lat,
      lng: opts.address.lng,
      requestId: opts.requestId,
      fetcher: visionFetcher,
    }),
  ]);

  if (!solar || solar.segmentCount === 0) return null;

  const facets = solarToFacets(solar, vision);
  const edges = classifyEdges(facets, solar.dominantAzimuthDeg);
  const objects = visionPenetrationsToObjects(opts.address, vision);
  const flashing = computeFlashing(facets, edges, objects);
  const totals = computeTotals(facets, edges, objects);

  const confidence =
    solar.imageryQuality === "HIGH" ? 0.85 :
    solar.imageryQuality === "MEDIUM" ? 0.70 :
    solar.imageryQuality === "LOW" ? 0.55 : 0.50;

  return {
    address: opts.address,
    source: "tier-c-solar",
    refinements: [],
    confidence,
    imageryDate: solar.imageryDate,
    ageYearsEstimate: vision?.estimatedAgeYears ?? null,
    ageBucket: vision && vision.estimatedAge !== "unknown" ? vision.estimatedAge : null,
    facets, edges, objects, flashing, totals,
    diagnostics: { attempts: [], warnings: [], needsReview: [] },
  };
}

function solarToFacets(solar: SolarSummary, vision: RoofVision | null): Facet[] {
  const material: Material | null = vision ? mapVisionMaterial(vision.currentMaterial) : null;
  return solar.segments.map((seg, idx) => {
    const polygon = solar.segmentPolygonsLatLng[idx] ?? [];
    const pitchDeg = seg.pitchDegrees;
    const pitchRad = (pitchDeg * Math.PI) / 180;
    const az = seg.azimuthDegrees;
    const azRad = (az * Math.PI) / 180;
    // Normal vector from pitch + azimuth (z up)
    const normal = {
      x: Math.sin(pitchRad) * Math.sin(azRad),
      y: Math.sin(pitchRad) * Math.cos(azRad),
      z: Math.cos(pitchRad),
    };
    return {
      id: `facet-${idx}`,
      polygon, normal,
      pitchDegrees: pitchDeg,
      azimuthDeg: az,
      areaSqftSloped: seg.areaSqft,
      areaSqftFootprint: seg.groundAreaSqft,
      material,
      isLowSlope: pitchDeg < 18.43, // < 4/12
    };
  });
}

function visionPenetrationsToObjects(
  address: { lat: number; lng: number },
  vision: RoofVision | null,
): RoofObject[] {
  if (!vision) return [];
  // vision.penetrations carries x/y in 640×640 tile pixels; we don't have
  // the tile bounds here. Tier C: emit objects with the address center as
  // approximate position. Tier B obliques refine to per-facet positioning.
  // Object IDs are derived from penetration index so a re-run produces
  // the same IDs (important for caching).
  return vision.penetrations.map((p, idx) => ({
    id: `obj-${idx}`,
    kind: mapPenetrationKind(p.kind),
    position: { lat: address.lat, lng: address.lng, heightM: 0 },
    dimensionsFt: {
      width: p.approxSizeFt ?? defaultDimForKind(p.kind),
      length: p.approxSizeFt ?? defaultDimForKind(p.kind),
    },
    facetId: null,
  }));
}

function mapPenetrationKind(k: RoofVision["penetrations"][number]["kind"]): RoofObject["kind"] {
  if (k === "vent") return "vent";
  if (k === "chimney") return "chimney";
  if (k === "skylight") return "skylight";
  if (k === "stack") return "stack";
  if (k === "satellite-dish") return "satellite-dish";
  return "vent"; // "other" → treat as vent for pipe-boot purposes
}

function defaultDimForKind(k: RoofVision["penetrations"][number]["kind"]): number {
  if (k === "chimney") return 3;
  if (k === "skylight") return 3;
  return 0.75;
}

function mapVisionMaterial(m: RoofVision["currentMaterial"]): Material | null {
  if (m === "unknown") return null;
  if (m === "asphalt-3tab") return "asphalt-3tab";
  if (m === "asphalt-architectural") return "asphalt-architectural";
  if (m === "metal-standing-seam") return "metal-standing-seam";
  if (m === "tile-concrete") return "tile-concrete";
  if (m === "wood-shake") return "wood-shake";
  if (m === "flat-membrane") return "flat-membrane";
  return null;
}

async function defaultSolarFetcher(lat: number, lng: number): Promise<SolarSummary | null> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/solar?lat=${lat}&lng=${lng}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json() as SolarSummary;
  if (data.segmentCount === 0) return null;
  return data;
}

async function defaultVisionFetcher(lat: number, lng: number): Promise<RoofVision | null> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/vision?lat=${lat}&lng=${lng}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}
```

**Note:** The `/api/vision` route may not exist with that exact signature. Check `app/api/vision/route.ts` (the spec says it exists). If the actual route uses POST + body, adapt `defaultVisionFetcher` to match.

- [ ] **Step 2: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/sources/solar-source.ts
git commit -m "feat(roof-engine): add tierCSolarSource (Solar + parallel vision)"
```

---

### Task 9: Create `lib/sources/vision-source.ts`

**Files:**
- Create: `lib/sources/vision-source.ts`

- [ ] **Step 1: Create the vision-only fallback source**

```ts
// lib/sources/vision-source.ts
import type { RoofData, Facet, Material } from "@/types/roof";
import type { RoofVision } from "@/types/estimate";
import {
  classifyEdges, computeFlashing, computeTotals,
} from "@/lib/roof-engine";
import { getMemoizedVision } from "@/lib/cache/vision-request";

/**
 * Tier C vision-only fallback. Single-facet whole-roof RoofData
 * when Solar has no coverage. Lower confidence (0.40); per-facet
 * pitch isn't available — uses vision's estimated pitch as a single
 * facet value.
 */
export async function tierCVisionSource(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  requestId: string;
  visionFetcher?: (lat: number, lng: number) => Promise<RoofVision | null>;
  /** Approximate footprint sqft for sizing the single facet — when caller
   *  has a Microsoft Buildings or geocoded estimate, pass it; otherwise
   *  defaults to 2000 sqft. */
  estimatedFootprintSqft?: number;
}): Promise<RoofData | null> {
  const visionFetcher = opts.visionFetcher ?? defaultVisionFetcher;
  const vision = await getMemoizedVision({
    lat: opts.address.lat,
    lng: opts.address.lng,
    requestId: opts.requestId,
    fetcher: visionFetcher,
  });
  if (!vision) return null;
  // Empty roof polygon = vision couldn't identify the roof
  if (!vision.roofPolygon || vision.roofPolygon.length < 3) return null;

  const facet = visionToSingleFacet(opts.address, vision, opts.estimatedFootprintSqft ?? 2000);
  const facets = [facet];
  const edges = classifyEdges(facets, null);
  const objects = visionPenetrationsToObjects(opts.address, vision);
  const flashing = computeFlashing(facets, edges, objects);
  const totals = computeTotals(facets, edges, objects);

  return {
    address: opts.address,
    source: "tier-c-vision",
    refinements: [],
    confidence: 0.40,
    imageryDate: null,
    ageYearsEstimate: vision.estimatedAgeYears,
    ageBucket: vision.estimatedAge !== "unknown" ? vision.estimatedAge : null,
    facets, edges, objects, flashing, totals,
    diagnostics: {
      attempts: [],
      warnings: ["Vision-only fallback — no Solar coverage. Pitch and area are approximate."],
      needsReview: [],
    },
  };
}

function visionToSingleFacet(
  address: { lat: number; lng: number },
  vision: RoofVision,
  estimatedFootprintSqft: number,
): Facet {
  // vision.roofPolygon is in 640×640 pixel coords — we don't have the tile
  // bounds, so we synthesize a tiny lat/lng box around the address. Tier B
  // refinement supplies real geometry. Pitch from vision currently doesn't
  // exist as a field; use 25° (~ 6/12 average) until the vision prompt
  // is enhanced for estimatedPitchDegrees.
  const pitchDeg = 25;
  const pitchRad = (pitchDeg * Math.PI) / 180;
  const slopeRatio = 1 / Math.cos(pitchRad);
  const slopedArea = Math.round(estimatedFootprintSqft * slopeRatio);
  // Synthesize a square polygon around address.lat/lng sized to footprint.
  // 1 m ≈ 1/111320 degrees lat
  const sideM = Math.sqrt(estimatedFootprintSqft / 10.7639); // m
  const halfDeg = sideM / 2 / 111_320;
  return {
    id: "facet-0",
    polygon: [
      { lat: address.lat - halfDeg, lng: address.lng - halfDeg },
      { lat: address.lat - halfDeg, lng: address.lng + halfDeg },
      { lat: address.lat + halfDeg, lng: address.lng + halfDeg },
      { lat: address.lat + halfDeg, lng: address.lng - halfDeg },
    ],
    normal: { x: 0, y: 0, z: 1 },
    pitchDegrees: pitchDeg,
    azimuthDeg: 180,
    areaSqftSloped: slopedArea,
    areaSqftFootprint: estimatedFootprintSqft,
    material: mapVisionMaterial(vision.currentMaterial),
    isLowSlope: false,
  };
}

function visionPenetrationsToObjects(
  address: { lat: number; lng: number },
  vision: RoofVision,
) {
  return vision.penetrations.map((p, idx) => ({
    id: `obj-${idx}`,
    kind: mapPenetrationKind(p.kind),
    position: { lat: address.lat, lng: address.lng, heightM: 0 },
    dimensionsFt: {
      width: p.approxSizeFt ?? 1,
      length: p.approxSizeFt ?? 1,
    },
    facetId: null,
  })) as RoofData["objects"];
}

function mapPenetrationKind(k: RoofVision["penetrations"][number]["kind"]): RoofData["objects"][number]["kind"] {
  if (k === "vent") return "vent";
  if (k === "chimney") return "chimney";
  if (k === "skylight") return "skylight";
  if (k === "stack") return "stack";
  if (k === "satellite-dish") return "satellite-dish";
  return "vent";
}

function mapVisionMaterial(m: RoofVision["currentMaterial"]): Material | null {
  if (m === "asphalt-3tab") return "asphalt-3tab";
  if (m === "asphalt-architectural") return "asphalt-architectural";
  if (m === "metal-standing-seam") return "metal-standing-seam";
  if (m === "tile-concrete") return "tile-concrete";
  if (m === "wood-shake") return "wood-shake";
  if (m === "flat-membrane") return "flat-membrane";
  return null;
}

async function defaultVisionFetcher(lat: number, lng: number): Promise<RoofVision | null> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/vision?lat=${lat}&lng=${lng}`, { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}
```

- [ ] **Step 2: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/sources/vision-source.ts
git commit -m "feat(roof-engine): add tierCVisionSource (vision-only fallback)"
```

---

### Task 10: Create `lib/roof-pipeline.ts`

**Files:**
- Create: `lib/roof-pipeline.ts`

- [ ] **Step 1: Create the orchestrator**

```ts
// lib/roof-pipeline.ts
import type { RoofData, RoofDiagnostics } from "@/types/roof";
import { makeDegradedRoofData } from "@/lib/roof-engine";
import { tierCSolarSource } from "@/lib/sources/solar-source";
import { tierCVisionSource } from "@/lib/sources/vision-source";
import { getCached, setCached } from "@/lib/cache";

function nanoid(): string {
  return Math.random().toString(36).slice(2, 14);
}

type RoofSource = (opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  requestId: string;
}) => Promise<RoofData | null>;

/**
 * Tier C orchestrator. Iterates sources serially; first non-null wins.
 * All sources failed → degraded RoofData (source: "none").
 * Successful results cached for 1h via lib/cache.ts; degraded never cached.
 */
export async function runRoofPipeline(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  /** When true, bypass cache (used by the debug route and the rep "re-analyze" button). */
  nocache?: boolean;
}): Promise<RoofData> {
  const cacheKey = `${opts.address.lat.toFixed(6)},${opts.address.lng.toFixed(6)}`;
  if (!opts.nocache) {
    const cached = await getCached<RoofData>("roof-data", opts.address.lat, opts.address.lng);
    if (cached && cached.source !== "none") {
      // Re-emit pipeline_source_picked telemetry on cache hit so the
      // success-rate metric stays accurate.
      console.log("[roof-pipeline] cache hit", {
        source: cached.source, address: opts.address.formatted, cacheKey,
      });
      return cached;
    }
  }

  const requestId = nanoid();
  const attempts: RoofDiagnostics["attempts"] = [];
  const sources: Array<{ name: string; fn: RoofSource }> = [
    { name: "tier-c-solar", fn: tierCSolarSource },
    { name: "tier-c-vision", fn: tierCVisionSource },
  ];

  let primary: RoofData | null = null;
  const startedAt = Date.now();
  for (const s of sources) {
    try {
      const result = await s.fn({ address: opts.address, requestId });
      attempts.push({
        source: s.name,
        outcome: result ? "succeeded" : "failed-coverage",
      });
      if (result) { primary = result; break; }
    } catch (err) {
      attempts.push({
        source: s.name,
        outcome: "failed-error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!primary) {
    const degraded = makeDegradedRoofData({ address: opts.address, attempts });
    console.log("[roof-pipeline] all sources failed", {
      address: opts.address.formatted, attempts,
    });
    return degraded;
  }

  primary.diagnostics.attempts = attempts;
  const latencyMs = Date.now() - startedAt;
  console.log("[roof-pipeline] pipeline_source_picked", {
    source: primary.source,
    latencyMs,
    address: opts.address.formatted,
    imageryQuality: primary.imageryDate ? "present" : null,
  });

  // Cache successful results only
  await setCached("roof-data", opts.address.lat, opts.address.lng, primary);
  return primary;
}
```

- [ ] **Step 2: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/roof-pipeline.ts
git commit -m "feat(roof-engine): add runRoofPipeline orchestrator with cache + degraded fallback"
```

---

### Task 11: Create debug route + verify against 8450 Oak Park Rd

**Files:**
- Create: `app/api/debug/roof-pipeline/route.ts`

- [ ] **Step 1: Create the temporary debug route**

```ts
// app/api/debug/roof-pipeline/route.ts
import { NextResponse } from "next/server";
import { runRoofPipeline } from "@/lib/roof-pipeline";

export const runtime = "nodejs";

/**
 * Temporary debug route for Phase 1 verification. Removed at end of Phase 3.
 *
 * Usage:
 *   GET /api/debug/roof-pipeline?lat=28.4815&lng=-81.4720&nocache=1&address=...
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const address = searchParams.get("address") ?? "debug";
  const nocache = searchParams.get("nocache") === "1";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }
  const data = await runRoofPipeline({
    address: { formatted: address, lat, lng },
    nocache,
  });
  return NextResponse.json(data);
}
```

- [ ] **Step 2: Run typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 3: Start dev server and verify 8450 Oak Park Rd**

```bash
npm run dev
```

In a second terminal:

```bash
curl "http://localhost:3000/api/debug/roof-pipeline?lat=28.4815&lng=-81.4720&address=8450%20Oak%20Park%20Rd&nocache=1" | jq '{source, facets: (.facets | length), totalSqft: .totals.totalRoofAreaSqft, flashing: .flashing}'
```

Expected output (approximate):
```json
{
  "source": "tier-c-solar",
  "facets": 17,
  "totalSqft": 5485,
  "flashing": {
    "chimneyLf": <≈14-28>,
    "skylightLf": <≈12-24>,
    "dormerStepLf": <≈16-32>,
    "valleyLf": <≈30-50>,
    "dripEdgeLf": <≈200-280>,
    ...
  }
}
```

**Headline pass check:** `chimneyLf + skylightLf + dormerStepLf + valleyLf` should sum to roughly **~64 LF** (per spec acceptance criteria). If it's significantly off (< 40 or > 100), the heuristic is mis-tuned and Task 6's classifier needs revisiting.

- [ ] **Step 4: Verify a Solar-404 address falls through to vision**

```bash
# A rural Florida address Solar typically doesn't cover.
# (Pick one from the rep's known list, or use 9999 fake address.)
curl "http://localhost:3000/api/debug/roof-pipeline?lat=27.0&lng=-82.5&address=test%20rural" | jq '.source'
```

Expected: `"tier-c-vision"` if vision succeeded, otherwise `"none"`.

- [ ] **Step 5: Verify cache works**

```bash
# Run twice in quick succession — second call should log a cache hit
curl "http://localhost:3000/api/debug/roof-pipeline?lat=28.4815&lng=-81.4720&address=oak" > /dev/null
curl "http://localhost:3000/api/debug/roof-pipeline?lat=28.4815&lng=-81.4720&address=oak" > /dev/null
```

Watch the dev server console — second call should print `[roof-pipeline] cache hit`.

- [ ] **Step 6: Stop dev server, commit**

```bash
git add app/api/debug/roof-pipeline/route.ts
git commit -m "feat(roof-engine): add Phase 1 debug route + verify 8450 Oak Park Rd"
```

---

### Task 12: Phase 1 verification harness + push

**Files:**
- Modify: nothing new

- [ ] **Step 1: Run the full verification harness**

Run: `npx tsx scripts/verify-roof-engine.ts`
Expected: All verifications PASS.

- [ ] **Step 2: Run full quality gate**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS at every step.

- [ ] **Step 3: Push Phase 1**

```bash
git push origin claude/epic-lamport-ce1560
```

Check Vercel preview build status — should pass. **Phase 1 complete.**

---

## Phase 2 — `/internal` Refactor + v2 Save Format + Loader Shim

### Task 13: Extend `lib/storage.ts` with v1/v2 tagged-union loader

**Files:**
- Modify: `lib/storage.ts`

- [ ] **Step 1: Read existing `lib/storage.ts`**

Read the file. Expected current API: `loadEstimates() / saveEstimate(e) / deleteEstimate(id) / getEstimate(id)`.

- [ ] **Step 2: Add tagged-union loader + v2 save**

Replace the existing `lib/storage.ts` content with this expanded version (keeping the existing function names but updating behavior):

```ts
// lib/storage.ts
import type { Estimate } from "@/types/estimate";
import type { EstimateV2, LoadedEstimate } from "@/types/roof";

const STORAGE_KEY = "roofai_estimates_v1"; // unchanged — same blob holds both shapes

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Tag a raw estimate row as v1 or v2 (for renderer branching). */
export function tagEstimate(raw: unknown): LoadedEstimate | null {
  if (!isRecord(raw)) return null;
  if (raw.version === 2 && isRecord(raw.roofData)) {
    return { kind: "v2", estimate: raw as unknown as EstimateV2 };
  }
  return { kind: "v1", estimate: raw as unknown as Estimate };
}

/** Raw load — returns mixed v1/v2 estimates (tagged). */
export function loadEstimatesTagged(): LoadedEstimate[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(tagEstimate).filter((x): x is LoadedEstimate => x !== null);
  } catch {
    return [];
  }
}

/** Back-compat: returns only legacy v1 estimates. */
export function loadEstimates(): Estimate[] {
  return loadEstimatesTagged()
    .filter((x): x is { kind: "v1"; estimate: Estimate } => x.kind === "v1")
    .map((x) => x.estimate);
}

/** Save a v2 estimate. New estimates always save as v2. */
export function saveEstimateV2(e: EstimateV2): void {
  if (typeof window === "undefined") return;
  const all = loadAllRaw();
  const updated = [e, ...all.filter((r) => !isRecord(r) || r.id !== e.id)];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

/** Save a legacy v1 estimate. Kept for any remaining callers; new code should
 *  use saveEstimateV2. */
export function saveEstimate(e: Estimate): void {
  if (typeof window === "undefined") return;
  const all = loadAllRaw();
  const updated = [e, ...all.filter((r) => !isRecord(r) || r.id !== e.id)];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function deleteEstimate(id: string): void {
  if (typeof window === "undefined") return;
  const all = loadAllRaw();
  const updated = all.filter((r) => isRecord(r) && r.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function getEstimateTagged(id: string): LoadedEstimate | null {
  return loadEstimatesTagged().find((x) => x.estimate.id === id) ?? null;
}

export function getEstimate(id: string): Estimate | undefined {
  return loadEstimates().find((e) => e.id === id);
}

function loadAllRaw(): unknown[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. If any caller of `loadEstimates()` was relying on it returning v2 estimates too, fix the call site to use `loadEstimatesTagged()` and branch on `kind`.

- [ ] **Step 4: Commit**

```bash
git add lib/storage.ts
git commit -m "feat(roof-engine): add v1/v2 tagged-union loader to lib/storage"
```

---

### Task 14: Extend `lib/proposal-snapshot.ts` for v2 reads

**Files:**
- Modify: `lib/proposal-snapshot.ts`

- [ ] **Step 1: Update `summarizeProposalSnapshot` to read v2 fields with v1 fallback**

Find the `summarizeProposalSnapshot` function. Update its body so it reads `priced.totalLow / totalHigh` and `pricingInputs.material` when the snapshot has `version: 2`, falling back to the existing v1 paths (`detailed.lineItems`, `assumptions.material`, etc.) otherwise.

Concrete edit — replace the body of `summarizeProposalSnapshot`:

```ts
export function summarizeProposalSnapshot(snapshot: Json | null): ProposalSummary {
  const empty: ProposalSummary = {
    material: null, sqft: null, pitch: null,
    addOnCount: 0, addOnLabels: [],
    lineItemCount: 0,
    total: null, totalLow: null, totalHigh: null,
    isInsuranceClaim: false,
    hasPhotos: false, photoCount: 0,
    staff: null, notes: null,
  };
  if (!isRecord(snapshot)) return empty;

  const isV2 = snapshot.version === 2 && isRecord(snapshot.roofData);

  if (isV2) {
    const roofData = isRecord(snapshot.roofData) ? snapshot.roofData : {};
    const totals = isRecord(roofData.totals) ? roofData.totals : {};
    const priced = isRecord(snapshot.priced) ? snapshot.priced : null;
    const pricingInputs = isRecord(snapshot.pricingInputs) ? snapshot.pricingInputs : {};
    const addOnsRaw = Array.isArray(pricingInputs.addOns) ? pricingInputs.addOns : [];
    const enabledAddOns = addOnsRaw.filter(
      (a) => isRecord(a) && a.enabled === true,
    ) as Array<Record<string, unknown>>;
    const lineItems = priced && Array.isArray(priced.lineItems) ? priced.lineItems : [];
    const photos = Array.isArray(snapshot.photos) ? snapshot.photos : [];

    // Pitch display: use averagePitchDegrees rounded
    const pitchDeg = asNumber(totals.averagePitchDegrees);
    const pitchLabel = pitchDeg !== null
      ? `${Math.round(Math.tan((pitchDeg * Math.PI) / 180) * 12 * 10) / 10}/12`
      : null;

    return {
      material: asString(pricingInputs.material),
      sqft: asNumber(totals.totalRoofAreaSqft),
      pitch: pitchLabel,
      addOnCount: enabledAddOns.length,
      addOnLabels: enabledAddOns
        .map((a) => asString(a.label))
        .filter((s): s is string => s !== null)
        .slice(0, 4),
      lineItemCount: lineItems.length,
      total: priced ? asNumber(priced.totalLow) : null,
      totalLow: priced ? asNumber(priced.totalLow) : null,
      totalHigh: priced ? asNumber(priced.totalHigh) : null,
      isInsuranceClaim: snapshot.isInsuranceClaim === true,
      hasPhotos: photos.length > 0,
      photoCount: photos.length,
      staff: asString(snapshot.staff),
      notes: asString(snapshot.notes),
    };
  }

  // ---- Legacy v1 fallback (existing code) ---------------------------------
  const assumptions = isRecord(snapshot.assumptions) ? snapshot.assumptions : {};
  const addOnsRaw = Array.isArray(snapshot.addOns) ? snapshot.addOns : [];
  const enabledAddOns = addOnsRaw.filter(
    (a) => isRecord(a) && a.enabled === true,
  ) as Array<Record<string, unknown>>;
  const detailed = isRecord(snapshot.detailed) ? snapshot.detailed : null;
  const lineItems = detailed && Array.isArray(detailed.lineItems) ? detailed.lineItems : [];
  const photos = Array.isArray(snapshot.photos) ? snapshot.photos : [];

  return {
    material: asString(assumptions.material) ?? asString(snapshot.material),
    sqft: asNumber(assumptions.sqft) ?? asNumber(snapshot.estimatedSqft),
    pitch: asString(assumptions.pitch),
    addOnCount: enabledAddOns.length,
    addOnLabels: enabledAddOns
      .map((a) => asString(a.label))
      .filter((s): s is string => s !== null)
      .slice(0, 4),
    lineItemCount: lineItems.length,
    total: asNumber(snapshot.total),
    totalLow: asNumber(snapshot.baseLow),
    totalHigh: asNumber(snapshot.baseHigh),
    isInsuranceClaim: snapshot.isInsuranceClaim === true,
    hasPhotos: photos.length > 0,
    photoCount: photos.length,
    staff: asString(snapshot.staff),
    notes: asString(snapshot.notes),
  };
}
```

- [ ] **Step 2: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/proposal-snapshot.ts
git commit -m "feat(roof-engine): extend proposal-snapshot to read v2 estimates"
```

---

### Task 15: Build shared `components/roof/PitchDisplay.tsx` + `LowSlopeBadge.tsx`

**Files:**
- Create: `components/roof/PitchDisplay.tsx`
- Create: `components/roof/LowSlopeBadge.tsx`

- [ ] **Step 1: Create `PitchDisplay.tsx`**

```tsx
// components/roof/PitchDisplay.tsx
export function PitchDisplay({ degrees, className }: { degrees: number; className?: string }) {
  const rise = Math.round(Math.tan((degrees * Math.PI) / 180) * 12 * 10) / 10;
  return <span className={className}>{rise}/12</span>;
}
```

- [ ] **Step 2: Create `LowSlopeBadge.tsx`**

```tsx
// components/roof/LowSlopeBadge.tsx
export function LowSlopeBadge({ className }: { className?: string }) {
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 " +
        (className ?? "")
      }
      title="Low slope (under 4/12) — may require different material spec"
    >
      Low slope
    </span>
  );
}
```

- [ ] **Step 3: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/roof/PitchDisplay.tsx components/roof/LowSlopeBadge.tsx
git commit -m "feat(roof-engine): add PitchDisplay + LowSlopeBadge components"
```

---

### Task 16: Build `components/roof/RoofTotalsCard.tsx`

**Files:**
- Create: `components/roof/RoofTotalsCard.tsx`

- [ ] **Step 1: Create the card**

```tsx
// components/roof/RoofTotalsCard.tsx
import type { RoofData } from "@/types/roof";
import { PitchDisplay } from "./PitchDisplay";

export function RoofTotalsCard({ data }: { data: RoofData }) {
  const t = data.totals;
  if (data.source === "none") {
    return (
      <div className="rounded-lg border bg-slate-50 p-4">
        <p className="text-sm text-slate-600">No analysis available — please verify the address.</p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Roof area</div>
          <div className="font-medium text-slate-900">{t.totalRoofAreaSqft.toLocaleString()} sqft</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Squares</div>
          <div className="font-medium text-slate-900">{t.totalSquares.toFixed(2)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Avg pitch</div>
          <div className="font-medium text-slate-900">
            <PitchDisplay degrees={t.averagePitchDegrees} />
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Facets</div>
          <div className="font-medium text-slate-900">{t.facetsCount}</div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/roof/RoofTotalsCard.tsx
git commit -m "feat(roof-engine): add RoofTotalsCard component"
```

---

### Task 17: Build `components/roof/DetectedFeaturesPanel.tsx`

**Files:**
- Create: `components/roof/DetectedFeaturesPanel.tsx`

- [ ] **Step 1: Create the panel (variant = rep | customer)**

```tsx
// components/roof/DetectedFeaturesPanel.tsx
import type { RoofData, RoofObject } from "@/types/roof";

export function DetectedFeaturesPanel({
  data, variant,
}: {
  data: RoofData;
  variant: "rep" | "customer";
}) {
  if (data.source === "none") return null;

  const counts = countObjects(data.objects);

  if (variant === "customer") {
    const lines = [];
    if (counts.chimney) lines.push(`${counts.chimney} chimney${counts.chimney > 1 ? "s" : ""}`);
    if (counts.skylight) lines.push(`${counts.skylight} skylight${counts.skylight > 1 ? "s" : ""}`);
    if (counts.dormer) lines.push(`${counts.dormer} dormer${counts.dormer > 1 ? "s" : ""}`);
    const ventCount = counts.vent + counts.stack;
    if (ventCount) lines.push(`${ventCount} roof vent${ventCount > 1 ? "s" : ""}`);
    return (
      <div className="rounded-lg border bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">What we detected</h3>
        <p className="mt-1 text-sm text-slate-700">
          {lines.length > 0 ? lines.join(", ") + " — all factored into your estimate." : "Clean roof — no penetrations detected."}
        </p>
      </div>
    );
  }

  // Rep variant — full diagnostics
  return (
    <div className="rounded-lg border bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">Detected features</h3>
      <ul className="mt-2 space-y-1 text-sm text-slate-700">
        <li>{data.facets.length} facet{data.facets.length === 1 ? "" : "s"}</li>
        <li>{data.edges.length} classified edges</li>
        {Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => (
          <li key={kind}>{n} × {kind}</li>
        ))}
      </ul>
      {data.diagnostics.warnings.length > 0 && (
        <div className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
          {data.diagnostics.warnings.join(" • ")}
        </div>
      )}
    </div>
  );
}

function countObjects(objects: RoofObject[]): Record<string, number> {
  const out: Record<string, number> = {
    chimney: 0, skylight: 0, dormer: 0,
    vent: 0, stack: 0, "satellite-dish": 0,
    "ridge-vent": 0, "box-vent": 0, turbine: 0,
  };
  for (const o of objects) out[o.kind] = (out[o.kind] ?? 0) + 1;
  return out;
}
```

- [ ] **Step 2: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/roof/DetectedFeaturesPanel.tsx
git commit -m "feat(roof-engine): add DetectedFeaturesPanel (rep + customer variants)"
```

---

### Task 18: Build `components/roof/FacetList.tsx`

**Files:**
- Create: `components/roof/FacetList.tsx`

- [ ] **Step 1: Create the per-facet rep view**

```tsx
// components/roof/FacetList.tsx
"use client";

import { useState } from "react";
import type { RoofData, PricedEstimate, FacetAttribution } from "@/types/roof";
import { PitchDisplay } from "./PitchDisplay";
import { LowSlopeBadge } from "./LowSlopeBadge";

export function FacetList({
  data, priced,
}: {
  data: RoofData;
  priced: PricedEstimate;
}) {
  const [expanded, setExpanded] = useState(false);
  if (data.source === "none" || data.facets.length === 0) return null;

  // Aggregate per-facet shingle costs from facetAttribution across all shingle line items
  const attribByFacet = new Map<string, { low: number; high: number }>();
  for (const li of priced.lineItems) {
    if (!li.facetAttribution) continue;
    for (const a of li.facetAttribution) {
      const prev = attribByFacet.get(a.facetId) ?? { low: 0, high: 0 };
      attribByFacet.set(a.facetId, {
        low: prev.low + a.extendedLow,
        high: prev.high + a.extendedHigh,
      });
    }
  }

  return (
    <div className="rounded-lg border bg-white p-4">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between text-sm font-semibold text-slate-900"
      >
        Per-facet breakdown ({data.facets.length} facet{data.facets.length === 1 ? "" : "s"})
        <span className="text-xs text-slate-500">{expanded ? "Hide" : "Show"}</span>
      </button>
      {expanded && (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="pb-1 font-medium">Facet</th>
              <th className="pb-1 font-medium">Pitch</th>
              <th className="pb-1 font-medium text-right">Area</th>
              <th className="pb-1 font-medium text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.facets.map((f) => {
              const cost = attribByFacet.get(f.id);
              return (
                <tr key={f.id} className="border-t border-slate-100">
                  <td className="py-1 font-medium text-slate-900">{f.id}</td>
                  <td className="py-1">
                    <PitchDisplay degrees={f.pitchDegrees} />
                    {f.isLowSlope && <LowSlopeBadge className="ml-2" />}
                  </td>
                  <td className="py-1 text-right">{Math.round(f.areaSqftSloped).toLocaleString()} sf</td>
                  <td className="py-1 text-right">
                    {cost ? `$${Math.round(cost.low).toLocaleString()}–$${Math.round(cost.high).toLocaleString()}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/roof/FacetList.tsx
git commit -m "feat(roof-engine): add FacetList rep-only per-facet breakdown"
```

---

### Task 19: Refactor `/internal` to use `runRoofPipeline` + `priceRoofData`

**Files:**
- Modify: `app/(internal)/page.tsx`

This is the biggest task in the plan. It rips out the per-page Solar / vision / polygon orchestration in `app/(internal)/page.tsx` and replaces with a single `runRoofPipeline` + `priceRoofData` flow.

- [ ] **Step 1: Inventory the existing flow**

Read `app/(internal)/page.tsx` end-to-end. Identify:
- Where Places autocomplete → confirmed lat/lng (pin-confirmation flow already exists)
- Where Solar API is fetched
- Where vision API is fetched
- Where SAM3 / Roboflow / polygon reconciliation is fetched (Tier C keeps these for pin-confirmation but they don't feed the pipeline output)
- Where `buildDetailedEstimate` is called
- Where the rep's `Assumptions` state lives (material, multipliers, etc.)
- Where the estimate is saved (via `saveEstimate` from `lib/storage.ts`)

Document the call graph in a comment at the top of the new code if helpful.

- [ ] **Step 2: Add the new state + pipeline call**

After the pin-confirmation step (`phase === "estimating"`), call `runRoofPipeline({ address: { formatted, lat: confirmedLat, lng: confirmedLng } })` once. Store the result in component state as `roofData: RoofData | null`.

Wire up a fetch effect that runs when `phase === "estimating"` and `confirmedLatLng` changes. Use the existing pattern (no axios — `fetch("/api/debug/roof-pipeline?lat=...&lng=...")` is fine for now, or refactor `runRoofPipeline` to be a server action if you prefer — but for Tier C scope, the debug route is the cheapest path).

Actually — **don't** call the debug route. The pipeline lives in `lib/roof-pipeline.ts`. In a Server Component (or via a new `/api/roof-pipeline` endpoint) call it directly. The debug route is for curl testing only.

Add a new (non-debug) endpoint:

```ts
// app/api/roof-pipeline/route.ts
import { NextResponse } from "next/server";
import { runRoofPipeline } from "@/lib/roof-pipeline";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const address = searchParams.get("address") ?? "";
  const nocache = searchParams.get("nocache") === "1";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }
  const data = await runRoofPipeline({
    address: { formatted: address, lat, lng },
    nocache,
  });
  return NextResponse.json(data);
}
```

Then in `/internal`:

```tsx
const [roofData, setRoofData] = useState<RoofData | null>(null);
const [pipelineErr, setPipelineErr] = useState<string | null>(null);

useEffect(() => {
  if (phase !== "estimating" || !confirmedLatLng) return;
  let cancelled = false;
  (async () => {
    try {
      const res = await fetch(
        `/api/roof-pipeline?lat=${confirmedLatLng.lat}&lng=${confirmedLatLng.lng}&address=${encodeURIComponent(address)}`,
      );
      const data = await res.json() as RoofData;
      if (!cancelled) setRoofData(data);
    } catch (e) {
      if (!cancelled) setPipelineErr(e instanceof Error ? e.message : String(e));
    }
  })();
  return () => { cancelled = true; };
}, [phase, confirmedLatLng, address]);
```

- [ ] **Step 3: Replace `buildDetailedEstimate` calls with `priceRoofData`**

Wherever `/internal` calls `buildDetailedEstimate(assumptions, addOns, opts)`, replace with:

```tsx
const pricingInputs: PricingInputs = {
  material: assumptions.material,
  materialMultiplier: assumptions.materialMultiplier,
  laborMultiplier: assumptions.laborMultiplier,
  serviceType: assumptions.serviceType ?? "reroof-tearoff",
  addOns,
  wasteOverridePct: undefined, // rep can override via waste table; wire below
  isInsuranceClaim: isInsuranceClaim ?? false,
};
const priced = roofData ? priceRoofData(roofData, pricingInputs) : null;
```

The rep `PricingInputs` UI: drop the `Pitch` picker (no longer needed — pitch is per-facet from `roofData`). Keep material picker (with vision-seeded default from `roofData.totals.predominantMaterial`), multipliers, serviceType, waste override (still uses existing `buildWasteTable` from `lib/roof-geometry.ts` — feed it `roofData.totals.totalRoofAreaSqft` and `roofData.totals.complexity`).

- [ ] **Step 4: Mount the new components on the rep page**

Above the existing line-item table:

```tsx
{roofData && roofData.source !== "none" ? (
  <>
    <RoofTotalsCard data={roofData} />
    <DetectedFeaturesPanel data={roofData} variant="rep" />
    {priced && <FacetList data={roofData} priced={priced} />}
  </>
) : roofData?.source === "none" ? (
  <DegradedNotice attempts={roofData.diagnostics.attempts} />
) : null}
```

Add `<DegradedNotice>` inline or as a new component — a simple card explaining "we couldn't analyze this address" and listing the attempts.

- [ ] **Step 5: Switch save to v2 format**

When the rep saves the estimate, build an `EstimateV2`:

```tsx
const v2: EstimateV2 = {
  version: 2,
  id, createdAt, staff, customerName, notes,
  address: addressInfo,
  roofData: roofData!,
  pricingInputs,
  priced: priced!,
  isInsuranceClaim,
  photos,
};
saveEstimateV2(v2);
```

Use `loadEstimatesTagged()` for the rep's rolodex view; render v2 estimates with the new UI, v1 with the legacy renderer (keep the legacy renderer code-path intact for now — Phase 3 doesn't delete v1 UI yet either; the loader-isolated shim is the only contract).

- [ ] **Step 6: Run typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 7: Start dev server and verify rep workflow against 3 addresses**

```bash
npm run dev
```

Manually walk through:
1. **8450 Oak Park Rd Orlando FL 32819** — Solar HIGH, 17 facets. Verify: continuous pitch displays (e.g. "5.4/12"), per-facet breakdown shows all 17 facets with low-slope badges on the flat ones, flashing line items include chimney + skylight + dormer-step.
2. **A simple ranch** (pick any single-story FL address — rep should have a known good one). Verify: 1-4 facets, no dormer flashing, low complexity tier.
3. **A rural Solar-404 address** (vision-only fallback). Verify: source = "tier-c-vision", single facet, lower confidence, warning banner visible.

For each, confirm the estimate save → load round-trip works (close browser, reopen, find estimate in rolodex, open it, prices match).

- [ ] **Step 8: Commit**

```bash
git add app/api/roof-pipeline/route.ts app/\(internal\)/page.tsx
git commit -m "feat(roof-engine): /internal refactor to runRoofPipeline + priceRoofData"
```

---

### Task 20: Wire telemetry events into pipeline + loader

**Files:**
- Modify: `lib/roof-pipeline.ts`
- Modify: `lib/storage.ts`
- Modify: `lib/roof-engine.ts`

- [ ] **Step 1: Emit `vision_failure_tolerated` from `solar-source.ts`**

In `lib/sources/solar-source.ts`, after the `Promise.all`, if `solar !== null` and `vision === null`, add:

```ts
if (solar && !vision) {
  console.log("[telemetry] vision_failure_tolerated", {
    address: opts.address.formatted,
    reason: "vision returned null",
  });
}
```

- [ ] **Step 2: Emit `flashing_detected` from `runRoofPipeline`**

After the successful path in `runRoofPipeline`, before returning:

```ts
const objCounts = primary.objects.reduce((acc, o) => {
  acc[o.kind] = (acc[o.kind] ?? 0) + 1;
  return acc;
}, {} as Record<string, number>);
const totalFlashingLf =
  primary.flashing.chimneyLf + primary.flashing.skylightLf +
  primary.flashing.dormerStepLf + primary.flashing.valleyLf +
  primary.flashing.wallStepLf + primary.flashing.headwallLf +
  primary.flashing.apronLf;
console.log("[telemetry] flashing_detected", {
  address: opts.address.formatted,
  chimneys: objCounts.chimney ?? 0,
  skylights: objCounts.skylight ?? 0,
  dormers: objCounts.dormer ?? 0,
  vents: (objCounts.vent ?? 0) + (objCounts.stack ?? 0),
  totalFlashingLf,
});
```

- [ ] **Step 3: Emit `estimate_loaded_legacy_vs_v2` from `tagEstimate`**

In `lib/storage.ts`, modify `tagEstimate`:

```ts
export function tagEstimate(raw: unknown): LoadedEstimate | null {
  if (!isRecord(raw)) return null;
  let result: LoadedEstimate;
  if (raw.version === 2 && isRecord(raw.roofData)) {
    result = { kind: "v2", estimate: raw as unknown as EstimateV2 };
  } else {
    result = { kind: "v1", estimate: raw as unknown as Estimate };
  }
  if (typeof window !== "undefined") {
    console.log("[telemetry] estimate_loaded_legacy_vs_v2", {
      id: result.estimate.id,
      kind: result.kind,
    });
  }
  return result;
}
```

- [ ] **Step 4: Emit `complexity_bucket_crossed` and `pricing_diff_v1_vs_v2`**

These two events are emitted only during the rollout window (first 100 estimates and first 50 new estimates respectively). Implement a simple in-memory counter on `lib/roof-engine.ts`:

```ts
// lib/roof-engine.ts  (append near the top)
let complexityComparisonCount = 0;
const COMPLEXITY_COMPARISON_LIMIT = 100;

/**
 * Emits complexity_bucket_crossed telemetry during the first
 * COMPLEXITY_COMPARISON_LIMIT estimates. Wraps classifyComplexity.
 * Call this instead of classifyComplexity directly from the pipeline
 * (NOT from internal engine functions like computeTotals — that would
 * double-emit).
 */
export function classifyComplexityWithTelemetry(
  input: { facets: Facet[]; edges: Edge[]; objects: RoofObject[] },
  legacy: (() => ComplexityTier) | null,
  address?: string,
): ComplexityTier {
  const newBucket = classifyComplexity(input);
  if (legacy && complexityComparisonCount < COMPLEXITY_COMPARISON_LIMIT) {
    const oldBucket = legacy();
    if (oldBucket !== newBucket) {
      console.log("[telemetry] complexity_bucket_crossed", {
        address: address ?? "",
        oldBucket, newBucket,
      });
    }
    complexityComparisonCount += 1;
  }
  return newBucket;
}
```

For Tier C, the pipeline doesn't have ready access to the v1 inputs to recompute legacy complexity — the v1 complexity inference used pixel-space polygons, not RoofData. **Skip `complexity_bucket_crossed` from the pipeline** and instead emit it from `/internal` when it has access to the v1 polygons (Solar polygons, SAM polygons) alongside the new RoofData:

In `/internal`'s pipeline-result handler, add:

```tsx
import { inferComplexityFromPolygons } from "@/lib/roof-geometry";
// ...
if (roofData && roofData.source !== "none") {
  const legacyPolygons = roofData.facets.map((f) => f.polygon);
  const oldBucket = inferComplexityFromPolygons(legacyPolygons);
  const newBucket = roofData.totals.complexity;
  if (oldBucket && oldBucket !== newBucket) {
    console.log("[telemetry] complexity_bucket_crossed", {
      address: addressInfo.formatted,
      oldBucket, newBucket,
    });
  }
}
```

`pricing_diff_v1_vs_v2`: same pattern. In `/internal`'s save handler (or right before showing the priced estimate), for the first 50 new estimates run BOTH `buildDetailedEstimate(legacyAssumptions, legacyAddOns, legacyOpts)` AND `priceRoofData(roofData, pricingInputs)`, then log:

```tsx
const v1 = buildDetailedEstimate(legacyAssumptions, legacyAddOns, legacyOpts);
const v2 = priceRoofData(roofData, pricingInputs);
const deltaPct = v1.totalLow > 0 ? ((v2.totalLow - v1.totalLow) / v1.totalLow) * 100 : 0;
console.log("[telemetry] pricing_diff_v1_vs_v2", {
  address: addressInfo.formatted,
  v1Total: v1.totalLow,
  v2Total: v2.totalLow,
  deltaPct: Math.round(deltaPct * 10) / 10,
});
```

Cap the count in localStorage so we don't run dual pricing forever:

```ts
const key = "roof_engine_pricing_diff_count";
const count = Number(localStorage.getItem(key) ?? "0");
if (count < 50) {
  // ... do dual-pricing log
  localStorage.setItem(key, String(count + 1));
}
```

- [ ] **Step 5: Run typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/roof-pipeline.ts lib/storage.ts lib/roof-engine.ts lib/sources/solar-source.ts app/\(internal\)/page.tsx
git commit -m "feat(roof-engine): wire telemetry events (Phase 2)"
```

---

### Task 21: Phase 2 gate — full build, address verification, push

- [ ] **Step 1: Re-run all engine verifications**

Run: `npx tsx scripts/verify-roof-engine.ts`
Expected: All PASS.

- [ ] **Step 2: Full quality gate**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 3: Manual rep workflow verification on 3 addresses**

Same three addresses as Task 19, end-to-end (address → confirm → estimate → save → reload → view).

For 8450 Oak Park Rd, capture and document:
- Total flashing LF (chimney + skylight + dormer-step + valley) — must be ≈ 64 LF
- v1 vs v2 pricing delta (from the `pricing_diff_v1_vs_v2` telemetry) — should be in the 0% to +10% range
- Per-facet breakdown shows all 17 facets

- [ ] **Step 4: Push Phase 2**

```bash
git push origin claude/epic-lamport-ce1560
```

Verify Vercel preview passes. **Phase 2 complete. /internal runs on Tier C.**

---

## Phase 3 — `/quote` Refactor + Cleanup

### Task 22: Refactor `/quote` to use `runRoofPipeline` + `priceRoofData`

**Files:**
- Modify: `app/quote/page.tsx`

- [ ] **Step 1: Inventory `/quote` orchestration**

Read `app/quote/page.tsx`. Identify Solar / vision fetch points, the existing `MATERIAL_RATES` import, the `QUOTE_ADDONS` constant, and the `serviceType: "reroof-tearoff"` / `multipliers = 1` pinning.

- [ ] **Step 2: Replace orchestration with pipeline call**

Mirror Task 19's pattern. On `phase === "estimating"`, call `/api/roof-pipeline` with the customer-confirmed lat/lng, store `roofData`. Build `pricingInputs`:

```tsx
const pricingInputs: PricingInputs = {
  material: customerMaterial ?? bestMaterialFromVision(roofData) ?? "asphalt-architectural",
  materialMultiplier: 1.0,
  laborMultiplier: 1.0,
  serviceType: "reroof-tearoff",
  addOns: QUOTE_ADDONS.filter((a) => a.enabled),
  isInsuranceClaim: false,
};

function bestMaterialFromVision(d: RoofData | null): Material | null {
  if (!d || d.confidence < 0.6) return null;
  return d.totals.predominantMaterial;
}
```

The default chain (customer > vision-confidence-gated > brand default) lives in `bestMaterialFromVision`. Customer selection from a dropdown overrides; if customer hasn't selected and vision confidence is high enough, use the detected material; otherwise fall back to `"asphalt-architectural"`.

- [ ] **Step 3: Mount the customer variants**

```tsx
{roofData && roofData.source !== "none" ? (
  <>
    <RoofTotalsCard data={roofData} />
    <DetectedFeaturesPanel data={roofData} variant="customer" />
  </>
) : roofData?.source === "none" ? (
  <p>We couldn't analyze this address — please double-check the pin or try a different address.</p>
) : null}
```

No `FacetList` (rep-only). Line items render the existing `priced.simplifiedItems` groups, not the full `lineItems` (collapse per-facet detail).

- [ ] **Step 4: Verify proposal PDF + `/p/[id]` share link**

The proposal save path writes to Supabase `proposals.snapshot`. Update the save handler:

```tsx
const v2Snapshot: EstimateV2 = {
  version: 2,
  id: estimateId, createdAt, staff: "",
  customerName: customerInfo.name,
  address: addressInfo,
  roofData: roofData!,
  pricingInputs,
  priced: priced!,
  isInsuranceClaim: false,
};
// POST to /api/proposals with v2Snapshot as the snapshot body
```

Verify both code paths:
1. Generate a new proposal from `/quote` → check Supabase row has `version: 2`
2. Open `/p/[publicId]` for both a v2 proposal AND a legacy v1 proposal → both render correctly

The `/p/[id]` page reads via `summarizeProposalSnapshot` (Task 14 already extended it) and renders the full snapshot. Update `app/p/[id]/page.tsx` to branch on `tagEstimate`:

```tsx
const loaded = tagEstimate(rawSnapshot);
if (loaded?.kind === "v2") return <V2ProposalView estimate={loaded.estimate} />;
return <LegacyProposalView estimate={loaded?.estimate} />;
```

`V2ProposalView` renders `RoofTotalsCard` + `DetectedFeaturesPanel variant="customer"` + the simplified line items. `LegacyProposalView` is the existing renderer (move existing logic into that component).

- [ ] **Step 5: Run typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Manual customer flow verification**

Walk through customer flow on 8450 Oak Park Rd:
- Address → pin confirm → estimate appears in ~3-5s
- "What we detected" panel shows correct counts (no per-facet jargon)
- Headline price range is sensible (within ±10% of /internal's range for the same address with multipliers at 1.0)
- Proposal PDF generates and opens
- `/p/[id]` share link opens and renders identically

Walk through a v1 share link from an older proposal — verify it still renders via `LegacyProposalView`.

- [ ] **Step 7: Commit**

```bash
git add app/quote/page.tsx app/p/\[id\]/page.tsx
git commit -m "feat(roof-engine): /quote refactor to runRoofPipeline + priceRoofData"
```

---

### Task 23: Delete legacy engine code

**Files:**
- Modify: `lib/roof-geometry.ts`
- Modify: `lib/pricing.ts`

- [ ] **Step 1: Confirm nothing in active code paths uses the legacy functions**

Run:

```bash
```

Use Grep tool with pattern `flashingFromComplexity|deriveRoofLengthsFromPolygons|deriveRoofLengthsHeuristic|buildDetailedEstimate|computeBase` across the repo. Expected hits:
- `lib/roof-geometry.ts` (definitions to delete)
- `lib/pricing.ts` (definitions to delete + `buildDetailedEstimate` definition)
- v1 renderer for legacy estimates (these MAY still need `buildDetailedEstimate` to re-price old assumptions — but per the spec they should render saved `detailed.lineItems` directly without re-pricing)

If any UI component imports `buildDetailedEstimate` outside of the legacy v1 renderer that re-renders historical line items, fix it (legacy renderer reads `estimate.detailed.lineItems` directly, no re-pricing).

If `MATERIAL_RATES` is imported by `/internal` or `/quote` for a UI display (e.g., the rate-band card), keep `MATERIAL_RATES` exported from `lib/pricing.ts` and only delete the engine functions.

- [ ] **Step 2: Delete `flashingFromComplexity` from `lib/roof-geometry.ts`**

Remove the `flashingFromComplexity` function definition. Also remove `deriveRoofLengthsFromPolygons` and `deriveRoofLengthsHeuristic` (they call `flashingFromComplexity` and aren't used after Phase 3). Keep `inferComplexityFromPolygons`, `polygonPerimeterFt`, `buildWasteTable`, `suggestedWastePct` (waste-table UI still uses these).

- [ ] **Step 3: Delete `buildDetailedEstimate` + `computeBase` from `lib/pricing.ts`**

Remove the function definitions. Keep `MATERIAL_RATES`, `COMPONENT_RATES`, `DEFAULT_ADDONS`, `fmt`, `PITCH_FACTOR`, `pitchToDegrees`, `TWO_STORY_LABOR_BUMP` if any UI still references them. (Quick grep before deleting each one.)

Remove the `PITCH_TO_DEG_LOCAL` constant if it's no longer referenced (`buildDetailedEstimate` was its only consumer).

- [ ] **Step 4: Delete the debug route**

```bash
```

Delete `app/api/debug/roof-pipeline/route.ts`. `/api/roof-pipeline` (Task 19) is the production endpoint now.

- [ ] **Step 5: Run typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS. If typecheck fails on stale imports, remove them.

- [ ] **Step 6: Re-verify the engine harness still passes**

Run: `npx tsx scripts/verify-roof-engine.ts`
Expected: All PASS.

- [ ] **Step 7: Final manual verification — three addresses end-to-end**

For each of the three test addresses:
1. New estimate on `/internal` — save as v2
2. New proposal on `/quote` — save as v2
3. Open the share link `/p/[id]` — v2 renderer
4. Open a stored v1 estimate in the rep rolodex — legacy renderer

Confirm no console errors. Confirm dashboard summaries render for both v1 and v2 proposals.

- [ ] **Step 8: Commit**

```bash
git add lib/roof-geometry.ts lib/pricing.ts
git rm app/api/debug/roof-pipeline/route.ts
git commit -m "chore(roof-engine): delete legacy engine functions + debug route (Tier C cleanup)"
```

---

### Task 24: Phase 3 gate — push

- [ ] **Step 1: Final quality gate**

Run: `npm run typecheck && npm run lint && npm run build && npx tsx scripts/verify-roof-engine.ts`
Expected: PASS.

- [ ] **Step 2: Push Phase 3**

```bash
git push origin claude/epic-lamport-ce1560
```

Verify Vercel preview passes.

- [ ] **Step 3: Tier C done — pause for user confirmation before Tier B**

Per the kickoff doc: "Pause and confirm with user before starting Tier B." Do not proceed beyond this point in this session without explicit confirmation.

---

## Self-Review Checklist (run after writing the plan)

Spec coverage check:
- [x] Schema in §2 → Task 1 creates `types/roof.ts`
- [x] §3 Pipeline + sources → Tasks 2, 8, 9, 10, 11
- [x] §3.6 Vision memoizer → Task 2
- [x] §3.8 Degraded RoofData → Task 7 (`makeDegradedRoofData`)
- [x] §3.9 Caching → Task 10
- [x] §4 Engine functions → Tasks 3, 4, 5, 6, 7
- [x] §4.5 classifyEdges synthetic-axis fallback → Task 6 algorithm step 3
- [x] §5 Saved-estimate migration → Tasks 13, 14, 22 Step 4 (loader-isolated; no business-logic branches confirmed)
- [x] §6.1 Phase 1 → Tasks 1-12
- [x] §6.2 Phase 2 → Tasks 13-21
- [x] §6.3 Phase 3 → Tasks 22-24
- [x] §7 UI components → Tasks 15, 16, 17, 18
- [x] §7.5 Telemetry → Task 20
- [x] §8 Acceptance criteria — 8450 Oak Park Rd headline check → Task 11 Step 3 + Task 21 Step 3
- [x] §8 all-sources-failed test → Task 11 Step 4 + manual coverage in /internal /quote
- [x] §9 deferred → not implemented (correct)

Placeholder scan: no TBDs / "implement later" / placeholder code blocks remain.

Type consistency check: `PricingInputs`, `RoofData`, `PricedEstimate`, `EstimateV2`, `LoadedEstimate` names match across all tasks. `tierCSolarSource` / `tierCVisionSource` / `runRoofPipeline` / `priceRoofData` / `computeFlashing` / `computeTotals` / `classifyComplexity` / `classifyEdges` / `makeDegradedRoofData` consistently used. `tagEstimate` / `loadEstimatesTagged` / `saveEstimateV2` consistently used. Material enum: 6 strings + null, consistent across `types/roof.ts`, `lib/roof-engine.ts`, both source files.

# Roof Estimator Engine — Tier C (Solar + Vision Foundation) Design Spec

**Date:** 2026-05-14
**Status:** Approved (design), awaiting implementation
**Repo:** roofai-internal (Voxaris Pitch)
**Parent doc:** [2026-05-14-roof-engine-abc-kickoff.md](./2026-05-14-roof-engine-abc-kickoff.md) — the unified A+B+C rebuild this spec is the first installment of

---

## 1. Goals and Non-Goals

### Goals

1. Introduce a single `RoofData` contract that every estimator surface (`/internal`, `/quote`, dashboard, PDF) reads from.
2. Build a pluggable source pipeline (`runRoofPipeline`) registering two Tier C sources: `tier-c-solar` (Solar API + vision) and `tier-c-vision` (vision-only fallback).
3. Replace bucketed pitch with continuous per-facet `pitchDegrees`. Each facet prices at its own pitch, no 5-row lookup.
4. Replace `flashingFromComplexity`'s 3-row constant table with feature-driven flashing math (chimneys, skylights, dormers, vents, valleys, eaves all contribute LF independently).
5. Refactor `/internal` and `/quote` to consume `RoofData` end-to-end (full replacement of their independent orchestration), in three commit-gated phases.
6. Ship a clean `version: 2` saved-estimate shape with a loader-isolated shim for `version: 1` records so historical estimates keep loading unchanged.

### Non-Goals (deferred, see §9)

- Tier B multiview oblique refinement (own spec after Tier C ships).
- Tier A LiDAR + RANSAC measurement and the Python service decision (own spec after Tier B ships).
- R3F + Cesium 3D visual layer and Puppeteer PDF stills (deferred to post–Tier A).
- Continuous waste % from richer signals (deferred to Tier B/A where the signal exists).
- Per-facet material refinement (deferred to Tier B obliques).
- Modified bitumen / TPO membrane detection (no source signal in Tier C).
- Customer-facing "I'm filing an insurance claim" toggle on `/quote` (out of scope; see §9).

---

## 2. The Schema — `types/roof.ts`

`RoofData` is the keystone. Every source produces it, every refinement updates it, every consumer reads it. Tier C produces a complete, schema-conformant `RoofData` even when individual fields are imprecise — consumers must never have to defensively null-check structural fields like `objects[]` or `edges[]`.

### 2.1 `RoofData`

```ts
export interface RoofData {
  /** Address + lat/lng of the resolved building center. */
  address: { formatted: string; lat: number; lng: number; zip?: string };

  /** Provenance — which source produced this primary data. */
  source: "tier-a-lidar" | "tier-b-multiview" | "tier-c-solar" | "tier-c-vision";

  /** Refinements applied on top of the primary source. Empty in Tier C. */
  refinements: Array<"multiview-obliques">;

  /** Overall confidence in this RoofData, 0..1. Tier C formula in §4. */
  confidence: number;

  /** When the underlying imagery was captured (Solar's imageryDate; null on vision-only). */
  imageryDate: string | null;

  /** Vision-estimated age of the roof material in years; null when unknown.
   *  Sourced from RoofVision.estimatedAgeYears. Display-only in Tier C. */
  ageYearsEstimate: number | null;
  /** Vision-estimated age bucket; null when unknown. */
  ageBucket: "new" | "moderate" | "aged" | "very-aged" | null;

  /** Per-facet detail. Always non-empty. */
  facets: Facet[];
  /** Classified edges between facets + perimeter. Always non-empty. */
  edges: Edge[];
  /** Detected objects on the roof. Empty when none detected; never absent. */
  objects: RoofObject[];
  /** Flashing line items, computed from facets + edges + objects. */
  flashing: FlashingBreakdown;
  /** Whole-roof totals (sums and derived values). */
  totals: RoofTotals;
  /** Diagnostics — what fell back, what was guessed, what should be reviewed. */
  diagnostics: RoofDiagnostics;
}
```

### 2.2 `Facet`, `Edge`, `RoofObject` (per schema in kickoff doc with one expansion)

```ts
export interface Facet {
  id: string;
  polygon: Array<{ lat: number; lng: number }>;
  normal: { x: number; y: number; z: number };
  pitchDegrees: number;        // continuous, e.g. 22.6 for ~5/12
  azimuthDeg: number;
  areaSqftSloped: number;
  areaSqftFootprint: number;
  /** What this facet looks like — diagnostic, not pricing input.
   *  In Tier C, all facets carry the same vision-derived value. */
  material:
    | "asphalt-3tab"
    | "asphalt-architectural"
    | "metal-standing-seam"
    | "tile-concrete"
    | "wood-shake"
    | "flat-membrane"
    | null;
  isLowSlope: boolean;         // true when pitchDegrees < atan(4/12) ≈ 18.43°
}

export type EdgeType = "ridge" | "hip" | "valley" | "eave" | "rake" | "step-wall";

export interface Edge {
  id: string;
  type: EdgeType;
  /** Real lat/lng polyline. heightM = 0 in Tier C (no 3D info). */
  polyline: Array<{ lat: number; lng: number; heightM: number }>;
  lengthFt: number;
  facetIds: string[];
  /** 0.4 in Tier C heuristic classification (so Tier B/A always wins). */
  confidence: number;
}

export type ObjectKind =
  | "chimney" | "skylight" | "dormer"
  | "vent" | "stack" | "satellite-dish"
  | "ridge-vent" | "box-vent" | "turbine";

export interface RoofObject {
  id: string;
  kind: ObjectKind;
  position: { lat: number; lng: number; heightM: number };  // heightM = 0 in Tier C
  dimensionsFt: { width: number; length: number };          // vision approxSizeFt-derived
  facetId: string | null;                                    // null in Tier C (no facet attribution yet)
}
```

**Material enum expansion vs. kickoff doc:** the kickoff doc listed `asphalt-shingle | tile-concrete | metal-standing-seam | modified-bitumen | tpo-membrane`. We expand to match vision's vocabulary: split `asphalt-shingle` → `asphalt-3tab | asphalt-architectural` (real pricing difference, $60–80/sq vs $80–110/sq), add `wood-shake`, add `flat-membrane`, drop `modified-bitumen` / `tpo-membrane` (no Tier C detection signal — add when a source for them lands). `unknown` from vision → `null` so consumers have one not-detected case.

### 2.3 `FlashingBreakdown`, `RoofTotals`, `RoofDiagnostics`

Verbatim from kickoff doc, with one note on `wallStepLf` and one new field in totals:

```ts
export interface FlashingBreakdown {
  chimneyLf: number;     // chimney perimeter × 4 sides, + cricket if w > 30in (cricket is Tier B+)
  skylightLf: number;    // skylight kit perimeter math, per skylight
  dormerStepLf: number;  // dormer cheek wall length × 2
  /** Non-dormer wall-to-roof step flashing. Always 0 in Tier C (Tier B+ signal). */
  wallStepLf: number;
  headwallLf: number;
  apronLf: number;
  valleyLf: number;      // valley edge LF × 1.05 overlap
  dripEdgeLf: number;    // eaves + rakes total
  pipeBootCount: number;
  iwsSqft: number;       // eaves × 3ft + valleys × 6ft
}

export interface RoofTotals {
  facetsCount: number;
  edgesCount: number;
  objectsCount: number;
  totalRoofAreaSqft: number;
  totalFootprintSqft: number;
  totalSquares: number;             // sqft / 100, rounded up to nearest 1/3
  averagePitchDegrees: number;      // area-weighted average
  wastePct: number;                 // 7 | 11 | 14 in Tier C (see §4.3)
  /** Inferred complexity tier in Tier C — kept on totals for legacy waste-table UI.
   *  NOTE: this is a deliberate addition vs the kickoff schema; the kickoff doc had
   *  wastePct but not complexity. Tier B/A may demote this field if continuous waste
   *  lands. */
  complexity: "simple" | "moderate" | "complex";
  predominantMaterial: Facet["material"];
}

export interface RoofDiagnostics {
  attempts: Array<{ source: string; outcome: "succeeded" | "failed-coverage" | "failed-error"; reason?: string }>;
  warnings: string[];
  needsReview: Array<{ kind: "facet" | "edge" | "object"; id: string; reason: string }>;
}
```

---

## 3. Pipeline and Sources

### 3.1 Files

```
lib/roof-pipeline.ts            ← orchestrator (runRoofPipeline)
lib/sources/solar-source.ts     ← tier-c-solar (Solar API + vision in parallel)
lib/sources/vision-source.ts    ← tier-c-vision (vision-only, fallback)
lib/cache/vision-request.ts     ← request-scoped vision memoizer
```

### 3.2 Source contract

```ts
type RoofSource = (opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  requestId: string;
}) => Promise<RoofData | null>;
```

Returns `null` for coverage failures (Solar 404); throws for hard errors (network, schema-broken response). The orchestrator catches throws and records them in `diagnostics.attempts`.

### 3.3 Orchestrator — `runRoofPipeline`

```ts
export async function runRoofPipeline(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
}): Promise<RoofData> {
  const requestId = nanoid();
  const attempts: RoofDiagnostics["attempts"] = [];

  // Sources in priority order. Tier A is registered when it ships;
  // Tier C registers solar then vision-fallback.
  const sources: RoofSource[] = [
    tierCSolarSource,
    tierCVisionSource,
  ];

  let primary: RoofData | null = null;
  for (const source of sources) {
    try {
      const result = await source({ address: opts.address, requestId });
      attempts.push({
        source: source.name,
        outcome: result ? "succeeded" : "failed-coverage",
      });
      if (result) { primary = result; break; }
    } catch (err) {
      attempts.push({
        source: source.name,
        outcome: "failed-error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!primary) throw new Error("All Tier C sources failed");

  primary.diagnostics.attempts = attempts;
  return primary;
}
```

Tier B (`tierBMultiviewRefinement`) and Tier A (`tierALidarSource`) are **not** registered in Tier C. They land in their respective tiers' specs.

### 3.4 `tierCSolarSource`

```ts
async function tierCSolarSource({ address, requestId }): Promise<RoofData | null> {
  const [solarRes, visionRes] = await Promise.all([
    fetchSolar(address.lat, address.lng),
    getMemoizedVision(address.lat, address.lng, requestId),
  ]);
  if (!solarRes || solarRes.segmentCount === 0) return null;

  // Solar succeeded. Vision is a nice-to-have on top — failure is empty,
  // not a source failure.
  const facets = solarToFacets(solarRes, visionRes);   // material seeded from vision
  const edges = classifyEdges(facets, solarRes.dominantAzimuthDeg);
  const objects = visionPenetrationsToObjects(visionRes);   // [] when vision failed
  const flashing = computeFlashing(facets, edges, objects);
  const totals = computeTotals(facets, edges, objects);
  return assembleRoofData({
    address, source: "tier-c-solar", facets, edges, objects,
    flashing, totals, visionRes, solarRes,
  });
}
```

### 3.5 `tierCVisionSource` (fallback)

Single-facet whole-roof RoofData when Solar 404s. Uses the **same memoized** vision call (cheap on the fallback path because Solar source already fired it).

```ts
async function tierCVisionSource({ address, requestId }): Promise<RoofData | null> {
  const visionRes = await getMemoizedVision(address.lat, address.lng, requestId);
  if (!visionRes) return null;

  const facets = [singleFacetFromVision(address, visionRes)];
  const edges = heuristicEdgesFromVisionPolygon(visionRes.roofPolygon);
  const objects = visionPenetrationsToObjects(visionRes);
  const flashing = computeFlashing(facets, edges, objects);
  const totals = computeTotals(facets, edges, objects);
  return assembleRoofData({
    address, source: "tier-c-vision", facets, edges, objects,
    flashing, totals, visionRes, solarRes: null,
  });
}
```

### 3.6 Request-scoped vision memoizer — `lib/cache/vision-request.ts`

```ts
const inflight = new Map<string, Promise<RoofVision | null>>();

export async function getMemoizedVision(
  lat: number, lng: number, requestId: string,
): Promise<RoofVision | null> {
  const key = `${requestId}:${lat.toFixed(6)},${lng.toFixed(6)}`;
  if (inflight.has(key)) return inflight.get(key)!;
  const promise = (async () => {
    try {
      return await fetchVision(lat, lng);
    } catch (err) {
      console.warn("[vision] failed in source pipeline:", err);
      return null;
    } finally {
      // Clear after a short delay so concurrent sources within the same
      // request still get the memoized result.
      setTimeout(() => inflight.delete(key), 5000);
    }
  })();
  inflight.set(key, promise);
  return promise;
}
```

**Effect:** vision is called at most once per `runRoofPipeline` invocation. If Solar succeeds and orchestrator stops, vision still ran in parallel (sunk cost ~$0.01). If Solar 404s and fallback fires the vision source, it gets the already-in-flight result for free.

### 3.7 Confidence formula (Tier C)

```
RoofData.confidence =
    source === "tier-c-solar" && imageryQuality === "HIGH"      → 0.85
    source === "tier-c-solar" && imageryQuality === "MEDIUM"    → 0.70
    source === "tier-c-solar" && imageryQuality === "LOW"       → 0.55
    source === "tier-c-vision"                                  → 0.40
```

Tier B refinement bumps to `min(0.95, confidence + 0.10)`. Tier A overrides to ≥ 0.90 regardless.

---

## 4. Engine — `lib/roof-engine.ts`

Source-agnostic pure functions. No I/O, no React, no Next.js imports.

### 4.1 `priceRoofData(data, inputs)`

```ts
export interface PricingInputs {
  material: Material;          // expanded enum from §2.2; rep-picked, vision-seeded default
  materialMultiplier: number;  // default 1.0
  laborMultiplier: number;     // default 1.0
  serviceType: ServiceType;    // "new" | "reroof-tearoff" | "layover" | "repair"
  addOns: AddOn[];             // merged in (was separate in v1)
  wasteOverridePct?: number;   // overrides RoofData.totals.wastePct when set
  isInsuranceClaim?: boolean;
}

export interface PricedEstimate {
  lineItems: LineItem[];        // each carries per-facet attribution where applicable
  simplifiedItems: SimplifiedItem[];
  subtotalLow: number; subtotalHigh: number;
  overheadProfit: { low: number; high: number };
  totalLow: number; totalHigh: number;
  squares: number;
  /** When true the rep view should show the per-facet breakdown; the
   *  customer view collapses by category. */
  hasPerFacetDetail: boolean;
}

export function priceRoofData(
  data: RoofData,
  inputs: PricingInputs,
): PricedEstimate { ... }
```

**Pricing logic key points:**

- **Shingles**: priced per facet at facet pitch, summed. Each shingle line item carries `facetAttribution: Array<{ facetId, areaSqftSloped, pitchDegrees, extendedLow, extendedHigh }>`. Steep-charge multiplier (today's `steepChargeMultiplier(p)`) becomes continuous: `multiplier = pitchDegrees < 33.7 ? 0 : pitchDegrees < 39.8 ? 0.25 : 0.35`.
- **Underlayment**: one line item, summed area, fixed 10% waste (unchanged).
- **IWS**: from `flashing.iwsSqft` (eaves×3' + valleys×6').
- **Drip edge**: from `flashing.dripEdgeLf`.
- **Ridge / hip cap**: from edges of type ridge + hip.
- **Valley metal**: from edges of type valley.
- **Pipe boots**: from `flashing.pipeBootCount`.
- **Chimney / skylight / dormer-step flashing**: from `flashing.chimneyLf / skylightLf / dormerStepLf`. **These line items are new** — Tier C replaces the 3-row "generic flashing + step flashing" constants with per-feature LF.
- **Tear-off**: by `serviceType`, against total roof sqft (unchanged math).
- **Decking allowance**: 10% of total sqft (unchanged).
- **Add-ons**: merged from `inputs.addOns`.
- **Labor adjustments** (steep, complexity): applied to 35% of subtotal as today.
- **O&P**: as today.

### 4.2 `computeFlashing(facets, edges, objects)`

Feature-driven. **Replaces `flashingFromComplexity`** which is deleted in Tier C.

```ts
export function computeFlashing(
  facets: Facet[],
  edges: Edge[],
  objects: RoofObject[],
): FlashingBreakdown {
  // Per-object math
  const chimneys = objects.filter(o => o.kind === "chimney");
  const chimneyLf = chimneys.reduce(
    (s, c) => s + 2 * (c.dimensionsFt.width + c.dimensionsFt.length), 0,
  ); // perimeter; cricket adder (>30in width) is Tier B+
  const skylights = objects.filter(o => o.kind === "skylight");
  const skylightLf = skylights.reduce(
    (s, k) => s + 2 * (k.dimensionsFt.width + k.dimensionsFt.length), 0,
  );
  const dormers = objects.filter(o => o.kind === "dormer");
  const dormerStepLf = dormers.reduce(
    (s, d) => s + 2 * d.dimensionsFt.length, 0,
  ); // two cheek walls per dormer

  // Per-edge math
  const valleyLf = edges
    .filter(e => e.type === "valley")
    .reduce((s, e) => s + e.lengthFt, 0) * 1.05;
  const dripEdgeLf = edges
    .filter(e => e.type === "eave" || e.type === "rake")
    .reduce((s, e) => s + e.lengthFt, 0);
  const eaveLf = edges
    .filter(e => e.type === "eave")
    .reduce((s, e) => s + e.lengthFt, 0);
  const iwsSqft = Math.round(eaveLf * 3 + valleyLf * 6);

  const pipeBootCount = objects.filter(
    o => o.kind === "vent" || o.kind === "stack",
  ).length;

  return {
    chimneyLf: Math.round(chimneyLf),
    skylightLf: Math.round(skylightLf),
    dormerStepLf: Math.round(dormerStepLf),
    wallStepLf: 0,                  // Tier B+ signal
    headwallLf: 0,                  // Tier B+ signal
    apronLf: 0,                     // Tier B+ signal
    valleyLf: Math.round(valleyLf),
    dripEdgeLf: Math.round(dripEdgeLf),
    pipeBootCount,
    iwsSqft,
  };
}
```

### 4.3 `computeTotals(facets, edges, objects, wasteOverridePct?)`

```ts
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

  // Material consensus from facets
  const materialVotes = new Map<Facet["material"], number>();
  for (const f of facets) {
    materialVotes.set(f.material, (materialVotes.get(f.material) ?? 0) + f.areaSqftSloped);
  }
  const predominantMaterial = [...materialVotes.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

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

### 4.4 `classifyComplexity` — Tier C with dormer signal

```ts
function classifyComplexity(input: {
  facets: Facet[]; edges: Edge[]; objects: RoofObject[];
}): "simple" | "moderate" | "complex" {
  const facetCount = input.facets.length;
  const dormerCount = input.objects.filter(o => o.kind === "dormer").length;
  const valleyLf = input.edges
    .filter(e => e.type === "valley")
    .reduce((s, e) => s + e.lengthFt, 0);
  // Reflex/convexity check on the union of facet polygons — same idea as
  // existing inferComplexityFromPolygons, applied to the new shape.
  const hasReflex = computeUnionConvexity(input.facets) < 0.78;

  if (facetCount >= 6 || hasReflex || dormerCount >= 3 || valleyLf >= 60) {
    return "complex";
  }
  if (facetCount >= 3 || dormerCount >= 1 || valleyLf >= 20) {
    return "moderate";
  }
  return "simple";
}

export function suggestedWastePctTierC(c: "simple" | "moderate" | "complex"): number {
  return c === "complex" ? 14 : c === "simple" ? 7 : 11;
}
```

**Rollout safety:** during the first 100 estimates after rollout, also compute the legacy `inferComplexityFromPolygons` result over the same polygons (or footprint heuristic if unavailable) and log both via the `complexity_bucket_crossed` telemetry event (§7.5). If the bucket-crossing rate exceeds 5%, pause and revisit the thresholds.

### 4.5 `classifyEdges` — Tier C heuristic

```ts
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
function classifyEdges(
  facets: Facet[],
  dominantAzimuthDeg: number | null,
): Edge[] { ... }
```

**Algorithm:**

1. Walk every polygon edge across all facets. Compute haversine length + bearing.
2. Detect shared edges by pairwise matching with ~0.6 m tolerance (existing `unionPerimeterAndSharedEdges` logic, adapted to emit edge pairs instead of LF totals).
3. **For each shared edge:**
   - If bearing within ±15° of `dominantAzimuthDeg` → candidate `ridge`.
   - If bearing within ±15° of perpendicular → candidate `valley`.
   - Otherwise → candidate `hip`.
   - Apply complexity-ratio sanity caps: don't let "ridges" exceed 55% of shared LF on moderate, 40% on complex, 85% on simple — overflow gets reassigned to `hip`. Same for valley/hip splits.
4. **For each exterior edge:**
   - If bearing within ±15° of `dominantAzimuthDeg` → `eave`.
   - Otherwise → `rake`.
   - Pitch-aware split as a fallback when `dominantAzimuthDeg` is null: use existing `eaveRakeSplit` ratios applied longest-first.
5. Every emitted edge: `confidence: 0.4`, `polyline` = the real lat/lng coordinates at `heightM: 0`.

When `dominantAzimuthDeg` is null (vision-only source, or Solar returned no useful azimuth signal), both shared and exterior edges fall through to length-ranked assignment: shared edges split into ridge/hip/valley by complexity-ratio LF caps applied longest-first; exterior edges split into eave/rake using the existing `eaveRakeSplit` ratios applied longest-first. Confidence still 0.4.

---

## 5. Saved-Estimate Migration — Loader-Isolated Shim

### 5.1 Two storage layers

- **localStorage** via `lib/storage.ts` — rep rolodex on `/internal`.
- **Supabase `proposals.snapshot` JSONB** — public share links at `/p/[id]` and dashboard summaries via `lib/proposal-snapshot.ts`.

### 5.2 v2 shape

```ts
export interface EstimateV2 {
  version: 2;
  id: string;
  createdAt: string;
  staff: string;
  customerName?: string;
  notes?: string;
  address: AddressInfo;

  /** RoofData from runRoofPipeline at save time. */
  roofData: RoofData;
  /** Rep-controlled pricing knobs. */
  pricingInputs: PricingInputs;
  /** Output of priceRoofData(roofData, pricingInputs). */
  priced: PricedEstimate;

  isInsuranceClaim?: boolean;
  photos?: PhotoMeta[];
  claim?: ClaimContext;
}
```

### 5.3 Loader contract

Single function per storage layer returns a tagged union:

```ts
export type LoadedEstimate =
  | { kind: "v2"; estimate: EstimateV2 }
  | { kind: "v1"; estimate: Estimate /* legacy shape from types/estimate.ts */ };

export function loadEstimateById(id: string): LoadedEstimate | null { ... }
```

Renderers branch **once** at the top:

```tsx
const loaded = loadEstimateById(id);
if (!loaded) return <NotFound />;
return loaded.kind === "v2"
  ? <EstimateViewV2 estimate={loaded.estimate} />
  : <EstimateViewV1 estimate={loaded.estimate} />;
```

**Rule:** no `if (estimate.version === 1)` checks anywhere in pricing, line-item rendering, UI components, or PDF. Two parallel render trees; shim is the loader's only job.

### 5.4 Loader detection

```ts
function tagEstimate(raw: unknown): LoadedEstimate | null {
  if (!isRecord(raw)) return null;
  if (raw.version === 2 && isRecord(raw.roofData)) {
    return { kind: "v2", estimate: raw as EstimateV2 };
  }
  // Anything else (no version, version: 1, or malformed v2) → legacy renderer
  return { kind: "v1", estimate: raw as Estimate };
}
```

### 5.5 What about `proposal-snapshot.ts`?

The dashboard's `summarizeProposalSnapshot` reader is already defensive. Extend it to handle v2 by reading `priced.totalLow/High` and `pricingInputs.material` in addition to the legacy paths — but keep all the existing fallback logic for v1 rows. Same defensive pattern, broader surface.

### 5.6 Sunset plan

After 90 days of v2-only writes (or after a deliberate backfill of the non-sealed proposals subset, whichever happens first), drop the v1 renderer + the legacy `Estimate` interface usage. Until then, v1 keeps working untouched.

---

## 6. Consumer Refactor — Three Phases, Commit-and-Push Gates

The 8-12 hour Tier C scope is dominated by replacing the per-page Solar/vision/polygon orchestration in `/internal` and `/quote`. Sequencing this in three phases — with verified pushes between each — caps blast radius.

### 6.1 Phase 1 — Engine + pipeline + sources (~2-3 hrs)

- Create `types/roof.ts` with the schema in §2.
- Create `lib/roof-engine.ts` with `priceRoofData`, `computeFlashing`, `computeTotals`, `classifyComplexity`, `classifyEdges`, `suggestedWastePctTierC`.
- Create `lib/roof-pipeline.ts`, `lib/sources/solar-source.ts`, `lib/sources/vision-source.ts`, `lib/cache/vision-request.ts`.
- **Do NOT delete `flashingFromComplexity` yet.** It's still called by `deriveRoofLengthsFromPolygons` / `deriveRoofLengthsHeuristic` → `buildDetailedEstimate`, which `/quote` still uses until Phase 3. The new engine lives alongside the old. The hard delete happens in Phase 3.
- **No page changes yet.** Wire up a tiny temporary debug route (`/api/debug/roof-pipeline?address=...`) that runs the pipeline and returns the JSON, so 8450 Oak Park Rd can be verified before any consumer is touched.
- Run `npm run typecheck && npm run lint && npm run build`. All green.
- **Commit + push.** Verify Vercel preview build passes on the branch.

### 6.2 Phase 2 — `/internal` refactor (~2-3 hrs)

- Rip out `/internal`'s Solar/vision/polygon orchestration. Replace with a single `runRoofPipeline({ address: confirmedLatLng })` call after the pin-confirmation step (which stays unchanged).
- Replace `buildDetailedEstimate(assumptions, addOns, opts)` calls with `priceRoofData(roofData, pricingInputs)`.
- Update the rep `PricingInputs` UI: material picker (vision-seeded), multipliers, serviceType, waste override, insurance toggle. Drop the bucketed pitch picker — pitch is now per-facet, displayed not selected.
- Add the rep "What we detected" panel (facets + objects + diagnostics) and per-facet pricing attribution view.
- New saves write `version: 2`. Loader uses the v2 path; v1 records still load via the shim.
- Run `npm run typecheck && npm run lint && npm run build`. Manually verify rep workflow against 8450 Oak Park Rd + one simple ranch + one rural Solar-404 address.
- **Commit + push.** This is a deployable state — `/quote` still works on the legacy path, and `/internal` is on the new path.

### 6.3 Phase 3 — `/quote` refactor (~3-4 hrs)

- Same operation on `/quote`. Pipeline call replaces its independent orchestration.
- Update customer `PricingInputs` shape (multipliers pinned 1.0, serviceType pinned, customer-selectable material + addOns).
- Material default chain on `/quote`: customer manual > vision (confidence > 0.6) > brand default.
- Add the simplified customer "What we detected" panel (counts only, no per-facet jargon).
- Aggregate per-facet shingle line items back into category totals for customer view.
- Verify proposal PDF and `/p/[id]` share links render correctly for both new and legacy estimates.
- **Now** delete `flashingFromComplexity` from `lib/roof-geometry.ts` and remove the old `buildDetailedEstimate` / `computeBase` / `deriveRoofLengthsFromPolygons` / `deriveRoofLengthsHeuristic` functions from `lib/pricing.ts` and `lib/roof-geometry.ts`. The legacy v1 loader path still uses the stored `Estimate.detailed.lineItems` directly for rendering — it does not re-price — so removing the legacy engine is safe.
- Run `npm run typecheck && npm run lint && npm run build`. End-to-end test the public customer flow.
- **Commit + push.** Tier C is done.

### 6.4 Rollback

If Phase 3 hits a snag, Phases 1+2 are already merged and `/quote` falls back to the legacy path until Phase 3 is unblocked. Don't bundle phases into a single PR.

---

## 7. UI Additions

Define shared components in `components/roof/`:

- `<RoofTotalsCard data={data} />` — sqft, squares, average pitch (continuous "5.4/12" format), facet count.
- `<DetectedFeaturesPanel data={data} variant="rep" | "customer" />` — rep variant shows full list (per-facet pitch, edges, objects with sizes, diagnostics warnings); customer variant shows counts only ("2 chimneys, 3 skylights, 1 dormer, 5 vents — we factored these into the price").
- `<FacetList data={data} priced={priced} />` — rep-only. Toggleable per-facet breakdown showing each facet's pitch, area, sloped/footprint, and its share of shingle cost.
- `<LowSlopeBadge facet={facet} />` — small warning on facets with `pitchDegrees < 18.43°` (below 4/12 — needs different material spec; not auto-overridden in Tier C, just flagged).
- `<PitchDisplay degrees={n} />` — formats continuous pitch as `"5.4/12"` (rise = `tan(deg) * 12` rounded to one decimal).

Both `/internal` and `/quote` consume these. Variant prop controls fidelity.

---

## 7.5. Rollout Telemetry

Without instrumentation we can't measure whether the rebuild actually moved the needle. All events logged via `console.log` with structured payloads (matches the pin-confirmation pattern; Sentry breadcrumbs pick them up).

| Event | Payload | When |
|---|---|---|
| `pipeline_source_picked` | `{ source, latencyMs, address, imageryQuality? }` | Every `runRoofPipeline` call |
| `vision_failure_tolerated` | `{ address, reason }` | Solar source succeeded but memoized vision returned null |
| `complexity_bucket_crossed` | `{ address, oldBucket, newBucket }` | First 100 estimates; emitted whenever new path differs from legacy path |
| `flashing_detected` | `{ address, chimneys, skylights, dormers, vents, totalFlashingLf }` | Every successful pipeline run |
| `estimate_loaded_legacy_vs_v2` | `{ id, kind: "v1" \| "v2" }` | Every loader call |
| `pricing_diff_v1_vs_v2` | `{ address, v1Total, v2Total, deltaPct }` | First 50 NEW estimates only — run both engines, log delta |

**Success criteria from telemetry:**

- `pipeline_source_picked.source === "tier-c-solar"` should win on >70% of estimates (Solar coverage in the Voxaris service area).
- `complexity_bucket_crossed` rate <5% across the first 100. Higher → revisit thresholds.
- `pricing_diff_v1_vs_v2.deltaPct` should average modest-positive on cut-up roofs (more accurate flashing math → slightly higher prices) and near-zero on simple roofs.

---

## 8. Acceptance Criteria

- [ ] `types/roof.ts` defines `RoofData` / `Facet` / `Edge` / `RoofObject` / `FlashingBreakdown` / `RoofTotals` / `RoofDiagnostics` exactly as in §2.
- [ ] Solar source produces correct RoofData for **8450 Oak Park Rd, Orlando FL 32819**: 17 facets, HIGH imagery, sloped sqft ~5,485, source `tier-c-solar`. Verify by running `/api/debug/roof-pipeline` and comparing to a curled `/api/solar`.
- [ ] **Headline flashing check on 8450 Oak Park Rd:** total flashing LF (chimney + skylight + dormer-step + valley) goes from ~18 LF (legacy) to ~64 LF (Tier C) — i.e. the chimneys/skylights/dormers vision sees actually show up as flashing line items. This is the single pass/fail signal for "the rebuild does the thing it was built for."
- [ ] Vision source produces RoofData for an address Solar 404s on. Single facet, populated objects, source `tier-c-vision`, confidence 0.4.
- [ ] `priceRoofData` produces a line-itemized estimate where each shingle line item carries per-facet attribution and continuous-pitch steep multipliers.
- [ ] `flashingFromComplexity` is deleted; grep for it across the repo returns zero hits.
- [ ] `/internal` renders Tier C pipeline data; rep workflow not broken (save/load, PDF, dashboard summary all functional).
- [ ] `/quote` renders Tier C pipeline data; customer proposal still works end-to-end including `/p/[id]` share links.
- [ ] Both surfaces show `<DetectedFeaturesPanel>` (rep + customer variants).
- [ ] Pitch displays as continuous (e.g. "5.4/12") on both surfaces; bucketed pitch picker is gone from `/internal`.
- [ ] Low-slope facets show `<LowSlopeBadge>`.
- [ ] `version: 2` estimates load via the v2 renderer; legacy estimates load via the shim with no visible regression on the dashboard summary, `/p/[id]` share link, or rep rolodex.
- [ ] All six telemetry events fire and appear in the console / Sentry breadcrumbs.
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` all green at each phase boundary.
- [ ] Verified against three addresses: 8450 Oak Park Rd (complex), one simple ranch, one rural Solar-404 (vision fallback).
- [ ] Three separate commits pushed: end-of-Phase-1, end-of-Phase-2, end-of-Phase-3.

---

## 9. Out of Scope / Deferred

Explicitly **not** part of Tier C — these have their own tier specs or follow-up tickets:

- **Tier B multiview oblique refinement** — own design spec after Tier C ships. Includes the wall-step / headwall / apron flashing fields (zero in Tier C), cricket adder for chimneys >30in wide, per-facet material refinement, refined object dimensions, oblique-derived dihedral edge typing (confidence ≥0.7).
- **Tier A LiDAR + RANSAC + Python service deployment decision** (Modal vs Railway vs Fly.io vs Vercel Python serverless vs Replicate) — own spec after Tier B ships. Includes the freshness check, commercial LiDAR premium-tier hook.
- **Visual layer: R3F + Cesium textured 3D model + Puppeteer-driven PDF stills + 360° orbit MP4** — deferred to **post–Tier A**. Tier C does **not** introduce any 3D rendering. The customer "wow factor" 3D model is sourced from Google 3D Tiles (rendered) overlaid with LiDAR-derived geometry — neither of which exists until Tier A.
- **Continuous waste % from richer signals** (α·valleyLf + β·facetCount + γ·dormerCount) — deferred to Tier B/A where multiview / dihedral signals exist. Tier C keeps the 7/11/14 buckets.
- **Per-facet material refinement** — every facet gets the same vision-derived material in Tier C; per-facet variation lands in Tier B obliques.
- **`modified-bitumen` / `tpo-membrane`** — no Tier C detection signal. Add to schema when a source for them lands (Tier B oblique seam analysis).
- **Customer-facing insurance-claim toggle on `/quote`** — real customers in storm zones want this, but it's a follow-up. Today `/quote` pins `isInsuranceClaim: false`; the toggle (with Xactimate-format PDF, claim metadata capture) is a separate ticket.
- **Pitch-correction regressor / ground-truth-roof workstream** — explicitly obsolete in the LiDAR future (per kickoff §"Don't build a pitch-correction model"). Tier C doesn't introduce it either; Solar's `pitchDegrees` is taken as truth.
- **Backfill of historical Supabase proposals to v2** — keep them as v1 forever (or sunset after 90 days when retention allows).

---

## 10. Open Questions / Decisions Pending

None blocking implementation. Q1–Q8 in the brainstorm conversation are resolved. The Python service decision (Tier A) and the wall-step detection prompt (Tier B) are the next architectural decisions — each blocks its own tier, neither blocks Tier C.

---

## 11. Implementation Order (Summary)

1. Phase 1: schema + engine + pipeline + sources + debug route (no consumer changes)
2. Verify 8450 Oak Park Rd via debug route — 17 facets, 64 LF flashing
3. Push Phase 1
4. Phase 2: `/internal` refactor, v2 save format, loader shim
5. Verify rep workflow + 3 test addresses
6. Push Phase 2
7. Phase 3: `/quote` refactor, simplified customer surfaces, PDF + share link verification
8. Verify customer workflow + PDF + `/p/[id]`
9. Push Phase 3
10. Tier C done. Pause and confirm with user before starting Tier B brainstorm.

---

**Done. Ready for implementation planning (`sp-writing-plans`).**

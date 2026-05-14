# Roof Estimator Engine — Unified A + B + C Rebuild

> **Paste this entire document as the first message in a fresh Claude Code session.**

You are taking over a Next.js 16 / React 19 / TypeScript / Tailwind v4 roof estimator at `D:\Users\nanob\roofai-internal` called **Voxaris Pitch**. The product turns an address into a signed roofing proposal in under 5 seconds. You are building the **unified accuracy engine** — three tiers (C, B, A) that all feed into one shared `RoofData` pipeline consumed by both the internal rep tool (`/`, app route `app/(internal)/page.tsx`) and the public customer tool (`/quote`, app route `app/quote/page.tsx`).

## Your job in one sentence

Build a single `RoofData` pipeline with three pluggable accuracy sources (Tier C → Tier B → Tier A), refactor `/internal` and `/quote` to both consume it, and ship it source-by-source with continuous verification.

## Required skills (in order)

Use these skills via the `Skill` tool. The pattern for each tier:

1. `sp-brainstorming` — design the tier, get user approval on the spec
2. `sp-writing-plans` — turn the spec into bite-sized tasks
3. `sp-subagent-driven-development` — execute the plan, dispatching one subagent per task with spec + code-quality review after each

Each tier (C, then B, then A) runs through this loop once. Do NOT mix tiers; finish one before starting the next.

## Quality bar (non-negotiable)

- TypeScript strict mode, no `any` without a comment justifying it
- Every subagent task gets BOTH spec compliance review AND code quality review before being marked complete
- Frequent commits with descriptive messages + `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` trailer
- `npm run typecheck` and `npm run lint` after every change; both must stay green for files you touch
- `npm run build` (Turbopack production build) before pushing — it catches client/server boundary issues that typecheck and lint miss
- Pause and ask the user when you hit a real design decision (deployment target for the Python service, etc.), don't guess

## The current state (read before starting)

Critical files to read first (in this order):

1. `docs/superpowers/specs/2026-05-13-pin-confirmation-design.md` — recently shipped feature; sets the pattern
2. `lib/pricing.ts` — current pricing engine, you'll be replacing it with a thin adapter
3. `lib/roof-geometry.ts` — contains `flashingFromComplexity()`, the 3-row constant table you're killing
4. `lib/anthropic.ts` — Claude vision functions (`analyzeRoofImage`, `validateRoofPolygon`, `findPrimaryResidence`)
5. `app/api/solar/route.ts` — Solar API integration, returns per-facet `pitchDegrees` but currently buckets to 5 values
6. `app/api/verify-polygon-multiview/route.ts` — multiview Cesium capture you'll reuse for Tier B
7. `types/estimate.ts` — current types (Pitch is a 5-bucket union, replace with `number`)
8. `app/(internal)/page.tsx` — 2200-line internal estimator (rep tool)
9. `app/quote/page.tsx` — 1610-line public estimator (customer tool, has its own pipeline you'll consolidate)

The pin-confirmation feature shipped tonight (commits ending at `9895938` on main). That's the most recent reference for code patterns and quality bar.

## The unified architecture

```
                ┌──────────────────────┐
                │   RoofData schema    │  ← Facet[]/Edge[]/Object[]/Flashing/LineItem[]
                │   (single contract)  │     defined in types/roof.ts (new)
                └──────────┬───────────┘
                           │ consumed by all sources & all consumers
       ┌───────────────────┼───────────────────┐
       │                   │                   │
   SOURCES            REFINEMENTS         CONSUMERS
       │                   │                   │
  ┌────┴────┐         ┌────┴────┐         ┌─────────┐
  │ Tier A  │         │ Tier B  │         │/internal│
  │ LiDAR   │ ──┐     │Multiview│ ──┐     │ (rep UI)│
  │ + RANSAC│   │     │ obliques│   │     └─────────┘
  └─────────┘   │     └─────────┘   │
  (USGS 3DEP    │                   │     ┌─────────┐
   raw point    │                   │     │  R3F    │
   cloud →      │                   │     │ Visual  │
   facets)      │                   │     │ Layer   │
                │                   │     │(3D Tiles│
                │                   │     │ texture │
                │                   │     │+ facets)│
                │                   │     └─────────┘
  ┌─────────┐   ├──→ Same RoofData ─┤     ┌─────────┐
  │ Tier C  │   │       output      │     │ /quote  │
  │ Solar   │ ──┤                   ├──→  │(public) │
  │ API     │   │                   │     └─────────┘
  └─────────┘   │                   │
  ┌─────────┐   │                   │     Same data,
  │ Tier C  │ ──┘                   │     different UI
  │ vision  │                       │
  │fallback │                       │
  └─────────┘                       │
                                    │
              All three feed into the same engine →
              Pipeline picks best available + merges refinements
```

**Properties of this architecture:**

- **One contract.** `RoofData` shape is defined once in `types/roof.ts`. Sources produce it, refinements update it, consumers render it.
- **Sources are pluggable.** Each is a function: `(input) => Promise<RoofData | null>`. The pipeline orchestrator (`lib/roof-pipeline.ts`) picks the best available, falls through on failure.
- **Refinements are additive.** Tier B doesn't replace Tier C's facets — it adds detail (wall-to-roof junctions, sizes) that Tier C couldn't see.
- **Consumers are dumb.** `/internal` and `/quote` both call `runRoofPipeline(address)`, get `RoofData`, render it. No source-specific logic in pages.

## The schema (define this first, before any source)

Create `types/roof.ts`:

```ts
/** The unified roof data shape produced by every source and consumed by every renderer. */
export interface RoofData {
  /** Address + lat/lng of the resolved building center */
  address: { formatted: string; lat: number; lng: number; zip?: string };
  /** Provenance — which source produced this data (highest tier that succeeded) */
  source: "tier-a-lidar" | "tier-b-multiview" | "tier-c-solar" | "tier-c-vision";
  /** Whether refinements have been applied (Tier B obliques) */
  refinements: Array<"multiview-obliques">;
  /** Overall confidence in this RoofData, 0..1 */
  confidence: number;
  /** When the underlying imagery was captured */
  imageryDate: string | null;

  /** Per-facet detail. Sources MUST produce at least one facet. */
  facets: Facet[];
  /** Classified edges between facets + perimeter. Tier C may produce heuristic edges; Tier A produces geometric ones. */
  edges: Edge[];
  /** Detected objects on the roof. */
  objects: RoofObject[];
  /** Flashing line items, computed from facets + edges + objects. */
  flashing: FlashingBreakdown;
  /** Whole-roof totals (sums and derived values). */
  totals: RoofTotals;
  /** Diagnostics — what fell back, what was guessed, what should be reviewed. */
  diagnostics: RoofDiagnostics;
}

export interface Facet {
  id: string;
  /** Lat/lng polygon, closed ring. */
  polygon: Array<{ lat: number; lng: number }>;
  /** Surface normal vector (used for 3D rendering + edge classification) */
  normal: { x: number; y: number; z: number };
  /** Pitch in degrees (continuous, not bucketed). */
  pitchDegrees: number;
  /** Azimuth — compass bearing of the down-slope direction. */
  azimuthDeg: number;
  /** True sloped surface area (sqft). */
  areaSqftSloped: number;
  /** Footprint area (sqft) — sloped × cos(pitch). */
  areaSqftFootprint: number;
  /** What material this facet looks like — null when unknown. */
  material: "asphalt-shingle" | "tile-concrete" | "metal-standing-seam" | "modified-bitumen" | "tpo-membrane" | null;
  /** True for pitches under 4/12 — flags for different material spec. */
  isLowSlope: boolean;
}

export type EdgeType = "ridge" | "hip" | "valley" | "eave" | "rake" | "step-wall";

export interface Edge {
  id: string;
  type: EdgeType;
  /** 3D polyline in lat/lng + height (height in meters, 0 = ground). */
  polyline: Array<{ lat: number; lng: number; heightM: number }>;
  lengthFt: number;
  /** Which facets this edge borders. */
  facetIds: string[];
  /** How confident we are in the classification. */
  confidence: number;
}

export type ObjectKind = "chimney" | "skylight" | "dormer" | "vent" | "stack" | "satellite-dish" | "ridge-vent" | "box-vent" | "turbine";

export interface RoofObject {
  id: string;
  kind: ObjectKind;
  /** Center position (lat/lng + height in meters). */
  position: { lat: number; lng: number; heightM: number };
  /** Footprint dimensions in feet. */
  dimensionsFt: { width: number; length: number };
  /** Which facet this object sits on (when known). */
  facetId: string | null;
}

export interface FlashingBreakdown {
  /** Chimney flashing — perimeter × sides, plus cricket if width > 30in */
  chimneyLf: number;
  /** Skylight kits — perimeter math, counted per skylight. */
  skylightLf: number;
  /** Dormer step flashing — cheek wall length × 2. */
  dormerStepLf: number;
  /** Non-dormer wall-to-roof step flashing (Tier B+ only). */
  wallStepLf: number;
  /** Headwall flashing (top of wall-to-roof junction). */
  headwallLf: number;
  /** Apron flashing (bottom of wall-to-roof junction). */
  apronLf: number;
  /** Valley flashing — covered by valley edge LF × 1.05 overlap. */
  valleyLf: number;
  /** Drip edge — eaves + rakes. */
  dripEdgeLf: number;
  /** Pipe boots — per-penetration count. */
  pipeBootCount: number;
  /** Ice & water shield — eaves × 3ft + valleys × 6ft. */
  iwsSqft: number;
}

export interface RoofTotals {
  facetsCount: number;
  edgesCount: number;
  objectsCount: number;
  /** Sloped surface area of the entire roof. */
  totalRoofAreaSqft: number;
  /** Footprint area. */
  totalFootprintSqft: number;
  /** Squares (1 square = 100 sqft, rounded up to nearest 1/3). */
  totalSquares: number;
  /** Area-weighted average pitch in degrees (display only, not used in pricing). */
  averagePitchDegrees: number;
  /** Industry-standard waste percentage based on complexity. */
  wastePct: number;
  /** Predominant material across all facets. */
  predominantMaterial: Facet["material"];
}

export interface RoofDiagnostics {
  /** Sources that were attempted and their outcomes. */
  attempts: Array<{ source: string; outcome: "succeeded" | "failed-coverage" | "failed-error"; reason?: string }>;
  /** Warnings the rep / customer should know about. */
  warnings: string[];
  /** Facets/objects flagged for human QA (low confidence). */
  needsReview: Array<{ kind: "facet" | "edge" | "object"; id: string; reason: string }>;
}
```

This schema is the keystone. Every source produces it. Every consumer reads it. **Do not deviate from it** without explicit user approval.

## Tier C — Solar API + Vision (foundation, ship first)

### Goal

Replace the bucketed `Pitch` type with continuous `pitchDegrees`. Replace `flashingFromComplexity()` with feature-driven flashing math. Build the source-agnostic pricing engine. Refactor both `/internal` and `/quote` to consume the unified pipeline.

### Sources to build

**Tier C primary: `lib/sources/solar-source.ts`**
- Input: address + lat/lng
- Calls: `/api/solar` (already exists)
- Produces: `RoofData` with `source: "tier-c-solar"` from Solar API's `roofSegmentStats[]`
- Per-facet: `pitchDegrees`, `azimuthDeg`, `areaSqftSloped` from Solar's per-segment data
- Edges: heuristic (eaves+rakes from perimeter, ridges/hips/valleys from segment adjacency — keep the existing logic in `lib/roof-geometry.ts:deriveRoofLengthsFromPolygons` but rebuild it to produce typed `Edge[]` instead of just LF totals)
- Objects: from `/api/vision` response (penetrations[] + visibleFeatures[])
- Returns null if Solar API 404s

**Tier C fallback: `lib/sources/vision-source.ts`**
- Input: address + lat/lng
- Calls: `/api/vision` (already exists) with an enhanced prompt asking for `estimatedPitchDegrees` + `dormerCount`
- Produces: `RoofData` with `source: "tier-c-vision"`. Single facet representing the whole roof (no per-facet detail without Solar).
- Edges: heuristic split based on perimeter + segment-count
- Objects: from vision penetrations[]
- Always works (when Anthropic key is set), lowest accuracy

### Engine to build

**`lib/roof-engine.ts`** — source-agnostic pure functions:
- `priceRoofData(data: RoofData, assumptions: Assumptions): LineItem[]` — converts RoofData → priced line items. Each facet priced at its own pitch (continuous multiplier, not buckets). Each flashing type gets its own line item.
- `computeFlashing(facets, edges, objects): FlashingBreakdown` — feature-driven math (chimney perimeter × 4 sides, skylight kit math, dormer × 2 cheek walls, etc.). REPLACES `flashingFromComplexity`.
- `computeTotals(facets, edges, objects, wasteOverridePct?): RoofTotals` — aggregations.

**`lib/roof-pipeline.ts`** — orchestrator:

```ts
export async function runRoofPipeline(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  // Future: signal to skip Tier A/B for debug, or force a specific tier
}): Promise<RoofData> {
  const attempts: RoofDiagnostics["attempts"] = [];

  // Try sources in priority order; first non-null wins for primary data
  let primary: RoofData | null = null;
  for (const source of [tierAMeshSource, tierCSolarSource, tierCVisionSource]) {
    try {
      const result = await source(opts);
      attempts.push({ source: source.name, outcome: result ? "succeeded" : "failed-coverage" });
      if (result) { primary = result; break; }
    } catch (err) {
      attempts.push({ source: source.name, outcome: "failed-error", reason: String(err) });
    }
  }
  if (!primary) throw new Error("All sources failed");

  // Apply refinements (Tier B obliques) — additive
  primary = await tierBMultiviewRefinement(primary).catch(() => primary);

  primary.diagnostics.attempts = attempts;
  return primary;
}
```

### Consumer refactor

Both `/internal` and `/quote` currently have their own RoofData-equivalent state, their own pricing logic, their own UI. After Tier C, both should:

1. Call `runRoofPipeline({ address })` once per address
2. Get `RoofData`
3. Run `priceRoofData(data, assumptions)` to get line items
4. Render

The /internal renderer shows: every facet's pitch + area, every detected object, every line item, all controls. The /quote renderer shows: the headline price, the line items (collapsed by category), a "What we detected" panel, and the proposal PDF.

Both should share components:
- `<DetectedFeaturesPanel data={data} />` — shows "2 chimneys, 3 skylights, 1 dormer, 5 vents"
- `<FacetList data={data} />` — toggleable per-facet breakdown
- `<RoofTotals data={data} />` — sqft, pitch, squares

Define these in `components/roof/` (new folder).

### Tier C UI additions

- Show real pitch numbers (e.g. "5.4/12") not bucketed values
- Per-facet pricing visible in the rep view
- "What we detected" panel on both /internal AND /quote
- Low-slope facets flagged with a small warning badge — they need different material spec

### Tier C scope summary

About 8-12 hours of focused work. Files touched: ~15. New files: ~10. Refactored files: 2 large pages.

### Acceptance criteria for Tier C

- [ ] `types/roof.ts` defines `RoofData` etc. exactly as the schema above
- [ ] Solar source produces correct RoofData for 8450 Oak Park Rd, Orlando FL (17 facets, HIGH coverage; verify manually with `curl`)
- [ ] Vision source produces RoofData for an address Solar 404s on
- [ ] `priceRoofData` produces a line-itemized estimate where each facet's pitch is reflected in pricing
- [ ] `flashingFromComplexity` is deleted; all flashing comes from feature math
- [ ] `/internal` renders the new pipeline data correctly; existing rep workflow not broken
- [ ] `/quote` renders the new pipeline data correctly; customer proposal still works end-to-end
- [ ] Both surfaces show the "What we detected" panel
- [ ] Pitch displays as continuous (e.g. "5.4/12") not bucketed
- [ ] `npm run build` passes (Turbopack production build)
- [ ] Tested against 3 real Orlando addresses: 8450 Oak Park Rd (complex, 17 facets), one simple ranch, one rural Solar-404 address

---

## Tier B — Multiview Claude Roof Inspector (refinement)

### Goal

Take Tier C's `RoofData` as input. Use the existing multiview Cesium capture infrastructure (`app/api/verify-polygon-multiview`) to capture 1 top-down + 4 obliques (N/E/S/W at 45°), then prompt Claude to:

1. Verify each facet from Tier C and refine pitch via shadow analysis
2. Identify **wall-to-roof junctions** that aren't dormers (lower garage roof butting upper main wall, etc.) → produces `step-wall` edges
3. Refine chimney + skylight + dormer **sizes** for accurate flashing math
4. Add cricket flashing requirement when chimney width > 30"

### Sources to build

**`lib/sources/multiview-source.ts`** — implements `tierBMultiviewRefinement(data: RoofData): Promise<RoofData>`
- Inputs an existing RoofData (from Tier C or A)
- Captures multiview using existing infra
- Calls a new `/api/roof-inspector` endpoint (similar pattern to `verify-polygon-multiview`) with a structured prompt
- Returns an updated RoofData with:
  - Refined `pitchDegrees` on each facet
  - Added `step-wall` edges in the `edges[]` array
  - Refined `dimensionsFt` on each object
  - Updated `flashing` computed by re-running `computeFlashing` with the refined inputs
  - `refinements: ["multiview-obliques"]` flag set

### API route to build

**`app/api/roof-inspector/route.ts`** — POST endpoint
- Body: `{ data: RoofData, topDownBase64, obliques: [{ base64, headingDeg }] }`
- Composes the images, sends to Claude with a structured prompt
- Returns the refined RoofData

The prompt structure should ask for STRUCTURED JSON output matching the RoofData schema, not free-text answers.

### Tier B UI additions

- "Roof Inspector" badge on facets/edges/objects refined by Tier B (so the rep knows the data has been verified by oblique inspection)
- "Wall-to-roof step flashing: 32 LF" line item appears for the first time (it was always 0 in Tier C)

### Acceptance criteria for Tier B

- [ ] `/api/roof-inspector` accepts a RoofData + multiview images, returns refined RoofData
- [ ] `multiviewSource` correctly integrates with the pipeline (returns refined data, falls through silently on error)
- [ ] Wall-to-roof step flashing is detected on test addresses with attached garages or split-level homes
- [ ] Chimney/skylight sizes refined from defaults to detected values
- [ ] Both /internal and /quote benefit automatically (they consume the pipeline)
- [ ] On the Oak Park address, total flashing goes from ~64 LF (Tier C) to ~104 LF (Tier B) — the actual wall step flashing on that house

---

## Tier A — LiDAR + RANSAC Measurement (best accuracy, broadest coverage) + 3D Tiles Visual Layer

### Goal

Pull raw **USGS 3DEP LiDAR point cloud** for the parcel, isolate the roof returns, run RANSAC plane segmentation directly on the point cloud to derive per-facet pitch + normals from real height measurements. Edge types come from facet adjacency (dihedral angles), not heuristics. Step flashing comes from "edge against vertical neighbor."

**Separately, render the customer-facing 3D visual model from Google Photorealistic 3D Tiles** (textured mesh — beautiful) with the LiDAR-derived facets/edges overlaid. LiDAR is for measurement; 3D Tiles is for visual. They are not competing — they are complementary.

### Why LiDAR over photogrammetric mesh for measurement

- **Free at scale** — USGS 3DEP is public domain, downloaded once and cached. No per-tile billing like Google 3D Tiles ($2 per 1,000 requests).
- **Better pitch accuracy** — direct height measurement, not photogrammetric reconstruction. Photogrammetry systematically underestimates steep pitches (smoothing artifact); LiDAR doesn't have that bias, so the pitch-correction-regressor workstream becomes optional.
- **Better rural coverage** — 3DEP covers near all of CONUS at 1-2m resolution; 3D Tiles is metro-only and patchy in suburbs. Critical for Voxaris's rural Florida demos.
- **Cleaner roof/wall separation** — sharp height gradient unambiguously isolates the roof from walls; photogrammetry's mesh blends them.
- **Multi-return pulses partially penetrate light tree canopy** — better data on tree-shaded roofs than photogrammetry which can't see under foliage.
- **Same accuracy ceiling EagleView uses** — they're LiDAR-based too. Matching their measurement source means matching their accuracy ceiling.

### Why still keep 3D Tiles (for visual only)

LiDAR is a point cloud — it looks like sparse dots in a viewer, not a roof. The customer-facing "wow factor" 3D model needs textured mesh. So 3D Tiles renders the surface for the customer, and the LiDAR-derived facet polygons get overlaid on top with color coding, edge classification, and object markers.

### CRITICAL DECISION: where does the Python service live?

The existing codebase is Next.js on Vercel. Python (PDAL, Open3D, NetworkX, Shapely, NumPy) doesn't run there natively. Options to surface to the user during Tier A's brainstorm:

1. **Modal** — designed for ML/compute workloads, easy deploy, billed per-invocation. **Likely best fit — LiDAR processing is compute-heavy.**
2. **Railway** — general purpose, easy
3. **Fly.io** — global, more setup
4. **Vercel Python serverless** — cold start issues + 50 MB package size limit will likely block PDAL. Probably not viable for LiDAR.
5. **Replicate** — model-hosting platform, awkward fit for non-ML pipeline.

User must pick before Tier A engineering begins. The Python service exposes a single HTTP endpoint: `POST /extract-roof` with `{ lat, lng, parcelPolygon }`, returns RoofData.

### Sources to build

**`services/roof-lidar/`** — new Python service (separate repo? subdirectory? user decides)
- `coverage_check.py` — given lat/lng, check 3DEP coverage manifest, return tile IDs + last-flight date
- `pull_lidar.py` — fetch LAS/LAZ tiles from USGS 3DEP (or Florida statewide if newer) intersecting the parcel bbox
- `isolate_roof.py` — ground-classify with PDAL, footprint mask (Microsoft Buildings polygon), height threshold above ground plane, vertical-return filter for walls vs roof
- `segment_planes.py` — region-growing plane segmentation directly on the point cloud (better than naive RANSAC for residential roofs; tuned for 1-2m point spacing)
- `build_facets.py` — alpha-shape boundaries on plane inlier points, Douglas-Peucker simplification, pitch/azimuth from plane normal
- `topology_graph.py` — facet adjacency + edge classification by dihedral angle
- `detect_objects.py` — YOLO inference on orthorectified top-down render produced from 3D Tiles imagery (LiDAR alone can't classify chimney vs vent — we still need imagery)
- `compute_flashing.py` — flashing rules applied to facets + edges + objects
- `freshness_check.py` — compare 3DEP capture date against current Google imagery date; flag for human review if roof appears newer than LiDAR (recent construction)
- `api.py` — FastAPI endpoint that wires it all together

**`lib/sources/lidar-source.ts`** — TypeScript adapter that calls the Python service and unpacks the response into RoofData with `source: "tier-a-lidar"`.

**`components/roof/RoofViewer.tsx`** — R3F visual layer (separate from measurement). Pulls Google 3D Tiles for the parcel as the textured backdrop, overlays LiDAR-derived facets as colored meshes + classified edges as lines + objects as 3D markers.

### Tier A coverage + freshness caveats

- **3DEP coverage is broad but not uniform.** Most of Florida + most metro areas have data; some rural counties have 5-10 year old data; a few small gaps in remote areas have nothing. The `coverage_check.py` step must run first and gracefully fall back to Tier C (Solar API + vision) when no LiDAR exists for the address.
- **3DEP datasets are not always recent.** Florida is generally well-served by the post-hurricane recovery program (capture every 2-5 years). For new construction (post-LiDAR-flight), the LiDAR will show the OLD roof or no building at all. The `freshness_check.py` step compares the LiDAR capture date against current Google imagery date and flags addresses where the building appears newer than the LiDAR.
- **Point cloud noise on edges.** Even with 1m resolution, individual ridge/hip points can be slightly mispositioned. The region-growing segmentation handles this, but expect facet boundaries to need 0.1-0.3m Douglas-Peucker simplification.
- **Object classification still requires imagery.** LiDAR sees that something exists at a height (chimney, vent, skylight, dormer) but can't tell which. The detect_objects pipeline still uses Google 3D Tiles ortho rendering + YOLO for that — same as proposed in the original Tier A plan, just sourced differently.
- **Commercial LiDAR fallback (premium tier, future).** When 3DEP is stale or missing, commercial sources like Nearmap or Vexcel offer recent high-res LiDAR for $$ per parcel. Defer this as a Phase 2 premium-tier upgrade; design the source to be swappable.

### Visual layer in Tier A

Once Tier A's LiDAR pipeline produces per-facet polygons + classified edges + objects, the visual layer renders them on top of Google 3D Tiles texture. The visual layer is a separate sub-feature within Tier A that should be brainstormed AFTER the core LiDAR pipeline is producing clean RoofData.

Visual layer stack:
- `<RoofViewer />` React component using `@react-three/fiber` (already in package.json) + Cesium for 3D Tiles base
- Cesium loads Google Photorealistic 3D Tiles for the parcel as a textured base mesh (the "real photo" of the house in 3D)
- R3F overlays the LiDAR-derived data on top:
  - Each facet rendered as a semi-transparent colored mesh (color ramp by pitch — cool blues for low slope, warm reds for steep)
  - Edges rendered as opaque colored lines (ridge=red, hip=orange, valley=blue, eave=green, rake=dashed green) with LF labels
  - Objects rendered as 3D markers (chimney=box, skylight=pane, vent=circle) with kind labels
- Camera presets (top, front, back, iso) as buttons + free orbit
- Puppeteer-based static export pipeline for PDF rendering (4-6 stills + a rotating GIF/MP4)

### Acceptance criteria for Tier A

- [ ] Python service deployed and reachable from the Next.js app
- [ ] 3DEP coverage check correctly identifies covered vs uncovered addresses
- [ ] LiDAR source produces correct RoofData for an Orlando address with 3DEP coverage (verify per-facet pitch matches Solar API ±0.3/12 — LiDAR should be MORE accurate than Solar, so ±0.3/12 is the loose tolerance, expect tighter)
- [ ] Edge types classified from geometry (ridge/hip/valley/eave/rake/step-wall)
- [ ] Wall-to-roof step flashing emerges from "edge against vertical neighbor" without needing obliques
- [ ] Freshness check flags addresses where the imagery shows newer construction than the LiDAR capture
- [ ] Falls back to Tier C cleanly when LiDAR coverage is missing or stale
- [ ] R3F + Cesium visual layer renders LiDAR-derived facets overlaid on 3D Tiles texture correctly on /internal and as an embedded panel on /quote
- [ ] Puppeteer pipeline exports 6 stills + a 360° orbit GIF/MP4 for the PDF report
- [ ] Total Tier A pipeline (coverage check → fetch → isolate → segment → facet build → topology → object detect → flashing → return) completes in under 30 seconds for a typical residential address

---

## Build order within this session

1. **Brainstorm + spec Tier C** (use `sp-brainstorming`). Get user approval on the spec.
2. **Plan Tier C** (use `sp-writing-plans`).
3. **Implement Tier C** (use `sp-subagent-driven-development`). Subagent per task, two-stage review, frequent commits.
4. **Verify Tier C** against 8450 Oak Park Rd Orlando + a simple ranch + a rural 404 address. `npm run build` must pass.
5. **Push Tier C.** Vercel deploy should succeed.
6. **Pause and confirm with user** before starting Tier B.
7. **Brainstorm + spec Tier B.** Apply for refinement-only design.
8. **Plan + implement Tier B.** Same loop.
9. **Verify and push Tier B.**
10. **Pause and confirm with user** before starting Tier A.
11. **Brainstorm Tier A** — SURFACE THE DEPLOYMENT DECISION (Modal/Railway/etc.) to the user before designing.
12. **Spec + plan + implement Tier A.** Bigger scope; may take multiple subagent passes.
13. **Brainstorm + implement visual layer** (R3F + Puppeteer export) once Tier A is producing clean RoofData.
14. **Final integration test** across all three tiers on a real demo set.

Each pause is a checkpoint. The user can redirect at any of them. Do NOT just barrel through without these gates.

## When you're stuck

- If you hit an architectural decision with multiple valid approaches (deployment target, schema field naming, etc.) — **stop and ask**.
- If a subagent reports BLOCKED, escalate to the user with context.
- If a tier expands beyond its scope (e.g., Tier C starts pulling in Tier B work), stop and reconfirm scope before continuing.
- If verification fails on a known-good test address, do not "fix" by relaxing checks. Find the actual bug.

## What NOT to do

- Don't skip the brainstorm/spec phase for any tier — even if the spec feels obvious.
- Don't merge tiers — finish C, push, pause, then B.
- Don't refactor /quote without rerunning its full happy path (it's the public-facing surface, regressions are visible).
- Don't push to main without a green `npm run build`.
- Don't write commit messages that hide what changed.
- Don't build a pitch-correction model for LiDAR — direct height measurement doesn't have the photogrammetric smoothing bias. The 200-500 ground-truth-roof workstream is OBSOLETE once LiDAR is the measurement source. (Keep this note for future Claude sessions that might reference the older 3D-Tiles-based plan.)
- Don't try to render the customer-facing 3D model from raw LiDAR point cloud — it looks like sparse dots, not a roof. The customer-facing model uses 3D Tiles texture. LiDAR is for measurement only.

## Repo state at handoff

- Branch: `main`
- Most recent commit: `9895938` — fix(canvass) typo (unrelated, just a build fix)
- Most recent feature: pin-confirmation overlay (shipped between `7ddb24b` and `1029c74`)
- Working tree should be clean before you start. Run `git status` to verify.
- Working directory: `D:\Users\nanob\roofai-internal`
- Test address that exercises complexity: **8450 Oak Park Rd, Orlando FL 32819** — Solar API HIGH coverage, 17 facets, 5,485 sqft sloped surface, includes low-slope sections that the current engine prices incorrectly

## Final words

This is a 12-30 hour project depending on how Tier A's Python service deployment shakes out. Take it tier by tier. The user trusts you to ship each piece clean before moving to the next. Quality over speed.

Go.

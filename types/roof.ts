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
  /** What this facet looks like — diagnostic, not pricing input.
   *  Pricing uses PricingInputs.material (rep-picked, vision-seeded default).
   *  In Tier C, all facets carry the same vision-derived value. */
  material: Material | null;
  isLowSlope: boolean;
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
  /** Center position. heightM = 0 in Tier C (no 3D info). */
  position: { lat: number; lng: number; heightM: number };
  dimensionsFt: { width: number; length: number };
  /** Which facet this object sits on. null in Tier C (no facet attribution yet). */
  facetId: string | null;
}

export interface FlashingBreakdown {
  chimneyLf: number;
  skylightLf: number;
  dormerStepLf: number;
  /** Non-dormer wall-to-roof step flashing. Always 0 in Tier C (Tier B+ signal). */
  wallStepLf: number;
  /** Headwall flashing (top of wall-to-roof junction). Always 0 in Tier C. */
  headwallLf: number;
  /** Apron flashing (bottom of wall-to-roof junction). Always 0 in Tier C. */
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
  /** Squares (1 square = 100 sqft, rounded up to nearest 1/3). */
  totalSquares: number;
  averagePitchDegrees: number;
  /** 7 | 11 | 14 in Tier C (simple/moderate/complex). */
  wastePct: number;
  /** Inferred complexity tier — intentional schema extension beyond the
   *  kickoff doc (kickoff had wastePct but not complexity). Kept on
   *  totals so the rep-side waste-table UI can highlight the suggested row
   *  without re-deriving complexity from facets[]. Tier B/A may demote
   *  this field if continuous waste lands. */
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

/** Refinement tags applied on top of a primary source's RoofData.
 *  Tier B adds "multiview-obliques"; Tier A may add LiDAR-derived
 *  refinement tags. A named type so widening doesn't require touching
 *  the RoofData interface. */
export type Refinement = "multiview-obliques";

export interface RoofData {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  /** "none" = all sources failed; see lib/roof-pipeline.makeDegradedRoofData. */
  source: "tier-a-lidar" | "tier-b-multiview" | "tier-c-solar" | "tier-c-vision" | "none";
  refinements: Refinement[];
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
  /** Pixel-accurate building outline from Solar dataLayers mask (Tier C)
   *  or LiDAR alpha-shape boundary (Tier A). When present, this is the
   *  visible outline rendered on map + 3D view — strictly tighter than
   *  the union of `facets[].polygon` (which for Tier C is axis-aligned
   *  bboxes rotated to dominant azimuth, inherently loose on L-shapes).
   *  Facet polygons remain authoritative for per-facet pricing / pitch.
   *  When null / absent (vision-only, degraded, mask fetch failed),
   *  consumers fall back to the facet-union outline. Optional on the
   *  type so older fixtures + the v1 estimate-loader shim don't have to
   *  set it — the field is strictly additive. */
  outlinePolygon?: Array<{ lat: number; lng: number }> | null;
  /** Cross-source measurement baseline. When the winning source is Tier A
   *  (LiDAR), we still capture what Tier C Solar said about the same roof
   *  so the UI can show an "X agrees with Y" trust signal. Populated by
   *  the pipeline when both sources resolved during the same run.
   *  Strictly additive / optional — older payloads, degraded results, and
   *  Tier C/D primaries leave this null. */
  crossSourceBaseline?: {
    solar?: {
      sqft: number | null;
      pitchDegrees: number | null;
      segmentCount: number;
      imageryDate: string | null;
      imageryQuality: string;
    } | null;
  } | null;
  /** Phase 2 — how the facets[] mesh was reconstructed.
   *    "point2roof"       — Li-Li-Whu/Point2Roof deep-learning model
   *                         (MIT, vendored). Primary tier; produces
   *                         per-facet planar polygons from a
   *                         keypoint+edge wireframe. Tier A only.
   *    "polyfit"          — CGAL Polygonal_surface_reconstruction_3
   *                         produced a watertight mesh with shared
   *                         edges. Secondary tier (GPL). Tier A only.
   *    "frustum-fallback" — Both ML + PolyFit failed (or weren't
   *                         available); facets came from per-plane
   *                         alpha-shape. Tier A only. The renderer
   *                         falls back to its synthetic frustum-from-
   *                         outline mesh.
   *    "solar-tier-c"     — Source is Tier C Solar / vision; facets
   *                         are Solar's bbox-rotated segments.
   *  Optional + nullable — older fixtures and degraded payloads
   *  leave it unset. Renderer treats missing as "frustum-fallback". */
  meshSource?:
    | "point2roof"
    | "polyfit"
    | "frustum-fallback"
    | "solar-tier-c"
    | null;
  /** Phase 2 — reconstruction failure-corpus diagnostics. Always
   *  present on Tier A results; null otherwise. Includes mesh_source,
   *  failure_reason, timings for each attempted tier, input plane/
   *  point counts. Surface in the rep tool when debugging an
   *  estimate; aggregate in the failure log for the 2-4 week review. */
  polyfitDiagnostics?: {
    mesh_source: "point2roof" | "polyfit" | "regularize_only" | "failed";
    failure_reason: string | null;
    timings: {
      regularize_ms?: number;
      point2roof_ms?: number;
      polyfit_ms?: number;
      total_ms?: number;
    };
    input_plane_count: number;
    input_point_count: number;
    regularized_plane_count?: number;
    output_facet_count?: number;
    output_facet_count_after_filter?: number;
  } | null;
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

import type { AddressInfo, Estimate as LegacyEstimate } from "./estimate";
import type { PhotoMeta } from "./photo";
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

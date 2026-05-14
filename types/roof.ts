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

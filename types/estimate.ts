export type Material =
  | "asphalt-3tab"
  | "asphalt-architectural"
  | "metal-standing-seam"
  | "tile-concrete";

export type Pitch = "4/12" | "5/12" | "6/12" | "7/12" | "8/12+";

export type ServiceType =
  /** First-time install on new construction */
  | "new"
  /** Tear off existing & replace */
  | "reroof-tearoff"
  /** New shingles laid over existing layer */
  | "layover"
  /** Patch / partial only */
  | "repair";

export type Complexity = "simple" | "moderate" | "complex";

export interface AddOn {
  id: string;
  label: string;
  price: number;
  enabled: boolean;
}

export interface Assumptions {
  sqft: number;
  pitch: Pitch;
  material: Material;
  ageYears: number;
  laborMultiplier: number;
  materialMultiplier: number;
  /** Optional — defaults to "reroof-tearoff" for legacy data */
  serviceType?: ServiceType;
  /** Optional — drives complexity multiplier; defaults to "moderate" */
  complexity?: Complexity;
}

export interface AddressInfo {
  formatted: string;
  zip?: string;
  lat?: number;
  lng?: number;
}

export interface RoofVision {
  currentMaterial:
    | "asphalt-3tab"
    | "asphalt-architectural"
    | "metal-standing-seam"
    | "tile-concrete"
    | "wood-shake"
    | "flat-membrane"
    | "unknown";
  estimatedAge: "new" | "moderate" | "aged" | "very-aged" | "unknown";
  estimatedAgeYears: number;
  complexity: Complexity;
  visibleFeatures: Array<
    | "chimney"
    | "skylight"
    | "dormer"
    | "solar-panels"
    | "satellite-dish"
    | "vents"
    | "complex-geometry"
  >;
  visibleDamage: Array<
    "missing-shingles" | "moss-algae" | "discoloration" | "tarp-visible" | "ponding" | "none"
  >;
  /** Per-penetration positions (pixel coords on the 640x640 satellite tile) */
  penetrations: Array<{
    kind: "vent" | "chimney" | "skylight" | "stack" | "satellite-dish" | "other";
    x: number;
    y: number;
    approxSizeFt?: number;
  }>;
  /** Single closed polygon outlining the entire roof, in pixel coords on the
   *  640x640 satellite tile. 6-14 vertices, clockwise. Empty array when the
   *  roof can't be identified. Used as the activePolygon when Solar API
   *  has no segments for the property. */
  roofPolygon: Array<[number, number]>;
  salesNotes: string;
  confidence: number;
}

/** Parsed Solar API output, augmented with pixel-space polygons for overlay drawing */
export interface SolarSummary {
  sqft: number | null;
  pitch: Pitch | null;
  pitchDegrees: number | null;
  segmentCount: number;
  buildingFootprintSqft: number | null;
  imageryQuality: "HIGH" | "MEDIUM" | "LOW" | "BASE" | "UNKNOWN";
  imageryDate: string | null;
  /** Geographic polygons (lat/lng vertex pairs), one per roof segment.
   *  Used to render overlay polygons on the Google Maps satellite map. */
  segmentPolygonsLatLng: Array<Array<{ lat: number; lng: number }>>;
  maxArrayPanels?: number | null;
  yearlyKwhPotential?: number | null;
}

export type LineItemUnit = "SQ" | "LF" | "EA" | "SF" | "%";
export type LineItemCategory =
  | "tearoff"
  | "decking"
  | "underlayment"
  | "shingles"
  | "flashing"
  | "ventilation"
  | "addons"
  | "labor"
  | "op";

export interface LineItem {
  /** Xactimate-style code, e.g. "RFG ARCH" */
  code: string;
  description: string;
  /** Friendlier label for the homeowner-facing summary */
  friendlyName: string;
  quantity: number;
  unit: LineItemUnit;
  unitCostLow: number;
  unitCostHigh: number;
  extendedLow: number;
  extendedHigh: number;
  category: LineItemCategory;
}

export interface SimplifiedItem {
  group: string;
  totalLow: number;
  totalHigh: number;
  codes: string[];
}

export interface DetailedEstimate {
  lineItems: LineItem[];
  simplifiedItems: SimplifiedItem[];
  subtotalLow: number;
  subtotalHigh: number;
  overheadProfit: { low: number; high: number };
  totalLow: number;
  totalHigh: number;
  squares: number;
}

/** EagleView-style line measurements (eaves/rakes/ridges/valleys etc.) */
export interface RoofLengths {
  perimeterLf: number;
  eavesLf: number;
  rakesLf: number;
  ridgesLf: number;
  hipsLf: number;
  valleysLf: number;
  dripEdgeLf: number;
  flashingLf: number;
  stepFlashingLf: number;
  iwsSqft: number;
  /** "polygons" = computed from real polygons; "footprint" = from building footprint; "heuristic" = pure approximation */
  source: "polygons" | "footprint" | "heuristic";
}

export interface WasteRow {
  pct: number;
  areaSqft: number;
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

export interface Estimate {
  id: string;
  createdAt: string;
  staff: string;
  customerName?: string;
  notes?: string;
  address: AddressInfo;
  assumptions: Assumptions;
  addOns: AddOn[];
  total: number;
  baseLow: number;
  baseHigh: number;
  /** Optional — set when the rep marks this as an insurance claim */
  isInsuranceClaim?: boolean;
  /** Optional — Claude's vision analysis of the roof (when available) */
  vision?: RoofVision;
  /** Optional — Solar API geometry */
  solar?: SolarSummary;
  /** Optional — Xactimate-style line items (computed from assumptions on save) */
  detailed?: DetailedEstimate;
  /** Optional — EagleView-style line-feet measurements */
  lengths?: RoofLengths;
  /** Optional — EagleView-style waste calculation table */
  waste?: WasteTable;
  /** Optional — the polygon(s) actually used for measurement, after any
   *  rep edits. Persisted so reopening an estimate restores the exact roof
   *  geometry it was priced against. Lat/lng order. */
  polygons?: Array<Array<{ lat: number; lng: number }>>;
  /** Optional — provenance of the saved polygons. */
  polygonSource?: "edited" | "solar-mask" | "solar" | "sam" | "osm" | "ai";
}

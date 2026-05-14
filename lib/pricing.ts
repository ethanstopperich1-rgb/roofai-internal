import type {
  AddOn,
  Assumptions,
  Material,
  Pitch,
} from "@/types/estimate";

// -----------------------------------------------------------------------------
// Original (legacy) flat pricing — used by ResultsPanel for the headline number
// and by computeTotal(). Preserved as-is so the simple flow keeps working.
// -----------------------------------------------------------------------------

/**
 * Installed cost per sqft (materials + labor, mid/low/high).
 *
 * Source: RoofingCalculator's 2026 published industry ranges. These are
 * total replacement costs per sqft, not material-only — labor is already
 * baked in (~60% of the figure per their breakdown). `removeLow/High` is
 * the tear-off + disposal range per their Table 4.
 *
 * Q2 2026 update (2026-05-11): bumped per Grok wholesale-pricing intel.
 * GAF/CertainTeed/Owens Corning/Atlas all announced 5-8% list-price
 * hikes effective April 2026; SRS distributors passing through +6-10%
 * more in June. Aluminum/Galvalume materially hit by tariffs (+12-25%).
 * Concrete tile largely unaffected (+4-8%). Conservative end of each
 * range applied — over-correcting kills competitiveness on quoted bids.
 *
 *   Asphalt 3-tab        : $3.77–$5.12/sf   tear-off $0.42–$0.58 (was 3.43–4.65)
 *   Architectural        : $4.52–$6.55/sf   (was 4.11–5.95)        +10%
 *   Standing-seam metal  : $21.37–$28.91/sf no tear-off              +18%
 *   Concrete tile        : $6.65–$9.00/sf   tear-off $1.45–$1.97   +6%
 */
/**
 * IMPORTANT — two pricing engines, two source-of-truth tables:
 *
 *   MATERIAL_RATES (this file): full installed cost per sqft of roof by
 *     material type. Used by `computeBase` for the headline range
 *     ($/sqft × area × pitch slope). Coarse, fast, customer-facing.
 *
 *   DEFAULT_MATERIAL_PRICES (lib/branding.ts): Xactimate-style
 *     per-component prices ($/SQ for shingles, $/LF for ridge cap, etc).
 *     Used by `priceRoofData` (lib/roof-engine.ts) to produce a line-item breakdown.
 *     Fine-grained, used internally and on the rep's worksheet.
 *
 * These two tables MUST stay directionally aligned (a 6% Q3 hike in
 * shingles needs to show up in both) but they aren't auto-derived from
 * each other today. When you update one, audit the other.
 *
 * TODO (post-pilot): collapse to one regional-overrides table that
 * generates both views. Until then, treat divergence between
 * MATERIAL_RATES.asphalt-architectural.rate and the corresponding
 * sum-of-components in DEFAULT_MATERIAL_PRICES as a bug, not a
 * feature.
 */
export const MATERIAL_RATES: Record<
  Material,
  {
    label: string;
    /** Midpoint per-sqft installed cost — used by `computeBase().mid` */
    rate: number;
    /** Industry-low installed cost per sqft */
    low: number;
    /** Industry-high installed cost per sqft */
    high: number;
    /** Tear-off + disposal per sqft, low end. 0 = no tear-off needed (metal layover) */
    removeLow: number;
    /** Tear-off + disposal per sqft, high end */
    removeHigh: number;
  }
> = {
  "asphalt-3tab": {
    label: "Asphalt 3-Tab",
    rate: 4.44, low: 3.77, high: 5.12,
    removeLow: 0.42, removeHigh: 0.58,
  },
  "asphalt-architectural": {
    label: "Architectural Shingle",
    rate: 5.53, low: 4.52, high: 6.55,
    removeLow: 0.42, removeHigh: 0.58,
  },
  "metal-standing-seam": {
    label: "Standing-Seam Metal",
    rate: 25.13, low: 21.37, high: 28.91,
    removeLow: 0, removeHigh: 0,
  },
  "tile-concrete": {
    label: "Concrete Tile",
    rate: 7.82, low: 6.65, high: 9.00,
    removeLow: 1.45, removeHigh: 1.97,
  },
};

/**
 * Component adders for the itemized engine — per-sqft or per-LF rates from
 * RoofingCalculator's "Additional roof replacement materials" section.
 * Used by `priceRoofData` and the white-label override in branding.ts.
 *
 * Q2 2026 update (2026-05-11):
 *   - underlayment + ice & water: +8% (synthetic underlayment + IWS
 *     part of the April 2026 manufacturer hikes, +5-10% range)
 *   - flashing + drip edge: +15% (aluminum / steel accessories hit hard
 *     by Section 232 tariff pressure, Grok cites +10-20% on category)
 *   - decking: unchanged (plywood/OSB largely stable per Grok)
 *   - fascia / soffit: +6% (aluminum-coil products, moderate tariff pass-through)
 */
export const COMPONENT_RATES = {
  /** Sheathing replacement per sqft */
  decking:        { low: 2.20, high: 3.00 },
  /** Synthetic felt underlayment per sqft */
  underlayment:   { low: 1.62, high: 2.27 },
  /** Ice & water barrier per sqft */
  iceAndWater:    { low: 2.02, high: 2.73 },
  /** Galvanized steel flashing per linear foot */
  flashing:       { low: 10.35, high: 12.65 },
  /** Rubber pipe boots, each */
  pipeBoot:       { low: 63.00, high: 85.00 },
  /** Fascia board per linear foot */
  fascia:         { low: 4.51, high: 9.14 },
  /** Soffit per linear foot */
  soffit:         { low: 2.97, high: 5.60 },
} as const;

/**
 * Two-story homes take materially longer (and need more safety setup).
 * Default adjustment applied in computeBase when `isTwoStory` is set.
 */
export const TWO_STORY_LABOR_BUMP = 1.08;

export const PITCH_FACTOR: Record<Pitch, number> = {
  "4/12": 1.0,
  "5/12": 1.05,
  "6/12": 1.12,
  "7/12": 1.2,
  "8/12+": 1.32,
};

// Q2 2026 update: ice-water +6%, gutters +8% (aluminum coil), skylight +5%
// (aluminum-framed unit), drip edge upgrade +15% (tariff-heavy aluminum).
// Ridge vent + solar-ready unchanged (plastic + labor-only respectively).
export const DEFAULT_ADDONS: AddOn[] = [
  { id: "ice-water", label: "Ice & Water Shield", price: 900, enabled: false },
  { id: "ridge-vent", label: "Ridge Vent", price: 425, enabled: false },
  { id: "solar-ready", label: "Solar Ready Prep", price: 1200, enabled: false },
  { id: "gutters", label: "Seamless Gutters", price: 2000, enabled: false },
  { id: "skylight", label: "Skylight Replacement", price: 1000, enabled: false },
  { id: "drip-edge", label: "Drip Edge Upgrade", price: 370, enabled: false },
];

/**
 * Legacy per-sqft × material-rate × pitch headline pricer.
 *
 * @kept-for-tiers — `lib/tiers.ts buildTiers` (the v1 entrypoint, still
 * wired to the rep-side /internal TiersPanel) uses this for the
 * Good/Better/Best band math. Tier C ships `priceRoofData` as the
 * canonical engine and `buildTiersFromRoofData` for the v2 path; this
 * v1 helper stays alive because /internal hasn't migrated TiersPanel yet
 * and the inline replacement (re-implementing pitch + multiplier band
 * math) isn't worth the ~20-LOC churn.
 *
 * Do not add new callers.
 */
export function computeBase(a: Assumptions): { low: number; high: number; mid: number } {
  // Installed cost per sqft already includes labor (~60% of total per
  // RoofingCalculator's breakdown). Multipliers shift the band:
  //   - materialMultiplier scales the material side (~40% of cost)
  //   - laborMultiplier scales the labor side (~60% of cost)
  // Pitch factor + service-type mod are applied multiplicatively over both.
  const m = MATERIAL_RATES[a.material];
  const matSplit = 0.4;
  const laborSplit = 0.6;
  const pitch = PITCH_FACTOR[a.pitch];
  const blended =
    (matSplit * a.materialMultiplier + laborSplit * a.laborMultiplier) * pitch;
  const mid = Math.round(a.sqft * m.rate * blended);
  // Use the industry-published low/high envelope as the bound, scaled by the
  // same blended multiplier so reps' adjustments stay reflected in the range.
  const low = Math.round(a.sqft * m.low * blended);
  const high = Math.round(a.sqft * m.high * blended);
  return { low, high, mid };
}

export function computeTotal(a: Assumptions, addOns: AddOn[]): number {
  const { mid } = computeBase(a);
  const adds = addOns.filter((x) => x.enabled).reduce((s, x) => s + x.price, 0);
  return Math.round(mid + adds);
}

export function fmt(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

// -----------------------------------------------------------------------------
// Tier C migration: the Xactimate-style line-item engine and its helpers
// (buildDetailedEstimate, SHINGLE_*, complexityMultiplier, steepChargeMultiplier,
// makeItem, estimateRoofMetrics, pitchToDegrees) lived here. priceRoofData
// in lib/roof-engine.ts is the single source of truth for line-item pricing
// now. computeBase / computeTotal above stay alive for lib/tiers.ts and the
// /internal + /dashboard/estimate headline fallback when the pipeline degrades.
// -----------------------------------------------------------------------------

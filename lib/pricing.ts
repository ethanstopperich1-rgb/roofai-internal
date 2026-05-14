import type {
  AddOn,
  Assumptions,
  Complexity,
  DetailedEstimate,
  LineItem,
  LineItemCategory,
  LineItemUnit,
  Material,
  Pitch,
  ServiceType,
  SimplifiedItem,
} from "@/types/estimate";
import { BRAND_CONFIG, getMaterialPrice, type MaterialPriceKey } from "./branding";
import {
  deriveRoofLengthsFromPolygons,
  deriveRoofLengthsHeuristic,
  suggestedWastePct,
} from "./roof-geometry";

const PITCH_TO_DEG_LOCAL: Record<Pitch, number> = {
  "4/12": 18.43,
  "5/12": 22.62,
  "6/12": 26.57,
  "7/12": 30.26,
  "8/12+": 35.0,
};

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
 *     Used by `buildDetailedEstimate` to produce a line-item breakdown.
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
 * Used by `buildDetailedEstimate` and the white-label override in branding.ts.
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
// Xactimate-style line-item engine — used by:
//   - the Detailed view in ResultsPanel
//   - the PDF when the estimate is marked as an insurance claim
//   - downstream CRM/JSON exports
// Pricing comes from BRAND_CONFIG so it stays tunable per client.
// -----------------------------------------------------------------------------

// Underlayment is rolled goods — much less per-cut waste than shingles
// regardless of roof complexity. Keep it as a fixed 10% across the board.
// Shingle waste is now complexity-driven via suggestedWastePct() — see
// the call site below in `buildDetailedEstimate`. Single source of truth
// shared with `buildWasteTable` so the panel-suggested % == billed %.
const UNDERLAYMENT_WASTE = 1.1;
const DEFAULT_PIPE_FLASHINGS = 3;

const SHINGLE_KEY: Record<Material, MaterialPriceKey> = {
  "asphalt-3tab": "RFG_3T",
  "asphalt-architectural": "RFG_ARCH",
  "metal-standing-seam": "RFG_METAL",
  "tile-concrete": "RFG_TILE",
};

const SHINGLE_CODE: Record<Material, string> = {
  "asphalt-3tab": "RFG 3T",
  "asphalt-architectural": "RFG ARCH",
  "metal-standing-seam": "RFG METAL",
  "tile-concrete": "RFG TILE",
};

const SHINGLE_LABEL: Record<Material, string> = {
  "asphalt-3tab": "3-tab composition shingle",
  "asphalt-architectural": "Architectural composition shingle",
  "metal-standing-seam": "Standing-seam metal",
  "tile-concrete": "Concrete / clay tile",
};

const SIMPLIFIED_GROUPS: Array<{ name: string; codes: string[] }> = [
  {
    name: "Materials & shingles",
    codes: ["RFG ARCH", "RFG 3T", "RFG METAL", "RFG TILE", "RFG STARTER", "RFG RIDG"],
  },
  { name: "Underlayment & weatherproofing", codes: ["RFG SYNF", "RFG IWS"] },
  { name: "Flashing & metal", codes: ["RFG DRIP", "RFG VAL", "RFG PIPEFL"] },
  { name: "Tear-off & disposal", codes: ["RFG SHGLR", "RFG DEPSTL"] },
  { name: "Decking repair (allowance)", codes: ["RFG DECK"] },
  { name: "Ventilation", codes: ["RFG RDGV"] },
  { name: "Add-ons & upgrades", codes: ["ADDON"] },
  { name: "Labor adjustments", codes: ["RFG STP", "COMPLEXITY"] },
  { name: "Overhead & profit", codes: ["O&P"] },
];

function pitchToDegrees(p: Pitch): number {
  const rise = p === "8/12+" ? 9 : Number(p.split("/")[0]);
  return Math.atan(rise / 12) * (180 / Math.PI);
}

function steepChargeMultiplier(p: Pitch): number {
  const rise = p === "8/12+" ? 9 : Number(p.split("/")[0]);
  if (rise < 8) return 0;
  if (rise < 10) return 0.25;
  return 0.35;
}

function complexityMultiplier(c: Complexity = "moderate"): number {
  if (c === "simple") return 1.0;
  if (c === "moderate") return 1.1;
  return 1.25;
}

function makeItem(args: {
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

/**
 * Estimate roof metrics (perimeter LF, ridge LF, valley LF, IWS sqft) when
 * Solar API doesn't give us per-segment data. Documented as approximations.
 */
function estimateRoofMetrics(opts: {
  sqftFootprint: number;
  segmentCount: number;
}): { perimeterLf: number; ridgeLf: number; valleyLf: number; iwsSqft: number } {
  const { sqftFootprint, segmentCount } = opts;
  const sideLength = Math.sqrt(sqftFootprint);
  const perimeterLf = Math.round(sideLength * 4 * 1.05);
  const ridgeLf = Math.round(0.5 * Math.sqrt(sqftFootprint));
  const valleyLf = segmentCount > 4 ? Math.round(sqftFootprint * 0.015) : 0;
  const iwsSqft = Math.round(perimeterLf * 3 + valleyLf * 6);
  return { perimeterLf, ridgeLf, valleyLf, iwsSqft };
}

/**
 * @deprecated Tier C ships with priceRoofData (lib/roof-engine.ts) as the
 * canonical pricing engine for /internal and /quote. This function remains
 * for three legacy consumers that haven't migrated yet:
 *   - app/dashboard/estimate/page.tsx
 *   - lib/pdf.ts (fallback when Estimate.detailed is missing)
 *   - lib/tiers.ts (buildTiers Good/Better/Best)
 * Phase 4 will migrate those consumers and delete this function. Do not
 * add new callers.
 */
export function buildDetailedEstimate(
  a: Assumptions,
  addOns: AddOn[],
  opts: {
    /** Optional — when known, drives perimeter/ridge/valley estimates */
    buildingFootprintSqft?: number | null;
    /** Optional — Solar API gives this; otherwise defaults to 4 */
    segmentCount?: number;
    /** Optional — when present, perimeter/ridge/valley come from polygon geometry */
    segmentPolygonsLatLng?: Array<Array<{ lat: number; lng: number }>>;
  } = {},
): DetailedEstimate {
  const sqft = a.sqft;
  const squares = sqft / 100;
  const serviceType: ServiceType = a.serviceType ?? "reroof-tearoff";
  const complexity: Complexity = a.complexity ?? "moderate";

  const segmentCount = opts.segmentCount ?? 4;
  const lengths =
    opts.segmentPolygonsLatLng && opts.segmentPolygonsLatLng.length > 1
      ? deriveRoofLengthsFromPolygons({
          polygons: opts.segmentPolygonsLatLng,
          pitchDegrees: PITCH_TO_DEG_LOCAL[a.pitch],
          complexity,
        })
      : deriveRoofLengthsHeuristic({
          totalRoofSqft: sqft,
          buildingFootprintSqft: opts.buildingFootprintSqft ?? null,
          segmentCount,
          complexity,
          pitch: a.pitch,
        });
  const perimeterLf = lengths.perimeterLf;
  const ridgeLf = lengths.ridgesLf + lengths.hipsLf;
  const valleyLf = lengths.valleysLf;
  const iwsSqft = lengths.iwsSqft;

  const items: LineItem[] = [];

  // Tear-off
  const tearoffMultiplier =
    serviceType === "new" ? 0 :
    serviceType === "layover" ? 0 :
    serviceType === "repair" ? 0.25 : 1;

  if (tearoffMultiplier > 0) {
    const t = getMaterialPrice("RFG_SHGLR");
    items.push(makeItem({
      code: "RFG SHGLR",
      description: "Tear off composition shingles",
      friendlyName: "Remove old shingles",
      quantity: squares * tearoffMultiplier,
      unit: "SQ",
      unitCostLow: t.low,
      unitCostHigh: t.high,
      category: "tearoff",
    }));
    const d = getMaterialPrice("RFG_DEPSTL");
    items.push(makeItem({
      code: "RFG DEPSTL",
      description: "Disposal / dump fee",
      friendlyName: "Disposal & dumpster",
      quantity: squares * tearoffMultiplier,
      unit: "SQ",
      unitCostLow: d.low,
      unitCostHigh: d.high,
      category: "tearoff",
    }));
  }

  // Decking allowance
  if (serviceType === "reroof-tearoff" || serviceType === "new") {
    const dk = getMaterialPrice("RFG_DECK");
    items.push(makeItem({
      code: "RFG DECK",
      description: "Sheathing replacement allowance",
      friendlyName: "Decking repair (10% allowance)",
      quantity: sqft * 0.1,
      unit: "SF",
      unitCostLow: dk.low,
      unitCostHigh: dk.high,
      category: "decking",
    }));
  }

  // Underlayment
  if (serviceType !== "repair") {
    const u = getMaterialPrice("RFG_SYNF");
    items.push(makeItem({
      code: "RFG SYNF",
      description: "Synthetic underlayment",
      friendlyName: "Synthetic underlayment",
      quantity: squares * UNDERLAYMENT_WASTE,
      unit: "SQ",
      unitCostLow: u.low,
      unitCostHigh: u.high,
      category: "underlayment",
    }));
  }

  // Ice & water shield (eaves + valleys baseline)
  if (iwsSqft > 0 && serviceType !== "repair") {
    const iws = getMaterialPrice("RFG_IWS");
    items.push(makeItem({
      code: "RFG IWS",
      description: "Ice & water shield (eaves + valleys)",
      friendlyName: "Ice & water shield (eaves + valleys)",
      quantity: iwsSqft / 100,
      unit: "SQ",
      unitCostLow: iws.low,
      unitCostHigh: iws.high,
      category: "underlayment",
    }));
  }

  if (perimeterLf > 0 && serviceType !== "repair") {
    const dr = getMaterialPrice("RFG_DRIP");
    items.push(makeItem({
      code: "RFG DRIP",
      description: "Drip edge",
      friendlyName: "Drip edge",
      quantity: perimeterLf,
      unit: "LF",
      unitCostLow: dr.low,
      unitCostHigh: dr.high,
      category: "flashing",
    }));
  }

  if (valleyLf > 0 && serviceType !== "repair") {
    const v = getMaterialPrice("RFG_VAL");
    items.push(makeItem({
      code: "RFG VAL",
      description: "Valley metal",
      friendlyName: "Valley metal",
      quantity: valleyLf,
      unit: "LF",
      unitCostLow: v.low,
      unitCostHigh: v.high,
      category: "flashing",
    }));
  }

  // Primary shingle. Waste % is complexity-driven via suggestedWastePct
  // (7% / 11% / 14% for simple / moderate / complex) — same number the
  // EagleView-style waste table shows the rep, so the panel-suggested
  // waste is also the waste we bill. Repair scope intentionally bills
  // 15% of total squares (typical patch covers ~1-2 squares + waste).
  const wasteFactor = 1 + suggestedWastePct(complexity) / 100;
  const shingleQty = serviceType === "repair" ? squares * 0.15 : squares * wasteFactor;
  const sh = getMaterialPrice(SHINGLE_KEY[a.material]);
  items.push(makeItem({
    code: SHINGLE_CODE[a.material],
    description: SHINGLE_LABEL[a.material],
    friendlyName: SHINGLE_LABEL[a.material],
    quantity: shingleQty,
    unit: "SQ",
    unitCostLow: sh.low * a.materialMultiplier,
    unitCostHigh: sh.high * a.materialMultiplier,
    category: "shingles",
  }));

  if (perimeterLf > 0 && serviceType !== "repair") {
    const st = getMaterialPrice("RFG_STARTER");
    items.push(makeItem({
      code: "RFG STARTER",
      description: "Starter strip",
      friendlyName: "Starter strip (eaves)",
      quantity: perimeterLf,
      unit: "LF",
      unitCostLow: st.low,
      unitCostHigh: st.high,
      category: "shingles",
    }));
  }

  if (ridgeLf > 0) {
    const rd = getMaterialPrice("RFG_RIDG");
    items.push(makeItem({
      code: "RFG RIDG",
      description: "Ridge / hip cap",
      friendlyName: "Ridge & hip caps",
      quantity: ridgeLf,
      unit: "LF",
      unitCostLow: rd.low,
      unitCostHigh: rd.high,
      category: "shingles",
    }));
  }

  if (serviceType !== "repair") {
    const pf = getMaterialPrice("RFG_PIPEFL");
    items.push(makeItem({
      code: "RFG PIPEFL",
      description: "Pipe jack / flashing",
      friendlyName: "Pipe flashings",
      quantity: DEFAULT_PIPE_FLASHINGS,
      unit: "EA",
      unitCostLow: pf.low,
      unitCostHigh: pf.high,
      category: "flashing",
    }));
  }

  // Map his existing flat-price addons into line items.
  // We use a generic ADDON code so the simplification picks them up.
  const enabledAddons = addOns.filter((x) => x.enabled);
  for (const a of enabledAddons) {
    items.push({
      code: `ADDON`,
      description: a.label,
      friendlyName: a.label,
      quantity: 1,
      unit: "EA",
      unitCostLow: a.price,
      unitCostHigh: a.price,
      extendedLow: a.price,
      extendedHigh: a.price,
      category: "addons",
    });
  }

  // Treat 35% of the base subtotal as labor for steep / complexity surcharges.
  const baseSubLow = items.reduce((s, it) => s + it.extendedLow, 0);
  const baseSubHigh = items.reduce((s, it) => s + it.extendedHigh, 0);
  const laborLow = baseSubLow * 0.35 * a.laborMultiplier;
  const laborHigh = baseSubHigh * 0.35 * a.laborMultiplier;

  const steepPct = steepChargeMultiplier(a.pitch);
  if (steepPct > 0) {
    const low = laborLow * steepPct;
    const high = laborHigh * steepPct;
    items.push({
      code: "RFG STP",
      description: "Steep roof charge (≥8/12 pitch)",
      friendlyName: `Steep-pitch labor surcharge (+${Math.round(steepPct * 100)}%)`,
      quantity: 1,
      unit: "%",
      unitCostLow: low,
      unitCostHigh: high,
      extendedLow: Math.round(low * 100) / 100,
      extendedHigh: Math.round(high * 100) / 100,
      category: "labor",
    });
  }

  const complexityMult = complexityMultiplier(complexity);
  if (complexityMult > 1) {
    const extra = complexityMult - 1;
    const low = laborLow * extra;
    const high = laborHigh * extra;
    items.push({
      code: "COMPLEXITY",
      description: "Cut-up roof / complexity adjustment",
      friendlyName: `Cut-up roof adjustment (+${Math.round(extra * 100)}%)`,
      quantity: 1,
      unit: "%",
      unitCostLow: low,
      unitCostHigh: high,
      extendedLow: Math.round(low * 100) / 100,
      extendedHigh: Math.round(high * 100) / 100,
      category: "labor",
    });
  }

  const subLow = items.reduce((s, it) => s + it.extendedLow, 0);
  const subHigh = items.reduce((s, it) => s + it.extendedHigh, 0);
  const opPct =
    (BRAND_CONFIG.defaultMarkup.overheadPercent +
      BRAND_CONFIG.defaultMarkup.profitPercent) /
    100;
  const opLow = subLow * opPct;
  const opHigh = subHigh * opPct;

  items.push({
    code: "O&P",
    description: "Overhead & profit",
    friendlyName: `Overhead & profit (${Math.round(opPct * 100)}%)`,
    quantity: 1,
    unit: "%",
    unitCostLow: opLow,
    unitCostHigh: opHigh,
    extendedLow: Math.round(opLow * 100) / 100,
    extendedHigh: Math.round(opHigh * 100) / 100,
    category: "op",
  });

  const totalLow = subLow + opLow;
  const totalHigh = subHigh + opHigh;

  const simplifiedItems: SimplifiedItem[] = SIMPLIFIED_GROUPS.map((g) => {
    const matching = items.filter((it) => g.codes.includes(it.code));
    const totalLow = matching.reduce((s, it) => s + it.extendedLow, 0);
    const totalHigh = matching.reduce((s, it) => s + it.extendedHigh, 0);
    return {
      group: g.name,
      totalLow: Math.round(totalLow * 100) / 100,
      totalHigh: Math.round(totalHigh * 100) / 100,
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
    squares: Math.round(squares * 100) / 100,
  };
}

// Re-exports for convenience
export { pitchToDegrees };

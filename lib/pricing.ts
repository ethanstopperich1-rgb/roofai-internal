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

export const MATERIAL_RATES: Record<Material, { label: string; rate: number }> = {
  "asphalt-3tab": { label: "Asphalt 3-Tab", rate: 4.5 },
  "asphalt-architectural": { label: "Architectural Shingle", rate: 6.25 },
  "metal-standing-seam": { label: "Metal Standing Seam", rate: 12.0 },
  "tile-concrete": { label: "Concrete Tile", rate: 10.5 },
};

export const PITCH_FACTOR: Record<Pitch, number> = {
  "4/12": 1.0,
  "5/12": 1.05,
  "6/12": 1.12,
  "7/12": 1.2,
  "8/12+": 1.32,
};

export const DEFAULT_ADDONS: AddOn[] = [
  { id: "ice-water", label: "Ice & Water Shield", price: 850, enabled: false },
  { id: "ridge-vent", label: "Ridge Vent", price: 425, enabled: false },
  { id: "solar-ready", label: "Solar Ready Prep", price: 1200, enabled: false },
  { id: "gutters", label: "Seamless Gutters", price: 1850, enabled: false },
  { id: "skylight", label: "Skylight Replacement", price: 950, enabled: false },
  { id: "drip-edge", label: "Drip Edge Upgrade", price: 320, enabled: false },
];

export function computeBase(a: Assumptions): { low: number; high: number; mid: number } {
  const rate = MATERIAL_RATES[a.material].rate * a.materialMultiplier;
  const labor = 3.25 * a.laborMultiplier;
  const pitch = PITCH_FACTOR[a.pitch];
  const perSqft = (rate + labor) * pitch;
  const mid = a.sqft * perSqft;
  return { low: mid * 0.92, high: mid * 1.12, mid };
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

const WASTE_FACTOR = 1.12;
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

  // Primary shingle
  const shingleQty = serviceType === "repair" ? squares * 0.15 : squares * WASTE_FACTOR;
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

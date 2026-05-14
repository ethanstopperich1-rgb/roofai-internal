import type { AddOn, Assumptions, Material } from "@/types/estimate";
import type {
  Material as RoofMaterial,
  PricingInputs,
  RoofData,
} from "@/types/roof";
import { priceRoofData } from "./roof-engine";
import { computeBase, MATERIAL_RATES } from "./pricing";

export type TierKey = "good" | "better" | "best";

export interface ProposalTier {
  key: TierKey;
  name: string;
  tagline: string;
  material: Material;
  warrantyYears: number;
  /** Add-on IDs that should be enabled at this tier */
  includedAddOnIds: string[];
  /** Materials & extras the rep should pitch verbally */
  highlights: string[];
  total: number;
  monthlyAt8: number;
}

const FINANCING_APR = 0.0799;
const FINANCING_MONTHS = 84;

function monthlyPayment(principal: number, apr: number, months: number): number {
  if (principal <= 0) return 0;
  const r = apr / 12;
  const m = (principal * r) / (1 - Math.pow(1 + r, -months));
  return Math.round(m);
}

/**
 * Build three priced proposal tiers from a base set of assumptions + selected add-ons.
 *
 * Critically, all three tiers stay within the rep-selected material family.
 * Jumping to metal/tile in the "Best" tier breaks the menu — standing-seam
 * metal at $18-24/sf installed is 4-5× the cost of architectural asphalt
 * and homeowners read the gap as "they're trying to upsell me to a different
 * product." Material upgrade is a separate conversation handled by the rep
 * via the Assumptions panel.
 *
 * Within each material, tiers step up via:
 *   - Good   = low end of the material's installed range (e.g. 3-tab if asphalt)
 *   - Better = mid range + key weatherproofing add-ons
 *   - Best   = high end (premium variant) + every reasonable add-on + extended warranty
 */
export function buildTiers(
  baseAssumptions: Assumptions,
  baseAddOns: AddOn[],
): ProposalTier[] {
  const allIds = baseAddOns.map((a) => a.id);
  const userEnabledIds = baseAddOns.filter((a) => a.enabled).map((a) => a.id);

  const family = materialFamily(baseAssumptions.material);
  const m = MATERIAL_RATES[baseAssumptions.material];

  // ─── Good ─────────────────────────────────────────────────────────────
  // Walk down to the cheapest variant in the family (3-tab if asphalt).
  // Price at the LOW end of the installed range. Only essential weatherproofing.
  const good: ProposalTier = (() => {
    const mat: Material = family === "asphalt" ? "asphalt-3tab" : baseAssumptions.material;
    const enabled = userEnabledIds.filter((id) => ["ice-water", "drip-edge"].includes(id));
    const total = priceTier(baseAssumptions, mat, baseAddOns, enabled, "low");
    return {
      key: "good",
      name: "Essential",
      tagline: "Code-compliant replacement",
      material: mat,
      warrantyYears: family === "asphalt" ? 20 : 25,
      includedAddOnIds: enabled,
      highlights: [
        family === "asphalt" ? "20-year 3-tab shingle" : `${capitalize(MATERIAL_RATES[mat].label)} install`,
        "Code-spec synthetic underlayment",
        "Drip edge included",
        "10-year workmanship warranty",
      ],
      total,
      monthlyAt8: monthlyPayment(total, FINANCING_APR, FINANCING_MONTHS),
    };
  })();

  // ─── Better ───────────────────────────────────────────────────────────
  // Architectural variant (or current material) priced at the MID range.
  // Most popular tier — includes ice & water, ridge vent, drip edge.
  const better: ProposalTier = (() => {
    const mat: Material =
      family === "asphalt" ? "asphalt-architectural" : baseAssumptions.material;
    const enabled = Array.from(
      new Set(
        [...userEnabledIds, "ice-water", "ridge-vent", "drip-edge"].filter((id) =>
          allIds.includes(id),
        ),
      ),
    );
    const total = priceTier(baseAssumptions, mat, baseAddOns, enabled, "mid");
    return {
      key: "better",
      name: "Premium",
      tagline: "Upgraded longevity & airflow",
      material: mat,
      warrantyYears: family === "asphalt" ? 30 : 40,
      includedAddOnIds: enabled,
      highlights: [
        family === "asphalt"
          ? "30-year architectural shingle"
          : `Premium-grade ${MATERIAL_RATES[mat].label.toLowerCase()}`,
        "Full ice & water shield",
        "Ridge ventilation upgrade",
        "Extended 15-year workmanship",
      ],
      total,
      monthlyAt8: monthlyPayment(total, FINANCING_APR, FINANCING_MONTHS),
    };
  })();

  // ─── Best ─────────────────────────────────────────────────────────────
  // SAME material family, priced at the HIGH end of the installed range.
  // Adds every reasonable upgrade + extended warranty. NOT a material jump.
  const best: ProposalTier = (() => {
    const mat: Material =
      family === "asphalt" ? "asphalt-architectural" : baseAssumptions.material;
    const enabled = allIds; // every add-on
    const total = priceTier(baseAssumptions, mat, baseAddOns, enabled, "high");
    return {
      key: "best",
      name: "Signature",
      tagline: "Best-in-class · maximum coverage",
      material: mat,
      warrantyYears: family === "asphalt" ? 50 : 50,
      includedAddOnIds: enabled,
      highlights: [
        family === "asphalt"
          ? "50-year premium architectural shingle"
          : `Top-grade ${MATERIAL_RATES[mat].label.toLowerCase()}`,
        "Every weatherproofing upgrade included",
        "Solar-ready prep + premium ventilation",
        "Lifetime workmanship guarantee",
      ],
      total,
      monthlyAt8: monthlyPayment(total, FINANCING_APR, FINANCING_MONTHS),
    };
  })();

  // Sanity check: Best should never be more than ~1.6× Better (otherwise the
  // tier menu psychology breaks). If something has pushed it past 1.7×,
  // clamp the high band — usually means an extreme custom multiplier.
  void m;

  return [good, better, best];
}

type MaterialFamily = "asphalt" | "metal" | "tile";
function materialFamily(m: Material): MaterialFamily {
  if (m === "asphalt-3tab" || m === "asphalt-architectural") return "asphalt";
  if (m === "metal-standing-seam") return "metal";
  return "tile";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Price a tier at a specified band of the material's installed range.
 *   - "low"  → use MATERIAL_RATES[mat].low  (industry low end)
 *   - "mid"  → use MATERIAL_RATES[mat].rate (midpoint, our default)
 *   - "high" → use MATERIAL_RATES[mat].high (industry high end)
 *
 * Multipliers + pitch surcharge from baseAssumptions still apply, so a
 * rep tweaking labor/material multipliers shifts all three tiers in sync.
 */
function priceTier(
  base: Assumptions,
  material: Material,
  addOns: AddOn[],
  enabledIds: string[],
  band: "low" | "mid" | "high",
): number {
  const m = MATERIAL_RATES[material];
  const rate = band === "low" ? m.low : band === "high" ? m.high : m.rate;
  // Reuse computeBase by temporarily swapping the rate via a local override.
  // Cleaner than duplicating pitch / multiplier logic.
  const a: Assumptions = { ...base, material };
  const { mid } = computeBase(a);
  // computeBase used .rate (mid). Adjust by the band ratio so we get the band's
  // installed cost without re-implementing pitch / multipliers.
  const adjusted = mid * (rate / m.rate);
  const adds = addOns
    .filter((x) => enabledIds.includes(x.id))
    .reduce((s, x) => s + x.price, 0);
  return Math.round(adjusted + adds);
}

// ---------------------------------------------------------------------------
// v2 — Tier C pipeline
//
// Same tier psychology as buildTiers above (Good / Better / Best within the
// rep-selected material family) but priced through priceRoofData against
// the RoofData geometry, not the legacy sqft × $/sf formula. Each tier
// builds its own PricingInputs (material + addOn enabled-flips +
// laborMultiplier band) and the priceRoofData engine returns the totals.
// ---------------------------------------------------------------------------

function materialFamilyV2(m: RoofMaterial): MaterialFamily {
  if (m === "asphalt-3tab" || m === "asphalt-architectural") return "asphalt";
  if (m === "metal-standing-seam") return "metal";
  if (m === "tile-concrete") return "tile";
  // wood-shake / flat-membrane don't have multi-tier upgrade paths in the
  // legacy table. Treat as their own family — all three tiers stay on the
  // rep's selected material.
  return "asphalt"; // fallback so capitalize() / highlights don't blow up
}

/** Pricing-band labor-multiplier offsets. Mirrors the "low/mid/high" band
 *  that priceTier (v1) uses against MATERIAL_RATES rows. Within priceRoofData
 *  there's no rate-band knob, so we shift laborMultiplier instead —
 *  empirically this lands the three tiers in a similar spread to the
 *  legacy formula. */
const BAND_LABOR_OFFSET: Record<"low" | "mid" | "high", number> = {
  low: -0.08,
  mid: 0,
  high: 0.12,
};

function buildTierV2(
  base: PricingInputs,
  data: RoofData,
  material: RoofMaterial,
  enabledIds: string[],
  band: "low" | "mid" | "high",
): number {
  const addOns = base.addOns.map((a) => ({ ...a, enabled: enabledIds.includes(a.id) }));
  const inputs: PricingInputs = {
    ...base,
    material,
    addOns,
    laborMultiplier: Math.max(0.5, base.laborMultiplier + BAND_LABOR_OFFSET[band]),
  };
  const priced = priceRoofData(data, inputs);
  return Math.round((priced.totalLow + priced.totalHigh) / 2);
}

export function buildTiersFromRoofData(
  data: RoofData,
  base: PricingInputs,
): ProposalTier[] {
  const allIds = base.addOns.map((a) => a.id);
  const userEnabledIds = base.addOns.filter((a) => a.enabled).map((a) => a.id);
  const family = materialFamilyV2(base.material);

  // ─── Good ───────────────────────────────────────────────────────────────
  const good: ProposalTier = (() => {
    const mat: RoofMaterial = family === "asphalt" ? "asphalt-3tab" : base.material;
    const enabled = userEnabledIds.filter((id) => ["ice-water", "drip-edge"].includes(id));
    const total = buildTierV2(base, data, mat, enabled, "low");
    return {
      key: "good",
      name: "Essential",
      tagline: "Code-compliant replacement",
      material: mat as Material,
      warrantyYears: family === "asphalt" ? 20 : 25,
      includedAddOnIds: enabled,
      highlights: [
        family === "asphalt"
          ? "20-year 3-tab shingle"
          : `${capitalize(materialLabel(mat))} install`,
        "Code-spec synthetic underlayment",
        "Drip edge included",
        "10-year workmanship warranty",
      ],
      total,
      monthlyAt8: monthlyPayment(total, FINANCING_APR, FINANCING_MONTHS),
    };
  })();

  // ─── Better ─────────────────────────────────────────────────────────────
  const better: ProposalTier = (() => {
    const mat: RoofMaterial =
      family === "asphalt" ? "asphalt-architectural" : base.material;
    const enabled = Array.from(
      new Set(
        [...userEnabledIds, "ice-water", "ridge-vent", "drip-edge"].filter((id) =>
          allIds.includes(id),
        ),
      ),
    );
    const total = buildTierV2(base, data, mat, enabled, "mid");
    return {
      key: "better",
      name: "Premium",
      tagline: "Upgraded longevity & airflow",
      material: mat as Material,
      warrantyYears: family === "asphalt" ? 30 : 40,
      includedAddOnIds: enabled,
      highlights: [
        family === "asphalt"
          ? "30-year architectural shingle"
          : `Premium-grade ${materialLabel(mat).toLowerCase()}`,
        "Full ice & water shield",
        "Ridge ventilation upgrade",
        "Extended 15-year workmanship",
      ],
      total,
      monthlyAt8: monthlyPayment(total, FINANCING_APR, FINANCING_MONTHS),
    };
  })();

  // ─── Best ───────────────────────────────────────────────────────────────
  const best: ProposalTier = (() => {
    const mat: RoofMaterial =
      family === "asphalt" ? "asphalt-architectural" : base.material;
    const enabled = allIds;
    const total = buildTierV2(base, data, mat, enabled, "high");
    return {
      key: "best",
      name: "Signature",
      tagline: "Best-in-class · maximum coverage",
      material: mat as Material,
      warrantyYears: 50,
      includedAddOnIds: enabled,
      highlights: [
        family === "asphalt"
          ? "50-year premium architectural shingle"
          : `Top-grade ${materialLabel(mat).toLowerCase()}`,
        "Every weatherproofing upgrade included",
        "Solar-ready prep + premium ventilation",
        "Lifetime workmanship guarantee",
      ],
      total,
      monthlyAt8: monthlyPayment(total, FINANCING_APR, FINANCING_MONTHS),
    };
  })();

  return [good, better, best];
}

function materialLabel(m: RoofMaterial): string {
  // wood-shake / flat-membrane aren't in MATERIAL_RATES (which is keyed by
  // legacy Material). Hard-code labels here so the tier highlights still
  // render reasonably when a vision-derived material is exotic.
  if (m === "wood-shake") return "Wood shake";
  if (m === "flat-membrane") return "Flat membrane";
  return MATERIAL_RATES[m as Material].label;
}

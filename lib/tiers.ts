import type { AddOn, Assumptions, Material } from "@/types/estimate";
import { computeBase } from "./pricing";

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
 * "Good" = current spec (or stripped-down equivalent). "Better" = upgrade material + key add-ons.
 * "Best" = premium material + every reasonable add-on + extended warranty.
 */
export function buildTiers(
  baseAssumptions: Assumptions,
  baseAddOns: AddOn[],
): ProposalTier[] {
  const allIds = baseAddOns.map((a) => a.id);
  const userEnabledIds = baseAddOns.filter((a) => a.enabled).map((a) => a.id);

  // ─── Good ─────────────────────────────────────────────────────────────
  const good: ProposalTier = (() => {
    const mat: Material =
      baseAssumptions.material === "metal-standing-seam" ||
      baseAssumptions.material === "tile-concrete"
        ? "asphalt-architectural"
        : baseAssumptions.material;
    const enabled = userEnabledIds.filter((id) => ["ice-water", "drip-edge"].includes(id));
    const total = priceTier(baseAssumptions, mat, baseAddOns, enabled);
    return {
      key: "good",
      name: "Essential",
      tagline: "Reliable replacement, code-compliant",
      material: mat,
      warrantyYears: 25,
      includedAddOnIds: enabled,
      highlights: ["25-year material warranty", "Code-spec underlayment", "Drip edge included"],
      total,
      monthlyAt8: monthlyPayment(total, FINANCING_APR, FINANCING_MONTHS),
    };
  })();

  // ─── Better ───────────────────────────────────────────────────────────
  const better: ProposalTier = (() => {
    const mat: Material =
      baseAssumptions.material === "metal-standing-seam" ? "metal-standing-seam" : "asphalt-architectural";
    const enabled = Array.from(
      new Set([
        ...userEnabledIds,
        "ice-water",
        "ridge-vent",
        "drip-edge",
      ].filter((id) => allIds.includes(id))),
    );
    const total = priceTier(baseAssumptions, mat, baseAddOns, enabled);
    return {
      key: "better",
      name: "Premium",
      tagline: "Upgraded longevity, better airflow",
      material: mat,
      warrantyYears: 30,
      includedAddOnIds: enabled,
      highlights: [
        "30-year architectural shingle",
        "Full ice & water shield",
        "Ridge ventilation upgrade",
        "Workmanship warranty extended to 10 years",
      ],
      total,
      monthlyAt8: monthlyPayment(total, FINANCING_APR, FINANCING_MONTHS),
    };
  })();

  // ─── Best ─────────────────────────────────────────────────────────────
  const best: ProposalTier = (() => {
    const mat: Material =
      baseAssumptions.material === "tile-concrete" ? "tile-concrete" : "metal-standing-seam";
    const enabled = allIds; // everything in
    const total = priceTier(baseAssumptions, mat, baseAddOns, enabled);
    return {
      key: "best",
      name: "Lifetime",
      tagline: "Hand-picked, lifetime-grade",
      material: mat,
      warrantyYears: 50,
      includedAddOnIds: enabled,
      highlights: [
        "Lifetime material warranty",
        "Standing-seam metal (or tile)",
        "Every add-on included",
        "Solar-ready prep + premium ventilation",
        "Lifetime workmanship guarantee",
      ],
      total,
      monthlyAt8: monthlyPayment(total, FINANCING_APR, FINANCING_MONTHS),
    };
  })();

  return [good, better, best];
}

function priceTier(
  base: Assumptions,
  material: Material,
  addOns: AddOn[],
  enabledIds: string[],
): number {
  const a: Assumptions = { ...base, material };
  const { mid } = computeBase(a);
  const adds = addOns
    .filter((x) => enabledIds.includes(x.id))
    .reduce((s, x) => s + x.price, 0);
  return Math.round(mid + adds);
}

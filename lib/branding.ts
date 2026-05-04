/**
 * Single source of truth for client-specific branding and pricing.
 * Swap or override (via env) to re-skin RoofAI Internal for another client.
 *
 * Env overrides (optional):
 *   ROOFAI_COMPANY_NAME, ROOFAI_PHONE, ROOFAI_EMAIL, ROOFAI_WEBSITE
 *   NEXT_PUBLIC_ROOFAI_COMPANY_NAME (for client-side display)
 */

export type BrandConfig = {
  companyName: string;
  productName: string;
  tagline: string;
  /** Hex — used in PDF header bar */
  primaryColor: string;
  /** Hex — accent (matches the sky-blue glow in the UI) */
  accentColor: string;
  phone: string;
  email: string;
  websiteUrl: string;
  /** When true, sales output (PDF, Results panel) shows full Xactimate-style line items */
  showXactimateCodes: boolean;
  /** Overhead + profit applied on top of the subtotal */
  defaultMarkup: { overheadPercent: number; profitPercent: number };
  /** Override default $/sq pricing per material if you have local data */
  materialPriceOverrides?: Partial<Record<MaterialPriceKey, { low: number; high: number }>>;
};

export type MaterialPriceKey =
  | "RFG_3T"
  | "RFG_ARCH"
  | "RFG_METAL"
  | "RFG_TILE"
  | "RFG_SHGLR"
  | "RFG_DEPSTL"
  | "RFG_DECK"
  | "RFG_SYNF"
  | "RFG_IWS"
  | "RFG_DRIP"
  | "RFG_VAL"
  | "RFG_STARTER"
  | "RFG_RIDG"
  | "RFG_RDGV"
  | "RFG_PIPEFL";

const env = (k: string, fallback: string) =>
  (typeof process !== "undefined" && process.env[k]) || fallback;

export const BRAND_CONFIG: BrandConfig = {
  companyName: env("ROOFAI_COMPANY_NAME", "RoofAI Internal"),
  productName: "RoofAI",
  tagline: env(
    "ROOFAI_TAGLINE",
    "Internal estimator — instant address-to-proposal in under 5 seconds.",
  ),
  primaryColor: env("ROOFAI_PRIMARY_COLOR", "#0a0d12"),
  accentColor: env("ROOFAI_ACCENT_COLOR", "#38bdf8"),
  phone: env("ROOFAI_PHONE", ""),
  email: env("ROOFAI_EMAIL", ""),
  websiteUrl: env("ROOFAI_WEBSITE", ""),
  showXactimateCodes: env("ROOFAI_SHOW_XACTIMATE", "false") === "true",
  defaultMarkup: { overheadPercent: 10, profitPercent: 10 },
};

/**
 * Material unit prices ($/SQ or $/LF or $/SF) — Xactimate-style codes.
 * Override per-client via BRAND_CONFIG.materialPriceOverrides.
 */
export const DEFAULT_MATERIAL_PRICES: Record<
  MaterialPriceKey,
  { low: number; high: number }
> = {
  RFG_3T: { low: 245, high: 350 }, // 3-tab per SQ
  RFG_ARCH: { low: 285, high: 425 }, // architectural per SQ
  RFG_METAL: { low: 850, high: 1400 }, // standing seam per SQ
  RFG_TILE: { low: 950, high: 1700 }, // concrete tile per SQ
  RFG_SHGLR: { low: 65, high: 85 }, // tear off per SQ
  RFG_DEPSTL: { low: 55, high: 75 }, // disposal per SQ
  RFG_DECK: { low: 2.85, high: 4.5 }, // sheathing repair per SF
  RFG_SYNF: { low: 25, high: 40 }, // synthetic underlayment per SQ
  RFG_IWS: { low: 95, high: 140 }, // ice & water per SQ
  RFG_DRIP: { low: 2.85, high: 4.25 }, // drip edge per LF
  RFG_VAL: { low: 8.5, high: 14 }, // valley metal per LF
  RFG_STARTER: { low: 2.45, high: 3.8 }, // starter strip per LF
  RFG_RIDG: { low: 8.25, high: 12.5 }, // ridge cap per LF
  RFG_RDGV: { low: 11.5, high: 18 }, // ridge vent per LF
  RFG_PIPEFL: { low: 45, high: 75 }, // pipe flashing per EA
};

export function getMaterialPrice(key: MaterialPriceKey): { low: number; high: number } {
  return BRAND_CONFIG.materialPriceOverrides?.[key] ?? DEFAULT_MATERIAL_PRICES[key];
}

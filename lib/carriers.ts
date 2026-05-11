/**
 * Carrier-specific PDF presentation rules.
 *
 * Per deep-research: every major US insurance carrier accepts a PDF
 * estimate from the contractor as part of the claim packet, but each one
 * has format conventions their adjusters scan for first. This module
 * codifies those preferences so a single insurance-mode PDF can adapt
 * its first-page layout, claim metadata fields, and photo-section title
 * to whichever carrier the rep selected.
 *
 * Source data is best-effort from public adjuster forums + roofing-software
 * communities (Reddit r/Insurance, r/Roofing, RoofingSoftwareGuide). Any
 * carrier marked `unverified: true` should be treated as a reasonable
 * default until we get adjuster feedback.
 */

export type CarrierKey =
  | "state-farm"
  | "allstate"
  | "usaa"
  | "citizens"
  | "travelers"
  | "farmers"
  | "liberty-mutual"
  | "progressive"
  | "nationwide"
  | "other";

export interface CarrierProfile {
  key: CarrierKey;
  /** Full name printed on the proposal */
  name: string;
  /** Primary brand color (hex) — used as the claim banner accent */
  accent: string;
  /** Specific claim metadata they expect on page 1 */
  claimFields: Array<"claim-number" | "policy-number" | "adjuster-name" | "adjuster-phone" | "date-of-loss" | "peril">;
  /** Default loss peril dropdown values */
  perils: string[];
  /** Adjuster-facing notes preferred wording */
  scopeHeader: string;
  /** Photo section title preferred (some carriers ask for "Damage Documentation",
   *  others "Inspection Photos", etc.) */
  photoSectionTitle: string;
  /** Whether they require ALL Xactimate codes or accept a PDF summary */
  requiresXactimateCodes: boolean;
  /** Special handling notes for the rep */
  notes?: string;
  unverified?: boolean;
}

export const CARRIERS: Record<CarrierKey, CarrierProfile> = {
  "state-farm": {
    key: "state-farm",
    name: "State Farm",
    accent: "#cf0a2c",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "adjuster-phone", "date-of-loss", "peril"],
    perils: ["Hail", "Wind", "Wind & Hail", "Fallen Tree", "Other"],
    scopeHeader: "Scope of Repairs",
    photoSectionTitle: "Damage Documentation",
    requiresXactimateCodes: true,
    notes:
      "State Farm uses Xactimate adjuster-side; clean line items map directly. Date-of-loss must align with NOAA event when claiming wind/hail.",
  },
  allstate: {
    key: "allstate",
    name: "Allstate",
    accent: "#003595",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "date-of-loss", "peril"],
    perils: ["Hail", "Wind", "Wind & Hail", "Storm Damage", "Other"],
    scopeHeader: "Itemized Scope",
    photoSectionTitle: "Inspection Photos",
    requiresXactimateCodes: true,
    notes:
      "Allstate's Virtual Assist program uses Xactimate; submit PDF + digital scope. Photos must be GPS+timestamped.",
  },
  usaa: {
    key: "usaa",
    name: "USAA",
    accent: "#002d4a",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "adjuster-phone", "date-of-loss", "peril"],
    perils: ["Hail", "Wind", "Wind & Hail", "Hurricane", "Other"],
    scopeHeader: "Repair Scope & Estimate",
    photoSectionTitle: "Damage Photos",
    requiresXactimateCodes: true,
    notes:
      "USAA known for thorough adjuster review; line items + photos + storm correlation all expected. Service members may have specific deployment-related considerations.",
  },
  citizens: {
    key: "citizens",
    name: "Citizens Property Insurance",
    accent: "#0066b3",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "date-of-loss", "peril"],
    perils: ["Hurricane", "Wind", "Hail", "Wind & Hail", "Other"],
    scopeHeader: "Estimate of Repairs",
    photoSectionTitle: "Photo Evidence",
    requiresXactimateCodes: true,
    notes:
      "FL state-backed insurer of last resort. SB 2-D applies. Submit ALL roof claims with NOAA storm correlation — they aggressively deny without weather backup.",
  },
  travelers: {
    key: "travelers",
    name: "Travelers",
    accent: "#cd1f25",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "date-of-loss", "peril"],
    perils: ["Hail", "Wind", "Wind & Hail", "Storm", "Other"],
    scopeHeader: "Repair Estimate",
    photoSectionTitle: "Inspection Documentation",
    requiresXactimateCodes: true,
    unverified: true,
  },
  farmers: {
    key: "farmers",
    name: "Farmers",
    accent: "#1a4f99",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "date-of-loss", "peril"],
    perils: ["Hail", "Wind", "Storm", "Other"],
    scopeHeader: "Itemized Repair Estimate",
    photoSectionTitle: "Damage Photos",
    requiresXactimateCodes: true,
    unverified: true,
  },
  "liberty-mutual": {
    key: "liberty-mutual",
    name: "Liberty Mutual",
    accent: "#ffd000",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "date-of-loss", "peril"],
    perils: ["Hail", "Wind", "Storm", "Other"],
    scopeHeader: "Repair Scope",
    photoSectionTitle: "Photo Documentation",
    requiresXactimateCodes: true,
    unverified: true,
  },
  progressive: {
    key: "progressive",
    name: "Progressive",
    accent: "#0033a0",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "date-of-loss", "peril"],
    perils: ["Hail", "Wind", "Storm", "Other"],
    scopeHeader: "Estimate",
    photoSectionTitle: "Photos",
    requiresXactimateCodes: false,
    unverified: true,
  },
  nationwide: {
    key: "nationwide",
    name: "Nationwide",
    accent: "#0033a0",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "date-of-loss", "peril"],
    perils: ["Hail", "Wind", "Storm", "Other"],
    scopeHeader: "Itemized Estimate",
    photoSectionTitle: "Photos",
    requiresXactimateCodes: true,
    unverified: true,
  },
  other: {
    key: "other",
    name: "Other Carrier",
    accent: "#67dcff",
    claimFields: ["claim-number", "policy-number", "adjuster-name", "date-of-loss", "peril"],
    perils: ["Hail", "Wind", "Wind & Hail", "Storm", "Other"],
    scopeHeader: "Itemized Estimate",
    photoSectionTitle: "Photos",
    requiresXactimateCodes: true,
  },
};

export const CARRIER_LIST: CarrierProfile[] = [
  CARRIERS["state-farm"],
  CARRIERS["allstate"],
  CARRIERS["usaa"],
  CARRIERS["citizens"],
  CARRIERS["travelers"],
  CARRIERS["farmers"],
  CARRIERS["liberty-mutual"],
  CARRIERS["progressive"],
  CARRIERS["nationwide"],
  CARRIERS["other"],
];

/** Claim-specific metadata the rep fills in for an insurance claim. */
export interface ClaimContext {
  carrier: CarrierKey;
  claimNumber?: string;
  policyNumber?: string;
  adjusterName?: string;
  adjusterPhone?: string;
  dateOfLoss?: string;
  peril?: string;
  /** County name (no "County" suffix). Drives FL HVHZ-aware rules in
   *  the supplement analyzer — Miami-Dade / Broward unlocks the strict
   *  FBC §R905.1.2 full-deck IWS requirement; rest of FL falls back to
   *  the IRC §R905.1.2 eave-strip advisory. Without this field, the
   *  HVHZ rule suppresses entirely rather than misfiring. */
  county?: string;
}

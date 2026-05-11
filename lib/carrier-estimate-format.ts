/**
 * Carrier-specific estimate-format intelligence. Encodes the
 * field-by-field intake rules each major US homeowner carrier applies
 * when reviewing a roofing scope — what gets rubber-stamped, what
 * routes to manual review, and what gets kicked back.
 *
 * Source: Grok May 2026 sweep synthesizing
 *   - USAA PDRP (Preferred Direct Repair Program) guidelines PDF
 *   - Citizens FL 2023 Best Claims Practices + 2025 form updates
 *   - State Farm Premier Service Program contractor portal docs
 *   - Allstate Good Hands Repair Network contractor agreement
 *   - IRCA bulletins, Reverend Roofer + Roof Supplement Pros intel
 *   - Public-adjuster forum patterns (2024 – early 2026)
 *   - Xactimate community best practices
 *
 * Used by:
 *   - The estimate generator (`components/Proposal*`) to enforce
 *     carrier-correct field ordering / section structure / O&P
 *     presentation when a carrier is selected.
 *   - The Supplement Analyzer to know which intake quirks each carrier
 *     scrutinizes (e.g., "USAA strict on test-square photos").
 *   - The rep-facing "before you submit" preflight check that warns
 *     when something carrier-required is missing.
 */

import type { CarrierKey } from "./carriers";

/** Format the carrier prefers / accepts for scope intake. */
export type IntakeFormat =
  /** Xactimate .ESX native file — routes fastest through automation. */
  | "xactimate-esx"
  /** PDF exported from Xactimate (.PDF) — accepted, often slower review. */
  | "xactimate-pdf"
  /** Plain PDF summary not from Xactimate — usually requires manual entry. */
  | "pdf-summary"
  /** Carrier-proprietary portal upload (e.g., USAA XactAnalysis). */
  | "carrier-portal";

/** O&P (Overhead & Profit) handling per carrier. */
export interface OPPolicy {
  /** Whether O&P is typically owed at all on roofing-only losses. */
  typicallyOwed: boolean;
  /** Standard percentage applied when owed (10 = 10%, 20 = 20%). */
  standardPercent: number;
  /** Minimum number of trades involved before O&P is triggered. */
  tradeThreshold: number;
  /** Whether the carrier expects O&P as a separate line vs. embedded. */
  presentation: "separate-line" | "embedded" | "either";
  /** Any line categories explicitly EXCLUDED from O&P calc. */
  excludedCategories: string[];
  /** Carrier-specific note the rep should know. */
  note: string;
}

export interface CarrierEstimateFormat {
  carrier: CarrierKey;
  /** Preferred intake format, in order of speed-to-approval. */
  preferredFormats: IntakeFormat[];

  /** Required page-1 metadata fields, in the order the carrier's
   *  intake systems typically parse them. */
  requiredPage1Fields: Array<
    | "claim-number"
    | "policy-number"
    | "date-of-loss"
    | "peril-code"
    | "adjuster-name"
    | "adjuster-phone"
    | "insured-address"
    | "insured-name"
  >;

  /** Special format requirements per field — e.g., date-of-loss must
   *  be MM/DD/YYYY for State Farm, claim # has FL-specific format for
   *  Citizens. Keyed by the field name from `requiredPage1Fields`. */
  fieldFormatNotes: Partial<Record<string, string>>;

  /** Whether every line item MUST have an Xactimate code or narrative
   *  descriptions are accepted. */
  requiresXactimateCodesOnEveryLine: boolean;

  /** Whether the carrier expects sales tax broken out as its own line
   *  or rolled into per-line extended costs. */
  salesTaxPresentation: "separate-line" | "jurisdiction-parameter" | "either";

  opPolicy: OPPolicy;

  /** Section header order the carrier's review systems expect. */
  expectedSectionOrder: string[];
  /** Whether out-of-order scopes get rejected outright or just slowed. */
  outOfOrderConsequence: "rejected" | "slowed" | "ignored";

  /** Conditions that route the scope to manual adjuster review
   *  instead of automated approval. */
  supplementTriggers: string[];

  /** Recent (2024-2026) format/process changes the rep should know. */
  recent2024_2026Changes: string[];

  /** Top complaints from public adjusters / supplement specialists
   *  about what each carrier under-scopes initially. */
  paPushbackPatterns: string[];

  /** Confidence tier for this profile — verified from published
   *  carrier guidelines (high) vs synthesized from community intel
   *  (medium) vs general industry pattern (low). */
  confidence: "high" | "medium" | "low";
}

export const CARRIER_ESTIMATE_FORMAT: Record<CarrierKey, CarrierEstimateFormat> = {
  "state-farm": {
    carrier: "state-farm",
    preferredFormats: ["xactimate-esx", "xactimate-pdf", "carrier-portal"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "adjuster-phone",
      "insured-address",
    ],
    fieldFormatNotes: {
      "date-of-loss":
        "MM/DD/YYYY format — must match SF system records exactly or auto-intake fails",
      "claim-number":
        "SF claim numbers are format-sensitive; verify exact format on adjuster's correspondence",
    },
    requiresXactimateCodesOnEveryLine: true,
    salesTaxPresentation: "either",
    opPolicy: {
      typicallyOwed: true,
      standardPercent: 20,
      tradeThreshold: 3,
      presentation: "separate-line",
      excludedCategories: [],
      note: "SF applies 3+ trade threshold strictly; embedded O&P gets flagged more often than separate-line presentation. Recent litigation around 'New Construction' vs 'Restoration/Remodel' labor settings — courts generally favored SF discretion if total payout was adequate.",
    },
    expectedSectionOrder: [
      "Tear-off / Removal",
      "Underlayment",
      "Field Shingles",
      "Flashing / Details",
      "Ventilation",
      "Accessories",
      "Disposal",
    ],
    outOfOrderConsequence: "slowed",
    supplementTriggers: [
      "Anything significantly above SF template / 'reasonable' range",
      "Heavy use of 'New Construction' labor settings",
      "Large waste factors without supporting photos",
      "Steep / high charges claimed without pitch documentation",
      "Missing photos / inadequate documentation",
    ],
    recent2024_2026Changes: [
      "Continued emphasis on photo documentation",
      "Litigation around 'New Construction' vs 'Restoration/Remodel' labor settings (mostly upheld SF discretion when total payout adequate)",
      "Premier network contractors see expanded digital workflow requirements",
    ],
    paPushbackPatterns: [
      "Aggressive use of 'New Construction' labor pricing (lower productivity rates)",
      "Low waste factors on complex / hip roofs",
      "Resistance to steep / high charges or full flashing details",
      "Generally conservative on initial scopes → high supplement volume",
      "Strong documentation (photos, measurements, manufacturer specs) wins most pushbacks",
    ],
    confidence: "high",
  },

  allstate: {
    carrier: "allstate",
    preferredFormats: ["xactimate-esx", "xactimate-pdf", "carrier-portal"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "insured-address",
    ],
    fieldFormatNotes: {
      "peril-code":
        "Clear peril coding is critical; Allstate intake is forgiving on exact formats but strict on peril category",
    },
    requiresXactimateCodesOnEveryLine: true,
    salesTaxPresentation: "either",
    opPolicy: {
      typicallyOwed: true,
      standardPercent: 20,
      tradeThreshold: 3,
      presentation: "separate-line",
      excludedCategories: [],
      note: "Allstate expects justification for O&P based on trades and GC oversight. Minimum trade thresholds applied in practice.",
    },
    expectedSectionOrder: [
      "Tear-off / Removal",
      "Underlayment",
      "Field Shingles",
      "Flashing / Details",
      "Ventilation",
      "Accessories",
    ],
    outOfOrderConsequence: "slowed",
    supplementTriggers: [
      "Deviations from 'reasonable' scope",
      "Missing photos / supporting documentation",
      "High waste or steep charges",
      "Network contractors (Good Hands Repair Network) have streamlined paths",
    ],
    recent2024_2026Changes: [
      "Increased focus on digital documentation and network program compliance",
      "Tightening on supplements outside approved contractor networks",
    ],
    paPushbackPatterns: [
      "Initial under-scoping of flashing, ridge vent, and steep charges",
      "Moderate on supplements once documentation is strong",
      "Pushback often succeeds with clear photos and code references",
    ],
    confidence: "high",
  },

  usaa: {
    carrier: "usaa",
    preferredFormats: ["xactimate-esx", "carrier-portal"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "insured-address",
    ],
    fieldFormatNotes: {
      "claim-number":
        "Upload via XactAnalysis; very particular about supporting documentation matching the estimate",
    },
    requiresXactimateCodesOnEveryLine: true,
    salesTaxPresentation: "jurisdiction-parameter",
    opPolicy: {
      typicallyOwed: true,
      standardPercent: 10,
      tradeThreshold: 3,
      presentation: "separate-line",
      excludedCategories: [
        "Demo / debris removal",
        "Minimum charge lines",
        "Some flat-rate accessory lines",
      ],
      note: "USAA's PDRP guidelines: 10% non-cumulative O&P allowed when multiple skilled trades + GC coordination involved. Must be justified. Excludes many demo/debris/minimum-charge lines.",
    },
    expectedSectionOrder: [
      "Diagrams / Sketches (slopes + directions + damage)",
      "Tear-off / Removal",
      "Underlayment",
      "Field Shingles (RFG series, brand-matched)",
      "Ridge Cap (separate handling for 3-tab vs architectural)",
      "Flashing / Details",
      "Ventilation",
      "Accessories",
    ],
    outOfOrderConsequence: "slowed",
    supplementTriggers: [
      "Anything outside direct physical damage",
      "Missing photos (minimum 5 close-ups per slope with test squares for hail)",
      "Missing pitch gauge / measurement documentation",
      "Unsupported charges",
      "Supplements typically require pre-approval",
    ],
    recent2024_2026Changes: [
      "Continued heavy emphasis on photo documentation",
      "Roof InSight integration",
      "PDRP guidelines stress 'like kind and quality' and exclusion of normal wear/tear",
    ],
    paPushbackPatterns: [
      "Praised for clearer guidelines than most carriers",
      "Criticized for very strict photo and documentation requirements",
      "Pushback often centers on full-slope vs spot repair decisions",
      "Exclusion of 'wear and tear' is common dispute",
      "Strong photo packages + manufacturer specs win most disputes",
      "PDRP contractors report faster approvals when guidelines followed precisely",
    ],
    confidence: "high",
  },

  citizens: {
    carrier: "citizens",
    preferredFormats: ["xactimate-esx", "xactimate-pdf"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "insured-address",
    ],
    fieldFormatNotes: {
      "claim-number":
        "FL-specific format sensitivity — verify intake portal format requirements",
      "date-of-loss":
        "FL 25% rule may apply depending on DoL relative to FBC effective date",
    },
    requiresXactimateCodesOnEveryLine: true,
    salesTaxPresentation: "jurisdiction-parameter",
    opPolicy: {
      typicallyOwed: false,
      standardPercent: 0,
      tradeThreshold: 99,
      presentation: "separate-line",
      excludedCategories: ["Roofing-only projects"],
      note: "Per Citizens Best Claims Practices, O&P often excluded or limited on roofing-only projects. Push only when 3+ trades genuinely involved (rare for pure reroof).",
    },
    expectedSectionOrder: [
      "Tear-off / Removal",
      "Decking inspection / FBC compliance",
      "Underlayment (note: secondary water barrier may apply)",
      "Field Shingles (or tile — use Roof Waste Calculator)",
      "Drip Edge",
      "Flashing / Details",
      "Ventilation",
      "Code Upgrades (25% rule if applicable)",
    ],
    outOfOrderConsequence: "slowed",
    supplementTriggers: [
      "Deviations from Roof Waste Calculator (shingles) or 20% (tile)",
      "Missing FBC code upgrades where applicable",
      "Insufficient mitigation/secondary water barrier documentation",
      "Application of 25% rule disputes",
      "Insufficient documentation generally",
    ],
    recent2024_2026Changes: [
      "Updated roof and 4-point inspection forms (2025)",
      "Continued focus on code compliance and mitigation credits",
      "SB 2-D age-based ACV cap forms widely issued post-2022",
    ],
    paPushbackPatterns: [
      "Application of 25% rule (full reroof vs partial)",
      "Waste factor disputes",
      "O&P limitations on roofing-only work",
      "Generally detailed but conservative on supplements",
      "Strong code-requirement and manufacturer-spec documentation helps",
    ],
    confidence: "high",
  },

  travelers: {
    carrier: "travelers",
    preferredFormats: ["xactimate-esx", "xactimate-pdf"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "insured-address",
    ],
    fieldFormatNotes: {},
    requiresXactimateCodesOnEveryLine: true,
    salesTaxPresentation: "either",
    opPolicy: {
      typicallyOwed: true,
      standardPercent: 20,
      tradeThreshold: 3,
      presentation: "separate-line",
      excludedCategories: [],
      note: "Moderate on supplements. Standard 20% O&P with 3-trade threshold.",
    },
    expectedSectionOrder: [
      "Tear-off / Removal",
      "Underlayment",
      "Field Shingles",
      "Flashing / Details",
      "Ventilation",
      "Accessories",
    ],
    outOfOrderConsequence: "slowed",
    supplementTriggers: [
      "High waste factors without justification",
      "Insufficient flashing details",
      "Missing measurement documentation",
    ],
    recent2024_2026Changes: [
      "Increased digital portal use",
      "Tighter photo requirements",
    ],
    paPushbackPatterns: [
      "Moderate on supplements",
      "Pushback often on waste and flashing details",
      "Reasonable documentation standards",
    ],
    confidence: "medium",
  },

  farmers: {
    carrier: "farmers",
    preferredFormats: ["xactimate-esx", "xactimate-pdf"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "insured-address",
    ],
    fieldFormatNotes: {},
    requiresXactimateCodesOnEveryLine: true,
    salesTaxPresentation: "either",
    opPolicy: {
      typicallyOwed: true,
      standardPercent: 20,
      tradeThreshold: 3,
      presentation: "separate-line",
      excludedCategories: [],
      note: "Similar to State Farm in conservatism. O&P and steep charges frequently challenged.",
    },
    expectedSectionOrder: [
      "Tear-off / Removal",
      "Underlayment",
      "Field Shingles",
      "Flashing / Details",
      "Ventilation",
      "Accessories",
    ],
    outOfOrderConsequence: "slowed",
    supplementTriggers: [
      "Steep charges without pitch documentation",
      "O&P claims without trade justification",
      "High waste factors",
    ],
    recent2024_2026Changes: [
      "Tighter photo documentation requirements",
      "Increased portal use",
    ],
    paPushbackPatterns: [
      "Conservative on initial scopes (similar to State Farm)",
      "Frequent challenges on O&P and steep charges",
      "Pipe-jack / vent boot lines often omitted on initial scopes",
    ],
    confidence: "medium",
  },

  "liberty-mutual": {
    carrier: "liberty-mutual",
    preferredFormats: ["xactimate-esx", "xactimate-pdf"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "insured-address",
    ],
    fieldFormatNotes: {},
    requiresXactimateCodesOnEveryLine: true,
    salesTaxPresentation: "either",
    opPolicy: {
      typicallyOwed: true,
      standardPercent: 20,
      tradeThreshold: 3,
      presentation: "separate-line",
      excludedCategories: [],
      note: "Xactimate-focused. Network programs have published guidelines; pushback common on complex roof pricing.",
    },
    expectedSectionOrder: [
      "Tear-off / Removal",
      "Underlayment",
      "Field Shingles",
      "Flashing / Details (step + kick-out per IRC R905.2.8.3)",
      "Ventilation",
      "Accessories",
    ],
    outOfOrderConsequence: "slowed",
    supplementTriggers: [
      "Complex roof pricing variance",
      "Missing kick-out flashing on wall terminations",
      "Discontinued-SKU claims without manufacturer letter",
    ],
    recent2024_2026Changes: [
      "Increased emphasis on network compliance",
      "Tighter scope documentation requirements",
    ],
    paPushbackPatterns: [
      "Routine pushback on matching claims without discontinued-SKU letter",
      "Complex roof pricing frequently challenged",
      "Pipe-jack / vent boot lines often omitted",
    ],
    confidence: "medium",
  },

  progressive: {
    carrier: "progressive",
    preferredFormats: ["xactimate-pdf", "carrier-portal", "xactimate-esx"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "insured-address",
    ],
    fieldFormatNotes: {
      "peril-code":
        "Strict on peril coding — automated intake more aggressive than peer carriers",
    },
    requiresXactimateCodesOnEveryLine: false,
    salesTaxPresentation: "either",
    opPolicy: {
      typicallyOwed: true,
      standardPercent: 20,
      tradeThreshold: 3,
      presentation: "separate-line",
      excludedCategories: [],
      note: "More automated than peer carriers — strict on peril coding and documentation. ASI Progressive (FL) frequently includes matching-limit endorsements.",
    },
    expectedSectionOrder: [
      "Tear-off / Removal",
      "Underlayment",
      "Field Shingles",
      "Flashing / Details",
      "Ventilation",
      "Accessories",
    ],
    outOfOrderConsequence: "slowed",
    supplementTriggers: [
      "Peril coding mismatches",
      "Missing documentation",
      "Slower overall supplement cycles than peer carriers",
    ],
    recent2024_2026Changes: [
      "Continued automation of intake",
      "Stricter peril coding requirements",
    ],
    paPushbackPatterns: [
      "Slower supplement cycles cited frequently",
      "Strict on peril coding",
      "Starter course routinely omitted on architectural reroofs",
      "ASI Progressive FL matching endorsements limit scope",
    ],
    confidence: "medium",
  },

  nationwide: {
    carrier: "nationwide",
    preferredFormats: ["xactimate-esx", "xactimate-pdf"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "insured-address",
    ],
    fieldFormatNotes: {},
    requiresXactimateCodesOnEveryLine: true,
    salesTaxPresentation: "either",
    opPolicy: {
      typicallyOwed: true,
      standardPercent: 20,
      tradeThreshold: 3,
      presentation: "separate-line",
      excludedCategories: [],
      note: "Standard 20% O&P. Emphasis on photo and measurement documentation.",
    },
    expectedSectionOrder: [
      "Tear-off / Removal",
      "Underlayment",
      "Field Shingles",
      "Flashing / Details",
      "Valley metal",
      "Ventilation",
      "Hip & Ridge cap (dedicated product)",
      "Accessories",
    ],
    outOfOrderConsequence: "slowed",
    supplementTriggers: [
      "Missing valley metal on architectural reroofs",
      "Hand-cut ridge cap instead of dedicated product",
      "Extended IWS coverage in cold climates",
    ],
    recent2024_2026Changes: [
      "Recommended 6 ft IWS at eaves in northern climates",
      "Tighter photo requirements",
    ],
    paPushbackPatterns: [
      "Valley metal omission cited as top-5 scope gap",
      "Hip & ridge cap pricing as field-shingle LF (instead of dedicated product) common",
      "Moderate supplement volume",
    ],
    confidence: "medium",
  },

  other: {
    carrier: "other",
    preferredFormats: ["xactimate-esx", "xactimate-pdf"],
    requiredPage1Fields: [
      "claim-number",
      "policy-number",
      "date-of-loss",
      "peril-code",
      "adjuster-name",
      "insured-address",
    ],
    fieldFormatNotes: {},
    requiresXactimateCodesOnEveryLine: true,
    salesTaxPresentation: "either",
    opPolicy: {
      typicallyOwed: true,
      standardPercent: 20,
      tradeThreshold: 3,
      presentation: "separate-line",
      excludedCategories: [],
      note: "Default industry-standard 20% O&P at 3-trade threshold. Verify with the specific carrier's adjuster guidelines.",
    },
    expectedSectionOrder: [
      "Tear-off / Removal",
      "Underlayment",
      "Field Shingles",
      "Flashing / Details",
      "Ventilation",
      "Accessories",
    ],
    outOfOrderConsequence: "ignored",
    supplementTriggers: [
      "Verify with the specific carrier's adjuster guidelines",
    ],
    recent2024_2026Changes: [],
    paPushbackPatterns: [],
    confidence: "low",
  },
};

/** Quick preflight check: given a carrier + a partially-built scope,
 *  return a list of human-readable warnings about what's missing or
 *  out-of-format for that carrier's intake. Used by the "before you
 *  submit" panel in the estimate UI. */
export function preflightForCarrier(opts: {
  carrier: CarrierKey;
  hasXactimateCodes: boolean;
  hasOPLine: boolean;
  totalTrades: number;
  hasPhotoDocumentation: boolean;
  hasPitchDocumentation: boolean;
}): string[] {
  const fmt = CARRIER_ESTIMATE_FORMAT[opts.carrier];
  const warnings: string[] = [];

  if (fmt.requiresXactimateCodesOnEveryLine && !opts.hasXactimateCodes) {
    warnings.push(
      `${opts.carrier}: every line item must have an Xactimate code — narrative-only scopes route to manual review.`,
    );
  }

  if (
    fmt.opPolicy.typicallyOwed &&
    !opts.hasOPLine &&
    opts.totalTrades >= fmt.opPolicy.tradeThreshold
  ) {
    warnings.push(
      `${opts.carrier}: ${fmt.opPolicy.standardPercent}% O&P is typically owed at ${opts.totalTrades} trades but no O&P line is present.`,
    );
  }

  if (!opts.hasPhotoDocumentation) {
    warnings.push(
      `${opts.carrier}: photo documentation missing — this carrier's intake systems flag scopes without supporting photos.`,
    );
  }

  if (!opts.hasPitchDocumentation && opts.carrier !== "other") {
    warnings.push(
      `${opts.carrier}: pitch documentation (gauge photo or drone measurement) recommended to support steep-charge lines.`,
    );
  }

  return warnings;
}

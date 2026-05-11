/**
 * 2026 estimate-PDF format best practices, benchmarked from the
 * highest-converting roofing-proposal tools and sales-trainer
 * consensus.
 *
 * The trainer-and-tool consensus (Roof Strategist, RCS Reform, Roofing
 * Mastermind, Roofr / Hover / JobNimbus product data) is that
 * multi-tier presentation + embedded financing + visual storytelling
 * are the three biggest conversion levers. Industry average estimate
 * → signed contract conversion in 2026 is 25-40%; top quartile run
 * 50-70%+ with optimized format.
 *
 * Source: Grok May 2026 sweep of
 *   - Tool product pages + demos (Hover, Roofr, JobNimbus, AccuLynx,
 *     RoofSnap, Sumo Quote, Leap, EagleView, CompanyCam)
 *   - Sales training (Adam Bensman, Joe Hughes, RCS Reform podcast,
 *     Roofing Mastermind)
 *   - Self-reported tool conversion data + contractor forums
 *
 * Used by:
 *   - The proposal/estimate PDF generator to enforce ideal section
 *     order + multi-tier structure.
 *   - The "proposal-quality" scorer that grades a generated estimate
 *     against the high-converting benchmark.
 */

/** Canonical section in a 2026 high-converting roofing proposal,
 *  in the order that maximizes close rate per trainer consensus. */
export interface ProposalSection {
  id: string;
  /** Section header label. */
  label: string;
  /** Whether this section is REQUIRED for high-converting format,
   *  STRONGLY recommended, or optional polish. */
  importance: "required" | "strongly-recommended" | "optional";
  /** Why this section moves the needle on conversion. */
  rationale: string;
}

/** Ideal section order from cover page through signature. Generated
 *  proposal PDFs should follow this structure unless a specific
 *  carrier override (see carrier-estimate-format.ts) requires a
 *  different scope ordering for the adjuster-facing scope section. */
export const IDEAL_PROPOSAL_STRUCTURE: ProposalSection[] = [
  {
    id: "cover",
    label: "Cover / Hero",
    importance: "required",
    rationale: "First-impression page. Hero photo or 3D render of the home, prominently-displayed address, 'Proposal for [Name]', company logo + tagline, valid-until date. Sets brand + personalization tone.",
  },
  {
    id: "property-overview",
    label: "Property Overview / Measurements",
    importance: "required",
    rationale: "Establishes credibility — shows the rep measured (not guessed). Roof squares, pitch, complexity, predominant facets visible. Hover/EagleView measurement diagrams here when available.",
  },
  {
    id: "scope-summary",
    label: "Scope Summary",
    importance: "required",
    rationale: "High-level bullets or short prose explaining 'here is what we will do' before the line items. Homeowners read this first and decide whether to read further.",
  },
  {
    id: "line-items",
    label: "Itemized Scope (Grouped by Trade)",
    importance: "required",
    rationale: "Detailed line items grouped by phase — Tear-off & Disposal → Underlayment → Field Shingles → Flashing → Ventilation → Accessories → Cleanup. Grouping (vs. flat list) makes the scope feel comprehensive without overwhelming.",
  },
  {
    id: "tiers",
    label: "Good / Better / Best Tiers",
    importance: "required",
    rationale: "The single biggest conversion lever per 2026 trainer consensus (Bensman, RCS Reform). Three-tier presentation outperforms single-price by significant margins. Anchors the 'Better' option as the obvious choice.",
  },
  {
    id: "warranty",
    label: "Warranty (Manufacturer + Workmanship Side-by-Side)",
    importance: "required",
    rationale: "Logos of warranty providers (GAF Golden Pledge, CertainTeed SureStart Plus, Owens Corning Platinum Preferred, Atlas Signature Select). Workmanship warranty terms next to manufacturer warranty — comparison frame builds trust.",
  },
  {
    id: "photos",
    label: "Damage Documentation / Photo Evidence",
    importance: "required",
    rationale: "Embedded inline (not just appendix) per Roofr / Hover best practices. Each photo paired with a short caption explaining the damage. Visual storytelling, not just evidence.",
  },
  {
    id: "financing",
    label: "Financing Options (with Monthly Payment Examples)",
    importance: "strongly-recommended",
    rationale: "Embedded calculators (GreenSky, Hearth, Service Finance) showing actual monthly payment alongside total. Trainer consensus: financing callouts double close rates when the homeowner is on the fence about price.",
  },
  {
    id: "payment-schedule",
    label: "Payment Schedule",
    importance: "required",
    rationale: "Clear milestones — typical deposit / materials / completion percentages. State-specific compliance (FL §501.025, TX §39.005, MN §325G.07) embedded here.",
  },
  {
    id: "terms",
    label: "Terms & Conditions / Legal Disclosures",
    importance: "required",
    rationale: "Mechanic's lien notice, right of rescission, license disclosures, change-order language. State-specific mandatory language — missing text can void the contract.",
  },
  {
    id: "signature",
    label: "Embedded E-Signature",
    importance: "required",
    rationale: "One-click DocuSign-style signing eliminates the print-and-fax friction. Single biggest mechanical conversion factor — paper contracts close at fraction of e-sign rates.",
  },
];

/** Multi-tier presentation — the trainer consensus #1 conversion lever. */
export interface ProposalTier {
  key: "basic" | "recommended" | "premium";
  label: string;
  /** What's typically in this tier — used by the PDF generator to
   *  auto-build the three-tier comparison table. */
  typicalInclusions: string[];
  /** Pricing strategy — multiplier off the 'recommended' tier as
   *  baseline 1.0. */
  pricingMultiplier: number;
}

/** Recommended Good / Better / Best tier structure. */
export const TIER_TEMPLATES: ProposalTier[] = [
  {
    key: "basic",
    label: "Good — Code-Compliant Reroof",
    typicalInclusions: [
      "Tear-off + disposal",
      "Synthetic underlayment",
      "Standard 30-year architectural shingles",
      "Standard hip & ridge cap",
      "Drip edge",
      "Step flashing replacement",
      "Pipe-jack flashings",
      "Standard workmanship warranty (5 yr)",
    ],
    pricingMultiplier: 0.88,
  },
  {
    key: "recommended",
    label: "Better — Enhanced Protection (Most Popular)",
    typicalInclusions: [
      "Everything in Good",
      "Ice & water shield at eaves + valleys + penetrations",
      "Upgraded ridge vent",
      "Manufacturer enhanced warranty (GAF System Plus or equivalent)",
      "Extended workmanship warranty (10 yr)",
    ],
    pricingMultiplier: 1.0,
  },
  {
    key: "premium",
    label: "Best — Lifetime Premium Package",
    typicalInclusions: [
      "Everything in Better",
      "Premium architectural or designer shingles (GAF Timberline UHDZ / CertainTeed Landmark Pro)",
      "Full-deck ice & water shield",
      "Decking inspection + replacement allowance",
      "Premium ridge ventilation",
      "Manufacturer Golden Pledge / Platinum Preferred warranty (lifetime)",
      "Lifetime workmanship warranty",
    ],
    pricingMultiplier: 1.18,
  },
];

/** Conversion benchmarks — the rep can use these to grade their own
 *  performance and the studio can use them to set goals. */
export interface ConversionBenchmark {
  segment: string;
  rate: string;
  source: string;
}

export const CONVERSION_BENCHMARKS_2026: ConversionBenchmark[] = [
  {
    segment: "Industry average (estimate → signed contract)",
    rate: "25-40%",
    source: "RCS Reform podcast 2025 industry survey",
  },
  {
    segment: "Top-quartile contractors (optimized format)",
    rate: "50-70%+",
    source: "Trainer-reported (Bensman, Hughes 2025-2026)",
  },
  {
    segment: "Single-price proposals (no tiers)",
    rate: "lower baseline",
    source: "Multi-tier tool conversion data (Roofr, JobNimbus)",
  },
  {
    segment: "Multi-tier proposals (Good/Better/Best)",
    rate: "significant lift over single-price",
    source: "Trainer consensus 2025-2026",
  },
  {
    segment: "Proposals with embedded financing",
    rate: "double close rate on price-sensitive customers",
    source: "GreenSky / Hearth product reports",
  },
];

/** Things to NOT do — common 2026 mistakes that hurt close rate. */
export const ANTI_PATTERNS: Array<{ id: string; rule: string; why: string }> = [
  {
    id: "flat-line-item-list",
    rule: "Don't present line items as a flat list",
    why: "Grouping by trade/phase (tear-off → underlayment → field → details → cleanup) signals comprehensiveness and is easier for the homeowner to scan. Flat lists feel overwhelming.",
  },
  {
    id: "photos-in-appendix",
    rule: "Don't bury photos in an appendix",
    why: "Top-converting tools (Roofr, Hover) embed photos INLINE with captions next to relevant line items. Appendix photos rarely get read.",
  },
  {
    id: "single-price",
    rule: "Don't present a single-price proposal",
    why: "Three-tier (Good/Better/Best) is the #1 conversion lever per 2026 trainer consensus. Without anchoring, the homeowner has no frame of reference and frequently shops the bid.",
  },
  {
    id: "long-proposal",
    rule: "Don't go over 12-15 pages",
    why: "Top-converting tool benchmark is 8-12 pages. Long proposals feel padded; short ones feel underprepared. 8-12 is the sweet spot.",
  },
  {
    id: "hide-financing",
    rule: "Don't bury financing in fine print",
    why: "Embedded monthly-payment examples (Hearth, GreenSky calculator inline) double close rates on price-sensitive customers. Financing should be a section, not a footnote.",
  },
  {
    id: "no-personalization",
    rule: "Don't send a template-feeling proposal",
    why: "AI-personalized scope notes + rep voice-note callouts are emerging differentiators. Generic-feeling proposals close lower.",
  },
];

/** Score a generated proposal against the high-converting benchmark.
 *  Returns 0-100 plus a list of missing-section warnings. */
export function gradeProposalStructure(opts: {
  presentSections: string[]; // section IDs from IDEAL_PROPOSAL_STRUCTURE
  pageCount: number;
  hasTiers: boolean;
  hasFinancingCallout: boolean;
  hasPhotosInline: boolean;
}): { score: number; warnings: string[] } {
  let score = 0;
  const warnings: string[] = [];
  const present = new Set(opts.presentSections);

  // Each required section worth 8 points, strongly-recommended 4,
  // optional 2.
  for (const section of IDEAL_PROPOSAL_STRUCTURE) {
    if (present.has(section.id)) {
      score +=
        section.importance === "required"
          ? 8
          : section.importance === "strongly-recommended"
            ? 4
            : 2;
    } else if (section.importance === "required") {
      warnings.push(`Missing required section: "${section.label}". ${section.rationale}`);
    } else if (section.importance === "strongly-recommended") {
      warnings.push(`Missing strongly-recommended section: "${section.label}".`);
    }
  }

  // Bonus points for the 3 trainer-consensus levers.
  if (opts.hasTiers) score += 10;
  else warnings.push("Single-price proposal — multi-tier (Good/Better/Best) is the #1 conversion lever for 2026.");

  if (opts.hasFinancingCallout) score += 8;
  else warnings.push("No financing callout — embedded monthly-payment examples double close on price-sensitive customers.");

  if (opts.hasPhotosInline) score += 6;
  else warnings.push("Photos not embedded inline — appendix photos rarely get read.");

  // Page count penalty for going over.
  if (opts.pageCount > 15) {
    score -= 5;
    warnings.push(`Proposal is ${opts.pageCount} pages — top-converting benchmark is 8-12. Consider tightening.`);
  } else if (opts.pageCount < 6) {
    score -= 3;
    warnings.push(`Proposal is only ${opts.pageCount} pages — feels underprepared. 8-12 is the sweet spot.`);
  }

  return { score: Math.max(0, Math.min(100, score)), warnings };
}

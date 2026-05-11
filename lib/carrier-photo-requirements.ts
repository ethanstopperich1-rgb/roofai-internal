/**
 * Carrier-specific photo documentation requirements for roofing claims.
 *
 * Photo packages are one of the top reasons carrier scopes get kicked
 * back for revision in 2026. Most carriers now expect HAAG-aligned
 * protocols (10×10 test squares, tactile inspection, corroborating
 * soft-metal evidence) even when they don't name HAAG explicitly.
 * Desktop review automation has tightened metadata and timestamp
 * requirements significantly since 2024.
 *
 * Source: Grok May 2026 sweep synthesizing
 *   - USAA PDRP Guidelines (detailed photo lists)
 *   - Citizens FL Best Claims Practices
 *   - HAAG Protocol for Assessment of Hail-Damaged Roofing
 *   - NRCA technical bulletins
 *   - IRCA + public-adjuster forum patterns (2025-2026)
 *
 * Used by:
 *   - The photo-capture flow in the inspection app to enforce min
 *     required shots before a scope can be submitted.
 *   - The supplement analyzer to warn when a scope is missing photo
 *     documentation a specific carrier requires.
 *   - The estimate generator to embed a photo checklist matched to
 *     the selected carrier.
 */

import type { CarrierKey } from "./carriers";

/** A specific photo shot the carrier expects in the claim package. */
export interface RequiredShot {
  /** Short rep-facing label ("Full front elevation"). */
  label: string;
  /** Why this carrier wants it. */
  rationale: string;
  /** Whether this shot is required for every claim, or only when a
   *  specific condition holds (e.g., "steep roof", "interior damage
   *  claimed"). Optional shots get surfaced but won't block submit. */
  required: boolean;
  /** Free-text condition the rep can read. Empty = always applies. */
  conditional?: string;
}

/** Hail-specific documentation methodology — the carriers vary
 *  meaningfully on test-square strictness and brittleness testing. */
export interface HailDocMethodology {
  /** Whether test squares are REQUIRED or merely expected/optional. */
  testSquaresRequired: boolean;
  /** Typical size — usually 10ft × 10ft (100 sqft / HAAG standard). */
  testSquareSize: string;
  /** Number of test squares expected per slope. */
  squaresPerSlope: number;
  /** Whether chalk circles around hits are required, optional, or
   *  prohibited (some carriers reject altered-roof photos). */
  chalkCircles: "required" | "optional" | "prohibited";
  /** Whether brittleness testing on older shingles is expected. */
  brittlenessTest: boolean;
  /** Whether soft-metal corroborating damage is REQUIRED to support
   *  a hail claim. Without it some carriers deny outright. */
  softMetalCorroboration: boolean;
  /** Whether granule loss measurement (vs. just visual) is expected. */
  granuleLossMeasurement: boolean;
}

/** Photo metadata + technical requirements. */
export interface PhotoMetadataRules {
  /** Whether timestamp (EXIF or visibly in image) is REQUIRED. */
  timestampRequired: boolean;
  /** Whether GPS EXIF data is REQUIRED, preferred, or ignored. */
  gpsExif: "required" | "strongly-preferred" | "preferred" | "ignored";
  /** Minimum megapixels for close-up shots. */
  minMegapixels: number;
  /** Whether a scale reference (coin, ruler, chalk mark) is required
   *  in damage close-up shots. */
  scaleReferenceRequired: boolean;
}

export interface CarrierPhotoRequirements {
  carrier: CarrierKey;
  /** Minimum photo count the carrier's intake expects. Below this
   *  the scope is highly likely to bounce. */
  minPhotoCount: number;
  /** Typical photo count for an approved package (helps the rep
   *  calibrate "am I doing enough"). */
  typicalPhotoCount: number;
  /** Required shot checklist — used by the inspection app to enforce
   *  capture before submit. */
  requiredShots: RequiredShot[];
  hailDocMethodology: HailDocMethodology;
  metadataRules: PhotoMetadataRules;
  /** Whether attic / interior photos are required for any leak-path
   *  or interior-damage claim. */
  interiorRequired: boolean;
  /** Drone usage policy — "encouraged", "accepted", "prohibited"
   *  (some carriers have liability concerns with drone evidence). */
  dronePolicy: "encouraged" | "accepted" | "prohibited";
  /** Top reasons photo packages get rejected for this carrier. */
  rejectPatterns: string[];
  /** Whether the carrier follows HAAG protocols by name, by practice,
   *  or has its own internal standard. */
  haagAlignment: "explicit" | "in-practice" | "internal-standard";
  /** Recent 2024-2026 changes. */
  recentChanges: string[];
  /** Confidence tier for this profile. */
  confidence: "high" | "medium" | "low";
}

/** Industry baseline shots that apply to every carrier — used as the
 *  common floor the per-carrier maps extend. */
const BASELINE_REQUIRED_SHOTS: RequiredShot[] = [
  { label: "Front elevation (full house)", rationale: "Address verification + property condition baseline.", required: true },
  { label: "Each slope from ground level", rationale: "Overview of slope condition + identifies the affected areas.", required: true },
  { label: "Each slope from drone / aerial", rationale: "Top-down view critical for damage area measurement.", required: true, conditional: "When drone is available (encouraged on steep/inaccessible)" },
  { label: "Ridge close-ups", rationale: "Ridge cap condition + ventilation evidence.", required: true },
  { label: "Valley close-ups", rationale: "Valley metal vs. closed-cut shingle install + flashing condition.", required: true },
  { label: "All penetrations", rationale: "Plumbing vents, exhaust fans, electrical mast, skylights, chimneys — each EA flashing line.", required: true },
  { label: "Step flashing at every wall intersection", rationale: "IRC R905.2.8.3 required — wall flashing replacement is its own line.", required: true },
  { label: "Drip edge condition (eaves AND rakes)", rationale: "IRC R905.2.8.5 required — drip edge is per-LF and per-edge.", required: true },
  { label: "Gutter condition", rationale: "Hail corroboration (gutter dents) + replacement justification.", required: true },
  { label: "Address verification shot", rationale: "Street sign or visible house number — fraud / wrong-property prevention.", required: true },
];

export const CARRIER_PHOTO_REQUIREMENTS: Record<CarrierKey, CarrierPhotoRequirements> = {
  "state-farm": {
    carrier: "state-farm",
    minPhotoCount: 20,
    typicalPhotoCount: 35,
    requiredShots: [
      ...BASELINE_REQUIRED_SHOTS,
      { label: "Test square (10×10 ft) per affected slope", rationale: "HAAG-style hit count per 100 sqft — SF expects multiple on larger roofs.", required: true, conditional: "Hail loss" },
      { label: "Soft metal damage (vents, gutters, AC fins)", rationale: "Corroborating evidence — SF will challenge hail claims without it.", required: true, conditional: "Hail loss" },
      { label: "Granule loss measurement", rationale: "Visual + measurement if possible — strengthens scope of damage.", required: false, conditional: "Hail loss / aging shingles" },
      { label: "Brittleness test on older shingles", rationale: "Often expected on >10yr shingles.", required: false, conditional: "Roof age >10yr" },
      { label: "Attic shots", rationale: "Leak path verification.", required: true, conditional: "Interior damage claimed" },
    ],
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft (100 sqft / HAAG)",
      squaresPerSlope: 1,
      chalkCircles: "optional",
      brittlenessTest: true,
      softMetalCorroboration: true,
      granuleLossMeasurement: false,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "preferred",
      minMegapixels: 5,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "encouraged",
    rejectPatterns: [
      "Missing test square photos per slope",
      "No close-ups of flashing / penetrations",
      "Poor lighting / angles on damage",
      "No corroborating soft metal evidence",
    ],
    haagAlignment: "in-practice",
    recentChanges: [
      "Increased emphasis on aerial / drone integration",
      "Tighter timestamped evidence requirements",
    ],
    confidence: "high",
  },

  allstate: {
    carrier: "allstate",
    minPhotoCount: 15,
    typicalPhotoCount: 25,
    requiredShots: [
      ...BASELINE_REQUIRED_SHOTS,
      { label: "Test square (10×10 ft) per affected slope", rationale: "Allstate expects HAAG-style hit counts on the affected slopes.", required: true, conditional: "Hail loss" },
      { label: "Soft metal corroboration", rationale: "Vents/gutters/AC fins — Allstate looks for it.", required: true, conditional: "Hail loss" },
      { label: "Granule loss documentation", rationale: "Visual evidence — strengthens claim.", required: false, conditional: "Hail loss" },
      { label: "Interior leak verification", rationale: "Required for leak claims.", required: true, conditional: "Interior damage claimed" },
    ],
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft",
      squaresPerSlope: 1,
      chalkCircles: "optional",
      brittlenessTest: false,
      softMetalCorroboration: true,
      granuleLossMeasurement: false,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "strongly-preferred",
      minMegapixels: 5,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "encouraged",
    rejectPatterns: [
      "Insufficient close-ups of damage details",
      "Missing corroborating soft metal photos",
    ],
    haagAlignment: "in-practice",
    recentChanges: [
      "Network-specific upload portals with automated quality checks",
    ],
    confidence: "high",
  },

  usaa: {
    carrier: "usaa",
    minPhotoCount: 30,
    typicalPhotoCount: 45,
    requiredShots: [
      ...BASELINE_REQUIRED_SHOTS,
      { label: "Minimum 5 close-ups per slope being replaced", rationale: "USAA PDRP guideline — explicit per-slope close-up requirement.", required: true },
      { label: "Test square (10×10 ft) per affected slope", rationale: "PDRP requires test square methodology, multiple on larger roofs.", required: true, conditional: "Hail loss" },
      { label: "Pitch gauge photo", rationale: "Required to support steep / high charges.", required: true },
      { label: "Shingle measurement gauge", rationale: "Validates field-shingle quantity.", required: true },
      { label: "IWS coverage area", rationale: "Required to document extended ice & water shield.", required: true, conditional: "Cold-climate or HVHZ" },
      { label: "Valley metal", rationale: "PDRP-specific — must document presence and condition.", required: true },
      { label: "Soft metal damage corroboration", rationale: "Required as supporting evidence for hail claims.", required: true, conditional: "Hail loss" },
      { label: "Granule loss visual + measurement", rationale: "PDRP expects both qualitative and measured.", required: true, conditional: "Hail loss" },
      { label: "Brittleness test documentation", rationale: "Often required on older shingles.", required: false, conditional: "Roof age >10yr" },
      { label: "Work-in-progress photos", rationale: "PDRP requires documentation during the repair.", required: true },
      { label: "Post-construction photos", rationale: "PDRP requires final completion documentation.", required: true },
      { label: "Attic / ceiling shots", rationale: "Leak path verification required when interior is claimed.", required: true, conditional: "Interior damage claimed" },
    ],
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft (100 sqft / HAAG)",
      squaresPerSlope: 1,
      chalkCircles: "required",
      brittlenessTest: true,
      softMetalCorroboration: true,
      granuleLossMeasurement: true,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "required",
      minMegapixels: 8,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "accepted",
    rejectPatterns: [
      "Missing test square photos for every slope",
      "Insufficient close-ups (<5 per slope)",
      "No corroborating soft metal evidence",
      "Poor documentation of damage vs. wear/tear distinction",
      "Missing pitch gauge or shingle gauge photos",
    ],
    haagAlignment: "internal-standard",
    recentChanges: [
      "Continued tightening of photo upload requirements in XactAnalysis",
      "Roof InSight integration",
    ],
    confidence: "high",
  },

  citizens: {
    carrier: "citizens",
    minPhotoCount: 20,
    typicalPhotoCount: 35,
    requiredShots: [
      ...BASELINE_REQUIRED_SHOTS,
      { label: "Secondary water barrier / SWR documentation", rationale: "FL code-compliance evidence — Citizens scrutinizes this.", required: true, conditional: "FL property" },
      { label: "Mitigation feature photos", rationale: "Citizens uses for both claims and underwriting.", required: true, conditional: "FL property" },
      { label: "Test square (10×10 ft)", rationale: "HAAG-style hit count per slope.", required: true, conditional: "Hail loss" },
      { label: "Soft metal corroboration", rationale: "Hail evidence — Citizens expects it in FL.", required: true, conditional: "Hail loss" },
      { label: "Interior leak documentation", rationale: "Required for leak claims.", required: true, conditional: "Interior damage claimed" },
    ],
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft",
      squaresPerSlope: 1,
      chalkCircles: "optional",
      brittlenessTest: false,
      softMetalCorroboration: true,
      granuleLossMeasurement: false,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "preferred",
      minMegapixels: 5,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "encouraged",
    rejectPatterns: [
      "Insufficient documentation of code-compliance items (SWR, mitigation)",
      "Missing close-ups of flashing / penetrations",
    ],
    haagAlignment: "in-practice",
    recentChanges: [
      "Updated inspection forms (2025) with stronger photo emphasis",
    ],
    confidence: "high",
  },

  travelers: {
    carrier: "travelers",
    minPhotoCount: 15,
    typicalPhotoCount: 25,
    requiredShots: [
      ...BASELINE_REQUIRED_SHOTS,
      { label: "Test square (10×10 ft) per affected slope", rationale: "Industry/HAAG standard — Travelers follows in practice.", required: true, conditional: "Hail loss" },
      { label: "Soft metal damage", rationale: "Hail corroboration.", required: true, conditional: "Hail loss" },
      { label: "Interior verification", rationale: "Leak path documentation.", required: true, conditional: "Interior damage claimed" },
    ],
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft",
      squaresPerSlope: 1,
      chalkCircles: "optional",
      brittlenessTest: false,
      softMetalCorroboration: true,
      granuleLossMeasurement: false,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "strongly-preferred",
      minMegapixels: 5,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "encouraged",
    rejectPatterns: [
      "Missing test squares / close-ups",
      "Poor angles or lighting on damage",
      "Lack of corroborating soft metal evidence",
    ],
    haagAlignment: "in-practice",
    recentChanges: ["Digital portal use + timestamp verification"],
    confidence: "medium",
  },

  farmers: {
    carrier: "farmers",
    minPhotoCount: 15,
    typicalPhotoCount: 25,
    requiredShots: [
      ...BASELINE_REQUIRED_SHOTS,
      { label: "Test square per affected slope", rationale: "HAAG-style — Farmers expects on hail claims.", required: true, conditional: "Hail loss" },
      { label: "Soft metal corroboration", rationale: "Hail evidence support.", required: true, conditional: "Hail loss" },
      { label: "Brittleness test", rationale: "Older roof documentation.", required: false, conditional: "Roof age >10yr" },
      { label: "Interior verification", rationale: "Leak path.", required: true, conditional: "Interior damage claimed" },
    ],
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft",
      squaresPerSlope: 1,
      chalkCircles: "optional",
      brittlenessTest: true,
      softMetalCorroboration: true,
      granuleLossMeasurement: false,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "strongly-preferred",
      minMegapixels: 5,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "encouraged",
    rejectPatterns: [
      "Missing test squares",
      "No corroborating soft metal evidence",
    ],
    haagAlignment: "in-practice",
    recentChanges: ["Digital portal use"],
    confidence: "medium",
  },

  "liberty-mutual": {
    carrier: "liberty-mutual",
    minPhotoCount: 15,
    typicalPhotoCount: 25,
    requiredShots: [
      ...BASELINE_REQUIRED_SHOTS,
      { label: "Test square per slope", rationale: "Industry standard.", required: true, conditional: "Hail loss" },
      { label: "Kick-out flashing where wall continues past roof", rationale: "Liberty Mutual specifically scrutinizes kick-out flashing.", required: true },
      { label: "Soft metal corroboration", rationale: "Hail evidence.", required: true, conditional: "Hail loss" },
      { label: "Interior verification", rationale: "Leak documentation.", required: true, conditional: "Interior damage claimed" },
    ],
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft",
      squaresPerSlope: 1,
      chalkCircles: "optional",
      brittlenessTest: false,
      softMetalCorroboration: true,
      granuleLossMeasurement: false,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "strongly-preferred",
      minMegapixels: 5,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "encouraged",
    rejectPatterns: [
      "Missing kick-out flashing documentation",
      "Insufficient close-ups",
    ],
    haagAlignment: "in-practice",
    recentChanges: ["Digital portal use"],
    confidence: "medium",
  },

  progressive: {
    carrier: "progressive",
    minPhotoCount: 15,
    typicalPhotoCount: 25,
    requiredShots: [
      ...BASELINE_REQUIRED_SHOTS,
      { label: "Test square per slope", rationale: "Industry standard, but automated intake is strict.", required: true, conditional: "Hail loss" },
      { label: "Starter course documentation", rationale: "Progressive/ASI scopes routinely omit starter — document existing condition.", required: true },
      { label: "Soft metal corroboration", rationale: "Hail evidence.", required: true, conditional: "Hail loss" },
      { label: "Interior verification", rationale: "Leak documentation.", required: true, conditional: "Interior damage claimed" },
    ],
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft",
      squaresPerSlope: 1,
      chalkCircles: "optional",
      brittlenessTest: false,
      softMetalCorroboration: true,
      granuleLossMeasurement: false,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "required",
      minMegapixels: 5,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "encouraged",
    rejectPatterns: [
      "Stricter automated intake — missing metadata bounces submission",
      "Insufficient close-ups",
    ],
    haagAlignment: "in-practice",
    recentChanges: ["More aggressive automated photo validation"],
    confidence: "medium",
  },

  nationwide: {
    carrier: "nationwide",
    minPhotoCount: 15,
    typicalPhotoCount: 25,
    requiredShots: [
      ...BASELINE_REQUIRED_SHOTS,
      { label: "Test square per slope", rationale: "Industry standard.", required: true, conditional: "Hail loss" },
      { label: "Valley metal close-ups", rationale: "Nationwide cites valley metal as top-5 scope gap.", required: true },
      { label: "Hip & ridge cap close-ups", rationale: "Document whether dedicated cap product or hand-cut field shingle.", required: true },
      { label: "Soft metal corroboration", rationale: "Hail evidence.", required: true, conditional: "Hail loss" },
      { label: "Interior verification", rationale: "Leak documentation.", required: true, conditional: "Interior damage claimed" },
    ],
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft",
      squaresPerSlope: 1,
      chalkCircles: "optional",
      brittlenessTest: false,
      softMetalCorroboration: true,
      granuleLossMeasurement: false,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "strongly-preferred",
      minMegapixels: 5,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "encouraged",
    rejectPatterns: [
      "Missing valley-metal documentation",
      "Hand-cut ridge cap pricing without photo evidence",
    ],
    haagAlignment: "in-practice",
    recentChanges: ["Recommended 6 ft IWS at eaves in northern climates"],
    confidence: "medium",
  },

  other: {
    carrier: "other",
    minPhotoCount: 15,
    typicalPhotoCount: 25,
    requiredShots: BASELINE_REQUIRED_SHOTS,
    hailDocMethodology: {
      testSquaresRequired: true,
      testSquareSize: "10ft × 10ft (HAAG standard)",
      squaresPerSlope: 1,
      chalkCircles: "optional",
      brittlenessTest: false,
      softMetalCorroboration: true,
      granuleLossMeasurement: false,
    },
    metadataRules: {
      timestampRequired: true,
      gpsExif: "preferred",
      minMegapixels: 5,
      scaleReferenceRequired: true,
    },
    interiorRequired: true,
    dronePolicy: "encouraged",
    rejectPatterns: [],
    haagAlignment: "in-practice",
    recentChanges: [],
    confidence: "low",
  },
};

/** Preflight check: given a carrier + the captured photo set, return
 *  human-readable warnings about missing required shots. Used by the
 *  inspection app's "before you submit" panel. */
export function preflightPhotosForCarrier(opts: {
  carrier: CarrierKey;
  /** Set of shot labels (or label substrings) the rep has captured. */
  capturedShotLabels: string[];
  totalPhotoCount: number;
  isHailLoss: boolean;
  interiorDamageClaimed: boolean;
}): string[] {
  const reqs = CARRIER_PHOTO_REQUIREMENTS[opts.carrier];
  const warnings: string[] = [];

  if (opts.totalPhotoCount < reqs.minPhotoCount) {
    warnings.push(
      `${opts.carrier}: only ${opts.totalPhotoCount} photos captured — minimum for this carrier is ${reqs.minPhotoCount} (typical approved package: ${reqs.typicalPhotoCount}).`,
    );
  }

  const captured = new Set(
    opts.capturedShotLabels.map((s) => s.toLowerCase()),
  );

  for (const shot of reqs.requiredShots) {
    if (!shot.required) continue;
    // Filter by condition.
    if (shot.conditional) {
      const cond = shot.conditional.toLowerCase();
      if (cond.includes("hail loss") && !opts.isHailLoss) continue;
      if (
        cond.includes("interior damage claimed") &&
        !opts.interiorDamageClaimed
      ) {
        continue;
      }
    }
    const matched = [...captured].some((c) =>
      c.includes(shot.label.toLowerCase().slice(0, 20)),
    );
    if (!matched) {
      warnings.push(`${opts.carrier}: missing required shot — "${shot.label}". ${shot.rationale}`);
    }
  }

  if (opts.isHailLoss) {
    const hail = reqs.hailDocMethodology;
    if (hail.testSquaresRequired && !opts.capturedShotLabels.some((s) => /test.?square/i.test(s))) {
      warnings.push(
        `${opts.carrier}: hail loss but no test-square photo captured (expected: ${hail.testSquareSize}, ${hail.squaresPerSlope} per slope).`,
      );
    }
    if (hail.softMetalCorroboration && !opts.capturedShotLabels.some((s) => /soft.?metal|gutter|vent|fin/i.test(s))) {
      warnings.push(
        `${opts.carrier}: hail loss requires soft-metal corroboration (gutter dents, vent damage, AC fins) — none captured.`,
      );
    }
  }

  return warnings;
}

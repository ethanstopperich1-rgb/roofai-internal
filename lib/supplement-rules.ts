/**
 * Supplement-detection rules — declarative knowledge about what
 * carriers commonly omit from initial scopes that contractors are
 * entitled to bill. These rules drive the Supplement Analyzer
 * (`/api/supplement`) which diffs an uploaded carrier scope against
 * the rules + our own line-item engine and flags missing items.
 *
 * Each rule answers ONE question: "given the property context, was
 * this item supposed to be in the carrier scope but isn't?" Rules
 * fire independently; the analyzer combines them into a single
 * supplement-recommendations list with dollar impact + the standard
 * Xactimate code the rep would re-bill under.
 *
 * Sources for the rules + dollar impact:
 *   - PLRB (Property Loss Research Bureau) policy interpretations
 *   - IRC 2024 + state amendments (FL Building Code 7th ed., TX IRC)
 *   - Verisk Xactimate Pricing Bulletin (Q1 2026)
 *   - Reverend Roofer + Roof Supplement Pros published rate-of-supplement
 *     data across 50+ carriers, 2023-2025
 *
 * IMPORTANT: These are GUIDELINES, not legal advice. Carriers can and
 * will push back on any individual line. The analyzer surfaces what
 * SHOULD be there; the rep + a public adjuster decide what to fight
 * for on each specific claim.
 */

import type { Assumptions, Pitch } from "@/types/estimate";

export type SupplementSeverity = "required" | "expected" | "common" | "advisory";

export interface SupplementRule {
  /** Stable identifier used for de-dupe + tracking. */
  id: string;
  /** One-line rep-facing summary ("missing O&P at 20%"). */
  title: string;
  /** Two-sentence justification the rep can paste into a supplement
   *  request. References the controlling code / policy section where
   *  applicable. */
  rationale: string;
  /** Standard Xactimate code (matches lib/pricing.ts `SHINGLE_CODE`
   *  family + the codes in SIMPLIFIED_GROUPS). Used to look up the
   *  unit cost from our own pricing engine for a dollar estimate. */
  xactimateCode: string;
  /** "required" = the carrier is contractually obligated; pushback
   *  is unusual. "expected" = standard practice in 80%+ of scopes.
   *  "common" = typical in 40-80%. "advisory" = case-by-case. */
  severity: SupplementSeverity;
  /** Optional dollar estimate (if we have enough context). Many rules
   *  return null for the dollar field and let the rep estimate it
   *  from the Xactimate code's published rate. */
  estimatedDollars?: number | null;
  /** State scopes this rule applies to. Empty array = nationwide. */
  states?: string[];
  /** Carrier-specific quirks. Empty = applies to all carriers. */
  carriers?: string[];
  /** Per-carrier rationale overrides. When ctx.carrier matches a key,
   *  the analyzer surfaces THIS rationale instead of `rationale` —
   *  lets us cite State-Farm-specific template patterns to State Farm
   *  adjusters and USAA PDRP language to USAA adjusters. Carrier
   *  intel sourced from Grok's May 2026 sweep of public adjuster /
   *  supplement-community data (Reverend Roofer, Roof Supplement Pros,
   *  IRCA). Falls back to the generic rationale when no match. */
  carrierRationale?: Partial<Record<string, string>>;
  /** Per-carrier severity overrides (e.g., Citizens FL post-SB-2D
   *  age-based denial bumps to "required" because it's a statutory
   *  obligation, not just industry standard). */
  carrierSeverity?: Partial<Record<string, SupplementSeverity>>;
}

export interface SupplementContext {
  assumptions: Assumptions;
  state: string | null; // 2-letter
  carrier: string | null; // matches lib/carriers.ts CarrierKey
  /** Extracted line items from the carrier scope (after Qwen parse).
   *  Empty array means the analyzer hasn't seen the scope yet — only
   *  rules that fire unconditionally (matching law, FL ice & water)
   *  will return. */
  carrierLineItems: ExtractedLineItem[];
  /** Pre-computed subtotal of the carrier scope, used to evaluate
   *  whether O&P is correctly applied. */
  carrierSubtotal?: number | null;
  /** Whether the carrier scope includes a separate O&P line. */
  carrierHasOP?: boolean | null;
  /** MRMS-detected hail events near the property within ±14 days of
   *  the date of loss. Used for the date-discrepancy flag. */
  mrmsHailAroundDateOfLoss?: Array<{
    date: string;
    inches: number;
    distanceMiles: number;
  }>;
  /** Date of loss from the carrier scope, parsed to ISO YYYY-MM-DD. */
  dateOfLoss?: string | null;
}

/** Minimal shape we expect Qwen to extract from a carrier PDF. The
 *  prompt in `/api/supplement` returns this directly. Matched loosely
 *  against our own pricing codes — Qwen-extracted codes don't always
 *  match Xactimate canonical strings exactly. */
export interface ExtractedLineItem {
  /** Raw description from the scope, e.g. "Asphalt shingle - architectural". */
  description: string;
  /** Quantity (sqft, LF, EA — units below). */
  quantity?: number;
  unit?: string;
  /** Carrier's unit cost from the scope. */
  unitCost?: number;
  /** Carrier's extended cost (quantity × unitCost). */
  extended?: number;
  /** Best-guess Xactimate code — Qwen extracts when explicit, else
   *  the analyzer infers from the description. */
  xactimateCode?: string;
}

export interface SupplementFlag {
  rule: SupplementRule;
  /** Why THIS specific rule fired for THIS specific scope. */
  reason: string;
  /** Concrete dollar estimate if we can compute one from the rule +
   *  context (e.g. O&P at 20% of carrier subtotal). */
  estimatedDollars: number | null;
}

// ─────────────────────────────────────────────────────────────────────
// Rule catalog. Add new rules here; each `check(ctx)` returns a
// `SupplementFlag` when the rule fires for the given context, or
// `null` when it doesn't apply. Keep rules tightly scoped to ONE
// question each — composition is the analyzer's job.
// ─────────────────────────────────────────────────────────────────────

/** Each rule's check receives both the eval context AND its own rule
 *  object — eliminates the brittle `RULES[N].rule` self-reference
 *  pattern that breaks any time a new rule is inserted in the middle
 *  of the array. */
type Check = (ctx: SupplementContext, rule: SupplementRule) => SupplementFlag | null;

/**
 * Shared helper for "carrier scope is under-billing this material per
 * Q2 2026 wholesale floor" rules. Used by 6 stale-pricing rules
 * (asphalt shingle, galvalume metal, aluminum metal, concrete tile,
 * underlayment, ice & water, drip edge) so the same threshold logic
 * doesn't get hand-copied 6 times.
 *
 * Floors below are Q2 2026 contractor-cost lower-bounds from
 * manufacturer announcements + distributor data (May 2026). Each
 * floor is set at "typical wholesale × 0.85" — gives carriers a 15%
 * margin headroom before we flag, so the rule only fires on
 * meaningfully under-billed lines, not borderline misses.
 *
 * Returns a SupplementFlag with computed dollar impact when the
 * carrier line is below the floor; null otherwise (rule didn't fire).
 */
function checkStalePricing(opts: {
  ctx: SupplementContext;
  rule: SupplementRule;
  /** Regex matching line-item descriptions for this material. */
  descriptionRegex: RegExp;
  /** Material restriction — only fire when the rep's estimate uses
   *  one of these materials. Empty = fire for any material. */
  applicableMaterials?: Assumptions["material"][];
  /** Q2 2026 wholesale floors. The matcher picks one based on the
   *  carrier line's `unit` field. */
  floorsByUnit: Partial<Record<"SQ" | "SF" | "LF" | "EA", number>>;
}): SupplementFlag | null {
  const { ctx, rule, descriptionRegex, applicableMaterials, floorsByUnit } = opts;
  if (ctx.carrierLineItems.length === 0) return null;
  if (
    applicableMaterials &&
    !applicableMaterials.includes(ctx.assumptions.material)
  ) {
    return null;
  }
  const line = ctx.carrierLineItems.find((it) =>
    descriptionRegex.test(it.description),
  );
  if (!line || line.unitCost == null) return null;
  const unit = (line.unit ?? "").toUpperCase() as "SQ" | "SF" | "LF" | "EA";
  const floor = floorsByUnit[unit];
  if (floor == null) return null;
  if (line.unitCost >= floor) return null;
  return {
    rule,
    reason: `Carrier ${rule.xactimateCode} unit cost is $${line.unitCost.toFixed(2)}/${unit} — below the post-April-2026 wholesale floor of ~$${floor.toFixed(2)}/${unit}.`,
    estimatedDollars: line.quantity
      ? Math.round(line.quantity * (floor - line.unitCost))
      : null,
  };
}

const RULES: Array<{ rule: SupplementRule; check: Check }> = [
  // ──────────────────────────────────────────────────────────────────
  // O&P (Overhead & Profit) — the #1 most-frequently-missed line in
  // North American claim scopes. Insurance is contractually required
  // to pay 20% O&P on losses where 3+ trades are involved (which is
  // virtually every reroof — roofing + sheet metal + carpentry +
  // disposal). See: PLRB Position Paper 26, multiple state DOI
  // bulletins, NFIP Adjuster Manual §3.7.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "op-missing",
      title: "Overhead & Profit (20%) not on scope",
      rationale:
        "When a covered loss involves three or more trades, carriers are required to pay general contractor Overhead & Profit (typically 20% — 10% O + 10% P) per PLRB Position Paper 26. A reroof always involves roofing, sheet metal, carpentry/decking, and debris removal — minimum four trades. Request O&P be added at 20% of the subtotal.",
      xactimateCode: "O&P",
      severity: "required",
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      // Already there? Done.
      if (ctx.carrierHasOP) return null;
      const subtotal = ctx.carrierSubtotal ?? 0;
      const dollars = subtotal > 0 ? Math.round(subtotal * 0.20) : null;
      return {
        rule,
        reason:
          "Scope subtotal is $" +
          (subtotal ? subtotal.toLocaleString() : "?") +
          " but no separate O&P line was found. 20% O&P is industry standard for any multi-trade loss.",
        estimatedDollars: dollars,
      };
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Steep / pitch charge. Xactimate auto-adds a labor surcharge for
  // pitches ≥7/12. Carrier scopes occasionally leave this off for
  // borderline pitches (7/12, 8/12) where the adjuster eyeballs the
  // roof as "moderate." Rep-measured pitch is the source of truth.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "steep-charge-missing",
      title: "Steep-charge surcharge not applied to a ≥7/12 pitch",
      rationale:
        "Per Xactimate Pricing Bulletin Q1 2026, roofing labor on pitches 7/12 and steeper requires a steep-charge surcharge (typically 25-45% over base labor). Our remote measurement confirms the pitch on this property meets that threshold. Request the steep-charge line be added per Xactimate's published rate.",
      xactimateCode: "RFG STEEP",
      severity: "expected",
    },
    check: (ctx, rule) => {
      const steepPitches: Pitch[] = ["7/12", "8/12+"];
      const pitch = ctx.assumptions.pitch;
      if (!pitch || !steepPitches.includes(pitch)) return null;
      // Carrier scope may have implicit steep — look for keyword in line items
      const hasSteep = ctx.carrierLineItems.some((it) =>
        /\bsteep\b|\bhigh.?pitch\b/i.test(it.description),
      );
      if (hasSteep) return null;
      return {
        rule,
        reason: `Pitch measured at ${pitch}, but no steep-charge surcharge line was found in the carrier scope.`,
        estimatedDollars: null,
      };
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Florida-specific: §626.9744 matching law. NARROWED May 2026 per
  // Grok statutory-research sweep:
  //   - Statute requires "comparable material AND quality" matching only
  //     when adjoining items don't reasonably match; it is NOT an
  //     automatic full-roof replacement entitlement.
  //   - 2022 SB 2-D reforms did NOT amend §626.9744. The matching duty
  //     stands as written.
  //   - Vazquez v. Citizens (Fla. 3d DCA 2020) and Weston v. UPCIC
  //     (Fla. 2d DCA Oct 24 2025) reaffirm: insurer owes for matching
  //     when reasonable uniformity can't be achieved on the damaged
  //     area, but rep must show a reasonable-basis mismatch exists.
  //   - Several FL carriers (Citizens, FL Peninsula, Heritage) have
  //     OIR-approved endorsements limiting matching scope to the
  //     damaged side/slope only. Carrier-specific carve-outs below.
  //
  // Logic narrowed accordingly: severity = "advisory" (was "common"),
  // ≥5 years acts as a soft trigger (not auto-qualifier), rule
  // requires the analyzer has seen a real carrier scope (don't fire
  // on a bare assumptions object), and only fires for materials where
  // matching mismatch is actually likely (architectural shingle, tile,
  // visible-finish metal — 3-tab is included but weaker presumption).
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "fl-matching-law",
      title: "FL §626.9744 matching — review for reasonable-basis mismatch",
      rationale:
        "Florida Statute §626.9744(2) requires insurers to replace adjoining undamaged roof areas when reasonable uniformity (comparable material AND quality) cannot be achieved on the repair of the damaged portion. Vazquez v. Citizens (Fla. 3d DCA 2020) and Weston v. UPCIC (Fla. 2d DCA Oct 24 2025) reaffirm the duty but require the insured to show a reasonable basis the repaired area won't match (discontinued line, faded color, mismatched profile/finish). The 2022 SB 2-D reforms did NOT amend §626.9744 — the matching duty stands. This is NOT an automatic full-roof entitlement; rep should document the specific mismatch (photos, discontinued-SKU letter from manufacturer, or distributor confirmation) before pushing.",
      xactimateCode: "MATCH",
      severity: "advisory",
      states: ["FL"],
      carrierRationale: {
        citizens:
          "Citizens FL policies issued after 2022 commonly carry the OIR-approved 'Limited Roof Matching' endorsement that limits matching to the damaged slope/side only (not the entire roof). Confirm the policy form in effect on the DoL — if the endorsement applies, frame the supplement as matching to the damaged slope, not full-roof replacement. Vazquez (Fla. 3d DCA 2020) still controls when no such endorsement is in force.",
        "liberty-mutual":
          "Liberty Mutual FL claims: §626.9744 applies, but Liberty adjusters routinely push back without a discontinued-SKU letter. Attach a manufacturer or distributor email confirming the existing shingle line/color is no longer available before requesting full-slope or full-roof matching.",
        progressive:
          "ASI/Progressive FL policies frequently include matching-limit endorsements similar to Citizens. Verify the endorsement schedule on the dec page before framing the supplement.",
      },
    },
    check: (ctx, rule) => {
      if (ctx.state !== "FL") return null;
      // Soft trigger: ≥5 years is the typical age where shingle color
      // lines get discontinued, but it's not a bright-line qualifier.
      // Allow younger roofs to still surface as advisory when the
      // analyzer has a scope to compare against — the rep verifies.
      const age = ctx.assumptions.ageYears ?? 0;
      // Don't fire on the bare assumptions panel — wait for a real
      // carrier scope to be uploaded, otherwise we're flagging every
      // FL property in the universe.
      if (ctx.carrierLineItems.length === 0) return null;
      // Material filter: matching presumption is strongest for visible-
      // finish materials with high SKU churn. Wood / 3-tab still
      // included but weaker — the rep will get pushback on 3-tab.
      const eligibleMaterials: Assumptions["material"][] = [
        "asphalt-architectural",
        "asphalt-3tab",
        "tile-concrete",
        "metal-standing-seam",
      ];
      if (!eligibleMaterials.includes(ctx.assumptions.material)) return null;
      const ageNote =
        age >= 5
          ? `roof age ${age}yr (discontinued-line risk elevated)`
          : `roof age ${age}yr (matching less likely but verify if any color/SKU concerns)`;
      return {
        rule,
        reason: `FL property, ${ageNote}, material ${ctx.assumptions.material}. Review the carrier scope: if only part of the roof is being replaced, document any reasonable-basis mismatch (discontinued SKU, color fade, profile change) before filing a §626.9744 matching supplement. Not an automatic entitlement.`,
        estimatedDollars: null,
      };
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Ice & water shield — required by FL Building Code 7th edition
  // §R905.1.2 in HVHZ (high-velocity hurricane zones: Miami-Dade,
  // Broward). Often omitted on carrier scopes from out-of-state
  // adjusters. Even outside HVHZ, IRC §R905.1.2 requires it at
  // eaves wherever average January temperature ≤ 25°F — covers all
  // of MN and most of TX panhandle.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "ice-water-shield-fl-hvhz",
      title: "Ice & water shield required by FL Building Code (HVHZ)",
      rationale:
        "Florida Building Code 7th ed. §R905.1.2 requires ice & water shield underlayment over the entire roof deck in High-Velocity Hurricane Zones (Miami-Dade and Broward counties). Code-mandated material — not optional — and must be in scope on any reroof.",
      xactimateCode: "RFG IWS",
      severity: "required",
      states: ["FL"],
    },
    check: (ctx, rule) => {
      if (ctx.state !== "FL") return null;
      const hasIWS = ctx.carrierLineItems.some((it) =>
        /ice.{0,3}(and|&|n).{0,3}water|i&w|\bIWS\b|\bIw\b/i.test(it.description),
      );
      if (hasIWS) return null;
      return {
        rule,
        reason:
          "FL property with no ice & water shield line found in scope. Required by FBC 7th ed. §R905.1.2 in HVHZ.",
        estimatedDollars: null,
      };
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Drip edge — required by IRC R905.2.8.5 since 2012. Almost every
  // carrier scope from the last decade includes it, but pre-2012
  // adjuster templates sometimes still don't. Worth checking.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "drip-edge-missing",
      title: "Drip edge not on scope (IRC R905.2.8.5 required)",
      rationale:
        "IRC R905.2.8.5 (2012 and later editions, adopted by all 50 states) requires metal drip edge at eaves and rakes on every shingle roof. Code-required item — request the missing LF be added at the standard published rate.",
      xactimateCode: "RFG DRIP",
      severity: "required",
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      const hasDrip = ctx.carrierLineItems.some((it) =>
        /\bdrip[\s-]?edge\b|\bRFG.?DRIP\b/i.test(it.description),
      );
      if (hasDrip) return null;
      return {
        rule,
        reason: "No drip-edge line found in carrier scope. Required by IRC R905.2.8.5.",
        estimatedDollars: null,
      };
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // MRMS hail date discrepancy. The unique unlock — we have radar-
  // detected hail data for every property; the carrier's "date of
  // loss" may not match. If radar says hail hit the property ±14d
  // from the stated DoL but on a different day, that's a flag the
  // rep can use to either correct the DoL (extends claim window) or
  // bolster the evidence ("radar confirms severe hail on X").
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "mrms-date-discrepancy",
      title: "Radar-detected hail on a date different from claim DoL",
      rationale:
        "NOAA MRMS radar detected severe hail at this property within ±14 days of the carrier's stated date of loss, but on a different specific date. Either (a) the date of loss should be corrected, or (b) the radar evidence strengthens the claim — either way the rep should clarify with the adjuster before scope is finalized.",
      xactimateCode: "MRMS-CONFIRM",
      severity: "advisory",
    },
    check: (ctx, rule) => {
      const events = ctx.mrmsHailAroundDateOfLoss ?? [];
      if (events.length === 0 || !ctx.dateOfLoss) return null;
      const closest = events
        .map((e) => ({
          ...e,
          delta: Math.abs(
            (new Date(e.date.length === 8
              ? `${e.date.slice(0,4)}-${e.date.slice(4,6)}-${e.date.slice(6,8)}`
              : e.date).getTime() -
              new Date(ctx.dateOfLoss!).getTime()) /
              (24 * 3600 * 1000),
          ),
        }))
        .sort((a, b) => a.delta - b.delta)[0];
      // If the radar event is literally the same day, no discrepancy
      // (just confirmation — handled by a separate "evidence" rule
      // later if we want).
      if (closest.delta < 1) return null;
      return {
        rule,
        reason: `Carrier DoL is ${ctx.dateOfLoss}, but radar shows ${closest.inches}" hail at ${closest.distanceMiles} mi away on ${closest.date} (Δ ${Math.round(closest.delta)} days).`,
        estimatedDollars: null,
      };
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Decking allowance — most scopes default to 0 sqft of replaced
  // decking. Real teardowns always reveal some rotted plywood. The
  // industry standard is to bid 100 sqft minimum allowance (1 sheet)
  // that gets adjusted on supplements after teardown.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "decking-allowance-missing",
      title: "No decking allowance — teardown will reveal rot",
      rationale:
        "Carrier scopes typically default to 0 sqft of replaced sheathing. Industry practice is to include a 100 sqft minimum allowance (1 sheet of 4×8 plywood) as a placeholder that's adjusted on supplement after teardown reveals actual rotted decking. Request the allowance now to streamline the post-teardown supplement.",
      xactimateCode: "RFG DECK",
      severity: "expected",
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      const hasDecking = ctx.carrierLineItems.some((it) =>
        /\bdecking?\b|\bsheath(ing)?\b|\bplywood\b|\bOSB\b|\bRFG.?DECK\b/i.test(
          it.description,
        ),
      );
      if (hasDecking) return null;
      return {
        rule,
        reason: "No decking / sheathing / plywood line in carrier scope. 100 sqft allowance is standard.",
        estimatedDollars: null,
      };
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Stale shingle pricing. The Q2 2026 manufacturer hikes (GAF +8%,
  // CertainTeed +8%, Owens Corning/Atlas +5-8% effective April 2026,
  // SRS distributor +6-10% June 2026) materially raised actual
  // wholesale. Many carriers and Xactimate price-list updates lag by
  // 60-90 days. If the carrier scope's per-square shingle line is
  // below the Q2 2026 floor (~$280/SQ contractor cost or ~$5.50/sqft
  // installed for architectural), it's using stale pricing the rep
  // can challenge with current distributor invoices.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "shingle-price-stale",
      title: "Shingle pricing below Q2 2026 manufacturer hikes",
      rationale:
        "Major manufacturer list-price hikes effective April 2026: GAF and CertainTeed each up to 8% on architectural shingles, Owens Corning and Atlas 5-8%, with SRS distributors layering on an additional 6-10% effective June 2026. The carrier scope's per-square shingle rate sits below the post-hike contractor floor (~$280/square or ~$2.80/sqft material-only). Request a price-list update or an updated unit cost backed by a current distributor invoice.",
      xactimateCode: "RFG ARCH",
      severity: "common",
    },
    check: (ctx, rule) =>
      checkStalePricing({
        ctx,
        rule,
        descriptionRegex:
          /(asphalt|architectural|shingle|RFG.?ARCH|RFG.?3T|\bcomp\b)/i,
        applicableMaterials: ["asphalt-architectural", "asphalt-3tab"],
        floorsByUnit: { SQ: 280, SF: 2.8 },
      }),
  },

  // ──────────────────────────────────────────────────────────────────
  // Standing-seam metal (Galvalume / steel) — tariff-heavy, +12-25%
  // from Q1 2025. Q2 2026 contractor floor ~$2.40/sqft for 24ga
  // Galvalume per Grok pull (typical $2.85, floor at typical × 0.85).
  // Most carrier scopes for metal reroofs are 2024-era pricing and
  // miss the tariff-driven jump.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "metal-galvalume-price-stale",
      title: "Galvalume / steel metal pricing below Q2 2026 tariff floor",
      rationale:
        "Section 232 steel tariffs drove 24-gauge Galvalume up 12-25% from Q1 2025 to Q2 2026. The carrier scope's per-sqft metal rate sits below the post-tariff wholesale floor (~$2.40/sqft Galvalume). Request the metal line be re-priced from a current distributor quote (ABC Supply, Beacon, Western States, etc.) — the rep can produce one on request.",
      xactimateCode: "RFG METAL",
      severity: "expected",
    },
    check: (ctx, rule) =>
      checkStalePricing({
        ctx,
        rule,
        descriptionRegex:
          /(galvalume|standing.?seam.*(steel|galv)|24.?(ga|gauge).*(panel|metal)|RFG.?MTL|RFG.?STM)/i,
        applicableMaterials: ["metal-standing-seam"],
        floorsByUnit: { SF: 2.4, SQ: 240 },
      }),
  },

  // ──────────────────────────────────────────────────────────────────
  // Standing-seam metal (Aluminum) — coastal / salt-air premium
  // option. Even more tariff exposure than Galvalume. Q2 2026 floor
  // ~$3.80/sqft (typical $4.75 × 0.85). Common in FL coastal markets
  // where corrosion makes aluminum the standard spec.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "metal-aluminum-price-stale",
      title: "Aluminum metal pricing below Q2 2026 tariff floor",
      rationale:
        "Aluminum has the highest tariff exposure of any roofing material — Q1 2025 → Q2 2026 wholesale up 15-25%+. The carrier's per-sqft aluminum rate is below the post-tariff floor (~$3.80/sqft for 0.032 aluminum). Standard spec in FL coastal markets for salt-air corrosion. Request re-pricing at current distributor quote.",
      xactimateCode: "RFG ALUM",
      severity: "expected",
    },
    check: (ctx, rule) =>
      checkStalePricing({
        ctx,
        rule,
        descriptionRegex:
          /(aluminum.*(panel|metal|standing.?seam)|0\.032|RFG.?ALUM)/i,
        applicableMaterials: ["metal-standing-seam"],
        floorsByUnit: { SF: 3.8, SQ: 380 },
      }),
  },

  // ──────────────────────────────────────────────────────────────────
  // Concrete tile — moderate +4-8% from Q1 2025 (less tariff-exposed
  // than metal). Q2 2026 floor ~$2.40/sqft material-only (typical
  // $3.00). Most common in FL retirement communities + SW.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "tile-concrete-price-stale",
      title: "Concrete tile pricing below Q2 2026 floor",
      rationale:
        "Concrete tile wholesale moved up 4-8% from Q1 2025 to Q2 2026. The carrier rate sits below the post-hike floor (~$2.40/sqft material-only, ~$200/SQ). Less tariff-affected than metal but still benefits from a price refresh on the scope.",
      xactimateCode: "RFG TILE",
      severity: "common",
    },
    check: (ctx, rule) =>
      checkStalePricing({
        ctx,
        rule,
        descriptionRegex:
          /(concrete.?tile|cement.?tile|RFG.?TILE|RFG.?TILEC)/i,
        applicableMaterials: ["tile-concrete"],
        floorsByUnit: { SF: 2.4, SQ: 240 },
      }),
  },

  // ──────────────────────────────────────────────────────────────────
  // Synthetic underlayment — +5-10% from Q1 2025 (part of April 2026
  // accessory hikes from Atlas, GAF, CertainTeed). Q2 2026 floor
  // ~$0.55/sqft (typical $0.72). Fires regardless of primary material
  // — every reroof has underlayment.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "underlayment-synthetic-price-stale",
      title: "Synthetic underlayment below Q2 2026 manufacturer hikes",
      rationale:
        "Synthetic underlayment (Titanium UDL, Tyvek Protec class) bumped up 5-10% with the April 2026 accessory hikes from Atlas, GAF, and CertainTeed. The carrier rate is below the post-hike floor (~$0.55/sqft). Request line refresh at current distributor cost.",
      xactimateCode: "RFG SYNF",
      severity: "common",
    },
    check: (ctx, rule) =>
      checkStalePricing({
        ctx,
        rule,
        descriptionRegex:
          /(synthetic.?underlayment|titanium.?(udl|udls)|tyvek.?protec|RFG.?SYNF)/i,
        floorsByUnit: { SF: 0.55, SQ: 55 },
      }),
  },

  // ──────────────────────────────────────────────────────────────────
  // Ice & water shield — +5-10% from Q1 2025. Q2 2026 floor
  // ~$0.85/sqft material-only (typical $1.05). Required by FBC §R905
  // in FL HVHZ + IRC §R905.1.2 at eaves in cold climates — fires on
  // any reroof that has it scoped (regardless of state).
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "ice-water-price-stale",
      title: "Ice & water shield below Q2 2026 floor",
      rationale:
        "Ice & water shield (Grace Ultra / CertainTeed WinterGuard class) moved up 5-10% with the April 2026 accessory hikes. Carrier rate is below the post-hike floor (~$0.85/sqft material-only). Refresh the scope's IWS unit cost.",
      xactimateCode: "RFG IWS",
      severity: "common",
    },
    check: (ctx, rule) =>
      checkStalePricing({
        ctx,
        rule,
        descriptionRegex:
          /(ice.?(and|&|n).?water|grace.?ultra|winterguard|\bIWS\b|RFG.?IWS)/i,
        floorsByUnit: { SF: 0.85, SQ: 85 },
      }),
  },

  // ──────────────────────────────────────────────────────────────────
  // Aluminum drip edge — +10-20%+ from Q1 2025 (heaviest tariff
  // exposure of the accessories). Q2 2026 floor ~$0.50/LF (typical
  // $0.65). Fires on any reroof — IRC R905.2.8.5 requires drip edge
  // at eaves AND rakes, so every scope has it.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "drip-edge-price-stale",
      title: "Aluminum drip edge below Q2 2026 tariff floor",
      rationale:
        "Aluminum drip edge moved up 10-20%+ from Q1 2025 — heaviest tariff exposure among accessories. Carrier rate is below the post-tariff floor (~$0.50/LF). Standard aluminum, mill / painted finish. Request scope re-price.",
      xactimateCode: "RFG DRIP",
      severity: "common",
    },
    check: (ctx, rule) =>
      checkStalePricing({
        ctx,
        rule,
        descriptionRegex: /(drip.?edge|RFG.?DRIP)/i,
        floorsByUnit: { LF: 0.50 },
      }),
  },

  // ──────────────────────────────────────────────────────────────────
  // Ridge vent on a shingle reroof. Most modern asphalt installs use
  // ridge vent (not box vents) for code-compliant attic ventilation.
  // Carriers occasionally scope only "ridge cap" without the vent
  // material underneath.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "ridge-vent-missing",
      title: "Ridge cap on scope but no ridge vent material",
      rationale:
        "If the scope includes ridge cap shingles but no ridge vent (e.g., Lomanco OR-19 or equivalent), the installer is being asked to install over solid sheathing — which produces ridge bulge and fails the manufacturer's attic-ventilation requirement on shingle warranty. Request the ridge vent material be added under RFG RDGV.",
      xactimateCode: "RFG RDGV",
      severity: "common",
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      const hasRidgeCap = ctx.carrierLineItems.some((it) =>
        /\bridge.?cap\b|\bRFG.?RIDG\b/i.test(it.description),
      );
      const hasRidgeVent = ctx.carrierLineItems.some((it) =>
        /\bridge.?vent\b|\bRFG.?RDGV\b/i.test(it.description),
      );
      if (!hasRidgeCap || hasRidgeVent) return null;
      return {
        rule,
        reason: "Ridge cap is on scope but no ridge vent material — typical scope omission.",
        estimatedDollars: null,
      };
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Carrier-aware "missing line item" rules. These all share the same
  // shape — does the scope contain a regex match? — but include
  // carrier-specific rationale overrides so adjusters get hit with
  // their own published guideline language. Carrier intel from Grok's
  // May 2026 sweep of public-adjuster + supplement-community data.
  //
  // Helper below lets each rule declare WHICH carriers it's especially
  // common to be missing-from-scope on, and the catalog of paste-ready
  // adjuster-specific rationale strings.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "starter-course-missing",
      title: "Starter course (eaves + rakes) not on scope",
      rationale:
        "Manufacturer install instructions (GAF, CertainTeed, Owens Corning, Atlas) all require a dedicated starter strip at eaves AND rakes for the warranty to be valid. Carrier scopes that re-use field shingles as starter void the warranty and don't reflect modern install practice. Request a separate starter line at the perimeter LF.",
      xactimateCode: "RFG STRTR",
      severity: "expected",
      carrierRationale: {
        allstate:
          "Allstate's published 'Roof Loss Practice Guide' calls for separate starter strip at perimeter — line should be present unless adjuster's photos document existing field-shingle starter being reused, which voids manufacturer warranty.",
        progressive:
          "ASI/Progressive scopes routinely omit starter on architectural reroofs. GAF/Atlas/CertainTeed all require dedicated starter at eaves + rakes for the algae/wind warranty to apply.",
        "state-farm":
          "State Farm's own contractor agreement explicitly references manufacturer install requirements — starter at eaves and rakes is part of those requirements.",
      },
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      // Only fires on shingle reroofs.
      if (
        ctx.assumptions.material !== "asphalt-architectural" &&
        ctx.assumptions.material !== "asphalt-3tab"
      ) {
        return null;
      }
      const hasStarter = ctx.carrierLineItems.some((it) =>
        /\bstarter\b|\bRFG.?STRT/i.test(it.description),
      );
      if (hasStarter) return null;
      return {
        rule,
        reason: "Shingle reroof scope has no starter-course line — required by manufacturer install instructions for warranty.",
        estimatedDollars: null,
      };
    },
  },

  {
    rule: {
      id: "step-flashing-missing",
      title: "Step flashing at sidewalls not on scope",
      rationale:
        "IRC R905.2.8.3 requires step flashing at every roof-to-wall intersection. Reusing existing step flashing is non-compliant when shingles are being replaced — the flashing comes out with the shingles. Request step flashing be added at every wall intersection LF.",
      xactimateCode: "RFG STPFL",
      severity: "expected",
      carrierRationale: {
        "state-farm":
          "State Farm's roofing supplement guide explicitly calls for step flashing replacement at any sidewall on a reroof — re-using existing flashing voids the underlayment seal.",
        allstate:
          "Allstate Roof Claims Practice Guide identifies step flashing as a required line for any wall intersection in the loss area.",
        usaa:
          "USAA's PDRP (Preferred Direct Repair Program) contractor scope template includes step flashing at all sidewalls by default — its absence on an adjuster scope is a known omission.",
        travelers:
          "Travelers' published contractor guidelines require step flashing replacement on reroof when shingles are torn off; reuse is not warrantable.",
        "liberty-mutual":
          "Liberty Mutual claims handling manual identifies step flashing as code-required (IRC R905.2.8.3) and not legitimately reusable on a tear-off.",
      },
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      if (
        ctx.assumptions.material !== "asphalt-architectural" &&
        ctx.assumptions.material !== "asphalt-3tab"
      ) {
        return null;
      }
      const hasStep = ctx.carrierLineItems.some((it) =>
        /\bstep.?flash\b|\bRFG.?STPF/i.test(it.description),
      );
      if (hasStep) return null;
      return {
        rule,
        reason: "No step-flashing line on scope. Required at every roof-to-wall intersection per IRC R905.2.8.3.",
        estimatedDollars: null,
      };
    },
  },

  {
    rule: {
      id: "kickout-flashing-missing",
      title: "Kick-out flashing at wall terminations not on scope",
      rationale:
        "IRC R905.2.8.3 (2018 and later) requires a kick-out flashing at every point where a roof edge meets a wall that continues past the roof line — without it, water runs behind the wall cladding and causes hidden rot. Single EA item per termination point, but routinely omitted from carrier scopes.",
      xactimateCode: "RFG KOFL",
      severity: "expected",
      carrierRationale: {
        "liberty-mutual":
          "Liberty Mutual's own roof inspection checklist (in the adjuster training manual) lists kick-out flashing as a required line item on any wall-roof termination — its absence is a known scope gap.",
        "state-farm":
          "State Farm contractor scope template flags kick-out flashing as a separate EA line where wall continues past roof edge.",
      },
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      if (
        ctx.assumptions.material !== "asphalt-architectural" &&
        ctx.assumptions.material !== "asphalt-3tab"
      ) {
        return null;
      }
      const hasKickout = ctx.carrierLineItems.some((it) =>
        /\bkick.?out\b|\bdiverter\b|\bRFG.?KOFL/i.test(it.description),
      );
      // Only fire if step flashing IS present (otherwise the bigger
      // step-flashing flag will fire and this is duplicative).
      const hasStep = ctx.carrierLineItems.some((it) =>
        /\bstep.?flash\b/i.test(it.description),
      );
      if (hasKickout || !hasStep) return null;
      return {
        rule,
        reason: "Scope has step flashing but no kick-out flashing at wall terminations — required by IRC R905.2.8.3.",
        estimatedDollars: null,
      };
    },
  },

  {
    rule: {
      id: "valley-metal-missing",
      title: "Valley metal not on scope (open or closed-cut valleys)",
      rationale:
        "Manufacturer install instructions (GAF, CertainTeed, Owens Corning) require either valley metal underlayment OR ice-and-water shield + woven/closed-cut valley shingles. If neither is in scope, the valley install isn't warrantable. Request valley metal LF or confirm IWS is scoped through the valleys.",
      xactimateCode: "RFG VALY",
      severity: "common",
      carrierRationale: {
        allstate:
          "Allstate Roof Claims Practice Guide specifies valley metal as a line item when valleys are present on the loss area.",
        travelers:
          "Travelers contractor guidelines call for valley metal on any tear-off with open valleys; closed-cut valleys must have IWS lining the valley centerline.",
        nationwide:
          "Nationwide claim handling guide identifies valley metal omission as a top-5 scope gap on architectural-shingle reroofs.",
      },
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      if (
        ctx.assumptions.material !== "asphalt-architectural" &&
        ctx.assumptions.material !== "asphalt-3tab"
      ) {
        return null;
      }
      const hasValley = ctx.carrierLineItems.some((it) =>
        /\bvalley\b|\bRFG.?VAL/i.test(it.description),
      );
      if (hasValley) return null;
      return {
        rule,
        reason: "No valley-metal (or valley-IWS) line on scope — required by manufacturer for warrantable valley install.",
        estimatedDollars: null,
      };
    },
  },

  {
    rule: {
      id: "penetration-flashing-missing",
      title: "Pipe / vent penetration flashings not on scope",
      rationale:
        "Every plumbing vent, exhaust fan, and electrical mast penetration through the roof requires a new flashing boot/collar on a reroof — re-using boots from a 15+ year old roof guarantees future leaks. Request one EA per penetration visible in the inspection photos.",
      xactimateCode: "RFG PENFL",
      severity: "common",
      carrierRationale: {
        farmers:
          "Farmers' own roof scope template includes pipe-jack flashings on every reroof as an itemized EA line — its omission is a known shortcut.",
        "liberty-mutual":
          "Liberty Mutual claims manual identifies plumbing-vent boot reuse as a leading cause of post-reroof leaks; replacement is the standard scope.",
      },
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      if (
        ctx.assumptions.material !== "asphalt-architectural" &&
        ctx.assumptions.material !== "asphalt-3tab"
      ) {
        return null;
      }
      const hasPenFlash = ctx.carrierLineItems.some((it) =>
        /\b(pipe|plumb|vent).?(jack|flash|boot|collar)\b|\bRFG.?PEN/i.test(
          it.description,
        ),
      );
      if (hasPenFlash) return null;
      return {
        rule,
        reason: "No pipe-jack / vent-boot replacement line on scope — required when shingles around penetrations are being replaced.",
        estimatedDollars: null,
      };
    },
  },

  {
    rule: {
      id: "ridge-cap-on-architectural",
      title: "Hand-cut field shingles used as ridge cap (architectural)",
      rationale:
        "Manufacturer install instructions (GAF Seal-A-Ridge, CertainTeed Shadow Ridge, Owens Corning ProEdge, Atlas Pro-Cut) require a dedicated hip & ridge cap product on architectural shingle reroofs. Hand-cutting 3-tab from field shingles voids the algae and wind warranty. If the scope shows 'ridge cap' as field-shingle linear feet rather than a specific cap product, request the proper hip & ridge cap line.",
      xactimateCode: "RFG RIDGC",
      severity: "common",
      carrierRationale: {
        "state-farm":
          "State Farm's contractor agreement references manufacturer install requirements — dedicated hip & ridge cap is required for warranty.",
        usaa:
          "USAA PDRP contractor template specifies brand-matched ridge cap (e.g., GAF Seal-A-Ridge with GAF Timberline field) as the standard scope.",
        farmers:
          "Farmers roof scope template includes manufacturer-specific hip & ridge cap as a separate line from field shingles.",
        nationwide:
          "Nationwide's own claim guidelines require dedicated hip & ridge cap on architectural reroofs to preserve the manufacturer warranty.",
      },
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      if (ctx.assumptions.material !== "asphalt-architectural") return null;
      // Did they price ridge cap as a dedicated product line?
      const hasProperCap = ctx.carrierLineItems.some((it) =>
        /\b(seal.?a.?ridge|shadow.?ridge|proedge|pro.?cut|hip.?(and|&|n).?ridge)\b|\bRFG.?RIDGC\b/i.test(
          it.description,
        ),
      );
      // Or are they pricing it as field-shingle LF (hand cut)?
      const hasFieldShingleCap = ctx.carrierLineItems.some((it) =>
        /\bridge.?cap\b/i.test(it.description) &&
        /\bLF\b/i.test(it.unit ?? "") &&
        !/\b(seal.?a.?ridge|shadow.?ridge|proedge|pro.?cut|hip.?(and|&|n).?ridge)\b/i.test(
          it.description,
        ),
      );
      if (hasProperCap || !hasFieldShingleCap) return null;
      return {
        rule,
        reason: "Carrier scope prices ridge cap as field-shingle LF (hand-cut), not a dedicated hip & ridge cap product — voids manufacturer warranty.",
        estimatedDollars: null,
      };
    },
  },

  {
    rule: {
      id: "extended-iws-missing",
      title: "Extended ice & water shield coverage (>3ft) not on scope",
      rationale:
        "IRC R905.1.2 requires ice & water shield extending at least 24 inches inside the exterior wall line at eaves. In cold-climate states (MN, northern TX), and on low-slope sections, USAA and FL Peninsula scope guidelines specifically recommend extending IWS to 6 ft or full-roof. If the scope's IWS quantity equals only the eave-edge length, it's likely under-scoped.",
      xactimateCode: "RFG IWS",
      severity: "common",
      carrierRationale: {
        usaa:
          "USAA's own loss-prevention guide recommends extended IWS coverage (6 ft at eaves, full coverage on low-slope sections) in cold climates and HVHZ — verify the scope's IWS sqft matches.",
        nationwide:
          "Nationwide's roofing-loss guide recommends 6 ft of IWS at eaves in northern climates; standard 3 ft strip is the minimum, not the spec.",
        citizens:
          "Citizens FL HVHZ scopes should include IWS over the entire roof deck per FBC 7th ed. §R905.1.2 — if the scope shows only 3 ft strips, full-deck IWS is required and missing.",
      },
    },
    check: (ctx, rule) => {
      if (ctx.carrierLineItems.length === 0) return null;
      // Only fire when state is cold-climate OR FL HVHZ. We can't tell
      // HVHZ vs non-HVHZ FL from state alone, so only fire on MN and FL
      // (FL covered by the separate `ice-water-shield-fl-hvhz` rule
      // when missing entirely; this fires when present but under-spec).
      const coldOrHvhz = ["MN", "FL"].includes(ctx.state ?? "");
      if (!coldOrHvhz) return null;
      const iwsLine = ctx.carrierLineItems.find((it) =>
        /ice.?(and|&|n).?water|\bIWS\b|grace.?ultra|winterguard/i.test(
          it.description,
        ),
      );
      if (!iwsLine || iwsLine.quantity == null) return null;
      const roofSqft = ctx.assumptions.sqft ?? 0;
      if (roofSqft <= 0) return null;
      // Heuristic: if IWS qty is < 25% of roof area, it's an eaves-only
      // strip; carriers in this list should be specifying more.
      const iwsCoverageFraction = iwsLine.quantity / roofSqft;
      if (iwsCoverageFraction >= 0.25) return null;
      return {
        rule,
        reason: `Scope shows IWS at ${iwsLine.quantity} sqft (${Math.round(iwsCoverageFraction * 100)}% of ${roofSqft} sqft roof) — looks like eaves-only minimum, not the extended coverage typical in ${ctx.state}.`,
        estimatedDollars: null,
      };
    },
  },

  {
    rule: {
      id: "citizens-fl-sb2d-age-denial",
      title: "Citizens FL roof age cap (SB 2-D) — verify policy form",
      rationale:
        "Florida SB 2-D (2022) allowed Citizens and other admitted FL carriers to offer policy forms with roof age-based coverage caps (typically ACV-only on roofs >10 years old, sometimes >15 years). If the policy form on the DoL is one of these capped forms, the carrier may be issuing an ACV settlement when the insured expected RCV. Verify the dec page — if uncapped, the full RCV scope is owed.",
      xactimateCode: "POLICY-CHECK",
      severity: "required",
      carriers: ["citizens"],
      states: ["FL"],
    },
    check: (ctx, rule) => {
      if (ctx.state !== "FL") return null;
      if (ctx.carrier !== "citizens") return null;
      const age = ctx.assumptions.ageYears ?? 0;
      if (age < 10) return null;
      return {
        rule,
        reason: `Citizens FL claim on a ${age}yr roof — post-SB-2D policy forms may cap recovery to ACV at this age. Pull the dec page and confirm RCV applies before negotiating scope.`,
        estimatedDollars: null,
      };
    },
  },
];

/**
 * Run every rule against the context and return all that fired,
 * ordered by severity (required → advisory). The Supplement Analyzer
 * UI groups by severity and shows the dollar impact when computed.
 */
export function evaluateSupplementRules(
  ctx: SupplementContext,
): SupplementFlag[] {
  const sevOrder: Record<SupplementSeverity, number> = {
    required: 0,
    expected: 1,
    common: 2,
    advisory: 3,
  };
  const fired: SupplementFlag[] = [];
  for (const { rule, check } of RULES) {
    try {
      const f = check(ctx, rule);
      if (!f) continue;
      // Apply per-carrier rationale / severity overrides if the
      // context's carrier matches a key in the rule's override maps.
      // We build a shallow-cloned rule so we don't mutate the catalog.
      const carrier = ctx.carrier;
      const carrierRationale =
        carrier && rule.carrierRationale?.[carrier]
          ? rule.carrierRationale[carrier]
          : undefined;
      const carrierSeverity =
        carrier && rule.carrierSeverity?.[carrier]
          ? rule.carrierSeverity[carrier]
          : undefined;
      if (carrierRationale || carrierSeverity) {
        fired.push({
          ...f,
          rule: {
            ...rule,
            rationale: carrierRationale ?? rule.rationale,
            severity: carrierSeverity ?? rule.severity,
          },
        });
      } else {
        fired.push(f);
      }
    } catch (err) {
      console.warn(`[supplement-rules] check threw for ${rule.id}:`, err);
    }
  }
  fired.sort(
    (a, b) => sevOrder[a.rule.severity] - sevOrder[b.rule.severity],
  );
  return fired;
}

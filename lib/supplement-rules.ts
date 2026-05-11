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
  // Florida-specific: §626.9744 matching law. When one slope is
  // damaged, the carrier must pay to match the rest of the roof if
  // the same material isn't reasonably available. This is the single
  // biggest dollar lift on partial-slope FL claims.
  // ──────────────────────────────────────────────────────────────────
  {
    rule: {
      id: "fl-matching-law",
      title: "FL §626.9744 matching may apply (partial slope damaged)",
      rationale:
        "Florida Statute §626.9744 requires insurers to pay for replacement of undamaged roof areas when matching the existing material isn't reasonably available. This is the controlling matching-law standard in Florida and applies to any partial-slope claim where the existing shingles are 5+ years old (discontinued color/style typical at that age).",
      xactimateCode: "MATCH",
      severity: "common",
      states: ["FL"],
    },
    check: (ctx, rule) => {
      if (ctx.state !== "FL") return null;
      if ((ctx.assumptions.ageYears ?? 0) < 5) return null;
      return {
        rule,
        reason: `Property is in FL, roof age ${ctx.assumptions.ageYears}yr. Partial-slope claims at this age routinely qualify for §626.9744 matching — verify scope covers all slopes or push for matching.`,
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
      if (f) fired.push(f);
    } catch (err) {
      console.warn(`[supplement-rules] check threw for ${rule.id}:`, err);
    }
  }
  fired.sort(
    (a, b) => sevOrder[a.rule.severity] - sevOrder[b.rule.severity],
  );
  return fired;
}

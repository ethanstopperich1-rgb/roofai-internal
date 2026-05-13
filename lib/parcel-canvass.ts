/**
 * Parcel-backed canvass-list builder + hot-lead scoring.
 *
 * Called by `/api/cron/storm-pulse` and `scripts/enrich_permits.py`
 * after the parcels table is populated by `scripts/ingest_parcels.py`.
 *
 * Two-phase scoring:
 *
 *   PHASE 1 — `rankParcels()` (at storm-pulse creation time)
 *     Base score = hail_inches × 10 × proximity_decay. This is the
 *     score that lands in canvass_targets the moment a storm event is
 *     detected. Permit data isn't known yet at this point — enrichment
 *     runs separately on a delay.
 *
 *   PHASE 2 — `scoreHotLead()` (after enrich_permits.py finishes)
 *     Full hot-lead score = base + permit_recency + age_bonus +
 *     post_storm_penalty. Applied as a UPDATE on the canvass_targets
 *     row by the enrichment worker once portal queries finish.
 *
 * Rubric (from the Noland's canvass spec):
 *
 *   MUST-PASS FILTERS (gate, not scored — drop everything else):
 *     • Land use = single-family residential
 *     • Inside hail corridor (ST_DWithin already enforces this)
 *     • Hail size ≥ 0.75-1.0" in that cell
 *
 *   HOT-LEAD SCORING (additive over the hail × proximity base):
 *     Roof Permit Recency
 *       • No permit in last 15 yrs (or never)  → +50
 *       • No permit in last 10 yrs              → +30
 *       • Permit < 5 yrs ago                    → −40
 *     Permit Type Keywords
 *       • Matches: roof | reroof | re-roof |
 *         roof replacement | roof repair |
 *         building – roof                       → "counts" as roof permit
 *       (Anything else doesn't trigger recency)
 *     Estimated Roof Age
 *       • Year built > 20 yrs AND no recent permit → +25
 *     Hail × Proximity                           multiplicative base
 *     Post-storm activity
 *       • Roof permit filed AFTER storm_date    → −100 (already claimed)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ParcelHit {
  county_fips: string;
  parcel_id: string;
  owner_name: string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  centroid_lat: number;
  centroid_lng: number;
  distance_miles: number;
  year_built: number | null;
  just_value: number | null;
}

export interface CanvassRanked extends ParcelHit {
  /** Composite score. Higher = canvass first. Capped at +200 / floored
   *  at -200 to fit the numeric(5,2) column comfortably. */
  score: number;
}

export interface PermitContext {
  /** Date of the most recent qualifying ROOF permit on file. Null when
   *  the portal returned no roof permits or hasn't been queried yet. */
  lastRoofPermitDate: Date | null;
  /** Storm event date — used for the post-storm-activity penalty. */
  stormDate: Date;
  /** Year the home was built. Drives the age bonus. */
  yearBuilt: number | null;
}

/* ─── Phase 1: base scoring (hail × proximity) ────────────────────────── */

/**
 * Spatial query for residential parcels within `radiusMiles` of
 * (lat, lng). Uses ST_DWithin on the geography cast for accurate
 * great-circle distance — the GIST index on parcels.geom keeps this
 * sub-second even on the full 9M-row statewide table.
 */
export async function parcelsWithinRadius(
  sb: SupabaseClient,
  lat: number,
  lng: number,
  radiusMiles: number,
  opts: { residentialOnly?: boolean; limit?: number } = {},
): Promise<ParcelHit[]> {
  const { residentialOnly = true, limit = 5_000 } = opts;
  const { data, error } = await sb.rpc("parcels_within_radius", {
    p_lat: lat,
    p_lng: lng,
    p_radius_miles: radiusMiles,
    p_residential_only: residentialOnly,
    p_limit: limit,
  });
  if (error) {
    if (error.message?.includes("does not exist")) {
      console.warn("[parcel-canvass] RPC missing; parcels migration not yet applied");
      return [];
    }
    throw new Error(`parcels_within_radius failed: ${error.message}`);
  }
  return (data ?? []) as ParcelHit[];
}

/**
 * Phase-1 score = hail × proximity. Applied at canvass_targets
 * creation time, before any permit data is known. Permit-aware
 * recovery + age bonus happens in `scoreHotLead()` after enrichment.
 */
export function rankParcels(
  hits: ParcelHit[],
  peakInches: number,
): CanvassRanked[] {
  const ranked = hits.map((p) => {
    const base = hailProximityScore(peakInches, p.distance_miles);
    // Age bias at phase 1 — modest tilt so newly-created canvass rows
    // already favour older homes pre-enrichment. The big age bonus
    // (+25 for >20yr + no permit) lands at phase 2 once we know the
    // permit status.
    const ageNudge = p.year_built && new Date().getUTCFullYear() - p.year_built > 20 ? 5 : 0;
    return { ...p, score: roundScore(base + ageNudge) };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

/* ─── Phase 2: full hot-lead score (post-enrichment) ──────────────────── */

/**
 * Hot-lead score per the canvass rubric. Applied after
 * scripts/enrich_permits.py finishes pulling permit data for the
 * canvass_targets row.
 *
 * @param baseScore  Phase-1 hail × proximity score already on the row.
 * @param ctx        Permit context — last roof permit date, storm date,
 *                   year built.
 */
export function scoreHotLead(baseScore: number, ctx: PermitContext): number {
  let score = baseScore;
  const now = new Date();
  const lastPermit = ctx.lastRoofPermitDate;

  // ─── Post-storm activity penalty (−100, applied first) ───────────────
  // Roof permit filed AFTER the storm = competitor already canvassed or
  // homeowner already moved. Big red flag.
  if (lastPermit && lastPermit > ctx.stormDate) {
    score += -100;
    // Return early — don't also apply recency bonus for a permit pulled
    // in response to this storm. The penalty is the dominant signal.
    return roundScore(score);
  }

  // ─── Roof Permit Recency (additive) ──────────────────────────────────
  const yearsSinceLastPermit = lastPermit
    ? (now.getTime() - lastPermit.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
    : Number.POSITIVE_INFINITY; // no permit on record = treat as "forever"

  let recencyBonus = 0;
  if (yearsSinceLastPermit < 5) {
    recencyBonus = -40; // recent reroof — homeowner already covered
  } else if (yearsSinceLastPermit >= 15) {
    recencyBonus = +50; // 15+ years (or never) — hottest
  } else if (yearsSinceLastPermit >= 10) {
    recencyBonus = +30; // 10-15 years — warm
  }
  // 5-10 years = 0 (neutral)
  score += recencyBonus;

  // ─── Estimated Roof Age bonus (+25) ──────────────────────────────────
  // Year built > 20 yrs ago AND no recent permit. We treat "no recent
  // permit" as ≥10 years since last permit (matches the warm/hot
  // recency tiers). Older homes in FL = bigger insurance claims.
  if (ctx.yearBuilt) {
    const homeAge = now.getUTCFullYear() - ctx.yearBuilt;
    const noRecentPermit = yearsSinceLastPermit >= 10;
    if (homeAge > 20 && noRecentPermit) {
      score += 25;
    }
  }

  return roundScore(score);
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function hailProximityScore(peakInches: number, distanceMiles: number): number {
  // peak_inches × 10 × proximity_decay
  // 1.00" hail at 0 mi = 10pts; 1.50" hail at 0.5 mi = 10pts; etc.
  const proximityFactor = 1 / (1 + Math.max(0, distanceMiles));
  return peakInches * 10 * proximityFactor;
}

function roundScore(s: number): number {
  // Clamp to [-200, 200] so a post-storm penalty + small base doesn't
  // blow past the numeric(5,2) column bounds (which is +/-999.99
  // technically, but tightening makes UI sorting saner).
  const clamped = Math.max(-200, Math.min(200, s));
  return Math.round(clamped * 100) / 100;
}

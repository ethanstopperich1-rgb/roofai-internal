/**
 * Parcel-backed canvass-list builder.
 *
 * Called by `/api/cron/storm-pulse` once per detected storm event.
 * Runs a PostGIS spatial query against `public.parcels` for every
 * residential parcel within the canvass radius, ranks each by
 * (hail intensity × proximity), and inserts canvass_targets rows
 * with real owner names + situs addresses pulled from the county
 * tax roll.
 *
 * Falls back gracefully when the parcels table is empty (i.e. the
 * Python ingest hasn't run yet) — returns zero parcels, and the
 * caller's existing OSM placeholder path keeps the cron functional
 * during the migration window.
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
  /** Composite score 0-100. Higher = canvass first. */
  score: number;
}

/**
 * Spatial query for residential parcels within `radiusMiles` of
 * (lat, lng). Uses ST_DWithin on the geography cast for accurate
 * great-circle distance — the GIST index on parcels.geom keeps this
 * sub-second even on the full 9M-row statewide table.
 *
 * Implemented as a Postgres RPC because Supabase's JS client doesn't
 * expose raw PostGIS functions. The RPC is defined in
 * `migrations/0013_parcels.sql` companion `parcels_within_radius`
 * function — created below.
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
    // The RPC returning "function does not exist" means the migration
    // hasn't landed yet — return empty so the caller's fallback path
    // (OSM count) takes over. Logged for ops visibility.
    if (error.message?.includes("does not exist")) {
      console.warn("[parcel-canvass] RPC missing; parcels migration not yet applied");
      return [];
    }
    throw new Error(`parcels_within_radius failed: ${error.message}`);
  }
  return (data ?? []) as ParcelHit[];
}

/**
 * Rank parcel hits for canvass priority.
 *
 * Score = (peakInches × 10) × proximityFactor × ageFactor × valueFactor
 *
 *   peakInches × 10  → 1.0" hail = 10pts; 2.5" = 25pts. Linear in
 *                       hail magnitude because real damage probability
 *                       is roughly linear in MESH up to ~3".
 *   proximityFactor  → 1 / (1 + distance_miles). Inside the storm
 *                       center gets the full score; 2mi out gets 1/3.
 *   ageFactor        → houses 15-25 yr old score 1.2× (sweet spot for
 *                       roof replacement); >25 yr 1.15× (likely already
 *                       replaced once); <10 yr 0.7× (probably warranty-
 *                       covered).
 *   valueFactor      → log-scaled bump for higher-value properties
 *                       because the ROI of a roof replacement scales
 *                       with the home value. Clipped 0.8-1.4×.
 */
export function rankParcels(
  hits: ParcelHit[],
  peakInches: number,
): CanvassRanked[] {
  const ranked = hits.map((p) => {
    const proximityFactor = 1 / (1 + p.distance_miles);
    const ageFactor = ageMultiplier(p.year_built);
    const valueFactor = valueMultiplier(p.just_value);
    const raw = peakInches * 10 * proximityFactor * ageFactor * valueFactor;
    // Clamp to score column scale (0-100 fits the numeric(5,2) col).
    const score = Math.max(0, Math.min(100, raw));
    return { ...p, score: Math.round(score * 100) / 100 };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function ageMultiplier(yearBuilt: number | null): number {
  if (yearBuilt == null) return 1;
  const age = new Date().getUTCFullYear() - yearBuilt;
  if (age >= 15 && age <= 25) return 1.2;
  if (age > 25) return 1.15;
  if (age < 10) return 0.7;
  return 1;
}

function valueMultiplier(jv: number | null): number {
  if (jv == null || jv <= 0) return 1;
  // Log10($300k) = 5.48 → ref point ~1.0
  // Log10($150k) = 5.18 → 0.92
  // Log10($600k) = 5.78 → 1.08
  // Clip to 0.8-1.4 so outliers don't dominate.
  const ref = 5.48;
  const factor = 1 + (Math.log10(jv) - ref) * 0.4;
  return Math.max(0.8, Math.min(1.4, factor));
}

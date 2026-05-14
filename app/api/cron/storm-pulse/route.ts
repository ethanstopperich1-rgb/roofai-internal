import { NextResponse } from "next/server";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import { parcelsWithinRadius, rankParcels } from "@/lib/parcel-canvass";

export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * GET /api/cron/storm-pulse
 *
 * Daily scan for the storm-trigger lead engine.
 *
 *   1. For each watched region (per-office), fetch the trailing 48-hour
 *      MRMS event window via /api/hail-mrms.
 *   2. For each ≥1" event detected, upsert a `storm_events` row
 *      (deduped on office_id × event_date × region_name).
 *   3. For each newly-created storm event, queue a canvass batch by
 *      counting OSM buildings inside the polygon; rows go into
 *      `canvass_targets` with score = peak_inches × 10 × (1 / (1 + dist))
 *      (heuristic; refined post-pilot with conversion data).
 *
 * Triggered by Vercel cron at 06:00 UTC daily (see vercel.json). The
 * window covers the prior day's evening storms + early-morning convective
 * activity in CST/EST — the high-value window for FL roofing canvass.
 *
 * Auth: same CRON_SECRET / x-vercel-cron-signature pattern as the SAM3
 * warm cron.
 */

// Watched regions for v1 — hardcoded against the seed `voxaris` office.
// In production, each office's admin UI inserts rows into a
// future `watched_regions` table and the cron iterates that. For the
// demo we use three FL metros where roofing demand peaks.
const WATCHED_REGIONS = [
  { name: "Orlando, FL", lat: 28.5384, lng: -81.3792, radiusMiles: 25 },
  { name: "Tampa, FL", lat: 27.9506, lng: -82.4572, radiusMiles: 25 },
  { name: "Lakeland, FL", lat: 28.0395, lng: -81.9498, radiusMiles: 25 },
];

// MIN_HAIL_INCHES = 0.5 — Noland's reports closing deals on
// half-inch hail events. Conventional industry threshold is 0.75-1.0",
// but FL roofs are aged + UV-degraded enough that a 0.5" event is
// often the trigger for a claim that was already brewing (granule
// loss, marginal age, prior storm damage). First-roofer-at-the-door
// also wins relationships independent of actual damage.
//
// If MRMS produces too much noise at this threshold (false positives
// = wasted truck rolls), tune up to 0.75. Per-office override goes
// on the offices table when the multi-tenant feature ships.
const MIN_HAIL_INCHES = 0.5;
const CANVASS_RADIUS_MILES = 2.0;

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return req.headers.has("x-vercel-cron-signature");
  }
  return req.headers.get("authorization") === `Bearer ${expected}`;
}

interface MrmsEvent {
  date: string;
  maxInches: number;
  hitCount: number;
  distanceMiles: number;
}

interface PulseRegionResult {
  region: string;
  eventsDetected: number;
  newStormEvents: number;
  newCanvassTargets: number;
  error?: string;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!supabaseServiceRoleConfigured()) {
    return NextResponse.json({
      status: "skipped",
      reason: "Supabase service role not configured — set SUPABASE_SERVICE_ROLE_KEY",
    });
  }

  const sb = createServiceRoleClient();

  // Resolve the seed office for the v1 hardcoded regions. Per-office
  // watched-regions land in a future migration; until then every event
  // is tagged to the seed `voxaris` office.
  const { data: office } = await sb
    .from("offices")
    .select("id")
    .eq("slug", "voxaris")
    .maybeSingle();
  const seedOfficeId = office?.id ?? null;
  if (!seedOfficeId) {
    return NextResponse.json({
      status: "skipped",
      reason: "voxaris seed office not found — apply migration 0003_seed.sql",
    });
  }

  const origin = new URL(req.url).origin;
  const results: PulseRegionResult[] = [];

  for (const region of WATCHED_REGIONS) {
    const result: PulseRegionResult = {
      region: region.name,
      eventsDetected: 0,
      newStormEvents: 0,
      newCanvassTargets: 0,
    };

    let events: MrmsEvent[] = [];
    try {
      // Tight 48-hour window — anything older has been picked up by
      // yesterday's run.
      const res = await fetch(
        `${origin}/api/hail-mrms?lat=${region.lat}&lng=${region.lng}` +
          `&radiusMiles=${Math.min(5, region.radiusMiles)}` +
          `&yearsBack=1&minInches=${MIN_HAIL_INCHES}`,
        { cache: "no-store", signal: AbortSignal.timeout(25_000) },
      );
      if (res.ok) {
        const data = (await res.json()) as { events?: MrmsEvent[] };
        events = data.events ?? [];
      }
    } catch (err) {
      result.error = `mrms fetch failed: ${err instanceof Error ? err.message : "unknown"}`;
      results.push(result);
      continue;
    }

    // Trim to the last 48 hours
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const yyyymmdd = (d: Date) =>
      `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const cutoffKey = yyyymmdd(cutoff);
    const recent = events.filter((e) => e.date >= cutoffKey);
    result.eventsDetected = recent.length;

    for (const ev of recent) {
      const eventDateIso =
        ev.date.slice(0, 4) + "-" + ev.date.slice(4, 6) + "-" + ev.date.slice(6, 8);

      // Upsert storm_events on (office_id, event_date, region_name)
      const { data: upserted, error: upErr } = await sb
        .from("storm_events")
        .upsert(
          {
            office_id: seedOfficeId,
            region_name: region.name,
            center_lat: region.lat,
            center_lng: region.lng,
            radius_miles: region.radiusMiles,
            event_date: eventDateIso,
            peak_inches: ev.maxInches,
            hit_count: ev.hitCount,
            source: "mrms+spc",
          },
          { onConflict: "office_id,event_date,region_name" },
        )
        .select("id, detected_at")
        .single();

      if (upErr || !upserted) {
        result.error = `upsert storm_events failed: ${upErr?.message ?? "unknown"}`;
        continue;
      }

      // If detected_at is "near now" (< 5 min ago) we treat this as a
      // newly-created row and queue canvass targets. Existing rows are
      // skipped to avoid re-canvassing every day for the same event.
      const detectedAt = new Date(upserted.detected_at as string).getTime();
      const isNew = Date.now() - detectedAt < 5 * 60 * 1000;
      if (!isNew) continue;
      result.newStormEvents += 1;

      // Build the canvass list. PRIMARY path: PostGIS spatial join
      // against `public.parcels` populated by scripts/ingest_parcels.py
      // — real owner names + situs addresses + ranked score. FALLBACK:
      // if the parcels table is empty (ingest hasn't run yet) or the
      // RPC is missing (migration not yet applied), drop back to the
      // OSM placeholder so the cron stays functional during rollout.
      try {
        const hits = await parcelsWithinRadius(
          sb,
          region.lat,
          region.lng,
          CANVASS_RADIUS_MILES,
          { residentialOnly: true, limit: 5_000 },
        );

        if (hits.length > 0) {
          const ranked = rankParcels(hits, ev.maxInches);
          // Cap the canvass-target rows inserted per event. The full
          // ranked list is preserved on disk via storm_event_id →
          // canvass_targets join, but we don't need to insert all 5k
          // — the top 500 covers a generous "first wave" canvass.
          const top = ranked.slice(0, 500);
          // Batch insert. Postgrest handles arrays natively; if the
          // batch fails (e.g. on a single bad row), we fall back to
          // the OSM placeholder rather than leaving the event without
          // any canvass attached.
          // Bump this constant whenever scoreHotLead changes shape.
          // Lets the ML trainer (Phase 4) bucket rows by which rubric
          // produced them — apples-to-apples comparison across drift.
          const RUBRIC_VERSION = "2026-05-13.v1";
          const nowCreated = new Date();
          const rows = top.map((p) => ({
            office_id: seedOfficeId,
            storm_event_id: upserted.id,
            address_line: p.situs_address,
            city: p.situs_city,
            state: "FL",
            zip: p.situs_zip,
            lat: p.centroid_lat,
            lng: p.centroid_lng,
            score: p.score,
            distance_miles: p.distance_miles,
            status: "new",
            // FEATURES SNAPSHOT — frozen at score-time. Read once,
            // never updated. Drives the ML training pairs once
            // canvass_outcomes accumulates ≥500 closed rows. Schema
            // is flexible (JSONB); the trainer treats missing fields
            // as nulls so we can extend without migration churn.
            features_snapshot: {
              rubric_version: RUBRIC_VERSION,
              // Hail / proximity
              hail_inches: ev.maxInches,
              hit_count: ev.hitCount,
              distance_miles: p.distance_miles,
              // Property
              year_built: p.year_built ?? null,
              just_value: p.just_value ?? null,
              // Permit — at the moment of row creation. Subsequent
              // permit enrichment updates the canvass_targets columns
              // but NOT this snapshot, so the model sees what we knew
              // when we scored.
              permit_known_at_score_time: false,
              // Temporal context
              created_at_iso: nowCreated.toISOString(),
              created_dow: nowCreated.getUTCDay(),
              created_hour: nowCreated.getUTCHours(),
              // Storm metadata
              region_name: region.name,
              storm_event_date: eventDateIso,
              source: "mrms+spc",
            },
          }));
          // Cast through unknown — features_snapshot column post-dates
          // the generated types/supabase.ts. Regenerate types after
          // migration 0016 lands.
          const insertRes = await (sb as unknown as {
            from: (t: string) => {
              insert: (rows: unknown[]) => Promise<{ error: { message: string } | null }>;
            };
          })
            .from("canvass_targets")
            .insert(rows);
          if (!insertRes.error) {
            result.newCanvassTargets += top.length;
            // Continue to next event; PRIMARY path succeeded.
            continue;
          }
          // Log + fall through to OSM placeholder
          console.warn(
            "[storm-pulse] parcel insert failed, falling back to OSM:",
            insertRes.error.message,
          );
        }

        // FALLBACK — OSM-counted building summary row, same as v1
        const canvassRes = await fetch(
          `${origin}/api/storms/canvass-area?lat=${region.lat}&lng=${region.lng}` +
            `&radiusMiles=${CANVASS_RADIUS_MILES}`,
          { cache: "no-store", signal: AbortSignal.timeout(25_000) },
        );
        if (canvassRes.ok) {
          const data = (await canvassRes.json()) as { buildingCount: number };
          const insertRes = await sb.from("canvass_targets").insert({
            office_id: seedOfficeId,
            storm_event_id: upserted.id,
            lat: region.lat,
            lng: region.lng,
            score: Math.round(ev.maxInches * 100) / 10,
            distance_miles: ev.distanceMiles,
            status: "new",
          });
          if (!insertRes.error) {
            result.newCanvassTargets += data.buildingCount;
          }
        }
      } catch (err) {
        // Soft failure — the storm event itself is recorded.
        console.warn(
          "[storm-pulse] canvass build failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    results.push(result);
  }

  return NextResponse.json({
    status: "ok",
    runAt: new Date().toISOString(),
    regions: results,
  });
}

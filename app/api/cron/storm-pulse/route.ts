import { NextResponse } from "next/server";
import {
  createServiceRoleClient,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";

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

const MIN_HAIL_INCHES = 1.0;
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

      // Build the canvass list from OSM buildings within the canvass
      // radius. v1 inserts placeholder address rows tagged with
      // (lat, lng) only — the address-line gets populated once the
      // operator wires in their county parcel feed.
      try {
        const canvassRes = await fetch(
          `${origin}/api/storms/canvass-area?lat=${region.lat}&lng=${region.lng}` +
            `&radiusMiles=${CANVASS_RADIUS_MILES}`,
          { cache: "no-store", signal: AbortSignal.timeout(25_000) },
        );
        if (canvassRes.ok) {
          const data = (await canvassRes.json()) as { buildingCount: number };
          // Insert a single placeholder "summary" canvass-target row for
          // v1. This is enough to surface "N buildings to canvass" on the
          // operator dashboard. Per-address rows land when parcel data
          // is wired up — populating them now from OSM-only data would
          // be misleading (no owner info, no address lines).
          const insertRes = await sb.from("canvass_targets").insert({
            office_id: seedOfficeId,
            storm_event_id: upserted.id,
            lat: region.lat,
            lng: region.lng,
            score: Math.round(ev.maxInches * 100) / 10, // peak_inches * 10
            distance_miles: ev.distanceMiles,
            status: "new",
          });
          if (!insertRes.error) {
            result.newCanvassTargets += data.buildingCount;
          }
        }
      } catch {
        // Soft failure — the storm event itself is recorded.
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

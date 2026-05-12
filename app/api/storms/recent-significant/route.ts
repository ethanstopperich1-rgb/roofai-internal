import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { getCached, setCached } from "@/lib/cache";
import { scanHailEvents, type HailEvent } from "@/lib/hail-mrms";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/storms/recent-significant?lat=..&lng=..&radiusMiles=25&minInches=1.0
 *
 * Returns the SINGLE most recent qualifying hail event for the watched
 * region.
 *
 * Architecture note (2026-05-12 fix): previously this route did an
 * internal HTTP fetch to /api/hail-mrms and to /api/storms to assemble
 * the answer. The internal fetches silently failed in production —
 * recent-significant ran, hail-mrms returned 6 valid events, but the
 * roundtrip back inside the same Vercel function project consistently
 * dropped on us. /storms ended up rendering an empty state on a live
 * Orange-County demo with real data sitting in Blob.
 *
 * Refactored to call `scanHailEvents()` from lib/hail-mrms.ts
 * directly. No HTTP roundtrip, no rate-limit-via-self-fetch, no
 * silent timeout. NOAA Storm Events ground-report cross-reference is
 * still an HTTP fetch to /api/storms (separate BigQuery route) — that
 * one is optional, fails gracefully to 0 reports.
 */

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const radiusMiles = Math.max(1, Math.min(50, Number(searchParams.get("radiusMiles")) || 25));
  const minInches = Math.max(0.5, Number(searchParams.get("minInches")) || 1.0);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  // `v2` suffix added when this route was refactored to call
  // scanHailEvents() directly. The old cache holds `event: null`
  // results from when the internal HTTP fetch was failing — bumping
  // the scope invalidates those entries so the fix takes effect
  // immediately instead of after the 6h TTL.
  const scope = `storms-recent-v2-r${radiusMiles}-m${minInches.toFixed(1)}`;
  const cached = await getCached<unknown>(scope, lat, lng);
  if (cached) return NextResponse.json(cached);

  // Direct in-process scan. radiusMiles is capped at 5 here because
  // the cell-level MRMS scan uses a per-cell distance filter — beyond
  // 5 miles you get into "anywhere in central FL" territory, which
  // dilutes the "this event hit your watched region" signal. The
  // route's incoming radiusMiles is for the ground-report cross-ref
  // which uses point-level NOAA data.
  let events: HailEvent[] = [];
  try {
    const result = await scanHailEvents({
      lat,
      lng,
      radiusMiles: Math.min(5, radiusMiles),
      yearsBack: 3,
      minInches,
    });
    events = result.events;
  } catch (err) {
    console.warn("[recent-significant] hail scan failed:", err);
  }

  // Sort newest first (scanHailEvents already does this, but defensive).
  events.sort((a, b) => (a.date < b.date ? 1 : -1));
  const topEvent = events[0] ?? null;

  // Cross-reference with NOAA Storm Events for ground-report count.
  // Stays a soft HTTP fetch because BigQuery doesn't belong inline in
  // a hot read path. Fails gracefully to 0 reports.
  let groundReportCount = 0;
  if (topEvent) {
    const origin = new URL(req.url).origin;
    try {
      const stormsRes = await fetch(
        `${origin}/api/storms?lat=${lat}&lng=${lng}` +
          `&radiusMiles=${radiusMiles}&yearsBack=1`,
        { cache: "no-store", signal: AbortSignal.timeout(6_000) },
      );
      if (stormsRes.ok) {
        const data = (await stormsRes.json()) as {
          events?: Array<{ event_type?: string; date?: string | null }>;
        };
        const targetDay =
          topEvent.date.slice(0, 4) + "-" +
          topEvent.date.slice(4, 6) + "-" +
          topEvent.date.slice(6, 8);
        groundReportCount = (data.events ?? []).filter((e) =>
          (e.event_type ?? "").toLowerCase().includes("hail") &&
          typeof e.date === "string" &&
          e.date.startsWith(targetDay),
        ).length;
      }
    } catch (err) {
      console.warn("[recent-significant] ground-report fetch failed:", err);
    }
  }

  const result = {
    event: topEvent
      ? {
          date: topEvent.date,
          maxInches: topEvent.maxInches,
          hitCount: topEvent.hitCount,
          distanceMiles: topEvent.distanceMiles,
          groundReportCount,
          source: "mrms+spc" as const,
        }
      : null,
    coverage: { lat, lng, radiusMiles, minInches },
    queriedAt: new Date().toISOString(),
  };

  await setCached(scope, lat, lng, result);
  return NextResponse.json(result);
}

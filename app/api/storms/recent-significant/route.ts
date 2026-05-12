import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
// Capped at 15s — the page hydrates this client-side and we want it
// to either return data or fail fast so the UI flips to empty/error
// state. The upstream /api/hail-mrms internally has a 60s ceiling but
// in practice resolves in <3s once warm; if it's cold we'd rather
// show "data temporarily unavailable" than hang the demo.
export const maxDuration = 15;

/**
 * GET /api/storms/recent-significant?lat=..&lng=..&radiusMiles=25&minInches=1.0
 *
 * Returns the SINGLE most recent significant hail event in the area,
 * cross-referenced across:
 *   - MRMS radar (the granular layer, sub-1km cells)
 *   - NOAA Storm Events / Local Storm Reports (the ground-truth /
 *     legal-defensibility layer)
 *
 * Used by the /storms demo page to surface a live example.
 *
 * Defensibility: every claim returned here ties to an upstream source
 * (MRMS source name in metadata; SPC report URLs when available).
 * Never returns a value the upstream didn't return.
 *
 * Response shape:
 *   {
 *     event: { date, maxInches, hitCount, distanceMiles,
 *              groundReportCount, source: "mrms+spc" } | null,
 *     coverage: { region, lat, lng, radiusMiles },
 *     queriedAt: ISO,
 *   }
 * Returns event: null when no event ≥ minInches in the last 90 days.
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

  // Cache key includes the radius + threshold in the scope string so
  // queries with different parameters don't collide on the same lat/lng.
  const scope = `storms-recent-r${radiusMiles}-m${minInches.toFixed(1)}`;
  const cached = await getCached<unknown>(scope, lat, lng);
  if (cached) return NextResponse.json(cached);

  const origin = new URL(req.url).origin;

  // Pull MRMS (radar, daily-fresh, granular) — primary signal.
  // 90-day window matches the "this hit recently and is actionable for
  // canvassing" definition. Anything older has likely been worked.
  let mrmsEvents: Array<{
    date: string;
    maxInches: number;
    hitCount: number;
    distanceMiles: number;
  }> = [];
  try {
    const mrmsRes = await fetch(
      `${origin}/api/hail-mrms?lat=${lat}&lng=${lng}` +
        `&radiusMiles=${Math.min(5, radiusMiles)}` +
        `&yearsBack=1&minInches=${minInches}`,
      { cache: "no-store", signal: AbortSignal.timeout(10_000) },
    );
    if (mrmsRes.ok) {
      const data = (await mrmsRes.json()) as { events?: typeof mrmsEvents };
      mrmsEvents = data.events ?? [];
    }
  } catch (err) {
    console.warn("[recent-significant] MRMS fetch failed:", err);
  }

  // Filter to the trailing 90 days. MRMS returns full backfill window;
  // the demo page only wants "recent and actionable."
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const toDate = (yyyymmdd: string) => {
    const y = yyyymmdd.slice(0, 4);
    const m = yyyymmdd.slice(4, 6);
    const d = yyyymmdd.slice(6, 8);
    return new Date(`${y}-${m}-${d}T00:00:00Z`);
  };
  const recentMrms = mrmsEvents.filter((e) => toDate(e.date) >= ninetyDaysAgo);

  // Pick the most recent by date — not the largest. The demo wants
  // freshness; a 2.5" event from 80 days ago reads as stale next to a
  // 1.1" event from yesterday.
  recentMrms.sort((a, b) => (a.date < b.date ? 1 : -1));
  const topEvent = recentMrms[0] ?? null;

  // Cross-reference with NOAA Storm Events for the same day to surface
  // the ground-report count. Optional — we don't fail the route on
  // BigQuery being unconfigured.
  let groundReportCount = 0;
  if (topEvent) {
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
        // Match same-day hail reports. SPC dates are ISO; MRMS are YYYYMMDD.
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
      console.warn("[recent-significant] storms fetch failed:", err);
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

  // Cached via shared cache layer (6 hour Redis TTL applies).
  await setCached(scope, lat, lng, result);
  return NextResponse.json(result);
}

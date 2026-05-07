import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { list } from "@vercel/blob";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/hail-mrms?lat=&lng=&yearsBack=2&radiusMiles=2
 *
 * Returns radar-derived hail events at a property, sourced from NOAA
 * MRMS Maximum Estimated Size of Hail (MESH) — the same dataset
 * commercial products like HailTrace and Interactive Hail Maps build on
 * top of. ~1km radar resolution, far more granular than NOAA SPC's
 * human-filed Local Storm Reports (which we already serve via /api/storms).
 *
 * The MESH GRIB2 data is ingested daily by the GitHub Actions workflow
 * `.github/workflows/ingest-mrms.yml`, which decodes the PNG-compressed
 * grids and writes per-day cell lists to Vercel Blob at
 * `mrms-hail/YYYYMMDD.json`. This route reads those Blob files; no
 * GRIB2 parsing happens at request time.
 *
 * Why MRMS adds value over BigQuery NOAA SPC (which we already have):
 *   - Resolution: 1 km radar grid vs SPC's county-centroid points
 *   - Coverage: full radar footprint vs SPC's "someone called it in"
 *   - Threshold: catches sub-1" hail SPC misses
 *   - Latency: ~30 min behind real-time vs SPC's 30-60 day reporting lag
 *
 * Query params:
 *   lat, lng         — required, the property
 *   yearsBack        — int 1-5, default 2
 *   radiusMiles      — float 0.5-5.0, default 2.0 (MESH is 1km cells, so
 *                      <0.5 mi = same cell, >2 mi = neighborhood-scale)
 *   minInches        — float, default 0.5 (≥0.75" causes shingle damage,
 *                      ≥1" causes granule loss + bruising)
 *
 * Returns:
 *   { events: [{ date, maxInches, maxMm, hitCount, distanceMiles }],
 *     source: "noaa-mrms-mesh-1km",
 *     coverage: { yearsAvailable, earliestDate, latestDate } }
 */

interface MrmsCell {
  lat: number;
  lng: number;
  mm: number;
  in: number;
}

interface MrmsDayDoc {
  date: string;
  cellCount: number;
  cells: MrmsCell[];
}

interface HailEvent {
  date: string;
  maxInches: number;
  maxMm: number;
  hitCount: number;
  /** Distance to the closest hail-affected cell in miles. */
  distanceMiles: number;
}

interface HailMrmsResponse {
  events: HailEvent[];
  source: "noaa-mrms-mesh-1km";
  coverage: {
    yearsAvailable: number;
    earliestDate: string | null;
    latestDate: string | null;
  };
}

/** Haversine distance in miles between two lat/lng points. */
function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * List the per-day MRMS Blob keys we have, oldest → newest. The
 * Vercel Blob `list()` API is paginated; we walk the cursor until
 * exhausted. Result is cached for 1 hour because daily ingest runs
 * once a day — listing more often is wasted Blob API calls.
 */
async function listMrmsKeys(): Promise<string[]> {
  const cached = await getCached<string[]>("mrms", 0, 0);
  if (cached) return cached;

  const dates: string[] = [];
  let cursor: string | undefined = undefined;
  for (let i = 0; i < 50; i++) {
    const page: Awaited<ReturnType<typeof list>> = await list({
      prefix: "mrms-hail/",
      limit: 1000,
      cursor,
    });
    for (const b of page.blobs) {
      const m = b.pathname.match(/^mrms-hail\/(\d{8})\.json$/);
      if (m) dates.push(m[1]);
    }
    if (!page.hasMore) break;
    cursor = page.cursor;
  }
  dates.sort();
  await setCached("mrms", 0, 0, dates);
  return dates;
}

/** Filenames are YYYYMMDD; lex-sort = chrono-sort. */
function dateInRangeYYYYMMDD(d: string, start: Date, end: Date): boolean {
  const y = parseInt(d.slice(0, 4), 10);
  const m = parseInt(d.slice(4, 6), 10) - 1;
  const day = parseInt(d.slice(6, 8), 10);
  const dt = Date.UTC(y, m, day);
  return dt >= start.getTime() && dt <= end.getTime();
}

export async function GET(req: Request) {
  const limited = await rateLimit(req, "standard");
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }
  const yearsBack = Math.min(
    5,
    Math.max(1, Number(searchParams.get("yearsBack")) || 2),
  );
  const radiusMiles = Math.min(
    5,
    Math.max(0.5, Number(searchParams.get("radiusMiles")) || 2.0),
  );
  const minInches = Math.max(
    0.5,
    Number(searchParams.get("minInches")) || 0.5,
  );
  const minMm = minInches * 25.4;

  // Cache hot path — same property + same window = same answer for the
  // life of the day's data. Bake the radius / minInches into the key
  // so different rep queries stay isolated.
  const cacheKey = `${radiusMiles.toFixed(2)}:${minInches.toFixed(2)}:${yearsBack}`;
  const cached = await getCached<HailMrmsResponse>(
    `mrms:${cacheKey}`,
    lat,
    lng,
  );
  if (cached) return NextResponse.json(cached);

  let allDates: string[];
  try {
    allDates = await listMrmsKeys();
  } catch (err) {
    console.warn("[hail-mrms] blob list failed:", err);
    return NextResponse.json(
      { error: "MRMS index unavailable", events: [] },
      { status: 503 },
    );
  }

  if (allDates.length === 0) {
    // Backfill hasn't run yet — return empty cleanly so the UI knows
    // it's a coverage gap, not a no-hail-history result.
    const empty: HailMrmsResponse = {
      events: [],
      source: "noaa-mrms-mesh-1km",
      coverage: { yearsAvailable: 0, earliestDate: null, latestDate: null },
    };
    await setCached(`mrms:${cacheKey}`, lat, lng, empty);
    return NextResponse.json(empty);
  }

  const now = new Date();
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - yearsBack);

  const datesInWindow = allDates.filter((d) =>
    dateInRangeYYYYMMDD(d, start, now),
  );

  // Coarse pre-filter: per-cell distance check is cheap, but skipping
  // entire days where the bbox center can't possibly be within radius
  // would be cheaper. The MRMS bbox is huge (24N→50N, -107→-79W) so
  // the bbox check would skip almost no days. We just iterate.
  const events: HailEvent[] = [];
  await Promise.all(
    datesInWindow.map(async (date) => {
      try {
        const url = `https://blob.vercel-storage.com/mrms-hail/${date}.json`;
        // Fall back to public Blob URL pattern. If our deploy stores
        // under a different store ID we override via env.
        const customBase = process.env.MRMS_BLOB_BASE;
        const fetchUrl = customBase
          ? `${customBase.replace(/\/$/, "")}/mrms-hail/${date}.json`
          : url;
        const r = await fetch(fetchUrl, {
          signal: AbortSignal.timeout(8_000),
          // Per-day Blob is immutable once written; let CDN cache forever
          cache: "force-cache",
        });
        if (!r.ok) return;
        const doc = (await r.json()) as MrmsDayDoc;
        if (!doc.cells || doc.cells.length === 0) return;

        let bestMm = 0;
        let bestDistance = Infinity;
        let hitCount = 0;
        for (const cell of doc.cells) {
          if (cell.mm < minMm) continue;
          const d = haversineMiles(lat, lng, cell.lat, cell.lng);
          if (d > radiusMiles) continue;
          hitCount++;
          if (cell.mm > bestMm) bestMm = cell.mm;
          if (d < bestDistance) bestDistance = d;
        }
        if (hitCount > 0) {
          events.push({
            date,
            maxInches: Math.round((bestMm / 25.4) * 100) / 100,
            maxMm: bestMm,
            hitCount,
            distanceMiles: Math.round(bestDistance * 10) / 10,
          });
        }
      } catch (err) {
        console.warn(`[hail-mrms] failed to read ${date}:`, err);
      }
    }),
  );

  events.sort((a, b) => b.date.localeCompare(a.date));

  const result: HailMrmsResponse = {
    events,
    source: "noaa-mrms-mesh-1km",
    coverage: {
      yearsAvailable:
        (parseInt(allDates[allDates.length - 1].slice(0, 4), 10) -
          parseInt(allDates[0].slice(0, 4), 10)) +
        1,
      earliestDate: allDates[0],
      latestDate: allDates[allDates.length - 1],
    },
  };

  await setCached(`mrms:${cacheKey}`, lat, lng, result);
  return NextResponse.json(result);
}

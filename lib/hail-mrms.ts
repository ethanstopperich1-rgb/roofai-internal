/**
 * MRMS hail event scanner.
 *
 * Lifted out of `app/api/hail-mrms/route.ts` so server-side callers
 * (like `/api/storms/recent-significant`) can read events directly
 * without an internal HTTP roundtrip. The previous architecture had
 * recent-significant fetching its own /api/hail-mrms endpoint —
 * which silently failed in production for reasons that turned out
 * to be load/rate/timing dependent, and dropped the live storm card
 * into its empty state with no diagnostic.
 *
 * The HTTP route (`/api/hail-mrms`) now thin-wraps this same function.
 * Two callers, one source of truth.
 */

import { list } from "@vercel/blob";

export interface HailEvent {
  date: string; // YYYYMMDD
  maxInches: number;
  maxMm: number;
  hitCount: number;
  /** Distance to the closest hail-affected cell in miles. */
  distanceMiles: number;
}

export interface HailMrmsResult {
  events: HailEvent[];
  source: "noaa-mrms-mesh-1km";
  coverage: {
    yearsAvailable: number;
    earliestDate: string | null;
    latestDate: string | null;
  };
}

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

interface MrmsKey {
  date: string;
  url: string;
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

function dateInRangeYYYYMMDD(d: string, start: Date, end: Date): boolean {
  const y = parseInt(d.slice(0, 4), 10);
  const m = parseInt(d.slice(4, 6), 10) - 1;
  const day = parseInt(d.slice(6, 8), 10);
  const dt = Date.UTC(y, m, day);
  return dt >= start.getTime() && dt <= end.getTime();
}

async function listMrmsKeys(): Promise<MrmsKey[]> {
  const out: MrmsKey[] = [];
  let cursor: string | undefined = undefined;
  for (let i = 0; i < 50; i++) {
    const page: Awaited<ReturnType<typeof list>> = await list({
      prefix: "mrms-hail/",
      limit: 1000,
      cursor,
    });
    for (const b of page.blobs) {
      const m = b.pathname.match(/^mrms-hail\/(\d{8})\.json$/);
      if (m) out.push({ date: m[1], url: b.url });
    }
    if (!page.hasMore) break;
    cursor = page.cursor;
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export interface ScanOptions {
  lat: number;
  lng: number;
  /** Capped at 5 by the route; pass through here. */
  radiusMiles: number;
  /** Capped at 5 by the route. */
  yearsBack: number;
  /** Minimum hail size threshold in inches. */
  minInches: number;
}

/**
 * Run the MRMS scan and return matching events. Throws on Blob list
 * failure; returns `events: []` cleanly on every other "no data" path.
 */
export async function scanHailEvents(opts: ScanOptions): Promise<HailMrmsResult> {
  const { lat, lng, radiusMiles, yearsBack, minInches } = opts;
  const minMm = minInches * 25.4;

  const allKeys = await listMrmsKeys();
  const allDates = allKeys.map((k) => k.date);

  if (allDates.length === 0) {
    return {
      events: [],
      source: "noaa-mrms-mesh-1km",
      coverage: { yearsAvailable: 0, earliestDate: null, latestDate: null },
    };
  }

  const now = new Date();
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - yearsBack);
  const keysInWindow = allKeys.filter((k) =>
    dateInRangeYYYYMMDD(k.date, start, now),
  );

  const events: HailEvent[] = [];
  const CHUNK_SIZE = 20;
  for (let i = 0; i < keysInWindow.length; i += CHUNK_SIZE) {
    const chunk = keysInWindow.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async ({ date, url }) => {
        try {
          const r = await fetch(url, {
            signal: AbortSignal.timeout(8_000),
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
          console.warn(`[hail-mrms scan] failed to read ${date}:`, err);
        }
      }),
    );
  }

  events.sort((a, b) => b.date.localeCompare(a.date));

  return {
    events,
    source: "noaa-mrms-mesh-1km",
    coverage: {
      yearsAvailable:
        parseInt(allDates[allDates.length - 1].slice(0, 4), 10) -
        parseInt(allDates[0].slice(0, 4), 10) +
        1,
      earliestDate: allDates[0],
      latestDate: allDates[allDates.length - 1],
    },
  };
}

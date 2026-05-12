import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
// 12s ceiling — gives 3 Overpass mirrors at 8s each a chance to
// respond. If all mirrors are slow, we fall through to the regional-
// density heuristic so the UI never hangs.
export const maxDuration = 12;

/**
 * GET /api/storms/canvass-area?lat=..&lng=..&radiusMiles=2
 *
 * Returns an approximate building count within the canvass radius around
 * a storm event. Sourced from OpenStreetMap Overpass — the same data the
 * polygon picker uses internally (lib/buildings.ts).
 *
 * What this is FOR: surfacing "≈ N buildings inside this hail footprint"
 * on the /storms demo page. It's an upper-bound count of CANVASS-ELIGIBLE
 * structures, not a confirmed list of residential properties — OSM
 * doesn't distinguish residential from outbuildings as reliably as a
 * county parcel feed would.
 *
 * What this is NOT: a list of addresses. We deliberately don't return
 * coordinates / addresses here because (a) OSM coverage is patchy on
 * addr:* tags, (b) the actionable address list comes from the
 * operator's county parcel integration, not from us shipping a flat
 * file.
 */

interface CanvassAreaResponse {
  buildingCount: number;
  /** When the count was sourced. OSM data changes; we cache 24h. */
  countedAt: string;
  source: "osm-overpass";
  /** True when we couldn't reach Overpass — falls back to a heuristic
   *  count from radius (assumes ~150 buildings per sq-mile in suburban
   *  FL). UI should disclose the fallback so the demo isn't misleading. */
  isEstimate: boolean;
  query: { lat: number; lng: number; radiusMiles: number };
}

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

async function queryOverpass(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<number | null> {
  // `out count` returns just the aggregate count — no per-element data
  // shipped over the wire, perfect for our "how many buildings" use case.
  // [timeout:3] tells Overpass to abort the query server-side after
  // 3s — matched to our per-mirror fetch timeout. Counting buildings
  // by radius is cheap on Overpass even at 25km, so 3s is plenty.
  const query = `
    [out:json][timeout:3];
    (
      way(around:${radiusMeters},${lat},${lng})["building"];
      relation(around:${radiusMeters},${lat},${lng})["building"];
    );
    out count;
  `.trim();

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "voxaris-pitch/1.0 (https://pitch.voxaris.io; contact: hello@voxaris.io)",
        },
        body: `data=${encodeURIComponent(query)}`,
        // 3.5s per mirror — total iteration over 3 mirrors fits under
        // the 12s route maxDuration. If all mirrors are slow we'd
        // rather fall through to the density-heuristic estimate than
        // hang the demo page.
        signal: AbortSignal.timeout(3_500),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        elements?: Array<{ tags?: { total?: string } }>;
      };
      const total = data.elements?.[0]?.tags?.total;
      if (typeof total === "string") {
        const n = Number.parseInt(total, 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch {
      // Try the next mirror
    }
  }
  return null;
}

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const radiusMiles = Math.max(
    0.25,
    Math.min(10, Number(searchParams.get("radiusMiles")) || 2),
  );
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  const scope = `canvass-area-r${radiusMiles}`;
  const cached = await getCached<CanvassAreaResponse>(scope, lat, lng);
  if (cached) return NextResponse.json(cached);

  const radiusMeters = Math.round(radiusMiles * 1609.34);
  const liveCount = await queryOverpass(lat, lng, radiusMeters);

  let buildingCount = liveCount ?? 0;
  let isEstimate = false;
  if (liveCount == null) {
    // Overpass mirrors all unreachable — fall back to a regional density
    // heuristic so the demo doesn't show "0 buildings." Suburban FL
    // averages ~150 buildings/sq-mile in residential zones; we use a
    // conservative 100 to avoid overclaiming.
    const areaSqMiles = Math.PI * radiusMiles * radiusMiles;
    buildingCount = Math.round(areaSqMiles * 100);
    isEstimate = true;
  }

  const result: CanvassAreaResponse = {
    buildingCount,
    countedAt: new Date().toISOString(),
    source: "osm-overpass",
    isEstimate,
    query: { lat, lng, radiusMiles },
  };

  await setCached(scope, lat, lng, result);
  return NextResponse.json(result);
}

/**
 * OpenStreetMap building-footprint lookup via the Overpass API.
 *
 * Given a lat/lng, returns the polygon of the building containing or
 * nearest to that point. Free, no auth, ~50-60% US residential coverage.
 * Falls back gracefully (returns null) when OSM has no building near the
 * address — caller then falls back to Claude's vision-derived polygon.
 *
 * Data is hand-traced by OSM contributors, so where it exists it's
 * usually accurate to within a few feet. Way more reliable than a
 * vision model trying to find a building in noisy aerial imagery.
 */

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",
];

const SEARCH_RADIUS_M = 60;
const QUERY_TIMEOUT_S = 8;

export interface BuildingPolygon {
  /** Closed polygon vertices, lat/lng order */
  latLng: Array<{ lat: number; lng: number }>;
  source: "osm";
  osmId?: number;
}

type OverpassResponse = {
  elements?: Array<{
    type?: string;
    id?: number;
    geometry?: Array<{ lat: number; lon: number }>;
    tags?: Record<string, string>;
  }>;
};

/**
 * Squared great-circle-ish distance from point to polygon centroid (m²).
 * Cheap proximity sort — we only need it to rank candidates, not measure.
 */
function distSqToCentroid(
  lat: number,
  lng: number,
  poly: Array<{ lat: number; lng: number }>,
): number {
  let cLat = 0, cLng = 0;
  for (const v of poly) { cLat += v.lat; cLng += v.lng; }
  cLat /= poly.length; cLng /= poly.length;
  const dLat = (cLat - lat) * 111_320;
  const dLng = (cLng - lng) * 111_320 * Math.cos((lat * Math.PI) / 180);
  return dLat * dLat + dLng * dLng;
}

/**
 * Real polygon area in m² via shoelace (lat/lng → meters via cosLat scale).
 * Used to rank candidate buildings — when none contain the click point we
 * tiebreak by area so a 30-vertex apartment doesn't win over the 4-vertex
 * house it should pick (the previous proxy used `polygon.length`, which
 * inverted that ranking).
 */
function polygonAreaM2(poly: Array<{ lat: number; lng: number }>): number {
  if (poly.length < 3) return 0;
  let cLat = 0;
  for (const v of poly) cLat += v.lat;
  cLat /= poly.length;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ax = a.lng * 111_320 * cosLat;
    const ay = a.lat * 111_320;
    const bx = b.lng * 111_320 * cosLat;
    const by = b.lat * 111_320;
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
}

/**
 * Ray-casting point-in-polygon test in lat/lng space (good enough at
 * residential parcel scale).
 */
function pointInPolygon(
  lat: number,
  lng: number,
  poly: Array<{ lat: number; lng: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat;
    const xj = poly[j].lng, yj = poly[j].lat;
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

async function queryOverpass(
  endpoint: string,
  query: string,
): Promise<OverpassResponse | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Overpass mirrors block requests without a meaningful User-Agent.
        // We were getting 406/429/403 across all three mirrors before this
        // header, which left the GIS reconciler with no fallback for FL
        // addresses (MS Buildings is TN-only). Per Overpass etiquette,
        // include a contact in the UA so they can reach us if we abuse it.
        "User-Agent":
          "voxaris-pitch/1.0 (https://pitch.voxaris.io; contact: hello@voxaris.io)",
      },
      body: `data=${encodeURIComponent(query)}`,
      cache: "no-store",
      signal: AbortSignal.timeout(QUERY_TIMEOUT_S * 1000 + 2000),
    });
    if (!res.ok) {
      console.warn(`[buildings] overpass ${endpoint} → ${res.status}`);
      return null;
    }
    return (await res.json()) as OverpassResponse;
  } catch (err) {
    console.warn(`[buildings] overpass ${endpoint} failed:`, err);
    return null;
  }
}

export async function fetchBuildingPolygon(opts: {
  lat: number;
  lng: number;
}): Promise<BuildingPolygon | null> {
  const { lat, lng } = opts;
  const query = `
    [out:json][timeout:${QUERY_TIMEOUT_S}];
    (
      way(around:${SEARCH_RADIUS_M},${lat},${lng})["building"];
    );
    out geom;
  `.trim();

  // Try mirrors in order — Overpass main endpoint can be flaky under load.
  let data: OverpassResponse | null = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    data = await queryOverpass(endpoint, query);
    if (data) break;
  }
  if (!data || !Array.isArray(data.elements) || data.elements.length === 0) {
    return null;
  }

  // Build candidate polygons from way geometries
  type Candidate = {
    polygon: Array<{ lat: number; lng: number }>;
    osmId?: number;
    contains: boolean;
    distSq: number;
    area: number;
  };
  const candidates: Candidate[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 3) continue;
    const polygon = el.geometry.map((p) => ({ lat: p.lat, lng: p.lon }));
    // Skip implausibly small structures (sheds, AC pads ≤ 15 m²)
    const area = polygonAreaM2(polygon);
    if (area < 15) continue;
    candidates.push({
      polygon,
      osmId: el.id,
      contains: pointInPolygon(lat, lng, polygon),
      distSq: distSqToCentroid(lat, lng, polygon),
      area,
    });
  }
  if (candidates.length === 0) return null;

  // Selection logic — engineered for rural parcels with outbuildings.
  //
  // Problem: on a 5-acre FL lot with a house, barn, shop, and two sheds,
  // Google's geocoder routinely snaps the address to the driveway entrance
  // or mailbox, which is closer to a roadside shed than to the main house.
  // A pure "closest building" sort then picks the wrong structure, and
  // SAM3 traces the shop's roof.
  //
  // Heuristic, in order:
  //   1. If any candidate CONTAINS the point, pick the smallest container
  //      (parcel polygons sometimes wrap multiple buildings).
  //   2. Otherwise, FILTER OUT candidates < 50 m² (sheds, carports, AC
  //      enclosures). A real residence is rarely under 540 sqft. We keep
  //      this filter strict because false-positives (tiny house, ADU) are
  //      a rare edge case while false-negatives (shed picked instead of
  //      house) are the common rural failure mode this PR fixes.
  //   3. Among remaining candidates, score each as
  //          score = sqrt(distSq) - 8 × ln(area)
  //      Lower wins. The area term means a 200 m² building 50m away beats
  //      a 50 m² building 10m away (which is exactly the rural shop-vs-
  //      house case). The sqrt keeps distance in meters so the constants
  //      stay interpretable.
  //   4. If the area filter empties the list (genuinely small structures
  //      only — tiny home, mobile home), fall back to closest-by-distance
  //      without the filter.
  const containers = candidates.filter((c) => c.contains);
  let best: Candidate;
  if (containers.length > 0) {
    containers.sort((a, b) => a.area - b.area);
    best = containers[0];
  } else {
    // Two-stage selection:
    //
    // Stage 1 — drop obvious non-residence structures by area.
    //   We use an 80 m² (≈ 860 sqft) floor. Almost no real FL residence is
    //   under 860 sqft. AC pads, detached carports, garden sheds, well
    //   houses, gazebos, pool equipment enclosures all sit under this.
    //
    // Stage 2 — rural-mode switch:
    //   If the closest remaining candidate is < 20m away AND a substantially
    //   larger one (≥1.6×) exists within 80m, prefer the larger one. The
    //   "closest small structure near the geocoded pin + bigger house set
    //   back" pattern is the classic rural FL failure mode this fixes.
    //
    //   Otherwise (suburban tight-spacing, single candidate, similar sizes),
    //   fall back to closest-by-distance ranking which is correct for
    //   subdivision lots where adjacent houses are similar size.
    //
    // Honest caveat: when a real pole barn (4,000+ sqft) sits on a parcel
    // with a smaller house (1,200 sqft), this still picks the barn. The
    // only reliable fix for that case is parcel data — FL has free per-
    // county parcel layers we can wire in later.
    const RESIDENTIAL_MIN_M2 = 80;
    const sizable = candidates.filter((c) => c.area >= RESIDENTIAL_MIN_M2);
    const pool = sizable.length > 0 ? sizable : candidates;
    pool.sort((a, b) => a.distSq - b.distSq);
    const closest = pool[0];
    const closestDistM = Math.sqrt(closest.distSq);
    // Search the rest of the pool for a meaningfully-larger candidate
    // within 80m — that's the "main house set back behind a closer
    // outbuilding" case.
    const RURAL_PROBE_M = 80;
    const SIZE_DOMINANCE = 1.6;
    let bestRural: Candidate | null = null;
    if (closestDistM < 20) {
      for (const c of pool) {
        if (c === closest) continue;
        if (Math.sqrt(c.distSq) > RURAL_PROBE_M) continue;
        if (c.area >= closest.area * SIZE_DOMINANCE) {
          if (!bestRural || c.area > bestRural.area) bestRural = c;
        }
      }
    }
    best = bestRural ?? closest;
  }

  return {
    latLng: best.polygon,
    source: "osm",
    osmId: best.osmId,
  };
}

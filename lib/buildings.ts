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

/** OSM `building=*` values that explicitly identify a non-dwelling.
 *  Hard-demoted in the ranking — a building tagged this way can only win
 *  when no house/unknown-tagged candidates are in range, which is the
 *  correct fallback (e.g. ag parcels with only outbuildings near the pin).
 *  Pole barns and large shops show up here even when they exceed the
 *  80 m² residence-size floor, which is the residual failure mode the
 *  area-weighted ranker can't catch on its own. */
const OUTBUILDING_TAGS = new Set([
  "garage", "garages", "carport", "shed",
  "barn", "stable", "cowshed", "farm_auxiliary",
  "warehouse", "industrial", "manufacture", "hangar",
  "greenhouse", "service", "outbuilding", "storage_tank",
  "silo", "roof",
]);

/** OSM `building=*` values that identify a dwelling. Promoted over both
 *  outbuildings and `building=yes` / untagged candidates. */
const HOUSE_TAGS = new Set([
  "house", "residential", "detached", "semidetached_house",
  "apartments", "bungalow", "cabin", "terrace", "static_caravan",
  "dormitory", "farm",
]);

function classifyBuilding(tag?: string): "house" | "outbuilding" | "unknown" {
  if (!tag) return "unknown";
  const t = tag.toLowerCase();
  if (HOUSE_TAGS.has(t)) return "house";
  if (OUTBUILDING_TAGS.has(t)) return "outbuilding";
  return "unknown";
}

/** Compare an OSM `addr:housenumber` tag to the input address's leading
 *  number. Accepts exact match and ranges like `1234-1238` (numeric only).
 *  Letter suffixes (`1234A`) match exactly. */
function housenumberMatches(tag: string | undefined, target: string): boolean {
  if (!tag) return false;
  const t = tag.trim().toLowerCase();
  const goal = target.trim().toLowerCase();
  if (!t || !goal) return false;
  if (t === goal) return true;
  // Range form: "1234-1238" or "1234–1238" — accept if target falls inside.
  const parts = t.split(/[-–—]/);
  if (parts.length === 2) {
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    const g = parseInt(goal, 10);
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(g)) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (g >= lo && g <= hi) return true;
    }
  }
  return false;
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
  /** Optional input-address house number (leading digit run, e.g. "1234"
   *  or "1234A"). When present, OSM ways whose `addr:housenumber` tag
   *  matches short-circuit ranking — that's the strongest single signal
   *  short of parcel data that we've found the right building. */
  houseNumber?: string;
}): Promise<BuildingPolygon | null> {
  const { lat, lng, houseNumber } = opts;
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
    kind: "house" | "outbuilding" | "unknown";
    addrMatch: boolean;
  };
  const candidates: Candidate[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 3) continue;
    const polygon = el.geometry.map((p) => ({ lat: p.lat, lng: p.lon }));
    // Skip implausibly small structures (sheds, AC pads ≤ 15 m²)
    const area = polygonAreaM2(polygon);
    if (area < 15) continue;
    const tags = el.tags ?? {};
    candidates.push({
      polygon,
      osmId: el.id,
      contains: pointInPolygon(lat, lng, polygon),
      distSq: distSqToCentroid(lat, lng, polygon),
      area,
      kind: classifyBuilding(tags["building"]),
      addrMatch: houseNumber
        ? housenumberMatches(tags["addr:housenumber"], houseNumber)
        : false,
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
  //   1. Drop OSM-tagged outbuildings (barn, garage, shed, industrial, ...)
  //      from the candidate pool.
  //   2. If `addr:housenumber` matches the input address, pick that
  //      (largest if multiple) — strongest signal short of parcel data.
  //   3. Else if any candidate CONTAINS the point, pick the smallest
  //      container (parcel polygons sometimes wrap multiple buildings).
  //   4. Else two-stage: drop sub-80 m² candidates (sheds, AC pads, well
  //      houses), then prefer a meaningfully-larger building set back from
  //      the pin if the closest is small (rural-mode switch from 9f450ca).
  //   5. Else (filter empties the pool) fall back to closest-by-distance.
  // Pre-filter — hard-demote OSM-tagged outbuildings (barn, garage, shed,
  // industrial, hangar, ...). The area-weighted ranker shipped in
  // 9f450ca handles small outbuildings via the 80 m² floor, but a pole
  // barn or workshop can easily clear that floor and out-score the
  // actual house on rural compounds. When OSM tells us a building isn't
  // a dwelling, trust that over geometry.
  //
  // Fallback: if every candidate is tagged as an outbuilding, fall back
  // to the full set so we return *something*. The reconciler and the
  // rep-facing click-to-pick will catch genuinely-ambiguous cases.
  const nonOutbuildings = candidates.filter((c) => c.kind !== "outbuilding");
  const pool = nonOutbuildings.length > 0 ? nonOutbuildings : candidates;

  let best: Candidate | undefined;

  // Address-match short-circuit. When OSM has the input house number
  // hand-tagged to a building (about 20-30% of US residential coverage),
  // that's the strongest signal available short of parcel data. When
  // multiple ways share the same addr:housenumber (e.g. an attached
  // duplex traced as two polygons), prefer the largest — virtually
  // always the principal dwelling.
  if (houseNumber) {
    const matches = pool.filter((c) => c.addrMatch);
    if (matches.length > 0) {
      matches.sort((a, b) => b.area - a.area);
      best = matches[0];
    }
  }

  const containers = best ? [] : pool.filter((c) => c.contains);
  if (!best && containers.length > 0) {
    containers.sort((a, b) => a.area - b.area);
    best = containers[0];
  } else if (!best) {
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
    const sizable = pool.filter((c) => c.area >= RESIDENTIAL_MIN_M2);
    const sizedPool = sizable.length > 0 ? sizable : pool;
    sizedPool.sort((a, b) => a.distSq - b.distSq);
    const closest = sizedPool[0];
    const closestDistM = Math.sqrt(closest.distSq);
    // Search the rest of the pool for a meaningfully-larger candidate
    // within 80m — that's the "main house set back behind a closer
    // outbuilding" case.
    const RURAL_PROBE_M = 80;
    const SIZE_DOMINANCE = 1.6;
    let bestRural: Candidate | null = null;
    if (closestDistM < 20) {
      for (const c of sizedPool) {
        if (c === closest) continue;
        if (Math.sqrt(c.distSq) > RURAL_PROBE_M) continue;
        if (c.area >= closest.area * SIZE_DOMINANCE) {
          if (!bestRural || c.area > bestRural.area) bestRural = c;
        }
      }
    }
    best = bestRural ?? closest;
  }

  // `best` is assigned in every branch above (addrMatch / containers /
  // two-stage). The non-null assertion silences TS narrowing across the
  // `else if` chain.
  return {
    latLng: best!.polygon,
    source: "osm",
    osmId: best!.osmId,
  };
}

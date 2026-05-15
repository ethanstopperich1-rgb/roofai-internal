/**
 * lib/sources/parcel-polygon.ts
 *
 * Phase 1 picker: chooses the BEST building-footprint polygon for a
 * parcel by combining all available sources (Solar mask, MS Buildings,
 * OSM, Solar segments union) with priority + IoU disagreement check +
 * synthetic fallback.
 *
 * Approved design (see chat log around Phase 1 design review):
 *
 *   Priority:  solar_mask > ms_buildings > osm > solar_segments
 *   Buffer:    0.5m (applied at call site, not here)
 *
 *   Disagreement check (refinement #1):
 *     When BOTH solar_mask and ms_buildings are present, compute their
 *     IoU. If IoU < 0.6, fall back to priority order WITHOUT trusting
 *     Solar mask blindly — flag the result as low-confidence with
 *     reason "solar_disagreement". The failure corpus will tell us
 *     after a few weeks whether this matters often enough to invest
 *     in a smarter resolution.
 *
 *   Area bounds (refinement #2):
 *     Hard reject:   area < 200 sqft OR area > 20000 sqft
 *     Flag-only:     area < 600 sqft  → likely_outbuilding diagnostic,
 *                                       do NOT reject. The picker may
 *                                       still choose it if it's the
 *                                       only available source.
 *
 *   Synthetic fallback (final refinement):
 *     When all four sources fail to produce a usable polygon, emit a
 *     synthetic 2500 sqft square centered on the geocoded lat/lng,
 *     tagged source: "synthetic_fallback". Customer still gets an
 *     estimate; we get a failure-corpus row.
 *
 * Buffer is applied at the call site, NOT inside this function. Callers
 * own that decision so e.g. the LiDAR isolate stage can buffer by 0.5m
 * while a UI overlay can use the unbuffered tight outline.
 */

import polygonClipping from "polygon-clipping";
import { fetchMsBuildings, type LatLng } from "@/lib/sources/ms-buildings";

// ─── Public types ────────────────────────────────────────────────────

export type ParcelPolygonSource =
  | "sam3"
  | "solar_mask"
  | "ms_buildings"
  | "osm"
  | "solar_segments"
  | "synthetic_fallback";

export type ParcelPolygonReason =
  | "only_available"
  | "priority"
  | "iou_winner"
  | "iou_tiebreaker"
  | "solar_disagreement"
  | "synthetic_no_sources";

export interface PickResult {
  polygon: LatLng[];
  source: ParcelPolygonSource;
  reason: ParcelPolygonReason;
  /** IoU vs. Solar reference. null when no Solar reference was available
   *  or the chosen source is Solar itself. */
  iouVsSolar: number | null;
  /** Set true when the chosen polygon's area is below OUTBUILDING_MAX_SQFT.
   *  Diagnostic only — does NOT block selection. */
  likelyOutbuilding: boolean;
  /** Polygon area in sqft. */
  areaSqft: number;
  /** Confidence delta to subtract from RoofData.confidence. Non-zero when
   *  the picker had to use a low-confidence path (disagreement, synthetic).
   *  Caller applies via `confidence = Math.max(0, confidence - delta)`. */
  confidencePenalty: number;
}

/** Optional source bundle. Caller fetches each upstream in parallel and
 *  passes whatever resolved. Any field may be omitted; the picker
 *  handles all-empty by emitting the synthetic fallback. */
export interface SourceBundle {
  /** SAM3 (Roboflow) vision-traced building outline. Default polygon
   *  source for new pipeline runs — vision actually traces the roof's
   *  visible edges, while Solar's dataLayers mask returns parcel-ish
   *  blobs that bleed into yards / driveways / neighbouring lots.
   *  When SAM3 succeeds it always wins; the rest of this bundle are
   *  fallbacks for SAM3 timeout / low-confidence / hard-to-trace
   *  rooftops. */
  sam3?: LatLng[] | null;
  solar_mask?: LatLng[] | null;
  ms_buildings?: LatLng[] | null;
  osm?: LatLng[] | null;
  solar_segments?: LatLng[] | null;
}

// ─── Tuning constants ────────────────────────────────────────────────

/** Sources eligible for picker selection. Excludes `synthetic_fallback`
 *  (which is emitted only when this list yields zero candidates) — the
 *  type matches `keyof SourceBundle` so the picker can index `sources`
 *  with these values safely. */
type PickableSource = Exclude<ParcelPolygonSource, "synthetic_fallback">;

const PRIORITY_ORDER: PickableSource[] = [
  // SAM3 (Roboflow vision trace) is the new default — it actually traces
  // visible roof edges instead of returning parcel-ish blobs. Solar mask
  // demoted to fallback after the 813 Summerwood Dr, Jupiter case where
  // Solar returned a 7,013 sf parcel diamond against a 1,655 sqft real
  // roof. SAM3 traces the same building tightly to ~2,800 sf.
  "sam3",
  "solar_mask",
  "ms_buildings",
  "osm",
  "solar_segments",
];

const PRIORITY_RANK: Record<ParcelPolygonSource, number> = {
  sam3: 0,
  solar_mask: 1,
  ms_buildings: 2,
  osm: 3,
  solar_segments: 4,
  synthetic_fallback: 5,
};

const IOU_TIEBREAKER_DELTA = 0.05;
const SOLAR_DISAGREEMENT_THRESHOLD = 0.6;
const MIN_AREA_SQFT = 200;
const MAX_AREA_SQFT = 20_000;
const OUTBUILDING_MAX_SQFT = 600;
const SYNTHETIC_FALLBACK_SQFT = 2500;

// ─── Confidence penalties ────────────────────────────────────────────

const CONFIDENCE_PENALTY = {
  /** No upstream source — emit the synthetic fallback. Roughly halves
   *  the customer-facing confidence chip. */
  synthetic: 0.4,
  /** Solar mask and MS Buildings disagreed (IoU < 0.6) — both might
   *  be off. Modest demote. */
  disagreement: 0.15,
  /** Picked source had area in [200, 600] sqft (likely outbuilding). */
  outbuilding: 0.05,
} as const;

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Pick the best parcel polygon across upstream sources.
 *
 * Returns a synthetic fallback polygon (never null) so callers don't
 * need to handle the all-sources-failed case separately. Use the
 * `source: "synthetic_fallback"` field to identify those rows for the
 * failure corpus.
 */
export function pickBestParcelPolygon(
  geocode: { lat: number; lng: number },
  sources: SourceBundle,
): PickResult {
  // 1. Filter to candidates that look like real residential outlines.
  type Candidate = {
    source: ParcelPolygonSource;
    polygon: LatLng[];
    areaSqft: number;
  };
  const candidates: Candidate[] = [];
  for (const src of PRIORITY_ORDER) {
    const poly = sources[src];
    if (!poly || poly.length < 3) continue;
    const area = polygonAreaSqft(poly);
    // Hard area bounds — outside residential range is almost certainly
    // a source bug or wrong building (commercial / parcel boundary).
    if (area < MIN_AREA_SQFT || area > MAX_AREA_SQFT) continue;
    candidates.push({ source: src, polygon: poly, areaSqft: area });
  }

  // 2. No candidates → synthetic fallback.
  if (candidates.length === 0) {
    const synth = makeSyntheticSquare(geocode, SYNTHETIC_FALLBACK_SQFT);
    return {
      polygon: synth,
      source: "synthetic_fallback",
      reason: "synthetic_no_sources",
      iouVsSolar: null,
      likelyOutbuilding: false,
      areaSqft: SYNTHETIC_FALLBACK_SQFT,
      confidencePenalty: CONFIDENCE_PENALTY.synthetic,
    };
  }

  // 3. Disagreement check — runs whenever BOTH solar_mask AND ms_buildings
  //    are in the candidate set, regardless of whether solar_mask would
  //    otherwise win on priority. This is refinement #1: Solar mask is
  //    NOT trusted blindly when it dramatically disagrees with MS.
  const solarMaskCand = candidates.find((c) => c.source === "solar_mask");
  const msCand = candidates.find((c) => c.source === "ms_buildings");
  const solarMsDisagree =
    solarMaskCand &&
    msCand &&
    polygonIoU(solarMaskCand.polygon, msCand.polygon) <
      SOLAR_DISAGREEMENT_THRESHOLD;

  // 4. Single candidate path — no decision to make.
  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      polygon: only.polygon,
      source: only.source,
      reason: "only_available",
      iouVsSolar: null,
      likelyOutbuilding: only.areaSqft < OUTBUILDING_MAX_SQFT,
      areaSqft: only.areaSqft,
      confidencePenalty:
        only.areaSqft < OUTBUILDING_MAX_SQFT
          ? CONFIDENCE_PENALTY.outbuilding
          : 0,
    };
  }

  // 5. Solar disagreement fires → don't trust Solar mask; pick the
  //    next-best by priority (NOT by IoU — both Solar and MS could be
  //    off; we'd rather defer to the priority order with a confidence
  //    demote than guess).
  if (solarMsDisagree) {
    // Walk priority order excluding solar_mask (which we no longer
    // trust by itself for this address).
    const withoutSolar = candidates.filter((c) => c.source !== "solar_mask");
    const choice = withoutSolar[0] ?? candidates[0]; // fallback to anything
    return {
      polygon: choice.polygon,
      source: choice.source,
      reason: "solar_disagreement",
      iouVsSolar: polygonIoU(
        solarMaskCand!.polygon,
        msCand!.polygon,
      ),
      likelyOutbuilding: choice.areaSqft < OUTBUILDING_MAX_SQFT,
      areaSqft: choice.areaSqft,
      confidencePenalty:
        CONFIDENCE_PENALTY.disagreement +
        (choice.areaSqft < OUTBUILDING_MAX_SQFT
          ? CONFIDENCE_PENALTY.outbuilding
          : 0),
    };
  }

  // 6. Solar mask present (and not disagreeing) → it wins per priority.
  if (candidates[0].source === "solar_mask") {
    const winner = candidates[0];
    return {
      polygon: winner.polygon,
      source: "solar_mask",
      reason: "priority",
      iouVsSolar: 1.0, // solar mask IS the reference
      likelyOutbuilding: winner.areaSqft < OUTBUILDING_MAX_SQFT,
      areaSqft: winner.areaSqft,
      confidencePenalty:
        winner.areaSqft < OUTBUILDING_MAX_SQFT
          ? CONFIDENCE_PENALTY.outbuilding
          : 0,
    };
  }

  // 7. Solar mask absent. Find a Solar reference for IoU scoring.
  //    Use solar_segments if present; otherwise no reference and we
  //    fall back to priority order.
  const solarRef = sources.solar_segments;
  if (!solarRef || solarRef.length < 3) {
    const winner = candidates[0];
    return {
      polygon: winner.polygon,
      source: winner.source,
      reason: "priority",
      iouVsSolar: null,
      likelyOutbuilding: winner.areaSqft < OUTBUILDING_MAX_SQFT,
      areaSqft: winner.areaSqft,
      confidencePenalty:
        winner.areaSqft < OUTBUILDING_MAX_SQFT
          ? CONFIDENCE_PENALTY.outbuilding
          : 0,
    };
  }

  // 8. Multiple non-Solar candidates with a Solar reference → IoU score.
  const scored = candidates
    .filter((c) => c.source !== "solar_segments")
    .map((c) => ({ ...c, iou: polygonIoU(c.polygon, solarRef) }))
    .sort((a, b) => {
      // Primary: higher IoU wins.
      if (Math.abs(a.iou - b.iou) > IOU_TIEBREAKER_DELTA) {
        return b.iou - a.iou;
      }
      // Tiebreaker (within 0.05): higher priority wins.
      return PRIORITY_RANK[a.source] - PRIORITY_RANK[b.source];
    });

  if (scored.length === 0) {
    // Only solar_segments was available among non-mask → use it.
    return {
      polygon: solarRef,
      source: "solar_segments",
      reason: "priority",
      iouVsSolar: null,
      likelyOutbuilding: polygonAreaSqft(solarRef) < OUTBUILDING_MAX_SQFT,
      areaSqft: polygonAreaSqft(solarRef),
      confidencePenalty: 0,
    };
  }

  const winner = scored[0];
  const reason: ParcelPolygonReason =
    scored.length >= 2 &&
    Math.abs(scored[0].iou - scored[1].iou) <= IOU_TIEBREAKER_DELTA
      ? "iou_tiebreaker"
      : "iou_winner";

  return {
    polygon: winner.polygon,
    source: winner.source,
    reason,
    iouVsSolar: winner.iou,
    likelyOutbuilding: winner.areaSqft < OUTBUILDING_MAX_SQFT,
    areaSqft: winner.areaSqft,
    confidencePenalty:
      winner.areaSqft < OUTBUILDING_MAX_SQFT
        ? CONFIDENCE_PENALTY.outbuilding
        : 0,
  };
}

// ─── Convenience: pickWithMsFetch ────────────────────────────────────
//
// Most callers (the LiDAR pipeline) want the picker plus MS Buildings
// + SAM3 vision trace fetched in one call. This wrapper fans those two
// upstream requests in parallel, merges them with the provided Solar
// hints, and invokes the picker.

export async function pickWithMsFetch(
  geocode: { lat: number; lng: number },
  hints: Omit<SourceBundle, "ms_buildings" | "sam3">,
  opts?: {
    /** SSR base URL — required so the SAM3 fetch can hit /api/sam3-roof
     *  from inside the Next.js server context. The roof-pipeline already
     *  resolves this via `resolveBaseUrl()`; pass it through. */
    baseUrl?: string;
    /** Optional address string forwarded to /api/sam3-roof so the route
     *  can use the address for vision-aware roof identification. */
    address?: string | null;
  },
): Promise<PickResult> {
  const [msBuildings, sam3] = await Promise.all([
    fetchMsBuildings(geocode).catch(() => null),
    fetchSam3(geocode, opts?.baseUrl, opts?.address).catch(() => null),
  ]);
  return pickBestParcelPolygon(geocode, {
    ...hints,
    sam3,
    ms_buildings: msBuildings?.polygon ?? null,
  });
}

/** Fetch SAM3 / Roboflow vision-traced roof polygon. Returns null on
 *  any failure (cold-start timeout, low confidence, network error,
 *  empty polygon) so the picker degrades cleanly to Solar mask. */
async function fetchSam3(
  geocode: { lat: number; lng: number },
  baseUrl: string | undefined,
  address: string | null | undefined,
): Promise<LatLng[] | null> {
  const origin = baseUrl ?? "";
  const params = new URLSearchParams({
    lat: String(geocode.lat),
    lng: String(geocode.lng),
  });
  if (address) params.set("address", address);
  try {
    const res = await fetch(`${origin}/api/sam3-roof?${params}`, {
      cache: "no-store",
      // 35s gives Roboflow's cold path (~5-30s typical) room without
      // pushing the overall pipeline budget too far. Falls back to
      // Solar mask on AbortError.
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      polygon?: Array<{ lat: number; lng: number }>;
      source?: string;
    };
    // Some SAM3 fallback paths (e.g. footprint-only) emit a polygon
    // that's really a wall trace, not a roof outline. The picker's
    // downstream area + IoU checks will catch grossly wrong ones,
    // but we reject the obviously-bad source labels here so they
    // never even compete for the slot.
    if (!data.polygon || data.polygon.length < 3) return null;
    return data.polygon;
  } catch {
    return null;
  }
}

// ─── Geometry helpers ────────────────────────────────────────────────

/** Polygon area in square feet via planar shoelace, lat/lng → meters
 *  using a cheap cosine-of-centroid-latitude scale (sub-cm accurate at
 *  parcel sizes). */
export function polygonAreaSqft(ring: LatLng[]): number {
  if (ring.length < 3) return 0;
  const M_PER_DEG_LAT = 111_320;
  const cLat = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ax = a.lng * M_PER_DEG_LAT * cosLat;
    const ay = a.lat * M_PER_DEG_LAT;
    const bx = b.lng * M_PER_DEG_LAT * cosLat;
    const by = b.lat * M_PER_DEG_LAT;
    sum += ax * by - bx * ay;
  }
  const areaM2 = Math.abs(sum) / 2;
  return areaM2 * 10.7639;
}

/** Intersection-over-union for two lat/lng polygons.
 *  Returns 0 on degenerate / non-intersecting / library error, so a
 *  single bad polygon can't poison the picker's decision. */
export function polygonIoU(a: LatLng[], b: LatLng[]): number {
  if (a.length < 3 || b.length < 3) return 0;
  // polygon-clipping types: Polygon = Ring[], Ring = Pair[],
  // Pair = [number, number]. The cast on each vertex keeps the
  // tuple type rather than collapsing to number[].
  const toRing = (p: LatLng[]): [number, number][] =>
    p.map((v) => [v.lng, v.lat] as [number, number]);
  try {
    const inter = polygonClipping.intersection([toRing(a)], [toRing(b)]);
    const uni = polygonClipping.union([toRing(a)], [toRing(b)]);
    const interArea = sumMultiPolygonAreaSqft(inter);
    const uniArea = sumMultiPolygonAreaSqft(uni);
    if (uniArea <= 0) return 0;
    return Math.max(0, Math.min(1, interArea / uniArea));
  } catch {
    return 0;
  }
}

/** Sum the area of a polygon-clipping MultiPolygon result (list of
 *  polygons, each a list of rings with the outer ring first). */
function sumMultiPolygonAreaSqft(mp: number[][][][]): number {
  let total = 0;
  for (const polygon of mp) {
    if (polygon.length === 0) continue;
    const outer = polygon[0]; // exterior ring
    if (outer.length < 3) continue;
    const ring: LatLng[] = outer.map(([lng, lat]) => ({ lat, lng }));
    total += polygonAreaSqft(ring);
    // Subtract holes (interior rings).
    for (let i = 1; i < polygon.length; i++) {
      const hole = polygon[i];
      if (hole.length < 3) continue;
      const holeRing: LatLng[] = hole.map(([lng, lat]) => ({ lat, lng }));
      total -= polygonAreaSqft(holeRing);
    }
  }
  return total;
}

/** Build a square polygon centered on `geocode` with the given total
 *  area in sqft. Used by the synthetic_fallback path. */
function makeSyntheticSquare(
  geocode: { lat: number; lng: number },
  totalSqft: number,
): LatLng[] {
  const sideM = Math.sqrt(totalSqft / 10.7639); // sqft → m²  → side
  const half = sideM / 2;
  const M_PER_DEG_LAT = 111_320;
  const cosLat = Math.cos((geocode.lat * Math.PI) / 180);
  const dLat = half / M_PER_DEG_LAT;
  const dLng = half / (M_PER_DEG_LAT * cosLat);
  // Closed ring CCW (south-west → south-east → north-east → north-west).
  return [
    { lat: geocode.lat - dLat, lng: geocode.lng - dLng },
    { lat: geocode.lat - dLat, lng: geocode.lng + dLng },
    { lat: geocode.lat + dLat, lng: geocode.lng + dLng },
    { lat: geocode.lat + dLat, lng: geocode.lng - dLng },
  ];
}

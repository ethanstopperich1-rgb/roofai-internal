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

// SAM3 is the ONLY polygon source. Solar mask, MS Buildings, OSM, and
// Solar segments are all out — the system never traces the roof with
// anything other than the SAM3 vision model. When SAM3 fails (cold
// start exceeds 60s, returned no mask, or returned a too-small
// polygon), the pipeline falls all the way through to
// `synthetic_fallback` and the rep handles it manually rather than
// silently displaying a wrong polygon source. Solar still provides
// the DATA (plane decomposition, pitch, azimuth, area) — but never
// the OUTLINE.
const PRIORITY_ORDER: PickableSource[] = ["sam3"];

const PRIORITY_RANK: Record<ParcelPolygonSource, number> = {
  sam3: 0,
  solar_mask: 99,       // legacy, never selected
  ms_buildings: 99,     // legacy, never selected
  osm: 99,              // legacy, never selected
  solar_segments: 99,   // legacy, never selected
  synthetic_fallback: 100,
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
  // `hints` retained for API stability — Solar mask / OSM / segments
  // are still accepted as inputs but they no longer compete for the
  // polygon slot, so the picker ignores them. Kept on the type so
  // callers don't have to retool their existing fetches. Same with
  // the `ms_buildings` field, which is no longer fetched here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _hints: Omit<SourceBundle, "ms_buildings" | "sam3">,
  opts?: {
    baseUrl?: string;
    address?: string | null;
  },
): Promise<PickResult> {
  // SAM3 is the ONLY polygon source — Solar mask, MS Buildings, OSM,
  // and Solar segments are out per the May 2026 architecture pivot.
  // No parallel fetches for sources that can't win the priority.
  const sam3 = await fetchSam3(
    geocode,
    opts?.baseUrl,
    opts?.address,
  ).catch(() => null);
  return pickBestParcelPolygon(geocode, { sam3 });
}

/** Fetch SAM3 / Roboflow vision-traced roof polygon. Returns null on
 *  any failure (cold-start timeout, low confidence, network error,
 *  empty polygon) so the picker degrades cleanly to Solar mask.
 *
 *  Emits single-line `sam3:` gate logs at every exit so we can
 *  diagnose why fall-throughs happen post-hoc:
 *    sam3: gate=http_error status=...
 *    sam3: gate=timeout latency_ms=...
 *    sam3: gate=missing_polygon source=...
 *    sam3: gate=too_few_vertices n=...
 *    sam3: gate=success vertices=N source=... latency_ms=...
 *
 *  60s timeout (was 35s) — Roboflow workers warmed by /api/cron/warm-sam3
 *  serve in <5s, but cold starts can run 30-45s. 60s clears them. */
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
  const t0 = Date.now();
  try {
    const res = await fetch(`${origin}/api/sam3-roof?${params}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.warn(
        "sam3: gate=http_error status=%d latency_ms=%d",
        res.status, Date.now() - t0,
      );
      return null;
    }
    const data = (await res.json()) as {
      polygon?: Array<{ lat: number; lng: number }>;
      source?: string;
    };
    if (!data.polygon) {
      console.warn(
        "sam3: gate=missing_polygon source=%s latency_ms=%d",
        data.source ?? "none", Date.now() - t0,
      );
      return null;
    }
    if (data.polygon.length < 3) {
      console.warn(
        "sam3: gate=too_few_vertices n=%d source=%s latency_ms=%d",
        data.polygon.length, data.source ?? "none", Date.now() - t0,
      );
      return null;
    }
    // Reject SAM3's own fallback modes — these aren't real SAM3
    // traces, they're SAM3 saying "I couldn't see the roof, here's a
    // GIS footprint instead." The user mandate is SAM3-traced ONLY;
    // letting these through would silently revert to wrong-shape
    // polygons covering yards / driveways / neighbors. When SAM3
    // genuinely fails, the picker should emit synthetic_fallback so
    // the rep sees the failure rather than a bogus trace.
    const REJECTED_SOURCES = new Set([
      "footprint-only",        // SAM3 didn't run; GIS footprint passed through
      "footprint-occluded",    // SAM3 ran but roof occluded; GIS fallback
      "osm",                   // OSM raw footprint
      "osm-centroid-after-solar-drift",
      "address-solar-drift-fallback",
      "address-mask-drift-fallback",
      "solar-mask-centroid",
      "address",
    ]);
    if (data.source && REJECTED_SOURCES.has(data.source)) {
      console.warn(
        "sam3: gate=non_sam3_source source=%s vertices=%d latency_ms=%d",
        data.source, data.polygon.length, Date.now() - t0,
      );
      return null;
    }
    console.log(
      "sam3: gate=success vertices=%d source=%s latency_ms=%d",
      data.polygon.length, data.source ?? "none", Date.now() - t0,
    );
    return data.polygon;
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "TimeoutError";
    console.warn(
      "sam3: gate=%s latency_ms=%d err=%s",
      isAbort ? "timeout" : "fetch_error",
      Date.now() - t0,
      err instanceof Error ? err.message.slice(0, 120) : "unknown",
    );
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

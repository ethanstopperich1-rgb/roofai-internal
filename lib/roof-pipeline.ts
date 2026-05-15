// lib/roof-pipeline.ts
import type { RoofData, RoofDiagnostics } from "@/types/roof";
import { makeDegradedRoofData } from "@/lib/roof-engine";
import { tierCSolarSource } from "@/lib/sources/solar-source";
import { tierCVisionSource } from "@/lib/sources/vision-source";
// tierALidarSource removed from active path — retired 2026-05-15.
// SAM3 polygon (with Solar mask fallback) feeds Solar's findClosest
// segments as the authoritative facet decomposition. Modal LiDAR
// service stays deployed; this import can be restored if/when a
// verification tier comes back.
import { getCached, setCached } from "@/lib/cache";
import { fetchSolarRoofMask } from "@/lib/solar-mask";
import { resolveBaseUrl } from "@/lib/base-url";
import type { SolarSummary } from "@/types/estimate";
import {
  pickWithMsFetch,
  type ParcelPolygonReason,
  type ParcelPolygonSource,
} from "@/lib/sources/parcel-polygon";

function nanoid(): string {
  return Math.random().toString(36).slice(2, 14);
}

type RoofSource = (opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  requestId: string;
  /** Optional 2D parcel polygon hint, used by Tier A to clip the
   *  LiDAR cloud to just-this-building before normal-cluster
   *  segmentation. When present, dramatically improves isolation
   *  vs. relying on height/wall heuristics alone. */
  parcelPolygon?: Array<{ lat: number; lng: number }>;
  /** Optional imagery date hint, forwarded to Tier A so its
   *  freshness check can compare imagery vs LiDAR capture date. */
  imageryDate?: string | null;
}) => Promise<RoofData | null>;

/** Cheap one-shot fetch of Solar findClosest. We need its building
 *  footprint + segment polygons as a polygon hint for Tier A, and its
 *  imageryDate. Solar is cached server-side anyway so Tier C's later
 *  re-fetch is free.
 *
 *  Returns null when Solar 404s (rural address) — Tier A then runs
 *  without the polygon prior (less accurate but still useful). */
async function fetchSolarHint(
  lat: number,
  lng: number,
): Promise<SolarSummary | null> {
  try {
    const res = await fetch(`${resolveBaseUrl()}/api/solar?lat=${lat}&lng=${lng}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json() as SolarSummary;
    if (data.segmentCount === 0) return null;
    return data;
  } catch {
    return null;
  }
}

/** Expand a polygon outward from its centroid by `meters`. Used to
 *  add a safety buffer around the Solar mask before clipping the
 *  LiDAR cloud — Google's mask is occasionally conservative at edges
 *  (traces inside the actual eave line by 0.5-1m), and the LiDAR
 *  points at the real eave would otherwise be dropped.
 *
 *  Cheap centroid-expand approach: works well for convex-ish residential
 *  roofs. For deeply concave L-shapes the expansion is slightly uneven
 *  at the concave corners, but the downstream height + wall filters in
 *  isolate_roof catch any non-roof bleed, so the imprecision is
 *  asymmetrically safe (lets in too many, never too few). */
function bufferPolygon(
  poly: Array<{ lat: number; lng: number }>,
  meters: number,
): Array<{ lat: number; lng: number }> {
  if (poly.length === 0 || meters === 0) return poly;
  const cLat = poly.reduce((s, p) => s + p.lat, 0) / poly.length;
  const cLng = poly.reduce((s, p) => s + p.lng, 0) / poly.length;
  const M_PER_DEG_LAT = 111_320;
  const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((cLat * Math.PI) / 180);
  return poly.map((p) => {
    const dLat = p.lat - cLat;
    const dLng = p.lng - cLng;
    const distM = Math.hypot(dLat * M_PER_DEG_LAT, dLng * M_PER_DEG_LNG);
    if (distM < 1e-6) return p;
    const scale = (distM + meters) / distM;
    return {
      lat: cLat + dLat * scale,
      lng: cLng + dLng * scale,
    };
  });
}

/** Build a polygon hint for Tier A's isolate_roof clip step.
 *
 *  Phase 1 — delegates to `pickBestParcelPolygon` which runs the full
 *  multi-source picker (Solar mask → MS Buildings → OSM → Solar
 *  segments → synthetic fallback) with Solar-disagreement IoU check
 *  and 0.5m buffer. Returns both the buffered polygon AND picker
 *  diagnostics so callers can persist provenance to RoofData.
 *
 *  Buffer is applied INSIDE this function (0.5m) — the Phase 1 audit
 *  found the previous 1.5-2.5m buffer was too loose and admitted
 *  non-roof points that fed the over-segmentation problem.
 *  Compensation: isolate_roof.py now enforces LAS class 6 + a tighter
 *  normal-Z wall filter so eaves are still captured. */
async function buildParcelPolygon(
  lat: number,
  lng: number,
  solar: SolarSummary | null,
  apiKey: string | undefined,
  address: string | null,
): Promise<{
  polygon: Array<{ lat: number; lng: number }> | null;
  /** Picker provenance. Null when the picker wasn't able to run
   *  (no candidates AND synthetic was suppressed — currently never). */
  pickerSource: ParcelPolygonSource | null;
  pickerReason: ParcelPolygonReason | null;
  iouVsSolar: number | null;
  areaSqft: number;
  likelyOutbuilding: boolean;
  /** Subtract this from RoofData.confidence to surface low-confidence
   *  picker paths (synthetic_fallback, solar_disagreement, etc.). */
  confidencePenalty: number;
}> {
  // Fetch Solar mask in parallel with the MS Buildings module's own
  // lookup (which the picker triggers via pickWithMsFetch). Solar
  // segments are provided by the caller (already fetched for the
  // findClosest hint).
  let solarMask: Array<{ lat: number; lng: number }> | null = null;
  if (apiKey) {
    try {
      const mask = await fetchSolarRoofMask({ lat, lng, apiKey });
      if (mask && mask.latLng.length >= 3) solarMask = mask.latLng;
    } catch {
      /* fall through */
    }
  }

  const solarSegments =
    solar && solar.segmentPolygonsLatLng.length > 0
      ? solar.segmentPolygonsLatLng.flat()
      : null;

  // Picker fetches MS Buildings + SAM3 internally; we pass the Solar /
  // OSM hints we've already resolved. SAM3 (Roboflow vision trace) is
  // the new top-priority polygon source — it traces visible roof edges
  // rather than parcel-ish blobs. Solar mask is now the fallback.
  const picked = await pickWithMsFetch(
    { lat, lng },
    {
      solar_mask: solarMask,
      osm: null,
      solar_segments: solarSegments,
    },
    {
      baseUrl: resolveBaseUrl(),
      address,
    },
  );

  // 0.5m buffer per Phase 1 design — eaves typically extend 0.4-0.6m
  // past the wall; this catches eave LiDAR returns. The previous
  // 1.5-2.5m buffer admitted too many neighboring non-roof points.
  const buffered = bufferPolygon(picked.polygon, 0.5);

  return {
    polygon: buffered,
    pickerSource: picked.source,
    pickerReason: picked.reason,
    iouVsSolar: picked.iouVsSolar,
    areaSqft: picked.areaSqft,
    likelyOutbuilding: picked.likelyOutbuilding,
    confidencePenalty: picked.confidencePenalty,
  };
}

/**
 * Tier C orchestrator. Iterates sources serially; first non-null wins.
 * All sources failed → degraded RoofData (source: "none"); never throws.
 * Successful results cached for 1h via lib/cache.ts; degraded never cached.
 */
export async function runRoofPipeline(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  /** When true, bypass cache (used by the debug route and the rep "re-analyze" button). */
  nocache?: boolean;
}): Promise<RoofData> {
  if (!opts.nocache) {
    const cached = await getCached<RoofData>("roof-data", opts.address.lat, opts.address.lng);
    if (cached && cached.source !== "none") {
      console.log("[roof-pipeline] cache hit", {
        source: cached.source,
        address: opts.address.formatted,
      });
      return cached;
    }
  }

  const requestId = nanoid();
  const attempts: RoofDiagnostics["attempts"] = [];

  // ─── Pre-fetch Solar context for Tier A's polygon hint ──────────────
  // Tier A's worker is dramatically more accurate when it can clip the
  // LiDAR cloud to a known parcel polygon BEFORE running height/normal
  // segmentation. Without this, isolate_roof has to fight the whole
  // bbox of points — including neighbours, trees, sheds. With a clip,
  // segmentation only sees points strictly above this building.
  //
  // Strategy: one cheap Solar findClosest call (~$0.005, ~1s, cached
  // server-side so Tier C's later re-fetch is free) provides:
  //   - building footprint polygon (segment_polygons union)
  //   - imageryDate (forwarded to Tier A's freshness check)
  // Then we try the higher-fidelity Solar dataLayers mask. Whichever
  // we get becomes the parcelPolygon hint.
  const apiKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  // Phase 1 — single picker call runs all sources (Solar mask, MS
  // Buildings, Solar segments, synthetic fallback) and returns the
  // best polygon plus provenance for diagnostics.
  const solarHint = await fetchSolarHint(opts.address.lat, opts.address.lng);
  const pickerResult = await buildParcelPolygon(
    opts.address.lat,
    opts.address.lng,
    solarHint,
    apiKey,
    opts.address.formatted,
  );
  const finalParcelPolygon = pickerResult.polygon;
  const imageryDate = solarHint?.imageryDate ?? null;
  if (finalParcelPolygon) {
    console.log("[roof-pipeline] parcel_polygon_hint", {
      address: opts.address.formatted,
      vertices: finalParcelPolygon.length,
      source: pickerResult.pickerSource,
      reason: pickerResult.pickerReason,
      iouVsSolar: pickerResult.iouVsSolar,
      areaSqft: pickerResult.areaSqft,
      likelyOutbuilding: pickerResult.likelyOutbuilding,
      confidencePenalty: pickerResult.confidencePenalty,
    });
    // Persist picker provenance to diagnostics. Reason string matches
    // what the Phase 1 audit format spec'd:
    // `{source}/{reason}/iou={iou?.toFixed(2)}`
    attempts.push({
      source: "parcel-polygon",
      outcome:
        pickerResult.pickerSource === "synthetic_fallback"
          ? "failed-coverage"
          : "succeeded",
      reason:
        `${pickerResult.pickerSource}/${pickerResult.pickerReason}` +
        (pickerResult.iouVsSolar != null
          ? `/iou=${pickerResult.iouVsSolar.toFixed(2)}`
          : ""),
    });
  }

  // Source cascade (post-retire-Tier-A):
  //   1. Solar API segments — authoritative plane decomposition.
  //      Per-plane pitch, azimuth, sloped + footprint area.
  //   2. Vision fallback — pure-image Tier C used when Solar 404s
  //      (rural / no-coverage addresses).
  //
  // Tier A LiDAR was retired on 2026-05-15 — the rep tool now uses
  // SAM3 for the outline polygon (primary) with Solar mask as
  // fallback, then Solar's findClosest segments[] drive the
  // authoritative facet breakdown (pitch / azimuth / area / edges).
  // The Modal LiDAR service stays deployed for future re-introduction
  // as an optional verification layer, but it's no longer in the
  // pipeline cascade.
  const sources: Array<{ name: string; fn: RoofSource }> = [
    { name: "tier-c-solar", fn: tierCSolarSource },
    { name: "tier-c-vision", fn: tierCVisionSource },
  ];

  let primary: RoofData | null = null;
  const startedAt = Date.now();
  for (const s of sources) {
    try {
      const result = await s.fn({
        address: opts.address,
        requestId,
        parcelPolygon: finalParcelPolygon ?? undefined,
        imageryDate,
      });
      attempts.push({
        source: s.name,
        outcome: result ? "succeeded" : "failed-coverage",
      });
      if (result) {
        primary = result;
        break;
      }
    } catch (err) {
      attempts.push({
        source: s.name,
        outcome: "failed-error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!primary) {
    const degraded = makeDegradedRoofData({ address: opts.address, attempts });
    console.log("[roof-pipeline] all sources failed", {
      address: opts.address.formatted,
      attempts,
    });
    return degraded;
  }

  primary.diagnostics.attempts = attempts;

  // Phase 1 — apply the picker's confidence penalty. Synthetic fallback
  // (no upstream sources resolved) cuts confidence by 0.4; Solar/MS
  // disagreement by 0.15; outbuilding-sized polygon by 0.05.
  if (pickerResult.confidencePenalty > 0) {
    primary.confidence = Math.max(
      0,
      primary.confidence - pickerResult.confidencePenalty,
    );
  }
  // Surface the picker's likely-outbuilding flag as a needs-review entry
  // so the failure corpus + the rep UI both see it.
  if (pickerResult.likelyOutbuilding) {
    primary.diagnostics.needsReview.push({
      kind: "facet",
      id: "all",
      reason: "parcel-polygon-likely-outbuilding",
    });
  }

  // crossSourceBaseline was previously populated when Tier A LiDAR
  // won the cascade — captured Solar's same-address numbers for a
  // "two methods agree" trust signal. Tier A retired 2026-05-15;
  // Solar is now the authoritative measurement source, so there's
  // no longer a second method to cross-check against. Field stays
  // on RoofData (additive optional) for future re-introduction of
  // a verification tier.

  const latencyMs = Date.now() - startedAt;
  console.log("[roof-pipeline] pipeline_source_picked", {
    source: primary.source,
    latencyMs,
    address: opts.address.formatted,
  });

  const objCounts = primary.objects.reduce((acc, o) => {
    acc[o.kind] = (acc[o.kind] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const totalFlashingLf =
    primary.flashing.chimneyLf + primary.flashing.skylightLf +
    primary.flashing.dormerStepLf + primary.flashing.valleyLf +
    primary.flashing.wallStepLf + primary.flashing.headwallLf +
    primary.flashing.apronLf;
  console.log("[telemetry] flashing_detected", {
    address: opts.address.formatted,
    chimneys: objCounts.chimney ?? 0,
    skylights: objCounts.skylight ?? 0,
    dormers: objCounts.dormer ?? 0,
    vents: (objCounts.vent ?? 0) + (objCounts.stack ?? 0),
    totalFlashingLf,
  });

  // Cache successful results only, for 1 hour.
  await setCached("roof-data", opts.address.lat, opts.address.lng, primary, 60 * 60);
  return primary;
}

// ============================================================================
// Cross-compare mode — runs Tier A (LiDAR) + Tier C (Solar) in PARALLEL on
// the same address and returns both RoofData payloads. Used by the customer
// /quote + rep /internal 3D visual so the user can toggle between the two
// measurements with a button. Also a continuous-validation signal: when the
// two measurements disagree by >X%, we know one of them is wrong on this
// address and surface it for manual review.
// ============================================================================

export interface RoofComparison {
  /** The winning source — higher confidence, LiDAR breaks ties. Always
   *  populated (degraded RoofData if both sources failed). */
  primary: RoofData;
  /** Tier A LiDAR result, when available. null when LIDAR_SERVICE_URL is
   *  unset, when Modal returned no coverage, or when the call errored. */
  lidar: RoofData | null;
  /** Tier C Solar result, when available. null when Solar 404'd (rural). */
  solar: RoofData | null;
  /** Source-agreement metrics for diagnostics + UI cross-check chip. */
  agreement: {
    /** Both sources returned non-null. */
    bothPresent: boolean;
    /** |lidar_sqft - solar_sqft| / max(lidar_sqft, solar_sqft). 0 = perfect
     *  agreement, 1 = total disagreement. null when only one source ran. */
    sqftDeltaPct: number | null;
    /** |lidar_pitch - solar_pitch|, degrees. null when only one source ran. */
    pitchDeltaDegrees: number | null;
    /** Facet count delta. null when only one source ran. */
    facetCountDelta: number | null;
  };
  /** Per-source latency for telemetry. */
  latencyMs: { lidar: number | null; solar: number | null; total: number };
}

export async function runRoofPipelineCompare(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  nocache?: boolean;
}): Promise<RoofComparison> {
  const startedAt = Date.now();
  const requestId = nanoid();

  // Reuse the same polygon-hint pre-fetch as the serial pipeline — Tier A
  // needs it to clip the point cloud. We pay for one Solar findClosest +
  // optional dataLayers mask, both of which are also part of Tier C's
  // own work, so when we run Tier C downstream this is effectively free.
  const apiKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  // Phase 1 — single picker call (Solar mask + MS Buildings + Solar
  // segments + synthetic fallback) instead of the prior two-phase
  // Solar-only call.
  const solarHint = await fetchSolarHint(opts.address.lat, opts.address.lng);
  const pickerResult = await buildParcelPolygon(
    opts.address.lat,
    opts.address.lng,
    solarHint,
    apiKey,
    opts.address.formatted,
  );
  const finalParcelPolygon = pickerResult.polygon;
  const imageryDate = solarHint?.imageryDate ?? null;

  // Post-Tier-A-retirement: this is now a Solar-only run with
  // Vision as the fallback. The function name + return shape are
  // preserved so existing callers (/api/roof-pipeline?compare=1
  // and /quote) keep working, but `lidar` is always null and
  // `agreement.bothPresent` is always false. We'll reintroduce a
  // real cross-source layer once SAM2 lands and we have an
  // independent plane / area path to verify Solar against.
  const solarStart = Date.now();
  const solarSettled = await Promise.allSettled([
    tierCSolarSource({
      address: opts.address,
      requestId,
      parcelPolygon: finalParcelPolygon ?? undefined,
      imageryDate,
    }),
  ]);
  const lidar: RoofData | null = null;
  const lidarLatency: number | null = null;
  const solar =
    solarSettled[0].status === "fulfilled" ? solarSettled[0].value : null;
  const solarLatency = solar ? Date.now() - solarStart : null;

  let vision: RoofData | null = null;
  if (!solar) {
    try {
      vision = await tierCVisionSource({
        address: opts.address,
        requestId,
        parcelPolygon: finalParcelPolygon ?? undefined,
        imageryDate,
      });
    } catch {
      vision = null;
    }
  }

  let primary: RoofData;
  if (solar) {
    primary = solar;
  } else if (vision) {
    primary = vision;
  } else {
    const attempts: RoofDiagnostics["attempts"] = [
      { source: "tier-c-solar", outcome: "failed-error", reason: "no result" },
      { source: "tier-c-vision", outcome: "failed-error", reason: "no result" },
    ];
    primary = makeDegradedRoofData({ address: opts.address, attempts });
  }

  // crossSourceBaseline intentionally left untouched on `primary` —
  // the field stays on RoofData for future re-introduction of a
  // verification tier (likely SAM2-derived areas vs Solar plane
  // decomposition once Phase 2 lands).

  // Agreement metrics — degenerate to "no second method" until
  // SAM2 / a new verification tier lands. Shape preserved so
  // existing UI consumers (MeasurementVerification) keep working.
  const agreement = {
    bothPresent: false,
    sqftDeltaPct: null as number | null,
    pitchDeltaDegrees: null as number | null,
    facetCountDelta: null as number | null,
  };

  const totalLatency = Date.now() - startedAt;
  console.log("[roof-pipeline] cross_compare_complete", {
    address: opts.address.formatted,
    primary: primary.source,
    lidarPresent: !!lidar,
    solarPresent: !!solar,
    visionFallback: !!vision,
    agreement,
    latencyMs: { lidar: lidarLatency, solar: solarLatency, total: totalLatency },
  });

  // Cache primary RoofData under the existing key so legacy callers
  // (runRoofPipeline) hit the same cache; secondary data is recomputed
  // each time cross-compare runs (cheap with hint reuse).
  if (primary.source !== "none") {
    await setCached(
      "roof-data",
      opts.address.lat,
      opts.address.lng,
      primary,
      60 * 60,
    );
  }

  return {
    primary,
    lidar,
    solar,
    agreement,
    latencyMs: { lidar: lidarLatency, solar: solarLatency, total: totalLatency },
  };
}

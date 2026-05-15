// lib/roof-pipeline.ts
import type { RoofData, RoofDiagnostics } from "@/types/roof";
import { makeDegradedRoofData } from "@/lib/roof-engine";
import { tierCSolarSource } from "@/lib/sources/solar-source";
import { tierCVisionSource } from "@/lib/sources/vision-source";
import { tierALidarSource } from "@/lib/sources/lidar-source";
import { getCached, setCached } from "@/lib/cache";
import { fetchSolarRoofMask } from "@/lib/solar-mask";
import { resolveBaseUrl } from "@/lib/base-url";
import type { SolarSummary } from "@/types/estimate";

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
 *  Preference order:
 *    1. Solar dataLayers mask polygon (pixel-accurate, ~20 vertices)
 *       buffered +1.5m for eave overhang + segmentation conservatism.
 *    2. Union of Solar findClosest segment polygons (rotated bboxes)
 *       buffered +2.5m (rotated bboxes already overshoot somewhat
 *       so a smaller margin is enough).
 *    3. None — Tier A relies on height + normal-vertical filters alone.
 *
 *  Buffering is always-safer: the downstream height + wall-vertical
 *  filters in isolate_roof drop non-roof points anyway, so a too-big
 *  polygon costs ~nothing while a too-small polygon drops real roof
 *  points (catastrophic). */
async function buildParcelPolygon(
  lat: number,
  lng: number,
  solar: SolarSummary | null,
  apiKey: string | undefined,
): Promise<Array<{ lat: number; lng: number }> | null> {
  if (apiKey) {
    try {
      const mask = await fetchSolarRoofMask({ lat, lng, apiKey });
      if (mask && mask.latLng.length >= 3) {
        return bufferPolygon(mask.latLng, 1.5);
      }
    } catch {
      /* fall through */
    }
  }
  if (solar && solar.segmentPolygonsLatLng.length > 0) {
    // Flatten all segment polygons into one ring — Shapely's
    // contains() on a multi-vertex outer ring is enough for isolate
    // to clip points. Not a clean union (would need a polygon
    // library) but residential segment polygons rarely have gaps
    // big enough to matter for point-in-polygon tests.
    return bufferPolygon(solar.segmentPolygonsLatLng.flat(), 2.5);
  }
  return null;
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
  const [solarHint, parcelPolygon] = await Promise.all([
    fetchSolarHint(opts.address.lat, opts.address.lng),
    apiKey
      ? buildParcelPolygon(opts.address.lat, opts.address.lng, null, apiKey).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);
  // If mask fetch failed but findClosest succeeded, build polygon from
  // segment polygons as fallback.
  const finalParcelPolygon =
    parcelPolygon ??
    (solarHint
      ? await buildParcelPolygon(opts.address.lat, opts.address.lng, solarHint, undefined)
      : null);
  const imageryDate = solarHint?.imageryDate ?? null;
  if (finalParcelPolygon) {
    console.log("[roof-pipeline] parcel_polygon_hint", {
      address: opts.address.formatted,
      vertices: finalParcelPolygon.length,
      source: parcelPolygon ? "solar-mask" : "solar-findclosest-segments",
    });
  }

  // Tier A is registered as the highest-priority source, but its adapter
  // returns null when LIDAR_SERVICE_URL is unset — so the pipeline degrades
  // cleanly to Tier C on deploys that don't have the Modal service wired.
  const sources: Array<{ name: string; fn: RoofSource }> = [
    { name: "tier-a-lidar", fn: tierALidarSource },
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

  // Cross-source baseline: when Tier A wins, capture what Tier C Solar
  // said about the same roof so the UI can show a measurement-agreement
  // trust signal. The Solar hint was already fetched for the parcel
  // polygon — re-use it rather than firing another request.
  if (primary.source === "tier-a-lidar" && solarHint) {
    primary.crossSourceBaseline = {
      solar: {
        sqft: solarHint.sqft,
        pitchDegrees: solarHint.pitchDegrees,
        segmentCount: solarHint.segmentCount,
        imageryDate: solarHint.imageryDate,
        imageryQuality: solarHint.imageryQuality,
      },
    };
  }

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
  const [solarHint, parcelPolygonFromMask] = await Promise.all([
    fetchSolarHint(opts.address.lat, opts.address.lng),
    apiKey
      ? buildParcelPolygon(opts.address.lat, opts.address.lng, null, apiKey).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);
  const finalParcelPolygon =
    parcelPolygonFromMask ??
    (solarHint
      ? await buildParcelPolygon(opts.address.lat, opts.address.lng, solarHint, undefined)
      : null);
  const imageryDate = solarHint?.imageryDate ?? null;

  // Fire both Tier A and Tier C in parallel. We track each independently so
  // a failure in one doesn't poison the other. Tier-A typically takes
  // 5-25s warm, 30-90s cold; Tier-C typically 1-3s. Total wall time = max,
  // not sum.
  const lidarStart = Date.now();
  const solarStart = Date.now();
  const [lidarSettled, solarSettled] = await Promise.allSettled([
    tierALidarSource({
      address: opts.address,
      requestId,
      parcelPolygon: finalParcelPolygon ?? undefined,
      imageryDate,
    }),
    tierCSolarSource({
      address: opts.address,
      requestId,
      parcelPolygon: finalParcelPolygon ?? undefined,
      imageryDate,
    }),
  ]);
  const lidar =
    lidarSettled.status === "fulfilled" ? lidarSettled.value : null;
  const lidarLatency = lidar ? Date.now() - lidarStart : null;
  const solar =
    solarSettled.status === "fulfilled" ? solarSettled.value : null;
  const solarLatency = solar ? Date.now() - solarStart : null;

  // Vision fallback only fires when BOTH primary sources failed — keeps
  // cost/latency low and avoids cluttering the cross-compare with a
  // third measurement that has lower confidence than either.
  let vision: RoofData | null = null;
  if (!lidar && !solar) {
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

  // Pick primary: highest confidence, LiDAR breaks ties (matches the
  // original serial-pipeline priority of "LiDAR wins when both succeed").
  let primary: RoofData;
  if (lidar && solar) {
    primary = lidar.confidence >= solar.confidence ? lidar : solar;
  } else if (lidar) {
    primary = lidar;
  } else if (solar) {
    primary = solar;
  } else if (vision) {
    primary = vision;
  } else {
    const attempts: RoofDiagnostics["attempts"] = [
      { source: "tier-a-lidar", outcome: "failed-error", reason: "no result" },
      { source: "tier-c-solar", outcome: "failed-error", reason: "no result" },
      { source: "tier-c-vision", outcome: "failed-error", reason: "no result" },
    ];
    primary = makeDegradedRoofData({ address: opts.address, attempts });
  }

  // Cross-source baseline on primary, like the serial pipeline does.
  if (primary.source === "tier-a-lidar" && solarHint) {
    primary.crossSourceBaseline = {
      solar: {
        sqft: solarHint.sqft,
        pitchDegrees: solarHint.pitchDegrees,
        segmentCount: solarHint.segmentCount,
        imageryDate: solarHint.imageryDate,
        imageryQuality: solarHint.imageryQuality,
      },
    };
  }

  // Agreement metrics — useful for both the UI cross-check chip AND
  // continuous monitoring of "where do our two sources diverge."
  const agreement = {
    bothPresent: !!(lidar && solar),
    sqftDeltaPct:
      lidar && solar
        ? Math.abs(
            lidar.totals.totalRoofAreaSqft - solar.totals.totalRoofAreaSqft,
          ) /
          Math.max(
            lidar.totals.totalRoofAreaSqft,
            solar.totals.totalRoofAreaSqft,
            1,
          )
        : null,
    pitchDeltaDegrees:
      lidar && solar
        ? Math.abs(
            lidar.totals.averagePitchDegrees - solar.totals.averagePitchDegrees,
          )
        : null,
    facetCountDelta:
      lidar && solar
        ? Math.abs(lidar.totals.facetsCount - solar.totals.facetsCount)
        : null,
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

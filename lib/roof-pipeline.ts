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
import type { SolarSummary, SurfacePolygon } from "@/types/estimate";
import { isSam2Configured } from "@/lib/roboflow-workflow-config";
import { fetchGisFootprint } from "@/lib/reconcile-roof-polygon";
import { polygonAreaSqft } from "@/lib/polygon";
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
  // SAM3 is the ONLY polygon source as of May 2026. Solar mask, MS
  // Buildings, OSM, and Solar segments don't compete for the polygon
  // slot anymore — Solar still drives the FACET DATA (plane decomp,
  // pitch, azimuth, area per surface) but never the outline. If SAM3
  // fails, the picker emits synthetic_fallback (rep handles manually)
  // rather than silently drawing a wrong shape with a different model.
  const picked = await pickWithMsFetch(
    { lat, lng },
    {
      // hints intentionally empty — the picker ignores Solar mask /
      // OSM / solar_segments now. Kept on the type for backwards
      // compat with older callers; passing null is the safest signal.
      solar_mask: null,
      osm: null,
      solar_segments: null,
    },
    {
      baseUrl: resolveBaseUrl(),
      address,
    },
  );
  // apiKey + solar are no longer consumed inside the picker path —
  // the lint suppressions below keep the function signature stable
  // (Solar is still passed in by callers for downstream segment data
  // outside this function).
  void apiKey;
  void solar;

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

/** Phase 2 — fetch SAM2 surface segmentation INSIDE the SAM3 outline.
 *
 *  Fanned out in parallel with the Tier C source cascade (Solar /
 *  vision) so it doesn't add wall-clock latency unless Solar is faster
 *  than Roboflow's serverless cold start (unlikely; Solar ~1-3s, SAM2
 *  ~5-30s warm). Failures are strictly soft — empty surfaces array,
 *  pipeline continues unchanged. SAM2 NEVER blocks the customer-facing
 *  estimate.
 *
 *  Skip conditions (returns []):
 *    - SAM2 not configured (env var unset) — gate logged, no fetch
 *    - SAM3 polygon missing or has <3 vertices — nothing to segment
 *    - /api/sam2-surfaces returns non-200 or throws — log + continue
 *
 *  Returns: array of SurfacePolygon (lat/lng polygons + class + area
 *  + confidence). Empty array on any failure path.
 */
async function fetchSam2Surfaces(
  lat: number,
  lng: number,
  sam3Polygon: Array<{ lat: number; lng: number }> | null,
): Promise<SurfacePolygon[]> {
  if (!isSam2Configured()) {
    // Gate log matches sam3 pattern — single line, structured-ish.
    // Logged at info level (not warn) because "not configured" is the
    // expected steady state until Phase 2 ships.
    console.log(
      `sam2: gate=not_configured lat=${lat.toFixed(5)} lng=${lng.toFixed(5)}`,
    );
    return [];
  }
  if (!sam3Polygon || sam3Polygon.length < 3) {
    console.warn(
      `sam2: gate=no_sam3_polygon lat=${lat.toFixed(5)} lng=${lng.toFixed(5)} ` +
        `vertices=${sam3Polygon?.length ?? 0}`,
    );
    return [];
  }
  try {
    const url =
      `${resolveBaseUrl()}/api/sam2-surfaces?lat=${lat}&lng=${lng}` +
      `&sam3Polygon=${encodeURIComponent(JSON.stringify(sam3Polygon))}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.warn(`sam2: fetch returned ${res.status} for (${lat}, ${lng})`);
      return [];
    }
    const data = (await res.json()) as { surfaces?: SurfacePolygon[] };
    return Array.isArray(data.surfaces) ? data.surfaces : [];
  } catch (err) {
    console.warn(`sam2: fetch threw for (${lat}, ${lng}):`, err);
    return [];
  }
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
    const cached = await getCached<RoofData>("roof-data-v3-compare-undercount-fix", opts.address.lat, opts.address.lng);
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

  // Phase 2 — kick off SAM2 surface segmentation in parallel with the
  // Solar / vision cascade. Only fires when the picker landed a real
  // SAM3 polygon (otherwise there's no outline to segment inside).
  // Awaited below alongside whichever primary source resolved. Result
  // attaches to RoofData as `surfaces`; absent / empty when SAM2 isn't
  // configured or the fetch failed.
  const sam2Promise: Promise<SurfacePolygon[]> =
    pickerResult.pickerSource === "sam3" &&
    pickerResult.polygon &&
    pickerResult.polygon.length >= 3
      ? fetchSam2Surfaces(
          opts.address.lat,
          opts.address.lng,
          pickerResult.polygon,
        )
      : Promise.resolve([]);

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

  // Override outlinePolygon with the SAM3 trace when the picker landed
  // a real SAM3 polygon. Without this, MapView renders the union of
  // facet polygons (which are Solar-derived rotated bboxes) and the
  // customer sees a Solar-shaped outline even when SAM3 was the
  // intended polygon source. With SAM3 as the only allowed polygon
  // tracer (May 2026 architecture), the picker output IS the outline.
  // SAM3 polygon override — when SAM3 won the picker, replace the
  // source's default outline with the SAM3 trace. This is unconditional
  // per architecture mandate (SAM3-every-time, never Solar mask).
  // The "right way to fix bad SAM3 polygons" is to upgrade the GIS
  // clip target (MS Buildings via direct Azure fetch beats OSM, which
  // sometimes mis-tags driveways as `building`), NOT to fall back to
  // Solar.
  if (
    pickerResult.pickerSource === "sam3" &&
    pickerResult.polygon &&
    pickerResult.polygon.length >= 3
  ) {
    primary.outlinePolygon = pickerResult.polygon;
  }

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

  // ─── Solar low-confidence sanity check ────────────────────────────────
  // When Solar's `imageryQuality` is MEDIUM or LOW (proxied by
  // `primary.confidence < 0.85` — Solar source sets 0.85 for HIGH,
  // 0.70 for MEDIUM, 0.55 for LOW), its photogrammetric building model
  // can miss whole roof segments on complex residential roofs (lanai,
  // attached garage, low-slope wings). Symptom on Jupiter (813
  // Summerwood): Solar returns 6 segments totaling 1,612 sqft footprint
  // on a building whose OSM/MS-Buildings footprint is 3,336 sqft, and
  // whose EagleView ground truth is 3,651 sqft — Solar undercounts by
  // 53% because MEDIUM imagery resolved less than half of the actual
  // roof facets.
  //
  // Correction: when Solar's footprint is < 60% of the GIS footprint,
  // replace `totals.totalRoofAreaSqft` with `gisFootprint × slopeFactor`,
  // preserving Solar's averaged pitch ratio. The per-facet `areaSqftSloped`
  // values stay untouched (still useful for per-facet pricing comps) —
  // only the customer-facing total is corrected.
  //
  // HIGH-imagery Solar passes through unchanged (Orlando 2863 Newcomb
  // example: Solar HIGH 2024 → 1,555 sqft, EagleView 1,592 → 2.3% off,
  // no correction needed).
  if (
    primary.source === "tier-c-solar" &&
    primary.confidence < 0.85 &&
    primary.totals.totalFootprintSqft > 0 &&
    primary.totals.totalRoofAreaSqft > 0
  ) {
    try {
      // Extract leading house number from formatted address (e.g.
      // "813 Summerwood Dr ..." → "813"). OSM Overpass uses this to
      // rank candidate buildings; missing it just means OSM falls back
      // to nearest-building-to-coords, which is usually fine here too
      // since the pipeline already resolved the right lat/lng.
      const hn = opts.address.formatted.match(/^\s*(\d+[A-Za-z]?)\b/)?.[1];
      const gis = await fetchGisFootprint(
        opts.address.lat,
        opts.address.lng,
        hn,
      );
      if (gis) {
        const gisSqft = polygonAreaSqft(gis.polygon);
        const solarFootprint = primary.totals.totalFootprintSqft;
        const ratio = solarFootprint / gisSqft;

        // ─── Track K (2026-05-16): GIS polygon validation ─────────────
        // Tightened from 20k → 12k upper bound — catches more parcel
        // polygons that OSM occasionally returns instead of buildings
        // (e.g. Oak Park's 77k-sqft "building" was already caught at
        // 20k, but the 12k limit catches subtler half-lot mis-tags too).
        // 12k still admits the largest realistic FL residential
        // (mansion + attached garages + lanai = ~11k sqft footprint).
        const gisIsResidential = gisSqft >= 600 && gisSqft <= 12_000;

        // Centroid proximity check — the OSM polygon's centroid must
        // be within 25m of the address. Catches OSM's "wrong building"
        // failure mode where a neighbor's larger polygon overlaps the
        // address bbox and gets returned by Overpass. 25m is generous
        // (covers most setbacks + side-yard offsets) but rejects
        // polygons centered on adjacent parcels.
        const cosLat = Math.cos((opts.address.lat * Math.PI) / 180);
        const gisCentroidLat =
          gis.polygon.reduce((s, p) => s + p.lat, 0) / gis.polygon.length;
        const gisCentroidLng =
          gis.polygon.reduce((s, p) => s + p.lng, 0) / gis.polygon.length;
        const dLatM = (gisCentroidLat - opts.address.lat) * 111_320;
        const dLngM = (gisCentroidLng - opts.address.lng) * 111_320 * cosLat;
        const gisCentroidOffsetM = Math.hypot(dLatM, dLngM);
        const gisCentroidNearAddress = gisCentroidOffsetM <= 25;

        const solarUndercounting = ratio < 0.6;

        // If GIS looks wrong, log a clear "needs review" warning and
        // bail out without applying correction. Customer gets Solar's
        // uncorrected number (same behavior as if undercount correction
        // never fired) — never a wrong correction.
        if (!gisIsResidential || !gisCentroidNearAddress) {
          primary.diagnostics.warnings.push(
            `gis_rejected: ${gis.source} returned ${Math.round(gisSqft)} sqft polygon ` +
              `${gisCentroidOffsetM.toFixed(0)}m from address — ` +
              `${!gisIsResidential ? `outside residential bounds [600, 12000] sqft` : `centroid >25m from address`}. ` +
              `Solar's uncorrected ${primary.totals.totalRoofAreaSqft} sqft used; manual review recommended.`,
          );
          primary.diagnostics.needsReview.push({
            kind: "facet",
            id: "all",
            reason: "gis_polygon_invalid",
          });
          console.warn(
            `[roof-pipeline] gis_rejected gis=${gis.source} sqft=${Math.round(gisSqft)} ` +
              `offset_m=${gisCentroidOffsetM.toFixed(0)} solar_undercount_skipped`,
          );
        } else if (gisIsResidential && solarUndercounting) {
          const slopeFactor =
            primary.totals.totalRoofAreaSqft / solarFootprint;
          const correctedSloped = Math.round(gisSqft * slopeFactor);
          const oldSloped = primary.totals.totalRoofAreaSqft;
          const oldFootprint = primary.totals.totalFootprintSqft;
          primary.totals.totalRoofAreaSqft = correctedSloped;
          primary.totals.totalFootprintSqft = Math.round(gisSqft);
          // Recompute totalSquares to match new area
          primary.totals.totalSquares =
            Math.ceil((correctedSloped / 100) * 3) / 3;
          // Re-derive footprint-dependent EagleView fields. Attic is a
          // 9% deduction off footprint; stories heuristic depends on
          // both footprint and avg pitch. Without this re-derivation,
          // attic would still reflect Solar's undercounted footprint.
          primary.totals.estimatedAtticSqft = Math.round(gisSqft * 0.91);
          primary.totals.stories =
            primary.totals.averagePitchDegrees >= 26.6 &&
            primary.totals.totalFootprintSqft <= 2000
              ? 2
              : 1;
          primary.diagnostics.warnings.push(
            `solar_undercount_corrected: Solar ${oldFootprint}→${primary.totals.totalFootprintSqft} sqft footprint ` +
              `(${gis.source} GIS), ${oldSloped}→${correctedSloped} sqft sloped ` +
              `(slope factor ${slopeFactor.toFixed(3)})`,
          );
          console.log(
            `[roof-pipeline] solar_undercount_corrected ` +
              `gis=${gis.source} gis_sqft=${Math.round(gisSqft)} ` +
              `solar_footprint=${oldFootprint} ratio=${ratio.toFixed(2)} ` +
              `slope_factor=${slopeFactor.toFixed(3)} ` +
              `final_sqft=${correctedSloped}`,
          );
        }
      }
    } catch (err) {
      // GIS fetch failure must not blow up the pipeline — the customer
      // gets Solar's uncorrected number, same as before this block.
      console.warn(
        "[roof-pipeline] solar_undercount_check_failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Phase 2 — attach SAM2 surfaces (or [] when SAM2 didn't run / failed).
  // Awaited here so cache write below includes them. Adds at most the
  // sam2 fetch's remaining wall-clock — usually 0 because SAM2 finishes
  // before Solar's downstream geometry work.
  try {
    primary.surfaces = await sam2Promise;
  } catch {
    primary.surfaces = [];
  }

  const latencyMs = Date.now() - startedAt;
  console.log("[roof-pipeline] pipeline_source_picked", {
    source: primary.source,
    latencyMs,
    surfaceCount: primary.surfaces?.length ?? 0,
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
  await setCached("roof-data-v3-compare-undercount-fix", opts.address.lat, opts.address.lng, primary, 60 * 60);
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

  // Phase 2 — fan out SAM2 in parallel with Solar (same rationale as
  // runRoofPipeline above). Skipped when SAM3 didn't win the picker.
  const sam2Promise: Promise<SurfacePolygon[]> =
    pickerResult.pickerSource === "sam3" &&
    pickerResult.polygon &&
    pickerResult.polygon.length >= 3
      ? fetchSam2Surfaces(
          opts.address.lat,
          opts.address.lng,
          pickerResult.polygon,
        )
      : Promise.resolve([]);

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

  // Attach Phase 2 surfaces to whichever source won. Same soft-fail
  // semantics as the serial pipeline — empty array on any error.
  try {
    primary.surfaces = await sam2Promise;
  } catch {
    primary.surfaces = [];
  }

  // ─── Solar low-confidence sanity check (mirrors runRoofPipeline) ─────
  // The compare path is what the customer-facing UI actually hits
  // (/api/roof-pipeline?compare=1 → app/(internal)/page.tsx line 707).
  // Mirroring the exact correction block from runRoofPipeline keeps the
  // two callers in lockstep — without this, the serial path returned
  // 3,561 sqft on Jupiter while the compare path silently kept 1,721,
  // which is what the rep / customer would actually see. See the
  // matching block earlier in this file for full rationale.
  if (
    primary.source === "tier-c-solar" &&
    primary.confidence < 0.85 &&
    primary.totals.totalFootprintSqft > 0 &&
    primary.totals.totalRoofAreaSqft > 0
  ) {
    try {
      const hn = opts.address.formatted.match(/^\s*(\d+[A-Za-z]?)\b/)?.[1];
      const gis = await fetchGisFootprint(
        opts.address.lat,
        opts.address.lng,
        hn,
      );
      if (gis) {
        const gisSqft = polygonAreaSqft(gis.polygon);
        const solarFootprint = primary.totals.totalFootprintSqft;
        const ratio = solarFootprint / gisSqft;

        // ─── Track K validation (compare path mirror) ─────────────────
        // Same as the serial pipeline above — tightened residential
        // bounds (12k upper) + centroid proximity check vs the address.
        const gisIsResidential = gisSqft >= 600 && gisSqft <= 12_000;
        const cosLat = Math.cos((opts.address.lat * Math.PI) / 180);
        const gisCentroidLat =
          gis.polygon.reduce((s, p) => s + p.lat, 0) / gis.polygon.length;
        const gisCentroidLng =
          gis.polygon.reduce((s, p) => s + p.lng, 0) / gis.polygon.length;
        const dLatM = (gisCentroidLat - opts.address.lat) * 111_320;
        const dLngM = (gisCentroidLng - opts.address.lng) * 111_320 * cosLat;
        const gisCentroidOffsetM = Math.hypot(dLatM, dLngM);
        const gisCentroidNearAddress = gisCentroidOffsetM <= 25;
        const solarUndercounting = ratio < 0.6;

        if (!gisIsResidential || !gisCentroidNearAddress) {
          primary.diagnostics.warnings.push(
            `gis_rejected: ${gis.source} returned ${Math.round(gisSqft)} sqft polygon ` +
              `${gisCentroidOffsetM.toFixed(0)}m from address — ` +
              `${!gisIsResidential ? `outside residential bounds [600, 12000] sqft` : `centroid >25m from address`}. ` +
              `Solar's uncorrected ${primary.totals.totalRoofAreaSqft} sqft used; manual review recommended.`,
          );
          primary.diagnostics.needsReview.push({
            kind: "facet",
            id: "all",
            reason: "gis_polygon_invalid",
          });
          console.warn(
            `[roof-pipeline] gis_rejected (compare) gis=${gis.source} sqft=${Math.round(gisSqft)} ` +
              `offset_m=${gisCentroidOffsetM.toFixed(0)} solar_undercount_skipped`,
          );
        } else if (gisIsResidential && solarUndercounting) {
          const slopeFactor =
            primary.totals.totalRoofAreaSqft / solarFootprint;
          const correctedSloped = Math.round(gisSqft * slopeFactor);
          const oldSloped = primary.totals.totalRoofAreaSqft;
          const oldFootprint = primary.totals.totalFootprintSqft;
          primary.totals.totalRoofAreaSqft = correctedSloped;
          primary.totals.totalFootprintSqft = Math.round(gisSqft);
          primary.totals.totalSquares =
            Math.ceil((correctedSloped / 100) * 3) / 3;
          // See parallel block at line ~490: re-derive footprint-dependent
          // EagleView fields after GIS correction so the compare path
          // matches the serial path's behavior.
          primary.totals.estimatedAtticSqft = Math.round(gisSqft * 0.91);
          primary.totals.stories =
            primary.totals.averagePitchDegrees >= 26.6 &&
            primary.totals.totalFootprintSqft <= 2000
              ? 2
              : 1;
          primary.diagnostics.warnings.push(
            `solar_undercount_corrected: Solar ${oldFootprint}→${primary.totals.totalFootprintSqft} sqft footprint ` +
              `(${gis.source} GIS), ${oldSloped}→${correctedSloped} sqft sloped ` +
              `(slope factor ${slopeFactor.toFixed(3)})`,
          );
          console.log(
            `[roof-pipeline] solar_undercount_corrected (compare) ` +
              `gis=${gis.source} gis_sqft=${Math.round(gisSqft)} ` +
              `solar_footprint=${oldFootprint} ratio=${ratio.toFixed(2)} ` +
              `slope_factor=${slopeFactor.toFixed(3)} ` +
              `final_sqft=${correctedSloped}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        "[roof-pipeline] solar_undercount_check_failed (compare)",
        err instanceof Error ? err.message : String(err),
      );
    }
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
      "roof-data-v3-compare-undercount-fix",
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

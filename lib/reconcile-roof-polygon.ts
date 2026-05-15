/**
 * Reconcile a SAM3-traced roof polygon against the GIS building footprint
 * for the same address. Resolves the most common SAM3 failure modes:
 *
 *   1. PARTIAL OCCLUSION — tree canopy covers part of the roof, SAM3 only
 *      traces the visible portion. Detect via low SAM3-vs-footprint area
 *      ratio; substitute the GIS footprint × eave-overhang factor.
 *
 *   2. WRONG BUILDING — SAM3 latches onto a brighter neighbor or detached
 *      structure. Detect via SAM3 centroid drift from the geocoded address;
 *      substitute the GIS footprint.
 *
 *   3. OVER-TRACE — SAM3 includes the yard / driveway / pool perimeter.
 *      Detect via high area ratio; substitute the GIS footprint.
 *
 * GIS source priority: Microsoft Buildings (precomputed, fast, ~Nashville-
 * area only) → OSM Overpass (slower, ~50–60% US residential coverage).
 *
 * Eave overhang factor: GIS footprints trace ground projection of walls,
 * not roof material edges. Roofs typically overhang the walls by 6–18 in,
 * so footprint × 1.06 approximates the roof outline before pitch.
 */

import {
  polygonAreaSqft,
  polygonIntersection,
  polygonIoU,
  polygonIsNearAddress,
} from "./polygon";
// Phase 1 migration — was `./microsoft-buildings` (Nashville TSV impl);
// new path points at the Azure + 3-tier-cached module. Preserves the
// MS-Buildings-only semantics this consumer expects (rural fallback in
// the reconciliation tier ladder).
import { fetchMsBuildingsOnly as fetchMicrosoftBuildingPolygon } from "./sources/ms-buildings";
import { fetchBuildingPolygon } from "./buildings";

type LatLng = { lat: number; lng: number };

export type ReconciledRoofSource =
  /** SAM3 polygon used as-is — passed all reconciliation checks. */
  | "sam3"
  /** GIS footprint substituted because SAM3 was partial / over-traced. */
  | "footprint-occluded"
  /** GIS footprint used because SAM3 returned no usable polygon. */
  | "footprint-only"
  /** SAM3 polygon used without cross-check because no GIS was available. */
  | "sam3-no-footprint";

export interface ReconciledRoof {
  polygon: Array<LatLng>;
  /** Top-down footprint sqft. NOT pitch-corrected — caller multiplies by
   *  `1 / cos(pitchDegrees)` to get roof material sqft. */
  footprintSqft: number;
  source: ReconciledRoofSource;
  /** Human-readable reason — surfaced in logs and the rep-facing UI tag. */
  reason: string;
  /** Diagnostics — included for telemetry / debugging. */
  diagnostics: {
    sam3Sqft: number | null;
    gisSqft: number | null;
    areaRatio: number | null;
    iou: number | null;
    gisSource: "microsoft-buildings" | "osm" | null;
    sam3CentroidNearAddress: boolean | null;
  };
}

/** GIS footprints trace walls, not roof eaves. Roof material outline
 *  is typically 4–8% larger than footprint due to overhang; 1.06 is a
 *  conservative midpoint that under-quotes by <2% in most cases. */
const EAVE_OVERHANG_FACTOR = 1.06;

/** SAM3 polygon area must be within these bounds × footprint to be
 *  trusted WHEN IoU is below TRUSTED_IOU_THRESHOLD. When IoU clears the
 *  threshold, the area band is widened (high IoU proves the polygons
 *  describe the same building, so a slightly tight or generous trace
 *  is fine).
 *
 *  Loosened sequence:
 *    0.85 → 0.65 (2026-05-07): Orlando test with ratio=0.83/IoU=0.71
 *      was clearly correct but got demoted. SAM3 traces eaves; MS
 *      traces wall footprint PLUS attached porches/lanais/garages;
 *      ratio often <0.85 on correctly-traced FL houses.
 *    0.65 → 0.50 (2026-05-13): the Roboflow prompt change to
 *      "residential house roof" + zoom-19 fallback combo means SAM3
 *      polygons now trace house roofs more aggressively, often
 *      under-tracing relative to GIS wall+porch footprints (5385
 *      Henley class: Roboflow trace was perfect, but reconciler
 *      rejected it because GIS-with-porches was >2× larger). Lower
 *      MIN to 0.50 to accept those under-traces; raise MAX to 1.8
 *      to accept SAM3 polygons that include eaves on multi-section
 *      roofs whose GIS footprint missed an attached wing. */
const SAM3_AREA_RATIO_MIN = 0.5;
const SAM3_AREA_RATIO_MAX = 1.8;

/** When SAM3 and the GIS footprint overlap by at least this much (IoU),
 *  we trust SAM3 over the area-ratio gate. High IoU proves the two
 *  polygons describe the same building geometrically — area differences
 *  reflect SAM3 tracing roof material and GIS tracing wall footprint.
 *
 *  Lowered 0.5 → 0.35 (2026-05-13). SAM3 + GIS describing the same
 *  building reliably exceed 0.35; below that they're typically
 *  different buildings, not just different aspects of the same one. */
const TRUSTED_IOU_THRESHOLD = 0.35;

/** Below this IoU, SAM3 and the GIS footprint don't meaningfully overlap.
 *  That's a textbook wrong-building signal — even when the area ratio
 *  looks fine, SAM3 is tracing a roof in a different place than the
 *  building footprint we have for this address. Reject regardless of
 *  area, regardless of centroid proximity.
 *
 *  Lowered 0.15 → 0.05 (2026-05-13). 0.15 was rejecting cases where
 *  SAM3 (eaves) and GIS (wall+porch) overlapped at 0.10-0.14 on the
 *  same building — common on FL ranches with deep lanais. 0.05
 *  catches truly-zero-overlap (different buildings entirely) while
 *  allowing the eaves-vs-walls geometric mismatch. */
const ZERO_OVERLAP_IOU = 0.05;

/** SAM3 centroid must be within this distance of the geocoded-or-resolved
 *  address reference. Beyond this, SAM3 is almost certainly tracing the
 *  wrong building.
 *
 *  Loosened 15m → 40m (2026-05-13). The geocoded pin can be 20-40m off
 *  on rural setback parcels (Google's geocoder snaps to the driveway
 *  entrance, not the house). A correctly-traced setback house can have
 *  its centroid 25-35m from the pin and that's STILL the right building.
 *  15m was rejecting those. 40m matches SOLAR_DRIFT_THRESHOLD_M in
 *  route.ts for consistency — same "we don't trust the pin to within
 *  ±40m" framing across the pipeline. */
const CATASTROPHIC_DRIFT_M = 40;

/** Hard sanity bounds — anything outside this band is rejected outright. */
const MIN_FOOTPRINT_SQFT = 200;
const MAX_FOOTPRINT_SQFT = 20_000;

interface ReconcileInput {
  lat: number;
  lng: number;
  /** Optional reference point for proximity / wrong-building checks.
   *  Defaults to (lat, lng). Pass the resolved building center when
   *  available — e.g. when the satellite tile has been recentered on
   *  Solar's buildingCenter or a GIS polygon centroid — so SAM3 polygons
   *  on setback houses don't falsely fail the "wrong building" guard. */
  referenceLat?: number;
  referenceLng?: number;
  /** SAM3 output polygon. Pass `null` if SAM3 returned no polygon — this
   *  function will then fall through to the GIS footprint path. */
  sam3Polygon: Array<LatLng> | null;
  /** Override the GIS lookup (useful for tests / when caller already has
   *  it cached). When omitted, the function fetches MS Buildings → OSM. */
  gisPolygonOverride?: {
    polygon: Array<LatLng>;
    source: "microsoft-buildings" | "osm";
  } | null;
  /** Optional input-address house number (leading digit run, e.g. "1234"
   *  or "1234A"). Passed through to the OSM lookup, where it short-circuits
   *  ranking against `addr:housenumber` tags. MS Buildings has no tag
   *  data so this only affects the OSM path. */
  houseNumber?: string;
}

async function fetchGisFootprint(
  lat: number,
  lng: number,
  houseNumber?: string,
): Promise<{ polygon: Array<LatLng>; source: "microsoft-buildings" | "osm" } | null> {
  // Microsoft Buildings is a local file read — fast and free. Try first.
  const ms = await fetchMicrosoftBuildingPolygon({ lat, lng }).catch(() => null);
  if (ms) return { polygon: ms.polygon, source: "microsoft-buildings" };

  // OSM Overpass — slower (~1.5s fresh, 300ms cached) and patchier coverage,
  // but the only source for non-Nashville TN at the moment.
  const osm = await fetchBuildingPolygon({ lat, lng, houseNumber }).catch(() => null);
  if (osm) return { polygon: osm.latLng, source: "osm" };

  return null;
}

/**
 * Run the full reconciliation pipeline. Returns null only when neither SAM3
 * nor any GIS source produced a usable polygon — in that case the caller
 * should fall through to its next-tier source (Solar mask in our pipeline).
 */
export async function reconcileRoofPolygon(
  input: ReconcileInput,
): Promise<ReconciledRoof | null> {
  const { lat, lng, sam3Polygon } = input;
  // Reference point for proximity checks. When the caller resolved a
  // building centre and recentered the tile on it, use that as the
  // anchor — geocoded addresses can sit on the road and falsely fail
  // proximity checks for legitimately-traced houses.
  const refLat = input.referenceLat ?? lat;
  const refLng = input.referenceLng ?? lng;

  const gis =
    input.gisPolygonOverride !== undefined
      ? input.gisPolygonOverride
      : await fetchGisFootprint(lat, lng, input.houseNumber);

  const sam3Sqft =
    sam3Polygon && sam3Polygon.length >= 3 ? polygonAreaSqft(sam3Polygon) : null;
  const gisSqft = gis ? polygonAreaSqft(gis.polygon) : null;

  // ─── Case A: no usable SAM3 polygon ──────────────────────────────────
  // Hand back the GIS footprint × overhang, or null if GIS is also missing.
  const sam3IsUsable =
    sam3Polygon &&
    sam3Polygon.length >= 3 &&
    sam3Sqft != null &&
    sam3Sqft >= MIN_FOOTPRINT_SQFT &&
    sam3Sqft <= MAX_FOOTPRINT_SQFT;

  if (!sam3IsUsable) {
    if (
      gis &&
      gisSqft != null &&
      gisSqft >= MIN_FOOTPRINT_SQFT &&
      gisSqft <= MAX_FOOTPRINT_SQFT
    ) {
      return {
        polygon: gis.polygon,
        footprintSqft: Math.round(gisSqft * EAVE_OVERHANG_FACTOR),
        source: "footprint-only",
        reason: sam3Polygon
          ? `SAM3 polygon out of bounds (${sam3Sqft?.toFixed(0)} sqft); using GIS footprint × ${EAVE_OVERHANG_FACTOR}`
          : `no SAM3 polygon; using GIS footprint × ${EAVE_OVERHANG_FACTOR}`,
        diagnostics: {
          sam3Sqft,
          gisSqft,
          areaRatio: null,
          iou: null,
          gisSource: gis.source,
          sam3CentroidNearAddress: null,
        },
      };
    }
    return null;
  }

  // ─── Case B: SAM3 polygon exists but no GIS to cross-check ───────────
  if (!gis || !gisSqft) {
    const near = polygonIsNearAddress(sam3Polygon!, refLat, refLng, CATASTROPHIC_DRIFT_M);
    if (!near) {
      // No GIS fallback AND wrong building — caller falls through.
      return null;
    }
    return {
      polygon: sam3Polygon!,
      footprintSqft: Math.round(sam3Sqft!),
      source: "sam3-no-footprint",
      reason: "SAM3 polygon (no GIS available to cross-check)",
      diagnostics: {
        sam3Sqft,
        gisSqft: null,
        areaRatio: null,
        iou: null,
        gisSource: null,
        sam3CentroidNearAddress: near,
      },
    };
  }

  // ─── Case C: both SAM3 and GIS available — full reconciliation ───────
  const areaRatio = sam3Sqft! / gisSqft;
  const iou = polygonIoU(sam3Polygon!, gis.polygon);
  const sam3CentroidNearAddress = polygonIsNearAddress(
    sam3Polygon!,
    refLat,
    refLng,
    CATASTROPHIC_DRIFT_M,
  );

  // Wrong-building check #1 — centroid drift. A SAM3 polygon whose
  // centroid is far from the reference (geocoded address or resolved
  // building center) is almost certainly a neighbor's roof.
  if (!sam3CentroidNearAddress) {
    return {
      polygon: gis.polygon,
      footprintSqft: Math.round(gisSqft * EAVE_OVERHANG_FACTOR),
      source: "footprint-occluded",
      reason: `SAM3 centroid >${CATASTROPHIC_DRIFT_M}m from address (likely wrong building); using GIS footprint × ${EAVE_OVERHANG_FACTOR}`,
      diagnostics: {
        sam3Sqft,
        gisSqft,
        areaRatio,
        iou,
        gisSource: gis.source,
        sam3CentroidNearAddress,
      },
    };
  }

  // Wrong-building check #2 — IoU floor. The centroid check can pass
  // when SAM3 traced a small neighbor whose edge happens to be within
  // 15m of the address (e.g. dense urban / suburban lots). But IoU=0
  // with the GIS footprint can mean two very different things:
  //   a) Genuinely different buildings (SAM3 picked wrong)
  //   b) OSM tagged the entire parcel/lot as `building=*` instead of
  //      the actual building footprint — common on suburban/rural FL
  //      lots. SAM3 traces the 5,000 sqft house inside a 77,000 sqft
  //      lot polygon → IoU 0 because OSM's polygon is 13× larger →
  //      reconciler used to reject SAM3 and trust the bogus OSM lot.
  //
  // Heuristic discriminator: if SAM3's centroid is near the address
  // AND GIS area is implausibly large for a residential building
  // (> 15,000 sqft is a strong tell — the largest residential US
  // home is ~22k sqft; OSM lot polygons routinely hit 30-80k+ sqft
  // for typical suburban parcels), trust SAM3. The OSM polygon is
  // mislabeled, not SAM3 wrong.
  const GIS_IMPLAUSIBLE_RESIDENTIAL_SQFT = 15_000;
  const gisLooksLikeLot =
    gisSqft > GIS_IMPLAUSIBLE_RESIDENTIAL_SQFT &&
    sam3CentroidNearAddress &&
    sam3Sqft >= 800 &&        // SAM3 produced a residential-sized trace
    sam3Sqft <= 20_000;        // not commercial-scale either
  if (iou < ZERO_OVERLAP_IOU && !gisLooksLikeLot) {
    return {
      polygon: gis.polygon,
      footprintSqft: Math.round(gisSqft * EAVE_OVERHANG_FACTOR),
      source: "footprint-occluded",
      reason: `SAM3 has IoU ${iou.toFixed(2)} with GIS footprint (different buildings); using GIS footprint × ${EAVE_OVERHANG_FACTOR}`,
      diagnostics: {
        sam3Sqft,
        gisSqft,
        areaRatio,
        iou,
        gisSource: gis.source,
        sam3CentroidNearAddress,
      },
    };
  }
  if (iou < ZERO_OVERLAP_IOU && gisLooksLikeLot) {
    // OSM "building" polygon is actually the lot. SAM3 wins.
    // Don't fall through to the rest of the reconciler — the
    // area-ratio gate below would reject SAM3 for being 7-10% of
    // a lot-sized "footprint" too.
    console.log(
      "reconcile: gisLooksLikeLot — trusting SAM3 over GIS lot polygon",
      { sam3Sqft: Math.round(sam3Sqft), gisSqft: Math.round(gisSqft), gisSource: gis.source },
    );
    return {
      polygon: sam3Polygon!,
      footprintSqft: Math.round(sam3Sqft),
      source: "sam3",
      reason: `SAM3 trusted: GIS source=${gis.source} returned ${Math.round(gisSqft)} sqft (parcel-sized, not building); SAM3 traced ${Math.round(sam3Sqft)} sqft`,
      diagnostics: {
        sam3Sqft,
        gisSqft,
        areaRatio,
        iou,
        gisSource: gis.source,
        sam3CentroidNearAddress,
      },
    };
  }

  // IoU is the strongest single signal that SAM3 picked the right building.
  // When SAM3's polygon overlaps the GIS footprint substantially, both
  // polygons describe the same physical building — area differences just
  // reflect SAM3 tracing roof eaves while GIS traces wall footprint plus
  // attached structures (covered porches, lanais, garages — common in FL).
  // Trust SAM3 in this case even if the area ratio looks off.
  const iouTrusted = iou >= TRUSTED_IOU_THRESHOLD;

  // Area-ratio gate (only when IoU isn't strong enough on its own).
  // Same lot-misidentification escape: if GIS is implausibly large
  // for a residential footprint AND SAM3 traced a residential-sized
  // building near the address, GIS is the lot, not the house —
  // trust SAM3 instead of rejecting it for being "too small."
  if (!iouTrusted && areaRatio < SAM3_AREA_RATIO_MIN && !gisLooksLikeLot) {
    return {
      polygon: gis.polygon,
      footprintSqft: Math.round(gisSqft * EAVE_OVERHANG_FACTOR),
      source: "footprint-occluded",
      reason: `SAM3 covered ${(areaRatio * 100).toFixed(0)}% of footprint and IoU ${iou.toFixed(2)} (likely tree occlusion); using GIS footprint × ${EAVE_OVERHANG_FACTOR}`,
      diagnostics: {
        sam3Sqft,
        gisSqft,
        areaRatio,
        iou,
        gisSource: gis.source,
        sam3CentroidNearAddress,
      },
    };
  }
  if (!iouTrusted && areaRatio > SAM3_AREA_RATIO_MAX) {
    // Option A — geometric clip. When SAM3 over-traces (likely included
    // yard/driveway/pool deck) but GIS has a plausible residential
    // building outline (800-20k sqft) AND SAM3 overlaps it meaningfully
    // (iou ≥ MIN_CLIP_IOU), intersect the two polygons. SAM3 ∩ GIS
    // keeps SAM3's vertex resolution where it agrees with GIS and
    // trims the over-trace creep. Result is labeled source:"sam3"
    // so the picker accepts it.
    //
    // Jupiter case: SAM3 = 15,950 sqft (yard included), OSM = 4,021
    // sqft (correct building), IoU = 0.25, areaRatio = 3.97. The
    // intersection produces ~4,021 sqft with SAM3's edge fidelity.
    //
    // Skip when gisLooksLikeLot already fired (Oak Park) — that path
    // returned earlier with the raw SAM3 polygon.
    const MIN_CLIP_IOU = 0.10;
    const GIS_TRUSTABLE_MIN_SQFT = 800;
    const GIS_TRUSTABLE_MAX_SQFT = 20_000;
    const SAM3_OVERTRACE_RATIO = 2.0;
    const overtraceClippable =
      areaRatio > SAM3_OVERTRACE_RATIO &&
      iou >= MIN_CLIP_IOU &&
      gisSqft >= GIS_TRUSTABLE_MIN_SQFT &&
      gisSqft <= GIS_TRUSTABLE_MAX_SQFT;
    if (overtraceClippable) {
      const clipped = polygonIntersection(sam3Polygon!, gis.polygon);
      if (clipped && clipped.length >= 3) {
        const clippedSqft = polygonAreaSqft(clipped);
        if (
          clippedSqft >= GIS_TRUSTABLE_MIN_SQFT &&
          clippedSqft <= GIS_TRUSTABLE_MAX_SQFT
        ) {
          console.log(
            "reconcile: over-trace clipped — SAM3 ∩ GIS produced bounded polygon",
            {
              sam3Sqft: Math.round(sam3Sqft),
              gisSqft: Math.round(gisSqft),
              clippedSqft: Math.round(clippedSqft),
              iou: iou.toFixed(2),
              gisSource: gis.source,
            },
          );
          return {
            polygon: clipped,
            footprintSqft: Math.round(clippedSqft),
            source: "sam3",
            reason: `SAM3 over-traced ${(areaRatio * 100).toFixed(0)}% of footprint; clipped to GIS intersection (${Math.round(clippedSqft)} sqft from ${Math.round(sam3Sqft)})`,
            diagnostics: {
              sam3Sqft,
              gisSqft,
              areaRatio,
              iou,
              gisSource: gis.source,
              sam3CentroidNearAddress,
            },
          };
        }
      }
    }
    return {
      polygon: gis.polygon,
      footprintSqft: Math.round(gisSqft * EAVE_OVERHANG_FACTOR),
      source: "footprint-occluded",
      reason: `SAM3 was ${(areaRatio * 100).toFixed(0)}% of footprint and IoU ${iou.toFixed(2)} (likely yard/neighbor over-trace); using GIS footprint × ${EAVE_OVERHANG_FACTOR}`,
      diagnostics: {
        sam3Sqft,
        gisSqft,
        areaRatio,
        iou,
        gisSource: gis.source,
        sam3CentroidNearAddress,
      },
    };
  }

  // SAM3 passes all checks — use it. SAM3 traces roof eaves directly
  // (not the wall footprint), so its area is already roof-outline-correct
  // and we don't apply the overhang multiplier.
  return {
    polygon: sam3Polygon!,
    footprintSqft: Math.round(sam3Sqft!),
    source: "sam3",
    reason: iouTrusted
      ? `SAM3 polygon (IoU ${iou.toFixed(2)} ≥ ${TRUSTED_IOU_THRESHOLD} — same building as GIS footprint)`
      : `SAM3 polygon (${(areaRatio * 100).toFixed(0)}% of footprint, IoU ${iou.toFixed(2)})`,
    diagnostics: {
      sam3Sqft,
      gisSqft,
      areaRatio,
      iou,
      gisSource: gis.source,
      sam3CentroidNearAddress,
    },
  };
}

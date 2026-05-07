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

import { polygonAreaSqft, polygonIoU, polygonIsNearAddress } from "./polygon";
import { fetchMicrosoftBuildingPolygon } from "./microsoft-buildings";
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

/** SAM3 polygon area must be within [0.85, 1.40] × footprint to be trusted.
 *  - <0.85 ⇒ partial occlusion, missing wing, or under-trace
 *  - >1.40 ⇒ over-trace into yard / neighbor / pool
 *  Tune from the production telemetry once we have a few weeks of data. */
const SAM3_AREA_RATIO_MIN = 0.85;
const SAM3_AREA_RATIO_MAX = 1.4;

/** SAM3 centroid must be within this distance of the geocoded address.
 *  Beyond this, SAM3 is almost certainly tracing the wrong building. */
const CATASTROPHIC_DRIFT_M = 15;

/** Hard sanity bounds — anything outside this band is rejected outright. */
const MIN_FOOTPRINT_SQFT = 200;
const MAX_FOOTPRINT_SQFT = 20_000;

interface ReconcileInput {
  lat: number;
  lng: number;
  /** SAM3 output polygon. Pass `null` if SAM3 returned no polygon — this
   *  function will then fall through to the GIS footprint path. */
  sam3Polygon: Array<LatLng> | null;
  /** Override the GIS lookup (useful for tests / when caller already has
   *  it cached). When omitted, the function fetches MS Buildings → OSM. */
  gisPolygonOverride?: {
    polygon: Array<LatLng>;
    source: "microsoft-buildings" | "osm";
  } | null;
}

async function fetchGisFootprint(
  lat: number,
  lng: number,
): Promise<{ polygon: Array<LatLng>; source: "microsoft-buildings" | "osm" } | null> {
  // Microsoft Buildings is a local file read — fast and free. Try first.
  const ms = await fetchMicrosoftBuildingPolygon({ lat, lng }).catch(() => null);
  if (ms) return { polygon: ms.polygon, source: "microsoft-buildings" };

  // OSM Overpass — slower (~1.5s fresh, 300ms cached) and patchier coverage,
  // but the only source for non-Nashville TN at the moment.
  const osm = await fetchBuildingPolygon({ lat, lng }).catch(() => null);
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

  const gis =
    input.gisPolygonOverride !== undefined
      ? input.gisPolygonOverride
      : await fetchGisFootprint(lat, lng);

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
    const near = polygonIsNearAddress(sam3Polygon!, lat, lng, CATASTROPHIC_DRIFT_M);
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
    lat,
    lng,
    CATASTROPHIC_DRIFT_M,
  );

  // Wrong-building check first — overrides area ratio. A SAM3 polygon
  // that's 100% of the neighbor's footprint still gets rejected.
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

  // Area-ratio check — primary occlusion / over-trace detector.
  if (areaRatio < SAM3_AREA_RATIO_MIN) {
    return {
      polygon: gis.polygon,
      footprintSqft: Math.round(gisSqft * EAVE_OVERHANG_FACTOR),
      source: "footprint-occluded",
      reason: `SAM3 covered ${(areaRatio * 100).toFixed(0)}% of footprint (likely tree occlusion); using GIS footprint × ${EAVE_OVERHANG_FACTOR}`,
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
  if (areaRatio > SAM3_AREA_RATIO_MAX) {
    return {
      polygon: gis.polygon,
      footprintSqft: Math.round(gisSqft * EAVE_OVERHANG_FACTOR),
      source: "footprint-occluded",
      reason: `SAM3 was ${(areaRatio * 100).toFixed(0)}% of footprint (likely yard/neighbor over-trace); using GIS footprint × ${EAVE_OVERHANG_FACTOR}`,
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
    reason: `SAM3 polygon (${(areaRatio * 100).toFixed(0)}% of footprint, IoU ${iou.toFixed(2)})`,
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

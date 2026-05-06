"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddressInput from "@/components/AddressInput";
import AssumptionsEditor from "@/components/AssumptionsEditor";
import AddOnsPanel from "@/components/AddOnsPanel";
import ResultsPanel from "@/components/ResultsPanel";
import OutputButtons from "@/components/OutputButtons";
import MapView from "@/components/MapView";
import InsightsPanel from "@/components/InsightsPanel";
import PropertyContextPanel from "@/components/PropertyContextPanel";
import StormHistoryCard from "@/components/StormHistoryCard";
import VisionPanel from "@/components/VisionPanel";
import LineItemsPanel from "@/components/LineItemsPanel";
import TiersPanel from "@/components/TiersPanel";
import MeasurementsPanel from "@/components/MeasurementsPanel";
import RoofBlueprint from "@/components/RoofBlueprint";
import PolygonSizeWarning from "@/components/PolygonSizeWarning";
import SectionHeader from "@/components/SectionHeader";
import OutlineQualityWarning from "@/components/OutlineQualityWarning";
import PhotoUploadPanel from "@/components/PhotoUploadPanel";
import ImageryStormBanner from "@/components/ImageryStormBanner";
import CarrierClaimPanel from "@/components/CarrierClaimPanel";
import type { PhotoMeta } from "@/types/photo";
import type { ClaimContext } from "@/lib/carriers";
import dynamic from "next/dynamic";
import { QuantumPulseLoader } from "@/components/ui/quantum-pulse-loader";

const Roof3DViewer = dynamic(() => import("@/components/Roof3DViewer"), {
  ssr: false,
});
const ParametricRoofViewer = dynamic(
  () => import("@/components/ParametricRoofViewer"),
  { ssr: false },
);
import ErrorBoundary from "@/components/ErrorBoundary";
import { useKeyboardShortcuts } from "@/lib/useKeyboardShortcuts";
import { generatePdf, buildSummaryText } from "@/lib/pdf";
import { saveEstimate } from "@/lib/storage";
import type { ProposalTier } from "@/lib/tiers";
import type {
  AddOn,
  AddressInfo,
  Assumptions,
  Estimate,
  RoofVision,
  SolarSummary,
} from "@/types/estimate";
import {
  DEFAULT_ADDONS,
  buildDetailedEstimate,
  computeBase,
  computeTotal,
} from "@/lib/pricing";
import {
  buildWasteTable,
  deriveRoofLengthsFromPolygons,
  deriveRoofLengthsHeuristic,
  inferComplexityFromPolygons,
} from "@/lib/roof-geometry";
import {
  orthogonalizePolygon,
  mergeNearbyVertices,
  polygonIsNearAddress,
  polygonCoversFootprint,
  polygonsCoverFootprint,
  polygonAreaSqft,
  polygonIoU,
} from "@/lib/polygon";
import { BRAND_CONFIG } from "@/lib/branding";
import { estimateAge, estimateRoofSize } from "@/lib/utils";
import { newId } from "@/lib/storage";
import { Plus, RotateCcw, Sparkles, Zap } from "lucide-react";

const DEFAULT_ASSUMPTIONS: Assumptions = {
  sqft: 2200,
  pitch: "6/12",
  material: "asphalt-architectural",
  ageYears: 15,
  laborMultiplier: 1.0,
  materialMultiplier: 1.0,
  serviceType: "reroof-tearoff",
  complexity: "moderate",
};

const VISION_MATERIAL_TO_ASSUMPTION: Partial<
  Record<RoofVision["currentMaterial"], Assumptions["material"]>
> = {
  "asphalt-3tab": "asphalt-3tab",
  "asphalt-architectural": "asphalt-architectural",
  "metal-standing-seam": "metal-standing-seam",
  "tile-concrete": "tile-concrete",
};

export default function HomePage() {
  const [addressText, setAddressText] = useState("");
  const [address, setAddress] = useState<AddressInfo | null>(null);
  const [assumptions, setAssumptions] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [addOns, setAddOns] = useState<AddOn[]>(DEFAULT_ADDONS);
  const [staff, setStaff] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [notes, setNotes] = useState("");
  const [estimateId, setEstimateId] = useState<string>(newId());
  const [shown, setShown] = useState(false);

  const [solar, setSolar] = useState<SolarSummary | null>(null);
  const [vision, setVision] = useState<RoofVision | null>(null);
  const [visionLoading, setVisionLoading] = useState(false);
  const [visionError, setVisionError] = useState<string>("");
  const [isInsuranceClaim, setIsInsuranceClaim] = useState(false);
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [claim, setClaim] = useState<ClaimContext>({ carrier: "state-farm" });
  const [osmBuildingPolygon, setOsmBuildingPolygon] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  // Compound-pipeline result — OSM building × SAM 2 "roof" mask.
  // Tighter than OSM (it removes porches/decks/garages from the polygon)
  // and tighter than Claude (pixel-precise mask, not LLM-traced vertices).
  const [samRefinedPolygon, setSamRefinedPolygon] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  const [samRefining, setSamRefining] = useState(false);
  // Google Solar dataLayers:get binary roof mask — Project Sunroof's own
  // ground-truth segmentation. Beats SAM/OSM/AI for any property in Solar
  // coverage. Falls back through the chain when not available.
  const [solarMaskPolygon, setSolarMaskPolygon] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  // Polygon extracted client-side from the loaded 3D Tiles photogrammetric
  // mesh (Roof3DViewer samples elevations on a grid, thresholds above
  // tiles3d (mesh height extraction) was removed — produced inconsistent
  // results across rural properties (locked onto tree blobs, sheds, or
  // partial roofs depending on mesh quality). The 3D viewer now serves
  // purely as a visual renderer + multi-view capture surface for Claude
  // verification (separate route).
  // Roboflow Hosted Inference — roof-specific instance segmentation on the
  // same satellite tile the rest of the pipeline uses. Bake-off in
  // scripts/eval-roboflow.ts picked Satellite Rooftop Map (v3) — nailed a
  // hip-roof house at 92% confidence where tiles3d-vision had been
  // returning a wrong-angle rectangle.
  const [roboflowPolygon, setRoboflowPolygon] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  // Microsoft Building Footprints — open-data ML-extracted building polygons
  // covering rural areas where OSM has no coverage. ODbL license. Currently
  // scoped to the Nashville metro bbox (see lib/microsoft-buildings.ts).
  // Slotted below OSM (OSM is hand-traced, more accurate where present) and
  // above the Claude-vision last-resort.
  const [msBuildingPolygon, setMsBuildingPolygon] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  // Claude verification of the rendered polygon. Catches polygons traced
  // on the wrong building, neighbour's roof, covered patio over-traces.
  // When Claude flags an issue with high confidence (ok=false, conf>0.7),
  // we treat the source as failed and fall through. Otherwise informational.
  const [claudeVerifications, setClaudeVerifications] = useState<
    Partial<Record<string, { ok: boolean; confidence: number; reason: string; issues?: string[] }>>
  >({});
  // Live polygons after the rep edits a vertex. When set, overrides the
  // auto-detected source polygons everywhere (lengths, sqft, blueprint, PDF).
  // Reset to null on every new estimate so we always start from auto-detect.
  const [livePolygons, setLivePolygons] = useState<
    Array<Array<{ lat: number; lng: number }>> | null
  >(null);
  // Tracked via ref so late-arriving SAM doesn't stomp in-progress edits
  // (the sam-refine fetch resolves ~5-10s after OSM, by which point the rep
  // may have already moved vertices on the OSM polygon).
  const hasUserEditedRef = useRef(false);
  // Refs mirror state for the edit-capture closure so its [] dep array is
  // safe — without these, the captured edit would carry stale address /
  // source data from the moment handlePolygonsChanged was first created.
  const addressRef = useRef<AddressInfo | null>(null);
  const polygonSourceRef = useRef<string>("none");
  // Active-learning edit capture: when the rep settles on a corrected
  // polygon (5s of no further edits), persist it as a future training/
  // eval datapoint. The rep's manual correction IS the ground truth for
  // this address; capturing thousands of these over time gives us a
  // labeled corpus for fine-tuning a custom segmenter — without any
  // extra labeling effort. The original AI source is recorded too so we
  // can later compute "Roboflow IoU vs rep-corrected truth" by source.
  const editCaptureTimerRef = useRef<number | null>(null);
  const lastCapturedSignatureRef = useRef<string | null>(null);
  const handlePolygonsChanged = useCallback(
    (polys: Array<Array<{ lat: number; lng: number }>>) => {
      hasUserEditedRef.current = true;
      setLivePolygons(polys);
      // Debounced capture: reset on every edit, fire 5s after last edit.
      if (editCaptureTimerRef.current != null) {
        window.clearTimeout(editCaptureTimerRef.current);
      }
      editCaptureTimerRef.current = window.setTimeout(() => {
        editCaptureTimerRef.current = null;
        const primary = polys?.[0];
        if (!primary || primary.length < 3) return;
        // De-dup: don't re-POST identical polygons (rep clicked but didn't
        // change anything, or the debounce caught a no-op flicker).
        const sig = `${primary.length}|${primary[0].lat.toFixed(6)},${primary[0].lng.toFixed(6)}`;
        if (sig === lastCapturedSignatureRef.current) return;
        lastCapturedSignatureRef.current = sig;
        // Fire-and-forget; failures are non-fatal (capture is opportunistic).
        const a = addressRef.current;
        fetch("/api/eval-truth/edit-capture", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: a?.formatted ?? null,
            lat: a?.lat ?? null,
            lng: a?.lng ?? null,
            originalSource: polygonSourceRef.current,
            polygon: primary,
          }),
        }).catch(() => { /* opportunistic */ });
      }, 5000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const s = localStorage.getItem("pitch.staff");
    if (s) setStaff(s);
  }, []);
  useEffect(() => {
    if (staff) localStorage.setItem("pitch.staff", staff);
  }, [staff]);

  const { low, high } = useMemo(() => {
    const b = computeBase(assumptions);
    return { low: b.low, high: b.high };
  }, [assumptions]);

  const total = useMemo(() => computeTotal(assumptions, addOns), [assumptions, addOns]);

  // Polygon priority: Solar API per-facet > Claude single-polygon fallback.
  // Claude's polygon is in pixel coords on the 640x640 zoom-20 satellite tile;
  // we project back to lat/lng using the same meters-per-pixel formula MapView
  // uses, so the polygon lines up with the satellite imagery underneath.
  const claudePolygonLatLng = useMemo(() => {
    if (!address?.lat || !address?.lng) return null;
    const rawPoly = vision?.roofPolygon;
    if (!rawPoly || rawPoly.length < 3) return null;
    // Soft orthogonalize Claude's pixel-space trace before projection.
    // We DON'T force an oriented bounding rectangle here — bounding boxes
    // CIRCUMSCRIBE the input, so when Claude over-traces (covers the yard
    // too), the rect ends up even bigger. The size guard in cleanRoofPolygon
    // (lib/anthropic.ts) is what protects against over-trace; this pass
    // just smooths jaggies on traces that ARE roughly correct.
    // Orthogonalize, then drop near-duplicate vertices (orthogonalization
    // can collapse two adjacent vertices onto the same intersection point).
    const poly = mergeNearbyVertices(orthogonalizePolygon(rawPoly, 18), 4);
    const lat = address.lat;
    const lng = address.lng;
    const mPerPx =
      (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, 20);
    const cosLat = Math.cos((lat * Math.PI) / 180);
    return poly.map(([x, y]) => {
      const dx = x - 320;
      const dy = y - 320;
      return {
        lat: lat + (-dy * mPerPx) / 111_320,
        lng: lng + (dx * mPerPx) / (111_320 * cosLat),
      };
    });
  }, [vision?.roofPolygon, address?.lat, address?.lng]);

  // Wrong-house guard. Every auto-detected polygon must contain (or be
  // within tolerance of) an anchor on the actual building. Catches the
  // failure mode where AI traces the brightest neighbouring roof rather
  // than the actual target. Returns the polygon when valid, null when
  // it should be rejected.
  //
  // Polygon passes if it satisfies EITHER anchor:
  //   1. Solar's `buildingCenter` — Solar API's photogrammetric centroid
  //      for the closest building. On the actual roof when present.
  //   2. The user's geocoded address — Google's address point. Sits on
  //      the building footprint for tightly-platted suburban lots, but
  //      may be 10-20m off on large lots / set-back houses / parcels
  //      where the address geocodes to the lot center / driveway / pool.
  //
  // Tolerance tuned to 18m: the eval surfaced two FL addresses where
  // Roboflow returned an IoU=0 polygon on a neighbour's roof but within
  // 15m of the geocoded address — that's the upper bound we need to
  // reject. But early production testing showed 8m was too tight on
  // large lots where the geocoded point lands on the patio/lawn rather
  // than the building. 18m keeps the wrong-house failures we measured
  // out while letting through correct polygons whose anchor sits on
  // hardscape adjacent to the building.
  const PROXIMITY_M = 18;
  const buildingCenter = solar?.buildingCenter ?? null;
  const validateAtAddress = (
    poly: Array<{ lat: number; lng: number }> | null,
  ): Array<{ lat: number; lng: number }> | null => {
    if (!poly || poly.length < 3) return null;
    // Either anchor passes — buildingCenter is a BONUS signal, not a gate.
    // When Solar finds a building close to the user's geocoded address it
    // confirms which lot is the target; when it finds a neighbour's
    // building (Solar's `findClosest` is "closest to the input lat/lng",
    // which can be off when the address is rural or on a corner lot),
    // we don't want it to invalidate polygons that ARE on the user's
    // actual building.
    if (
      buildingCenter &&
      polygonIsNearAddress(poly, buildingCenter.lat, buildingCenter.lng, PROXIMITY_M)
    ) {
      return poly;
    }
    if (address?.lat == null || address?.lng == null) {
      return buildingCenter ? null : poly;
    }
    return polygonIsNearAddress(poly, address.lat, address.lng, PROXIMITY_M) ? poly : null;
  };

  const validSolarMask = useMemo(() => validateAtAddress(solarMaskPolygon), [solarMaskPolygon, address?.lat, address?.lng, buildingCenter]);
  const validRoboflow = useMemo(() => validateAtAddress(roboflowPolygon), [roboflowPolygon, address?.lat, address?.lng, buildingCenter]);
  const validSam = useMemo(() => validateAtAddress(samRefinedPolygon), [samRefinedPolygon, address?.lat, address?.lng, buildingCenter]);
  const validOsm = useMemo(() => validateAtAddress(osmBuildingPolygon), [osmBuildingPolygon, address?.lat, address?.lng, buildingCenter]);
  const validMsBuilding = useMemo(() => validateAtAddress(msBuildingPolygon), [msBuildingPolygon, address?.lat, address?.lng, buildingCenter]);
  const validClaude = useMemo(() => validateAtAddress(claudePolygonLatLng), [claudePolygonLatLng, address?.lat, address?.lng, buildingCenter]);

  // Pattern A: only consider a source if its 3D-mesh validation score is
  // above MIN_VALIDATION_SCORE (or no score yet — we don't penalize sources
  // that haven't been validated). 0.4 = at least 40% of polygon samples at
  // roof height. Tighter bars over-reject good polygons; looser bars let
  // through polygons traced on driveways. Tune up if false positives
  // continue to ship; tune down if good polygons get demoted.
  // Claude flagged the polygon as wrong with high confidence?  Demote it.
  // Low-confidence flags are informational (rep may notice a small edge
  // issue but the polygon is mostly right).
  const passesClaude = (source: string) => {
    const v = claudeVerifications[source];
    if (!v) return true;
    if (v.ok) return true;
    return v.confidence < 0.7; // ok=false but Claude isn't sure → keep
  };

  // MS Buildings hallucination cross-check. When BOTH Roboflow and MS
  // Buildings have polygons for the same address, compare areas + centroid
  // distance. If they disagree wildly (Roboflow's polygon is 3× the size
  // of MS's footprint, OR centroid is > 25m away), Roboflow has likely
  // hallucinated — traced a paved area or the neighbour's roof. Demote.
  // MS Buildings serves as a sanity-check authority for Roboflow because
  // it's pre-traced from satellite imagery (different model, different
  // training data) and contains the geocoded address point.
  const passesMsHallucinationCheck = (
    candidate: Array<{ lat: number; lng: number }> | null,
  ): boolean => {
    if (!candidate || candidate.length < 3) return true;
    if (!msBuildingPolygon || msBuildingPolygon.length < 3) return true; // no MS reference
    const cosLat = Math.cos(((candidate[0].lat) * Math.PI) / 180);
    const M_PER_DEG_LAT = 111_320;
    const polygonAreaSqM = (poly: Array<{ lat: number; lng: number }>): number => {
      let sum = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        sum += a.lng * b.lat - b.lng * a.lat;
      }
      // Convert from deg² to m² via local linear approximation
      const degSq = Math.abs(sum) / 2;
      return degSq * (M_PER_DEG_LAT * M_PER_DEG_LAT) * cosLat;
    };
    const centroid = (poly: Array<{ lat: number; lng: number }>) => {
      let lat = 0, lng = 0;
      for (const p of poly) { lat += p.lat; lng += p.lng; }
      return { lat: lat / poly.length, lng: lng / poly.length };
    };
    const aArea = polygonAreaSqM(candidate);
    const bArea = polygonAreaSqM(msBuildingPolygon);
    const ratio = aArea / Math.max(bArea, 1);
    const ac = centroid(candidate);
    const bc = centroid(msBuildingPolygon);
    const dxM = (ac.lng - bc.lng) * M_PER_DEG_LAT * cosLat;
    const dyM = (ac.lat - bc.lat) * M_PER_DEG_LAT;
    const centroidDistM = Math.hypot(dxM, dyM);
    // Reject when:
    //   - candidate is > 3× larger than MS footprint (over-trace into yard)
    //   - candidate is < 0.3× MS footprint (only tracing a portion of the building)
    //   - centroid is > 25m from MS footprint centroid (wrong building)
    if (ratio > 3.0 || ratio < 0.3 || centroidDistM > 25) {
      console.warn(
        `[hallucination] candidate vs MS Footprint: area ratio=${ratio.toFixed(2)}, centroid dist=${centroidDistM.toFixed(1)}m — flagging as hallucination`,
      );
      return false;
    }
    return true;
  };

  // Roof-type prior gate. Originally rejected polygons whose vertex
  // count wildly disagreed with vision.complexity (simple+>12 verts or
  // complex+≤4 verts). Production testing showed Vision's complexity
  // classification was less reliable than its confidence score
  // suggested, particularly on complex-segment roofs that Vision tagged
  // as "simple" — the gate then rejected good Solar/Roboflow polygons.
  // Currently a no-op pending more eval data; vertex-count vs Solar's
  // segmentCount may be a better signal than vision.complexity.
  const passesComplexityPrior = (
    _candidate: Array<{ lat: number; lng: number }> | null,
  ): boolean => true;

  // Footprint-coverage gate. Two failure modes:
  //   • UNDER-trace: segmenter caught one center section, missed wings.
  //     Polygon is < 55% of expected building footprint.
  //   • OVER-trace: segmenter followed fence / yard / driveway. Polygon
  //     is > 1.6× expected footprint (real eave overhang adds ~10–15%).
  //
  // Reference: prefer Solar's `buildingFootprintSqft` (DSM-derived,
  // closest to ground truth). When Solar has no footprint signal, fall
  // back to MS Buildings polygon area, then OSM polygon area — both are
  // pre-curated building footprints. Only when ALL three are missing
  // do we ship without coverage gating (rural last-resort).
  //
  // The reference source is excluded from being gated against itself
  // (otherwise it's circular). Other sources still get gated against it.
  const solarFootprintSqft = solar?.buildingFootprintSqft ?? null;
  const msFootprintSqft =
    validMsBuilding ? polygonAreaSqft(validMsBuilding) : null;
  const osmFootprintSqft = validOsm ? polygonAreaSqft(validOsm) : null;
  const referenceFootprintSqft =
    (solarFootprintSqft && solarFootprintSqft >= 100 ? solarFootprintSqft : null) ??
    (msFootprintSqft && msFootprintSqft >= 100 ? msFootprintSqft : null) ??
    (osmFootprintSqft && osmFootprintSqft >= 100 ? osmFootprintSqft : null);
  // Which source (if any) IS the reference — that source skips the gate
  // because comparing it to itself always passes (and is meaningless).
  const referenceSource: "solar" | "ms" | "osm" | null =
    solarFootprintSqft && solarFootprintSqft >= 100
      ? "solar"
      : msFootprintSqft && msFootprintSqft >= 100
        ? "ms"
        : osmFootprintSqft && osmFootprintSqft >= 100
          ? "osm"
          : null;
  const passesCoverage = (
    poly: Array<{ lat: number; lng: number }> | null | undefined,
  ) => polygonCoversFootprint(poly, referenceFootprintSqft, 0.55);
  const passesCoverageMulti = (
    polys: Array<Array<{ lat: number; lng: number }>> | null | undefined,
  ) => polygonsCoverFootprint(polys, referenceFootprintSqft, 0.55);

  // Polygon source priority — best-quality first.
  //
  // tiles3d (3D mesh height extraction) was originally at #1 but DEMOTED
  // below Roboflow because mesh quality varies wildly between properties.
  // On properties with sparse/noisy photogrammetric mesh, tiles3d
  // reproducibly extracts a tiny polygon on a shed near the geocode while
  // missing the actual main house. Roboflow is more CONSISTENT (~85-90%
  // accurate across all property types) even when not pixel-perfect.
  // Pattern A validation gates Roboflow on the mesh, so when the mesh IS
  // clean it improves Roboflow's score; when it's noisy, Roboflow still
  // wins.
  //
  //   1. Solar mask       — Project Sunroof's roof segmentation
  //                         (photogrammetric, ground truth where covered)
  //   2. Roboflow         — roof-trained instance segmenter on satellite
  //                         (Satellite Rooftop Map v3); consistent winner
  //   3. 3D Tiles mesh    — height-thresholded from Google's photogrammetry.
  //                         Demoted from #1 — only trusted when Roboflow
  //                         doesn't fire. Now requires ≥150 cells (was 80).
  //   4. Solar facets     — multi-facet bboxes from findClosest
  //   5. SAM 2 + OSM clip — point-prompted SAM with OSM building intersect
  //   6. OSM              — hand-traced building outline (~50-60% US, urban)
  //   7. MS Buildings     — open-data ML-extracted building footprints; fills
  //                         OSM coverage gap on rural addresses (Nashville)
  //   8. Claude vision    — Claude on the 2D satellite tile. Last resort.
  //
  // tiles3d-vision (Claude on multi-angle 3D mesh renders) was REMOVED —
  // it consistently produced over-traced rectangles. Claude's general vision
  // can't reliably pixel-trace eaves; roof-specific segmenters are needed.
  //
  // Each source goes through the wrong-house guard above before being
  // considered — a polygon that doesn't contain (or live very near to) the
  // geocoded address is dropped on the floor regardless of source.
  const polygonSource = useMemo<
    | "edited"
    | "tiles3d"
    | "solar-mask"
    | "roboflow"
    | "solar"
    | "sam"
    | "osm"
    | "microsoft-buildings"
    | "ai"
    | "none"
  >(() => {
    if (livePolygons && livePolygons.length) return "edited";
    // tiles3d removed — Roboflow + Claude verification is the path now.
    // Coverage gates (passesCoverage / passesCoverageMulti) preserved from
    // f5523d3: a polygon must cover ≥X% of the Solar-known footprint or
    // it gets demoted (catches "polygon is on a shed/garage, not the main
    // house"). OSM + MS Buildings are footprint-derived themselves so the
    // coverage gate is skipped on them — they're the ground truth Solar's
    // footprint comes from.
    if (validSolarMask && passesClaude("solar-mask") && passesCoverage(validSolarMask) && passesComplexityPrior(validSolarMask)) return "solar-mask";
    if (validRoboflow && passesClaude("roboflow") && passesCoverage(validRoboflow) && passesMsHallucinationCheck(validRoboflow) && passesComplexityPrior(validRoboflow)) return "roboflow";
    if (validSam && passesClaude("sam") && passesCoverage(validSam) && passesComplexityPrior(validSam)) return "sam";
    // Apply coverage gate to OSM & MS Buildings too — community traces and
    // ML-extracted footprints are sometimes wrong (yard perimeter, included
    // outbuildings, etc). When OSM/MS is the reference itself the gate is
    // self-comparing → trivially passes. Otherwise it catches wrong outlines
    // by ratio against Solar's footprint or whichever source IS the reference.
    if (validOsm && passesClaude("osm") && passesCoverage(validOsm) && passesComplexityPrior(validOsm)) return "osm";
    if (validMsBuilding && passesClaude("microsoft-buildings") && passesCoverage(validMsBuilding) && passesComplexityPrior(validMsBuilding)) return "microsoft-buildings";
    // Solar facets — rotated bboxes from findClosest. Demoted from former
    // position #3 (above SAM) to #6 (after MS Buildings) because the
    // rotated rectangles are visually crude vs. SAM/OSM/MS curated
    // outlines, even though their sqft sum is reasonable. Used as a
    // last-resort polygon source before AI fallback.
    if (solar?.segmentPolygonsLatLng?.length && solar.segmentCount > 1 && passesCoverageMulti(solar.segmentPolygonsLatLng)) return "solar";
    if (validClaude && passesClaude("ai") && passesCoverage(validClaude) && passesMsHallucinationCheck(validClaude)) return "ai";
    return "none";
  }, [
    livePolygons,
    validSolarMask,
    validRoboflow,
    solar?.segmentPolygonsLatLng,
    solar?.segmentCount,
    referenceFootprintSqft,
    validSam,
    validOsm,
    validMsBuilding,
    validClaude,
    claudeVerifications,
    msBuildingPolygon,
  ]);

  // Keep refs in sync for the active-learning edit-capture closure.
  useEffect(() => { addressRef.current = address; }, [address]);
  useEffect(() => { polygonSourceRef.current = polygonSource; }, [polygonSource]);

  // Source polygons — what MapView draws initially. Edited polygons don't
  // come back through this prop (would cause a redraw loop / cancel the
  // user's drag). They flow back via onPolygonsChanged → livePolygons.
  // Mirrors the priority/coverage logic from `polygonSource` above so the
  // map shows the polygon we'll actually use for sqft + lengths + PDF.
  const sourcePolygons:
    | Array<Array<{ lat: number; lng: number }>>
    | undefined = useMemo(() => {
    // NB: must mirror polygonSource priority above. tiles3d removed.
    if (validSolarMask && passesCoverage(validSolarMask)) return [validSolarMask];
    if (validRoboflow && passesCoverage(validRoboflow)) return [validRoboflow];
    if (validSam && passesCoverage(validSam)) return [validSam];
    if (validOsm && passesCoverage(validOsm)) return [validOsm];
    if (validMsBuilding && passesCoverage(validMsBuilding)) return [validMsBuilding];
    if (
      solar?.segmentPolygonsLatLng?.length &&
      solar.segmentCount > 1 &&
      passesCoverageMulti(solar.segmentPolygonsLatLng)
    )
      return solar.segmentPolygonsLatLng;
    if (validClaude && passesCoverage(validClaude)) return [validClaude];
    return undefined;
  }, [
    validSolarMask,
    validRoboflow,
    solar?.segmentPolygonsLatLng,
    solar?.segmentCount,
    referenceFootprintSqft,
    validSam,
    validOsm,
    validMsBuilding,
    validClaude,
  ]);

  // Active polygons — what we use for sqft, lengths, blueprint, PDF.
  // Live edits override source.
  const activePolygons = livePolygons ?? sourcePolygons;

  // Generation gate: don't show the polygon to the rep until Claude has
  // verified it (or until we're at a no-verify source like edited/ai).
  // Avoids the "three different outlines flickering" UX where Roboflow
  // showed first, then OSM swapped in, then Solar mask, etc. Now: blank
  // map + "Generating…" pill until verification completes.
  const polygonReady = useMemo(() => {
    if (polygonSource === "none") return true; // nothing to show; map is just satellite
    if (polygonSource === "edited") return true; // rep already approved by hand
    if (polygonSource === "tiles3d") return true; // legacy, no longer active
    if (polygonSource === "ai") return true; // last-resort, skip verify (Claude on Claude)
    // For all real AI / footprint sources: wait for the multi-view Claude verdict.
    return claudeVerifications[polygonSource] !== undefined;
  }, [polygonSource, claudeVerifications]);

  // Polygons we actually pass to the viewers. Undefined while !polygonReady
  // so MapView / Roof3DViewer don't draw an unverified outline.
  const renderedPolygons = polygonReady ? activePolygons : undefined;
  const renderedSourcePolygons = polygonReady ? sourcePolygons : undefined;
  // Verifying state for the spinner: we have an address + we're not yet
  // showing a polygon AND there's at least one source candidate fetching.
  const verifying =
    !!address?.lat &&
    !polygonReady &&
    polygonSource !== "none";

  // Cross-source consensus. Compute IoU between the active polygon and
  // every OTHER valid source's polygon — when multiple independent
  // detectors converge on the same shape, that's the strongest signal
  // we have that the polygon is correct. Also cheap insurance against
  // a single source being misled by fence lines / yard perimeters,
  // since unrelated detectors are unlikely to make the same mistake.
  const consensusInfo = useMemo<{
    agreeingSources: number;
    bestIoU: number;
    sources: Array<{ name: string; iou: number }>;
  }>(() => {
    const empty = { agreeingSources: 0, bestIoU: 0, sources: [] };
    if (!activePolygons || activePolygons.length === 0) return empty;
    const primary = activePolygons[0];
    if (!primary || primary.length < 3) return empty;
    const candidates: Array<{ name: string; poly: Array<{ lat: number; lng: number }> | null }> = [
      { name: "solar-mask", poly: validSolarMask },
      { name: "roboflow", poly: validRoboflow },
      { name: "sam", poly: validSam },
      { name: "osm", poly: validOsm },
      { name: "microsoft-buildings", poly: validMsBuilding },
      { name: "ai", poly: validClaude },
    ];
    const sources: Array<{ name: string; iou: number }> = [];
    let bestIoU = 0;
    for (const c of candidates) {
      if (!c.poly) continue;
      // Skip self — comparing the active polygon against itself is 1.0
      // and adds no information.
      if (c.poly === primary) continue;
      const iou = polygonIoU(primary, c.poly);
      sources.push({ name: c.name, iou });
      if (iou > bestIoU) bestIoU = iou;
    }
    const AGREE_THRESHOLD = 0.7;
    const agreeingSources = sources.filter((s) => s.iou >= AGREE_THRESHOLD).length;
    return { agreeingSources, bestIoU, sources };
  }, [
    activePolygons,
    validSolarMask,
    validRoboflow,
    validSam,
    validOsm,
    validMsBuilding,
    validClaude,
  ]);

  // Composite confidence for the rep. "high" / "moderate" / "low".
  // Inputs:
  //   • Cross-source consensus (3+ agreeing sources is strong; 2 is OK)
  //   • Multi-view Claude verdict (ok=true conf>0.85 is strong; ok=false
  //     high-conf collapses to low — that polygon is bad)
  //   • Source identity (rep edits = high; "ai" last-resort = low)
  //   • Reference footprint signal (Solar provided = better calibration)
  const estimateConfidence = useMemo<{
    level: "high" | "moderate" | "low";
    rationale: string;
  }>(() => {
    if (polygonSource === "edited") {
      return { level: "high", rationale: "Rep verified by hand" };
    }
    if (polygonSource === "none") {
      return { level: "low", rationale: "No polygon detected" };
    }
    const claudeV =
      polygonSource && claudeVerifications[polygonSource];
    // Hard fail on a high-confidence rejection from Claude.
    if (claudeV && !claudeV.ok && claudeV.confidence >= 0.7) {
      return { level: "low", rationale: `Verifier rejected: ${claudeV.reason || "polygon does not match roof"}` };
    }
    const claudeStrong = !!(claudeV && claudeV.ok && claudeV.confidence >= 0.85);
    const claudeMod = !!(claudeV && claudeV.ok && claudeV.confidence >= 0.6);

    // Imagery-age penalty. Solar / Google Static Maps imagery for any given
    // property dates 2017-2024. Older imagery means the rep may be looking
    // at a roof that's since been replaced, extended, or torn off — even
    // a perfect AI trace describes a stale state. STALE_YEARS=5 is the
    // point where roof material/condition divergence starts dominating;
    // 3 is when "noticeably aged" matters for sales accuracy.
    const STALE_YEARS = 5;
    const AGED_YEARS = 3;
    const imageryDateString = solar?.imageryDate ?? null;
    const imageryAgeYears = imageryDateString
      ? (Date.now() - new Date(imageryDateString).getTime()) /
        (365.25 * 24 * 3600 * 1000)
      : null;
    const isStaleImagery =
      imageryAgeYears != null &&
      isFinite(imageryAgeYears) &&
      imageryAgeYears > STALE_YEARS;
    const isAgedImagery =
      imageryAgeYears != null &&
      isFinite(imageryAgeYears) &&
      imageryAgeYears > AGED_YEARS;
    // Solar's `imageryQuality === "LOW"` also indicates a less reliable
    // mask — same effect on confidence.
    const lowQualityImagery = solar?.imageryQuality === "LOW";

    const ageNote = isStaleImagery
      ? ` · imagery ${Math.round(imageryAgeYears!)}y old`
      : isAgedImagery
        ? ` · imagery ${Math.round(imageryAgeYears!)}y old`
        : lowQualityImagery
          ? " · imagery LOW quality"
          : "";

    // Imagery age caps the achievable confidence level. Stale imagery (>5y)
    // can't be high-confidence even with perfect cross-source agreement —
    // the underlying ground truth might not be the current roof.
    if (consensusInfo.agreeingSources >= 3 || (claudeStrong && consensusInfo.agreeingSources >= 1)) {
      const cappedToModerate = isStaleImagery || lowQualityImagery;
      return {
        level: cappedToModerate ? "moderate" : "high",
        rationale: `${consensusInfo.agreeingSources + 1} sources agree${claudeStrong ? " · verifier passed" : ""}${ageNote}`,
      };
    }
    if (consensusInfo.agreeingSources >= 2 || claudeStrong || (claudeMod && consensusInfo.agreeingSources >= 1)) {
      const cappedToLow = isStaleImagery && !claudeStrong;
      return {
        level: cappedToLow ? "low" : "moderate",
        rationale: `${consensusInfo.agreeingSources + 1} sources agree${claudeMod ? " · verifier passed" : ""}${ageNote}`,
      };
    }
    if (polygonSource === "ai") {
      return { level: "low", rationale: `AI fallback (other sources unavailable)${ageNote}` };
    }
    if (consensusInfo.agreeingSources === 0 && consensusInfo.sources.length > 0) {
      return {
        level: "low",
        rationale: `Sources disagree (best IoU ${consensusInfo.bestIoU.toFixed(2)})${ageNote}`,
      };
    }
    return {
      level: isStaleImagery || lowQualityImagery ? "low" : "moderate",
      rationale: `Single-source polygon${ageNote}`,
    };
  }, [polygonSource, claudeVerifications, consensusInfo, solar?.imageryDate, solar?.imageryQuality]);

  // Single-image Claude verification was previously triggered here from
  // /api/verify-polygon. That endpoint still exists as a fallback but the
  // 3D viewer now drives multi-view verification via Roof3DViewer's
  // onMultiViewVerified callback (see /api/verify-polygon-multiview).
  // Multi-view is strictly more informative — it has top-down + 4 oblique
  // views with the polygon overlaid, lets Claude check cross-view
  // consistency. The single-image route remains for callers without 3D
  // (e.g. ssr / scripts).

  // Drop penetration markers that fall outside our active roof polygon —
  // Vision occasionally tags vents/skylights on neighboring houses since the
  // satellite tile spans more than just the target property. Anything we
  // can't clearly attribute to OUR roof shouldn't drive line-item counts or
  // confuse the rep on the satellite map.
  const filteredPenetrations = useMemo(() => {
    const pens = vision?.penetrations;
    if (!pens || pens.length === 0) return undefined;
    if (!activePolygons || activePolygons.length === 0 || address?.lat == null || address?.lng == null) {
      return pens;
    }
    const lat = address.lat;
    const lng = address.lng;
    const mPerPx = (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, 20);
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const inAny = (penLat: number, penLng: number) => {
      for (const poly of activePolygons) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i].lng, yi = poly[i].lat;
          const xj = poly[j].lng, yj = poly[j].lat;
          if (
            yi > penLat !== yj > penLat &&
            penLng < ((xj - xi) * (penLat - yi)) / (yj - yi) + xi
          ) {
            inside = !inside;
          }
        }
        if (inside) return true;
      }
      return false;
    };
    return pens.filter((p) => {
      const dx = p.x - 320;
      const dy = p.y - 320;
      const penLat = lat + (-dy * mPerPx) / 111_320;
      const penLng = lng + (dx * mPerPx) / (111_320 * cosLat);
      return inAny(penLat, penLng);
    });
  }, [vision?.penetrations, activePolygons, address?.lat, address?.lng]);

  // Whenever the active polygon changes, derive the roof area from it
  // and write to assumptions.sqft. Polygon-derived sqft is now the
  // canonical number — Solar API's `roofSegmentStats` total is no
  // longer used as the displayed sqft because it consistently
  // undercounts on complex / multi-section / older-imagery roofs
  // (Solar drops segments it can't confidently re-orient or whose
  // photogrammetry is shadowed). User feedback: "the rep is looking
  // AT the polygon — the number better match what they see."
  //
  // Trade-off accepted: applying a single pitch correction to the
  // whole polygon is approximate on multi-pitch roofs. Solar's per-
  // facet area would be more precise IF Solar caught all facets — but
  // when it doesn't, polygon × averaged pitch is closer than Solar's
  // truncated sum.
  //
  // Solar's `pitchDegrees` is still the preferred pitch (it's an
  // area-weighted average across all detected facets); we only fall
  // through to the rep's selected pitch when Solar has no signal.
  useEffect(() => {
    if (!activePolygons || activePolygons.length === 0) return;
    // Shoelace area in m² (lat/lng → meters via cosLat scale)
    const M = 111_320;
    let totalM2 = 0;
    for (const poly of activePolygons) {
      if (poly.length < 3) continue;
      const cLat = poly.reduce((s, v) => s + v.lat, 0) / poly.length;
      const cosLat = Math.cos((cLat * Math.PI) / 180);
      let sum = 0;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const ax = a.lng * M * cosLat;
        const ay = a.lat * M;
        const bx = b.lng * M * cosLat;
        const by = b.lat * M;
        sum += ax * by - bx * ay;
      }
      totalM2 += Math.abs(sum) / 2;
    }
    // Project footprint → roof surface area using the real pitch when
    // we have it (Solar `pitchDegrees`); fall back to the rep's selected
    // assumptions.pitch; final fallback is 6/12 (26.57°). Surface =
    // footprint / cos(pitch).
    const PITCH_MAP: Record<string, number> = {
      "4/12": 18.43, "5/12": 22.62, "6/12": 26.57, "7/12": 30.26, "8/12+": 35.0,
    };
    const pitchDeg =
      solar?.pitchDegrees ??
      PITCH_MAP[assumptions.pitch] ??
      26.57;
    const slopeMult = 1 / Math.cos((pitchDeg * Math.PI) / 180);
    const sqft = Math.round(totalM2 * 10.7639 * slopeMult);
    if (sqft >= 200 && sqft <= 30_000) {
      setAssumptions((a) => ({ ...a, sqft }));
    }
  }, [activePolygons, solar?.pitchDegrees, assumptions.pitch]);

  // Auto-derive complexity from polygon shape — strictly geometric, beats
  // Vision's noisy-thumbnail guess. Vision still wins when it returns
  // confidence >= 0.8 (set in the Solar+Vision merge below); this fires
  // for the moderate-confidence cases where the polygon is the better signal.
  useEffect(() => {
    if (!activePolygons || activePolygons.length === 0) return;
    if (vision && vision.confidence >= 0.8) return; // trust strong vision
    const inferred = inferComplexityFromPolygons(activePolygons);
    if (inferred && inferred !== assumptions.complexity) {
      setAssumptions((a) => ({ ...a, complexity: inferred }));
    }
  }, [activePolygons, vision, assumptions.complexity]);

  const detailed = useMemo(
    () =>
      buildDetailedEstimate(assumptions, addOns, {
        buildingFootprintSqft: solar?.buildingFootprintSqft ?? null,
        // Solar's segmentCount > everything. Otherwise, for a single-polygon
        // source (OSM / SAM / Claude), use vertex count as a complexity
        // proxy: a 4-vertex rectangle is 1 facet; a 12-vertex L is ~4-5.
        segmentCount: solar?.segmentCount ?? polygonVertexComplexity(activePolygons),
        segmentPolygonsLatLng: activePolygons,
      }),
    [assumptions, addOns, solar, activePolygons],
  );

  const lengths = useMemo(() => {
    const polys = activePolygons;
    const complexity = assumptions.complexity ?? "moderate";
    if (polys && polys.length > 1) {
      const pitchDegrees =
        ({ "4/12": 18.43, "5/12": 22.62, "6/12": 26.57, "7/12": 30.26, "8/12+": 35.0 } as const)[
          assumptions.pitch
        ];
      return deriveRoofLengthsFromPolygons({
        polygons: polys,
        pitchDegrees,
        complexity,
      });
    }
    return deriveRoofLengthsHeuristic({
      totalRoofSqft: assumptions.sqft,
      buildingFootprintSqft: solar?.buildingFootprintSqft ?? null,
      segmentCount: solar?.segmentCount ?? polygonVertexComplexity(activePolygons),
      complexity,
      pitch: assumptions.pitch,
    });
  }, [assumptions, solar, activePolygons]);

  const waste = useMemo(
    () => buildWasteTable(assumptions.sqft, assumptions.complexity ?? "moderate"),
    [assumptions.sqft, assumptions.complexity],
  );

  const runEstimate = async (explicitAddr?: AddressInfo) => {
    // Accept an explicit address from the autocomplete pick so we don't
    // race with React state. Falls back to current state for the
    // Estimate-button / Enter-key paths.
    const addr: AddressInfo =
      explicitAddr ?? address ?? { formatted: addressText.trim() };
    if (!addr.formatted?.trim()) return;
    setAddress(addr);
    setShown(true);
    setSolar(null);
    setVision(null);
    setVisionError("");
    setOsmBuildingPolygon(null);
    setSamRefinedPolygon(null);
    setSolarMaskPolygon(null);
    setLivePolygons(null);
    hasUserEditedRef.current = false;

    if (addr.lat == null || addr.lng == null) {
      setAssumptions((a) => ({
        ...a,
        sqft: a.sqft || estimateRoofSize(),
        ageYears: a.ageYears || estimateAge(),
      }));
      return;
    }

    setVisionLoading(true);
    const solarPromise = fetch(`/api/solar?lat=${addr.lat}&lng=${addr.lng}`)
      .then(async (r) => (r.ok ? ((await r.json()) as SolarSummary) : null))
      .catch(() => null);

    const visionPromise = fetch(`/api/vision?lat=${addr.lat}&lng=${addr.lng}`)
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || `vision_${r.status}`);
        }
        return (await r.json()) as RoofVision;
      })
      .catch((err) => {
        setVisionError(err instanceof Error ? err.message : "failed");
        return null;
      });

    // OSM building footprint — ground truth from human-traced data when
    // available. Runs in parallel with solar + vision. Cheap (free public
    // API) and short-circuits the need to trust an AI polygon for the
    // ~50-60% of US residential properties OSM has data on.
    const osmPromise = fetch(`/api/building?lat=${addr.lat}&lng=${addr.lng}`)
      .then(async (r) => {
        if (!r.ok) return null;
        const data = (await r.json()) as {
          latLng?: Array<{ lat: number; lng: number }>;
        };
        return data.latLng && data.latLng.length >= 3 ? data.latLng : null;
      })
      .catch(() => null);

    // Solar mask (Project Sunroof's roof segmentation) — runs in parallel
    // with everything else. Free tier of Solar covers most US/EU/JP/AU.
    // When available, this is the highest-quality polygon source we have.
    const solarMaskPromise = fetch(`/api/solar-mask?lat=${addr.lat}&lng=${addr.lng}`)
      .then(async (r) => {
        if (!r.ok) return null;
        const data = (await r.json()) as {
          latLng?: Array<{ lat: number; lng: number }>;
        };
        return data.latLng && data.latLng.length >= 3 ? data.latLng : null;
      })
      .catch(() => null);

    // Roboflow Hosted Inference (Satellite Rooftop Map v3) — fires in parallel
    // with everything else. ~1-2s latency. Slots between Solar mask and SAM
    // in the priority chain — beats SAM/OSM/Claude on most addresses thanks
    // to roof-specific training, but Solar mask wins when both available
    // because Solar is photogrammetric ground truth.
    const roboflowPromise = fetch(`/api/roboflow?lat=${addr.lat}&lng=${addr.lng}`)
      .then(async (r) => {
        if (!r.ok) return null;
        const data = (await r.json()) as {
          polygon?: Array<{ lat: number; lng: number }>;
        };
        return data.polygon && data.polygon.length >= 3 ? data.polygon : null;
      })
      .catch(() => null);

    // Microsoft Building Footprints — open-data ML-extracted building outlines,
    // pre-extracted for the Nashville metro bbox (see lib/microsoft-buildings.ts).
    // Fills the OSM coverage gap on rural addresses. Returns null outside the
    // pre-extracted bbox (so this is a noop for non-TN addresses for now).
    const msBuildingPromise = fetch(`/api/microsoft-building?lat=${addr.lat}&lng=${addr.lng}`)
      .then(async (r) => {
        if (!r.ok) return null;
        const data = (await r.json()) as {
          polygon?: Array<{ lat: number; lng: number }>;
        };
        return data.polygon && data.polygon.length >= 3 ? data.polygon : null;
      })
      .catch(() => null);

    // Compound-pipeline SAM refinement — fires in parallel with everything
    // else. ~5-10s latency on Replicate so the cheaper sources show first
    // and SAM "snaps" the polygon tighter when it returns.
    setSamRefining(true);
    const samPromise = fetch("/api/sam-refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: addr.lat, lng: addr.lng }),
    })
      .then(async (r) => {
        if (!r.ok) return null;
        const data = (await r.json()) as {
          polygon?: Array<{ lat: number; lng: number }>;
        };
        return data.polygon && data.polygon.length >= 3 ? data.polygon : null;
      })
      .catch(() => null);

    const [solarData, visionData, osmData] = await Promise.all([
      solarPromise,
      visionPromise,
      osmPromise,
    ]);

    if (solarData) setSolar(solarData);
    if (visionData) setVision(visionData);
    if (osmData) setOsmBuildingPolygon(osmData);
    setVisionLoading(false);

    // Don't await SAM in the main critical path — it's a "snap to tighter"
    // upgrade. Wire its result whenever it lands.
    samPromise
      .then((samPoly) => {
        // Don't stomp in-progress edits: if the rep has already moved a
        // vertex on the OSM/Claude polygon, keep their work and silently
        // discard the SAM refinement.
        if (samPoly && !hasUserEditedRef.current) setSamRefinedPolygon(samPoly);
      })
      .finally(() => setSamRefining(false));

    // Solar mask is one of the top-priority sources — same edit-stomp guard.
    solarMaskPromise.then((maskPoly) => {
      if (maskPoly && !hasUserEditedRef.current) setSolarMaskPolygon(maskPoly);
    });

    // Roboflow — same edit-stomp guard. When this returns, the priority
    // chain in `polygonSource` decides whether it wins (it does when
    // Solar mask is unavailable / 3D Tiles haven't loaded yet).
    roboflowPromise.then((rfPoly) => {
      if (rfPoly && !hasUserEditedRef.current) setRoboflowPolygon(rfPoly);
    });

    // MS Building Footprints — same edit-stomp guard.
    msBuildingPromise.then((msPoly) => {
      if (msPoly && !hasUserEditedRef.current) setMsBuildingPolygon(msPoly);
    });

    setAssumptions((a) => {
      const next: Assumptions = { ...a };
      if (solarData?.sqft) next.sqft = solarData.sqft;
      if (solarData?.pitch) next.pitch = solarData.pitch;
      if (visionData && visionData.confidence >= 0.5) {
        const matMap = VISION_MATERIAL_TO_ASSUMPTION[visionData.currentMaterial];
        if (matMap) next.material = matMap;
        if (visionData.estimatedAgeYears) next.ageYears = visionData.estimatedAgeYears;
        next.complexity = visionData.complexity;
      }
      if (!next.sqft) next.sqft = estimateRoofSize();
      if (!next.ageYears) next.ageYears = estimateAge();
      return next;
    });
  };

  const enabledAddOns = addOns.filter((a) => a.enabled).reduce((s, x) => s + x.price, 0);
  const estimate: Estimate = {
    id: estimateId,
    createdAt: new Date().toISOString(),
    staff,
    customerName,
    notes,
    address: address ?? { formatted: addressText },
    assumptions,
    addOns,
    total,
    baseLow: Math.round(low + enabledAddOns),
    baseHigh: Math.round(high + enabledAddOns),
    isInsuranceClaim,
    vision: vision ?? undefined,
    solar: solar ?? undefined,
    detailed,
    lengths,
    waste,
    polygons: activePolygons ?? undefined,
    polygonSource: polygonSource === "none" ? undefined : polygonSource,
    photos: photos.length ? photos : undefined,
    claim: isInsuranceClaim ? claim : undefined,
  };

  const applyTier = (tier: ProposalTier) => {
    setAssumptions((a) => ({ ...a, material: tier.material }));
    setAddOns((cur) => cur.map((x) => ({ ...x, enabled: tier.includedAddOnIds.includes(x.id) })));
  };

  useKeyboardShortcuts({
    onSave: () => shown && saveEstimate(estimate),
    onPdf: () => shown && generatePdf(estimate),
    onEmail: () => {
      if (!shown) return;
      const subject = encodeURIComponent(`Roofing Estimate — ${estimate.address.formatted}`);
      const body = encodeURIComponent(buildSummaryText(estimate));
      window.location.href = `mailto:?subject=${subject}&body=${body}`;
    },
    onNew: () => reset(),
    onFocusAddress: () => {
      const el = document.querySelector<HTMLInputElement>("input[placeholder*='Main Street']");
      el?.focus();
    },
  });

  const reset = () => {
    setAddressText("");
    setAddress(null);
    setAssumptions(DEFAULT_ASSUMPTIONS);
    setAddOns(DEFAULT_ADDONS);
    setCustomerName("");
    setNotes("");
    setEstimateId(newId());
    setShown(false);
    setSolar(null);
    setVision(null);
    setVisionError("");
    setIsInsuranceClaim(false);
    setPhotos([]);
    setClaim({ carrier: "state-farm" });
    setLivePolygons(null);
    setOsmBuildingPolygon(null);
    setSamRefinedPolygon(null);
    setSolarMaskPolygon(null);
    setRoboflowPolygon(null);
    setMsBuildingPolygon(null);
    setClaudeVerifications({});
    hasUserEditedRef.current = false;
  };

  const mapBadges = (() => {
    const badges: string[] = [];
    if (solar?.imageryDate) badges.push(`Imagery ${solar.imageryDate}`);
    if (solar && solar.imageryQuality !== "UNKNOWN") badges.push(`Quality ${solar.imageryQuality}`);
    if (polygonSource === "edited") badges.push("Edited");
    else if (polygonSource === "tiles3d") badges.push("3D mesh");
    else if (polygonSource === "solar-mask") badges.push("Solar mask");
    else if (polygonSource === "roboflow") badges.push("Roof AI");
    else if (polygonSource === "sam") badges.push("SAM 2 refined");
    else if (polygonSource === "osm") badges.push("OSM traced");
    else if (polygonSource === "microsoft-buildings") badges.push("MS Footprints");
    else if (polygonSource === "ai") badges.push("AI traced");
    else if (samRefining) badges.push("Refining…");
    else if (solar?.segmentCount && solar.segmentCount > 0) badges.push(`${solar.segmentCount} segments`);
    if (solar?.pitch) badges.push(`Pitch ${solar.pitch}`);
    // Confidence indicator — lets the rep tell at a glance whether the
    // outline is well-supported (multiple sources agreed + Claude
    // verified) or whether they should manually double-check it.
    if (polygonReady && polygonSource !== "none") {
      const lvl = estimateConfidence.level;
      const marker = lvl === "high" ? "✓" : lvl === "moderate" ? "△" : "⚠";
      const label = lvl === "high" ? "High conf" : lvl === "moderate" ? "Moderate conf" : "Low conf — review";
      badges.push(`${marker} ${label}`);
    }
    return badges;
  })();

  return (
    <div className="space-y-8 sm:space-y-10">
      {/* ─── Hero / address bar ─────────────────────────────────────── */}
      {/* No overflow-hidden here so the autocomplete dropdown can extend
          past the section's bottom edge. The gradient blob below uses
          isolation: isolate to keep its rounded-3xl clipping local. */}
      <section
        className="glass-strong rounded-3xl p-5 sm:p-7 md:p-9 relative"
        style={{ isolation: "isolate" }}
      >
        <div
          className="absolute -top-32 -right-24 w-[420px] h-[420px] rounded-full blur-3xl pointer-events-none opacity-50 -z-10"
          style={{ background: "radial-gradient(closest-side, rgba(103,220,255,0.18), transparent)" }}
        />
        <div className="relative flex items-end justify-between gap-6 mb-6 flex-wrap">
          <div className="flex items-end gap-3">
            <div className="chip chip-accent">
              <Zap size={11} /> Quick Estimate
            </div>
            <div className="hidden md:flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-slate-300">
              <span>address</span>
              <span className="w-3 h-px bg-slate-400/60" />
              <span>analyze</span>
              <span className="w-3 h-px bg-slate-400/60" />
              <span>review</span>
              <span className="w-3 h-px bg-slate-400/60" />
              <span className="text-cy-300 font-semibold">deliver</span>
            </div>
          </div>
          <div className="flex items-stretch gap-2 w-full sm:w-auto">
            <input
              className="input flex-1 sm:flex-none sm:w-44 text-[13px]"
              placeholder="Your name"
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
            />
            {shown && (
              <button
                onClick={reset}
                className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 rounded-[0.7rem] border border-white/[0.075] bg-black/30 text-slate-200 text-[13px] font-medium tracking-tight transition hover:border-white/[0.18] hover:bg-black/40"
              >
                <RotateCcw size={13} />
                <span className="hidden sm:inline">New</span>
              </button>
            )}
          </div>
        </div>

        <h1 className="font-display text-[28px] sm:text-4xl md:text-[44px] leading-[1.05] tracking-tight font-medium mb-1.5">
          Where are we{" "}
          <span className="bg-gradient-to-r from-cy-300 via-cy-400 to-mint bg-clip-text text-transparent">
            roofing
          </span>{" "}
          today?
        </h1>
        <p className="text-[13.5px] text-slate-400 mb-6 max-w-xl">
          Type or paste an address. Pick a suggestion — Pitch auto-measures and assesses the roof.
        </p>

        <AddressInput
          value={addressText}
          onChange={setAddressText}
          onSelect={setAddress}
          onSubmit={runEstimate}
        />
      </section>

      {!shown && <EmptyState />}

      {/* ─── Quantum-pulse loader: full-screen overlay while Solar+Vision run ─── */}
      {visionLoading && (
        <div
          // No backdrop-blur — the filter forces full-page recomposite every
          // frame, which thrashes against Cesium's WebGL canvas underneath
          // and made the loader animation visibly stutter. A solid fill at
          // 88% darkness reads almost the same and stays smooth.
          className="fixed inset-0 z-50 flex items-center justify-center float-in"
          style={{ background: "rgba(7,9,13,0.88)" }}
          aria-live="polite"
        >
          <QuantumPulseLoader text="Generating" />
        </div>
      )}

      {shown && (
        <>
          {/* ═══ 01 PROPERTY — satellite + photogrammetric 3D ═══════════ */}
          <SectionHeader
            index={1}
            title="Property"
            caption={address?.formatted}
            trailing={
              solar?.imageryDate && (
                <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slate-500">
                  Imagery {solar.imageryDate}
                </span>
              )
            }
          />
          {/* ─── Map hero — satellite + 3D side-by-side, full width ─────── */}
          <section className="grid lg:grid-cols-2 gap-4 h-[420px] sm:h-[520px] lg:h-[640px] float-in relative">
            {/* Generating overlay — covers BOTH viewers when verifying so
                the rep doesn't see polygon flicker as sources race. Hidden
                once Claude multi-view verifies the active polygon. */}
            {verifying && (
              <div
                className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none"
                aria-live="polite"
              >
                <div className="flex items-center gap-2.5 rounded-full border border-cy-300/40 bg-[#07090d]/90 backdrop-blur-md px-5 py-2 shadow-2xl shadow-cy-300/20">
                  <span className="font-mono text-[12px] uppercase tracking-[0.16em] text-cy-100">
                    Generating roof outline<span className="generating-dots" />
                  </span>
                </div>
              </div>
            )}
            <MapView
              lat={address?.lat}
              lng={address?.lng}
              address={address?.formatted}
              segments={renderedSourcePolygons}
              // Penetration markers (numbered yellow circles for vents,
              // chimneys, skylights) hidden from the rep-facing map per
              // user feedback — they cluttered the view without adding
              // sales value and reps confused them with the polygon
              // outline. Vision still detects them server-side and the
              // detailed estimate uses them for vent/flashing line items;
              // we just don't render the markers on the satellite tile.
              penetrations={undefined}
              metaBadges={mapBadges}
              editable={polygonReady && polygonSource !== "none"}
              onPolygonsChanged={handlePolygonsChanged}
              pitchDegrees={solar?.pitchDegrees ?? null}
            />
            {/* Defer mounting Cesium until generation finishes. Cesium's
              * first-paint downloads global tiles + builds a heavy octree
              * for raycasting; doing that while the QuantumPulseLoader is
              * on screen starves the GPU and visibly stutters the loader
              * animation. Mounting after loading puts the cost on a fresh
              * frame instead of competing with it. */}
            {address?.lat != null && address?.lng != null && !visionLoading && (
              <Roof3DViewer
                // key forces a hard remount on every address change so the
                // previous house's Cesium camera/tiles can't linger.
                key={`${address.lat.toFixed(6)},${address.lng.toFixed(6)}`}
                lat={address.lat}
                lng={address.lng}
                address={address.formatted}
                // Always pass polygons so the multi-view verify effect can
                // fire. The polygon outline stays HIDDEN until polygonReady
                // (verified) — see `polygonsHidden` prop.
                polygons={activePolygons}
                polygonSource={polygonSource === "none" ? undefined : polygonSource}
                polygonsHidden={!polygonReady}
                expectedFootprintSqft={referenceFootprintSqft}
                imageryDate={solar?.imageryDate ?? null}
                onMultiViewVerified={(result) => {
                  if (!polygonSource || polygonSource === "none") return;
                  setClaudeVerifications((cur) => ({
                    ...cur,
                    [polygonSource]: result,
                  }));
                }}
              />
            )}
          </section>

          {/* ═══ 02 ROOF GEOMETRY — parametric framing + blueprint ═════ */}
          {polygonReady && activePolygons && activePolygons.length > 0 && (
            <SectionHeader
              index={2}
              title="Roof geometry"
              caption={`${assumptions.sqft.toLocaleString()} sf · ${assumptions.pitch}`}
            />
          )}

          {/* ─── Parametric 3D roof framing (gables, ridges, eaves, rakes) ─
                Hidden until polygonReady so the framing doesn't keep
                redrawing as the polygon flickers between sources. */}
          {polygonReady && activePolygons && activePolygons.length > 0 && (
            <ErrorBoundary>
              <ParametricRoofViewer
                polygon={activePolygons[0]}
                pitch={assumptions.pitch}
              />
            </ErrorBoundary>
          )}

          {/* ─── Architectural blueprint of the traced roof ─────────────── */}
          {polygonReady && activePolygons && activePolygons.length > 0 && (
            <RoofBlueprint
              polygons={activePolygons}
              editing={polygonSource === "edited"}
              pitchDegrees={solar?.pitchDegrees ?? null}
              address={address?.formatted}
              pitchLabel={assumptions.pitch}
              sourceLabel={
                polygonSource === "tiles3d"
                  ? "3D mesh"
                  : polygonSource === "solar-mask"
                    ? "Solar mask"
                    : polygonSource === "roboflow"
                      ? "Roof AI"
                      : polygonSource === "solar"
                        ? `Solar · ${activePolygons.length} ${activePolygons.length === 1 ? "facet" : "facets"}`
                        : polygonSource === "sam"
                          ? "SAM 2 refined"
                          : polygonSource === "osm"
                            ? "OSM traced"
                            : polygonSource === "microsoft-buildings"
                              ? "MS Footprints"
                              : polygonSource === "ai"
                                ? "AI traced"
                                : polygonSource === "edited"
                                  ? "Edited by hand"
                                  : undefined
              }
            />
          )}

          {/* ═══ 03 QUALITY & COMPLIANCE ═══════════════════════════════ */}
          {/* Section header only when there's actually something to show
              (carrier claim, storm correlation, outline warning, or size
              mismatch). Otherwise we'd render a "03 Quality" header above
              an empty region. */}
          {(isInsuranceClaim ||
            (polygonReady && polygonSource !== "none")) && (
            <SectionHeader
              index={3}
              title="Quality & compliance"
              caption="Auto-checks before delivery"
            />
          )}

          {/* ─── Carrier-specific claim metadata (insurance mode only) ─── */}
          {isInsuranceClaim && (
            <CarrierClaimPanel context={claim} onChange={setClaim} />
          )}

          {/* ─── Imagery × storm correlation (multi-temporal) ──────────── */}
          <ImageryStormBanner
            imageryDate={solar?.imageryDate ?? null}
            lat={address?.lat}
            lng={address?.lng}
          />

          {/* ─── Outline accuracy warning — surfaces low / moderate
                confidence + Claude's specific issues to the rep so they
                know what to check. Hidden when high-confidence. */}
          {polygonReady && polygonSource !== "none" && (
            <OutlineQualityWarning
              level={estimateConfidence.level}
              rationale={estimateConfidence.rationale}
              issues={
                polygonSource && claudeVerifications[polygonSource]?.issues
                  ? (claudeVerifications[polygonSource]!.issues ?? [])
                  : []
              }
              sourceLabel={
                polygonSource === "solar-mask"
                  ? "Solar mask"
                  : polygonSource === "roboflow"
                    ? "Roof AI"
                    : polygonSource === "sam"
                      ? "SAM 2"
                      : polygonSource === "osm"
                        ? "OSM"
                        : polygonSource === "microsoft-buildings"
                          ? "MS Footprints"
                          : polygonSource === "ai"
                            ? "Claude vision"
                            : polygonSource === "solar"
                              ? "Solar facets"
                              : polygonSource === "edited"
                                ? "Edited"
                                : undefined
              }
              onManualEdit={() => {
                const map = document.querySelector(".gm-style");
                map?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            />
          )}

          {/* ─── Polygon size sanity check ──────────────────────────────── */}
          <PolygonSizeWarning
            detectedSqft={assumptions.sqft}
            solarFootprintSqft={solar?.buildingFootprintSqft ?? null}
            pitchDegrees={solar?.pitchDegrees ?? null}
            onAcceptSuggestion={(sqft) =>
              setAssumptions((a) => ({ ...a, sqft }))
            }
            onManualEdit={() => {
              const el = document.querySelector<HTMLInputElement>(
                'input[type="number"]',
              );
              el?.focus();
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          />

          {/* ═══ 04 ESTIMATE — headline price + breakdown ═══════════════ */}
          <SectionHeader
            index={4}
            title="Estimate"
            caption={`${assumptions.material.replace(/-/g, " ")}${assumptions.serviceType ? ` · ${assumptions.serviceType.replace(/-/g, " ")}` : ""}`}
          />

          {/* ─── Headline price card — full width ──────────────────────── */}
          <ErrorBoundary>
            <ResultsPanel
              address={estimate.address}
              assumptions={assumptions}
              total={total}
              baseLow={estimate.baseLow}
              baseHigh={estimate.baseHigh}
              isInsuranceClaim={isInsuranceClaim}
              onInsuranceChange={setIsInsuranceClaim}
            />
          </ErrorBoundary>

          {/* ═══ 05 BREAKDOWN — line items, measurements, customer detail ═ */}
          <SectionHeader
            index={5}
            title="Breakdown & detail"
            caption="Internal worksheet · not shown to customer"
          />

          {/* ─── Two-col grid for everything else ─────────────────────── */}
          <div className="grid lg:grid-cols-3 gap-6 float-in">
            <div className="lg:col-span-2 space-y-6">
              <VisionPanel
                vision={vision}
                loading={visionLoading}
                error={visionError}
                ageYears={assumptions.ageYears}
                zip={address?.zip}
              />
              <TiersPanel assumptions={assumptions} addOns={addOns} onApplyTier={applyTier} />
              <MeasurementsPanel
                lengths={lengths}
                waste={waste}
                defaultOpen={isInsuranceClaim || BRAND_CONFIG.showXactimateCodes}
              />
              <LineItemsPanel
                detailed={detailed}
                defaultOpen={isInsuranceClaim || BRAND_CONFIG.showXactimateCodes}
                alwaysShowXactimate={isInsuranceClaim || BRAND_CONFIG.showXactimateCodes}
              />
              <div className="grid md:grid-cols-2 gap-6">
                <AssumptionsEditor value={assumptions} onChange={setAssumptions} />
                <AddOnsPanel addOns={addOns} onChange={setAddOns} />
              </div>
            </div>
            <div className="space-y-6">
              <PropertyContextPanel address={address} />
              <StormHistoryCard lat={address?.lat} lng={address?.lng} />
              <PhotoUploadPanel photos={photos} onChange={setPhotos} />
              <div className="glass rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-display font-semibold tracking-tight">Customer & Notes</div>
                  <span className="label">internal only</span>
                </div>
                <input
                  className="input"
                  placeholder="Customer name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
                <textarea
                  className="input"
                  placeholder="Notes…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <div className="glass rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-display font-semibold tracking-tight">Output</div>
                  <span className="label">deliver</span>
                </div>
                <OutputButtons estimate={estimate} />
              </div>
              <InsightsPanel estimate={estimate} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  const tips = [
    {
      icon: <Sparkles size={14} className="text-cy-300" />,
      title: "Auto-measure on address pick",
      body: "Roof size, pitch, material, complexity — measured and assessed by Pitch in seconds.",
    },
    {
      icon: <Plus size={14} className="text-mint" />,
      title: "Tweak anything, total updates live",
      body: "Material, complexity, multipliers, add-ons — recompute instantly with smooth animation.",
    },
    {
      icon: <Zap size={14} className="text-amber" />,
      title: "Press ↵ to estimate",
      body: "Or click a suggestion. Fastest path: type, ↓, ↵.",
    },
  ];
  return (
    <section className="grid md:grid-cols-3 gap-4">
      {tips.map((t, i) => (
        <div
          key={t.title}
          className="glass rounded-2xl p-5 card-hover float-in"
          style={{ animationDelay: `${i * 70}ms` }}
        >
          <div className="flex items-center gap-2 mb-2">
            {t.icon}
            <span className="label">tip 0{i + 1}</span>
          </div>
          <div className="font-display font-medium tracking-tight text-[15px] mb-1">
            {t.title}
          </div>
          <div className="text-[13px] text-slate-400 leading-relaxed">{t.body}</div>
        </div>
      ))}
    </section>
  );
}

/**
 * Map a single-polygon source's vertex count to a "Solar-equivalent" segment
 * count for the line-item / lengths heuristics. A 4-vertex rectangle is one
 * gable; an 8-vertex L is roughly two gables; complex multi-bay houses with
 * 12+ vertices behave like 4-5 facets. Returns 4 (the heuristic default) when
 * we have nothing.
 */
function polygonVertexComplexity(
  polys: Array<Array<{ lat: number; lng: number }>> | undefined,
): number {
  if (!polys || polys.length === 0) return 4;
  if (polys.length > 1) return polys.length;
  const poly = polys[0];
  if (poly.length < 4) return 2;

  // Count REFLEX vertices (interior angle > 180°). Each reflex vertex
  // marks a junction between two distinct roof sections — an L-shape has
  // one reflex vertex (where the L bends), a T-shape has two, etc.
  // Reflex count is a much better "number of wings" signal than raw
  // vertex count, which gets confused by jagged segmentation noise.
  // Project to local meters around centroid for stable cross-products.
  let cLat = 0;
  for (const p of poly) cLat += p.lat;
  cLat /= poly.length;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const pts = poly.map((p) => ({
    x: p.lng * 111_320 * cosLat,
    y: p.lat * 111_320,
  }));
  // Polygon orientation via signed shoelace (positive = CCW in this
  // x-east / y-north frame).
  let signedArea2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    signedArea2 += a.x * b.y - b.x * a.y;
  }
  const ccw = signedArea2 > 0;
  let reflex = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[(i - 1 + pts.length) % pts.length];
    const cur = pts[i];
    const next = pts[(i + 1) % pts.length];
    const cross =
      (cur.x - prev.x) * (next.y - cur.y) -
      (cur.y - prev.y) * (next.x - cur.x);
    // For a CCW polygon, convex turns are positive cross. Reflex = sign
    // opposite to orientation. (And reverse for CW.)
    const isReflex = ccw ? cross < 0 : cross > 0;
    if (isReflex) reflex++;
  }
  // Approximate segment count: each "wing" (one reflex separation)
  // typically contributes ~2 roof facets (front + back). So segments
  // ≈ 2 × (reflex + 1). Bounded between 2 (simple gable) and 8.
  const segments = 2 * (reflex + 1);
  return Math.max(2, Math.min(8, segments));
}

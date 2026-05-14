"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

// 3D viewer is heavy (Cesium + Map Tiles 3D bundle ≈ 1.2 MB gzipped)
// — lazy-load it so the initial render of the internal page isn't
// blocked. ssr:false because Cesium relies on the WebGL canvas
// which doesn't exist server-side.
//
// Re-added 2026-05-13 after the vision-based primary-residence
// detection landed in /api/sam3-roof. The viewer was originally
// removed because rural FL properties with outbuildings consistently
// highlighted the wrong structure (the geocoded pin's closest
// building rather than the addressed residence). With Claude vision
// now identifying the residence semantically and SAM3 tracing it
// from there, the 3D mesh draping is anchored on the right building
// — and the photorealistic view is a real differentiator for reps
// showing storm damage to homeowners on tablets in the field.
const Roof3DViewer = dynamic(() => import("@/components/Roof3DViewer"), {
  ssr: false,
});
import AddressInput from "@/components/AddressInput";
import AssumptionsEditor from "@/components/AssumptionsEditor";
import AddOnsPanel from "@/components/AddOnsPanel";
import ResultsPanel from "@/components/ResultsPanel";
import EstimateSticky from "@/components/EstimateSticky";
import OutputButtons from "@/components/OutputButtons";
import MapView from "@/components/MapView";
import InsightsPanel from "@/components/InsightsPanel";
import PropertyContextPanel from "@/components/PropertyContextPanel";
import StormHistoryCard from "@/components/StormHistoryCard";
import LineItemsPanel from "@/components/LineItemsPanel";
import TiersPanel from "@/components/TiersPanel";
import MeasurementsPanel from "@/components/MeasurementsPanel";
import SectionHeader from "@/components/SectionHeader";
import PhotoUploadPanel from "@/components/PhotoUploadPanel";
import ImageryStormBanner from "@/components/ImageryStormBanner";
import VoiceNoteRecorder, { type VoiceNoteResult } from "@/components/VoiceNoteRecorder";
import CarrierClaimPanel from "@/components/CarrierClaimPanel";
import SupplementAnalyzerPanel from "@/components/SupplementAnalyzerPanel";
import type { PhotoMeta } from "@/types/photo";
import type { ClaimContext } from "@/lib/carriers";
import { QuantumPulseLoader } from "@/components/ui/quantum-pulse-loader";
import ErrorBoundary from "@/components/ErrorBoundary";
import { useKeyboardShortcuts } from "@/lib/useKeyboardShortcuts";
import { generatePdf, buildSummaryText } from "@/lib/pdf";
import { saveEstimate } from "@/lib/storage";
import type { ProposalTier } from "@/lib/tiers";
import type {
  AddOn,
  AddressInfo,
  Assumptions,
  DetailedEstimate,
  Estimate,
  RoofVision,
  SolarSummary,
} from "@/types/estimate";
import type {
  EdgeType,
  PricedEstimate,
  PricingInputs,
  RoofData,
} from "@/types/roof";
import { priceRoofData } from "@/lib/roof-engine";
import { DEFAULT_ADDONS, computeBase, computeTotal } from "@/lib/pricing";
import {
  buildWasteTable,
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

/**
 * The actual rep tool. Wrapped in <Suspense> by the default export
 * below because it synchronously calls `useSearchParams()` to read the
 * `?office=<slug>` tenancy param at the top of the component. Per
 * Next.js 16, any Client Component that synchronously reads search
 * params during render forces a CSR bailout — the prerender pass throws
 * unless a <Suspense> boundary exists above the useSearchParams call.
 *
 * Setting `export const dynamic = "force-dynamic"` does NOT fix this
 * (that directive is only respected on Server Component pages — on a
 * "use client" page it's silently ignored). The wrapper pattern is the
 * canonical fix.
 */
function HomePageInner() {
  // Tenancy — which business this rep is working under. Until staff
  // auth is wired through (Supabase JWT), reps bookmark `/?office=nolands`
  // for their company. Defaults to "nolands" — the only live customer
  // today — so bare visits still save under the right tenant.
  const searchParams = useSearchParams();
  const office = (searchParams.get("office") ?? "nolands").trim().toLowerCase();
  // `?nocache=1` URL param — debug toggle so the rep can force a
  // fresh SAM3 round-trip during the demo (bypasses the Redis cache
  // for the resolved polygon). Forwarded as a query suffix to the
  // /api/sam3-roof fetch below; the route's `noCache` handling already
  // exists, this just plumbs the front-end toggle through.
  const sam3NoCacheSuffix =
    searchParams.get("nocache") === "1" ? "&nocache=1" : "";
  const [addressText, setAddressText] = useState("");
  const [address, setAddress] = useState<AddressInfo | null>(null);
  const [assumptions, setAssumptions] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [addOns, setAddOns] = useState<AddOn[]>(DEFAULT_ADDONS);
  const [staff, setStaff] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [notes, setNotes] = useState("");
  const [estimateId, setEstimateId] = useState<string>(newId());
  const [shown, setShown] = useState(false);
  // Breakdown section tabs — the rep workbench used to render 11 panels
  // stacked vertically, which made the page feel endless. Tabbing groups
  // them into 3 logical workflows so only ~3-4 panels are visible at any
  // time. Default is "numbers" because that's where reps land after the
  // headline price card.
  const [breakdownTab, setBreakdownTab] = useState<
    "numbers" | "measurements" | "delivery"
  >("numbers");

  const [solar, setSolar] = useState<SolarSummary | null>(null);
  const [vision, setVision] = useState<RoofVision | null>(null);
  const [visionLoading, setVisionLoading] = useState(false);
  const [, setVisionError] = useState<string>("");

  // ─── Tier C unified pipeline result ──────────────────────────────────
  // Parallel fetch to /api/roof-pipeline that returns a canonical RoofData
  // feed. When present, drives priceRoofData (new engine); when null /
  // degraded, the page falls back to the legacy computeBase/computeTotal
  // headline. Mirrors /internal page's pattern with a fetch-generation
  // token to drop out-of-order responses on rapid address switching.
  const [roofData, setRoofData] = useState<RoofData | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const fetchGenRef = useRef(0);
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
  // `samRefining` flag removed — the legacy SAM2 (sam-refine) refining
  // step was deprecated in favor of custom SAM3. The state slot
  // `samRefinedPolygon` above is kept as a passive emergency-rollback
  // hook (see Phase 1 cleanup notes below).
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
  // Custom SAM3 (Roboflow Workflow) with server-side GIS-footprint
  // reconciliation. Sits at the top of the priority chain when available —
  // trained on our service-area imagery, so it consistently outperforms
  // the off-the-shelf Roboflow Satellite Rooftop Map and Solar mask on
  // properties where Solar's photogrammetry has gaps. The route handles
  // tree occlusion / wrong-building substitution before returning.
  const [sam3Polygon, setSam3Polygon] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  // SAM3 in-flight gate. While `sam3InFlight === true`, the polygon
  // priority chain returns "none" regardless of what MS Buildings, OSM,
  // or Solar mask have returned. This eliminates the visual flicker
  // where a fast-resolving fallback (MS Buildings ~100ms, OSM ~1.5s)
  // renders a polygon over the satellite tile, only to get replaced
  // 5-30 seconds later when SAM3 finishes. Reps were seeing the wrong
  // polygon during the cold-start window and assuming SAM3 had failed.
  //
  // The "Generating measurement…" overlay stays visible until SAM3
  // settles — either succeeds (its polygon wins the priority chain)
  // or fails (404 / kill switch / network error → fallback chain runs).
  // Set true at the start of every loadAddress fetch, set false in the
  // .then() of the sam3Promise regardless of outcome.
  const [sam3InFlight, setSam3InFlight] = useState<boolean>(false);
  // Reconciler source from /api/sam3-roof. When SAM3's raw output gets
  // substituted with the GIS wall footprint (occluded by tree canopy,
  // catastrophic centroid drift, area-ratio gate fail), the returned
  // polygon traces walls, not eaves — so it needs the 1.06 overhang
  // multiplier applied to roof-material sqft. "sam3" / "sam3-no-footprint"
  // mean the polygon traces eaves directly and no multiplier applies.
  const [sam3Source, setSam3Source] = useState<
    "sam3" | "footprint-only" | "footprint-occluded" | "sam3-no-footprint" | null
  >(null);
  // "Pick the right building" mode — when the auto-detection picks the
  // wrong building on a multi-structure rural parcel, the rep toggles
  // this on and clicks the actual house on the satellite tile. We then
  // re-call SAM3 with ?clickLat=&clickLng= override and update the
  // polygon with the result.
  const [pickingBuilding, setPickingBuilding] = useState(false);
  const [pickingLoading, setPickingLoading] = useState(false);
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
  // Ref mirror of `isWallFootprintSource`, updated by a useEffect below
  // (the derived value depends on polygonSource which is declared later
  // in the component, so we can't read it directly from this callback).
  // Captures whether the polygon being edited originated from a wall-
  // footprint source (MS Buildings, OSM, or SAM3 reconciler substitution).
  // Once livePolygons is set, `polygonSource` flips to "edited" and we
  // lose track of what the polygon was *traced from* — but the rep's
  // edits still describe walls, so the 1.06 overhang still applies.
  const isWallFootprintSourceRef = useRef<boolean>(false);
  // Frozen at first edit; cleared on runEstimate / reset.
  const editOriginIsWallFootprintRef = useRef<boolean>(false);
  const handlePolygonsChanged = useCallback(
    (polys: Array<Array<{ lat: number; lng: number }>>) => {
      if (!hasUserEditedRef.current) {
        // First edit — capture whether the source we're editing FROM
        // traces walls (so 1.06 keeps applying as the rep nudges).
        editOriginIsWallFootprintRef.current = isWallFootprintSourceRef.current;
      }
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

  // ─── Tier C pricing — priceRoofData when roofData is available,
  // otherwise the legacy sqft × $/sf fallback so the headline still
  // renders while the rep types the address and the pipeline is in
  // flight (or degraded).
  const pricingInputs = useMemo<PricingInputs>(
    () => ({
      material: assumptions.material,
      materialMultiplier: assumptions.materialMultiplier,
      laborMultiplier: assumptions.laborMultiplier,
      serviceType: assumptions.serviceType ?? "reroof-tearoff",
      addOns,
      wasteOverridePct: undefined,
      isInsuranceClaim,
    }),
    [assumptions, addOns, isInsuranceClaim],
  );

  const priced = useMemo<PricedEstimate | null>(() => {
    if (!roofData || roofData.source === "none") return null;
    return priceRoofData(roofData, pricingInputs);
  }, [roofData, pricingInputs]);

  const { low, high } = useMemo(() => {
    if (priced) {
      return { low: Math.round(priced.totalLow), high: Math.round(priced.totalHigh) };
    }
    const b = computeBase(assumptions);
    return { low: b.low, high: b.high };
  }, [priced, assumptions]);

  const total = useMemo(() => {
    if (priced) return Math.round((priced.totalLow + priced.totalHigh) / 2);
    return computeTotal(assumptions, addOns);
  }, [priced, assumptions, addOns]);

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

  const validSam3 = useMemo(() => validateAtAddress(sam3Polygon), [sam3Polygon, address?.lat, address?.lng, buildingCenter]);
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
  //     is > 2.2× expected footprint (eave overhang + attached lanais /
  //     covered porches / multi-section roofs in FL routinely add 50-
  //     100% to the Solar-reported footprint; tightened to 1.6 was
  //     rejecting legitimate polygons on complex Doctor-Phillips-style
  //     properties).
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
  // Solar-anchored coverage gate. Tier-aware upper bound — Solar's
  // `segmentCount` is our independent complexity signal (independent of
  // whichever polygon is being checked, so no circularity):
  //   • ≤2 segments → simple gable / single-pitch  → cap at 1.3× footprint
  //   • 3–5 segments → moderate (typical hip)       → cap at 1.6×
  //   • ≥6 segments → complex (multi-section, FL)  → cap at 2.0×
  //   • 0 segments  → no Solar findClosest signal  → cap at 1.20×
  //
  // The 0-segment case is the *strictest* because the only reference left
  // is MS Buildings / OSM footprint. Those are top-down satellite-derived
  // footprints with no eave / overhang information — a candidate polygon
  // with light eaves should land within ~10-20% of them. Anything above
  // 1.20× is almost certainly an over-trace into shadow / driveway / yard.
  //
  // History: was 1.6 → loosened to 2.2 (Doctor Phillips Orlando complex
  // FL home) → 5385 Henley Rd Mt Juliet shipped over-traced Solar mask at
  // 1.235× MS Buildings footprint. Tightening the no-Solar case to 1.20
  // rejects Mt Juliet's over-trace, falls through to Roboflow (~0.98× of
  // MS Buildings, clean), which becomes the displayed polygon.
  const overTraceUpperRatio = (() => {
    const sc = solar?.segmentCount ?? 0;
    if (sc >= 6) return 2.0;
    if (sc >= 3) return 1.6;
    if (sc >= 1) return 1.3;
    return 1.20;
  })();
  const passesCoverage = (
    poly: Array<{ lat: number; lng: number }> | null | undefined,
  ) => polygonCoversFootprint(poly, referenceFootprintSqft, 0.55, overTraceUpperRatio);
  const passesCoverageMulti = (
    polys: Array<Array<{ lat: number; lng: number }>> | null | undefined,
  ) => polygonsCoverFootprint(polys, referenceFootprintSqft, 0.55, overTraceUpperRatio);
  // Skip self-comparison when the source IS the reference (OSM gated
  // against an OSM-derived footprint = circular, trivially passes).
  const passesCoverageNonRef = (
    poly: Array<{ lat: number; lng: number }> | null | undefined,
    source: "ms" | "osm",
  ): boolean => {
    if (referenceSource === source) return true;
    return passesCoverage(poly);
  };
  // Absolute size sanity. ~93 m² ≈ 1000 sqft minimum (smaller than that
  // is almost always a noise blob or a shed, not a residential roof);
  // ~1860 m² ≈ 20,000 sqft maximum (larger than that is almost always
  // tracing the entire parcel or the neighbour's house too).
  const passesAbsoluteSize = (
    poly: Array<{ lat: number; lng: number }> | null | undefined,
  ): boolean => {
    if (!poly || poly.length < 3) return false;
    const sqft = polygonAreaSqft(poly);
    return sqft >= 200 && sqft <= 20_000;
  };

  /** TIGHTER size gate for Claude vision specifically. Claude over-traces
   *  routinely on rural / multi-building lots — it'll draw a single big
   *  rectangle around the house + driveway + outbuildings rather than
   *  isolate just the roof. Cap at 6,000 sqft to force fall-through to
   *  "none" when Claude returns a clearly oversized rectangle. The rep
   *  then gets the "Draw fresh" CTA instead of a bad auto-trace silently
   *  driving a $200k estimate. Lower bound stays 200 (catches sheds). */
  const passesClaudeSize = (
    poly: Array<{ lat: number; lng: number }> | null | undefined,
  ): boolean => {
    if (!poly || poly.length < 3) return false;
    const sqft = polygonAreaSqft(poly);
    return sqft >= 200 && sqft <= 6_000;
  };

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
    | "sam3"
    | "solar-mask"
    | "roboflow"
    | "solar"
    | "sam"
    | "osm"
    | "microsoft-buildings"
    | "ai"
    | "none"
  >(() => {
    // Rep edits always win — they're the final authority and shouldn't
    // be replaced by anything else, including a still-in-flight SAM3.
    if (livePolygons && livePolygons.length) return "edited";
    // SAM3 in-flight gate. Block the priority chain from rendering ANY
    // fallback polygon (MS Buildings, OSM, Solar mask, Solar facets,
    // Claude vision) while SAM3 is still working. Without this gate,
    // MS Buildings resolves in ~100ms and renders immediately, then
    // SAM3 replaces it 5-30s later — reps were seeing the wrong
    // polygon and assuming SAM3 had failed.
    //
    // Returning "none" here keeps the priority chain in its initial
    // (no-polygon) state, which the UI renders as the "Generating
    // measurement…" overlay. The gate clears in the sam3Promise.then
    // (after SAM3 succeeds OR its Solar-mask fallback completes),
    // at which point this useMemo recomputes and picks the best
    // polygon from whatever has resolved.
    if (sam3InFlight) return "none";
    // SAM3 (custom Roboflow Workflow) — top priority when it produces a
    // polygon. The route already runs GIS reconciliation server-side, so
    // a polygon coming back here has passed wrong-building / occlusion /
    // over-trace checks. Still gate against absolute size + coverage as
    // a belt-and-suspenders defence (cheap to compute, catches anything
    // the server-side reconciler missed).
    if (validSam3 && passesClaude("sam3") && passesAbsoluteSize(validSam3) && passesCoverage(validSam3) && passesComplexityPrior(validSam3)) return "sam3";
    // Coverage gating policy (revised 2026-05-06):
    //
    // • Solar mask: still gated against Solar's reported footprint via
    //   `passesCoverage`. Catches the failure mode where Solar's mask
    //   only traced a sub-section of its own segment-detected building
    //   (under-trace by ≥45%); without this gate, Solar mask polygons
    //   like Benwick Aly's 700 sqft fragment vs Solar's own 2202 sqft
    //   footprint would ship as the displayed polygon.
    //
    // • Other sources (Roboflow, SAM, OSM, MS Buildings, Claude vision)
    //   only need an absolute size sanity check. Solar's footprint
    //   isn't a reliable upper bound — Solar misses segments routinely,
    //   and complex FL homes with wide eaves / lanais / multi-section
    //   roofs trace 1.5-2× Solar's partial number. Gating those
    //   polygons against Solar's incomplete reference was hiding
    //   accurate traces. We trust the rep to visually verify the
    //   polygon overlay against the satellite tile and click "Draw
    //   fresh" if it's wrong.
    // Gate composition (revised 2026-05-06, regression-fix pass):
    //   • passesAbsoluteSize: 200–20,000 sf hard band (sheds & whole-parcel guard)
    //   • passesCoverage: tier-aware ratio vs Solar/MS/OSM reference footprint
    //     (lower 0.55, upper 1.3–2.0 by Solar segmentCount)
    //   • passesClaude: multi-view verifier (advisory, demotes on strong reject)
    //   • passesComplexityPrior: vertex count vs vision-detected complexity
    //   • passesMsHallucinationCheck: catches MS-derived hallucinations
    //
    // Coverage was previously skipped on Roboflow/SAM/OSM/MS — that bypass
    // let the Mt. Juliet over-trace ship. Now applied to every source,
    // with self-comparison skipped via passesCoverageNonRef where applicable.
    if (validSolarMask && passesClaude("solar-mask") && passesCoverage(validSolarMask) && passesComplexityPrior(validSolarMask)) return "solar-mask";
    if (validRoboflow && passesClaude("roboflow") && passesAbsoluteSize(validRoboflow) && passesCoverage(validRoboflow) && passesMsHallucinationCheck(validRoboflow) && passesComplexityPrior(validRoboflow)) return "roboflow";
    if (validSam && passesClaude("sam") && passesAbsoluteSize(validSam) && passesCoverage(validSam) && passesComplexityPrior(validSam)) return "sam";
    if (validOsm && passesClaude("osm") && passesAbsoluteSize(validOsm) && passesCoverageNonRef(validOsm, "osm") && passesComplexityPrior(validOsm)) return "osm";
    if (validMsBuilding && passesClaude("microsoft-buildings") && passesAbsoluteSize(validMsBuilding) && passesCoverageNonRef(validMsBuilding, "ms") && passesComplexityPrior(validMsBuilding)) return "microsoft-buildings";
    // Solar facets — rotated bboxes from findClosest. Multi-polygon, so
    // we sum the absolute area against the size band instead of using
    // single-polygon `passesAbsoluteSize`.
    if (solar?.segmentPolygonsLatLng?.length && solar.segmentCount > 1) {
      const totalSqft = solar.segmentPolygonsLatLng.reduce(
        (sum, p) => sum + polygonAreaSqft(p),
        0,
      );
      if (totalSqft >= 200 && totalSqft <= 20_000) return "solar";
    }
    // Claude vision is the LAST RESORT — gated tighter than other sources.
    // Uses passesClaudeSize (6,000 sqft ceiling, vs 20,000 for others) to
    // reject Claude's classic over-trace failure mode where it draws a big
    // rectangle around the whole compound on rural / multi-building lots.
    // When this gate fails, polygon source falls to "none" and the rep
    // sees the "Draw fresh" CTA instead of a bad auto-trace.
    if (validClaude && passesClaude("ai") && passesClaudeSize(validClaude) && passesCoverage(validClaude) && passesMsHallucinationCheck(validClaude)) return "ai";
    return "none";
  }, [
    livePolygons,
    sam3InFlight,
    validSam3,
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
  //
  // Derived DIRECTLY from `polygonSource` so it can't diverge — previous
  // version applied only `passesCoverage` here, missing `passesAbsoluteSize`
  // / `passesClaude` / `passesComplexityPrior` / `passesMsHallucinationCheck`
  // / `passesClaudeSize`. That gap let the displayed/priced polygon be one
  // that the source-priority logic had REJECTED — a real correctness bug
  // (wrong roof sqft → wrong PDF → wrong estimate). One source of truth now.
  const sourcePolygons:
    | Array<Array<{ lat: number; lng: number }>>
    | undefined = useMemo(() => {
    switch (polygonSource) {
      case "edited":
        return livePolygons ?? undefined;
      case "sam3":
        return validSam3 ? [validSam3] : undefined;
      case "solar-mask":
        return validSolarMask ? [validSolarMask] : undefined;
      case "roboflow":
        return validRoboflow ? [validRoboflow] : undefined;
      case "sam":
        return validSam ? [validSam] : undefined;
      case "osm":
        return validOsm ? [validOsm] : undefined;
      case "microsoft-buildings":
        return validMsBuilding ? [validMsBuilding] : undefined;
      case "solar":
        return solar?.segmentPolygonsLatLng ?? undefined;
      case "ai":
        return validClaude ? [validClaude] : undefined;
      case "tiles3d":
      case "none":
      default:
        return undefined;
    }
  }, [
    polygonSource,
    validSam3,
    validSolarMask,
    validRoboflow,
    validSam,
    validOsm,
    validMsBuilding,
    validClaude,
    solar?.segmentPolygonsLatLng,
    livePolygons,
  ]);

  // Active polygons — what we use for sqft, lengths, blueprint, PDF.
  // Live edits override source.
  const activePolygons = livePolygons ?? sourcePolygons;

  // Polygon visibility gate.
  //
  // Previous behaviour: polygon was hidden until Claude multi-view verify
  // completed, on the theory that an unverified polygon might be wrong.
  // Failure mode in production: Claude verify can hang (network, slow
  // 3D-tile load, Replicate cold start, capture timing) — and when it
  // does, the rep stares at a blank map indefinitely with no way to
  // proceed. The polygon IS computed (priority chain settled) but
  // hidden behind a "Generating…" overlay that never clears.
  //
  // New policy: show the polygon as soon as the priority chain picks
  // one. Claude verify still runs in the background; if it rejects
  // strongly (ok=false, confidence ≥ 0.7), `passesClaude` demotes the
  // source out of the priority chain on the next render → the polygon
  // either swaps to the next-best source or disappears (with the chain
  // settling on "none"). The confidence chip in mapBadges reflects
  // verify status as it lands. Rep is in the loop and can visually
  // verify the outline against the satellite tile; clicking "Draw
  // fresh" lets them re-trace if it's wrong.
  const polygonReady = useMemo(
    () => polygonSource !== "none",
    [polygonSource],
  );

  // Polygons passed to the viewers. With the verify-gate removal above,
  // `polygonReady` is true iff we have any priority-chain source — so
  // these mirror activePolygons / sourcePolygons whenever a source is
  // available. Kept the gate condition as a no-op safeguard against
  // future refactors that might re-introduce a "ready" state.
  const renderedPolygons = polygonReady ? activePolygons : undefined;
  const renderedSourcePolygons = polygonReady ? sourcePolygons : undefined;

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

  // Sqft source priority — Solar's photogrammetric measurement wins on
  // initial load, polygon-derived area takes over only after rep edits.
  //
  // Solar API's `roofSegmentStats[].areaMeters2` is the actual 3D surface
  // area Google computed from stereo aerial imagery — it's measurement,
  // not tracing. When Solar has segment coverage, that's the truth;
  // any polygon-shoelace-times-pitch number is a degraded approximation.
  //
  // The earlier "always use polygon" approach (commit aa5f5cc) tried to
  // solve a real problem: Solar undercounts on complex / multi-section
  // roofs, and a 4,500 sf polygon paired with 1,898 sf line items felt
  // wrong to the rep. But the cure was worse than the disease: when the
  // polygon over-traces (catches shadow / driveway / yard), the inflated
  // sqft now shows directly to the customer. See 5385 Henley Rd Mt Juliet:
  // polygon caught driveway shadow → 3,960 sf, ~40% above truth.
  //
  // Resolution: Solar wins on initial load (handled by the early-return
  // guard below + the assignment in runEstimate). Once the rep edits the
  // polygon (livePolygons set), the edit is the truth — recompute from it.
  // For addresses where Solar has no segments at all, polygon × pitch is
  // the fallback (handled by `solar?.sqft` being null → guard skipped).
  // Polygon sources that trace WALL footprint, not roof eaves. These
  // need a 1.06 overhang multiplier to approximate the roof-material
  // outline (typical residential eaves project 6-18in past the wall).
  // The reconciler at /api/sam3-roof already applies this internally
  // to its returned footprintSqft, but the page recomputes from the
  // polygon shape (so it stays right after rep edits) — meaning we
  // must apply the multiplier here whenever the underlying source
  // traces walls. Mirrors lib/reconcile-roof-polygon.ts EAVE_OVERHANG_FACTOR.
  //
  // Eave-traced sources (Solar facets, Solar mask, raw SAM3, Roboflow,
  // SAM 2, Claude) trace roof material directly → no multiplier.
  // Once the rep edits (polygonSource === "edited"), we use the frozen
  // pre-edit value captured by handlePolygonsChanged so the multiplier
  // persists through edits of MS/OSM polygons.
  const EAVE_OVERHANG = 1.06;
  const isWallFootprintSource = useMemo(() => {
    if (polygonSource === "edited") return editOriginIsWallFootprintRef.current;
    if (polygonSource === "microsoft-buildings") return true;
    if (polygonSource === "osm") return true;
    if (
      polygonSource === "sam3" &&
      (sam3Source === "footprint-only" || sam3Source === "footprint-occluded")
    ) {
      return true;
    }
    return false;
  }, [polygonSource, sam3Source]);

  // Mirror into a ref so the (forward-declared) handlePolygonsChanged
  // callback can capture the pre-edit value at the moment of first edit.
  useEffect(() => {
    isWallFootprintSourceRef.current = isWallFootprintSource;
  }, [isWallFootprintSource]);

  useEffect(() => {
    // Solar's segment-summed sqft is canonical when available + no rep edit.
    // assumptions.sqft is set from solar.sqft in runEstimate; this guard
    // prevents a fresh polygon (Solar mask / Roboflow / etc) from stomping
    // it with a polygon-shoelace estimate. Once the rep edits, livePolygons
    // is set and the guard releases.
    if (solar?.sqft && !livePolygons) return;
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
    const overhang = isWallFootprintSource ? EAVE_OVERHANG : 1;
    const sqft = Math.round(totalM2 * 10.7639 * overhang * slopeMult);
    if (sqft >= 200 && sqft <= 30_000) {
      setAssumptions((a) => ({ ...a, sqft }));
    }
  }, [
    activePolygons,
    solar?.sqft,
    solar?.pitchDegrees,
    livePolygons,
    assumptions.pitch,
    isWallFootprintSource,
  ]);

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

  // Legacy DetailedEstimate projection — feeds LineItemsPanel and the
  // v1-compatible Estimate object passed to OutputButtons / PDF / etc.
  // When the pipeline is degraded (priced === null), detailed is null;
  // LineItemsPanel handles the null case gracefully.
  const detailed = useMemo<DetailedEstimate | null>(() => {
    if (!priced) return null;
    return {
      lineItems: priced.lineItems.map((li) => ({
        code: li.code,
        description: li.description,
        friendlyName: li.friendlyName,
        quantity: li.quantity,
        unit: li.unit,
        unitCostLow: li.unitCostLow,
        unitCostHigh: li.unitCostHigh,
        extendedLow: li.extendedLow,
        extendedHigh: li.extendedHigh,
        category: li.category,
      })),
      simplifiedItems: priced.simplifiedItems,
      subtotalLow: priced.subtotalLow,
      subtotalHigh: priced.subtotalHigh,
      overheadProfit: priced.overheadProfit,
      totalLow: priced.totalLow,
      totalHigh: priced.totalHigh,
      squares: priced.squares,
    };
  }, [priced]);

  // ─── Tier C lengths — derived from RoofData.edges + RoofData.flashing
  // when available. Null when the pipeline is degraded —
  // MeasurementsPanel handles the null case.
  const lengths = useMemo(() => {
    if (!roofData || roofData.source === "none") return null;
    const sum = (type: EdgeType) =>
      roofData.edges
        .filter((e) => e.type === type)
        .reduce((s, e) => s + e.lengthFt, 0);
    return {
      perimeterLf: roofData.flashing.dripEdgeLf,
      eavesLf: sum("eave"),
      rakesLf: sum("rake"),
      ridgesLf: sum("ridge"),
      hipsLf: sum("hip"),
      valleysLf: sum("valley"),
      dripEdgeLf: roofData.flashing.dripEdgeLf,
      // Continuous-metal flashing + Tier B headwall/apron.
      flashingLf:
        roofData.flashing.chimneyLf +
        roofData.flashing.skylightLf +
        roofData.flashing.headwallLf +
        roofData.flashing.apronLf,
      // Step flashing = dormer cheek walls + Tier B non-dormer wall-step.
      stepFlashingLf:
        roofData.flashing.dormerStepLf + roofData.flashing.wallStepLf,
      iwsSqft: roofData.flashing.iwsSqft,
      source: "polygons" as const,
    };
  }, [roofData]);

  // Prefer RoofData-driven waste when the pipeline returned usable data
  // (matches /internal). Falls back to assumptions when roofData is null
  // or degraded (source === "none").
  const waste = useMemo(() => {
    if (roofData && roofData.source !== "none") {
      return buildWasteTable(
        roofData.totals.totalRoofAreaSqft,
        roofData.totals.complexity,
      );
    }
    return buildWasteTable(assumptions.sqft, assumptions.complexity ?? "moderate");
  }, [roofData, assumptions.sqft, assumptions.complexity]);

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
    setSam3Polygon(null);
    setSam3Source(null);
    setSam3InFlight(false); // reset gate on address change / clear
    setLivePolygons(null);
    setRoofData(null);
    hasUserEditedRef.current = false;
    editOriginIsWallFootprintRef.current = false;

    if (addr.lat == null || addr.lng == null) {
      setAssumptions((a) => ({
        ...a,
        sqft: a.sqft || estimateRoofSize(),
        ageYears: a.ageYears || estimateAge(),
      }));
      return;
    }

    setVisionLoading(true);

    // ─── Tier C unified pipeline ─────────────────────────────────────
    // Fire /api/roof-pipeline alongside the legacy chain. Result populates
    // `roofData`, which drives priceRoofData (new engine) for the
    // headline price, line items, and lengths. Out-of-order responses
    // are dropped via fetchGenRef.
    const gen = ++fetchGenRef.current;
    setPipelineLoading(true);
    setPipelineError(null);
    fetch(
      `/api/roof-pipeline?lat=${addr.lat}&lng=${addr.lng}` +
        `&address=${encodeURIComponent(addr.formatted ?? "")}` +
        sam3NoCacheSuffix,
      { cache: "no-store" },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`pipeline ${r.status}`);
        return (await r.json()) as RoofData;
      })
      .then((data) => {
        if (gen !== fetchGenRef.current) return;
        setRoofData(data);
      })
      .catch((err) => {
        if (gen !== fetchGenRef.current) return;
        setPipelineError(err instanceof Error ? err.message : String(err));
        setRoofData(null);
      })
      .finally(() => {
        if (gen === fetchGenRef.current) setPipelineLoading(false);
      });

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

    // [Lazy 2026-05-07] Solar mask (Project Sunroof) is now fired only as a
    // fallback after SAM3 returns null — see the sam3Promise.then block
    // below. Saves the $0.075 dataLayers cost on the common path where
    // SAM3 succeeds, and eliminates the "Solar mask renders first then
    // SAM3 swaps in" flicker.

    // [Phase 1 cleanup 2026-05-07] Off-the-shelf Roboflow Satellite Rooftop
    // Map call removed — custom SAM3 supersedes it. Route still exists for
    // emergency rollback (re-add the fetch here if needed). State slot
    // (`roboflowPolygon`) and priority chain entry kept passive; they'll
    // never receive data from the page so the chain skips that tier.

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

    // Custom SAM3 (Roboflow Workflow) with server-side GIS reconciliation.
    // Top-priority polygon source — trained on our service-area imagery.
    // ~5-10s latency (Roboflow inference + reconciliation), so we fire it
    // in parallel with everything else and let the priority chain pick it
    // up when it lands. Falls through silently when the kill switch is
    // tripped or the route 404s.
    //
    // Set the in-flight gate BEFORE the fetch starts. This is what keeps
    // the polygon priority chain from rendering MS Buildings or OSM
    // polygons in the 100ms-5s window while SAM3 is still working. The
    // .then() at the end of the file (sam3Promise.then) clears the flag
    // regardless of outcome (success or null), unblocking the chain.
    setSam3InFlight(true);
    const sam3Promise = fetch(
      `/api/sam3-roof?lat=${addr.lat}&lng=${addr.lng}` +
        `&address=${encodeURIComponent(addr.formatted)}` +
        sam3NoCacheSuffix,
    )
      .then(async (r) => {
        if (!r.ok) return null;
        const data = (await r.json()) as {
          polygon?: Array<{ lat: number; lng: number }>;
          source?:
            | "sam3"
            | "footprint-only"
            | "footprint-occluded"
            | "sam3-no-footprint";
        };
        if (!data.polygon || data.polygon.length < 3) return null;
        return { polygon: data.polygon, source: data.source ?? "sam3" };
      })
      .catch(() => null);

    // [Phase 1 cleanup 2026-05-07] Replicate SAM2 (sam-refine) call removed
    // — custom SAM3 supersedes it. Route + lib/grounded-sam.ts still exist
    // for emergency rollback. State slot (`samRefinedPolygon`) and
    // `samRefining` flag stay passive; the "Refining…" badge will never
    // light up because we no longer toggle it on.

    const [solarData, visionData, osmData] = await Promise.all([
      solarPromise,
      visionPromise,
      osmPromise,
    ]);

    if (solarData) setSolar(solarData);
    if (visionData) setVision(visionData);
    if (osmData) setOsmBuildingPolygon(osmData);
    setVisionLoading(false);

    // [Phase 1 cleanup] sam-refine and off-the-shelf roboflow result handlers
    // removed — those promises are no longer fired. Custom SAM3 below
    // covers the same role with better accuracy and lower latency.

    // MS Building Footprints — same edit-stomp guard.
    msBuildingPromise.then((msPoly) => {
      if (msPoly && !hasUserEditedRef.current) setMsBuildingPolygon(msPoly);
    });

    // SAM3 (custom) primary + lazy Solar mask fallback.
    // When SAM3 returns null, fire /api/solar-mask in serial as a fallback.
    // This avoids paying for Solar dataLayers on the common path where
    // SAM3 succeeds AND eliminates the visual flicker where Solar mask
    // would render first and then SAM3 would override it.
    //
    // The `sam3InFlight` gate clears AS LATE AS POSSIBLE so the
    // "Generating measurement…" overlay stays up through the entire
    // chain. Specifically:
    //   - SAM3 succeeds → clear immediately (we have the winning polygon)
    //   - SAM3 fails → wait for Solar mask fallback to land before
    //     clearing, so we don't briefly render "no polygon" between
    //     SAM3's failure and mask's arrival.
    sam3Promise.then((sam3Result) => {
      if (sam3Result) {
        if (!hasUserEditedRef.current) {
          setSam3Polygon(sam3Result.polygon);
          setSam3Source(sam3Result.source);
        }
        setSam3InFlight(false);
        return;
      }
      // SAM3 returned nothing — fall back to Solar mask. No need to fire
      // it earlier since the priority chain would have used SAM3 anyway.
      fetch(`/api/solar-mask?lat=${addr.lat}&lng=${addr.lng}`)
        .then(async (r) => {
          if (!r.ok) return null;
          const data = (await r.json()) as {
            latLng?: Array<{ lat: number; lng: number }>;
          };
          return data.latLng && data.latLng.length >= 3 ? data.latLng : null;
        })
        .catch(() => null)
        .then((maskPoly) => {
          if (maskPoly && !hasUserEditedRef.current) setSolarMaskPolygon(maskPoly);
          // Clear the gate whether mask succeeded or not. If both SAM3
          // and the mask fallback fail, the priority chain falls through
          // to MS Buildings / OSM (which by now are already resolved in
          // state). Clearing here unblocks that final fallback render.
          setSam3InFlight(false);
        });
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

  /** Merge structured fields from a voice-note into the estimate state.
   *  Each branch is conservatively gated — if the model didn't return a
   *  field, we don't touch the existing value. The rep can always edit
   *  any field manually after the merge. */
  const onVoiceNoteResult = (result: VoiceNoteResult) => {
    const s = result.structured;
    setAssumptions((a) => {
      const next: Assumptions = { ...a };
      if (s.material) next.material = s.material;
      if (s.complexity) next.complexity = s.complexity;
      if (s.serviceType) next.serviceType = s.serviceType;
      if (s.ageYears != null) next.ageYears = s.ageYears;
      return next;
    });
    if (s.customerName) setCustomerName(s.customerName);
    if (s.insuranceClaim) setIsInsuranceClaim(true);
    if (s.carrier) {
      // ClaimContext['carrier'] is a typed enum — only set if it matches
      // one of our 10 supported carriers.
      const validCarriers: ClaimContext["carrier"][] = [
        "state-farm", "allstate", "usaa", "citizens", "travelers",
        "farmers", "liberty-mutual", "progressive", "nationwide", "other",
      ];
      if (validCarriers.includes(s.carrier as ClaimContext["carrier"])) {
        setClaim((c) => ({ ...c, carrier: s.carrier as ClaimContext["carrier"] }));
      }
    }
    if (s.addOns) {
      // The 4 customer-facing add-ons map by id; ignore unknowns.
      const idMap: Record<string, string> = {
        iceWater: "ice-water",
        ridgeVent: "ridge-vent",
        gutters: "gutters",
        skylight: "skylight",
      };
      setAddOns((cur) =>
        cur.map((a) => {
          const k = Object.entries(idMap).find(([, v]) => v === a.id)?.[0];
          if (k && (s.addOns as Record<string, boolean | undefined>)[k]) {
            return { ...a, enabled: true };
          }
          return a;
        }),
      );
    }
    // Append damage notes + timeline to the rep notes field (don't
    // clobber existing notes — append with a newline separator).
    const noteParts: string[] = [];
    if (s.notes) noteParts.push(s.notes);
    if (s.damageNotes && s.damageNotes.length) {
      noteParts.push(`Damage: ${s.damageNotes.join("; ")}`);
    }
    if (s.timelineDays != null) {
      noteParts.push(`Customer timeline: ${s.timelineDays} days`);
    }
    if (noteParts.length) {
      setNotes((prev) => (prev ? `${prev}\n\n${noteParts.join(" · ")}` : noteParts.join(" · ")));
    }
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
    detailed: detailed ?? undefined,
    lengths: lengths ?? undefined,
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
    setSam3Polygon(null);
    setSam3Source(null);
    setRoboflowPolygon(null);
    setMsBuildingPolygon(null);
    setClaudeVerifications({});
    hasUserEditedRef.current = false;
    editOriginIsWallFootprintRef.current = false;
  };

  const mapBadges = (() => {
    const badges: string[] = [];
    // Labelled "Solar imagery" specifically because this date comes from
    // Google Solar API's dataset capture, NOT the Static Maps / Maps JS
    // tile actually rendered on screen. Reps saw the bare "Imagery 2015"
    // chip next to a 2026-attributed satellite tile and assumed the
    // image they were looking at was old. The Solar dataset can be
    // 5-12 years old; the displayed Maps tile is usually current. Both
    // datapoints matter (Solar age informs analysis confidence), but
    // the chip needs to say which it's about.
    if (solar?.imageryDate) badges.push(`Solar imagery ${solar.imageryDate}`);
    if (solar && solar.imageryQuality !== "UNKNOWN") badges.push(`Quality ${solar.imageryQuality}`);
    if (polygonSource === "edited") badges.push("Edited");
    else if (polygonSource === "tiles3d") badges.push("3D mesh");
    else if (polygonSource === "sam3") badges.push("SAM3 (custom)");
    else if (polygonSource === "solar-mask") badges.push("Solar mask");
    else if (polygonSource === "roboflow") badges.push("Roof AI");
    else if (polygonSource === "sam") badges.push("SAM 2 refined");
    else if (polygonSource === "osm") badges.push("OSM traced");
    else if (polygonSource === "microsoft-buildings") badges.push("MS Footprints");
    else if (polygonSource === "ai") badges.push("AI traced");
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
      {/* Floating voice-note recorder — mounts once the rep has loaded
          an address. Clicking it captures from the mic, ships to
          /api/voice-note for Whisper transcription + Claude structuring,
          and auto-fills the estimate fields (material, complexity,
          carrier, customer name, damage notes, add-ons, timeline).
          Hidden until shown=true to avoid presenting it before the rep
          has a property in scope. */}
      {shown && address?.lat != null && (
        <VoiceNoteRecorder
          addressText={address.formatted}
          currentSqft={assumptions.sqft}
          onResult={onVoiceNoteResult}
        />
      )}

      {/* ─── Hero / address bar ─────────────────────────────────────── */}
      {/* No overflow-hidden here so the autocomplete dropdown can extend
          past the section's bottom edge. The gradient blob below uses
          isolation: isolate to keep its rounded-3xl clipping local. */}
      <section
        className="glass-panel-hero p-5 sm:p-7 md:p-9 relative"
        style={{ isolation: "isolate" }}
      >
        <div className="relative flex items-end justify-between gap-6 mb-6 flex-wrap">
          <div className="flex items-end gap-3">
            <div className="glass-eyebrow">
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
              className="glass-input flex-1 sm:flex-none sm:w-44 text-[13px]"
              placeholder="Your name"
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
            />
            {shown && (
              <button
                onClick={reset}
                className="glass-button-secondary flex-shrink-0 text-[13px]"
                aria-label="Start new estimate"
              >
                <RotateCcw size={13} />
                <span className="hidden sm:inline">New</span>
              </button>
            )}
          </div>
        </div>

        <h1 className="font-display text-[28px] sm:text-4xl md:text-[44px] leading-[1.05] tracking-tight font-medium mb-1.5">
          Where are we{" "}
          <span className="iridescent-text">roofing</span>{" "}
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

        {/* Keyboard discoverability strip — surfaces the shortcuts the
            useKeyboardShortcuts hook already binds. Hidden on mobile
            (touch users have no keyboard) and on small screens. */}
        <div className="hidden md:flex flex-wrap items-center gap-x-4 gap-y-2 mt-4 text-[10.5px] font-mono uppercase tracking-[0.12em] text-slate-500">
          <span className="flex items-center gap-1.5"><span className="kbd">⌘K</span> Address</span>
          <span className="flex items-center gap-1.5"><span className="kbd">⌘N</span> New</span>
          <span className="flex items-center gap-1.5"><span className="kbd">⌘S</span> Save</span>
          <span className="flex items-center gap-1.5"><span className="kbd">⌘P</span> PDF</span>
          <span className="flex items-center gap-1.5"><span className="kbd">⌘E</span> Email</span>
        </div>
      </section>

      {!shown && <EmptyState />}

      {/* ─── Quantum-pulse loader: full-screen overlay while polygon resolution
           is still in flight. Stays up until ALL of:
             1. Solar + Vision metadata fetches complete (visionLoading)
             2. SAM3 settles — either successfully traces a polygon, or
                fails and the Solar-mask fallback completes (sam3InFlight)
             3. Click-pick re-trace settles (pickingLoading) — when the rep
                taps "Wrong building? Click to pick", the route re-runs
                Roboflow on the new centre and that call also takes
                5-30s. Without this gate, the rep saw the old polygon
                hang on-screen while Roboflow worked, then flicker to
                the new one — confusing UX. Showing the same overlay as
                initial load makes the state unambiguous.
           Without the sam3InFlight gate, the overlay would clear at ~3s
           (when vision finishes) but SAM3 would still be cold-starting
           Roboflow for another 5-30s. Reps were seeing the satellite
           render with NO polygon, then a stale fallback polygon appear,
           then the real SAM3 polygon flicker in late — making them
           assume SAM3 had failed. Holding the overlay through SAM3's
           full settle window eliminates that flicker. */}
      {pipelineError && !pipelineLoading && !visionLoading && (
        <div
          className="rounded-md border border-red-400/30 bg-red-50/95 px-3 py-2 text-sm text-red-900"
          role="alert"
        >
          Pipeline error: {pipelineError}. Try re-analyzing or reload.
        </div>
      )}

      {(visionLoading || sam3InFlight || pickingLoading) && (
        <div
          // No backdrop-blur — the filter forces full-page recomposite every
          // frame, which thrashes against Cesium's WebGL canvas underneath
          // and made the loader animation visibly stutter. A solid fill at
          // 88% darkness reads almost the same and stays smooth.
          //
          // `absolute` (not `fixed`) so the overlay anchors to the lg-env
          // wrapper, not the viewport. When this page is hosted inside the
          // dashboard chrome, `fixed inset-0` slid the loader UNDER the
          // sidebar — the "GENE" of "GENERATING" got clipped, only "RATING"
          // peeked through, and the cyan progress bar bled past the chrome.
          // Anchoring to the parent keeps the chrome visible and the loader
          // perfectly centered inside the content column.
          className="absolute inset-0 z-40 flex items-center justify-center float-in"
          style={{ background: "rgba(7,9,13,0.88)" }}
          aria-live="polite"
        >
          <QuantumPulseLoader
            text={
              pickingLoading
                ? "Re-tracing roof"
                : sam3InFlight && !visionLoading
                  ? "Tracing roof"
                  : "Generating"
            }
          />
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
                <span
                  className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slate-500"
                  title="Date of Google Solar API's roof dataset for this location — NOT the date of the satellite tile shown below (that's served by Google Static Maps / Maps JS and is usually current)."
                >
                  Solar imagery {solar.imageryDate}
                </span>
              )
            }
          />
          {/* ─── Map hero — satellite + 3D side-by-side, full width ───────
               Strict 2-column grid: MapView (which internally stacks
               satellite over street view) on the left, Roof3DViewer
               on the right. The "Wrong building? Click to pick"
               affordance moved OUT of this section into its own block
               below — adding it here gave the grid 3 children and broke
               the side-by-side layout (3D viewer wrapped to row 2,
               overflowing the fixed-height section). */}
          <section className="grid lg:grid-cols-2 gap-4 h-[420px] sm:h-[520px] lg:h-[640px] float-in relative">
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
              pickingBuilding={pickingBuilding}
              onPickBuilding={(clickLat, clickLng) => {
                if (!address?.lat || !address?.lng) return;
                setPickingBuilding(false);
                setPickingLoading(true);
                fetch(
                  `/api/sam3-roof?lat=${address.lat}&lng=${address.lng}` +
                    `&clickLat=${clickLat}&clickLng=${clickLng}` +
                    `&address=${encodeURIComponent(address.formatted)}`,
                )
                  .then(async (r) => {
                    if (!r.ok) return null;
                    const data = (await r.json()) as {
                      polygon?: Array<{ lat: number; lng: number }>;
                      source?:
                        | "sam3"
                        | "footprint-only"
                        | "footprint-occluded"
                        | "sam3-no-footprint";
                    };
                    if (!data.polygon || data.polygon.length < 3) return null;
                    return { polygon: data.polygon, source: data.source ?? "sam3" };
                  })
                  .then((result) => {
                    if (result) {
                      hasUserEditedRef.current = false;
                      setSam3Polygon(result.polygon);
                      setSam3Source(result.source);
                    } else {
                      console.warn("[page] click-override SAM3 returned no polygon");
                    }
                  })
                  .catch((err) =>
                    console.warn("[page] click-override SAM3 failed:", err),
                  )
                  .finally(() => setPickingLoading(false));
              }}
            />
            {/* ─── Photorealistic 3D mesh (Google Map Tiles 3D via Cesium) ───
                 Sits in column 2 of the grid, beside MapView in column 1.
                 Mounts only after the polygon resolution has settled so
                 Cesium isn't re-drawing the draped outline as polygons
                 race in. `key` forces a hard remount on address change so
                 the previous Cesium camera + tile cache can't linger.
                 interactive=true for rep workflow (they need to pan,
                 zoom, change angle to inspect damage). When no polygon
                 is on-screen yet we render a placeholder div instead of
                 nothing, so the grid layout doesn't collapse to single-
                 column and orphan the MapView. */}
            {polygonReady &&
            polygonSource !== "none" &&
            address?.lat != null &&
            address?.lng != null ? (
              <div
                className="glass-panel overflow-hidden h-full relative"
                aria-label={`3D photorealistic view of the roof at ${address.formatted ?? "this property"}`}
                role="img"
              >
                <Roof3DViewer
                  key={`${address.lat.toFixed(6)},${address.lng.toFixed(6)}`}
                  lat={address.lat}
                  lng={address.lng}
                  address={address.formatted}
                  polygons={activePolygons}
                  polygonSource={polygonSource}
                  imageryDate={solar?.imageryDate}
                  expectedFootprintSqft={
                    solar?.buildingFootprintSqft ?? null
                  }
                  interactive
                />
              </div>
            ) : (
              // Placeholder keeps the 2-column grid intact while SAM3
              // is in flight. Falls back to a soft glass panel mirroring
              // the eventual 3D mount so the layout doesn't shift when
              // the mesh appears.
              <div className="glass-panel h-full flex items-center justify-center text-slate-500 text-[12px] font-mono uppercase tracking-[0.14em]">
                3D mesh loads after measurement…
              </div>
            )}
          </section>

          {/* "Pick the right building" affordance — rendered OUTSIDE the
              2-column grid so it sits below the MapView+3D row at full
              width. Previously this lived inside the grid as a third
              child, which shoved the 3D viewer onto row 2 and made the
              fixed-height grid section overflow. */}
          {polygonReady && polygonSource !== "none" && (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPickingBuilding((p) => !p)}
                className="glass-button-secondary text-[12px] font-mono uppercase tracking-[0.14em]"
                disabled={pickingLoading}
              >
                {pickingLoading
                  ? "Re-tracing…"
                  : pickingBuilding
                    ? "Tap the right building (Esc to cancel)"
                    : "Wrong building? Click to pick"}
              </button>
              {pickingBuilding && (
                <span className="font-mono text-[11px] text-cy-300/70">
                  Click anywhere on the actual house in the satellite tile.
                </span>
              )}
            </div>
          )}

          {/* The "Roof geometry" section (parametric 3D + architectural
              blueprint card) was removed — same reason as above. The
              2D polygon trace + MapView already conveys the geometry
              data the rep needs, and the blueprint was duplicating
              measurements already shown in the Measurements panel. */}

          {/* ═══ 03 QUALITY & COMPLIANCE ═══════════════════════════════ */}
          {/* Section header only when there's actually something to show
              (carrier claim, storm correlation, outline warning, or size
              mismatch). Otherwise we'd render a "03 Quality" header above
              an empty region. */}
          {(isInsuranceClaim ||
            (polygonReady && polygonSource !== "none")) && (
            <SectionHeader
              index={2}
              title="Quality & compliance"
              caption="Auto-checks before delivery"
            />
          )}

          {/* ─── Carrier-specific claim metadata (insurance mode only) ─── */}
          {isInsuranceClaim && (
            <CarrierClaimPanel
              context={claim}
              onChange={setClaim}
              state={
                /\bFL\b/.test(address?.formatted ?? "") ? "FL"
                : /\bMN\b/.test(address?.formatted ?? "") ? "MN"
                : /\bTX\b/.test(address?.formatted ?? "") ? "TX"
                : null
              }
            />
          )}

          {/* ─── Supplement Analyzer (insurance mode only) ───────────────
                Rep uploads carrier's initial Xactimate PDF → Qwen parses
                → we diff against industry rule catalog (O&P, steep
                charge, FL matching, code items) + cross-ref MRMS hail
                data → flag missing items with copy-paste rationale.
                Highest-leverage feature for the insurance close. */}
          {isInsuranceClaim && (
            <SupplementAnalyzerPanel
              assumptions={assumptions}
              claim={claim}
              state={
                /\bFL\b/.test(address?.formatted ?? "") ? "FL"
                : /\bMN\b/.test(address?.formatted ?? "") ? "MN"
                : /\bTX\b/.test(address?.formatted ?? "") ? "TX"
                : null
              }
              propertyLat={address?.lat ?? null}
              propertyLng={address?.lng ?? null}
            />
          )}

          {/* ─── Imagery × storm correlation (multi-temporal) ──────────── */}
          <ImageryStormBanner
            imageryDate={solar?.imageryDate ?? null}
            lat={address?.lat}
            lng={address?.lng}
          />

          {/* ─── Outline accuracy + size-warning panels removed —
                superseded by RoofTotalsCard / DetectedFeaturesPanel in
                /internal. This page keeps the legacy polygon chain for
                now; quality warnings will be re-mounted as part of a
                later full migration to the v2 RoofData feed. */}


          {/* ═══ 04 ESTIMATE — headline price + breakdown ═══════════════ */}
          <SectionHeader
            index={3}
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

          {/* ═══ 05 BREAKDOWN — tabbed rep workbench ═══════════════════
              Was 11 panels stacked across a 2-col grid, which sprawled
              the page well past the fold. Tabbed into 3 logical groups
              (Numbers / Measurements & damage / Delivery) so only the
              panels relevant to the current workflow are mounted. */}
          <SectionHeader
            index={4}
            title="Breakdown & detail"
            caption="Internal worksheet · not shown to customer"
            trailing={
              <div
                role="tablist"
                aria-label="Breakdown sections"
                className="inline-flex items-center gap-1 p-1 rounded-full bg-white/[0.04] border border-white/[0.06]"
              >
                {(
                  [
                    { key: "numbers", label: "Numbers" },
                    { key: "measurements", label: "Measurements & damage" },
                    { key: "delivery", label: "Delivery" },
                  ] as const
                ).map((t) => {
                  const active = breakdownTab === t.key;
                  return (
                    <button
                      key={t.key}
                      role="tab"
                      aria-selected={active}
                      onClick={() => setBreakdownTab(t.key)}
                      className={[
                        "px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors",
                        active
                          ? "bg-cy-300/15 text-cy-300 border border-cy-300/30"
                          : "text-white/65 hover:text-white border border-transparent",
                      ].join(" ")}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            }
          />

          <div className="float-in">
            {breakdownTab === "numbers" && (
              <div className="grid lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-6">
                  <TiersPanel
                    assumptions={assumptions}
                    addOns={addOns}
                    onApplyTier={applyTier}
                  />
                  {detailed && (
                    <LineItemsPanel
                      detailed={detailed}
                      defaultOpen={
                        isInsuranceClaim || BRAND_CONFIG.showXactimateCodes
                      }
                      alwaysShowXactimate={
                        isInsuranceClaim || BRAND_CONFIG.showXactimateCodes
                      }
                    />
                  )}
                </div>
                <div className="space-y-6">
                  <AssumptionsEditor
                    value={assumptions}
                    onChange={setAssumptions}
                  />
                  <AddOnsPanel addOns={addOns} onChange={setAddOns} />
                </div>
              </div>
            )}

            {breakdownTab === "measurements" && (
              <div className="grid lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-6">
                  {lengths && (
                    <MeasurementsPanel
                      lengths={lengths}
                      waste={waste}
                      defaultOpen={
                        isInsuranceClaim || BRAND_CONFIG.showXactimateCodes
                      }
                    />
                  )}
                </div>
                <div className="space-y-6">
                  <PropertyContextPanel address={address} />
                  <StormHistoryCard
                    lat={address?.lat}
                    lng={address?.lng}
                  />
                </div>
              </div>
            )}

            {breakdownTab === "delivery" && (
              <div className="grid lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 space-y-6">
                  <PhotoUploadPanel photos={photos} onChange={setPhotos} />
                  <div className="glass-panel p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="font-display font-semibold tracking-tight">
                        Customer &amp; Notes
                      </div>
                      <span className="label">internal only</span>
                    </div>
                    <input
                      className="glass-input"
                      placeholder="Customer name"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                    />
                    <textarea
                      className="glass-input"
                      placeholder="Notes…"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      style={{
                        minHeight: 90,
                        resize: "vertical",
                        lineHeight: 1.5,
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-6">
                  <div className="glass-panel p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="font-display font-semibold tracking-tight">
                        Output
                      </div>
                      <span className="label">deliver</span>
                    </div>
                    <OutputButtons estimate={estimate} office={office} />
                  </div>
                  <InsightsPanel estimate={estimate} />
                </div>
              </div>
            )}
          </div>
          {/* Floating estimate summary — fades in once the rep scrolls past
              the headline price card so the live total + sqft + source
              stay visible while they work through line items below. */}
          <EstimateSticky
            total={total}
            sqft={assumptions.sqft}
            pitch={assumptions.pitch}
            sourceLabel={
              polygonSource === "edited"
                ? "Edited"
                : polygonSource === "sam3"
                  ? "SAM3"
                  : polygonSource === "solar-mask"
                    ? "Solar mask"
                    : polygonSource === "roboflow"
                      ? "Roof AI"
                      : polygonSource === "sam"
                        ? "SAM 2"
                        : polygonSource === "osm"
                          ? "OSM"
                          : polygonSource === "microsoft-buildings"
                            ? "MS Footprints"
                            : polygonSource === "solar"
                              ? "Solar facets"
                              : polygonSource === "ai"
                                ? "AI traced"
                                : null
            }
            confidence={
              polygonSource !== "none" ? estimateConfidence.level : null
            }
          />
        </>
      )}
    </div>
  );
}

/**
 * Default export — wraps HomePageInner in a <Suspense> boundary so the
 * Next.js build's prerender pass doesn't throw on HomePageInner's
 * synchronous `useSearchParams()` call. The wrapper itself is trivial
 * (renders nothing on its own) so there's no observable UX difference
 * for the rep — the inner page renders normally as soon as the search
 * params resolve (which is synchronous for static routes in practice).
 *
 * Fallback is null because:
 *   1. useSearchParams resolves synchronously on client navigation.
 *   2. The route is gated behind auth middleware anyway; an empty
 *      moment before HomePageInner mounts is invisible behind the
 *      transition from the login page.
 *   3. The full-screen QuantumPulseLoader inside HomePageInner kicks
 *      in for the actual heavy work (vision + Solar + SAM3), so there's
 *      no need for a fallback loader here.
 */
export default function HomePage() {
  // Wrap in `lg-env` so the dashboard-hosted estimator inherits the
  // SAME visual environment as the legacy `/` rep estimator — aurora
  // background blobs, noise-grain overlay, deep ink-950 base. Without
  // this wrap the estimator would render against the dashboard's
  // `theme-terminal` background, which doesn't match what the rep is
  // used to from /history and from /. The `relative z-[1]` matches
  // (internal)/layout.tsx so the aurora ::before pseudo can paint
  // correctly behind the content. The wrapping div bleeds to the
  // full main column width inside DashboardChrome's <main>; the
  // inner max-w-[1280px] container mirrors the legacy layout so
  // the estimator's own column widths and spacing read identically.
  return (
    <Suspense fallback={null}>
      <div className="lg-env relative z-[1] -m-4 sm:-m-6 lg:-m-8 min-h-[100dvh]">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 py-6 sm:py-8">
          <HomePageInner />
        </div>
      </div>
    </Suspense>
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
          className="glass-panel is-interactive p-5 float-in"
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

// polygonVertexComplexity removed — it fed buildDetailedEstimate /
// deriveRoofLengthsHeuristic's segmentCount fallback, both of which were
// retired as part of Phase 4. The Tier C pipeline (RoofData.totals.complexity)
// is the single source of truth for complexity now.

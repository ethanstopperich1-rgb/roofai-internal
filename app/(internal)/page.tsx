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
// Tier A.2 visual layer — only mounts when Tier A LiDAR is the active
// source. For Tier B/C the existing Roof3DViewer (polygon-verify path)
// continues to own the slot.
const RoofViewer = dynamic(() => import("@/components/roof/RoofViewer"), {
  ssr: false,
});
import AddressInput from "@/components/AddressInput";
import AssumptionsEditor from "@/components/AssumptionsEditor";
import AddOnsPanel from "@/components/AddOnsPanel";
import ResultsPanel from "@/components/ResultsPanel";
import EstimateSticky from "@/components/EstimateSticky";
import OutputButtons from "@/components/OutputButtons";
import MapView from "@/components/MapView";
import ConfirmHomePin from "@/components/ConfirmHomePin";
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
  Estimate,
  DetailedEstimate,
} from "@/types/estimate";
import type {
  RoofData,
  PricingInputs,
  PricedEstimate,
  EstimateV2,
} from "@/types/roof";
import { priceRoofData } from "@/lib/roof-engine";
import {
  refineRoofDataViaMultiview,
  type CapturedMultiView,
} from "@/lib/sources/multiview-source";
import { RoofTotalsCard } from "@/components/roof/RoofTotalsCard";
import { DetectedFeaturesPanel } from "@/components/roof/DetectedFeaturesPanel";
import { FacetList } from "@/components/roof/FacetList";
import { saveEstimateV2 } from "@/lib/storage";
import { DEFAULT_ADDONS, computeBase, computeTotal } from "@/lib/pricing";
import { buildWasteTable, inferComplexityFromPolygons } from "@/lib/roof-geometry";
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
  // Pin-confirmation flow. When set, the page renders <ConfirmHomePin>
  // instead of kicking off the estimate. The pending address is the
  // geocoded result from Places autocomplete; on confirm we replace its
  // lat/lng with the (possibly user-dragged or smart-corrected) point
  // and feed it into runEstimate.
  const [pendingAddress, setPendingAddress] = useState<AddressInfo | null>(null);
  const [assumptions, setAssumptions] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [addOns, setAddOns] = useState<AddOn[]>(DEFAULT_ADDONS);
  const [staff, setStaff] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [notes, setNotes] = useState("");
  const [estimateId, setEstimateId] = useState<string>(newId());
  const [shown, setShown] = useState(false);

  // Tier C unified pipeline result. Replaces the parallel solar/vision/
  // OSM/MSBuildings/SAM3 orchestration with a single canonical RoofData
  // feed. See lib/roof-pipeline.ts + /api/roof-pipeline.
  const [roofData, setRoofData] = useState<RoofData | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  // Tier B inspector status — surfaces a "Refining via oblique inspection…"
  // indicator while the roof-inspector call is in flight. Independent of
  // pipelineLoading because Tier B is additive and runs after Tier C lands.
  const [inspectorStatus, setInspectorStatus] = useState<
    "idle" | "running" | "done" | "skipped"
  >("idle");
  // Per-address guard: only run the inspector once per (address × Tier C
  // RoofData identity) so that minor re-renders don't re-fire the call.
  const inspectorRanForKeyRef = useRef<string | null>(null);
  // Once-per-address guard so RoofData-driven sqft / complexity seeding
  // doesn't re-stomp rep edits made after the first auto-fill.
  const roofDataAppliedForAddressRef = useRef<string | null>(null);
  // Flips to true on any user-initiated assumptions edit. Prevents the
  // pre-arrival seed effect from stomping fields the rep already touched
  // while the pipeline was still in flight (e.g. rep typed in sqft, then
  // RoofData lands and would otherwise overwrite it).
  const assumptionsTouchedRef = useRef(false);
  // Fetch-generation counter for runRoofPipelineFetch — guards against
  // out-of-order responses on rapid address switching. Each fetch captures
  // the counter; the response is dropped if the counter has moved on.
  const fetchGenRef = useRef(0);
  const [isInsuranceClaim, setIsInsuranceClaim] = useState(false);
  const [photos, setPhotos] = useState<PhotoMeta[]>([]);
  const [claim, setClaim] = useState<ClaimContext>({ carrier: "state-farm" });
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

  // `low`/`high`/`total` are derived from the Tier C `priced` memo below.
  // The actual values are assigned after `priced` is computed (so this
  // block is just a forward declaration via late `let`-style hoisting via
  // a separate memo block lower in the function).
  //
  // Kept here as a marker so search-and-replace tools find the legacy
  // call-sites if they ever appear in this region again.

  // ─── Tier C polygon state — derived from RoofData ────────────────────
  // `polygonSource` collapses to: "edited" when the rep has touched the
  // polygon, otherwise the RoofData source name (mapped to the legacy
  // Estimate.polygonSource union so downstream Roof3DViewer / Estimate
  // type still typechecks). "none" when no RoofData or RoofData failed.
  const polygonSource = useMemo<
    | "edited"
    | "sam3"
    | "solar"
    | "ai"
    | "none"
  >(() => {
    if (livePolygons && livePolygons.length) return "edited";
    if (!roofData || roofData.source === "none" || roofData.facets.length === 0) return "none";
    // Map RoofData.source → legacy union for Roof3DViewer / Estimate types:
    //   tier-c-solar  → "solar"   (Solar API photogrammetric facets)
    //   tier-c-vision → "ai"      (Claude vision fallback)
    //   tier-a/b      → "sam3"    (placeholder; lab-quality multiview/LiDAR)
    if (roofData.source === "tier-c-solar") return "solar";
    if (roofData.source === "tier-c-vision") return "ai";
    return "sam3";
  }, [livePolygons, roofData]);

  // sourcePolygons / activePolygons feed MapView + Roof3DViewer + the
  // legacy Estimate.polygons field. RoofData.facets[].polygon is the
  // canonical source-of-truth shape; livePolygons override after edit.
  const sourcePolygons:
    | Array<Array<{ lat: number; lng: number }>>
    | undefined = useMemo(() => {
    if (!roofData || roofData.source === "none") return undefined;
    return roofData.facets.map((f) => f.polygon);
  }, [roofData]);
  const activePolygons = livePolygons ?? sourcePolygons;
  const polygonReady = roofData != null && roofData.source !== "none";
  const renderedSourcePolygons = polygonReady ? sourcePolygons : undefined;

  // Tier C uses RoofData.confidence directly. The legacy 3-tier
  // (high/moderate/low) label is derived from a single number rather
  // than cross-source consensus.
  const estimateConfidence = useMemo<{
    level: "high" | "moderate" | "low";
    rationale: string;
  }>(() => {
    if (polygonSource === "edited") {
      return { level: "high", rationale: "Rep verified by hand" };
    }
    if (!roofData || roofData.source === "none") {
      return { level: "low", rationale: "No analysis available" };
    }
    const c = roofData.confidence;
    if (c >= 0.85) {
      return { level: "high", rationale: `Pipeline confidence ${c.toFixed(2)}` };
    }
    if (c >= 0.6) {
      return { level: "moderate", rationale: `Pipeline confidence ${c.toFixed(2)}` };
    }
    return { level: "low", rationale: `Pipeline confidence ${c.toFixed(2)}` };
  }, [polygonSource, roofData]);

  // claudePolygonLatLng was the pixel-space Claude trace projected to
  // lat/lng. RoofData now carries facet polygons in lat/lng directly,
  // so this is no longer needed.

  // ─── Legacy validators / polygon-priority chain — REMOVED ──────────
  // The wrong-house guard, source-priority useMemo, hallucination check,
  // coverage gate, absolute-size gate, IoU consensus, etc. all moved
  // server-side into lib/sources/* + lib/roof-pipeline.ts. RoofData
  // arrives with a single canonical polygon set and is the source of
  // truth for everything downstream.

  // ─── Tier C unified pricing — priceRoofData ─────────────────────────
  // Replaces buildDetailedEstimate. Driven by the canonical RoofData feed
  // plus the rep-side PricingInputs (material, multipliers, service type,
  // add-ons). The wasteOverridePct is left undefined so RoofData's
  // computed waste (from totals.wastePct) is the authoritative number;
  // the UI waste table is still rendered via buildWasteTable below.
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

  // Headline totals — derived directly from `priced`. priceRoofData
  // already includes add-on contributions in subtotal/total, so we don't
  // double-add them here. The v1 Estimate.baseLow / baseHigh fields
  // below also use these as-is for the same reason.
  //
  // Fallback: when the unified pipeline degrades (priced === null) but
  // the rep has typed a sqft + material + pitch, fall back to the legacy
  // computeBase/computeTotal so the headline doesn't collapse to "$0".
  // This restores the pre-Tier-C "type-in-sqft-and-see-rough-price" UX
  // for the degraded path while keeping the priced pipeline canonical
  // for happy-path estimates.
  const fallback = useMemo(() => {
    if (priced) return null;
    if (!assumptions.sqft || assumptions.sqft <= 0) return null;
    if (!assumptions.material || !assumptions.pitch) return null;
    return {
      base: computeBase(assumptions),
      total: computeTotal(assumptions, addOns),
    };
  }, [priced, assumptions, addOns]);

  const low = priced ? Math.round(priced.totalLow) : (fallback?.base.low ?? 0);
  const high = priced ? Math.round(priced.totalHigh) : (fallback?.base.high ?? 0);
  const total = priced
    ? Math.round((priced.totalLow + priced.totalHigh) / 2)
    : (fallback?.total ?? 0);

  // Legacy DetailedEstimate projection — feeds LineItemsPanel and the
  // v1-compatible Estimate object passed to OutputButtons / PDF / etc.
  // Tier C: seed assumptions.sqft + complexity from RoofData ONCE per
  // address (when the pipeline result first lands). After this initial
  // application the rep is free to edit any field — we won't stomp.
  useEffect(() => {
    if (!roofData || roofData.source === "none") return;
    const key = `${roofData.address.lat},${roofData.address.lng}`;
    if (roofDataAppliedForAddressRef.current === key) return;
    roofDataAppliedForAddressRef.current = key;
    // If the rep already edited assumptions while the pipeline was
    // in flight, don't stomp their work — leave sqft/complexity alone.
    // They can still re-trigger seeding by clicking New and re-entering.
    if (assumptionsTouchedRef.current) return;
    setAssumptions((a) => ({
      ...a,
      sqft: roofData.totals.totalRoofAreaSqft || a.sqft,
      complexity: roofData.totals.complexity,
    }));
  }, [roofData]);

  // ─── Rollout telemetry: complexity_bucket_crossed ────────────────────
  // For the first 100 estimates after Tier C rollout, compare the new
  // (RoofData-derived) complexity bucket against the legacy
  // polygon-shape inference. If they disagree, log a breadcrumb so we
  // can audit whether the new bucket lands too high or too low. The
  // counter caps the WINDOW, not the emission rate — once we've seen
  // 100 estimates the comparison stops entirely.
  const complexityDiffKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!roofData || roofData.source === "none") return;
    const key = `${roofData.address.lat},${roofData.address.lng}`;
    if (complexityDiffKeyRef.current === key) return;
    complexityDiffKeyRef.current = key;
    const COUNT_KEY = "roof_engine_complexity_diff_count";
    const count = Number(localStorage.getItem(COUNT_KEY) ?? "0");
    if (count >= 100) return;
    const newBucket = roofData.totals.complexity;
    const oldBucket = inferComplexityFromPolygons(
      roofData.facets.map((f) => f.polygon),
    );
    if (oldBucket && oldBucket !== newBucket) {
      console.log("[telemetry] complexity_bucket_crossed", {
        address: roofData.address.formatted,
        oldBucket,
        newBucket,
      });
    }
    localStorage.setItem(COUNT_KEY, String(count + 1));
  }, [roofData]);

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

  // ─── Tier C lengths — derived from RoofData.edges + RoofData.flashing ──
  // Replaces the legacy deriveRoofLengthsFromPolygons / heuristic split.
  // RoofData's classifier has already grouped edges by type, and the
  // flashing object carries the canonical drip-edge / IWS numbers.
  const lengths = useMemo(() => {
    if (!roofData || roofData.source === "none") return null;
    const sum = (type: import("@/types/roof").EdgeType) =>
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
      flashingLf:
        roofData.flashing.chimneyLf + roofData.flashing.skylightLf,
      stepFlashingLf: roofData.flashing.dormerStepLf,
      iwsSqft: roofData.flashing.iwsSqft,
      source: "polygons" as const,
    };
  }, [roofData]);

  // ─── Tier C waste table — uses RoofData.totals area + complexity ────
  // RoofData's totals.wastePct is already the suggested-row pick; the
  // multi-row UI display still uses buildWasteTable, which only needs
  // (sqft, complexity).
  const waste = useMemo(() => {
    if (!roofData || roofData.source === "none") return null;
    return buildWasteTable(
      roofData.totals.totalRoofAreaSqft,
      roofData.totals.complexity,
    );
  }, [roofData]);

  // Wrapper for setAssumptions to use at *user-driven* call sites
  // (AssumptionsEditor onChange, voice note merge, applyTier). Flips
  // assumptionsTouchedRef so the post-arrival RoofData seed effect
  // backs off and doesn't stomp the rep's edits. The seed effect itself
  // calls the raw setAssumptions so it doesn't trip its own guard.
  const userSetAssumptions: typeof setAssumptions = (updater) => {
    assumptionsTouchedRef.current = true;
    setAssumptions(updater);
  };

  /**
   * Gate between address selection and the estimate pipeline. When the
   * incoming address has a lat/lng (= user picked from autocomplete or we
   * geocoded successfully), we route it through the pin-confirmation step
   * first. Addresses without coords (manual typing, autocomplete offline)
   * skip the confirmation — the pipeline already handles those via its
   * fallback paths.
   */
  const requestEstimate = (explicitAddr?: AddressInfo) => {
    const addr: AddressInfo =
      explicitAddr ?? address ?? { formatted: addressText.trim() };
    if (!addr.formatted?.trim()) return;
    if (addr.lat == null || addr.lng == null) {
      // No coords → no map to confirm against. Run estimate directly.
      void runEstimate(addr);
      return;
    }
    setPendingAddress(addr);
  };

  /** Tier C unified pipeline call. Replaces the legacy parallel
   *  Solar/Vision/OSM/MSBuildings/SAM3 fan-out — one fetch, one
   *  canonical RoofData feed for everything downstream. */
  const runRoofPipelineFetch = async (addr: AddressInfo) => {
    if (addr.lat == null || addr.lng == null) return;
    // Bump the gen counter and capture this fetch's slot. On rapid
    // address switching, an older fetch's response will see its
    // captured myGen no longer match fetchGenRef.current and bail
    // before it can stomp the newer address's RoofData.
    const myGen = ++fetchGenRef.current;
    setPipelineLoading(true);
    setPipelineError(null);
    try {
      const nocacheSuffix = sam3NoCacheSuffix; // "&nocache=1" or ""
      const res = await fetch(
        `/api/roof-pipeline?lat=${addr.lat}&lng=${addr.lng}` +
          `&address=${encodeURIComponent(addr.formatted)}` +
          nocacheSuffix,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`pipeline ${res.status}`);
      const data = (await res.json()) as RoofData;
      if (fetchGenRef.current !== myGen) return; // stale — newer fetch won
      setRoofData(data);
    } catch (err) {
      if (fetchGenRef.current !== myGen) return;
      setPipelineError(err instanceof Error ? err.message : String(err));
      setRoofData(null);
    } finally {
      if (fetchGenRef.current === myGen) setPipelineLoading(false);
    }
  };

  /**
   * Tier B — multiview oblique refinement.
   *
   * Fires when Roof3DViewer publishes captured top-down + 4 oblique frames.
   * Sends them along with the current RoofData to /api/roof-inspector;
   * on success, swaps in the refined RoofData (with wall-step / headwall /
   * apron flashing now populated). On failure, keeps the Tier C result —
   * Tier B is additive, not load-bearing.
   *
   * Guards:
   *  - skip if RoofData is missing / degraded
   *  - skip if already refined (refinements includes "multiview-obliques")
   *  - skip if rep has edited the polygon (livePolygons set — oblique
   *    refinement is keyed off the original Tier C facet ids, edited
   *    polygons don't have facet ids to refine against)
   *  - dedupe via inspectorRanForKeyRef so a re-capture (e.g. tile reload)
   *    doesn't re-fire the call
   */
  const handleMultiViewCaptured = useCallback(
    (captured: CapturedMultiView) => {
      const data = roofData;
      if (!data || data.source === "none" || data.facets.length === 0) return;
      if (data.refinements.includes("multiview-obliques")) return;
      if (livePolygons && livePolygons.length > 0) return;
      const key = `${data.address.lat.toFixed(5)},${data.address.lng.toFixed(5)}:${data.source}:${data.facets.length}`;
      if (inspectorRanForKeyRef.current === key) return;
      inspectorRanForKeyRef.current = key;
      setInspectorStatus("running");
      (async () => {
        try {
          const { refined, patch, latencyMs } = await refineRoofDataViaMultiview({
            roofData: data,
            captured,
            imageryDate: data.imageryDate,
          });
          const didRefine = refined.refinements.includes("multiview-obliques");
          // Stale-fetch guard: address may have changed during the call.
          if (
            address?.lat == null ||
            address?.lng == null ||
            address.lat.toFixed(5) !== data.address.lat.toFixed(5) ||
            address.lng.toFixed(5) !== data.address.lng.toFixed(5)
          ) {
            return;
          }
          setRoofData(refined);
          setInspectorStatus(didRefine ? "done" : "skipped");
          console.log(
            `[internal] tier-b refinement ${didRefine ? "applied" : "gated/no-op"} (${latencyMs}ms): ` +
              `facets=${patch.facets?.length ?? 0} ` +
              `objects=${patch.objects?.length ?? 0} ` +
              `wallJunctions=${patch.wallJunctions?.length ?? 0}`,
          );
        } catch (err) {
          console.warn("[internal] tier-b refinement skipped:", err);
          setInspectorStatus("skipped");
          console.log("[telemetry] tier_b_failed", {
            address: data.address.formatted,
            source: data.source,
            reason: "client_error",
            message: err instanceof Error ? err.message : String(err),
          });
          // Don't clear the ref — failed inspector call shouldn't re-fire
          // on the same RoofData. Rep can re-analyze to force a fresh try.
        }
      })();
    },
    // address is read inside the async closure via the current React render;
    // including it in deps causes the callback identity to change on every
    // address mutation and re-fires the capture effect upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roofData, livePolygons],
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
    setLivePolygons(null);
    hasUserEditedRef.current = false;
    editOriginIsWallFootprintRef.current = false;
    // Reset pipeline state on every address change.
    setRoofData(null);
    setPipelineError(null);
    setInspectorStatus("idle");
    inspectorRanForKeyRef.current = null;
    roofDataAppliedForAddressRef.current = null;
    assumptionsTouchedRef.current = false;

    if (addr.lat == null || addr.lng == null) {
      setAssumptions((a) => ({
        ...a,
        sqft: a.sqft || estimateRoofSize(),
        ageYears: a.ageYears || estimateAge(),
      }));
      return;
    }

    // Single unified Tier C pipeline call. Cached for 1h server-side.
    // RoofData populates sqft / complexity / pitch via the one-shot
    // seeding effect below; no other client-side orchestration needed.
    await runRoofPipelineFetch(addr);
  };

  /** Merge structured fields from a voice-note into the estimate state.
   *  Each branch is conservatively gated — if the model didn't return a
   *  field, we don't touch the existing value. The rep can always edit
   *  any field manually after the merge. */
  const onVoiceNoteResult = (result: VoiceNoteResult) => {
    const s = result.structured;
    userSetAssumptions((a) => {
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

  // v1-compatible projection — feeds OutputButtons / InsightsPanel /
  // generatePdf / buildSummaryText, all of which still consume the
  // legacy Estimate shape. detailed/lengths/waste come from priced
  // (Tier C engine), polygons come from RoofData via activePolygons.
  // baseLow / baseHigh / total are taken straight from `priced` —
  // priceRoofData already folds enabled add-ons into the line items
  // and applies O&P, so adding the add-on sum on top here would
  // double-count it (this was the customer-facing range bug).
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
    baseLow: Math.round(low),
    baseHigh: Math.round(high),
    isInsuranceClaim,
    // vision / solar fields intentionally omitted in Tier C — the new
    // RoofData feed is the single source of truth and lives in EstimateV2.
    detailed: detailed ?? undefined,
    lengths: lengths ?? undefined,
    waste: waste ?? undefined,
    polygons: activePolygons ?? undefined,
    polygonSource: polygonSource === "none" ? undefined : polygonSource,
    photos: photos.length ? photos : undefined,
    claim: isInsuranceClaim ? claim : undefined,
  };

  // ─── EstimateV2 — canonical persisted shape ─────────────────────────
  // Tier C save: roofData + pricingInputs + priced + meta. The v1
  // Estimate above is still constructed for in-page consumers that
  // haven't migrated yet (OutputButtons, generatePdf, InsightsPanel),
  // but localStorage saves go through saveEstimateV2 from now on.
  const estimateV2 = useMemo<EstimateV2 | null>(() => {
    if (!roofData || roofData.source === "none" || !priced) return null;
    return {
      version: 2,
      id: estimateId,
      createdAt: new Date().toISOString(),
      staff,
      customerName,
      notes,
      address: address ?? { formatted: addressText },
      roofData,
      pricingInputs,
      priced,
      isInsuranceClaim,
      photos: photos.length ? photos : undefined,
      claim: isInsuranceClaim ? claim : undefined,
    };
  }, [
    roofData,
    priced,
    pricingInputs,
    estimateId,
    staff,
    customerName,
    notes,
    address,
    addressText,
    isInsuranceClaim,
    photos,
    claim,
  ]);

  const applyTier = (tier: ProposalTier) => {
    userSetAssumptions((a) => ({ ...a, material: tier.material }));
    setAddOns((cur) => cur.map((x) => ({ ...x, enabled: tier.includedAddOnIds.includes(x.id) })));
  };

  useKeyboardShortcuts({
    // Save prefers v2 (canonical). Falls back to legacy v1 save only
    // when no RoofData is available — defensive; this shouldn't happen
    // once the rep is on the breakdown page since v2 requires priced.
    onSave: () => {
      if (!shown) return;
      if (estimateV2) saveEstimateV2(estimateV2);
      else saveEstimate(estimate);
    },
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
    setPendingAddress(null);
    setAssumptions(DEFAULT_ASSUMPTIONS);
    setAddOns(DEFAULT_ADDONS);
    setCustomerName("");
    setNotes("");
    setEstimateId(newId());
    setShown(false);
    setIsInsuranceClaim(false);
    setPhotos([]);
    setClaim({ carrier: "state-farm" });
    setLivePolygons(null);
    setRoofData(null);
    setPipelineError(null);
    // Clear in-flight pipeline state — bumping fetchGenRef invalidates
    // any pending fetch so its eventual resolution can't re-set roofData
    // or pipelineLoading after the rep has hit New.
    setPipelineLoading(false);
    fetchGenRef.current++;
    roofDataAppliedForAddressRef.current = null;
    assumptionsTouchedRef.current = false;
    hasUserEditedRef.current = false;
    editOriginIsWallFootprintRef.current = false;
  };

  const mapBadges = (() => {
    const badges: string[] = [];
    // Tier C: imagery date + source + confidence chip — all from RoofData.
    if (roofData?.imageryDate) badges.push(`Imagery ${roofData.imageryDate}`);
    if (polygonSource === "edited") badges.push("Edited");
    else if (roofData?.source === "tier-c-solar") badges.push("Solar facets");
    else if (roofData?.source === "tier-c-vision") badges.push("AI traced");
    else if (roofData?.source === "tier-b-multiview") badges.push("Multi-view");
    else if (roofData?.source === "tier-a-lidar") badges.push("LiDAR");
    if (roofData && roofData.source !== "none" && roofData.totals.facetsCount > 0) {
      badges.push(`${roofData.totals.facetsCount} facet${roofData.totals.facetsCount === 1 ? "" : "s"}`);
    }
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
      {pendingAddress && pendingAddress.lat != null && pendingAddress.lng != null && (
        <div className="fixed inset-0 z-[200] bg-black/95">
          <ConfirmHomePin
            address={pendingAddress.formatted}
            geocodedLatLng={{
              lat: pendingAddress.lat,
              lng: pendingAddress.lng,
            }}
            onConfirm={(confirmed) => {
              const finalAddr: AddressInfo = {
                ...pendingAddress,
                lat: confirmed.lat,
                lng: confirmed.lng,
              };
              setPendingAddress(null);
              void runEstimate(finalAddr);
            }}
            onCancel={() => {
              setPendingAddress(null);
              setAddress(null);
            }}
          />
        </div>
      )}
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
          onSubmit={requestEstimate}
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

      {/* Pipeline error chip — surfaces /api/roof-pipeline failures.
          Without this the loader disappears and the rep sees nothing
          else explaining why measurements never landed. Placed above the
          empty-state / property section so it's visible regardless of
          whether shown=true. Hidden while the loader is up (the overlay
          covers it anyway). */}
      {pipelineError && !pipelineLoading && (
        <div
          className="rounded-md border border-red-400/30 bg-red-50/95 px-3 py-2 text-sm text-red-900"
          role="alert"
        >
          Pipeline error: {pipelineError}. Try the &ldquo;re-analyze&rdquo; button or reload.
        </div>
      )}

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
      {pipelineLoading && (
        <div
          // No backdrop-blur — the filter forces full-page recomposite every
          // frame, which thrashes against Cesium's WebGL canvas underneath
          // and made the loader animation visibly stutter. A solid fill at
          // 88% darkness reads almost the same and stays smooth.
          className="fixed inset-0 z-50 flex items-center justify-center float-in"
          style={{ background: "rgba(7,9,13,0.88)" }}
          aria-live="polite"
        >
          <QuantumPulseLoader text="Analyzing roof" />
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
              roofData?.imageryDate && (
                <span
                  className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slate-500"
                  title="Imagery capture date from the pipeline source (Solar API / vision tile)."
                >
                  Imagery {roofData.imageryDate}
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
              // Tier C: pitch comes from RoofData totals (average across
              // facets) rather than Solar API's single per-roof number.
              pitchDegrees={
                roofData && roofData.source !== "none"
                  ? roofData.totals.averagePitchDegrees
                  : null
              }
              // Pin-override / pickingBuilding intentionally dropped —
              // see TODO above. MapView's pickingBuilding prop is optional;
              // omitting it disables the pick UI entirely.
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
            address?.lng != null &&
            roofData?.source === "tier-a-lidar" ? (
              // Tier A path — LiDAR-derived facets + edges + objects rendered
              // on top of Google Photorealistic 3D Tiles via RoofViewer.
              <div
                className="glass-panel overflow-hidden h-full relative"
                aria-label={`3D LiDAR-derived view of the roof at ${address.formatted ?? "this property"}`}
                role="img"
              >
                <RoofViewer
                  key={`lidar-${address.lat.toFixed(6)},${address.lng.toFixed(6)}`}
                  data={roofData}
                  interactive
                />
              </div>
            ) : polygonReady &&
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
                  imageryDate={roofData?.imageryDate ?? null}
                  expectedFootprintSqft={
                    roofData?.totals.totalFootprintSqft ?? null
                  }
                  onMultiViewCaptured={handleMultiViewCaptured}
                  interactive
                />
                {(inspectorStatus === "running" ||
                  inspectorStatus === "done") &&
                  roofData &&
                  roofData.source !== "none" && (
                    <div
                      className="absolute bottom-2.5 left-2.5 z-10 chip backdrop-blur-md bg-[#07090d]/65 pointer-events-none"
                      role="status"
                      aria-live="polite"
                    >
                      {inspectorStatus === "running"
                        ? "Roof inspector: analyzing obliques…"
                        : `Roof inspector ✓ (${roofData.refinements.length} refinement${roofData.refinements.length === 1 ? "" : "s"})`}
                    </div>
                  )}
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

          {/* Tier C drops the "Wrong building? Click to pick" affordance —
              it depended on /api/sam3-roof's pin-override path which isn't
              wired into the new unified pipeline yet.
              TODO(Tier B): re-introduce pin-override via /api/roof-pipeline
              once the pipeline supports a clickLat/clickLng query. Pin
              confirmation (ConfirmHomePin) still catches initial geocode
              mistakes. */}

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
            imageryDate={roofData?.imageryDate ?? null}
            lat={address?.lat}
            lng={address?.lng}
          />

          {/* OutlineQualityWarning intentionally dropped in Tier C —
              its source/Claude-verifier model is gone now that RoofData
              is canonical.
              TODO(Tier B): surface multiview-derived outline quality
              concerns from roofData.diagnostics (warnings / needsReview). */}

          {/* PolygonSizeWarning intentionally dropped in Tier C — it
              compared assumptions.sqft against Solar's footprint, but
              RoofData has only one canonical area (totals.totalRoofAreaSqft)
              now, so there's no second source to compare against.
              TODO(Tier B): detect when rep-edited polygon's derived sqft
              diverges from Solar's expectation. */}

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

          {/* ═══ 05 BREAKDOWN — line items, measurements, customer detail ═ */}
          <SectionHeader
            index={4}
            title="Breakdown & detail"
            caption="Internal worksheet · not shown to customer"
          />

          {/* ─── Two-col grid for everything else ─────────────────────── */}
          <div className="grid lg:grid-cols-3 gap-6 float-in">
            <div className="lg:col-span-2 space-y-6">
              {/* Tier C unified-pipeline panels. Driven entirely from
                  RoofData (single canonical feed). */}
              {roofData && roofData.source !== "none" && (
                <>
                  <RoofTotalsCard data={roofData} />
                  <DetectedFeaturesPanel data={roofData} variant="rep" />
                  {priced && <FacetList data={roofData} priced={priced} />}
                </>
              )}
              {roofData?.source === "none" && (
                <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-900">
                  We couldn&rsquo;t analyze this address. Attempts:{" "}
                  {roofData.diagnostics.attempts
                    .map((a) => `${a.source}=${a.outcome}`)
                    .join(", ")}
                </div>
              )}
              {/* Tier C drops the legacy VisionPanel — DetectedFeaturesPanel
                  (mounted above) covers the same surface (counts, age
                  warnings) with RoofData as the canonical feed. */}
              <TiersPanel assumptions={assumptions} addOns={addOns} onApplyTier={applyTier} />
              {lengths && waste && (
                <MeasurementsPanel
                  lengths={lengths}
                  waste={waste}
                  defaultOpen={isInsuranceClaim || BRAND_CONFIG.showXactimateCodes}
                />
              )}
              {detailed && (
                <LineItemsPanel
                  detailed={detailed}
                  defaultOpen={isInsuranceClaim || BRAND_CONFIG.showXactimateCodes}
                  alwaysShowXactimate={isInsuranceClaim || BRAND_CONFIG.showXactimateCodes}
                />
              )}
              <div className="grid md:grid-cols-2 gap-6">
                <AssumptionsEditor value={assumptions} onChange={userSetAssumptions} />
                <AddOnsPanel addOns={addOns} onChange={setAddOns} />
              </div>
            </div>
            <div className="space-y-6">
              <PropertyContextPanel address={address} />
              <StormHistoryCard lat={address?.lat} lng={address?.lng} />
              <PhotoUploadPanel photos={photos} onChange={setPhotos} />
              <div className="glass-panel p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-display font-semibold tracking-tight">Customer & Notes</div>
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
                  style={{ minHeight: 90, resize: "vertical", lineHeight: 1.5 }}
                />
              </div>
              <div className="glass-panel p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-display font-semibold tracking-tight">Output</div>
                  <span className="label">deliver</span>
                </div>
                <OutputButtons
                  estimate={estimate}
                  office={office}
                  // /internal owns the full save flow (localStorage +
                  // Supabase POST). When we have an EstimateV2 we send
                  // the v2 snapshot to BOTH — so the dashboard's
                  // /dashboard/proposals/[publicId] page sees the
                  // canonical Tier C shape from rep-tool saves, not
                  // just from /quote submits. Without this, /internal
                  // saved v2 locally but POSTed a v1 projection to
                  // Supabase, leaving the dashboard's v2 renderer
                  // permanently unreachable from rep workflow.
                  onSave={async () => {
                    if (estimateV2) {
                      saveEstimateV2(estimateV2);
                      try {
                        await fetch("/api/proposals", {
                          method: "POST",
                          credentials: "same-origin",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            estimate: estimateV2,
                            office,
                          }),
                        });
                      } catch (err) {
                        console.warn(
                          "[internal] supabase v2 save failed:",
                          err,
                        );
                      }
                    } else {
                      // Pre-pipeline save (no RoofData yet) — fall back
                      // to the legacy v1 flow so the rep still has
                      // something to come back to.
                      saveEstimate(estimate);
                      try {
                        await fetch("/api/proposals", {
                          method: "POST",
                          credentials: "same-origin",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            estimate,
                            office,
                          }),
                        });
                      } catch (err) {
                        console.warn(
                          "[internal] supabase v1 save failed:",
                          err,
                        );
                      }
                    }
                  }}
                />
              </div>
              <InsightsPanel estimate={estimate} />
            </div>
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
                : polygonSource === "solar"
                  ? "Solar facets"
                  : polygonSource === "ai"
                    ? "AI traced"
                    : polygonSource === "sam3"
                      ? "Pipeline"
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
  return (
    <Suspense fallback={null}>
      <HomePageInner />
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


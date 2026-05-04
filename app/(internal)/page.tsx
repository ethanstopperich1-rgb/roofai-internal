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
  // ground). High-priority source — uses real geometric height data so
  // there's no AI/satellite-image guessing involved.
  const [tiles3dPolygon, setTiles3dPolygon] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  // Roboflow Hosted Inference — roof-specific instance segmentation on the
  // same satellite tile the rest of the pipeline uses. Bake-off in
  // scripts/eval-roboflow.ts picked Satellite Rooftop Map (v3) — nailed a
  // hip-roof house at 92% confidence where tiles3d-vision had been
  // returning a wrong-angle rectangle.
  const [roboflowPolygon, setRoboflowPolygon] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
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
  const handlePolygonsChanged = useCallback(
    (polys: Array<Array<{ lat: number; lng: number }>>) => {
      hasUserEditedRef.current = true;
      setLivePolygons(polys);
    },
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

  // Wrong-house guard. Every auto-detected polygon must contain (or be within
  // 15 m of) the geocoded address. Catches the failure mode where AI traces
  // the brightest neighbouring roof rather than the actual target. Returns
  // the polygon when valid, null when it should be rejected.
  const validateAtAddress = (
    poly: Array<{ lat: number; lng: number }> | null,
  ): Array<{ lat: number; lng: number }> | null => {
    if (!poly || poly.length < 3) return null;
    if (address?.lat == null || address?.lng == null) return poly;
    return polygonIsNearAddress(poly, address.lat, address.lng, 15) ? poly : null;
  };

  const validTiles3d = useMemo(() => validateAtAddress(tiles3dPolygon), [tiles3dPolygon, address?.lat, address?.lng]);
  const validSolarMask = useMemo(() => validateAtAddress(solarMaskPolygon), [solarMaskPolygon, address?.lat, address?.lng]);
  const validRoboflow = useMemo(() => validateAtAddress(roboflowPolygon), [roboflowPolygon, address?.lat, address?.lng]);
  const validSam = useMemo(() => validateAtAddress(samRefinedPolygon), [samRefinedPolygon, address?.lat, address?.lng]);
  const validOsm = useMemo(() => validateAtAddress(osmBuildingPolygon), [osmBuildingPolygon, address?.lat, address?.lng]);
  const validClaude = useMemo(() => validateAtAddress(claudePolygonLatLng), [claudePolygonLatLng, address?.lat, address?.lng]);

  // Polygon source priority — best-quality first:
  //   1. 3D Tiles mesh   — height-thresholded from Google's photogrammetry
  //                        (real geometric truth, no AI guessing)
  //   2. Solar mask      — Project Sunroof's roof segmentation
  //   3. Roboflow        — roof-trained instance segmenter on the satellite
  //                        tile (Satellite Rooftop Map v3)
  //   4. Solar facets    — multi-facet bboxes from findClosest (axis-aligned
  //                        but useful for ridge/valley counting)
  //   5. SAM 2 + OSM     — point-prompted SAM with OSM building clip
  //   6. OSM             — human-traced building outline (~50-60% US)
  //   7. Claude vision   — Claude on the 2D satellite tile. Less precise
  //                        than the segmenters above; rep should usually
  //                        review and edit before pricing.
  //
  // tiles3d-vision (Claude on multi-angle 3D mesh renders) was REMOVED —
  // it consistently produced over-traced rectangles even after camera
  // pull-back + verification pass. Claude's general vision can't reliably
  // pixel-trace eaves; roof-specific segmenters are needed for that
  // accuracy class.
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
    | "ai"
    | "none"
  >(() => {
    if (livePolygons && livePolygons.length) return "edited";
    if (validTiles3d) return "tiles3d";
    if (validSolarMask) return "solar-mask";
    if (validRoboflow) return "roboflow";
    if (solar?.segmentPolygonsLatLng?.length && solar.segmentCount > 1) return "solar";
    if (validSam) return "sam";
    if (validOsm) return "osm";
    if (validClaude) return "ai";
    return "none";
  }, [
    livePolygons,
    validTiles3d,
    validSolarMask,
    validRoboflow,
    solar?.segmentPolygonsLatLng,
    solar?.segmentCount,
    validSam,
    validOsm,
    validClaude,
  ]);

  // Source polygons — what MapView draws initially. Edited polygons don't
  // come back through this prop (would cause a redraw loop / cancel the
  // user's drag). They flow back via onPolygonsChanged → livePolygons.
  const sourcePolygons:
    | Array<Array<{ lat: number; lng: number }>>
    | undefined = useMemo(() => {
    if (validTiles3d) return [validTiles3d];
    if (validSolarMask) return [validSolarMask];
    if (validRoboflow) return [validRoboflow];
    if (solar?.segmentPolygonsLatLng?.length && solar.segmentCount > 1)
      return solar.segmentPolygonsLatLng;
    if (validSam) return [validSam];
    if (validOsm) return [validOsm];
    if (validClaude) return [validClaude];
    return undefined;
  }, [
    validTiles3d,
    validSolarMask,
    validRoboflow,
    solar?.segmentPolygonsLatLng,
    solar?.segmentCount,
    validSam,
    validOsm,
    validClaude,
  ]);

  // Active polygons — what we use for sqft, lengths, blueprint, PDF.
  // Live edits override source.
  const activePolygons = livePolygons ?? sourcePolygons;

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

  // Whenever the active polygon changes, sync the derived roof area into
  // assumptions.sqft so map label, blueprint label, and line-item engine
  // all read the same number. Solar API takes precedence — if Solar gave
  // us a sqft, we trust that and don't override.
  useEffect(() => {
    if (solar?.sqft) return; // Solar already populated assumptions.sqft elsewhere
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
  }, [activePolygons, solar?.sqft, solar?.pitchDegrees, assumptions.pitch]);

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
    setTiles3dPolygon(null);
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
    setLivePolygons(null);
    setOsmBuildingPolygon(null);
    setSamRefinedPolygon(null);
    setSolarMaskPolygon(null);
    setRoboflowPolygon(null);
    setTiles3dPolygon(null);
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
    else if (polygonSource === "ai") badges.push("AI traced");
    else if (samRefining) badges.push("Refining…");
    else if (solar?.segmentCount && solar.segmentCount > 0) badges.push(`${solar.segmentCount} segments`);
    if (solar?.pitch) badges.push(`Pitch ${solar.pitch}`);
    return badges;
  })();

  return (
    <div className="space-y-7">
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
          {/* ─── Map hero — satellite + 3D side-by-side, full width ─────── */}
          <section className="grid lg:grid-cols-2 gap-4 h-[420px] sm:h-[520px] lg:h-[640px] float-in">
            <MapView
              lat={address?.lat}
              lng={address?.lng}
              address={address?.formatted}
              segments={sourcePolygons}
              penetrations={filteredPenetrations}
              metaBadges={mapBadges}
              editable={polygonSource !== "none"}
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
                polygons={activePolygons}
                polygonSource={polygonSource === "none" ? undefined : polygonSource}
                onTilesPolygonDetected={(poly) => {
                  if (!hasUserEditedRef.current) setTiles3dPolygon(poly);
                }}
              />
            )}
          </section>

          {/* ─── Parametric 3D roof framing (gables, ridges, eaves, rakes) ─ */}
          {activePolygons && activePolygons.length > 0 && (
            <ErrorBoundary>
              <ParametricRoofViewer
                polygon={activePolygons[0]}
                pitch={assumptions.pitch}
              />
            </ErrorBoundary>
          )}

          {/* ─── Architectural blueprint of the traced roof ─────────────── */}
          {activePolygons && activePolygons.length > 0 && (
            <RoofBlueprint
              polygons={activePolygons}
              editing={polygonSource === "edited"}
              pitchDegrees={solar?.pitchDegrees ?? null}
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
                            : polygonSource === "ai"
                              ? "AI traced"
                              : polygonSource === "edited"
                                ? "Edited by hand"
                                : undefined
              }
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

          {/* ─── Two-col grid for everything else ─────────────────────── */}
          <div className="grid lg:grid-cols-3 gap-6 float-in">
            <div className="lg:col-span-2 space-y-6">
              <VisionPanel vision={vision} loading={visionLoading} error={visionError} />
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
  const v = polys[0].length;
  if (v <= 4) return 2;
  if (v <= 6) return 3;
  if (v <= 8) return 4;
  if (v <= 10) return 5;
  return 6;
}

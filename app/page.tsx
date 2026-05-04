"use client";

import { useEffect, useMemo, useState } from "react";
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
} from "@/lib/roof-geometry";
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
  const [propertyAttomYearBuilt, setPropertyAttomYearBuilt] = useState<number | null>(null);
  const [osmBuildingPolygon, setOsmBuildingPolygon] = useState<
    Array<{ lat: number; lng: number }> | null
  >(null);
  // Live polygons after the rep edits a vertex. When set, overrides the
  // auto-detected source polygons everywhere (lengths, sqft, blueprint, PDF).
  // Reset to null on every new estimate so we always start from auto-detect.
  const [livePolygons, setLivePolygons] = useState<
    Array<Array<{ lat: number; lng: number }>> | null
  >(null);

  // ATTOM yearBuilt → ageYears (rep can still override manually)
  useEffect(() => {
    if (propertyAttomYearBuilt) {
      const age = new Date().getFullYear() - propertyAttomYearBuilt;
      if (age > 0 && age < 150) {
        setAssumptions((a) => ({ ...a, ageYears: age }));
      }
    }
  }, [propertyAttomYearBuilt]);

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
    const poly = vision?.roofPolygon;
    if (!poly || poly.length < 3) return null;
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

  // Polygon source priority — best-quality first:
  //   1. Solar API per-facet polygons (metros only, ~30% of US)
  //   2. OpenStreetMap building footprint (human-traced, ~50-60% US)
  //   3. Claude vision polygon (fallback for everywhere else)
  const polygonSource = useMemo<"edited" | "solar" | "osm" | "ai" | "none">(() => {
    if (livePolygons && livePolygons.length) return "edited";
    if (solar?.segmentPolygonsLatLng?.length) return "solar";
    if (osmBuildingPolygon) return "osm";
    if (claudePolygonLatLng) return "ai";
    return "none";
  }, [livePolygons, solar?.segmentPolygonsLatLng, osmBuildingPolygon, claudePolygonLatLng]);

  // Source polygons — what MapView draws initially. Edited polygons don't
  // come back through this prop (would cause a redraw loop / cancel the
  // user's drag). They flow back via onPolygonsChanged → livePolygons.
  const sourcePolygons:
    | Array<Array<{ lat: number; lng: number }>>
    | undefined = useMemo(() => {
    if (solar?.segmentPolygonsLatLng?.length) return solar.segmentPolygonsLatLng;
    if (osmBuildingPolygon) return [osmBuildingPolygon];
    if (claudePolygonLatLng) return [claudePolygonLatLng];
    return undefined;
  }, [solar?.segmentPolygonsLatLng, osmBuildingPolygon, claudePolygonLatLng]);

  // Active polygons — what we use for sqft, lengths, blueprint, PDF.
  // Live edits override source.
  const activePolygons = livePolygons ?? sourcePolygons;

  const detailed = useMemo(
    () =>
      buildDetailedEstimate(assumptions, addOns, {
        buildingFootprintSqft: solar?.buildingFootprintSqft ?? null,
        segmentCount: solar?.segmentCount ?? activePolygons?.length,
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
      segmentCount: solar?.segmentCount ?? activePolygons?.length,
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
    setLivePolygons(null);

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

    const [solarData, visionData, osmData] = await Promise.all([
      solarPromise,
      visionPromise,
      osmPromise,
    ]);

    if (solarData) setSolar(solarData);
    if (visionData) setVision(visionData);
    if (osmData) setOsmBuildingPolygon(osmData);
    setVisionLoading(false);

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
  };

  const mapBadges = (() => {
    const badges: string[] = [];
    if (solar?.imageryDate) badges.push(`Imagery ${solar.imageryDate}`);
    if (solar && solar.imageryQuality !== "UNKNOWN") badges.push(`Quality ${solar.imageryQuality}`);
    if (polygonSource === "edited") badges.push("Edited");
    else if (polygonSource === "osm") badges.push("OSM traced");
    else if (polygonSource === "ai") badges.push("AI traced");
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
            <div className="hidden md:flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-slate-500">
              <span>address</span>
              <span className="w-3 h-px bg-slate-600" />
              <span>analyze</span>
              <span className="w-3 h-px bg-slate-600" />
              <span>review</span>
              <span className="w-3 h-px bg-slate-600" />
              <span className="text-cy-300">deliver</span>
            </div>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input
              className="input flex-1 sm:flex-none sm:w-44 text-[13px]"
              placeholder="Your name"
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
            />
            {shown && (
              <button className="btn btn-ghost flex-shrink-0" onClick={reset}>
                <RotateCcw size={14} /> <span className="hidden sm:inline">New</span>
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
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md bg-black/55 float-in"
          aria-live="polite"
        >
          <QuantumPulseLoader text="Generating" />
        </div>
      )}

      {shown && (
        <>
          {/* ─── Map hero — satellite + Street View, full width ─────────── */}
          <section className="relative h-[420px] sm:h-[520px] lg:h-[640px] float-in">
            <MapView
              lat={address?.lat}
              lng={address?.lng}
              address={address?.formatted}
              segments={sourcePolygons}
              penetrations={vision?.penetrations}
              metaBadges={mapBadges}
              editable={polygonSource !== "none"}
              onPolygonsChanged={setLivePolygons}
            />
          </section>

          {/* ─── Architectural blueprint of the traced roof ─────────────── */}
          {activePolygons && activePolygons.length > 0 && (
            <RoofBlueprint
              polygons={activePolygons}
              totalRoofSqft={assumptions.sqft}
              editing={polygonSource === "edited"}
              sourceLabel={
                polygonSource === "solar"
                  ? `Solar · ${activePolygons.length} ${activePolygons.length === 1 ? "facet" : "facets"}`
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
              <PropertyContextPanel
                address={address}
                onProperty={(p) => setPropertyAttomYearBuilt(p?.yearBuilt ?? null)}
              />
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

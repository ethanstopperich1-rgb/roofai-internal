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
import { Plus, RotateCcw, Sparkles, Zap, Sparkle, Loader2 } from "lucide-react";

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
  const [refinedPolygons, setRefinedPolygons] = useState<
    Array<Array<{ lat: number; lng: number }>> | null
  >(null);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string>("");

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
    const s = localStorage.getItem("roofai.staff");
    if (s) setStaff(s);
  }, []);
  useEffect(() => {
    if (staff) localStorage.setItem("roofai.staff", staff);
  }, [staff]);

  const { low, high } = useMemo(() => {
    const b = computeBase(assumptions);
    return { low: b.low, high: b.high };
  }, [assumptions]);

  const total = useMemo(() => computeTotal(assumptions, addOns), [assumptions, addOns]);

  // Prefer SAM-refined polygons over Solar API bounding boxes when both exist
  const activePolygons = refinedPolygons ?? solar?.segmentPolygonsLatLng;

  const detailed = useMemo(
    () =>
      buildDetailedEstimate(assumptions, addOns, {
        buildingFootprintSqft: solar?.buildingFootprintSqft ?? null,
        segmentCount: refinedPolygons?.length ?? solar?.segmentCount,
        segmentPolygonsLatLng: activePolygons,
      }),
    [assumptions, addOns, solar, refinedPolygons, activePolygons]
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
      segmentCount: refinedPolygons?.length ?? solar?.segmentCount,
      complexity,
      pitch: assumptions.pitch,
    });
  }, [assumptions, solar, refinedPolygons, activePolygons]);

  const waste = useMemo(
    () => buildWasteTable(assumptions.sqft, assumptions.complexity ?? "moderate"),
    [assumptions.sqft, assumptions.complexity],
  );

  const runEstimate = async () => {
    if (!addressText.trim()) return;
    const addr: AddressInfo = address ?? { formatted: addressText.trim() };
    setAddress(addr);
    setShown(true);
    setSolar(null);
    setVision(null);
    setVisionError("");
    setRefinedPolygons(null);
    setRefineError("");

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

    const [solarData, visionData] = await Promise.all([solarPromise, visionPromise]);

    if (solarData) setSolar(solarData);
    if (visionData) setVision(visionData);
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
    setRefinedPolygons(null);
    setRefineError("");
  };

  const refineOutline = async () => {
    if (!address?.lat || !address?.lng || refining) return;
    setRefining(true);
    setRefineError("");
    try {
      const res = await fetch("/api/refine-polygons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: address.lat, lng: address.lng }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `refine_${res.status}`);
      }
      const data = (await res.json()) as {
        polygons: Array<{ latLng: Array<{ lat: number; lng: number }> }>;
      };
      setRefinedPolygons(data.polygons.map((p) => p.latLng));
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : "failed");
    } finally {
      setRefining(false);
    }
  };

  const mapBadges = (() => {
    const badges: string[] = [];
    if (solar?.imageryDate) badges.push(`Imagery ${solar.imageryDate}`);
    if (solar && solar.imageryQuality !== "UNKNOWN") badges.push(`Quality ${solar.imageryQuality}`);
    if (refinedPolygons) badges.push(`SAM • ${refinedPolygons.length} facets`);
    else if (solar?.segmentCount && solar.segmentCount > 0) badges.push(`${solar.segmentCount} segments`);
    if (solar?.pitch) badges.push(`Pitch ${solar.pitch}`);
    return badges;
  })();

  return (
    <div className="space-y-7">
      {/* ─── Hero / address bar ─────────────────────────────────────── */}
      <section className="glass-strong rounded-3xl p-7 md:p-9 relative overflow-hidden">
        <div
          className="absolute -top-32 -right-24 w-[420px] h-[420px] rounded-full blur-3xl pointer-events-none opacity-50"
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
              <span>solar + vision</span>
              <span className="w-3 h-px bg-slate-600" />
              <span>review</span>
              <span className="w-3 h-px bg-slate-600" />
              <span className="text-cy-300">deliver</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="input w-44 text-[13px]"
              placeholder="Your name"
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
            />
            {shown && (
              <button className="btn btn-ghost" onClick={reset}>
                <RotateCcw size={14} /> New
              </button>
            )}
          </div>
        </div>

        <h1 className="font-display text-4xl md:text-[44px] leading-[1.05] tracking-tight font-medium mb-1.5">
          Where are we{" "}
          <span className="bg-gradient-to-r from-cy-300 via-cy-400 to-mint bg-clip-text text-transparent">
            roofing
          </span>{" "}
          today?
        </h1>
        <p className="text-[13.5px] text-slate-400 mb-6 max-w-xl">
          Type or paste an address. Pick a suggestion — Solar API + Claude vision run in parallel.
        </p>

        <AddressInput
          value={addressText}
          onChange={setAddressText}
          onSelect={setAddress}
          onSubmit={runEstimate}
        />
      </section>

      {!shown && <EmptyState />}

      {shown && (
        <>
          {/* ─── Map hero — satellite + Street View, full width ─────────── */}
          <section className="relative h-[640px] float-in">
            <MapView
              lat={address?.lat}
              lng={address?.lng}
              address={address?.formatted}
              segments={activePolygons}
              penetrations={vision?.penetrations}
              metaBadges={mapBadges}
            />
            {address?.lat && (
              <div className="absolute right-3 top-3 z-10 flex flex-col items-end gap-2">
                <button
                  onClick={refineOutline}
                  disabled={refining}
                  className="btn btn-ghost py-2 px-3.5 text-[12px] backdrop-blur"
                  style={{
                    background: "rgba(15, 19, 26, 0.78)",
                    borderColor: refinedPolygons
                      ? "rgba(95, 227, 176, 0.55)"
                      : "rgba(95, 227, 176, 0.35)",
                  }}
                >
                  {refining ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Sparkle size={12} className="text-mint" />
                  )}
                  {refining
                    ? "Tracing roof…"
                    : refinedPolygons
                      ? `SAM · ${refinedPolygons.length} facets`
                      : "Refine outline (SAM)"}
                </button>
                {refineError && (
                  <div
                    className="max-w-[260px] rounded-lg border px-3 py-2 text-[11px] backdrop-blur"
                    style={{
                      background: "rgba(60, 16, 24, 0.78)",
                      borderColor: "rgba(244, 63, 94, 0.35)",
                      color: "#fda4af",
                    }}
                  >
                    {refineError === "no_polygons"
                      ? "Couldn't extract a clean roof outline."
                      : refineError === "Missing REPLICATE_API_TOKEN"
                        ? "Set REPLICATE_API_TOKEN in .env.local."
                        : `Refinement failed: ${refineError}`}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ─── Headline price card — full width ──────────────────────── */}
          <ResultsPanel
            address={estimate.address}
            assumptions={assumptions}
            total={total}
            baseLow={estimate.baseLow}
            baseHigh={estimate.baseHigh}
            isInsuranceClaim={isInsuranceClaim}
            onInsuranceChange={setIsInsuranceClaim}
          />

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
      title: "Solar + Vision auto-fill on address pick",
      body: "Roof size, pitch, material, complexity — pulled from Google Solar API and Claude vision in parallel.",
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

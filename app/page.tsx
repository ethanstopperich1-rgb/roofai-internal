"use client";

import { useEffect, useMemo, useState } from "react";
import AddressInput from "@/components/AddressInput";
import AssumptionsEditor from "@/components/AssumptionsEditor";
import AddOnsPanel from "@/components/AddOnsPanel";
import ResultsPanel from "@/components/ResultsPanel";
import OutputButtons from "@/components/OutputButtons";
import MapView from "@/components/MapView";
import InsightsPanel from "@/components/InsightsPanel";
import VisionPanel from "@/components/VisionPanel";
import LineItemsPanel from "@/components/LineItemsPanel";
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
import { BRAND_CONFIG } from "@/lib/branding";
import { estimateAge, estimateRoofSize } from "@/lib/utils";
import { newId } from "@/lib/storage";

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

  useEffect(() => {
    const s = localStorage.getItem("roofai.staff");
    if (s) setStaff(s);
  }, []);
  useEffect(() => {
    if (staff) localStorage.setItem("roofai.staff", staff);
  }, [staff]);

  const { mid, low, high } = useMemo(() => {
    const b = computeBase(assumptions);
    return { mid: b.mid, low: b.low, high: b.high };
  }, [assumptions]);

  const total = useMemo(() => computeTotal(assumptions, addOns), [assumptions, addOns]);

  const detailed = useMemo(
    () =>
      buildDetailedEstimate(assumptions, addOns, {
        buildingFootprintSqft: solar?.buildingFootprintSqft ?? null,
        segmentCount: solar?.segmentCount,
      }),
    [assumptions, addOns, solar],
  );

  const runEstimate = async () => {
    if (!addressText.trim()) return;
    const addr: AddressInfo = address ?? { formatted: addressText.trim() };
    setAddress(addr);
    setShown(true);
    setSolar(null);
    setVision(null);
    setVisionError("");

    if (addr.lat == null || addr.lng == null) {
      setAssumptions((a) => ({
        ...a,
        sqft: a.sqft || estimateRoofSize(),
        ageYears: a.ageYears || estimateAge(),
      }));
      return;
    }

    // Fire Solar + Vision in parallel
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
      // Solar API priors
      if (solarData?.sqft) next.sqft = solarData.sqft;
      if (solarData?.pitch) next.pitch = solarData.pitch;
      // Vision priors (only when high-confidence)
      if (visionData && visionData.confidence >= 0.5) {
        const matMap = VISION_MATERIAL_TO_ASSUMPTION[visionData.currentMaterial];
        if (matMap) next.material = matMap;
        if (visionData.estimatedAgeYears) next.ageYears = visionData.estimatedAgeYears;
        next.complexity = visionData.complexity;
      }
      // Heuristic fallbacks if both APIs were silent
      if (!next.sqft) next.sqft = estimateRoofSize();
      if (!next.ageYears) next.ageYears = estimateAge();
      return next;
    });
  };

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
    baseLow: Math.round(low + addOns.filter((a) => a.enabled).reduce((s, x) => s + x.price, 0)),
    baseHigh: Math.round(high + addOns.filter((a) => a.enabled).reduce((s, x) => s + x.price, 0)),
    isInsuranceClaim,
    vision: vision ?? undefined,
    solar: solar ?? undefined,
    detailed,
  };

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

  // Discard mid since it's only used to compute low/high above
  void mid;

  const mapBadges = solar
    ? [
        solar.imageryDate ? `Imagery ${solar.imageryDate}` : "",
        solar.imageryQuality !== "UNKNOWN" ? `Quality ${solar.imageryQuality}` : "",
        solar.segmentCount > 0 ? `${solar.segmentCount} segments` : "",
        solar.pitch ? `Pitch ${solar.pitch}` : "",
      ].filter(Boolean)
    : [];

  return (
    <div className="space-y-6">
      <div className="glass-strong rounded-2xl p-6">
        <div className="flex items-end justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h1 className="text-2xl md:text-3xl font-black tracking-tight">Quick Estimate</h1>
            <p className="text-sm text-slate-400">
              Type or paste an address. Press Enter — Solar + Claude vision run in parallel.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="input w-44"
              placeholder="Your name"
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
            />
            {shown && (
              <button className="btn btn-ghost" onClick={reset}>
                New
              </button>
            )}
          </div>
        </div>
        <AddressInput
          value={addressText}
          onChange={setAddressText}
          onSelect={setAddress}
          onSubmit={runEstimate}
        />
      </div>

      {shown && (
        <>
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <ResultsPanel
                address={estimate.address}
                assumptions={assumptions}
                total={total}
                baseLow={estimate.baseLow}
                baseHigh={estimate.baseHigh}
                isInsuranceClaim={isInsuranceClaim}
                onInsuranceChange={setIsInsuranceClaim}
              />
              <VisionPanel vision={vision} loading={visionLoading} error={visionError} />
              <LineItemsPanel
                detailed={detailed}
                defaultOpen={isInsuranceClaim || BRAND_CONFIG.showXactimateCodes}
                alwaysShowXactimate={
                  isInsuranceClaim || BRAND_CONFIG.showXactimateCodes
                }
              />
              <div className="grid md:grid-cols-2 gap-6">
                <AssumptionsEditor value={assumptions} onChange={setAssumptions} />
                <AddOnsPanel addOns={addOns} onChange={setAddOns} />
              </div>
            </div>
            <div className="space-y-6">
              <div className="h-[420px]">
                <MapView
                  lat={address?.lat}
                  lng={address?.lng}
                  address={address?.formatted}
                  segments={solar?.segmentPolygonsLatLng}
                  metaBadges={mapBadges}
                />
              </div>
              <div className="glass rounded-2xl p-5 space-y-3">
                <div className="font-bold">Customer & Notes</div>
                <input
                  className="input"
                  placeholder="Customer name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
                <textarea
                  className="input min-h-[90px]"
                  placeholder="Notes (visible only internally)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              <div className="glass rounded-2xl p-5">
                <div className="font-bold mb-3">Output</div>
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

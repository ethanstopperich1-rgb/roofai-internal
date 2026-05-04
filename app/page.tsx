"use client";

import { useEffect, useMemo, useState } from "react";
import AddressInput from "@/components/AddressInput";
import AssumptionsEditor from "@/components/AssumptionsEditor";
import AddOnsPanel from "@/components/AddOnsPanel";
import ResultsPanel from "@/components/ResultsPanel";
import OutputButtons from "@/components/OutputButtons";
import MapView from "@/components/MapView";
import InsightsPanel from "@/components/InsightsPanel";
import type { AddOn, AddressInfo, Assumptions, Estimate } from "@/types/estimate";
import { DEFAULT_ADDONS, computeBase, computeTotal } from "@/lib/pricing";
import { estimateAge, estimateRoofSize } from "@/lib/utils";
import { newId } from "@/lib/storage";

const DEFAULT_ASSUMPTIONS: Assumptions = {
  sqft: 2200,
  pitch: "6/12",
  material: "asphalt-architectural",
  ageYears: 15,
  laborMultiplier: 1.0,
  materialMultiplier: 1.0,
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

  const runEstimate = async () => {
    if (!addressText.trim()) return;
    const addr: AddressInfo = address ?? { formatted: addressText.trim() };
    setAddress(addr);
    setShown(true);

    // Try Solar API for real sqft + pitch when we have coords
    if (addr.lat != null && addr.lng != null) {
      try {
        const res = await fetch(`/api/solar?lat=${addr.lat}&lng=${addr.lng}`);
        if (res.ok) {
          const data = (await res.json()) as { sqft?: number | null; pitch?: string | null };
          setAssumptions((a) => ({
            ...a,
            sqft: data.sqft || a.sqft || estimateRoofSize(),
            pitch: (data.pitch as typeof a.pitch) || a.pitch,
            ageYears: a.ageYears || estimateAge(),
          }));
          return;
        }
      } catch {
        // fall through to heuristic
      }
    }
    setAssumptions((a) => ({
      ...a,
      sqft: a.sqft || estimateRoofSize(),
      ageYears: a.ageYears || estimateAge(),
    }));
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
  };

  return (
    <div className="space-y-6">
      <div className="glass-strong rounded-2xl p-6">
        <div className="flex items-end justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h1 className="text-2xl md:text-3xl font-black tracking-tight">Quick Estimate</h1>
            <p className="text-sm text-slate-400">Type or paste an address. Press Enter to estimate.</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              className="input w-44"
              placeholder="Your name"
              value={staff}
              onChange={(e) => setStaff(e.target.value)}
            />
            {shown && (
              <button className="btn btn-ghost" onClick={reset}>New</button>
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
              />
              <div className="grid md:grid-cols-2 gap-6">
                <AssumptionsEditor value={assumptions} onChange={setAssumptions} />
                <AddOnsPanel addOns={addOns} onChange={setAddOns} />
              </div>
            </div>
            <div className="space-y-6">
              <div className="h-[420px]">
                <MapView lat={address?.lat} lng={address?.lng} address={address?.formatted} />
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

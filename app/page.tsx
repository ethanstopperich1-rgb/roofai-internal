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
import type { AddOn, AddressInfo, Assumptions, Estimate } from "@/types/estimate";
import { DEFAULT_ADDONS, computeBase, computeTotal } from "@/lib/pricing";
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

  const { low, high } = useMemo(() => {
    const b = computeBase(assumptions);
    return { low: b.low, high: b.high };
  }, [assumptions]);

  const total = useMemo(() => computeTotal(assumptions, addOns), [assumptions, addOns]);

  const runEstimate = async () => {
    if (!addressText.trim()) return;
    const addr: AddressInfo = address ?? { formatted: addressText.trim() };
    setAddress(addr);
    setShown(true);

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
        /* fall through */
      }
    }
    setAssumptions((a) => ({
      ...a,
      sqft: a.sqft || estimateRoofSize(),
      ageYears: a.ageYears || estimateAge(),
    }));
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
              <span>solar fetch</span>
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
          Type or paste an address. Pick a suggestion to auto-fill roof size & pitch from satellite data.
        </p>

        <AddressInput
          value={addressText}
          onChange={setAddressText}
          onSelect={setAddress}
          onSubmit={runEstimate}
        />
      </section>

      {/* ─── Empty state ─────────────────────────────────────────────── */}
      {!shown && <EmptyState />}

      {/* ─── Estimate workspace ──────────────────────────────────────── */}
      {shown && (
        <div className="grid lg:grid-cols-3 gap-6 float-in">
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
            <div className="h-[440px]">
              <MapView lat={address?.lat} lng={address?.lng} address={address?.formatted} />
            </div>
            <PropertyContextPanel address={address} />
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
      )}
    </div>
  );
}

function EmptyState() {
  const tips = [
    {
      icon: <Sparkles size={14} className="text-cy-300" />,
      title: "Solar API auto-fills roof size & pitch",
      body: "Pick a suggestion from autocomplete to use Google's actual building data.",
    },
    {
      icon: <Plus size={14} className="text-mint" />,
      title: "Tweak anything, total updates live",
      body: "Material, multipliers, add-ons — recompute instantly with smooth animation.",
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

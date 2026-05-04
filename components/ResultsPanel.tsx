"use client";

import { useEffect, useRef, useState } from "react";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import type { AddressInfo, Assumptions } from "@/types/estimate";

interface Props {
  address: AddressInfo;
  assumptions: Assumptions;
  total: number;
  baseLow: number;
  baseHigh: number;
}

export default function ResultsPanel({ address, assumptions, total, baseLow, baseHigh }: Props) {
  const [flash, setFlash] = useState(false);
  const prev = useRef(total);
  useEffect(() => {
    if (prev.current !== total) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 600);
      prev.current = total;
      return () => clearTimeout(t);
    }
  }, [total]);

  return (
    <div className="glass-strong rounded-2xl p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="label">Property</div>
          <div className="font-semibold truncate text-lg">{address.formatted || "—"}</div>
          {address.zip && <div className="text-xs text-slate-400 mt-0.5">ZIP {address.zip}</div>}
        </div>
        <div className="text-right">
          <div className="label">Total Estimate</div>
          <div className={`text-4xl md:text-5xl font-black tracking-tight ${flash ? "price-flash" : ""}`}>
            {fmt(total)}
          </div>
          <div className="text-xs text-slate-400 mt-1">Range {fmt(baseLow)} – {fmt(baseHigh)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
        <Stat label="Roof Size" value={`${assumptions.sqft.toLocaleString()} sf`} />
        <Stat label="Pitch" value={assumptions.pitch} />
        <Stat label="Material" value={MATERIAL_RATES[assumptions.material].label} />
        <Stat label="Age" value={`${assumptions.ageYears} yrs`} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
      <div className="label">{label}</div>
      <div className="font-semibold mt-0.5 truncate">{value}</div>
    </div>
  );
}

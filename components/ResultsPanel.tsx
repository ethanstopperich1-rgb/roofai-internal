"use client";

import { useEffect, useRef, useState } from "react";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import type { AddressInfo, Assumptions, ServiceType } from "@/types/estimate";
import { ShieldAlert } from "lucide-react";

const SERVICE_LABEL: Record<ServiceType, string> = {
  new: "New install",
  "reroof-tearoff": "Reroof (tear-off)",
  layover: "Layover",
  repair: "Repair only",
};

interface Props {
  address: AddressInfo;
  assumptions: Assumptions;
  total: number;
  baseLow: number;
  baseHigh: number;
  isInsuranceClaim?: boolean;
  onInsuranceChange?: (v: boolean) => void;
}

export default function ResultsPanel({
  address,
  assumptions,
  total,
  baseLow,
  baseHigh,
  isInsuranceClaim,
  onInsuranceChange,
}: Props) {
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

  const serviceType = assumptions.serviceType ?? "reroof-tearoff";

  return (
    <div className="glass-strong rounded-2xl p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="label">Property</div>
          <div className="font-semibold truncate text-lg">{address.formatted || "—"}</div>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {address.zip && (
              <span className="text-xs text-slate-400">ZIP {address.zip}</span>
            )}
            <span className="rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-300">
              {SERVICE_LABEL[serviceType]}
            </span>
            {isInsuranceClaim && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
                <ShieldAlert size={10} /> Insurance claim
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="label">Total Estimate</div>
          <div className={`text-4xl md:text-5xl font-black tracking-tight ${flash ? "price-flash" : ""}`}>
            {fmt(total)}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Range {fmt(baseLow)} – {fmt(baseHigh)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
        <Stat label="Roof Size" value={`${assumptions.sqft.toLocaleString()} sf`} />
        <Stat label="Pitch" value={assumptions.pitch} />
        <Stat label="Material" value={MATERIAL_RATES[assumptions.material].label} />
        <Stat label="Age" value={`${assumptions.ageYears} yrs`} />
      </div>

      {onInsuranceChange && (
        <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-3">
          <input
            type="checkbox"
            checked={!!isInsuranceClaim}
            onChange={(e) => onInsuranceChange(e.target.checked)}
            className="h-4 w-4 accent-amber-400"
          />
          <div className="flex-1">
            <div className="text-sm font-medium">Insurance claim</div>
            <div className="text-xs text-slate-400">
              Routes work to a restoration specialist; PDF includes full Xactimate-style line items.
            </div>
          </div>
        </label>
      )}
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

"use client";

import { useEffect, useRef, useState } from "react";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import type { AddressInfo, Assumptions, ServiceType } from "@/types/estimate";
import {
  MapPin,
  Ruler,
  TrendingUp,
  Layers,
  Clock,
  ShieldAlert,
  Hammer,
} from "lucide-react";

const SERVICE_LABEL: Record<ServiceType, string> = {
  new: "New install",
  "reroof-tearoff": "Reroof · tear-off",
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
      const t = setTimeout(() => setFlash(false), 700);
      prev.current = total;
      return () => clearTimeout(t);
    }
  }, [total]);

  const serviceType = assumptions.serviceType ?? "reroof-tearoff";

  return (
    <div className="glass-panel-hero p-7 md:p-8 relative overflow-hidden">
      <div className="relative grid lg:grid-cols-[1fr_auto] gap-8 items-end">
        {/* Address */}
        <div className="min-w-0">
          <div className="label flex items-center gap-1.5 mb-1.5">
            <MapPin size={11} /> Property
          </div>
          <div className="font-display text-[22px] md:text-[26px] leading-tight font-medium tracking-tight truncate">
            {address.formatted || "—"}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {address.zip && (
              <span className="font-mono tabular text-[11px] text-slate-400">
                ZIP {address.zip}
              </span>
            )}
            <span className="chip">
              <Hammer size={10} /> {SERVICE_LABEL[serviceType]}
            </span>
            {isInsuranceClaim && (
              <span className="chip" style={{ background: "rgba(243,177,75,0.10)", borderColor: "rgba(243,177,75,0.32)", color: "#f3b14b" }}>
                <ShieldAlert size={10} /> Insurance claim
              </span>
            )}
          </div>
        </div>

        {/* Price */}
        <div className="text-left lg:text-right">
          <div className="label mb-1.5 flex items-center lg:justify-end gap-1.5">
            <TrendingUp size={11} /> Total Estimate
          </div>
          <div
            className={`font-display tabular text-[68px] md:text-[88px] leading-[0.92] font-semibold tracking-[-0.04em] ${
              flash ? "price-flash" : "iridescent-text"
            }`}
          >
            {fmt(total)}
          </div>
          <div className="mt-1 font-mono text-[11px] text-slate-400 tabular">
            range {fmt(baseLow)} <span className="text-slate-600">→</span> {fmt(baseHigh)}
          </div>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-500 lg:text-right">
            {SERVICE_LABEL[serviceType]} · base
          </div>
        </div>
      </div>

      <div className="glass-divider my-7" />

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={<Ruler size={13} />}
          label="Roof Size"
          value={`${assumptions.sqft.toLocaleString()}`}
          unit="sf"
        />
        <Stat icon={<TrendingUp size={13} />} label="Pitch" value={assumptions.pitch} />
        <Stat
          icon={<Layers size={13} />}
          label="Material"
          value={MATERIAL_RATES[assumptions.material].label}
          tight
        />
        <Stat icon={<Clock size={13} />} label="Age" value={`${assumptions.ageYears}`} unit="yrs" />
      </div>

      {onInsuranceChange && (
        <label
          className={`mt-5 flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition ${
            isInsuranceClaim
              ? "border-amber/35 bg-amber/[0.06]"
              : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.13] hover:bg-white/[0.04]"
          }`}
        >
          <input
            type="checkbox"
            checked={!!isInsuranceClaim}
            onChange={(e) => onInsuranceChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-amber-400 cursor-pointer"
          />
          <div className="flex-1">
            <div className="text-[13.5px] font-medium flex items-center gap-2">
              <ShieldAlert size={13} className={isInsuranceClaim ? "text-amber" : "text-slate-400"} />
              Insurance claim
            </div>
            <div className="text-[12px] text-slate-400 mt-0.5 leading-relaxed">
              Routes work to a restoration specialist; PDF includes full Xactimate-style line items.
            </div>
          </div>
        </label>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  unit,
  tight,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  tight?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.05] bg-white/[0.015] px-4 py-3 card-hover">
      <div className="label flex items-center gap-1.5">
        <span className="text-slate-500">{icon}</span>
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span
          className={`font-display tabular ${
            tight ? "text-[15px] truncate" : "text-[20px]"
          } font-semibold tracking-tight`}
        >
          {value}
        </span>
        {unit && <span className="font-mono text-[11px] text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

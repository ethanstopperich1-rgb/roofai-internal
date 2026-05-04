"use client";

import { useEffect, useRef, useState } from "react";
import { fmt, MATERIAL_RATES } from "@/lib/pricing";
import type { AddressInfo, Assumptions } from "@/types/estimate";
import { MapPin, Ruler, TrendingUp, Layers, Clock } from "lucide-react";

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
      const t = setTimeout(() => setFlash(false), 700);
      prev.current = total;
      return () => clearTimeout(t);
    }
  }, [total]);

  return (
    <div className="glass-strong rounded-3xl p-7 md:p-8 relative overflow-hidden">
      {/* Atmospheric glow behind price */}
      <div
        className="absolute -top-20 right-0 w-[460px] h-[300px] blur-3xl pointer-events-none opacity-60"
        style={{ background: "radial-gradient(closest-side, rgba(95,227,176,0.10), transparent)" }}
      />

      <div className="relative grid lg:grid-cols-[1fr_auto] gap-8 items-end">
        {/* Address */}
        <div className="min-w-0">
          <div className="label flex items-center gap-1.5 mb-1.5">
            <MapPin size={11} /> Property
          </div>
          <div className="font-display text-[22px] md:text-[26px] leading-tight font-medium tracking-tight truncate">
            {address.formatted || "—"}
          </div>
          <div className="mt-1 flex items-center gap-3 text-[12px] text-slate-400">
            {address.zip && (
              <span className="font-mono tracking-wide">ZIP {address.zip}</span>
            )}
            <span className="font-mono uppercase tracking-[0.14em] text-[10px] text-mint inline-flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-mint pulse-dot" /> Solar data linked
            </span>
          </div>
        </div>

        {/* Price */}
        <div className="text-left lg:text-right">
          <div className="label mb-1.5 flex items-center lg:justify-end gap-1.5">
            <TrendingUp size={11} /> Total Estimate
          </div>
          <div
            className={`font-display tabular text-[68px] md:text-[88px] leading-[0.92] font-semibold tracking-[-0.04em] ${
              flash ? "price-flash" : "text-slate-50"
            }`}
            style={{
              textShadow: "0 1px 0 rgba(0,0,0,0.5), 0 0 60px rgba(103,220,255,0.06)",
            }}
          >
            {fmt(total)}
          </div>
          <div className="mt-1 font-mono text-[11px] text-slate-400 tabular">
            range {fmt(baseLow)} <span className="text-slate-600">→</span> {fmt(baseHigh)}
          </div>
        </div>
      </div>

      <div className="divider my-7" />

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

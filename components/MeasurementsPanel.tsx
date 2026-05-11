"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Ruler, Layers } from "lucide-react";
import type { RoofLengths, WasteTable } from "@/types/estimate";

interface Props {
  lengths: RoofLengths;
  waste: WasteTable;
  /** When false, the panel renders collapsed by default */
  defaultOpen?: boolean;
}

const SOURCE_LABEL: Record<RoofLengths["source"], string> = {
  polygons: "computed from real polygons",
  footprint: "estimated from building footprint",
  heuristic: "estimated from sqft + complexity",
};

const SOURCE_BADGE: Record<RoofLengths["source"], { label: string; cls: string }> = {
  polygons: {
    label: "PRECISE",
    cls: "bg-mint/[0.10] text-mint border-mint/30",
  },
  footprint: {
    label: "ESTIMATED",
    cls: "bg-cy-500/[0.10] text-cy-300 border-cy-500/30",
  },
  heuristic: {
    label: "APPROXIMATE",
    cls: "bg-amber/[0.08] text-amber border-amber/30",
  },
};

export default function MeasurementsPanel({ lengths, waste, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  // When defaultOpen flips false → true (e.g. rep toggles insurance
  // mode), auto-open the panel so the rep doesn't have to expand it
  // manually. Don't auto-close on the reverse — they may still want to
  // see it.
  const prevDefaultRef = useRef(defaultOpen);
  useEffect(() => {
    if (!prevDefaultRef.current && defaultOpen) setOpen(true);
    prevDefaultRef.current = defaultOpen;
  }, [defaultOpen]);
  const badge = SOURCE_BADGE[lengths.source];

  return (
    <div className="glass-panel p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4"
      >
        <div className="flex items-center gap-2">
          <Ruler size={14} className="text-cy-300" />
          <div className="font-display font-semibold tracking-tight text-[15px]">
            Roof measurements
          </div>
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[9px] tracking-[0.14em] ${badge.cls}`}
          >
            {badge.label}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[12.5px] text-slate-400">
          <span className="font-mono tabular">{waste.measuredSquares.toFixed(1)} sq</span>
          <span
            className="font-mono tabular text-[11px] text-cy-300/90 px-1.5 py-0.5 rounded-md border border-cy-300/25 bg-cy-300/[0.06]"
            title={`Active shingle waste factor — ${waste.suggestedPct}% applied to line items.`}
          >
            +{waste.suggestedPct}% waste
          </span>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {/* Length grid (EagleView "Length Diagram" totals) */}
          <div>
            <div className="label mb-2">Length diagram totals</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Length label="Ridges" value={lengths.ridgesLf} unit="ft" />
              <Length label="Hips" value={lengths.hipsLf} unit="ft" />
              <Length label="Valleys" value={lengths.valleysLf} unit="ft" />
              <Length label="Rakes" value={lengths.rakesLf} unit="ft" />
              <Length label="Eaves" value={lengths.eavesLf} unit="ft" />
              <Length label="Drip edge" value={lengths.dripEdgeLf} unit="ft" />
              <Length label="Flashing" value={lengths.flashingLf} unit="ft" />
              <Length label="Step flashing" value={lengths.stepFlashingLf} unit="ft" />
            </div>
          </div>

          {/* Ice & water shield row */}
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] px-4 py-3 flex items-center justify-between">
            <div>
              <div className="label">Ice & water shield needed</div>
              <div className="text-[10px] text-slate-500 mt-0.5">
                3 ft strip at eaves + 6 ft each side of valleys
              </div>
            </div>
            <div className="text-right">
              <div className="font-display tabular text-[18px] font-semibold tracking-tight">
                {lengths.iwsSqft.toLocaleString()}
              </div>
              <div className="font-mono text-[10px] text-slate-500">sqft</div>
            </div>
          </div>

          {/* EagleView-style waste calculation table */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Layers size={11} className="text-slate-500" />
              <div className="label">Waste calculation</div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-white/[0.05]">
              <table className="w-full text-[11.5px]">
                <thead className="bg-white/[0.03] text-left text-[9.5px] uppercase tracking-[0.12em] text-slate-500 font-mono">
                  <tr>
                    <th className="px-3 py-2 font-medium">Waste %</th>
                    <th className="px-3 py-2 text-right font-medium">Area (sqft)</th>
                    <th className="px-3 py-2 text-right font-medium">Squares</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {waste.rows.map((r) => (
                    <tr
                      key={r.pct}
                      className={
                        r.isMeasured
                          ? "bg-white/[0.02]"
                          : r.isSuggested
                            ? "bg-cy-500/[0.06] text-cy-200"
                            : ""
                      }
                    >
                      <td className="px-3 py-1.5 font-mono tabular">
                        {r.pct}%
                        {r.isMeasured && (
                          <span className="ml-1.5 text-[9px] text-slate-500">measured</span>
                        )}
                        {r.isSuggested && (
                          <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wider text-cy-300">
                            suggested
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular">
                        {r.areaSqft.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular">
                        {r.squares.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[10.5px] text-slate-500 leading-relaxed">
              Waste % is suggested based on roof complexity. Squares are rounded up to the nearest 1/3 (matches EagleView convention). For ridge / hip / starter strip materials, add separately.
            </p>
          </div>

          <div className="text-[10px] text-slate-500 italic">
            Measurements {SOURCE_LABEL[lengths.source]}.
            {lengths.source !== "polygons" &&
              " Refine the roof outline to compute precise edge lengths."}
          </div>
        </div>
      )}
    </div>
  );
}

function Length({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] px-3 py-2.5">
      <div className="label">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="font-display tabular text-[17px] font-semibold tracking-tight">
          {value.toLocaleString()}
        </span>
        <span className="font-mono text-[10px] text-slate-500">{unit}</span>
      </div>
    </div>
  );
}

// components/roof/FacetList.tsx
"use client";

import { useState } from "react";
import type { RoofData, PricedEstimate } from "@/types/roof";
import { PitchDisplay } from "./PitchDisplay";
import { LowSlopeBadge } from "./LowSlopeBadge";

export function FacetList({
  data,
  priced,
}: {
  data: RoofData;
  priced: PricedEstimate;
}) {
  const [expanded, setExpanded] = useState(false);
  if (data.source === "none" || data.facets.length === 0) return null;

  // Aggregate per-facet shingle costs across all shingle line items with attribution
  const attribByFacet = new Map<string, { low: number; high: number }>();
  for (const li of priced.lineItems) {
    if (!li.facetAttribution) continue;
    for (const a of li.facetAttribution) {
      const prev = attribByFacet.get(a.facetId) ?? { low: 0, high: 0 };
      attribByFacet.set(a.facetId, {
        low: prev.low + a.extendedLow,
        high: prev.high + a.extendedHigh,
      });
    }
  }

  return (
    <div className="glass-panel p-5">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between font-display text-[14px] font-semibold tracking-[-0.015em] text-slate-50"
      >
        Per-facet breakdown
        <span className="text-slate-500 ml-2 text-[12px] font-normal font-mono">
          {data.facets.length} facet{data.facets.length === 1 ? "" : "s"}
        </span>
        <span className="text-[11px] font-mono uppercase tracking-[0.14em] text-cy-300/85 ml-auto hover:text-cy-200 transition-colors">
          {expanded ? "Hide" : "Show"}
        </span>
      </button>
      {expanded && (
        <table className="mt-4 w-full text-[12.5px]">
          <thead>
            <tr className="text-left text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500">
              <th className="pb-2 font-medium">Facet</th>
              <th className="pb-2 font-medium">Pitch</th>
              <th className="pb-2 font-medium text-right">Area</th>
              <th className="pb-2 font-medium text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.facets.map((f) => {
              const cost = attribByFacet.get(f.id);
              return (
                <tr key={f.id} className="border-t border-white/[0.05]">
                  <td className="py-1.5 font-mono tabular text-slate-200">{f.id}</td>
                  <td className="py-1.5 text-slate-300">
                    <PitchDisplay degrees={f.pitchDegrees} />
                    {f.isLowSlope && <LowSlopeBadge className="ml-2" />}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular text-slate-200">
                    {Math.round(f.areaSqftSloped).toLocaleString()} sf
                  </td>
                  <td className="py-1.5 text-right font-mono tabular text-slate-300">
                    {cost
                      ? `$${Math.round(cost.low).toLocaleString()}–$${Math.round(cost.high).toLocaleString()}`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

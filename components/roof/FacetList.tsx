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
    <div className="rounded-lg border bg-white p-4">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between text-sm font-semibold text-slate-900"
      >
        Per-facet breakdown ({data.facets.length} facet
        {data.facets.length === 1 ? "" : "s"})
        <span className="text-xs text-slate-500">
          {expanded ? "Hide" : "Show"}
        </span>
      </button>
      {expanded && (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="pb-1 font-medium">Facet</th>
              <th className="pb-1 font-medium">Pitch</th>
              <th className="pb-1 font-medium text-right">Area</th>
              <th className="pb-1 font-medium text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.facets.map((f) => {
              const cost = attribByFacet.get(f.id);
              return (
                <tr key={f.id} className="border-t border-slate-100">
                  <td className="py-1 font-medium text-slate-900">{f.id}</td>
                  <td className="py-1">
                    <PitchDisplay degrees={f.pitchDegrees} />
                    {f.isLowSlope && <LowSlopeBadge className="ml-2" />}
                  </td>
                  <td className="py-1 text-right">
                    {Math.round(f.areaSqftSloped).toLocaleString()} sf
                  </td>
                  <td className="py-1 text-right">
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

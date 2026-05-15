// components/roof/RoofTotalsCard.tsx
import type { RoofData } from "@/types/roof";
import { PitchDisplay } from "./PitchDisplay";

/** Roof totals strip — 4 high-impact stats above the breakdown.
 *  Dark glass surface so it sits in the same visual language as the
 *  rest of the rep tool; previous tailwind defaults (bg-white,
 *  text-slate-900) were a light-mode anti-pattern that visually broke
 *  the dark theme mid-page. */
export function RoofTotalsCard({ data }: { data: RoofData }) {
  const t = data.totals;
  if (data.source === "none") {
    return (
      <div className="rounded-xl border border-amber/30 bg-amber/[0.05] p-4 text-[13px] text-amber">
        No analysis available — please verify the address.
      </div>
    );
  }
  return (
    <div className="glass-panel p-5">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat label="Roof area" value={`${t.totalRoofAreaSqft.toLocaleString()} sqft`} />
        <Stat label="Squares" value={t.totalSquares.toFixed(2)} />
        <Stat
          label="Avg pitch"
          value={<PitchDisplay degrees={t.averagePitchDegrees} />}
        />
        <Stat label="Facets" value={String(t.facetsCount)} />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-slate-500">
        {label}
      </div>
      <div className="font-display tabular text-[19px] font-semibold tracking-[-0.018em] text-slate-50 mt-1">
        {value}
      </div>
    </div>
  );
}

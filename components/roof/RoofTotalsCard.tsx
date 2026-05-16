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
  // EagleView-equivalent measurement chips. Each row only renders when
  // at least one value in the row is non-null — keeps the card tight
  // when Tier C didn't surface edges or vision didn't detect anything.
  const edgeChips: Array<[string, string]> = [];
  if (t.totalRidgesHipsLf != null)
    edgeChips.push(["Ridges/Hips", `${t.totalRidgesHipsLf.toLocaleString()} ft`]);
  if (t.totalValleysLf != null)
    edgeChips.push(["Valleys", `${t.totalValleysLf.toLocaleString()} ft`]);
  if (t.totalRakesLf != null)
    edgeChips.push(["Rakes", `${t.totalRakesLf.toLocaleString()} ft`]);
  if (t.totalEavesLf != null)
    edgeChips.push(["Eaves", `${t.totalEavesLf.toLocaleString()} ft`]);

  const detailChips: Array<[string, string]> = [];
  if (t.totalFootprintSqft > 0)
    detailChips.push([
      "Footprint",
      `${t.totalFootprintSqft.toLocaleString()} sqft`,
    ]);
  if (t.estimatedAtticSqft != null)
    detailChips.push([
      "Est. attic",
      `${t.estimatedAtticSqft.toLocaleString()} sqft`,
    ]);
  if (t.stories != null)
    detailChips.push(["Stories", String(t.stories)]);
  if (t.totalPenetrations != null)
    detailChips.push(["Penetrations", String(t.totalPenetrations)]);

  return (
    <div className="glass-panel p-5 space-y-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat label="Roof area" value={`${t.totalRoofAreaSqft.toLocaleString()} sqft`} />
        <Stat label="Squares" value={t.totalSquares.toFixed(2)} />
        <Stat
          label="Avg pitch"
          value={<PitchDisplay degrees={t.averagePitchDegrees} />}
        />
        <Stat label="Facets" value={String(t.facetsCount)} />
      </div>

      {/* Additional EagleView-equivalent measurements. Rendered as a
          secondary row to keep the four headline stats visually dominant. */}
      {detailChips.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 border-t border-white/[0.06] pt-4">
          {detailChips.map(([label, value]) => (
            <Stat key={label} label={label} value={value} />
          ))}
        </div>
      )}

      {edgeChips.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 border-t border-white/[0.06] pt-4">
          {edgeChips.map(([label, value]) => (
            <Stat key={label} label={label} value={value} />
          ))}
        </div>
      )}
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

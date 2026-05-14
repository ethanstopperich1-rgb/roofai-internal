// components/roof/RoofTotalsCard.tsx
import type { RoofData } from "@/types/roof";
import { PitchDisplay } from "./PitchDisplay";

export function RoofTotalsCard({ data }: { data: RoofData }) {
  const t = data.totals;
  if (data.source === "none") {
    return (
      <div className="rounded-lg border bg-slate-50 p-4">
        <p className="text-sm text-slate-600">
          No analysis available — please verify the address.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Roof area
          </div>
          <div className="font-medium text-slate-900">
            {t.totalRoofAreaSqft.toLocaleString()} sqft
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Squares
          </div>
          <div className="font-medium text-slate-900">
            {t.totalSquares.toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Avg pitch
          </div>
          <div className="font-medium text-slate-900">
            <PitchDisplay degrees={t.averagePitchDegrees} />
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Facets
          </div>
          <div className="font-medium text-slate-900">{t.facetsCount}</div>
        </div>
      </div>
    </div>
  );
}

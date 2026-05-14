// components/roof/DetectedFeaturesPanel.tsx
import type { RoofData, RoofObject } from "@/types/roof";

export function DetectedFeaturesPanel({
  data,
  variant,
}: {
  data: RoofData;
  variant: "rep" | "customer";
}) {
  if (data.source === "none") return null;

  const counts = countObjects(data.objects);

  if (variant === "customer") {
    const lines: string[] = [];
    if (counts.chimney) lines.push(`${counts.chimney} chimney${counts.chimney > 1 ? "s" : ""}`);
    if (counts.skylight) lines.push(`${counts.skylight} skylight${counts.skylight > 1 ? "s" : ""}`);
    if (counts.dormer) lines.push(`${counts.dormer} dormer${counts.dormer > 1 ? "s" : ""}`);
    const ventCount = counts.vent + counts.stack;
    if (ventCount) lines.push(`${ventCount} roof vent${ventCount > 1 ? "s" : ""}`);
    return (
      <div className="rounded-lg border bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">What we detected</h3>
        <p className="mt-1 text-sm text-slate-700">
          {lines.length > 0
            ? lines.join(", ") + " — all factored into your estimate."
            : "Clean roof — no penetrations detected."}
        </p>
      </div>
    );
  }

  // Rep variant — full diagnostics
  return (
    <div className="rounded-lg border bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">Detected features</h3>
      <ul className="mt-2 space-y-1 text-sm text-slate-700">
        <li>
          {data.facets.length} facet{data.facets.length === 1 ? "" : "s"}
        </li>
        <li>{data.edges.length} classified edges</li>
        {Object.entries(counts)
          .filter(([, n]) => n > 0)
          .map(([kind, n]) => (
            <li key={kind}>
              {n} × {kind}
            </li>
          ))}
      </ul>
      {data.diagnostics.warnings.length > 0 && (
        <div className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
          {data.diagnostics.warnings.join(" • ")}
        </div>
      )}
    </div>
  );
}

function countObjects(objects: RoofObject[]): Record<string, number> {
  const out: Record<string, number> = {
    chimney: 0,
    skylight: 0,
    dormer: 0,
    vent: 0,
    stack: 0,
    "satellite-dish": 0,
    "ridge-vent": 0,
    "box-vent": 0,
    turbine: 0,
  };
  for (const o of objects) out[o.kind] = (out[o.kind] ?? 0) + 1;
  return out;
}

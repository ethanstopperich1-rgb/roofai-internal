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
  const refinedByObliques = data.refinements.includes("multiview-obliques");
  // Wall-step / headwall / apron LF are Tier B+ signals — only render
  // the line when at least one is non-zero so Tier C views aren't cluttered
  // with three zero rows.
  const wallTotal =
    data.flashing.wallStepLf + data.flashing.headwallLf + data.flashing.apronLf;

  if (variant === "customer") {
    const lines: string[] = [];
    if (counts.chimney) lines.push(`${counts.chimney} chimney${counts.chimney > 1 ? "s" : ""}`);
    if (counts.skylight) lines.push(`${counts.skylight} skylight${counts.skylight > 1 ? "s" : ""}`);
    if (counts.dormer) lines.push(`${counts.dormer} dormer${counts.dormer > 1 ? "s" : ""}`);
    const ventCount = counts.vent + counts.stack;
    if (ventCount) lines.push(`${ventCount} roof vent${ventCount > 1 ? "s" : ""}`);
    // Tier C surfaces per-facet pitch + azimuth — homeowner-friendly
    // summary uses average pitch (in x/12 + degrees) and the dominant
    // compass direction so the customer sees "5 roof planes, mostly
    // 6/12 south-facing" instead of just "blue blob".
    const facetCount = data.facets.length;
    const avgDeg = data.totals.averagePitchDegrees;
    const pitchSummary = formatPitchSummary(avgDeg);
    const dominantDir = dominantCompass(data.facets);
    return (
      <div className="glass-panel p-5">
        <h3 className="font-display text-[14px] font-semibold tracking-[-0.015em] text-slate-50">
          What we detected
        </h3>
        {facetCount > 0 && (
          <p className="mt-2 text-[13px] text-slate-300 leading-relaxed">
            <strong className="text-slate-50">{facetCount} roof plane{facetCount === 1 ? "" : "s"}</strong>
            {pitchSummary && <> · <strong className="text-slate-50">{pitchSummary}</strong> average pitch</>}
            {dominantDir && <> · primarily <strong className="text-slate-50">{dominantDir}-facing</strong></>}.
          </p>
        )}
        <p className="mt-1.5 text-[13px] text-slate-300 leading-relaxed">
          {lines.length > 0
            ? lines.join(", ") + " — all factored into your estimate."
            : "Clean roof — no penetrations detected."}
        </p>
        {wallTotal > 0 && (
          <p className="mt-1.5 text-[12px] text-slate-500">
            Plus {wallTotal} LF of wall-to-roof flashing.
          </p>
        )}
        {refinedByObliques && (
          <p className="mt-2 text-[11px] text-mint flex items-center gap-1.5">
            <span aria-hidden>✓</span> Verified by oblique inspection
          </p>
        )}
      </div>
    );
  }

  // Rep variant — full diagnostics
  return (
    <div className="glass-panel p-5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-display text-[14px] font-semibold tracking-[-0.015em] text-slate-50">
          Detected features
        </h3>
        {refinedByObliques && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-mint/15 border border-mint/30 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.14em] text-mint"
            title="Pitches, object sizes, and wall-step flashing refined by oblique inspection."
          >
            ✓ Inspector
          </span>
        )}
      </div>
      <ul className="mt-3 space-y-1 text-[13px] text-slate-300">
        <li>
          <span className="font-mono tabular text-slate-50 font-medium">
            {data.facets.length}
          </span>{" "}
          facet{data.facets.length === 1 ? "" : "s"}
        </li>
        <li>
          <span className="font-mono tabular text-slate-50 font-medium">
            {data.edges.length}
          </span>{" "}
          classified edges
        </li>
        {Object.entries(counts)
          .filter(([, n]) => n > 0)
          .map(([kind, n]) => (
            <li key={kind}>
              <span className="font-mono tabular text-slate-50 font-medium">{n}</span>{" "}
              × {kind}
            </li>
          ))}
        {wallTotal > 0 && (
          <li className="text-mint">
            Wall-to-roof:{" "}
            {[
              data.flashing.wallStepLf > 0 && `step ${data.flashing.wallStepLf} LF`,
              data.flashing.headwallLf > 0 && `headwall ${data.flashing.headwallLf} LF`,
              data.flashing.apronLf > 0 && `apron ${data.flashing.apronLf} LF`,
            ]
              .filter(Boolean)
              .join(", ")}
          </li>
        )}
      </ul>
      {data.diagnostics.warnings.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber/30 bg-amber/[0.06] p-2.5 text-[11.5px] text-amber leading-relaxed">
          {data.diagnostics.warnings.join(" • ")}
        </div>
      )}
    </div>
  );
}

/** Convert pitch degrees to friendly "x/12" + "(N°)" form used by reps + customers.
 *  Examples: 26.57° → "6/12 (27°)"; 0° → null (flat); NaN → null. */
function formatPitchSummary(deg: number | null | undefined): string | null {
  if (deg == null || !Number.isFinite(deg) || deg <= 0) return null;
  // x/12 = 12 × tan(deg). Round to nearest half-rise for natural names.
  const rise = Math.round(12 * Math.tan((deg * Math.PI) / 180));
  if (rise < 1) return `${Math.round(deg)}°`;
  return `${rise}/12 (${Math.round(deg)}°)`;
}

/** Area-weighted dominant compass direction from per-facet azimuths.
 *  Returns "north" / "south-east" / "west" etc. Returns null for
 *  flat / unknown / non-residential azimuth distributions. */
function dominantCompass(
  facets: Array<{ azimuthDeg?: number | null; areaSqftSloped: number }>,
): string | null {
  if (!facets || facets.length === 0) return null;
  // Sum area-weighted unit vectors per facet azimuth.
  let x = 0;
  let y = 0;
  let weight = 0;
  for (const f of facets) {
    const az = f.azimuthDeg;
    if (az == null || !Number.isFinite(az)) continue;
    const area = f.areaSqftSloped > 0 ? f.areaSqftSloped : 1;
    // Azimuth is 0° = north, 90° = east. Project to (x=east, y=north).
    const rad = (az * Math.PI) / 180;
    x += Math.sin(rad) * area;
    y += Math.cos(rad) * area;
    weight += area;
  }
  if (weight === 0) return null;
  const resultantDeg = (Math.atan2(x, y) * 180) / Math.PI;
  const normalized = (resultantDeg + 360) % 360;
  // 8-direction compass.
  const dirs = [
    "north", "north-east", "east", "south-east",
    "south", "south-west", "west", "north-west",
  ];
  const idx = Math.round(normalized / 45) % 8;
  return dirs[idx];
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

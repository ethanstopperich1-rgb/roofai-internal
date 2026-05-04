"use client";

import { AlertTriangle, ArrowRight, Pencil } from "lucide-react";
import { useMemo } from "react";

interface Props {
  /** Detected roof sqft (sloped surface area) */
  detectedSqft: number | null | undefined;
  /** Solar API's photogrammetric building footprint (top-down sqft of all
   *  buildings the API can see — typically just the main house) */
  solarFootprintSqft: number | null | undefined;
  /** Average roof pitch in degrees (drives footprint → surface ratio) */
  pitchDegrees: number | null | undefined;
  /** Called when the rep accepts the suggested override */
  onAcceptSuggestion: (sqft: number) => void;
  /** Called when the rep wants to manually edit */
  onManualEdit?: () => void;
}

/**
 * Compares the detected roof sqft against Solar API's photogrammetric building
 * footprint. Surfaces a warning when the two disagree by >35%.
 *
 * Math:
 *   Solar `buildingFootprintSqft` = top-down area of all roof segments Solar
 *   could measure (~ground truth for the main house, may miss detached
 *   structures Solar didn't index).
 *
 *   Expected roof surface ≈ footprint / cos(pitch)
 *
 * If our detected roof sqft is < 65% or > 145% of the implied roof surface,
 * the polygon source we picked probably misfired:
 *   - too-small: polygon picked one wing of a multi-bay home, or missed a
 *     detached garage / barn that's part of the job scope
 *   - too-large: polygon extended past the eave into the yard / driveway
 *
 * Both cases are recoverable: rep can accept Solar's number, edit manually,
 * or drag polygon vertices on the map.
 */
export default function PolygonSizeWarning({
  detectedSqft,
  solarFootprintSqft,
  pitchDegrees,
  onAcceptSuggestion,
  onManualEdit,
}: Props) {
  const analysis = useMemo(() => {
    if (!detectedSqft || !solarFootprintSqft) return null;
    const pitchRad = ((pitchDegrees ?? 22) * Math.PI) / 180;
    const cosP = Math.max(Math.cos(pitchRad), 0.5);
    const expectedRoofSqft = Math.round(solarFootprintSqft / cosP);
    const ratio = detectedSqft / expectedRoofSqft;
    if (ratio >= 0.65 && ratio <= 1.45) return null;
    return {
      detected: detectedSqft,
      expected: expectedRoofSqft,
      ratio,
      direction: ratio < 0.65 ? "too-small" : "too-large",
    } as const;
  }, [detectedSqft, solarFootprintSqft, pitchDegrees]);

  if (!analysis) return null;

  const isSmall = analysis.direction === "too-small";
  return (
    <div
      className="rounded-2xl border p-4 flex items-start gap-3"
      style={{
        background: "rgba(243,177,75,0.06)",
        borderColor: "rgba(243,177,75,0.32)",
      }}
    >
      <div className="w-8 h-8 rounded-xl flex-shrink-0 flex items-center justify-center text-amber bg-amber/10 border border-amber/30">
        <AlertTriangle size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-display font-semibold tracking-tight text-[14px] text-amber">
          Roof size looks {isSmall ? "small" : "large"} for this property
        </div>
        <div className="text-[12.5px] text-slate-300 mt-1 leading-relaxed">
          Detected{" "}
          <span className="font-mono tabular text-slate-100">
            {analysis.detected.toLocaleString()} sf
          </span>{" "}
          but the building footprint suggests the roof is closer to{" "}
          <span className="font-mono tabular text-slate-100">
            {analysis.expected.toLocaleString()} sf
          </span>
          .{" "}
          {isSmall
            ? "The auto-traced polygon may have picked only one wing or missed a detached garage / barn."
            : "The polygon may have extended past the eave into the yard or driveway."}
        </div>
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <button
            onClick={() => onAcceptSuggestion(analysis.expected)}
            className="btn btn-primary py-1.5 px-3 text-[12px]"
          >
            Use {analysis.expected.toLocaleString()} sf <ArrowRight size={12} />
          </button>
          {onManualEdit && (
            <button onClick={onManualEdit} className="btn btn-ghost py-1.5 px-3 text-[12px]">
              <Pencil size={12} /> Edit manually
            </button>
          )}
          <span className="text-[10.5px] text-slate-500 font-mono uppercase tracking-[0.12em]">
            or drag polygon vertices on the map
          </span>
        </div>
      </div>
    </div>
  );
}

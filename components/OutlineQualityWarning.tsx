"use client";

import { ShieldAlert, ShieldQuestion, Pencil } from "lucide-react";

interface Props {
  /** Confidence level computed in page.tsx from cross-source IoU
   *  consensus + Claude verifier verdict + source identity. */
  level: "high" | "moderate" | "low";
  /** Plain-language rationale ("3 sources agree", "Sources disagree
   *  best IoU 0.42", etc). */
  rationale: string;
  /** Specific issues Claude flagged in the multi-view verification —
   *  e.g. "south edge on driveway, ~3m off eave". May be empty. */
  issues: string[];
  /** Display label for the polygon source the polygon came from. */
  sourceLabel?: string;
  /** Called when the rep clicks "Edit polygon" — should focus the map
   *  so the rep can drag vertices. */
  onManualEdit?: () => void;
}

/**
 * Surfaces low / moderate-confidence outline warnings to the rep, with
 * the specific issues Claude found in the multi-view verification.
 * High confidence = no panel rendered (no need to bother the rep).
 *
 * The goal is to PROACTIVELY alert reps when the auto-trace is shaky,
 * with concrete details (which edge is off, what was traced wrong) so
 * the rep knows exactly what to fix instead of having to compare the
 * polygon against the satellite themselves.
 */
export default function OutlineQualityWarning({
  level,
  rationale,
  issues,
  sourceLabel,
  onManualEdit,
}: Props) {
  if (level === "high") return null;
  // Moderate-confidence with no specific issues isn't actionable — the
  // map already shows the "△ Moderate conf" chip and there's nothing to
  // surface beyond that.
  if (level === "moderate" && issues.length === 0) return null;

  const isLow = level === "low";
  const accent = isLow
    ? { bg: "rgba(255,122,138,0.06)", border: "rgba(255,122,138,0.32)", fg: "#ff7a8a" }
    : { bg: "rgba(243,177,75,0.06)", border: "rgba(243,177,75,0.32)", fg: "#f3b14b" };
  const Icon = isLow ? ShieldAlert : ShieldQuestion;
  const headline = isLow
    ? "Outline accuracy: low confidence — please review"
    : "Outline accuracy: review recommended";

  return (
    <div
      className="rounded-2xl border p-4 flex items-start gap-3"
      style={{ background: accent.bg, borderColor: accent.border }}
    >
      <div
        className="w-8 h-8 rounded-xl flex-shrink-0 flex items-center justify-center"
        style={{
          color: accent.fg,
          background: `${accent.fg}1a`,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: `${accent.fg}4d`,
        }}
      >
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="font-display font-semibold tracking-tight text-[14px]"
          style={{ color: accent.fg }}
        >
          {headline}
        </div>
        <div className="text-[12.5px] text-slate-300 mt-1 leading-relaxed">
          {rationale}
          {sourceLabel ? ` · source: ${sourceLabel}` : ""}
        </div>
        {issues.length > 0 && (
          <ul className="mt-2.5 space-y-1 text-[12.5px] text-slate-300 leading-relaxed">
            {issues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2">
                <span
                  className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full"
                  style={{ background: accent.fg }}
                />
                <span>{issue}</span>
              </li>
            ))}
          </ul>
        )}
        {onManualEdit && (
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button onClick={onManualEdit} className="btn btn-ghost py-1.5 px-3 text-[12px]">
              <Pencil size={12} /> Edit polygon
            </button>
            <span className="text-[10.5px] text-slate-500 font-mono uppercase tracking-[0.12em]">
              or drag vertices on the map
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

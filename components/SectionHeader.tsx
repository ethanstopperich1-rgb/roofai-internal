"use client";

import React from "react";

interface Props {
  /** Two-letter or numeric badge — anchors the eye on the section's spot
   *  in the page flow. Defaults to a discrete tracked numeral. */
  index?: string | number;
  /** Section title — the eye's primary landing. */
  title: string;
  /** Optional one-line eyebrow caption. */
  caption?: string;
  /** Optional right-aligned content (chips, action button, etc.). */
  trailing?: React.ReactNode;
}

/**
 * Editorial section header — anchors a region of the page with a
 * numbered index, title, and optional trailing slot. Plays the role of
 * a chapter header on what would otherwise be an undifferentiated wall
 * of glass cards. Use one per major section: "01 Property", "02 Roof
 * Geometry", "03 Compliance", "04 Estimate".
 *
 * Visual: small mono index pill (cyan-on-ink) + display-font title with
 * a subtle gradient divider under it. Designed to read as "this is a
 * new section" without yelling.
 */
export default function SectionHeader({ index, title, caption, trailing }: Props) {
  return (
    <div className="flex items-end justify-between gap-4 pt-2 pb-2 flex-wrap">
      <div className="flex items-baseline gap-3 min-w-0">
        {index != null && (
          <span className="glass-eyebrow" aria-hidden>
            {typeof index === "number" ? String(index).padStart(2, "0") : index}
          </span>
        )}
        <h2 className="font-display text-[18px] sm:text-[20px] md:text-[22px] leading-tight tracking-tight font-semibold text-slate-100 whitespace-nowrap">
          {title}
        </h2>
        {caption && (
          // Inline `truncate` only works on block-level elements. Wrap the
          // caption so it actually truncates rather than overflowing the
          // header row when the caption is long (e.g. "asphalt architectural
          // · reroof tearoff"). Hidden under md so it doesn't compete with
          // the title at narrow widths.
          <span
            className="hidden md:inline-block min-w-0 flex-1 max-w-[320px] truncate text-[11.5px] text-slate-500 font-mono uppercase tracking-[0.12em]"
            title={caption}
          >
            · {caption}
          </span>
        )}
      </div>
      {trailing && <div className="flex items-center gap-2 flex-wrap">{trailing}</div>}
    </div>
  );
}

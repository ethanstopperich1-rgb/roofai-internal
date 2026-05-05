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
    <div className="flex items-end justify-between gap-4 pt-2 -mb-1 flex-wrap">
      <div className="flex items-baseline gap-3 min-w-0">
        {index != null && (
          <span
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-cy-300/90 px-2 py-0.5 rounded-full border border-cy-300/30 bg-cy-300/5"
            aria-hidden
          >
            {typeof index === "number" ? String(index).padStart(2, "0") : index}
          </span>
        )}
        <h2 className="font-display text-[18px] sm:text-[20px] md:text-[22px] leading-tight tracking-tight font-semibold text-slate-100">
          {title}
        </h2>
        {caption && (
          <span className="hidden md:inline text-[12px] text-slate-400 font-mono uppercase tracking-[0.12em] truncate">
            · {caption}
          </span>
        )}
      </div>
      {trailing && <div className="flex items-center gap-2 flex-wrap">{trailing}</div>}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

/**
 * Auto-generated jump-to-section TOC for long legal/policy pages.
 *
 * Reads `article h2` elements after mount, slugifies their text into
 * ids (assigning if missing), and renders a collapsible <details>
 * with anchor links. Skips itself entirely when an article has fewer
 * than 3 sections (the TOC would be more noise than help).
 *
 * Why a client component:
 *   - The (legal) page files are static JSX that don't carry ids on
 *     their headings. Rather than retrofit ids on every h2 across
 *     three docs by hand, this component injects them at mount.
 *   - The TOC needs to be `<details>` for the collapsible interaction
 *     and `<a href="#id">` for the smooth-scroll behavior the browser
 *     handles natively when ids exist on the targets.
 *
 * Marked .no-print so the TOC doesn't render in printed output —
 * legal docs printed for reference don't need an interactive jump
 * widget.
 */
export default function LegalTOC() {
  const [headings, setHeadings] = useState<Array<{ id: string; text: string }>>(
    [],
  );

  useEffect(() => {
    const h2s = Array.from(document.querySelectorAll<HTMLHeadingElement>("article h2"));
    const list = h2s.map((h, i) => {
      const text = h.textContent?.trim() ?? "";
      let id = h.id;
      if (!id) {
        id =
          text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || `section-${i + 1}`;
        h.id = id;
        // scroll-margin-top so anchor jumps land below the fixed
        // PublicHeader instead of being hidden behind it.
        h.style.scrollMarginTop = "80px";
      }
      return { id, text };
    });
    setHeadings(list);
  }, []);

  if (headings.length < 3) return null;

  return (
    <details
      className="mb-10 rounded-2xl border border-white/[0.06] bg-white/[0.02] no-print"
      open
    >
      <summary className="cursor-pointer list-none px-5 py-3 text-[11px] font-mono uppercase tracking-[0.16em] text-slate-400 hover:text-cy-300 transition-colors flex items-center justify-between gap-3">
        <span>Jump to section</span>
        <span className="text-slate-600" aria-hidden>
          ▾
        </span>
      </summary>
      <nav
        aria-label="Section navigation"
        className="px-5 pb-4 border-t border-white/[0.04]"
      >
        <ol className="text-[13px] text-slate-300 space-y-1.5 mt-3 list-decimal list-inside marker:text-slate-600">
          {headings.map((h) => (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                className="hover:text-cy-300 transition-colors"
              >
                {h.text}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </details>
  );
}

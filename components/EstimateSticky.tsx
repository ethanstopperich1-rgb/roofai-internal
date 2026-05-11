"use client";

import { useEffect, useRef, useState } from "react";
import { fmt } from "@/lib/pricing";

interface Props {
  total: number;
  sqft: number;
  pitch: string;
  /** Rendered as the source chip (e.g. "SAM3 (custom)", "OSM traced") */
  sourceLabel: string | null;
  /** Confidence colour — "high" mint, "moderate" amber, "low" rose. */
  confidence: "high" | "moderate" | "low" | null;
}

/**
 * Compact floating estimate summary for the rep estimator. Fades in once
 * the rep scrolls past the main ResultsPanel so the headline number stays
 * in view as they work through line items + breakdown below. Hidden when
 * the ResultsPanel is on-screen (so it doesn't compete with the main
 * price card).
 *
 * Implementation note — we don't observe a specific element; we just
 * track scrollY past ~900px which is roughly where the ResultsPanel
 * leaves the top of the viewport on a typical 1080p screen. Cheaper than
 * IntersectionObserver, no ref-passing required from the parent.
 */
export default function EstimateSticky({
  total,
  sqft,
  pitch,
  sourceLabel,
  confidence,
}: Props) {
  const [visible, setVisible] = useState(false);
  const tickRef = useRef(false);

  useEffect(() => {
    const onScroll = () => {
      if (tickRef.current) return;
      tickRef.current = true;
      requestAnimationFrame(() => {
        setVisible(window.scrollY > 900);
        tickRef.current = false;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const dotCls =
    confidence === "high"
      ? "bg-mint"
      : confidence === "moderate"
        ? "bg-amber"
        : confidence === "low"
          ? "bg-rose"
          : "bg-slate-500";

  return (
    <div
      aria-hidden={!visible}
      className={`fixed z-30 left-1/2 -translate-x-1/2 bottom-5 sm:bottom-6 pointer-events-none transition-all duration-300 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
      }`}
    >
      <div
        className="pointer-events-auto flex items-center gap-4 sm:gap-5 px-4 sm:px-5 py-2.5 sm:py-3 rounded-2xl border border-white/[0.08] backdrop-blur-2xl"
        style={{
          background: "rgba(11,14,20,0.82)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 0 rgba(0,0,0,0.5), 0 22px 44px -16px rgba(0,0,0,0.7)",
        }}
      >
        <div className="flex items-baseline gap-1.5">
          <span className="font-display tabular text-[20px] sm:text-[24px] font-semibold tracking-tight text-slate-50 leading-none">
            {fmt(total)}
          </span>
          <span className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500">
            estimate
          </span>
        </div>
        <div className="hidden sm:block h-5 w-px bg-white/[0.08]" />
        <div className="flex items-center gap-3 text-[11.5px] text-slate-300">
          <span className="font-mono tabular">
            <span className="text-slate-50 font-medium">{sqft.toLocaleString()}</span>
            <span className="text-slate-500 ml-1">sf</span>
          </span>
          <span className="text-slate-600">·</span>
          <span className="font-mono tabular">
            <span className="text-slate-50 font-medium">{pitch}</span>
            <span className="text-slate-500 ml-1">pitch</span>
          </span>
        </div>
        {sourceLabel && (
          <>
            <div className="hidden sm:block h-5 w-px bg-white/[0.08]" />
            <div className="hidden sm:flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} aria-hidden />
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-slate-300">
                {sourceLabel}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

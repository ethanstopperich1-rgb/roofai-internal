"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface AuroraButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  className?: string;
  children: React.ReactNode;
  glowClassName?: string;
  /** Tailwind classes applied to the OUTER wrapper. Use this for layout
   *  hooks like `flex-shrink-0` so the wrapper participates correctly in
   *  parent flex rows (the inner button can't take those — the wrapper
   *  gets squeezed and drops out of the row). */
  wrapperClassName?: string;
}

export function AuroraButton({
  className,
  children,
  glowClassName,
  wrapperClassName,
  ...props
}: AuroraButtonProps) {
  return (
    <div
      className={cn(
        // inline-flex so the wrapper sizes to its button child instead of
        // expanding to fill the parent's cross axis. flex-shrink-0 by default
        // so it never collapses below its natural width in a flex row.
        "relative group inline-flex flex-shrink-0",
        wrapperClassName,
      )}
    >
      <div
        className={cn(
          "absolute -inset-[2px] rounded-lg bg-gradient-to-r from-purple-500 via-cyan-300 to-emerald-400 opacity-75 blur-lg transition-all pointer-events-none",
          "group-hover:opacity-100 group-hover:blur-xl",
          glowClassName,
        )}
      />
      <button
        className={cn(
          "relative rounded-lg bg-slate-950/90 px-4 py-2",
          "text-slate-100 shadow-xl",
          "transition-all hover:bg-slate-950/70",
          "border border-slate-800",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </div>
  );
}

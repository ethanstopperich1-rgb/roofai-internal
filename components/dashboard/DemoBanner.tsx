"use client";

/**
 * Top-of-page demo banner. Renders on /demo only — the public surface
 * where the dashboard runs on synthetic data and the visitor needs both
 * (a) clear "this is a demo, not real customer data" signaling, and
 * (b) a way to preview each role's view of the product.
 *
 * Sits above the chrome (sidebar + topbar) at the root of the layout so
 * it's the first thing the eye lands on. Amber accent matches our
 * "warning / signal" colour bucket — same hue as the inline `Demo`
 * pill that used to live alone in the topbar.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2 } from "lucide-react";

interface RoleOption {
  key: "rep" | "manager" | "owner";
  label: string;
  blurb: string;
}

const ROLES: RoleOption[] = [
  {
    key: "rep",
    label: "Rep",
    blurb: "One rep's pipeline · assigned leads only · no cross-rep data",
  },
  {
    key: "manager",
    label: "Manager",
    blurb: "Single office · full team visibility · no admin tools",
  },
  {
    key: "owner",
    label: "Owner / CEO",
    blurb: "Multi-office switcher · cross-company view · all controls",
  },
];

export default function DemoBanner({ activeRole }: { activeRole: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function pick(roleKey: string) {
    if (roleKey === activeRole) return;
    setPending(roleKey);
    try {
      await fetch("/api/demo/role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: roleKey }),
      });
      startTransition(() => {
        router.refresh();
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      className="sticky top-0 z-50 bg-[rgba(36,24,8,0.96)] backdrop-blur-xl shadow-[0_8px_24px_-12px_rgba(243,177,75,0.25)]"
      style={{ borderBottom: "1px solid rgba(243,177,75,0.35)" }}
    >
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-3 lg:py-3.5 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6">
        {/* LEFT — demo callout */}
        <div className="flex items-start lg:items-center gap-3 flex-shrink-0">
          <div className="relative flex items-center justify-center flex-shrink-0">
            <span className="absolute w-7 h-7 rounded-full bg-amber/15 animate-ping" />
            <span className="relative w-5 h-5 rounded-md bg-amber/20 border border-amber/45 flex items-center justify-center">
              <AlertTriangle className="w-3 h-3 text-amber" />
            </span>
          </div>
          <div className="min-w-0">
            <div className="text-[10.5px] font-mono tabular uppercase tracking-[0.22em] text-amber leading-tight">
              Demo mode
            </div>
            <div className="text-[12px] text-white/70 leading-snug">
              Synthetic data · no real customer contacts shown
            </div>
          </div>
        </div>

        {/* DIVIDER — desktop only */}
        <div className="hidden lg:block w-px h-10 bg-amber/15 flex-shrink-0" />

        {/* RIGHT — role picker */}
        <div className="flex-1 min-w-0">
          <div
            role="radiogroup"
            aria-label="Preview the dashboard as a different role"
            className="grid grid-cols-1 sm:grid-cols-3 gap-2"
          >
            {ROLES.map((r) => {
              const active = r.key === activeRole;
              const isPending = pending === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={isPending || active}
                  onClick={() => pick(r.key)}
                  className={[
                    "group relative flex items-start gap-2.5 px-3.5 py-2 rounded-lg text-left transition-colors",
                    active
                      ? "bg-amber/12 border border-amber/45 cursor-default"
                      : "bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.08] hover:border-amber/30",
                    isPending ? "opacity-60" : "",
                  ].join(" ")}
                >
                  <div
                    className={[
                      "w-3.5 h-3.5 mt-0.5 rounded-full flex-shrink-0 flex items-center justify-center transition-colors",
                      active
                        ? "bg-amber/30 border border-amber/55"
                        : "border border-white/15 group-hover:border-amber/35",
                    ].join(" ")}
                  >
                    {isPending ? (
                      <Loader2 className="w-2.5 h-2.5 text-white/70 animate-spin" />
                    ) : active ? (
                      <Check className="w-2.5 h-2.5 text-amber" strokeWidth={3} />
                    ) : null}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className={[
                        "text-[12.5px] font-mono tabular uppercase tracking-[0.12em] leading-tight",
                        active ? "text-amber" : "text-white/85 group-hover:text-white",
                      ].join(" ")}
                    >
                      View as {r.label}
                    </div>
                    <div className="text-[11px] text-white/55 leading-snug mt-0.5 truncate">
                      {r.blurb}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

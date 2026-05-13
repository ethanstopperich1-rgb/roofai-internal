"use client";

/**
 * Dashboard error boundary. Catches any thrown error in /dashboard/* (and
 * the rewritten /demo/*). Without this file the user gets Next.js's
 * generic error page mid-demo — fatal for a sales pitch.
 *
 * Pairs with loading.tsx — both must exist together so the segment has
 * a complete fall-through (suspense -> error). Keep the visual on-brand
 * (glass + cyan) so a failure still reads as part of the product, not a
 * stack-trace screenshot.
 */
import { useEffect } from "react";
import { AlertTriangle, RotateCcw, Radio } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] route error:", error);
  }, [error]);

  // Use `/demo` as the home destination when the visitor is on the
  // public demo surface — the "Back to overview" CTA must NOT route
  // them into the protected /dashboard path that prompts HTTP Basic.
  const pathname = usePathname() ?? "/dashboard";
  const isDemo = pathname === "/demo" || pathname.startsWith("/demo/");
  const homeHref = isDemo ? "/demo" : "/dashboard";

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 py-16">
      <div className="glass-panel-hero p-10 lg:p-12 max-w-lg w-full relative overflow-hidden">
        <div className="absolute -top-32 -right-20 w-[400px] h-[400px] rounded-full bg-rose-400/8 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-32 -left-10 w-[300px] h-[300px] rounded-full bg-cy-300/8 blur-[80px] pointer-events-none" />

        <div className="relative flex flex-col items-center text-center gap-5">
          <div className="relative flex items-center justify-center">
            <span className="absolute w-16 h-16 rounded-full bg-rose-400/12 animate-ping" />
            <div className="relative w-14 h-14 rounded-2xl bg-rose-400/15 border border-rose-400/30 flex items-center justify-center shadow-[0_0_22px_-4px_rgba(255,122,138,0.55)]">
              <AlertTriangle className="w-5 h-5 text-rose-300" />
            </div>
          </div>

          <div className="space-y-2">
            <div className="glass-eyebrow inline-flex">Console interrupted</div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
              <span className="iridescent-text">Something glitched.</span>
            </h1>
            <p className="text-[13.5px] text-white/65 max-w-md leading-relaxed mt-2">
              The dashboard hit an unexpected condition while loading this view. Sydney is still
              listening on the call line — only this panel is affected. Try again, or jump back to
              the overview.
            </p>
          </div>

          {error.digest && (
            <div className="text-[10.5px] font-mono tabular text-white/35 uppercase tracking-[0.16em]">
              ref · {error.digest}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
            <button
              type="button"
              onClick={reset}
              className="glass-button-primary"
              aria-label="Retry loading this page"
            >
              <RotateCcw className="w-4 h-4" />
              Retry
            </button>
            <Link href={homeHref} className="glass-button-secondary">
              <Radio className="w-3.5 h-3.5 text-mint" />
              Back to overview
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

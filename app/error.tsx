"use client";

/**
 * Root error boundary. Catches any thrown error in a route below this
 * file that ISN'T handled by a more-specific error.tsx (e.g. the
 * dashboard's own boundary at app/dashboard/error.tsx still wins for
 * dashboard routes). Without this file, customer-facing crashes on
 * /quote, /embed, /storms, /p/[id] show Next.js's framework default
 * page — fatal during a live sales demo.
 *
 * Renders INSIDE the root layout (so html/body come from layout.tsx —
 * including those here would yield duplicate <html> tags). For errors
 * in the root layout itself, see app/global-error.tsx (not present —
 * the layout is simple enough that we accept the framework default
 * for that vanishingly rare case).
 */
import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw, ArrowRight } from "lucide-react";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[root] route error:", error);
  }, [error]);

  return (
    <main className="flex items-center justify-center min-h-[100dvh] px-4 sm:px-6 py-16">
      <div className="max-w-lg w-full text-center space-y-7">
        <div className="inline-flex w-14 h-14 rounded-2xl items-center justify-center bg-rose-400/12 border border-rose-400/25 shadow-[0_0_22px_-4px_rgba(255,122,138,0.45)]">
          <AlertTriangle className="w-5 h-5 text-rose-300" />
        </div>
        <div className="space-y-3">
          <h1 className="font-display text-[28px] sm:text-[38px] font-semibold tracking-tight text-slate-50 leading-[1.1]">
            Something went sideways.
          </h1>
          <p className="text-[15px] text-slate-400 leading-relaxed mx-auto max-w-md">
            A view in the app hit an unexpected condition. The roofing
            estimator and live operator dashboard are otherwise fine — try
            again, or jump back to the front door.
          </p>
        </div>
        {error.digest && (
          <div className="text-[10.5px] font-mono tabular text-white/35 uppercase tracking-[0.16em]">
            ref · {error.digest}
          </div>
        )}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-1">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[14px] font-medium bg-cy-400 hover:bg-cy-300 text-[#051019] shadow-[0_0_24px_rgba(20,136,252,0.45)] active:scale-[0.98] transition-all"
            aria-label="Try again"
          >
            <RotateCcw className="w-4 h-4" />
            Try again
          </button>
          <Link
            href="/quote"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[14px] font-medium text-slate-200 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.14] transition-colors"
          >
            Get a roof estimate
            <ArrowRight size={14} />
          </Link>
        </div>
      </div>
    </main>
  );
}

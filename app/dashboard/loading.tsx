/**
 * Dashboard route segment loader. Renders during the SSR pause while
 * dashboard pages fetch from Supabase (or build the demo bundle when
 * x-voxaris-demo is set). All dashboard pages are `force-dynamic`, so
 * without this file the user sees a blank frame between nav clicks —
 * a non-starter for a sales demo where every transition is on camera.
 *
 * The visual is intentionally a "booting operator console" — matches the
 * Liquid Glass language but reads as "the system is coming online", not
 * generic shimmer.
 */
import { Radio } from "lucide-react";

export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-7 lg:gap-8">
      {/* Hero skeleton */}
      <div className="glass-panel-hero p-7 lg:p-9 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none opacity-60">
          <div className="absolute -top-32 -right-20 w-[500px] h-[500px] rounded-full bg-cy-300/10 blur-[80px]" />
          <div className="absolute -bottom-32 -left-10 w-[400px] h-[400px] rounded-full bg-violet-300/10 blur-[80px]" />
        </div>
        <div className="relative flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 mb-4">
              <span className="glass-eyebrow">
                <span className="relative flex items-center justify-center mr-1">
                  <span className="absolute w-2 h-2 rounded-full bg-cy-300/40 animate-ping" />
                  <span className="relative w-1 h-1 rounded-full bg-cy-300" />
                </span>
                Booting operator console
              </span>
            </div>
            <div className="space-y-3 mt-1">
              <div className="h-9 w-[60%] max-w-md rounded-md shimmer opacity-80" />
              <div className="h-9 w-[78%] max-w-lg rounded-md shimmer opacity-60" />
              <div className="h-3 w-[44%] max-w-sm rounded-md shimmer opacity-40 mt-5" />
              <div className="h-3 w-[38%] max-w-xs rounded-md shimmer opacity-30" />
            </div>
          </div>
          <div className="lg:w-80 shrink-0">
            <div className="rounded-2xl border border-white/[0.10] bg-white/[0.04] backdrop-blur-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Radio className="w-3.5 h-3.5 text-mint animate-pulse" />
                  <span className="text-[12px] font-medium text-white/90">Sydney</span>
                </div>
                <span className="text-[10px] font-mono tabular text-mint/70 uppercase tracking-[0.14em]">
                  Connecting…
                </span>
              </div>
              <div className="h-8 w-24 rounded-md shimmer mb-3" />
              <div className="h-2.5 w-32 rounded-md shimmer opacity-40" />
            </div>
          </div>
        </div>
      </div>

      {/* Stat grid skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="glass-panel p-5 lg:p-6">
            <div className="w-9 h-9 rounded-2xl bg-white/[0.05] mb-4" />
            <div className="h-2.5 w-16 rounded-md shimmer opacity-60 mb-3" />
            <div className="h-8 w-24 rounded-md shimmer" />
            <div className="h-2.5 w-20 rounded-md shimmer opacity-40 mt-2" />
          </div>
        ))}
      </div>

      {/* Activity + jump-in skeleton */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6">
        <div className="glass-panel p-5 lg:p-7 xl:col-span-2">
          <div className="flex items-center justify-between mb-5">
            <div className="h-3 w-28 rounded-md shimmer opacity-60" />
            <div className="h-2.5 w-20 rounded-md shimmer opacity-40" />
          </div>
          <ul className="flex flex-col">
            {Array.from({ length: 6 }).map((_, i) => (
              <li
                key={i}
                className="flex items-start gap-3.5 py-3.5 border-b border-white/[0.04] last:border-b-0"
                style={{ opacity: 1 - i * 0.12 }}
              >
                <div className="w-7 h-7 rounded-xl bg-white/[0.04] flex-shrink-0" />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="h-2.5 w-[70%] rounded-md shimmer opacity-70" />
                  <div className="h-2 w-[40%] rounded-md shimmer opacity-40" />
                </div>
                <div className="h-2 w-12 rounded-md shimmer opacity-30" />
              </li>
            ))}
          </ul>
        </div>
        <aside className="flex flex-col gap-4">
          <div className="glass-panel p-5 lg:p-6">
            <div className="h-3 w-20 rounded-md shimmer opacity-60 mb-4" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 rounded-2xl bg-white/[0.02] border border-white/[0.06] mb-2" />
            ))}
          </div>
          <div className="glass-panel p-5 lg:p-6">
            <div className="h-2.5 w-16 rounded-md shimmer opacity-60 mb-3" />
            <div className="h-2 w-[80%] rounded-md shimmer opacity-40 mb-2" />
            <div className="h-2 w-[60%] rounded-md shimmer opacity-30" />
          </div>
        </aside>
      </div>
    </div>
  );
}

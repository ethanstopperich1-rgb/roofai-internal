import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import PublicHeader from "@/components/ui/public-header";
import PublicFooter from "@/components/ui/public-footer";

/**
 * Custom 404 page. Wired automatically by Next.js App Router when a
 * route resolves to nothing — replaces the bare framework default with
 * brand-coherent chrome and a clear path back to the customer flow.
 *
 * Audience: anyone who mistyped a URL, clicked a stale share link, or
 * landed via an out-of-date Google index. They're not lost long — a
 * single big CTA pushes them to /quote where the rest of the product
 * begins.
 *
 * noindex via metadata so this page itself never enters a search index.
 */
export const metadata: Metadata = {
  title: "Not found · Voxaris Pitch",
  description: "The page you tried to reach doesn't exist. Get a roof estimate in 30 seconds.",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="min-h-[100dvh] flex flex-col lg-env">
      <PublicHeader chip="404" />
      <main
        id="main-content"
        className="flex-1 flex items-center justify-center px-4 sm:px-6 py-16 sm:py-24"
      >
        <div className="max-w-xl w-full text-center space-y-7">
          {/* Big quiet "404" — display-weight, low-opacity, sets tone */}
          <div
            className="font-display tabular text-[120px] sm:text-[180px] font-semibold leading-none tracking-[-0.04em] text-white/[0.07] select-none"
            aria-hidden
          >
            404
          </div>
          <div className="space-y-3">
            <h1 className="font-display text-[28px] sm:text-[38px] font-semibold tracking-tight text-slate-50 leading-[1.1]">
              That page isn&apos;t here.
            </h1>
            <p className="text-[15px] sm:text-[16px] text-slate-400 leading-relaxed mx-auto max-w-md">
              The link may be old, the address mistyped, or the page may have
              been moved. The roof estimator is two clicks away — pick up where
              you meant to.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <Link
              href="/quote"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[14px] font-medium bg-cy-400 hover:bg-cy-300 text-[#051019] shadow-[0_0_24px_rgba(20,136,252,0.45)] active:scale-[0.98] transition-all"
            >
              Get a quote in 30 seconds <ArrowRight size={14} />
            </Link>
            <Link
              href="/storms"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl text-[14px] font-medium text-slate-200 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.14] transition-colors"
            >
              For roofing operators
            </Link>
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared chrome for /privacy and /terms. Lives outside both the
 * (internal) staff group and the customer wizard, so the policy pages
 * are clean static documents with no header / nav distractions —
 * which is also what legal review wants ("nothing on the page that
 * could be construed as modifying the policy text").
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative z-[1] min-h-screen px-4 sm:px-6 py-12 sm:py-20">
      <div className="max-w-3xl mx-auto">
        <Link
          href="/"
          className="inline-block mb-10 text-[12px] font-mono uppercase tracking-[0.16em] text-slate-400 hover:text-cy-300 transition-colors"
        >
          ← Voxaris Pitch
        </Link>
        <article className="prose prose-invert max-w-none">{children}</article>
        <footer className="mt-16 pt-8 border-t border-white/[0.06] flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-slate-500">
          <Link href="/privacy" className="hover:text-slate-300">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-slate-300">Terms of Service</Link>
          <span className="text-slate-600">© {new Date().getFullYear()} Voxaris, Inc.</span>
        </footer>
      </div>
    </main>
  );
}

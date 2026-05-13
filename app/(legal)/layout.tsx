import type { ReactNode } from "react";
import PublicHeader from "@/components/ui/public-header";
import PublicFooter from "@/components/ui/public-footer";
import LegalTOC from "@/components/ui/legal-toc";

/**
 * Shared chrome for /privacy /terms /methodology. Now uses the shared
 * PublicHeader + PublicFooter so the policy pages read as part of the
 * product instead of three lone documents with a text back-link.
 *
 * Legal review's only constraint was "nothing on the page that could
 * be construed as modifying the policy text" — the header is purely
 * navigational chrome, the policy text itself is untouched inside
 * the <article>, and the footer carries only the same Privacy/Terms/
 * How-we-measure cross-links plus the brand copyright. None of that
 * modifies the underlying policy text — it just stops the legal pages
 * from looking like an unfinished product.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <PublicHeader chip="Legal" />
      <main className="relative z-[1] flex-1 px-4 sm:px-6 py-12 sm:py-20">
        <div className="max-w-3xl mx-auto">
          {/* Auto-generated TOC from <article> h2 elements. Hides
              itself for short docs (<3 sections). Helps readers
              jump around 200+ line privacy / terms / methodology
              pages without scrolling end-to-end. */}
          <LegalTOC />
          <article className="prose prose-invert max-w-none">{children}</article>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

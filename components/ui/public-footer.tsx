import Link from "next/link";

/**
 * Shared public-surface footer. Same brand-consistent copyright +
 * Privacy / Terms / Storms link block used on every public route.
 *
 * Previously each page rolled its own footer (/quote, /storms, the
 * legal layout) with subtly different copy and link ordering. This
 * component is the single source so a copy change updates everywhere
 * at once.
 *
 * Copyright reads "Voxaris Pitch" (not bare "Voxaris" or "Voxaris,
 * Inc.") to match the wordmark + metadata title + the rest of the
 * product surface.
 */
export default function PublicFooter() {
  return (
    <footer className="border-t border-white/[0.08] mt-12">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 flex flex-wrap items-center justify-between gap-y-3 gap-x-6 text-[11px] text-white/45 font-mono">
        <span>© {new Date().getFullYear()} Voxaris Pitch</span>
        <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
          <Link href="/privacy" className="hover:text-white/70 transition-colors">
            Privacy
          </Link>
          <span className="text-white/25">·</span>
          <Link href="/terms" className="hover:text-white/70 transition-colors">
            Terms
          </Link>
          <span className="text-white/25">·</span>
          <Link href="/methodology" className="hover:text-white/70 transition-colors">
            How we measure
          </Link>
          <span className="text-white/25">·</span>
          <Link href="/storms" className="hover:text-white/70 transition-colors">
            For roofing operators
          </Link>
          <span className="text-white/25">·</span>
          <span>Estimates are non-binding</span>
        </div>
      </div>
    </footer>
  );
}

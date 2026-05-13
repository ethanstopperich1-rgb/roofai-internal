import Link from "next/link";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import NavHeader from "@/components/ui/nav-header";

/**
 * Shared public-surface header. Used by every customer-facing or
 * partner-facing route so the brand reads as one product instead of
 * five different page templates:
 *
 *   - /quote         → chip "Quick Quote",      nav with quote-specific anchors
 *   - /storms        → chip "Storm Intelligence" with amber accent
 *   - /p/[id]        → minimal (no nav), customer destination
 *   - /embed/install → chip "Install"
 *   - /(legal)/*     → minimal back-to-quote affordance
 *
 * The previous state was each of these pages rolling their own header
 * (different logo size, different wordmark — /storms even rendered
 * the brand as a text span instead of the logo image) which made the
 * site feel like a stack of independent pages. This component
 * replaces all of them with one component + per-page props.
 *
 * Logo size is fixed at the wizard-bar size (h-9 sm:h-14, max-w-[180px]
 * on mobile) — the hero-size logo lives inside BoltStyleHero on /quote
 * and is intentionally separate (display logo vs nav logo).
 *
 * Accent color: defaults to the cyan-300 brand accent. Pages that
 * need their own theming (e.g. /storms warm amber) can pass
 * `chipClassName` to override the chip's styling. Default chip uses
 * the existing `chip` utility class from globals.css.
 */
export interface PublicHeaderProps {
  /** Short label next to the logo ("Quick Quote", "Install", etc.) */
  chip?: string;
  /** Override the chip's tailwind classes (e.g. amber variant on /storms) */
  chipClassName?: string;
  /** Optional nav items in the center pill (anchors / cross-page links) */
  nav?: Array<{ label: string; href: string }>;
  /** Right-side content. Defaults to "Free · No-obligation" chip on /quote.
   *  Pass null to suppress entirely (e.g. on /p/[id] the right side is empty). */
  rightSlot?: ReactNode;
  /** href the logo links to. Defaults to /quote (the main customer destination). */
  logoHref?: string;
}

const DEFAULT_RIGHT_SLOT: ReactNode = (
  <div className="hidden sm:flex items-center gap-3 text-[12px] text-white/75 justify-self-end">
    <Check size={13} className="text-mint" />
    <span>Free · No-obligation</span>
  </div>
);

export default function PublicHeader({
  chip,
  chipClassName,
  nav,
  rightSlot = DEFAULT_RIGHT_SLOT,
  logoHref = "/quote",
}: PublicHeaderProps) {
  return (
    <header
      className="relative z-30"
      style={{
        background:
          "linear-gradient(180deg, rgba(8,11,17,0.55) 0%, rgba(8,11,17,0.25) 100%)",
        backdropFilter: "blur(40px) saturate(1.5)",
        WebkitBackdropFilter: "blur(40px) saturate(1.5)",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.04)",
      }}
    >
      {/* 3-column grid (1fr | auto | 1fr) so the nav pill in the
          middle is truly centered — flex justify-between centers it
          between the left and right siblings, which have different
          widths and pulled the nav off-center on the original /quote
          implementation. Keep this layout when porting other pages
          over. */}
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 h-16 sm:h-20 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <Link
          href={logoHref}
          className="flex items-center gap-2 min-w-0 justify-self-start"
          aria-label="Voxaris Pitch — home"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/logo-wordmark-alpha.png"
            alt="Voxaris Pitch"
            width={1672}
            height={941}
            className="h-9 sm:h-14 w-auto max-w-[180px] sm:max-w-none object-contain"
          />
          {chip && (
            <span className={chipClassName ?? "hidden md:inline-block ml-1 chip text-[10px]"}>
              {chip}
            </span>
          )}
        </Link>

        {nav && nav.length > 0 ? (
          <NavHeader items={nav} />
        ) : (
          // Empty placeholder keeps the 3-column grid alignment intact
          // even when there's no nav.
          <span aria-hidden="true" />
        )}

        {rightSlot ?? <span aria-hidden="true" />}
      </div>
    </header>
  );
}

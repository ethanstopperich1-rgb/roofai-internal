"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import NavHeader from "@/components/ui/nav-header";

/**
 * Internal staff header. Hidden on customer-facing routes (/quote, /p/[id])
 * and on the embeddable widget (/embed) — those render their own chrome,
 * or in /embed's case, no chrome at all because they live inside an iframe
 * on a third-party site.
 */
export default function InternalHeader() {
  const pathname = usePathname() ?? "/";
  const isCustomerRoute =
    pathname.startsWith("/quote") ||
    pathname.startsWith("/p/") ||
    pathname.startsWith("/embed");
  // /dashboard renders its own chrome (sidebar + topbar) so the global
  // staff header would double up — hide it there. /demo is the public
  // pitch surface that middleware rewrites internally to /dashboard,
  // but usePathname() returns the browser URL ("/demo") not the rewrite
  // target, so we must match both prefixes explicitly. Without this,
  // the marketing header rendered ON TOP of the dashboard chrome and
  // (worse) created a hydration mismatch that orphaned the Suspense
  // content subtree outside <main>, breaking every theme CSS rule.
  const isDashboardRoute =
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname === "/demo" ||
    pathname.startsWith("/demo/");
  // Legal + public marketing pages: any route a homeowner or
  // contractor reaches from the customer flow. They should never see
  // staff nav ("ESTIMATOR · HISTORY · ADMIN") because that's internal
  // tooling — surfacing it on public pages reads as "unfinished
  // product" and leaks routes that 401 if anyone clicks them.
  // /storms is public-marketing (for roofing operators), /privacy +
  // /terms + /methodology are legal pages a homeowner reaches from
  // /quote's TCPA disclosure + footer.
  const isLegalOrPublicMarketingRoute =
    pathname === "/privacy" ||
    pathname === "/terms" ||
    pathname === "/methodology" ||
    pathname === "/login" ||
    pathname === "/storms" ||
    pathname.startsWith("/storms/");
  if (isCustomerRoute || isDashboardRoute || isLegalOrPublicMarketingRoute) return null;

  return (
    <header
      className="sticky top-0 z-40 border-b border-white/[0.08]"
      style={{
        background:
          "linear-gradient(180deg, rgba(8,11,17,0.72) 0%, rgba(8,11,17,0.55) 100%)",
        backdropFilter: "blur(32px) saturate(180%)",
        WebkitBackdropFilter: "blur(32px) saturate(180%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 0 rgba(0,0,0,0.4)",
      }}
    >
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 h-16 sm:h-20 flex items-center justify-between gap-3">
        <Link href="/" className="group flex items-center gap-2 min-w-0" aria-label="Voxaris Pitch">
          <img
            src="/brand/logo-wordmark-alpha.png"
            alt="Voxaris Pitch"
            width={1672}
            height={941}
            className="h-9 sm:h-14 w-auto max-w-[180px] sm:max-w-none object-contain"
          />
          <span className="hidden md:inline-block ml-1 chip text-[10px]">beta</span>
        </Link>

        <NavHeader
          items={[
            { label: "Estimator", href: "/" },
            { label: "History", href: "/history" },
            { label: "Admin", href: "/admin" },
          ]}
        />

        <div className="flex items-center gap-3 text-[12px] text-slate-400">
          <span className="hidden md:inline-flex items-center gap-2">
            <span className="font-mono uppercase tracking-[0.14em] text-[10px] text-slate-500">Internal</span>
          </span>
        </div>
      </div>
    </header>
  );
}

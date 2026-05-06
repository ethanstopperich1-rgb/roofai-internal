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
  if (isCustomerRoute) return null;

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#07090d]/70 backdrop-blur-xl">
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
            <span className="w-1.5 h-1.5 rounded-full bg-mint pulse-dot" />
            <span className="font-mono uppercase tracking-[0.14em] text-[10px]">Live</span>
          </span>
        </div>
      </div>
    </header>
  );
}

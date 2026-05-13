"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  PhoneCall,
  Users,
  FileText,
  BarChart3,
  Settings as SettingsIcon,
  ShieldCheck,
  Menu,
  X,
  Radio,
  Check,
  AlertTriangle,
} from "lucide-react";
import type { DemoOffice } from "@/lib/dashboard-demo";

/**
 * Operator console chassis.
 *
 * visionOS Liquid Glass: aurora environment via `lg-env` on the layout
 * wrapper, glass sidebar floating over the canvas, status pulse at the
 * top, "Sydney online" indicator that telegraphs the platform is alive.
 *
 * Office switcher: the chip in the topbar opens a glass dropdown of all
 * seeded offices. Picking one POSTs to /api/office/switch (which sets
 * the `voxaris_demo_office` cookie) and router-refreshes so every
 * Server Component re-reads the demo data for the new office.
 */

type NavItem = {
  segment: "" | "/calls" | "/leads" | "/proposals" | "/analytics" | "/settings" | "/admin";
  label: string;
  icon: typeof LayoutDashboard;
  match: "exact" | "prefix";
  internalOnly?: boolean; // Hidden on the public /demo route
};

const NAV: NavItem[] = [
  { segment: "", label: "Overview", icon: LayoutDashboard, match: "exact" },
  { segment: "/calls", label: "Sydney Calls", icon: PhoneCall, match: "prefix" },
  { segment: "/leads", label: "Leads", icon: Users, match: "prefix" },
  { segment: "/proposals", label: "Proposals", icon: FileText, match: "prefix" },
  { segment: "/analytics", label: "Analytics", icon: BarChart3, match: "prefix" },
  { segment: "/settings", label: "Settings", icon: SettingsIcon, match: "prefix", internalOnly: true },
  { segment: "/admin", label: "Admin", icon: ShieldCheck, match: "prefix", internalOnly: true },
];

function isActive(pathname: string, item: NavItem, basePath: string): boolean {
  const href = basePath + item.segment;
  if (item.match === "exact") return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

interface DashboardChromeProps {
  children: ReactNode;
  offices: DemoOffice[];
  activeOffice: DemoOffice;
}

export default function DashboardChrome({
  children,
  offices,
  activeOffice,
}: DashboardChromeProps) {
  const rawPathname = usePathname() ?? "/dashboard";
  const isDemo = rawPathname === "/demo" || rawPathname.startsWith("/demo/");
  const basePath = isDemo ? "/demo" : "/dashboard";
  const pathname = rawPathname;
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="relative min-h-screen flex flex-col lg:flex-row">
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-30 px-4 py-3 flex items-center justify-between border-b border-white/[0.06] bg-[rgba(8,11,17,0.72)] backdrop-blur-xl">
        <Link href={basePath} className="flex items-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/logo-wordmark-alpha.png"
            alt="Voxaris Pitch"
            className="h-7 w-auto select-none"
            draggable={false}
          />
        </Link>
        <button
          type="button"
          aria-label={drawerOpen ? "Close menu" : "Open menu"}
          onClick={() => setDrawerOpen((v) => !v)}
          className="glass-button-secondary !px-3 !py-1.5"
        >
          {drawerOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
        </button>
      </div>

      {/* Sidebar — desktop */}
      <aside className="hidden lg:flex lg:w-72 xl:w-80 shrink-0 flex-col gap-5 px-6 py-7 border-r border-white/[0.06] sticky top-0 h-screen bg-[rgba(8,11,17,0.32)] backdrop-blur-2xl">
        <SidebarContent pathname={pathname} basePath={basePath} isDemo={isDemo} />
      </aside>

      {/* Drawer — mobile */}
      {drawerOpen && (
        <div className="lg:hidden border-b border-white/[0.06] px-4 py-4 bg-[rgba(8,11,17,0.86)] backdrop-blur-xl">
          <SidebarContent
            pathname={pathname}
            basePath={basePath}
            isDemo={isDemo}
            onNavigate={() => setDrawerOpen(false)}
          />
          <div className="mt-4 pt-4 border-t border-white/[0.06]">
            <div className="text-[10px] font-mono tabular uppercase tracking-[0.18em] text-white/40 mb-2 px-1">
              Active office
            </div>
            <OfficeSwitcher
              offices={offices}
              activeOffice={activeOffice}
              variant="drawer"
              onSwitched={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0 flex flex-col">
        {/* Desktop top bar */}
        <div className="hidden lg:flex items-center justify-between px-8 py-5 border-b border-white/[0.06] bg-[rgba(8,11,17,0.22)] backdrop-blur-xl">
          <div className="flex items-center gap-6">
            <OfficeSwitcher offices={offices} activeOffice={activeOffice} variant="topbar" />

            <div className="flex items-center gap-2 text-[12px] text-white/65">
              <div className="relative flex items-center justify-center">
                <span className="absolute w-3 h-3 rounded-full bg-mint/40 animate-ping" />
                <span className="relative w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_8px_rgba(95,227,176,0.6)]" />
              </div>
              <Radio className="w-3.5 h-3.5 text-mint/80" />
              <span>
                <span className="text-mint font-medium">Sydney</span>
                <span className="text-white/45"> · standing by</span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-5">
            <div className="text-[11px] text-white/45 font-mono tabular uppercase tracking-[0.16em] hidden xl:block">
              {new Date().toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </div>
            {isDemo ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber/30 bg-amber/10 text-[11px] font-mono tabular uppercase tracking-[0.14em] text-amber">
                <span className="w-1.5 h-1.5 rounded-full bg-amber shadow-[0_0_6px_rgba(243,177,75,0.6)]" />
                Demo mode
              </span>
            ) : (
              <>
                <div className="text-xs text-white/60 font-mono tabular">admin@voxaris.io</div>
                <form action="/auth/signout" method="POST">
                  <button
                    type="submit"
                    className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/45 hover:text-white/85 transition-colors"
                  >
                    Sign out
                  </button>
                </form>
              </>
            )}
          </div>
        </div>

        <div className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1400px] mx-auto w-full">
          {children}
        </div>

        {/* Footer ribbon */}
        <div className="border-t border-white/[0.06] px-4 sm:px-6 lg:px-8 py-4 mt-auto bg-[rgba(8,11,17,0.28)] backdrop-blur-xl">
          <div className="max-w-[1400px] mx-auto flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono tabular uppercase tracking-[0.16em] text-white/40">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_8px_rgba(95,227,176,0.5)] animate-pulse" />
                Live
              </span>
              <span className="text-white/15">·</span>
              <span>Sydney online</span>
              <span className="text-white/15">·</span>
              <span>
                {offices.length} offices · routed to {activeOffice.shortName}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span>Voxaris AI</span>
              <span className="text-white/15">·</span>
              <span>Operator Console</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── Office switcher ──────────────────────────────────────────────────

function OfficeSwitcher({
  offices,
  activeOffice,
  variant,
  onSwitched,
}: {
  offices: DemoOffice[];
  activeOffice: DemoOffice;
  variant: "topbar" | "drawer";
  onSwitched?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(variant === "drawer");
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  // Index of the option currently focused via keyboard. -1 = none.
  const [highlightIdx, setHighlightIdx] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click (topbar variant only)
  useEffect(() => {
    if (variant !== "topbar" || !open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, variant]);

  // Reset keyboard highlight when the dropdown opens — start on the
  // currently active office so Enter immediately = no-op (sensible default).
  useEffect(() => {
    if (open) {
      const activeIdx = offices.findIndex((o) => o.slug === activeOffice.slug);
      setHighlightIdx(activeIdx >= 0 ? activeIdx : 0);
    } else {
      setHighlightIdx(-1);
    }
  }, [open, offices, activeOffice.slug]);

  // Auto-dismiss the error toast after a few seconds.
  useEffect(() => {
    if (!errorToast) return;
    const t = setTimeout(() => setErrorToast(null), 4500);
    return () => clearTimeout(t);
  }, [errorToast]);

  async function pick(slug: string) {
    if (slug === activeOffice.slug) {
      setOpen(false);
      onSwitched?.();
      return;
    }
    setPendingSlug(slug);
    try {
      const res = await fetch("/api/office/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) throw new Error(`switch_failed_${res.status}`);
      router.refresh();
    } catch (err) {
      console.error("[office-switch] failed:", err);
      setErrorToast("Couldn't switch office — please try again.");
    } finally {
      setPendingSlug(null);
      setOpen(false);
      onSwitched?.();
    }
  }

  // Keyboard nav on the dropdown — Escape closes, arrows navigate, Home/End
  // jump, Enter/Space picks. Applies to both topbar and drawer variants.
  function onListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => (i + 1) % offices.length);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => (i - 1 + offices.length) % offices.length);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setHighlightIdx(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setHighlightIdx(offices.length - 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      if (highlightIdx >= 0 && highlightIdx < offices.length) {
        e.preventDefault();
        pick(offices[highlightIdx].slug);
      }
    }
  }

  const isTopbar = variant === "topbar";

  return (
    <div ref={rootRef} className={isTopbar ? "relative" : ""} onKeyDown={onListKeyDown}>
      {isTopbar && (
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if ((e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") && !open) {
              e.preventDefault();
              setOpen(true);
            }
          }}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Office: ${activeOffice.name}. Press Enter to switch.`}
          className="flex items-center gap-2.5 px-3 py-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
        >
          <span
            className="h-5 w-5 rounded-md border border-white/10 flex items-center justify-center text-[10px] font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
            style={{
              background: `linear-gradient(135deg, ${activeOffice.brand}66, ${activeOffice.brand}33)`,
            }}
          >
            {activeOffice.initial}
          </span>
          <span className="text-[13px] text-white/85 font-medium">{activeOffice.shortName}</span>
          <span className="text-[10px] font-mono tabular text-white/40 uppercase tracking-wider ml-1">
            Office
          </span>
          <svg
            className={`w-3 h-3 text-white/40 ml-0.5 transition-transform ${open ? "rotate-180" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}

      {open && (
        <div
          role="listbox"
          aria-label="Switch office"
          tabIndex={-1}
          className={
            isTopbar
              ? "absolute z-40 mt-2 left-0 w-72 rounded-2xl border border-white/[0.08] bg-[rgba(8,11,17,0.92)] backdrop-blur-2xl shadow-[0_24px_60px_-12px_rgba(0,0,0,0.6)] p-1.5 outline-none"
              : "flex flex-col gap-1 outline-none"
          }
        >
          {isTopbar && (
            <div className="px-3 pt-2 pb-1.5 text-[10px] font-mono tabular uppercase tracking-[0.18em] text-white/40">
              Switch office
            </div>
          )}
          {offices.map((o, i) => {
            const isActiveOffice = o.slug === activeOffice.slug;
            const isPending = pendingSlug === o.slug;
            const isHighlighted = i === highlightIdx;
            return (
              <button
                key={o.slug}
                type="button"
                role="option"
                aria-selected={isActiveOffice}
                disabled={isPending}
                onClick={() => pick(o.slug)}
                onMouseEnter={() => setHighlightIdx(i)}
                className={[
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors",
                  isActiveOffice
                    ? "bg-white/[0.06] border border-white/[0.08]"
                    : isHighlighted
                      ? "bg-white/[0.05] border border-white/[0.06]"
                      : "border border-transparent hover:bg-white/[0.04]",
                  isPending ? "opacity-60" : "",
                ].join(" ")}
              >
                <span
                  className="h-7 w-7 rounded-lg border border-white/10 flex items-center justify-center text-[11px] font-bold text-white shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
                  style={{
                    background: `linear-gradient(135deg, ${o.brand}66, ${o.brand}33)`,
                  }}
                >
                  {o.initial}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[13px] text-white/90 font-medium leading-tight truncate">
                    {o.name}
                  </span>
                  <span className="block text-[11px] text-white/45 leading-tight mt-0.5 truncate">
                    {o.city}, {o.state}
                  </span>
                </span>
                {isActiveOffice && <Check className="w-3.5 h-3.5 text-mint shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      {errorToast && (
        <div
          role="alert"
          aria-live="assertive"
          className={[
            "console-toast pointer-events-auto fixed z-[60] flex items-start gap-2.5",
            "right-4 top-4 lg:right-6 lg:top-6 max-w-[320px]",
            "px-3.5 py-3 rounded-2xl border border-rose-400/30",
            "bg-[rgba(28,12,16,0.92)] backdrop-blur-2xl",
            "shadow-[0_18px_36px_-12px_rgba(255,122,138,0.45)]",
          ].join(" ")}
        >
          <AlertTriangle className="w-4 h-4 text-rose-300 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-mono tabular text-rose-300/85 uppercase tracking-[0.16em]">
              Switch failed
            </div>
            <div className="text-[12.5px] text-white/85 leading-snug mt-0.5">{errorToast}</div>
          </div>
          <button
            type="button"
            onClick={() => setErrorToast(null)}
            aria-label="Dismiss error"
            className="text-white/45 hover:text-white/85 transition-colors flex-shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function SidebarContent({
  pathname,
  basePath,
  isDemo,
  onNavigate,
}: {
  pathname: string;
  basePath: string;
  isDemo: boolean;
  onNavigate?: () => void;
}) {
  const navItems = isDemo ? NAV.filter((n) => !n.internalOnly) : NAV;
  return (
    <>
      <Link
        href={basePath}
        onClick={onNavigate}
        className="hidden lg:flex flex-col items-start gap-1.5 px-1"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/logo-wordmark-alpha.png"
          alt="Voxaris Pitch"
          className="h-9 w-auto select-none drop-shadow-[0_6px_18px_rgba(125,211,252,0.18)]"
          draggable={false}
        />
        <span className="text-[10px] font-mono tabular uppercase tracking-[0.18em] text-white/40 pl-0.5">
          {isDemo ? "Demo Console" : "Operator Console"}
        </span>
      </Link>
      <div className="hidden lg:block glass-divider mt-2" />

      <nav className="flex flex-col gap-1">
        {navItems.map((item) => {
          const href = basePath + item.segment;
          const active = isActive(pathname, item, basePath);
          const Icon = item.icon;
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              className={[
                "group flex items-center gap-3 px-3 py-2.5 rounded-2xl text-[13.5px] font-medium transition-all",
                active
                  ? "bg-white/[0.07] text-white border border-white/[0.10] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                  : "text-white/65 hover:text-white hover:bg-white/[0.035] border border-transparent",
              ].join(" ")}
            >
              <span
                className={[
                  "relative flex items-center justify-center w-7 h-7 rounded-xl transition-colors",
                  active
                    ? "bg-cy-300/15 text-cy-300 border border-cy-300/25 shadow-[0_0_14px_-4px_rgba(125,211,252,0.55)]"
                    : "text-white/55 group-hover:text-white/85",
                ].join(" ")}
              >
                <Icon className="w-3.5 h-3.5" />
              </span>
              <span className="truncate">{item.label}</span>
              {active && (
                <span className="ml-auto w-1 h-1 rounded-full bg-cy-300 shadow-[0_0_6px_rgba(125,211,252,0.7)]" />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="hidden lg:flex mt-auto flex-col gap-3">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.025] backdrop-blur-xl p-3.5">
          <div className="flex items-center gap-2 mb-2">
            <div className="relative flex items-center justify-center">
              <span className="absolute w-3 h-3 rounded-full bg-mint/40 animate-ping" />
              <span className="relative w-1.5 h-1.5 rounded-full bg-mint shadow-[0_0_8px_rgba(95,227,176,0.6)]" />
            </div>
            <span className="text-[12px] font-medium text-white/85">Sydney</span>
            <span className="ml-auto text-[10px] font-mono tabular text-mint/85 uppercase tracking-wider">
              Online
            </span>
          </div>
          <div className="text-[11px] text-white/50 leading-relaxed">
            Inbound voice agent. Listening across every office, 24/7.
          </div>
        </div>
        <div className="text-[10px] font-mono tabular text-white/30 uppercase tracking-[0.18em] text-center">
          v1.0 · Production
        </div>
      </div>
    </>
  );
}

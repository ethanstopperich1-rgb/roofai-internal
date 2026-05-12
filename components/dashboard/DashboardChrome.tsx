"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
} from "lucide-react";

/**
 * Operator console chassis.
 *
 * visionOS Liquid Glass: aurora environment via `lg-env` on the layout
 * wrapper, glass sidebar floating over the canvas, status pulse at the
 * top, "Sydney online" indicator that telegraphs the platform is alive.
 *
 * Layout uses min-h-screen on the outer flex container + flex-grow on
 * main + a footer ribbon, so short pages never leave a black void
 * below the content.
 */

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, match: "exact" as const },
  { href: "/dashboard/calls", label: "Sydney Calls", icon: PhoneCall, match: "prefix" as const },
  { href: "/dashboard/leads", label: "Leads", icon: Users, match: "prefix" as const },
  { href: "/dashboard/proposals", label: "Proposals", icon: FileText, match: "prefix" as const },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3, match: "prefix" as const },
  { href: "/dashboard/settings", label: "Settings", icon: SettingsIcon, match: "prefix" as const },
  { href: "/dashboard/admin", label: "Admin", icon: ShieldCheck, match: "prefix" as const },
];

function isActive(pathname: string, item: (typeof NAV)[number]): boolean {
  if (item.match === "exact") return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

export default function DashboardChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/dashboard";
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="relative min-h-screen flex flex-col lg:flex-row">
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-30 px-4 py-3 flex items-center justify-between border-b border-white/[0.06] bg-[rgba(8,11,17,0.72)] backdrop-blur-xl">
        <Link href="/dashboard" className="flex items-center">
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

      {/* Sidebar — desktop. Floats over the aurora canvas with a soft
          right border and lots of breathing room. */}
      <aside className="hidden lg:flex lg:w-72 xl:w-80 shrink-0 flex-col gap-5 px-6 py-7 border-r border-white/[0.06] sticky top-0 h-screen bg-[rgba(8,11,17,0.32)] backdrop-blur-2xl">
        <SidebarContent pathname={pathname} />
      </aside>

      {/* Drawer — mobile */}
      {drawerOpen && (
        <div className="lg:hidden border-b border-white/[0.06] px-4 py-4 bg-[rgba(8,11,17,0.86)] backdrop-blur-xl">
          <SidebarContent pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
        </div>
      )}

      {/* Main column — flex column so footer can pin to bottom on short pages */}
      <main className="flex-1 min-w-0 flex flex-col">
        {/* Desktop top bar — operator status strip */}
        <div className="hidden lg:flex items-center justify-between px-8 py-5 border-b border-white/[0.06] bg-[rgba(8,11,17,0.22)] backdrop-blur-xl">
          <div className="flex items-center gap-6">
            {/* Office switcher chip — implies multi-tenancy */}
            <button
              type="button"
              className="flex items-center gap-2.5 px-3 py-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
            >
              <div className="h-5 w-5 rounded-md bg-gradient-to-br from-cy-300/40 to-violet-300/30 border border-white/10 flex items-center justify-center text-[10px] font-bold text-white">
                V
              </div>
              <span className="text-[13px] text-white/85 font-medium">Voxaris</span>
              <span className="text-[10px] font-mono tabular text-white/40 uppercase tracking-wider ml-1">
                Office
              </span>
              <svg className="w-3 h-3 text-white/40 ml-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* Sydney live indicator */}
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
            <div className="text-xs text-white/60 font-mono tabular">staff@voxaris.io</div>
            <form action="/auth/signout" method="POST">
              <button
                type="submit"
                className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/45 hover:text-white/85 transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        {/* Content — flex-1 so any leftover vertical space stays balanced */}
        <div className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1400px] mx-auto w-full">
          {children}
        </div>

        {/* Footer ribbon — pins to bottom on short pages, kills the void */}
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
              <span>Multi-office RLS active</span>
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

function SidebarContent({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      <Link
        href="/dashboard"
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
          Operator Console
        </span>
      </Link>
      <div className="hidden lg:block glass-divider mt-2" />

      <nav className="flex flex-col gap-1">
        {NAV.map((item) => {
          const active = isActive(pathname, item);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
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

      {/* Sidebar footer — Sydney status card, gives the sidebar weight */}
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

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
} from "lucide-react";

/**
 * The persistent shell: left sidebar on desktop, top drawer on mobile.
 * `lg-env` lives on the layout wrapper; this component renders inside it
 * and is purely structural — every visible surface is a `.glass-panel`.
 */

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard, match: "exact" as const },
  { href: "/dashboard/calls", label: "Calls", icon: PhoneCall, match: "prefix" as const },
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
        <div className="flex items-center gap-2">
          <span className="iridescent-text font-semibold tracking-tight text-base">Voxaris Pitch</span>
        </div>
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
      <aside className="hidden lg:flex lg:w-64 xl:w-72 shrink-0 flex-col gap-4 px-5 py-6 border-r border-white/[0.06] sticky top-0 h-screen">
        <SidebarContent pathname={pathname} />
      </aside>

      {/* Drawer — mobile */}
      {drawerOpen && (
        <div className="lg:hidden border-b border-white/[0.06] px-4 py-4 bg-[rgba(8,11,17,0.86)] backdrop-blur-xl">
          <SidebarContent pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
        </div>
      )}

      {/* Main */}
      <main className="flex-1 min-w-0">
        {/* Desktop top bar */}
        <div className="hidden lg:flex items-center justify-between px-8 py-5 border-b border-white/[0.06]">
          <div className="flex items-baseline gap-3">
            <span className="text-white/80 font-semibold tracking-tight">Voxaris</span>
            <span className="text-white/40 text-xs font-mono tabular">voxaris office</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-xs text-white/55 font-mono tabular">staff@voxaris.io</div>
            <form action="/auth/signout" method="POST">
              <button
                type="submit"
                className="text-[11px] font-mono uppercase tracking-[0.14em] text-white/50 hover:text-white/80 transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
        <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1400px] mx-auto">
          {children}
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
      <Link href="/dashboard" onClick={onNavigate} className="hidden lg:flex items-center gap-2">
        <span className="iridescent-text font-semibold tracking-tight text-lg">Voxaris Pitch</span>
      </Link>
      <div className="hidden lg:block glass-divider mt-1 mb-2" />
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
                "flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-colors",
                active
                  ? "bg-white/[0.08] text-white border border-white/[0.10]"
                  : "text-white/65 hover:text-white hover:bg-white/[0.04] border border-transparent",
              ].join(" ")}
            >
              <Icon className={["w-4 h-4", active ? "text-cy-300" : "text-white/55"].join(" ")} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="hidden lg:block mt-auto pt-4">
        <div className="glass-eyebrow !text-[10px]">Phase 3 · Dashboard</div>
      </div>
    </>
  );
}

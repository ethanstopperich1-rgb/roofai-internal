import type { Metadata } from "next";
import { Geist, Geist_Mono, Bricolage_Grotesque } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
  axes: ["opsz", "wdth"],
});

export const metadata: Metadata = {
  title: "RoofAI Internal · Estimator",
  description: "Internal roofing estimator for sales reps and office staff.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${geist.variable} ${geistMono.variable} ${bricolage.variable}`}
    >
      <body className="min-h-screen antialiased">
        <Header />
        <main className="max-w-[1280px] mx-auto px-6 lg:px-10 py-8">{children}</main>
      </body>
    </html>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#07090d]/70 backdrop-blur-xl">
      <div className="max-w-[1280px] mx-auto px-6 lg:px-10 h-14 flex items-center justify-between">
        <Link href="/" className="group flex items-center gap-3">
          <div className="relative w-7 h-7 rounded-[7px] bg-gradient-to-br from-cy-300 to-cy-600 flex items-center justify-center font-display font-bold text-[#051019] text-sm shadow-[0_4px_12px_-4px_rgba(56,197,238,0.6),inset_0_1px_0_rgba(255,255,255,0.4)]">
            R
            <span className="absolute -inset-px rounded-[7px] ring-1 ring-white/20" />
          </div>
          <div className="leading-none">
            <div className="text-[15px] font-display font-semibold tracking-tight">
              roofai<span className="text-cy-300">.</span>
            </div>
            <div className="text-[10px] mt-0.5 font-mono uppercase tracking-[0.18em] text-slate-500">
              Internal · v0.1
            </div>
          </div>
        </Link>

        <nav className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.025] border border-white/[0.05] text-[13px]">
          <NavLink href="/">Estimator</NavLink>
          <NavLink href="/history">History</NavLink>
          <NavLink href="/admin">Admin</NavLink>
        </nav>

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

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/[0.06] transition"
    >
      {children}
    </Link>
  );
}

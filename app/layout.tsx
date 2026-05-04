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
  title: "Voxaris Pitch · Roofing Estimator",
  description: "Estimate to deal in five minutes. The closing tool for roofing teams.",
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
        <Link href="/" className="group flex items-center gap-2.5" aria-label="Voxaris Pitch">
          {/* Mobile: icon only */}
          <img
            src="/brand/logo-mark.png"
            alt=""
            width={28}
            height={28}
            className="w-7 h-7 sm:hidden"
          />
          {/* Desktop: full wordmark (transparent so it sits on the dark header) */}
          <img
            src="/brand/logo-wordmark-alpha.png"
            alt="Voxaris Pitch"
            width={1672}
            height={941}
            className="hidden sm:block h-7 w-auto"
          />
          <span className="hidden sm:inline-block ml-1 chip text-[10px]">beta</span>
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

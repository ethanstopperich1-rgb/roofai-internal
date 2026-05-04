import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

export const metadata: Metadata = {
  title: "RoofAI Internal",
  description: "Internal roofing estimator tool",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen">
        <header className="sticky top-0 z-40 glass-strong">
          <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sky-400 to-cyan-500 flex items-center justify-center font-black text-slate-900">R</div>
              <div>
                <div className="font-bold tracking-tight">RoofAI <span className="text-sky-400">Internal</span></div>
                <div className="text-[10px] text-slate-400 -mt-0.5">Staff Estimator v0.1</div>
              </div>
            </Link>
            <nav className="flex items-center gap-1 text-sm">
              <Link href="/" className="btn btn-ghost py-1.5 px-3">Estimator</Link>
              <Link href="/history" className="btn btn-ghost py-1.5 px-3">History</Link>
              <Link href="/admin" className="btn btn-ghost py-1.5 px-3">Admin</Link>
            </nav>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-6 py-6">{children}</main>
      </body>
    </html>
  );
}

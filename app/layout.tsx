import type { Metadata } from "next";
import { Geist, Geist_Mono, Bricolage_Grotesque } from "next/font/google";
import "./globals.css";
import { GradientBackground } from "@/components/ui/gradient-background-4";
import InternalHeader from "@/components/InternalHeader";

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
      <body className="min-h-screen antialiased relative">
        <GradientBackground />
        {/* Header self-hides on /quote and /p/[id] (customer-facing routes
            render their own dedicated chrome). */}
        <InternalHeader />
        {children}
      </body>
    </html>
  );
}

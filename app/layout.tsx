import type { Metadata } from "next";
import {
  Geist,
  Geist_Mono,
  Bricolage_Grotesque,
  Space_Grotesk,
  Space_Mono,
} from "next/font/google";
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
// Nothing-aesthetic typography. Space Grotesk / Mono come from Colophon
// Foundry — same design DNA as Nothing's actual typefaces.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
  weight: ["300", "400", "500", "700"],
});
const spaceMono = Space_Mono({
  subsets: ["latin"],
  variable: "--font-space-mono",
  display: "swap",
  weight: ["400", "700"],
});

// metadataBase resolves relative URLs in OG / Twitter card images against a
// real origin so shared links (Slack, iMessage, X) load the social card from
// production instead of the build-host's localhost fallback. Falls through
// to Vercel's auto-injected origins for preview deploys, then to the
// production domain as a last resort.
const metadataBase = process.env.NEXT_PUBLIC_SITE_ORIGIN
  ? new URL(process.env.NEXT_PUBLIC_SITE_ORIGIN)
  : process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)
    : process.env.VERCEL_URL
      ? new URL(`https://${process.env.VERCEL_URL}`)
      : new URL("https://pitch.voxaris.io");

export const metadata: Metadata = {
  metadataBase,
  title: "Voxaris Pitch · Roofing Estimator",
  description: "Estimate to deal in five minutes. The closing tool for roofing teams.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${geist.variable} ${geistMono.variable} ${bricolage.variable} ${spaceGrotesk.variable} ${spaceMono.variable}`}
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

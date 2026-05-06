import type { Metadata } from "next";
import { BRAND_CONFIG } from "@/lib/branding";

/**
 * Per-route metadata for the public lead funnel. The page itself is
 * "use client" (the wizard needs interactive state), so we lift metadata
 * into a layout file — Next.js merges it on top of app/layout.tsx's
 * defaults. Drives the title shown in browser tabs / Google search
 * results, and the OG card embedded when the URL is shared on Slack,
 * iMessage, X, etc.
 */
const TITLE = `Free Roof Estimate in 30 Seconds · ${BRAND_CONFIG.companyName}`;
const DESCRIPTION =
  "AI-powered roof estimate from your address — no calls, no in-home visits, no obligation. Connect with a local licensed roofer when you're ready.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/quote" },
  openGraph: {
    type: "website",
    title: TITLE,
    description: DESCRIPTION,
    url: "/quote",
    siteName: BRAND_CONFIG.companyName,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function QuoteLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * /embed/install is documentation aimed at roofers' webmasters — it
 * describes how to drop the Voxaris Pitch embed snippet onto a third-
 * party site. It's NOT a homeowner-facing page and should never
 * surface in Google for queries like "voxaris roofing estimator" or
 * generic terms — search engines indexing it would route real
 * homeowners to install docs that make no sense to them.
 *
 * Marking noindex,nofollow via metadata. (X-Robots-Tag is also set
 * by middleware.ts for /p/[id]; here we use the metadata-driven robots
 * field which Next.js renders as a `<meta name="robots">` tag —
 * sufficient for this surface because no PII is at stake, just
 * search-discoverability.)
 *
 * The layout exists purely to host this metadata because the page
 * itself is a client component (`"use client"`) and client components
 * can't export metadata.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: "Install the Voxaris Pitch Embed",
  description: "Drop a roof estimator on any website in two lines — install instructions for contractor webmasters.",
};

export default function EmbedInstallLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

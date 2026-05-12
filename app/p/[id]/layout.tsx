import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

/**
 * Per-proposal layout.
 *
 * Critical purpose: tell search engines + AI crawlers NOT to index this
 * page. /p/<id> renders a specific customer's PII (name, address,
 * phone-anchored estimate). Even though the public_id is now a UUIDv4
 * (unguessable), having Google index any of them leaks PII into the
 * public web indefinitely. The robots metadata blocks indexing AND
 * link-following; the X-Robots-Tag fallback handles non-Google
 * crawlers that ignore meta tags.
 */
export const metadata: Metadata = {
  title: "Your roof estimate",
  description: "Your personalized roofing estimate.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      "max-snippet": -1,
      "max-image-preview": "none",
      "max-video-preview": -1,
    },
  },
};

export const viewport: Viewport = {
  themeColor: "#07090d",
};

export default function ProposalLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

"use client";

import { usePathname } from "next/navigation";

/**
 * Gradient Background — radial spotlight from the top.
 * Drop inside a `relative` container; renders as an absolute backdrop.
 *
 * Source: 21st.dev/bg.ibelick (gradient-background-4)
 *
 * Self-hides on `/embed` because the widget is iframed onto third-party
 * sites where any backdrop would visually leak past the form box.
 */
export const GradientBackground = () => {
  const pathname = usePathname() ?? "/";
  if (pathname.startsWith("/embed")) return null;

  return (
    <div
      aria-hidden
      className="absolute inset-0 h-full w-full bg-background [background:radial-gradient(125%_125%_at_50%_-50%,#c7d2fe_40%,transparent_100%)] dark:[background:radial-gradient(125%_125%_at_50%_-50%,#6366f136_40%,transparent_100%)]"
    />
  );
};

export default GradientBackground;

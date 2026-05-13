"use client";

import { usePathname } from "next/navigation";

/**
 * Gradient Background — radial spotlight from the top.
 * Drop inside a `relative` container; renders as an absolute backdrop.
 *
 * Source: 21st.dev/bg.ibelick (gradient-background-4)
 *
 * Self-hides on routes that paint their own atmosphere:
 *   - /embed: iframed onto third-party sites; any backdrop leaks past
 *     the form box.
 *   - /quote, /p/*: customer-facing routes that wrap content in
 *     `.lg-env` (the visionOS Liquid Glass environment in globals.css),
 *     which paints its own #060812 base + radial gradients + aurora blob.
 *     Layering this indigo halo behind that stacks four opaque bases
 *     (body, this, ray-background in the hero, lg-env) where only one
 *     ever shows through; the others are dead pixels.
 */
export const GradientBackground = () => {
  const pathname = usePathname() ?? "/";
  if (
    pathname.startsWith("/embed") ||
    pathname.startsWith("/quote") ||
    pathname.startsWith("/p/")
  ) {
    return null;
  }

  return (
    <div
      aria-hidden
      className="absolute inset-0 h-full w-full bg-background [background:radial-gradient(125%_125%_at_50%_-50%,#c7d2fe_40%,transparent_100%)] dark:[background:radial-gradient(125%_125%_at_50%_-50%,#6366f136_40%,transparent_100%)]"
    />
  );
};

export default GradientBackground;

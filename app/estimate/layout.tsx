/**
 * Layout for the public /estimate route.
 *
 * Mirrors app/(internal)/layout.tsx exactly — same max-width
 * container, same padding, same min-h-100dvh. /estimate is a public
 * mirror of `/`, and without this wrapper the page rendered
 * edge-to-edge on wide monitors because the route lives outside the
 * (internal) route group and doesn't inherit that layout.
 *
 * Kept as a sibling file rather than re-exporting `(internal)/layout`
 * because Next route groups can't be referenced across the parentheses
 * boundary — duplication is the cleanest path until we promote the
 * container to a shared component.
 */
export default function EstimateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="relative z-[1] lg-env min-h-[100dvh]">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 py-6 sm:py-8">
        {children}
      </div>
    </main>
  );
}

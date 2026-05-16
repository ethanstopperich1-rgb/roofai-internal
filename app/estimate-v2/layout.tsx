/**
 * Layout for the /estimate-v2 route — the V3 "holy-grail" pin-confirmed
 * Gemini-painted flow. Mirrors /estimate's container so the page sits
 * on the same shared layout without inheriting the heavy legacy UI.
 */
export default function EstimateV2Layout({
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

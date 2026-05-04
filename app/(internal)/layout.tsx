/**
 * Layout for internal staff routes (/, /history, /admin).
 * Wraps every internal page in the centered max-width container.
 * Customer-facing routes (/quote, /p/[id]) live OUTSIDE this group and
 * manage their own chrome — see app/quote/page.tsx, app/p/[id]/page.tsx.
 */
export default function InternalLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative z-[1] max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-10 py-6 sm:py-8">
      {children}
    </main>
  );
}

import type { ReactNode } from "react";
import DashboardChrome from "@/components/dashboard/DashboardChrome";
import DemoBanner from "@/components/dashboard/DemoBanner";
import {
  getActiveDemoOffice,
  getDashboardRole,
  getDashboardUser,
  isOnDemoRoute,
} from "@/lib/dashboard";
import { DEMO_OFFICES } from "@/lib/dashboard-demo";

/**
 * Dashboard chassis. The visible URL lives under /dashboard/* — the spec
 * originally said `app/(dashboard)/*` (a parens route group, no segment),
 * but `/` is already owned by the rep tool at `app/(internal)/page.tsx`,
 * so Next.js would error on the duplicate root page. Moving the dashboard
 * under `/dashboard` is the only way to share the tree without colliding.
 *
 * Auth: gated by `middleware.ts` HTTP Basic in production. RLS-aware
 * per-office scoping will land with the Supabase Auth follow-up — for now
 * every page resolves `office_id` for the seeded `voxaris` slug via a
 * service-role client. Search for "swap to current_office_id()" to find
 * the swap sites when auth lands.
 *
 * Office switcher: the active office for the demo path is resolved
 * here (server-side) and passed into the chrome so the chip never
 * flickers between SSR and hydration.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [activeOffice, role, user, isDemo] = await Promise.all([
    getActiveDemoOffice(),
    getDashboardRole(),
    getDashboardUser(),
    isOnDemoRoute(),
  ]);
  return (
    <div className="theme-terminal min-h-screen text-white">
      {isDemo && <DemoBanner activeRole={role} />}
      <DashboardChrome
        offices={DEMO_OFFICES}
        activeOffice={activeOffice}
        role={role}
        userEmail={user?.email ?? null}
        userFullName={user?.full_name ?? null}
      >
        {children}
      </DashboardChrome>
    </div>
  );
}

/**
 * Server-side helpers shared across the /dashboard/* tree.
 *
 * This file is SERVER ONLY — it imports `next/headers`. Client components
 * that need the formatters / style helpers should import from
 * `lib/dashboard-format.ts` instead. We also re-export those formatters
 * here so existing server-side callers don't need to change imports.
 *
 * Office scoping — two paths:
 *
 *   1. **Authenticated user (Supabase session cookie present)** — we
 *      build a cookie-aware server client. RLS pins every query to the
 *      user's office via the JWT + the policies in rls_policies.sql.
 *      Multi-tenant by row.
 *
 *   2. **HTTP Basic fallback (no session cookie)** — we use the
 *      service-role client AND hardcode office_id = the `voxaris`
 *      seed. RLS is bypassed; callers must filter by office_id on
 *      every query. This path exists for the transition period while
 *      reps move from Basic Auth to magic-link login.
 *
 * Pages don't need to know which path applies — `getDashboardSupabase()`
 * and `getDashboardOfficeId()` return the right client + id and the
 * page code is identical.
 */

import "server-only";
import { cookies, headers } from "next/headers";
import {
  createServerClient,
  createServiceRoleClient,
  resolveOfficeIdBySlug,
  supabaseConfigured,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import {
  DEFAULT_OFFICE_SLUG,
  DEMO_OFFICES,
  isDemoOfficeSlug,
  type DemoOfficeSlug,
} from "@/lib/dashboard-demo";
import type { Database } from "@/types/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Name of the cookie used by /api/office/switch to pin the active
 *  demo office. Read by every dashboard page so the switcher in the
 *  chrome propagates everywhere. */
export const OFFICE_COOKIE = "voxaris_demo_office";

/** True when middleware rewrote /demo/* to /dashboard/*. Forces every
 *  dashboard page onto the demo-data fallback even if SUPABASE_*
 *  env vars are set — so the public /demo URL never leaks real
 *  customer rows. */
async function isDemoRoute(): Promise<boolean> {
  try {
    const h = await headers();
    return h.get("x-voxaris-demo") === "1";
  } catch {
    return false;
  }
}

/** Public wrapper so layouts/Server Components can branch on the demo
 *  surface (e.g. render the demo-mode banner). */
export async function isOnDemoRoute(): Promise<boolean> {
  return isDemoRoute();
}

// Re-export the client-safe formatters + types so existing call sites
// in app/dashboard/* keep working without changing imports.
export {
  fmtUSD,
  fmtDuration,
  fmtDateTime,
  fmtDate,
  outcomeStyle,
  statusStyle,
  LEAD_STATUSES,
  daysAgoISO,
  monthStartISO,
  clamp,
  type Lead,
  type Call,
  type Event,
  type Proposal,
  type Office,
  type LeadStatus,
} from "@/lib/dashboard-format";

/** Union type so callers don't need to know whether they got a server
 *  client or a service-role client — both share the same query surface. */
export type SupabaseService = SupabaseClient<Database>;

/** Fallback office slug for the HTTP-Basic transition path. Once every
 *  rep has migrated to magic-link login, this constant goes away. */
export const FALLBACK_OFFICE_SLUG = "voxaris";

/** Legacy alias kept for existing call sites. */
export const DASHBOARD_OFFICE_SLUG = FALLBACK_OFFICE_SLUG;

async function buildCookieAdapter() {
  const cookieStore = await cookies();
  return {
    getAll: () =>
      cookieStore.getAll().map((c) => ({ name: c.name, value: c.value })),
    setAll: () => {
      // Server Components can't set cookies. Middleware does. Safe to swallow.
    },
  };
}

/** True when a Supabase session cookie is present on the request. */
async function hasSession(): Promise<boolean> {
  if (!supabaseConfigured()) return false;
  const cookieStore = await cookies();
  return cookieStore.getAll().some(
    (c) => c.name.startsWith("sb-") && c.name.endsWith("-auth-token"),
  );
}

/** Canonical role union. Order is intentional: 'rep' < 'staff' < 'manager'
 *  < 'admin' / 'owner'. 'staff' is the legacy default and is treated as
 *  a full-office viewer for backward compatibility — same surface as
 *  'manager'. 'admin' and 'owner' are equivalent (multi-office). */
export type DashboardRole = "rep" | "staff" | "manager" | "admin" | "owner";

export interface DashboardUser {
  id: string;
  email: string;
  full_name: string | null;
  office_id: string;
  role: DashboardRole;
}

const ROLE_VALUES: DashboardRole[] = ["rep", "staff", "manager", "admin", "owner"];
// Legacy alias map — historical DBs had a `viewer` role from the pre-0007
// check constraint. It behaves identically to "staff" in the app, but the
// raw value remains valid in the DB to keep the migration non-destructive.
const ROLE_ALIASES: Record<string, DashboardRole> = {
  viewer: "staff",
};
function normalizeRole(raw: string | null | undefined): DashboardRole {
  if (!raw) return "staff";
  if ((ROLE_VALUES as string[]).includes(raw)) return raw as DashboardRole;
  const aliased = ROLE_ALIASES[raw];
  if (aliased) return aliased;
  return "staff";
}

/** Resolve the current authenticated user. Returns null when there's no
 *  Supabase session (HTTP-Basic / unauth surfaces). The dashboard demo
 *  route returns null too — demo doesn't represent a real user. */
export async function getDashboardUser(): Promise<DashboardUser | null> {
  if (await isDemoRoute()) return null;
  if (!supabaseConfigured()) return null;
  if (!(await hasSession())) return null;
  try {
    const supabase = createServerClient(await buildCookieAdapter());
    const { data: userRow } = await supabase
      .from("users")
      .select("id, email, full_name, office_id, role")
      .single();
    if (!userRow) return null;
    return {
      id: userRow.id,
      email: userRow.email,
      full_name: userRow.full_name,
      office_id: userRow.office_id,
      role: normalizeRole(userRow.role),
    };
  } catch (err) {
    console.warn("[dashboard] getDashboardUser failed:", err);
    return null;
  }
}

/** True when the active route should render a rep-scoped view (their
 *  assigned leads only, no cross-office data). For the public /demo
 *  surface we also respect a cookie that lets us preview the rep
 *  experience without a real account — set `voxaris_demo_role=rep` to
 *  toggle. */
export async function getDashboardRole(): Promise<DashboardRole> {
  if (await isDemoRoute()) {
    const cookieStore = await cookies();
    const raw = cookieStore.get("voxaris_demo_role")?.value;
    return normalizeRole(raw);
  }
  const user = await getDashboardUser();
  return user?.role ?? "staff";
}

export function isAdminRole(role: DashboardRole): boolean {
  return role === "admin" || role === "owner";
}
export function isManagerRole(role: DashboardRole): boolean {
  return role === "manager" || isAdminRole(role);
}
export function isRepRole(role: DashboardRole): boolean {
  return role === "rep";
}

/** Resolve the office_id the dashboard should query.
 *
 *  When a Supabase session exists, we read it from public.users for
 *  the JWT user. When no session, fall back to the seed Voxaris office.
 *  Returns null when Supabase isn't configured at all. */
export async function getDashboardOfficeId(): Promise<string | null> {
  if (await isDemoRoute()) return null;
  if (!supabaseConfigured()) return null;
  if (await hasSession()) {
    try {
      const supabase = createServerClient(await buildCookieAdapter());
      const { data: userRow } = await supabase
        .from("users")
        .select("office_id")
        .single();
      if (userRow?.office_id) return userRow.office_id;
    } catch (err) {
      console.warn("[dashboard] auth-aware office_id lookup failed:", err);
    }
  }
  if (!supabaseServiceRoleConfigured()) return null;
  return resolveOfficeIdBySlug(FALLBACK_OFFICE_SLUG);
}

/** Resolve the slug of the office the dashboard should render for. Used
 *  by the demo-data fallback so the switcher in the chrome propagates
 *  to every page. Reads the `voxaris_demo_office` cookie set by
 *  /api/office/switch; falls back to Noland's when missing/invalid. */
export async function getDashboardOfficeSlug(): Promise<DemoOfficeSlug> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(OFFICE_COOKIE)?.value;
  return isDemoOfficeSlug(raw) ? raw : DEFAULT_OFFICE_SLUG;
}

/** Convenience: return the active demo office record. */
export async function getActiveDemoOffice() {
  const slug = await getDashboardOfficeSlug();
  return DEMO_OFFICES.find((o) => o.slug === slug) ?? DEMO_OFFICES[0];
}

/** Return the right Supabase client for the request. */
export async function getDashboardSupabase(): Promise<SupabaseService | null> {
  if (await isDemoRoute()) return null;
  if (!supabaseConfigured()) return null;
  if (await hasSession()) {
    try {
      return createServerClient(await buildCookieAdapter());
    } catch (err) {
      console.warn("[dashboard] server client init failed:", err);
    }
  }
  if (!supabaseServiceRoleConfigured()) return null;
  return createServiceRoleClient();
}

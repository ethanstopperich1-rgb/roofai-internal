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
import { cookies } from "next/headers";
import {
  createServerClient,
  createServiceRoleClient,
  resolveOfficeIdBySlug,
  supabaseConfigured,
  supabaseServiceRoleConfigured,
} from "@/lib/supabase";
import type { Database } from "@/types/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

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

/** Resolve the office_id the dashboard should query.
 *
 *  When a Supabase session exists, we read it from public.users for
 *  the JWT user. When no session, fall back to the seed Voxaris office.
 *  Returns null when Supabase isn't configured at all. */
export async function getDashboardOfficeId(): Promise<string | null> {
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

/** Return the right Supabase client for the request. */
export async function getDashboardSupabase(): Promise<SupabaseService | null> {
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

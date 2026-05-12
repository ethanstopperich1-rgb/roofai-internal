/**
 * Supabase clients — three variants for the three contexts we use them in.
 *
 *   1. createBrowserClient() — runs in the browser. Uses the publishable
 *      anon key. RLS-respected: every query is scoped to the calling
 *      user's office_id by the policies in migrations/rls_policies.sql.
 *      Auth state lives in cookies / localStorage.
 *
 *   2. createServerClient() — runs in Server Components, server actions,
 *      and authenticated /api routes. Uses the publishable anon key BUT
 *      with cookie-passing so RLS sees the user's JWT. Same per-office
 *      isolation as the browser client.
 *
 *   3. createServiceRoleClient() — runs in PUBLIC /api routes that have
 *      no authenticated user (the customer form on /quote, Twilio
 *      webhook on /api/sms/inbound, Sydney event sink on /api/agent/
 *      events). Uses the SERVICE_ROLE key to bypass RLS. NEVER expose
 *      this client to the browser. Always tag office_id explicitly on
 *      writes — without RLS as a guard, a bug that omits office_id is a
 *      cross-tenant leak.
 *
 * Env vars:
 *   NEXT_PUBLIC_SUPABASE_URL        — project URL, safe to expose
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY   — publishable key, safe to expose
 *   SUPABASE_SERVICE_ROLE_KEY       — server only, bypasses RLS
 *
 * Missing env vars: the factories throw on first use. Routes that can
 * tolerate a missing config (e.g. /api/leads with no Supabase wired up)
 * use the `supabaseConfigured()` guard to no-op gracefully.
 */

import { createBrowserClient as _createBrowserClient, createServerClient as _createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** True when the env vars needed for ANY Supabase client are set.
 *  Callers in optional paths (e.g. /api/leads writing to Supabase as a
 *  side-effect of capturing a lead) use this guard to no-op when the
 *  database isn't configured, preserving the existing webhook-only flow
 *  during phased rollout. */
export function supabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/** True when the SERVICE ROLE key is configured — required for public
 *  /api routes that need to write to Supabase without an authenticated
 *  user (e.g. /api/leads). */
export function supabaseServiceRoleConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

/** Browser client — use in client components.
 *  Reads / writes are RLS-scoped to the logged-in user's office. */
export function createBrowserClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "Supabase env not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  }
  return _createBrowserClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/** Server client (cookie-aware) — use in Server Components, server
 *  actions, and authenticated API routes. The `cookies` argument is the
 *  `next/headers` cookies() function or a compatible adapter.
 *
 *  Pattern from `@supabase/ssr` docs: each request gets a fresh client
 *  that reads / writes cookies via the framework's cookie adapter, so
 *  the JWT round-trips on every request.
 */
export function createServerClient(cookieAdapter: {
  getAll: () => Array<{ name: string; value: string }>;
  setAll: (cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => void;
}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      "Supabase env not configured — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY",
    );
  }
  return _createServerClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieAdapter.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookieAdapter.setAll(
            cookiesToSet.map((c) => ({ name: c.name, value: c.value, options: c.options })),
          );
        } catch {
          // Server Components can't set cookies. Middleware does. Swallow.
        }
      },
    },
  });
}

/** Service-role client — bypasses RLS. Use ONLY in server-side code that
 *  has no authenticated user (public form posts, webhooks, agent event
 *  sinks). The caller is responsible for tagging office_id on every write
 *  — without RLS as a guard, omitting office_id leaks rows across tenants. */
export function createServiceRoleClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Supabase service role not configured — set SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/** Resolve an office by slug. Used by public /api routes (e.g.
 *  /api/leads with ?office=voxaris) to tag the right office_id. Cached
 *  via the in-memory Map below — offices change rarely and the lookup
 *  fires on every public form submit. */
const OFFICE_CACHE = new Map<string, { id: string; fetchedAt: number }>();
const OFFICE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function resolveOfficeIdBySlug(slug: string): Promise<string | null> {
  const cached = OFFICE_CACHE.get(slug);
  if (cached && Date.now() - cached.fetchedAt < OFFICE_TTL_MS) {
    return cached.id;
  }
  if (!supabaseServiceRoleConfigured()) return null;
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("offices")
    .select("id")
    .eq("slug", slug)
    .eq("is_active", true)
    .single();
  if (error || !data) {
    console.warn(`[supabase] office lookup failed for slug='${slug}':`, error?.message);
    return null;
  }
  OFFICE_CACHE.set(slug, { id: data.id, fetchedAt: Date.now() });
  return data.id;
}

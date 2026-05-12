/**
 * POST /auth/signout — clear Supabase session and redirect to /login.
 *
 * Implemented as a POST route (not GET) so it can't be triggered by a
 * malicious image / link injection. The dashboard chrome's "Sign out"
 * button submits a form to this URL.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const response = NextResponse.redirect(new URL("/login", url));
  const cookieStore = await cookies();

  try {
    const supabase = createServerClient({
      getAll: () => cookieStore.getAll().map((c) => ({ name: c.name, value: c.value })),
      setAll: (cookiesToSet) => {
        for (const c of cookiesToSet) {
          response.cookies.set({
            name: c.name,
            value: c.value,
            ...((c.options ?? {}) as Record<string, unknown>),
          });
        }
      },
    });
    await supabase.auth.signOut();
  } catch (err) {
    console.warn("[auth/signout] failed:", err);
    // Always redirect to /login even on failure — the session is
    // probably gone anyway (cookie expired, env unset, etc).
  }

  return response;
}

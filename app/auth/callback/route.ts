/**
 * GET /auth/callback?code=... — magic-link redirect target.
 *
 * Supabase emails the user a link like:
 *   https://pitch.voxaris.io/auth/callback?code=<auth_code>
 *
 * We exchange that code for a session (which is set as an HTTP-only
 * cookie on the response) and then redirect the user to the dashboard.
 *
 * On error: redirect back to /login with the error message in the
 * query string so the user knows what went wrong.
 *
 * Notes:
 *   - The cookie adapter we pass into createServerClient is the
 *     standard Next.js 16 cookies() API. The Supabase SSR helper sets
 *     cookies on the OUTGOING response via the `setAll` callback.
 *   - We use NextResponse.redirect() to make the redirect happen, and
 *     return it directly so the cookies the helper set during the
 *     exchange travel back with the redirect.
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/dashboard";

  if (!code) {
    return NextResponse.redirect(new URL("/login?error=missing_code", url));
  }

  // Build a response we can mutate cookies onto. createServerClient's
  // setAll callback writes onto `response.cookies` so the session
  // cookie travels with the redirect.
  const response = NextResponse.redirect(new URL(next, url));
  const cookieStore = await cookies();

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

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.warn("[auth/callback] exchange failed:", error.message);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, url),
    );
  }

  return response;
}

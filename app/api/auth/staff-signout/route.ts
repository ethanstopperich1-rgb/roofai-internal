import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/auth/staff-signout
 *
 * Clears the `voxaris-staff` cookie. Server-side handler so the cookie
 * (HttpOnly, not readable from JS) can actually be deleted by the
 * browser. The client redirects to /login afterwards.
 */
export async function POST(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set("voxaris-staff", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

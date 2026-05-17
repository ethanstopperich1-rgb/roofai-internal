import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/auth/staff-login
 *
 * Validates {username, password} against STAFF_AUTH_USER / STAFF_AUTH_PASS
 * (set in Vercel project env) and, on success, issues a `voxaris-staff`
 * HttpOnly cookie. The cookie value is the same base64(user:pass) that
 * an HTTP Basic header would carry — the middleware decodes it the same
 * way regardless of which transport (Authorization header or cookie)
 * delivered it. Shared-staff-password model: there are no individual
 * accounts, so no JWT / session table / refresh logic is needed.
 *
 * Fail-closed in production when env vars are missing — mirrors the
 * middleware's posture so a misconfigured deploy can never accept any
 * password.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: { username?: string; password?: string };
  try {
    body = (await req.json()) as { username?: string; password?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const user = process.env.STAFF_AUTH_USER;
  const pass = process.env.STAFF_AUTH_PASS;
  if (!user || !pass) {
    // In dev let any non-empty username through so localhost iteration
    // doesn't require setting the env vars; in prod fail closed.
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "Service unavailable: staff authentication is not configured." },
        { status: 503 },
      );
    }
    if (body.username?.trim()) {
      return setStaffCookie(
        NextResponse.json({ ok: true, dev: true }),
        body.username.trim(),
        body.password ?? "",
      );
    }
    return NextResponse.json({ error: "Username is required" }, { status: 400 });
  }

  const reqUser = (body.username ?? "").trim();
  const reqPass = body.password ?? "";

  // Constant-time compare (XOR-and-OR over equal-length strings)
  const ok =
    reqUser.length === user.length &&
    reqPass.length === pass.length &&
    constantTimeEq(reqUser, user) &&
    constantTimeEq(reqPass, pass);
  if (!ok) {
    return NextResponse.json(
      { error: "Incorrect username or password." },
      { status: 401 },
    );
  }

  return setStaffCookie(NextResponse.json({ ok: true }), reqUser, reqPass);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function setStaffCookie(
  res: NextResponse,
  user: string,
  pass: string,
): NextResponse {
  // base64(user:pass) — identical encoding to the Authorization: Basic
  // header so the middleware uses one decode path for both.
  const value = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  // 30 days. Same cookie life as a typical "remember me" — staff sign
  // in on their laptop and don't think about it again. HttpOnly +
  // SameSite=Lax prevents XSS theft and cross-site mounting; Secure
  // means it never leaks over plain HTTP in prod.
  res.cookies.set("voxaris-staff", value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

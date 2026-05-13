import { NextResponse, type NextRequest } from "next/server";
import { isDemoOfficeSlug } from "@/lib/dashboard-demo";
import { OFFICE_COOKIE } from "@/lib/dashboard";

/**
 * Sets the active demo-office cookie so the dashboard chrome switcher
 * persists across pages. Accepts both POST (JSON body) and GET (query
 * param) so the switcher can use either form factor.
 *
 * Cookie is scoped to /dashboard so it can't leak into customer-facing
 * surfaces, and lives 30 days — long enough for a sales cycle without
 * needing reset logic.
 */

const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

function setCookie(res: NextResponse, slug: string) {
  res.cookies.set({
    name: OFFICE_COOKIE,
    value: slug,
    path: "/",
    maxAge: COOKIE_MAX_AGE_SEC,
    httpOnly: false,
    sameSite: "lax",
  });
}

export async function POST(req: NextRequest) {
  let slug: unknown;
  try {
    const body = await req.json();
    slug = body?.slug;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  if (typeof slug !== "string" || !isDemoOfficeSlug(slug)) {
    return NextResponse.json({ ok: false, error: "invalid_slug" }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true, slug });
  setCookie(res, slug);
  return res;
}

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug || !isDemoOfficeSlug(slug)) {
    return NextResponse.json({ ok: false, error: "invalid_slug" }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true, slug });
  setCookie(res, slug);
  return res;
}

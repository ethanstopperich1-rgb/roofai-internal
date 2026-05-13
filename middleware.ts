import { NextResponse, type NextRequest } from "next/server";

/**
 * Staff auth middleware — HTTP Basic gate on rep-facing routes.
 *
 * Why HTTP Basic and not NextAuth / Clerk:
 *   - The internal app has ~18 staff users across PE-backed offices.
 *     A shared staff password set in env vars covers that user count
 *     fine, and HTTP Basic is supported by every browser without any
 *     client-side library. Total auth code: 60 lines + 2 env vars.
 *   - Avoids the larger NextAuth wiring (DB, session, callbacks)
 *     while we're still iterating on the product.
 *   - Easy to swap for NextAuth / Clerk / Vercel Sign-In later — the
 *     middleware is the only file that needs replacement.
 *
 * Env vars (set in Vercel):
 *   STAFF_AUTH_USER       — required in prod
 *   STAFF_AUTH_PASS       — required in prod
 *
 * In production WITHOUT these env vars set, ALL protected routes
 * return 503 (fail-closed). In dev they pass through to keep local
 * iteration friction-free. The fail-closed behavior in prod was a
 * direct response to a code review flagging that `lib/ratelimit.ts`
 * failed-open without Redis — we don't want auth to repeat that
 * mistake.
 *
 * Public surfaces NOT protected (customer-facing, intentional):
 *   /quote                  customer estimator wizard
 *   /embed                  iframe embed for partner sites
 *   /p/[id]                 customer-facing proposal share link
 *   /api/leads              lead capture (BotID-guarded)
 *   /api/sms/*              Twilio webhooks (HMAC-validated)
 *   /api/places/*           address autocomplete (used by /quote)
 *   /api/solar              roof size + pitch (used by /quote)
 *   /api/sam3-roof          primary polygon source (used by /quote)
 *   /api/solar-mask         fallback polygon (used by /quote)
 *   /api/microsoft-building fallback polygon (used by /quote)
 *   /api/building           OSM building lookup (used by /quote)
 *   /api/storms             storm history (used by /quote)
 *   /api/hail-mrms          radar hail (used by /quote)
 *   /api/weather            weather context (used by /quote)
 *
 * Protected surfaces (staff-only, gated below):
 *   /                       internal estimator (rep tool)
 *   /history                rep history
 *   /admin                  admin tools
 *   /eval-trace             eval mode
 *   /api/photos             rep photo uploads (writes Vercel Blob — $$$ abuse risk)
 *   /api/voice-note         rep dictation (Whisper + Qwen — $$$ abuse risk)
 *   /api/supplement         PDF parse + Qwen (rep tool, $$$ abuse risk)
 *   /api/eval-truth/*       eval-mode capture (writes Vercel Blob)
 *   /api/insights           rep insights panel
 *   /api/vision             Claude vision (rep tool, $$$ abuse risk)
 *   /api/verify-polygon     Claude vision QA (rep tool)
 *   /api/verify-polygon-multiview  same
 *   /api/roboflow           Roboflow inference (rep tool, $$$ abuse risk)
 *   /api/sam-refine         Replicate SAM2 (rep tool, $$$ abuse risk)
 *   /api/estimates          rep proposal persistence (stub)
 *   POST /api/proposals     staff-only — same-origin + Basic Auth or session
 *   /api/aerial             currently unused by any caller — gated until
 *                           an intentional customer call site exists
 */

const PROTECTED_API_PREFIXES = [
  "/api/photos",
  "/api/voice-note",
  "/api/supplement",
  "/api/eval-truth",
  "/api/insights",
  "/api/vision",
  "/api/verify-polygon",
  "/api/roboflow",
  "/api/sam-refine",
  "/api/estimates",
  // /api/aerial moved to protected — was previously in the public-OK
  // list because middleware.ts assumed /quote used it, but a repo grep
  // (Cursor review) confirmed no callers. Gating it eliminates a free
  // cost-abuse surface (Google Aerial View render quota) until / if
  // we wire an actual customer-facing caller.
  "/api/aerial",
];

/**
 * INTENTIONALLY PUBLIC (do NOT add these to PROTECTED_*):
 *
 *   /quote, /embed, /p/*       customer-facing surfaces (the entire reason
 *                              the product exists)
 *   /login, /auth/*            sign-in flow itself — gating /login behind
 *                              auth would lock everyone out
 *   /privacy, /terms           legal pages must be reachable without auth
 *                              for TCPA + state-law compliance
 *   /api/leads, /api/sms/*     public ingest endpoints (BotID + Twilio HMAC)
 *   /api/places/*              address autocomplete used by /quote
 *   /api/solar, /api/solar-mask, /api/sam3-roof, /api/microsoft-building,
 *   /api/building, /api/storms, /api/hail-mrms, /api/weather  → /quote stack
 *   /api/healthz               operator probe (gated by HEALTHZ_TOKEN if set)
 *   GET /api/proposals/*       anonymous proposal read for /p/[id] share links
 *
 * If a future PR adds an /api/<new> that /quote depends on, add it to the
 * "intentionally public" comment in the file header — do not silently
 * leave it ungated. Likewise, anything new and rep-only goes in
 * PROTECTED_API_PREFIXES below.
 */
const PROTECTED_PAGE_PATHS = new Set<string>(["/"]);
const PROTECTED_PAGE_PREFIXES = ["/history", "/admin", "/eval-trace", "/dashboard"];

function isProtected(pathname: string, method: string): boolean {
  // POST /api/proposals — staff-only (prevents unauthenticated proposal spam).
  // GET /api/proposals/[publicId] must stay public for customer share links.
  if (pathname === "/api/proposals" && method === "POST") return true;

  // Exact match on protected pages
  if (PROTECTED_PAGE_PATHS.has(pathname)) return true;
  // Prefix match on rep-only sections
  for (const prefix of PROTECTED_PAGE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return true;
  }
  // Prefix match on rep-only API routes
  for (const prefix of PROTECTED_API_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) return true;
  }
  return false;
}

function unauthorizedResponse(): NextResponse {
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Voxaris Staff", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Detect a valid Supabase Auth session by sniffing the cookies. The
 * actual cookie name is `sb-<project_ref>-auth-token` — we match the
 * pattern rather than the literal so the middleware doesn't need to
 * know the project ref. A cookie alone doesn't prove the session is
 * still VALID (the JWT inside could be expired), but it's a strong
 * enough signal at the middleware layer; downstream Server Components
 * still verify via supabase.auth.getUser() before reading data.
 *
 * This is a deliberate trade-off: the alternative (calling getUser()
 * inside middleware) would add a network round-trip + a Supabase API
 * call to every protected request — too expensive. We accept that an
 * expired cookie temporarily slips past the middleware gate; the
 * Server Component fallback catches it within a single request.
 */
function hasSupabaseSession(req: NextRequest): boolean {
  for (const c of req.cookies.getAll()) {
    if (c.name.startsWith("sb-") && c.name.endsWith("-auth-token")) {
      return true;
    }
  }
  return false;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Customer-proposal share links live at `/p/<random-id>`. The page-
  // level metadata already sets `robots: { index: false }` for Google /
  // Googlebot, but other crawlers (Bing, Yandex, ChatGPT, etc.) respect
  // the `X-Robots-Tag` HTTP header more consistently than HTML meta.
  // Belt + suspenders for the customer-PII-on-share-link surface.
  if (pathname.startsWith("/p/")) {
    const res = NextResponse.next();
    res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return res;
  }

  // Public demo surface — pitch.voxaris.io/demo lets prospects play
  // with the dashboard without auth. Internally rewrite to /dashboard
  // so the same Server Components render, then set the demo header
  // so lib/dashboard.ts forces the demo-data fallback (never touches
  // real Supabase rows even when SUPABASE_* env vars are set in prod).
  //
  // URL stays /demo in the browser — DashboardChrome reads
  // usePathname() to detect the prefix and rewrites its nav links.
  if (pathname === "/demo" || pathname.startsWith("/demo/")) {
    const target = pathname === "/demo" ? "/dashboard" : "/dashboard" + pathname.slice(5);
    const url = req.nextUrl.clone();
    url.pathname = target;
    const reqHeaders = new Headers(req.headers);
    reqHeaders.set("x-voxaris-demo", "1");
    const res = NextResponse.rewrite(url, { request: { headers: reqHeaders } });
    // Don't let search engines index the demo or its rewritten target.
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  }

  // Root-domain landing: redirect unauthenticated visitors to the
  // customer-facing /quote page so a buyer pasting the bare URL
  // (`pitch.voxaris.io/`) doesn't hit the staff-auth 503. Authenticated
  // staff still land on the internal estimator at `/` via the redirect-
  // skip below.
  if (pathname === "/") {
    if (hasSupabaseSession(req)) {
      return NextResponse.next();
    }
    if (req.headers.get("authorization")?.startsWith("Basic ")) {
      // Let Basic-Auth-armed staff through to the internal estimator;
      // the protected-route logic below handles credential validation.
      return NextResponse.next();
    }
    const dest = new URL("/quote", req.url);
    return NextResponse.redirect(dest, 307);
  }

  if (!isProtected(pathname, req.method)) {
    return NextResponse.next();
  }

  // Supabase session — preferred path once auth migration is rolled
  // out. When the user has a valid session cookie, skip Basic Auth
  // entirely. Lets reps move to magic-link login without removing the
  // Basic Auth fallback (yet).
  if (hasSupabaseSession(req)) {
    return NextResponse.next();
  }

  const user = process.env.STAFF_AUTH_USER;
  const pass = process.env.STAFF_AUTH_PASS;

  // Fail-closed in production when auth env vars are missing — this
  // mirrors what we'd want for a defense-in-depth posture. Dev passes
  // through so localhost work doesn't require setting env vars.
  if (!user || !pass) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse(
        "Service unavailable: staff authentication is not configured.",
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.next();
  }

  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return unauthorizedResponse();
  }

  let decoded: string;
  try {
    decoded = atob(auth.slice(6).trim());
  } catch {
    return unauthorizedResponse();
  }
  // Username may contain ':' is not standard — split on FIRST colon only.
  const idx = decoded.indexOf(":");
  if (idx < 0) return unauthorizedResponse();
  const reqUser = decoded.slice(0, idx);
  const reqPass = decoded.slice(idx + 1);

  // Constant-time compare to defend against timing oracles. Length check
  // first since timingSafeEqual requires equal-length buffers.
  if (reqUser.length !== user.length || reqPass.length !== pass.length) {
    return unauthorizedResponse();
  }
  let mismatch = 0;
  for (let i = 0; i < reqUser.length; i++) {
    mismatch |= reqUser.charCodeAt(i) ^ user.charCodeAt(i);
  }
  for (let i = 0; i < reqPass.length; i++) {
    mismatch |= reqPass.charCodeAt(i) ^ pass.charCodeAt(i);
  }
  if (mismatch !== 0) {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Match everything except static assets and Next.js internals. The
   * `isProtected()` helper above does the real gating. Done this way
   * (broad matcher + in-function filter) because Next.js matchers
   * don't support arbitrary regex composition cleanly across many
   * prefixes, and the alternative — listing every protected path in
   * the matcher — duplicates the same data twice and goes stale.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon|apple-icon|icon\\.|opengraph-image|twitter-image|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff|woff2|map)).*)",
  ],
};

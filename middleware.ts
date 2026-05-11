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
 *   /api/estimates          rep proposal persistence
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

const PROTECTED_PAGE_PATHS = new Set<string>(["/"]);
const PROTECTED_PAGE_PREFIXES = ["/history", "/admin", "/eval-trace"];

function isProtected(pathname: string): boolean {
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

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (!isProtected(pathname)) {
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

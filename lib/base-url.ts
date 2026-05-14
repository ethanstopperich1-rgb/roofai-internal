// lib/base-url.ts
//
// Resolves an absolute base URL for server-side self-calls to our own
// /api routes. Required because Node's fetch() can't take relative URLs
// when running inside a Vercel function (no implicit origin), and the
// previous code defaulted to "http://localhost:3000" — which only works
// for local dev and silently fails to resolve from inside a deployed
// serverless function.
//
// Resolution chain (first non-empty wins):
//   1. NEXT_PUBLIC_BASE_URL  — explicit env (preferred when set; allows
//                              non-prod environments to point elsewhere)
//   2. VERCEL_PROJECT_PRODUCTION_URL — stable production URL, auto-set
//                                      by Vercel on every deploy
//   3. VERCEL_URL            — per-deployment URL, auto-set by Vercel
//                              (works for previews too)
//   4. "http://localhost:3000" — local dev fallback
//
// Vercel's auto-populated URLs come without the scheme, so we prepend
// https:// when they're used.

export function resolveBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_BASE_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/$/, "");
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod && prod.length > 0) return `https://${prod}`;
  const deployment = process.env.VERCEL_URL;
  if (deployment && deployment.length > 0) return `https://${deployment}`;
  return "http://localhost:3000";
}

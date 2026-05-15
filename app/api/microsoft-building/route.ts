/**
 * GET /api/microsoft-building?lat=..&lng=..
 *
 * @deprecated Phase 1 shim around `lib/sources/ms-buildings.ts`.
 *
 * This route was the original Nashville-scoped MS Buildings endpoint
 * (backed by a local TSV blob). The implementation has been replaced
 * by the Azure-based three-tier-cached `lib/sources/ms-buildings.ts`,
 * but the HTTP contract here is preserved BYTE-IDENTICAL so the four
 * known consumers continue working unchanged:
 *
 *   - app/quote/page.tsx                 (customer tier ladder)
 *   - app/dashboard/estimate/page.tsx    (rep tier ladder)
 *   - scripts/eval-truth.ts              (eval harness)
 *   - lib/reconcile-roof-polygon.ts      (server-side; will migrate
 *                                         to direct import in Phase 1.5)
 *
 * Phase 1.5 removes this route after the four consumers migrate to
 * /api/parcel-polygon. See tracking issue:
 *   "Phase 1.5: Migrate tier ladders to /api/parcel-polygon, remove
 *    /api/microsoft-building"
 *
 * IMPORTANT semantic contract: this route ONLY calls the MS Buildings
 * tier (fetchMsBuildingsOnly). It does NOT fall back to Solar / OSM —
 * doing so would silently change tier-ladder behavior in consumers
 * which expect "give me the MS Buildings polygon for this address, or
 * 404 if MS doesn't have one."
 *
 * Response shapes (preserved from the legacy impl):
 *
 *   200 success:
 *     {
 *       polygon: [{lat, lng}, ...],
 *       source:  "microsoft-buildings",
 *       contained: boolean
 *     }
 *
 *   404 no-coverage:
 *     {
 *       error: "no_coverage",
 *       message: "No Microsoft Building Footprint near this address."
 *     }
 *
 * Deprecation telemetry: every call logs the caller IP + referer +
 * user-agent so Phase 1.5 can verify whether the four known consumers
 * are actually the only callers (or surface forgotten internal tools).
 */

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { fetchMsBuildingsOnly } from "@/lib/sources/ms-buildings";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  // Phase 1 deprecation telemetry. One-line warn per call so the
  // failure corpus can attribute future surprise callers without
  // adding structured-logging dependencies.
  const url = new URL(req.url);
  console.warn(
    "[deprecated] /api/microsoft-building called",
    JSON.stringify({
      ip:
        req.headers.get("x-forwarded-for") ??
        req.headers.get("x-real-ip") ??
        "unknown",
      referer: req.headers.get("referer") ?? "none",
      userAgent: (req.headers.get("user-agent") ?? "none").slice(0, 200),
      query: url.search,
    }),
  );

  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  const result = await fetchMsBuildingsOnly({ lat, lng });
  if (!result) {
    return NextResponse.json(
      {
        error: "no_coverage",
        message: "No Microsoft Building Footprint near this address.",
      },
      { status: 404 },
    );
  }

  // Byte-identical response shape: polygon + source + contained ONLY.
  // The richer fields (areaSqft, fetchedAt, etc.) the new module knows
  // about are intentionally stripped — see Phase 1 design doc for the
  // contract preservation rationale.
  return NextResponse.json({
    polygon: result.polygon,
    source: result.source,
    contained: result.contained,
  });
}

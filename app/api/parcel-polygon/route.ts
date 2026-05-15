/**
 * GET /api/parcel-polygon
 *
 * Phase 1 picker route. Runs the multi-source parcel-polygon picker
 * (Solar mask → MS Buildings → OSM → Solar segments → synthetic
 * fallback) and returns the chosen polygon plus diagnostics.
 *
 * Customer-facing tier ladders (`/quote`, `/dashboard/estimate`) will
 * migrate to this route in Phase 1.5 — see tracking issue
 * "Phase 1.5: Migrate tier ladders to /api/parcel-polygon, remove
 * /api/microsoft-building". Until then they keep using
 * /api/microsoft-building (now a deprecated shim — see that file).
 *
 * Query params:
 *   lat, lng           — required; geocoded address center
 *   nocache=1          — bypass any source-level caches (debug only)
 *
 * Response (200):
 *   {
 *     polygon: [{lat, lng}, ...],
 *     source:  "solar_mask" | "ms_buildings" | "osm" | "solar_segments"
 *            | "synthetic_fallback",
 *     reason:  "only_available" | "priority" | "iou_winner"
 *            | "iou_tiebreaker" | "solar_disagreement"
 *            | "synthetic_no_sources",
 *     iouVsSolar: number | null,
 *     likelyOutbuilding: boolean,
 *     areaSqft: number,
 *     confidencePenalty: number,
 *     fetchedAt: string (ISO)
 *   }
 */

import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import {
  pickBestParcelPolygon,
  type SourceBundle,
} from "@/lib/sources/parcel-polygon";
import { fetchMsBuildings } from "@/lib/sources/ms-buildings";
import { fetchSolarRoofMask } from "@/lib/solar-mask";

export const runtime = "nodejs";
export const maxDuration = 20;

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json(
      { error: "lat & lng required" },
      { status: 400 },
    );
  }

  const apiKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;

  // Fetch each available source in parallel. OSM is wired here as a
  // future-work placeholder — Phase 1 doesn't ship an OSM fetcher yet
  // (tracked under Phase 1.5 follow-up). Solar segments come from the
  // runRoofPipeline cache layer when this route is hit during a pipeline
  // run; standalone callers pass null and the picker handles it.
  const [solarMask, msResult] = await Promise.all([
    apiKey
      ? fetchSolarRoofMask({ lat, lng, apiKey }).catch(() => null)
      : Promise.resolve(null),
    fetchMsBuildings({ lat, lng }).catch(() => null),
  ]);

  const bundle: SourceBundle = {
    solar_mask: solarMask?.latLng ?? null,
    ms_buildings: msResult?.polygon ?? null,
    osm: null, // Phase 1.5
    solar_segments: null, // populated when called via /api/roof-pipeline
  };

  const picked = pickBestParcelPolygon({ lat, lng }, bundle);

  return NextResponse.json(
    {
      polygon: picked.polygon,
      source: picked.source,
      reason: picked.reason,
      iouVsSolar: picked.iouVsSolar,
      likelyOutbuilding: picked.likelyOutbuilding,
      areaSqft: picked.areaSqft,
      confidencePenalty: picked.confidencePenalty,
      fetchedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

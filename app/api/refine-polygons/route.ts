import { NextResponse } from "next/server";
import { refineRoofPolygons, type RefineResult } from "@/lib/replicate";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/refine-polygons
 * Body: { lat, lng }
 *
 * Runs SAM 2 over the property's satellite tile and returns refined roof
 * polygons in lat/lng space (replaces Solar API bounding-box approximations).
 *
 * Cached for 6h per lat/lng. Latency: 10-30s typical.
 * Returns 503 if REPLICATE_API_TOKEN is not configured.
 */
export async function POST(req: Request) {
  let body: { lat?: number; lng?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  if (!process.env.REPLICATE_API_TOKEN) {
    return NextResponse.json(
      { error: "Missing REPLICATE_API_TOKEN" },
      { status: 503 },
    );
  }

  const googleMapsKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleMapsKey) {
    return NextResponse.json({ error: "Missing Google Maps key" }, { status: 503 });
  }

  const cached = getCached<RefineResult>("sam", lat, lng);
  if (cached) {
    return NextResponse.json({
      polygons: cached.polygons.map(({ latLng, pixelArea }) => ({ latLng, pixelArea })),
      cached: true,
    });
  }

  let result: RefineResult | null;
  try {
    result = await refineRoofPolygons({ lat, lng, googleMapsKey });
  } catch (err) {
    const code = err instanceof Error ? err.message : "unknown";
    if (code === "REPLICATE_NO_CREDIT") {
      return NextResponse.json(
        {
          error: "no_credit",
          message:
            "Replicate trial credit exhausted. Add billing at replicate.com/account/billing to enable roof outline refinement.",
        },
        { status: 402 },
      );
    }
    if (code === "REPLICATE_UNAUTHORIZED") {
      return NextResponse.json(
        { error: "bad_token", message: "Invalid REPLICATE_API_TOKEN — regenerate at replicate.com." },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: "sam_error", message: code },
      { status: 502 },
    );
  }

  if (!result) {
    return NextResponse.json(
      { error: "no_polygons", message: "Could not extract roof polygons from this property." },
      { status: 502 },
    );
  }

  setCached("sam", lat, lng, result);

  // Strip pixel/raw data from the response (only useful server-side)
  return NextResponse.json({
    polygons: result.polygons.map(({ latLng, pixelArea }) => ({ latLng, pixelArea })),
    cached: false,
  });
}

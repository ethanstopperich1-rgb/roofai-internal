import { NextResponse } from "next/server";
import {
  refineRoofWithRoboflow,
  CANDIDATE_MODELS,
  type RoboflowResult,
} from "@/lib/roboflow";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/roboflow?lat=..&lng=..
 *
 * Roof-specific instance segmentation via Roboflow Hosted Inference. Used
 * as a parallel polygon source — slots ABOVE Solar bbox segments and below
 * Solar mask in the priority chain (Solar mask is photogrammetric ground
 * truth when available; Roboflow is roof-trained AI on the same satellite
 * tile the rest of the pipeline uses).
 *
 * Currently runs ONLY the Satellite Rooftop Map model — the bake-off in
 * scripts/eval-roboflow.ts found it nailed Carefree Ln (92% conf, 13 verts,
 * correct rotation) where tiles3d-vision had been producing tilted
 * rectangles. Roof Seg 2 returned nothing on the same address; Roof
 * Segmentation Final traced the wrong house. To re-evaluate, edit the
 * eval script and add other CANDIDATE_MODELS entries here.
 *
 * Response shape: { polygon: LatLng[], polygons: LatLng[][], confidence,
 * className, source: "roboflow", modelSlug, modelVersion }
 *   - polygon: the primary (largest by area) polygon — what app/page.tsx
 *     consumes when ranking sources
 *   - polygons: ALL polygons that passed the confidence + proximity filter
 *     (multi-component: main house + attached/detached structures). Kept
 *     for Phase 2 multi-facet plumbing — the consumer can choose to draw
 *     all of them or just the primary.
 *
 * Cached server-side per lat/lng for 6h.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  const roboflowKey = process.env.ROBOFLOW_API_KEY;
  if (!roboflowKey) {
    return NextResponse.json(
      { error: "Missing ROBOFLOW_API_KEY" },
      { status: 503 },
    );
  }
  const googleMapsKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleMapsKey) {
    return NextResponse.json(
      { error: "Missing Google Maps key" },
      { status: 503 },
    );
  }

  const cached = getCached<RoboflowResult | null>("roboflow", lat, lng);
  if (cached !== null) {
    if (cached === undefined) {
      return NextResponse.json(
        { error: "no_polygon", message: "Roboflow returned no usable polygon." },
        { status: 404 },
      );
    }
    return buildResponse(cached);
  }

  let result: RoboflowResult | null = null;
  try {
    result = await refineRoofWithRoboflow({
      lat,
      lng,
      googleMapsKey,
      roboflowKey,
      model: CANDIDATE_MODELS.satelliteRooftopMap,
    });
  } catch (err) {
    console.error("[api/roboflow] inference error:", err);
    return NextResponse.json(
      { error: "inference_error", message: err instanceof Error ? err.message : "unknown" },
      { status: 502 },
    );
  }

  if (!result) {
    setCached<RoboflowResult | null>("roboflow", lat, lng, null);
    return NextResponse.json(
      { error: "no_polygon", message: "Roboflow returned no usable polygon." },
      { status: 404 },
    );
  }

  setCached("roboflow", lat, lng, result);
  return buildResponse(result);
}

function buildResponse(result: RoboflowResult) {
  const primary = result.polygons[0];
  return NextResponse.json({
    polygon: primary.latLng,
    polygons: result.polygons.map((p) => p.latLng),
    confidence: primary.confidence,
    className: primary.class,
    source: result.source,
    modelSlug: result.modelSlug,
    modelVersion: result.modelVersion,
  });
}

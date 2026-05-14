import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { findPrimaryResidence } from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/find-residence
 *
 * Wraps `findPrimaryResidence` (Claude vision wide-tile pass) for client-side
 * use by the pin-confirmation step. Given a geocoded address point, returns
 * Claude's best guess of where the actual residence sits on that lot, so the
 * UI can move the pin off a barn / outbuilding / wrong neighbour before the
 * user confirms.
 *
 * Returns null fields when Claude can't identify a residence, when
 * ANTHROPIC_API_KEY is unset, or when the upstream call errors. Callers
 * fall through to the geocoded point.
 */

interface RequestBody {
  lat?: number;
  lng?: number;
  address?: string;
}

export async function POST(req: Request) {
  const __rl = await rateLimit(req, "expensive");
  if (__rl) return __rl;

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[find-residence] ANTHROPIC_API_KEY not set");
    return NextResponse.json(
      { lat: null, lng: null, confidence: 0, reasoning: "no_anthropic_key" },
      { status: 200 },
    );
  }

  const googleKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!googleKey) {
    console.warn("[find-residence] no Google Maps key configured");
    return NextResponse.json(
      { lat: null, lng: null, confidence: 0, reasoning: "no_google_key" },
      { status: 200 },
    );
  }

  let body: RequestBody;
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

  try {
    const result = await findPrimaryResidence({
      lat,
      lng,
      address: typeof body.address === "string" ? body.address : undefined,
      googleApiKey: googleKey,
    });
    if (!result) {
      return NextResponse.json({
        lat: null,
        lng: null,
        confidence: 0,
        reasoning: "no_residence_found",
      });
    }
    return NextResponse.json({
      lat: result.lat,
      lng: result.lng,
      confidence: result.confidence,
      reasoning: result.reasoning,
    });
  } catch (err) {
    console.error("[find-residence] error:", err);
    return NextResponse.json(
      { lat: null, lng: null, confidence: 0, reasoning: "error" },
      { status: 200 },
    );
  }
}

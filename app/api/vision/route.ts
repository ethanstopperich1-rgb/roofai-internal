import { NextResponse } from "next/server";
import { analyzeRoofImage, fetchSatelliteImage } from "@/lib/anthropic";
import { getCached, setCached } from "@/lib/cache";
import type { RoofVision } from "@/types/estimate";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  const cached = await getCached<RoofVision>("vision", lat, lng);
  if (cached) return NextResponse.json(cached);

  const mapsKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
  if (!mapsKey) {
    return NextResponse.json({ error: "Missing Google key" }, { status: 503 });
  }

  const img = await fetchSatelliteImage({ lat, lng, apiKey: mapsKey });
  if (!img) {
    return NextResponse.json({ error: "satellite_unavailable" }, { status: 502 });
  }

  const vision = await analyzeRoofImage({
    imageBase64: img.base64,
    imageMimeType: img.mimeType,
  });

  await setCached("vision", lat, lng, vision);
  return NextResponse.json(vision);
}

import { NextResponse } from "next/server";
import { fetchAttomProperty, type AttomProperty } from "@/lib/attom";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/property?address=...&lat=...&lng=...
 *
 * Returns ATTOM "basicprofile" data for the given address (stories, year built,
 * building sqft, lot, beds/baths, property type). lat/lng is used only as the
 * cache key; ATTOM is queried by formatted address.
 */
export async function GET(req: Request) {
  const apiKey = process.env.ATTOM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing ATTOM_API_KEY" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!address) {
    return NextResponse.json({ error: "address required" }, { status: 400 });
  }

  // Cache by lat/lng when available, otherwise by hash of address
  const cacheKey = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  if (cacheKey) {
    const hit = getCached<AttomProperty>("attom", cacheKey.lat, cacheKey.lng);
    if (hit) return NextResponse.json(hit);
  }

  const data = await fetchAttomProperty({ formattedAddress: address, apiKey });
  if (!data) {
    return NextResponse.json(
      { error: "not_found", message: "ATTOM has no record for this address." },
      { status: 404 },
    );
  }

  if (cacheKey) setCached("attom", cacheKey.lat, cacheKey.lng, data);
  return NextResponse.json(data);
}

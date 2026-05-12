import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";

interface AddressComponent {
  types?: string[];
  shortText?: string;
  longText?: string;
}

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;
  const apiKey = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing key" }, { status: 503 });
  const { searchParams } = new URL(req.url);
  const placeId = searchParams.get("placeId");
  if (!placeId) return NextResponse.json({ error: "placeId required" }, { status: 400 });

  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "formattedAddress,addressComponents,location",
    },
    signal: AbortSignal.timeout(8_000),
  });
  const data = await res.json();
  if (!res.ok) {
    return NextResponse.json({ error: "places error", detail: data }, { status: res.status });
  }
  const components = data.addressComponents as AddressComponent[] | undefined;
  const zip = components?.find((c) => c.types?.includes("postal_code"))?.shortText;
  // street_number is the leading numeric part of the address ("1234" in
  // "1234 Main St"). When Places returns details for a fallback Place ID
  // (e.g. the user typed "Main St" and we autocompleted), this field is
  // OFTEN MISSING — which means we've geocoded a street, not a house.
  // Surface it so the caller can refuse the submission instead of
  // silently quoting a nearby roof.
  const streetNumber = components?.find((c) =>
    c.types?.includes("street_number"),
  )?.shortText ?? null;
  return NextResponse.json({
    formatted: data.formattedAddress,
    zip,
    lat: data.location?.latitude,
    lng: data.location?.longitude,
    streetNumber,
    hasStreetNumber: Boolean(streetNumber),
  });
}

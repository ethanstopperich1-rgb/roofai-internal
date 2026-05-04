import { NextResponse } from "next/server";

interface AddressComponent {
  types?: string[];
  shortText?: string;
  longText?: string;
}

export async function GET(req: Request) {
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
  });
  const data = await res.json();
  if (!res.ok) {
    return NextResponse.json({ error: "places error", detail: data }, { status: res.status });
  }
  const zip = (data.addressComponents as AddressComponent[] | undefined)?.find((c) =>
    c.types?.includes("postal_code")
  )?.shortText;
  return NextResponse.json({
    formatted: data.formattedAddress,
    zip,
    lat: data.location?.latitude,
    lng: data.location?.longitude,
  });
}

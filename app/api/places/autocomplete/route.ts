import { NextResponse } from "next/server";

interface PlacePrediction {
  placePrediction?: {
    placeId?: string;
    text?: { text?: string };
  };
}

export async function GET(req: Request) {
  const apiKey = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing key" }, { status: 503 });
  const { searchParams } = new URL(req.url);
  const input = searchParams.get("q");
  if (!input || input.trim().length < 3) {
    return NextResponse.json({ suggestions: [] });
  }

  const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text",
    },
    body: JSON.stringify({
      input,
      includedRegionCodes: ["us"],
      includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    return NextResponse.json({ error: "places error", detail: data }, { status: res.status });
  }
  const suggestions = (data.suggestions ?? [])
    .map((s: PlacePrediction) => ({
      placeId: s.placePrediction?.placeId,
      text: s.placePrediction?.text?.text,
    }))
    .filter((s: { placeId?: string; text?: string }) => s.placeId && s.text);
  return NextResponse.json({ suggestions });
}

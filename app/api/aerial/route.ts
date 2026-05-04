import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const apiKey = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing key" }, { status: 503 });
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address");
  if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });

  const url = `https://aerialview.googleapis.com/v1/videos:lookupVideo?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) return NextResponse.json({ error: "Aerial error", detail: data }, { status: res.status });

  // States: PROCESSING, ACTIVE, FAILED
  return NextResponse.json({
    state: data.state,
    videoMp4: data.uris?.MP4_HIGH?.landscapeUri ?? data.uris?.MP4_MEDIUM?.landscapeUri,
    videoMp4Portrait: data.uris?.MP4_HIGH?.portraitUri ?? data.uris?.MP4_MEDIUM?.portraitUri,
    image: data.uris?.IMAGE?.landscapeUri,
    duration: data.metadata?.duration,
  });
}

export async function POST(req: Request) {
  // Render request to start processing for new address
  const apiKey = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing key" }, { status: 503 });
  const body = (await req.json()) as { address?: string };
  if (!body.address) return NextResponse.json({ error: "address required" }, { status: 400 });

  const url = `https://aerialview.googleapis.com/v1/videos:renderVideo?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: body.address }),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const apiKey = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing key" }, { status: 503 });
  const { searchParams } = new URL(req.url);
  const lat = searchParams.get("lat");
  const lng = searchParams.get("lng");
  if (!lat || !lng) return NextResponse.json({ error: "lat & lng required" }, { status: 400 });

  const url = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lng}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) return NextResponse.json({ error: "Weather error", detail: data }, { status: res.status });

  return NextResponse.json({
    description: data.weatherCondition?.description?.text,
    icon: data.weatherCondition?.iconBaseUri,
    tempF: data.temperature?.degrees != null ? Math.round((data.temperature.degrees * 9) / 5 + 32) : null,
    tempC: data.temperature?.degrees,
    humidity: data.relativeHumidity,
    windMph: data.wind?.speed?.value != null ? Math.round(data.wind.speed.value * 0.621371) : null,
    windDir: data.wind?.direction?.cardinal,
    isDaytime: data.isDaytime,
  });
}

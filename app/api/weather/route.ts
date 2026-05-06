import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import { parseLatLng } from "@/lib/validate";

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;
  const apiKey = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing key" }, { status: 503 });
  const ll = parseLatLng(new URL(req.url).searchParams);
  if (!ll) return NextResponse.json({ error: "valid lat & lng required" }, { status: 400 });
  const { lat, lng } = ll;

  const url = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lng}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
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

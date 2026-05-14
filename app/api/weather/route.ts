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

  // unitsSystem=IMPERIAL — Google returns temperature in F and wind in mph
  // directly, so we don't have to do unit math client-side (and risk drift
  // when Google adjusts rounding). languageCode=en for description text.
  const url =
    `https://weather.googleapis.com/v1/currentConditions:lookup` +
    `?key=${apiKey}&location.latitude=${lat}&location.longitude=${lng}` +
    `&unitsSystem=IMPERIAL&languageCode=en`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  const data = await res.json();
  if (!res.ok) return NextResponse.json({ error: "Weather error", detail: data }, { status: res.status });

  // Google now returns °F directly under unitsSystem=IMPERIAL. Keep the
  // tempC field for any downstream consumer that wants metric (converted
  // here from the imperial value so output shape is stable across env).
  const tempF = data.temperature?.degrees ?? null;
  const tempC = tempF != null ? Math.round((((tempF - 32) * 5) / 9) * 10) / 10 : null;
  return NextResponse.json({
    description: data.weatherCondition?.description?.text,
    icon: data.weatherCondition?.iconBaseUri,
    tempF: tempF != null ? Math.round(tempF) : null,
    tempC,
    humidity: data.relativeHumidity,
    windMph: data.wind?.speed?.value != null ? Math.round(data.wind.speed.value) : null,
    windDir: data.wind?.direction?.cardinal,
    isDaytime: data.isDaytime,
  });
}

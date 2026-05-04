import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const apiKey = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing key" }, { status: 503 });
  }
  const { searchParams } = new URL(req.url);
  const lat = searchParams.get("lat");
  const lng = searchParams.get("lng");
  if (!lat || !lng) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  const url =
    `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
    `?location.latitude=${lat}&location.longitude=${lng}` +
    `&requiredQuality=HIGH&key=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: "Solar API error", detail: text }, { status: res.status });
  }
  const data = await res.json();
  const stats = data?.solarPotential;
  const segments: Array<{ pitchDegrees?: number; azimuthDegrees?: number; stats?: { areaMeters2?: number } }> =
    stats?.roofSegmentStats ?? [];
  const totalRoofM2 = segments.reduce((s, seg) => s + (seg.stats?.areaMeters2 ?? 0), 0);
  const totalRoofSqft = Math.round(totalRoofM2 * 10.7639);
  const avgPitchDeg =
    segments.length
      ? segments.reduce((s, seg) => s + (seg.pitchDegrees ?? 0), 0) / segments.length
      : null;

  // Convert pitch degrees -> rise/12
  let pitch: string | null = null;
  if (avgPitchDeg != null) {
    const rise = Math.round(Math.tan((avgPitchDeg * Math.PI) / 180) * 12);
    pitch = rise >= 8 ? "8/12+" : `${Math.max(4, rise)}/12`;
  }

  return NextResponse.json({
    sqft: totalRoofSqft || null,
    pitch,
    pitchDegrees: avgPitchDeg,
    segmentCount: segments.length,
    maxArrayPanels: stats?.maxArrayPanelsCount ?? null,
    yearlyKwhPotential: stats?.maxSunshineHoursPerYear ?? null,
  });
}

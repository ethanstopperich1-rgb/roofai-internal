import { NextResponse } from "next/server";
import type { Pitch, SolarSummary } from "@/types/estimate";
import { getCached, setCached } from "@/lib/cache";

export const runtime = "nodejs";

type BoundingBox = {
  sw: { latitude: number; longitude: number };
  ne: { latitude: number; longitude: number };
};

type Segment = {
  pitchDegrees?: number;
  azimuthDegrees?: number;
  stats?: { areaMeters2?: number; groundAreaMeters2?: number };
  boundingBox?: BoundingBox;
};

function bboxToPolygon(bbox: BoundingBox): Array<{ lat: number; lng: number }> {
  const sw = { lat: bbox.sw.latitude, lng: bbox.sw.longitude };
  const ne = { lat: bbox.ne.latitude, lng: bbox.ne.longitude };
  const nw = { lat: ne.lat, lng: sw.lng };
  const se = { lat: sw.lat, lng: ne.lng };
  // counter-clockwise winding
  return [nw, ne, se, sw];
}

function imageryDateString(d: { year?: number; month?: number; day?: number } | undefined): string | null {
  if (!d?.year) return null;
  const m = d.month ? String(d.month).padStart(2, "0") : "01";
  const day = d.day ? String(d.day).padStart(2, "0") : "01";
  return `${d.year}-${m}-${day}`;
}

function degreesToPitch(deg: number | null | undefined): Pitch | null {
  if (deg == null) return null;
  const rise = Math.round(Math.tan((deg * Math.PI) / 180) * 12);
  if (rise >= 8) return "8/12+";
  if (rise >= 7) return "7/12";
  if (rise >= 6) return "6/12";
  if (rise >= 5) return "5/12";
  return "4/12";
}

export async function GET(req: Request) {
  const apiKey = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Missing key" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  const cached = getCached<SolarSummary>("solar", lat, lng);
  if (cached) return NextResponse.json(cached);

  const url =
    `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
    `?location.latitude=${lat}&location.longitude=${lng}` +
    `&requiredQuality=HIGH&key=${apiKey}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    // Cache empty result briefly so we don't hammer Solar for known-misses
    if (res.status === 404) {
      const empty: SolarSummary = {
        sqft: null,
        pitch: null,
        pitchDegrees: null,
        segmentCount: 0,
        buildingFootprintSqft: null,
        imageryQuality: "UNKNOWN",
        imageryDate: null,
        segmentPolygonsLatLng: [],
      };
      setCached("solar", lat, lng, empty);
      return NextResponse.json(empty);
    }
    const text = await res.text();
    return NextResponse.json({ error: "Solar API error", detail: text }, { status: res.status });
  }

  const data = await res.json();
  const stats = data?.solarPotential;
  const segments: Segment[] = stats?.roofSegmentStats ?? [];

  const totalRoofM2 = segments.reduce((s, seg) => s + (seg.stats?.areaMeters2 ?? 0), 0);
  const totalRoofSqft = totalRoofM2 ? Math.round(totalRoofM2 * 10.7639) : null;

  const totalArea = segments.reduce((s, seg) => s + (seg.stats?.areaMeters2 ?? 0), 0) || 1;
  const avgPitchDeg = segments.length
    ? segments.reduce((s, seg) => s + (seg.pitchDegrees ?? 0) * (seg.stats?.areaMeters2 ?? 0), 0) /
      totalArea
    : null;

  const segmentPolygonsLatLng = segments
    .filter((s) => s.boundingBox)
    .map((s) => bboxToPolygon(s.boundingBox!));

  const buildingFootprintM2 = stats?.wholeRoofStats?.groundAreaMeters2 ?? null;
  const buildingFootprintSqft =
    buildingFootprintM2 != null ? Math.round(buildingFootprintM2 * 10.7639) : null;

  const summary: SolarSummary = {
    sqft: totalRoofSqft,
    pitch: degreesToPitch(avgPitchDeg),
    pitchDegrees: avgPitchDeg,
    segmentCount: segments.length,
    buildingFootprintSqft,
    imageryQuality: data?.imageryQuality ?? "UNKNOWN",
    imageryDate: imageryDateString(data?.imageryDate),
    segmentPolygonsLatLng,
    maxArrayPanels: stats?.maxArrayPanelsCount ?? null,
    yearlyKwhPotential: stats?.maxSunshineHoursPerYear ?? null,
  };

  setCached("solar", lat, lng, summary);
  return NextResponse.json(summary);
}

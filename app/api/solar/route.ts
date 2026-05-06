import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/ratelimit";
import type { Pitch, SolarSegment, SolarSummary } from "@/types/estimate";
import { getCached, setCached } from "@/lib/cache";
import { fetchWithTimeout } from "@/lib/safe-fetch";
import { rotateAllFacets } from "@/lib/solar-facets";

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

/**
 * Area-weighted dominant building axis from segment azimuths, mod 90.
 * Doubles the angle before averaging so opposite facets (front-of-house at
 * 90°, back-of-house at 270°, both perpendicular to the same ridge axis)
 * reinforce instead of cancel out.
 */
function dominantAzimuth(segs: SolarSegment[]): number | null {
  if (segs.length === 0) return null;
  let sumX = 0, sumY = 0, totalA = 0;
  for (const s of segs) {
    if (s.areaSqft <= 0) continue;
    const a = ((s.azimuthDegrees % 90) + 90) % 90;
    const rad = (a * Math.PI) / 90; // double-angle trick
    sumX += Math.cos(rad) * s.areaSqft;
    sumY += Math.sin(rad) * s.areaSqft;
    totalA += s.areaSqft;
  }
  if (totalA === 0) return null;
  const avg = (Math.atan2(sumY, sumX) * 90) / Math.PI / 2;
  return ((avg % 90) + 90) % 90;
}

export async function GET(req: Request) {
  const __rl = await rateLimit(req, "standard");
  if (__rl) return __rl;
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

  const cached = await getCached<SolarSummary>("solar", lat, lng);
  if (cached) return NextResponse.json(cached);

  const url =
    `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
    `?location.latitude=${lat}&location.longitude=${lng}` +
    `&requiredQuality=HIGH&key=${apiKey}`;

  const res = await fetchWithTimeout(url, { cache: "no-store", timeoutMs: 15_000 });
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
        segments: [],
        dominantAzimuthDeg: null,
      };
      await setCached("solar", lat, lng, empty);
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

  // Solar `findClosest` returns axis-aligned bounding boxes per facet —
  // visibly wrong on non-north-aligned homes if rendered as-is. Rotate
  // each bbox by the building's dominant axis (computed below) so each
  // rectangle aligns with its actual roof face. Still rectangles (won't
  // match L-shapes or triangular hip facets), but structurally correct
  // enough that the priority chain can fall back to Solar facets when
  // Roboflow / SAM are demoted.
  // Populated after we know `dominantAzimuthDeg` — see below.
  let segmentPolygonsLatLng: Array<Array<{ lat: number; lng: number }>> = [];

  const buildingFootprintM2 = stats?.wholeRoofStats?.groundAreaMeters2 ?? null;
  const buildingFootprintSqft =
    buildingFootprintM2 != null ? Math.round(buildingFootprintM2 * 10.7639) : null;

  // Per-facet metadata kept for validators (§9) and ensemble fuser (§6).
  // Solar's `boundingBox` is sometimes absent on synthetic facets; default
  // to a degenerate bbox so consumers don't have to null-guard.
  const enrichedSegments: SolarSegment[] = segments.map((seg) => ({
    pitchDegrees: seg.pitchDegrees ?? 0,
    azimuthDegrees: seg.azimuthDegrees ?? 0,
    areaSqft: Math.round((seg.stats?.areaMeters2 ?? 0) * 10.7639),
    groundAreaSqft: Math.round((seg.stats?.groundAreaMeters2 ?? 0) * 10.7639),
    bboxLatLng: {
      swLat: seg.boundingBox?.sw.latitude ?? 0,
      swLng: seg.boundingBox?.sw.longitude ?? 0,
      neLat: seg.boundingBox?.ne.latitude ?? 0,
      neLng: seg.boundingBox?.ne.longitude ?? 0,
    },
  }));

  const dominantAzimuthDeg = dominantAzimuth(enrichedSegments);
  segmentPolygonsLatLng = rotateAllFacets(enrichedSegments, dominantAzimuthDeg);

  const summary: SolarSummary = {
    sqft: totalRoofSqft,
    pitch: degreesToPitch(avgPitchDeg),
    pitchDegrees: avgPitchDeg,
    segmentCount: segments.length,
    buildingFootprintSqft,
    imageryQuality: data?.imageryQuality ?? "UNKNOWN",
    imageryDate: imageryDateString(data?.imageryDate),
    segmentPolygonsLatLng,
    segments: enrichedSegments,
    dominantAzimuthDeg,
    maxArrayPanels: stats?.maxArrayPanelsCount ?? null,
    yearlyKwhPotential: stats?.maxSunshineHoursPerYear ?? null,
  };

  await setCached("solar", lat, lng, summary);
  return NextResponse.json(summary);
}

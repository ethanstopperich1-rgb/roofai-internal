import { NextResponse } from "next/server";
import { getBigQuery } from "@/lib/bigquery";

export const runtime = "nodejs";
export const maxDuration = 30;

interface StormRow {
  event_type: string;
  event_begin_time: { value: string } | string;
  magnitude: number | null;
  magnitude_type: string | null;
  event_latitude: number;
  event_longitude: number;
  distance_miles: number;
}

/**
 * GET /api/storms?lat=..&lng=..&radiusMiles=5&yearsBack=5
 *
 * Queries `bigquery-public-data.noaa_historic_severe_storms.storms_*` for hail,
 * tornado and damaging-wind events within the bbox of (lat, lng, radius) over
 * the last `yearsBack` years. Returns events ordered by date desc.
 *
 * NOAA SPC reports are coarse (county-level for older entries, point-level for
 * recent ones), so distance is informational. We use Haversine for accuracy.
 */
export async function GET(req: Request) {
  const bq = getBigQuery();
  if (!bq) {
    return NextResponse.json(
      { error: "BigQuery not configured (set GCP_SERVICE_ACCOUNT_KEY)" },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lng = Number(searchParams.get("lng"));
  const radius = Math.max(1, Math.min(50, Number(searchParams.get("radiusMiles")) || 5));
  const years = Math.max(1, Math.min(20, Number(searchParams.get("yearsBack")) || 5));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat & lng required" }, { status: 400 });
  }

  // Bbox approximation. 1 deg lat = 69 mi. 1 deg lng = 69 cos(lat) mi.
  const dLat = radius / 69;
  const dLng = radius / (69 * Math.cos((lat * Math.PI) / 180));
  const minLat = lat - dLat;
  const maxLat = lat + dLat;
  const minLng = lng - dLng;
  const maxLng = lng + dLng;

  const yearTables: string[] = [];
  const currentYear = new Date().getFullYear();
  for (let y = currentYear - years; y <= currentYear; y++) {
    yearTables.push(`storms_${y}`);
  }
  // Use _TABLE_SUFFIX so we don't fail on years that don't exist yet.
  const minYear = currentYear - years;
  const maxYear = currentYear;

  const sql = `
WITH events AS (
  SELECT
    event_type,
    event_begin_time,
    magnitude,
    magnitude_type,
    event_latitude,
    event_longitude
  FROM \`bigquery-public-data.noaa_historic_severe_storms.storms_*\`
  WHERE _TABLE_SUFFIX BETWEEN @minYear AND @maxYear
    AND event_latitude IS NOT NULL AND event_longitude IS NOT NULL
    AND event_latitude BETWEEN @minLat AND @maxLat
    AND event_longitude BETWEEN @minLng AND @maxLng
    AND event_type IN ('Hail', 'Tornado', 'Thunderstorm Wind', 'High Wind')
)
SELECT
  event_type,
  event_begin_time,
  magnitude,
  magnitude_type,
  event_latitude,
  event_longitude,
  ST_DISTANCE(ST_GEOGPOINT(@lng, @lat), ST_GEOGPOINT(event_longitude, event_latitude)) / 1609.34 AS distance_miles
FROM events
ORDER BY event_begin_time DESC
LIMIT 50`;

  try {
    const [rows] = await bq.query({
      query: sql,
      params: {
        minYear: String(minYear),
        maxYear: String(maxYear),
        minLat,
        maxLat,
        minLng,
        maxLng,
        lat,
        lng,
      },
      types: {
        minYear: "STRING",
        maxYear: "STRING",
        minLat: "FLOAT64",
        maxLat: "FLOAT64",
        minLng: "FLOAT64",
        maxLng: "FLOAT64",
        lat: "FLOAT64",
        lng: "FLOAT64",
      },
      location: "US",
    });

    const events = (rows as StormRow[]).map((r) => ({
      type: r.event_type,
      date:
        typeof r.event_begin_time === "string"
          ? r.event_begin_time
          : r.event_begin_time?.value ?? null,
      magnitude: r.magnitude,
      magnitudeType: r.magnitude_type,
      lat: r.event_latitude,
      lng: r.event_longitude,
      distanceMiles: r.distance_miles ? Math.round(r.distance_miles * 10) / 10 : null,
    }));

    const summary = summarize(events, radius);
    return NextResponse.json({ events, summary, query: { lat, lng, radius, years } });
  } catch (err) {
    console.error("BigQuery storms query failed", err);
    return NextResponse.json(
      { error: "query_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

function summarize(
  events: Array<{ type: string; magnitude: number | null; distanceMiles: number | null }>,
  radius: number,
) {
  const hail = events.filter((e) => e.type === "Hail");
  const tornado = events.filter((e) => e.type === "Tornado");
  const wind = events.filter((e) => e.type !== "Hail" && e.type !== "Tornado");
  const maxHail = hail.reduce((m, e) => Math.max(m, e.magnitude ?? 0), 0);
  return {
    total: events.length,
    hailCount: hail.length,
    tornadoCount: tornado.length,
    windCount: wind.length,
    maxHailInches: maxHail || null,
    radiusMiles: radius,
  };
}

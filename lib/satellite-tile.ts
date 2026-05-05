/**
 * Satellite tile fetcher with imagery-freshness aware source selection.
 *
 * Google Static Maps is the default provider — high US coverage, well-tested
 * across the pipeline. But Google's imagery for any given property can be
 * 5–12 years old (the `imageryDate` chip on screenshots regularly shows
 * 2014, 2015, 2017 dates), and a roof replaced after the imagery date
 * shows up wrong: the analysis runs on shingles that no longer exist.
 *
 * When `MAPBOX_ACCESS_TOKEN` is set AND Google's Solar API reports an
 * `imageryDate` older than `STALE_YEARS`, route to Mapbox Satellite
 * (Vexcel + Maxar imagery, often newer per region). Otherwise stay on
 * Google. Mapbox failures fall back to Google so the pipeline never
 * stalls on a Mapbox outage.
 *
 * The freshness check uses Solar's cached `imageryDate` — every estimate
 * already calls Solar, so no extra round-trip. If Solar didn't return
 * (rural / 404) or `imageryDate` is null, we trust Google by default.
 */

import type { SolarSummary } from "@/types/estimate";
import { getCached } from "./cache";

/** Years past which Google imagery is considered too stale to trust */
export const STALE_YEARS = 3;

export interface SatelliteImage {
  base64: string;
  mimeType: "image/png" | "image/jpeg";
  source: "google" | "mapbox";
  /** ISO YYYY-MM-DD if known. Comes from Solar API; Mapbox tiles don't
   *  expose per-tile capture dates, so this reflects Google's reported
   *  date for the location regardless of which provider served the bytes. */
  imageryDate: string | null;
}

export interface FetchSatelliteOpts {
  lat: number;
  lng: number;
  googleApiKey: string;
  /** Base size (Google's `size` param, max 640) */
  sizePx?: number;
  zoom?: number;
  /** Google's `scale` param. Mapbox uses `@2x` retina mode for parity. */
  scale?: 1 | 2;
}

async function chooseSource(
  lat: number,
  lng: number,
): Promise<"google" | "mapbox"> {
  if (!process.env.MAPBOX_ACCESS_TOKEN) return "google";
  const solar = await getCached<SolarSummary>("solar", lat, lng);
  const date = solar?.imageryDate;
  if (!date) return "google";
  const ms = Date.now() - new Date(date).getTime();
  if (!isFinite(ms) || ms < 0) return "google";
  const years = ms / (365.25 * 24 * 3600 * 1000);
  return years > STALE_YEARS ? "mapbox" : "google";
}

export async function fetchSatelliteImage(
  opts: FetchSatelliteOpts,
): Promise<SatelliteImage | null> {
  const { lat, lng, googleApiKey, sizePx = 640, zoom = 20, scale = 1 } = opts;
  const solar = await getCached<SolarSummary>("solar", lat, lng);
  const imageryDate = solar?.imageryDate ?? null;
  const preferred = await chooseSource(lat, lng);

  if (preferred === "mapbox") {
    const token = process.env.MAPBOX_ACCESS_TOKEN!;
    const retina = scale === 2 ? "@2x" : "";
    const url =
      `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
      `${lng},${lat},${zoom}/${sizePx}x${sizePx}${retina}` +
      `?access_token=${token}&attribution=false&logo=false`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        return {
          base64: Buffer.from(buf).toString("base64"),
          mimeType: "image/jpeg",
          source: "mapbox",
          imageryDate,
        };
      }
      console.warn(
        `[satellite-tile] Mapbox returned ${res.status} — falling back to Google`,
      );
    } catch (err) {
      console.warn("[satellite-tile] Mapbox fetch failed — falling back:", err);
    }
    // Fall through to Google
  }

  const gUrl =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=${zoom}&size=${sizePx}x${sizePx}` +
    `&scale=${scale}&maptype=satellite&key=${googleApiKey}`;
  try {
    const res = await fetch(gUrl, { cache: "no-store" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return {
      base64: Buffer.from(buf).toString("base64"),
      mimeType: "image/png",
      source: "google",
      imageryDate,
    };
  } catch (err) {
    console.error("[satellite-tile] Google fetch failed:", err);
    return null;
  }
}

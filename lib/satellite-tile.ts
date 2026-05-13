/**
 * Satellite tile fetcher with imagery-freshness aware source selection.
 *
 * Google Static Maps is the fallback — high US coverage, well-tested
 * across the pipeline. But its imagery for any given property can be
 * 5–12 years old (the `imageryDate` chip on screenshots regularly shows
 * 2014, 2015, 2017 dates), and a roof replaced after the imagery date
 * shows up wrong: the analysis runs on shingles that no longer exist.
 *
 * Policy (revised 2026-05-13): when `MAPBOX_ACCESS_TOKEN` is set, ALWAYS
 * prefer Mapbox Satellite (Vexcel / Maxar / NearMap imagery, 6-18 month
 * refresh cycles in most US regions). Mapbox failures fall back to
 * Google so the pipeline never stalls on a Mapbox outage.
 *
 * Prior policy gated Mapbox routing on Solar API's `imageryDate` being
 * >3 years stale — the assumption was that Solar's date tracks Static
 * Maps' tile age. It doesn't: Solar and Static Maps are separate Google
 * products with separate update cycles. Solar would report a 2024
 * `imageryDate` while Static Maps still served a 2018 tile for the
 * same lat/lng, so the gate failed-closed and we kept sending stale
 * imagery to SAM3 / vision for analysis. SAM3 then traced eaves that
 * no longer existed (or missed eaves that did) and the rep got a roof
 * outline mismatched to the current building.
 *
 * The simpler "Mapbox always when token present" rule eliminates that
 * failure mode at the cost of using Mapbox for some addresses where
 * Google would have been fine. That tradeoff is right: Mapbox-fresh
 * tile of an unchanged roof = correct trace; Google-stale tile of a
 * changed roof = wrong trace fed downstream into a $50k estimate.
 *
 * If `MAPBOX_ACCESS_TOKEN` isn't set, every call defaults to Google
 * Static Maps and the staleness problem persists. Set the token in
 * Vercel env to fix.
 */

import type { SolarSummary } from "@/types/estimate";
import { getCached } from "./cache";

// Note: STALE_YEARS constant removed — the prior Solar-date-gated
// routing policy no longer applies. The internal page has its own
// imagery-age penalty constant (`STALE_YEARS = 5`) for confidence
// scoring that's unrelated to this file.

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

function chooseSource(): "google" | "mapbox" {
  // Whenever a Mapbox token is configured, prefer Mapbox. See the file
  // header for the rationale on dropping the prior Solar-date gating.
  // No async work needed — the choice is now a pure env-var check.
  return process.env.MAPBOX_ACCESS_TOKEN ? "mapbox" : "google";
}

export async function fetchSatelliteImage(
  opts: FetchSatelliteOpts,
): Promise<SatelliteImage | null> {
  const { lat, lng, googleApiKey, sizePx = 640, zoom = 20, scale = 1 } = opts;
  // Solar's imageryDate is still surfaced on the returned tile metadata
  // so confidence scoring + the "Solar imagery YYYY-MM-DD" chip have
  // a value to read. The chip now correctly labels this as Solar's
  // dataset date (not the served tile's date) per the rename in
  // app/(internal)/page.tsx.
  const solar = await getCached<SolarSummary>("solar", lat, lng);
  const imageryDate = solar?.imageryDate ?? null;
  const preferred = chooseSource();

  if (preferred === "mapbox") {
    const token = process.env.MAPBOX_ACCESS_TOKEN!;
    const retina = scale === 2 ? "@2x" : "";
    const url =
      `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
      `${lng},${lat},${zoom}/${sizePx}x${sizePx}${retina}` +
      `?access_token=${token}&attribution=false&logo=false`;
    try {
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
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
    const res = await fetch(gUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
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

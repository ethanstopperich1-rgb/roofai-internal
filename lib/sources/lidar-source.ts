// lib/sources/lidar-source.ts
//
// Tier A — LiDAR + RANSAC measurement source. Calls the Python service
// at LIDAR_SERVICE_URL (deployed on Modal) and unpacks the response
// into a RoofData matching the unified schema.
//
// When LIDAR_SERVICE_URL is unset, returns null silently — the pipeline
// then falls through to Tier B/C. This keeps the build green on local
// dev + on Vercel deploys without Modal credentials.

import type { RoofData, RoofDiagnostics } from "@/types/roof";

interface LidarServiceResponse {
  roofData?: RoofData;
  lidarCaptureDate?: string | null;
  latencyMs?: number;
  freshness?: { flag: boolean; message: string; days_delta?: number | null };
  error?: string;
  message?: string;
}

/** Default 30s timeout — Modal warm-call typical ~15s, cold-start can run
 *  ~60s. The pipeline orchestrator catches AbortError and falls through. */
const DEFAULT_TIMEOUT_MS = 30_000;

export async function tierALidarSource(opts: {
  address: { formatted: string; lat: number; lng: number; zip?: string };
  requestId: string;
  /** Optional: Solar's imageryDate, forwarded so the freshness check
   *  can compare against the LiDAR capture date. */
  imageryDate?: string | null;
  /** Optional: Microsoft Buildings / Solar footprint polygon, forwarded
   *  so the Python isolator can mask points outside the building. */
  parcelPolygon?: Array<{ lat: number; lng: number }>;
}): Promise<RoofData | null> {
  const serviceUrl = process.env.LIDAR_SERVICE_URL;
  if (!serviceUrl) {
    // Unconfigured — silent skip. Pipeline falls through.
    return null;
  }

  const t0 = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        lat: opts.address.lat,
        lng: opts.address.lng,
        address: opts.address.formatted,
        imageryDate: opts.imageryDate ?? null,
        parcelPolygon: opts.parcelPolygon,
      }),
    });
  } catch (err) {
    console.warn("[tier-a-lidar] fetch failed:", err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    console.warn("[tier-a-lidar] non-ok response:", resp.status);
    return null;
  }

  let data: LidarServiceResponse;
  try {
    data = await resp.json() as LidarServiceResponse;
  } catch (err) {
    console.warn("[tier-a-lidar] response parse failed:", err);
    return null;
  }

  if (data.error || !data.roofData) {
    console.warn("[tier-a-lidar] service error:", data.error, data.message);
    return null;
  }

  const rd = data.roofData;
  // Service emits source: "none" when its pipeline degraded (no coverage,
  // segmentation failure, etc). Treat as no-result so the orchestrator
  // tries Tier C next.
  if (rd.source === "none") {
    console.log("[tier-a-lidar] degraded — falling through", {
      attempts: rd.diagnostics.attempts,
      warnings: rd.diagnostics.warnings,
    });
    return null;
  }

  // Compute cost telemetry — Modal billing is opaque, so use latency × CPU
  // factor (rough heuristic, 1 CPU / sec ≈ $0.0001 on Modal's free tier).
  const totalLatencyMs = Date.now() - t0;
  const estCostCents = Math.round((totalLatencyMs / 1000) * 0.01 * 100) / 100;
  console.log("[telemetry] tier_a_compute_cost", {
    address: opts.address.formatted,
    requestId: opts.requestId,
    latencyMs: totalLatencyMs,
    serviceLatencyMs: data.latencyMs ?? null,
    estCostCents,
    facets: rd.facets.length,
  });

  // Ensure the diagnostics attempts has at least the LiDAR success row
  // for downstream observability.
  const attempts: RoofDiagnostics["attempts"] = [
    ...(rd.diagnostics.attempts ?? []),
  ];
  rd.diagnostics = { ...rd.diagnostics, attempts };

  return rd;
}

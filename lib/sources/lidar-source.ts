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

/** Default 180s total timeout — Modal warm-call typical ~10-15s, but
 *  cold-start + region-growing segmentation on a 200k-point cloud can
 *  push end-to-end past 120s. Override via LIDAR_FETCH_TIMEOUT_MS for
 *  alternate hosts. Clamped to [5s, 300s] — Vercel's function timeout
 *  caps total wall time around 300s anyway.
 *  The pipeline orchestrator catches AbortError and falls through. */
function resolveTimeoutMs(): number {
  const raw = process.env.LIDAR_FETCH_TIMEOUT_MS;
  const fallback = 180_000;
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(300_000, Math.max(5_000, Math.round(n)));
}

let unconfiguredLogged = false;
function logUnconfiguredOnce() {
  if (unconfiguredLogged) return;
  unconfiguredLogged = true;
  console.log(
    "[tier-a-lidar] LIDAR_SERVICE_URL not set — Tier A skipped. " +
      "Deploy services/roof-lidar/ to Modal and set the URL to enable. " +
      "See services/roof-lidar/README.md.",
  );
}

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
    // Unconfigured — silent skip. Pipeline falls through to Tier C.
    // Log once-per-process so an obviously-unconfigured deploy is visible
    // in logs without spamming on every call.
    logUnconfiguredOnce();
    return null;
  }

  const t0 = Date.now();
  const payload = {
    lat: opts.address.lat,
    lng: opts.address.lng,
    address: opts.address.formatted,
    imageryDate: opts.imageryDate ?? null,
    parcelPolygon: opts.parcelPolygon,
  };

  // Modal HTTP gateway caps sync responses at 150s — a cold Tier A
  // call routinely needs 300-500s for the 360MB LAZ download. Use the
  // submit + poll pattern: POST /submit returns a call_id immediately,
  // GET /result?call_id=... is non-blocking.
  //
  // serviceUrl may be the legacy /extract-roof endpoint (sync) or the
  // new /submit endpoint. Detect by URL suffix.
  const isLegacyEndpoint = /\/extract-roof\/?(\?|$)/.test(serviceUrl);
  const submitUrl = isLegacyEndpoint
    ? serviceUrl.replace(/\/extract-roof\/?(\?.*)?$/, "/submit$1")
    : serviceUrl;
  const resultUrl = submitUrl.replace(/\/submit\/?(\?.*)?$/, "/result$1");

  const totalTimeoutMs = resolveTimeoutMs();
  const deadline = Date.now() + totalTimeoutMs;

  // Phase 1 — submit. Should return in <1s.
  let callId: string;
  try {
    const submitResp = await fetch(submitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!submitResp.ok) {
      console.warn("[tier-a-lidar] submit non-ok:", submitResp.status);
      return null;
    }
    const submitJson = await submitResp.json() as { call_id?: string };
    if (!submitJson.call_id) {
      console.warn("[tier-a-lidar] submit missing call_id");
      return null;
    }
    callId = submitJson.call_id;
  } catch (err) {
    console.warn("[tier-a-lidar] submit failed:", err);
    return null;
  }

  // Phase 2 — poll. Default 10s interval, capped at total timeout.
  let data: LidarServiceResponse | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    try {
      const pollResp = await fetch(
        `${resultUrl}?call_id=${encodeURIComponent(callId)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!pollResp.ok) {
        console.warn("[tier-a-lidar] poll non-ok:", pollResp.status);
        continue;
      }
      const pollJson = await pollResp.json() as {
        status: "pending" | "done" | "error";
        result?: LidarServiceResponse;
        error?: string;
      };
      if (pollJson.status === "pending") continue;
      if (pollJson.status === "error") {
        console.warn("[tier-a-lidar] service error:", pollJson.error);
        return null;
      }
      if (pollJson.status === "done" && pollJson.result) {
        data = pollJson.result;
        break;
      }
    } catch (err) {
      console.warn("[tier-a-lidar] poll error:", err);
      continue;
    }
  }
  if (!data) {
    console.warn("[tier-a-lidar] polling timed out after", totalTimeoutMs, "ms");
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

  // Default outlinePolygon to null when the Python service didn't emit
  // one (older modal_app.py versions). When the service IS modern, it
  // already supplies the alpha-shape boundary from the LiDAR plane
  // segmentation step.
  if (rd.outlinePolygon === undefined) {
    rd.outlinePolygon = null;
  }

  return rd;
}

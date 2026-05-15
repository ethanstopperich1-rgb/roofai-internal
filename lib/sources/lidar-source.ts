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
  // call routinely needs 300-500s. Use the submit + poll pattern.
  //
  // Modal's per-endpoint URL pattern is:
  //   https://<workspace>--<app-name>-<function-name>.modal.run[/path]
  // So `voxaris-roof-lidar` exposes 4 endpoints (submit/result/
  // extract-roof/health), each at its own host. We accept ANY of those
  // (or a path-suffixed variant like /submit on a shared host) and
  // rebuild canonical submit + result URLs from the host prefix.
  // This avoids the brittle silent failure when the env var is set
  // to the workspace base, /health, /result, /extract-roof, etc.
  let submitUrl: string;
  let resultUrl: string;
  try {
    const { submit, result } = normalizeModalUrls(serviceUrl);
    submitUrl = submit;
    resultUrl = result;
  } catch (err) {
    console.warn(
      "[tier-a-lidar] LIDAR_SERVICE_URL is malformed:",
      serviceUrl,
      err,
    );
    return null;
  }

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
      const body = await submitResp.text().catch(() => "");
      console.warn(
        "[tier-a-lidar] submit non-ok:",
        submitResp.status,
        "url:", submitUrl,
        "body:", body.slice(0, 400),
      );
      return null;
    }
    const submitJson = await submitResp.json() as { call_id?: string };
    if (!submitJson.call_id) {
      console.warn(
        "[tier-a-lidar] submit response missing call_id — likely wrong URL.",
        "url:", submitUrl,
        "response:", submitJson,
      );
      return null;
    }
    callId = submitJson.call_id;
  } catch (err) {
    console.warn(
      "[tier-a-lidar] submit failed — check LIDAR_SERVICE_URL is reachable.",
      "url:", submitUrl,
      "err:", err,
    );
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
        // 405 / 404 / 401 / 403 are permanent — no point polling for
        // 5 minutes. Bail immediately with a clear diagnostic.
        // This is exactly the "GET / → 405 every 10s" bug we fixed
        // upstream via normalizeModalUrls; the early-bail here makes
        // sure any future URL mismatch fails fast instead of hanging.
        if ([401, 403, 404, 405].includes(pollResp.status)) {
          const body = await pollResp.text().catch(() => "");
          console.warn(
            "[tier-a-lidar] poll got permanent error — wrong result URL?",
            "status:", pollResp.status,
            "url:", resultUrl,
            "body:", body.slice(0, 400),
          );
          return null;
        }
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

// ---- Modal URL normalization ------------------------------------------------

// Modal exposes each @fastapi_endpoint at its own subdomain, NOT at a path:
//   https://<workspace>--<app-name>-<function-name>.modal.run
// Both <workspace> and <app-name> can contain hyphens
// (e.g. ethanstopperich1-rgb / voxaris-roof-lidar). The ONLY reliable
// separator between them is `--`. After the `--`, the trailing token
// after the final `-` is the function name (submit / result / health /
// extract-roof — extract-roof itself contains a hyphen, so it's handled
// as a special case via alternation in the trailing capture group).
const MODAL_HOST_RE =
  /^(.+?)--(.+)-(submit|result|health|extract-roof)$/;

/** Parse a Modal-style URL and return canonical submit / result / health
 *  URLs. Modal uses subdomain-per-function, not path-per-function — this
 *  is the exact gotcha that caused the original "GET / → 405 every 10s
 *  for 5 minutes" bug: regex-transforming `/submit` → `/result` is a
 *  no-op when the function name is in the hostname.
 *
 *  Accepts any of the four Modal subdomains:
 *    - https://ws--voxaris-roof-lidar-submit.modal.run
 *    - https://ws--voxaris-roof-lidar-result.modal.run
 *    - https://ws--voxaris-roof-lidar-extract-roof.modal.run
 *    - https://ws--voxaris-roof-lidar-health.modal.run
 *  Plus generic hosts (Fly / Railway / localhost) where the same
 *  FastAPI app serves all four functions at paths.
 *
 *  When LIDAR_SUBMIT_URL / LIDAR_RESULT_URL / LIDAR_HEALTH_URL are set
 *  in the environment, those values win unconditionally — this is the
 *  escape hatch for any future host where this regex doesn't fit.
 *
 *  Throws if `serviceUrl` itself isn't a valid URL. */
export function normalizeModalUrls(serviceUrl: string): {
  submit: string;
  result: string;
  health: string;
  /** True when we recognized the Modal per-endpoint host convention. */
  isModal: boolean;
} {
  const u = new URL(serviceUrl);
  const host = u.hostname;
  const isModal = host.endsWith(".modal.run");

  // Compute the "natural" submit/result/health URLs from the input shape.
  let submit: string;
  let result: string;
  let health: string;

  if (isModal) {
    const hostBase = host.replace(/\.modal\.run$/, "");
    const m = hostBase.match(MODAL_HOST_RE);
    if (m) {
      const [, workspace, appName] = m;
      const make = (fn: string) =>
        `${u.protocol}//${workspace}--${appName}-${fn}.modal.run`;
      submit = make("submit");
      result = make("result");
      health = make("health");
    } else {
      // Hostname is *.modal.run but didn't match our pattern. Treat the
      // origin as the all-paths host (works if the user reverse-proxies
      // their Modal app behind their own modal.run subdomain).
      const base = u.origin;
      submit = `${base}/submit`;
      result = `${base}/result`;
      health = `${base}/health`;
    }
  } else {
    // Generic host (Fly, Railway, localhost). Strip any trailing
    // function path and append /submit /result /health.
    const stripped = u.origin + u.pathname.replace(
      /\/(submit|result|extract-roof|health)\/?$/,
      "",
    );
    const base = stripped.replace(/\/$/, "");
    submit = `${base}/submit`;
    result = `${base}/result`;
    health = `${base}/health`;
  }

  // Env-var escape hatches — let an operator override any of the three
  // URLs without changing code. Useful for: a Modal deploy that doesn't
  // match our regex, a partial migration to a different host, or
  // testing with a mock server.
  if (process.env.LIDAR_SUBMIT_URL) submit = process.env.LIDAR_SUBMIT_URL;
  if (process.env.LIDAR_RESULT_URL) result = process.env.LIDAR_RESULT_URL;
  if (process.env.LIDAR_HEALTH_URL) health = process.env.LIDAR_HEALTH_URL;

  return { submit, result, health, isModal };
}

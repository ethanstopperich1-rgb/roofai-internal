import { NextResponse } from "next/server";
import { normalizeModalUrls } from "@/lib/sources/lidar-source";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/lidar-health
 *
 * Probes the Tier A Modal service at LIDAR_SERVICE_URL. Used by the rep
 * tool to render a green/red indicator so the partner knows whether
 * Tier A is actually reachable before running an estimate — without
 * this, a misconfigured URL looks identical to "Tier A coverage gap"
 * because both fall through silently to Tier C.
 *
 * Returns:
 *   200 { state: "configured", health: {...} }   — env set, /health responds 200
 *   200 { state: "unreachable", ... }            — env set, /health failed (with reason)
 *   200 { state: "unconfigured" }                — LIDAR_SERVICE_URL not set
 *   200 { state: "malformed", url, error }       — env set but unparseable
 *
 * Always 200 so the rep UI's status chip can render the diagnostic.
 */
export async function GET() {
  const raw = process.env.LIDAR_SERVICE_URL;
  if (!raw) {
    return NextResponse.json(
      { state: "unconfigured" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  let urls: ReturnType<typeof normalizeModalUrls>;
  try {
    urls = normalizeModalUrls(raw);
  } catch (err) {
    return NextResponse.json(
      {
        state: "malformed",
        url: raw,
        error: err instanceof Error ? err.message : String(err),
        hint:
          "Expected a URL like https://<workspace>--voxaris-roof-lidar-submit.modal.run " +
          "or https://localhost:8000",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const t0 = Date.now();
  try {
    const res = await fetch(urls.health, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json(
        {
          state: "unreachable",
          healthUrl: urls.health,
          submitUrl: urls.submit,
          resultUrl: urls.result,
          isModal: urls.isModal,
          status: res.status,
          latencyMs,
          body: body.slice(0, 400),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const json = await res.json().catch(() => ({}));
    return NextResponse.json(
      {
        state: "configured",
        healthUrl: urls.health,
        submitUrl: urls.submit,
        resultUrl: urls.result,
        isModal: urls.isModal,
        latencyMs,
        service: json,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        state: "unreachable",
        healthUrl: urls.health,
        submitUrl: urls.submit,
        resultUrl: urls.result,
        isModal: urls.isModal,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
        hint:
          "Check that the Modal app is deployed (run `modal deploy modal_app.py` " +
          "from services/roof-lidar/), and that LIDAR_SERVICE_URL points at " +
          "one of its endpoint hostnames.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}

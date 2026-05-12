import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 75;

/**
 * GET /api/cron/warm-sam3
 *
 * Keep the Roboflow SAM3 workflow warm so the first customer-facing
 * estimate doesn't eat a 30-60s cold start.
 *
 * Triggered by Vercel Cron every 5 minutes (see vercel.json). Sends a
 * minimal request to the SAM3 workflow endpoint — a 1×1 black PNG with
 * an obviously-invalid prompt — which won't return a polygon but WILL
 * exercise the serverless container so subsequent real calls hit a
 * warm worker.
 *
 * Authorization: Vercel injects `Authorization: Bearer ${CRON_SECRET}`
 * on cron triggers when the env var is set. We accept either that or
 * Vercel's signed `x-vercel-cron-signature` header.
 */

// 1×1 transparent PNG, base64-encoded. Smallest possible payload that
// the workflow accepts as a valid image input.
const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";

function authorized(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // No CRON_SECRET configured — only allow Vercel-signed cron
    // invocations (the platform sets this header automatically when
    // it triggers the route, and external callers can't forge it).
    return req.headers.has("x-vercel-cron-signature");
  }
  const got = req.headers.get("authorization");
  return got === `Bearer ${expected}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      status: "skipped",
      reason: "ROBOFLOW_API_KEY not configured",
    });
  }
  const url =
    process.env.ROBOFLOW_SAM3_WORKFLOW_URL ??
    "https://serverless.roboflow.com/infer/workflows/bradens-workspace/sam3-roof-segmentation-test-1778124556737";

  const t0 = Date.now();
  let status = 0;
  let ok = false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        api_key: apiKey,
        inputs: {
          image: { type: "base64", value: PIXEL_PNG_BASE64 },
          prompt: "warmup",
          pixels_per_unit: 1,
          confidence: 0.99,
        },
      }),
      // 60s ceiling — a cold start can take 30-60s; we want to ride
      // through that as part of the warmup, not give up at 8s.
      signal: AbortSignal.timeout(60_000),
    });
    status = res.status;
    ok = res.ok || res.status === 400; // 400 is fine — model rebuffed the 1px input but the container is warm
    // Drain the body so the Roboflow side doesn't waste capacity on a
    // half-read response.
    await res.text().catch(() => "");
  } catch (err) {
    return NextResponse.json({
      status: "fail",
      latencyMs: Date.now() - t0,
      reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
  }

  return NextResponse.json({
    status: ok ? "warm" : "cold-or-error",
    httpStatus: status,
    latencyMs: Date.now() - t0,
  });
}

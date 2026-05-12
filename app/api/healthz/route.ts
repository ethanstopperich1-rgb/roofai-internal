import { NextResponse } from "next/server";
import { supabaseConfigured, createServiceRoleClient, supabaseServiceRoleConfigured } from "@/lib/supabase";
import { SAM3_WORKFLOW_URL } from "@/lib/roboflow-workflow-config";

export const runtime = "nodejs";
// Tight enough that a hung dependency is obvious; long enough that
// a real cold start (Roboflow ~30s, Supabase ~3s on EU regions) still
// returns a green check.
export const maxDuration = 30;

/**
 * GET /api/healthz
 *
 * Per-dependency health probe. Used by:
 *   - Vercel deployment protection (pre-traffic check)
 *   - External uptime monitor (BetterUptime / Cronitor / Vercel
 *     observability)
 *   - On-call rep pinging "is the tool broken" before opening Slack
 *
 * Returns 200 when EVERY required dependency reports ok. Returns 503
 * with the same shape when any required dep fails, so a status-page
 * widget can show per-component breakdown.
 *
 * Optional deps (Sentry, Twilio, Replicate, Anthropic insights) don't
 * gate the 200 — they're reported with their own status so we can
 * tell what's degraded without taking the whole tool down.
 *
 * No authentication — the route reveals only env-var presence + ping
 * latency to public services. Nothing leakable beyond "this Vercel
 * deployment has X configured."
 */

type Status = "ok" | "fail" | "skipped" | "missing_config";

interface CheckResult {
  status: Status;
  /** Latency in ms when status is "ok" — useful for spotting slow deps */
  latencyMs?: number;
  /** Short reason on non-ok status. Never includes secrets. */
  reason?: string;
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; ms: number }> {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

/** Wraps a check with a hard timeout so a single slow dep can't make
 *  the whole healthz route time-out. */
async function withTimeout<T>(
  ms: number,
  fn: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Supabase: round-trip via a 1-row count query against the offices
 *  table (always seeded). Uses the service-role client so RLS doesn't
 *  reject the unauthenticated probe. */
async function checkSupabase(): Promise<CheckResult> {
  if (!supabaseConfigured()) {
    return { status: "missing_config", reason: "NEXT_PUBLIC_SUPABASE_URL/ANON_KEY unset" };
  }
  if (!supabaseServiceRoleConfigured()) {
    return { status: "missing_config", reason: "SUPABASE_SERVICE_ROLE_KEY unset" };
  }
  try {
    const { ms } = await timed(async () => {
      const sb = createServiceRoleClient();
      // Wrap the PostgrestFilterBuilder in an async arrow so withTimeout
      // sees a real Promise<{data, error}> rather than the builder type
      // (which is thenable but not strictly Promise-typed).
      const { error } = await withTimeout(5000, async () =>
        sb.from("offices").select("id", { count: "exact", head: true }).limit(1),
      );
      if (error) throw new Error(error.message);
    });
    return { status: "ok", latencyMs: ms };
  } catch (err) {
    return { status: "fail", reason: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

/** Google Maps key presence. We don't ping Google here — every probe
 *  would burn $0.005 against the Geocoding quota with no signal we
 *  couldn't get from env-presence + the first real request. */
function checkGoogleMaps(): CheckResult {
  const key = process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!key) return { status: "missing_config", reason: "GOOGLE_SERVER_KEY / NEXT_PUBLIC_GOOGLE_MAPS_KEY unset" };
  return { status: "ok" };
}

/** Roboflow: HEAD the workflow URL to confirm the workspace + workflow
 *  combo resolves. 200 / 405 / any-4xx-other-than-404 = configured;
 *  404 = wrong workflow URL (this was the actual demo bug).
 *  No body sent so we don't consume an inference. */
async function checkRoboflow(): Promise<CheckResult> {
  if (!process.env.ROBOFLOW_API_KEY) {
    return { status: "missing_config", reason: "ROBOFLOW_API_KEY unset" };
  }
  // Imported from lib/roboflow-workflow-config so the URL stays in sync
  // with app/api/sam3-roof/route.ts (single source of truth).
  const url = SAM3_WORKFLOW_URL;
  try {
    const { result, ms } = await timed(async () => {
      // GET is the only verb the workflow endpoint accepts for probe-
      // ability; sending an empty POST would 400 ambiguously. We send
      // GET expecting 405 (method not allowed) — that confirms the URL
      // resolves AND the workspace/workflow combo is real.
      const res = await withTimeout(5000, () =>
        fetch(url, { method: "GET", cache: "no-store" }),
      );
      return res.status;
    });
    if (result === 404) {
      return { status: "fail", reason: `workflow URL 404 — check workspace/workflow ID (got ${result})` };
    }
    // Any 200/4xx-not-404/5xx-other-than-down means the endpoint is alive.
    return { status: "ok", latencyMs: ms };
  } catch (err) {
    return { status: "fail", reason: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

/** Anthropic + Gemini: presence-only. Avoiding a real probe per call
 *  because token cost (~$0.001) × monitor frequency adds up, and a
 *  liveness check tells us nothing the next real request wouldn't. */
function checkAnthropic(): CheckResult {
  return process.env.ANTHROPIC_API_KEY
    ? { status: "ok" }
    : { status: "missing_config", reason: "ANTHROPIC_API_KEY unset" };
}

function checkGemini(): CheckResult {
  return process.env.GEMINI_API_KEY
    ? { status: "ok" }
    : { status: "missing_config", reason: "GEMINI_API_KEY unset" };
}

/** Upstash Redis: env presence. Used by lib/ratelimit.ts — when this
 *  is missing the rate limiter fails OPEN (per existing comment), so
 *  surface it as a real fail in healthz rather than a warning. */
function checkUpstashRedis(): CheckResult {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      status: "missing_config",
      reason: "UPSTASH_REDIS_REST_URL/TOKEN unset — rate limiting fails OPEN without these",
    };
  }
  return { status: "ok" };
}

/** Optional integrations — reported but don't gate 200. */
function checkOptional(envVar: string, label: string): CheckResult {
  return process.env[envVar]
    ? { status: "ok" }
    : { status: "skipped", reason: `${label} not configured` };
}

/** When HEALTHZ_TOKEN is set, the full per-component breakdown is only
 *  returned to callers that supply ?token=<value> (or the X-Healthz-Token
 *  header). Unauthed callers get a slim {status, timestamp} response.
 *
 *  Why: the full breakdown reveals our complete integration topology
 *  (Roboflow workflow, Anthropic config, Sentry/Twilio/Replicate
 *  presence). Useful for an attacker building a dependency map. The
 *  slim response is enough for a load-balancer / Vercel deployment
 *  protection probe; uptime monitors (BetterUptime, Cronitor) easily
 *  add the header.
 *
 *  Backward-compatible: when HEALTHZ_TOKEN is unset, every caller sees
 *  the full breakdown (matches the existing behavior). Set the env var
 *  in production to enable the gate without redeploying code. */
function authenticatesAsOperator(req: Request): boolean {
  const expected = process.env.HEALTHZ_TOKEN;
  if (!expected) return true; // backward-compat — no gate when unset
  const url = new URL(req.url);
  const given =
    url.searchParams.get("token") ?? req.headers.get("x-healthz-token") ?? "";
  if (!given || given.length !== expected.length) return false;
  // Constant-time compare via XOR accumulator.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function GET(req: Request) {
  // Required deps — if any of these is missing or broken, the tool
  // cannot deliver an estimate, so the route returns 503.
  const [supabase, roboflow] = await Promise.all([checkSupabase(), checkRoboflow()]);
  const required = {
    supabase,
    roboflow,
    google: checkGoogleMaps(),
    anthropic: checkAnthropic(),
    upstash: checkUpstashRedis(),
  };

  // Optional deps — degraded but not down.
  const optional = {
    gemini: checkGemini(),
    replicate: checkOptional("REPLICATE_API_TOKEN", "Replicate (sam-refine fallback)"),
    twilio: checkOptional("TWILIO_AUTH_TOKEN", "Twilio SMS"),
    sentry: checkOptional("NEXT_PUBLIC_SENTRY_DSN", "Sentry"),
    mapbox: checkOptional("MAPBOX_ACCESS_TOKEN", "Mapbox (stale-imagery fallback)"),
  };

  const allRequiredOk = Object.values(required).every((c) => c.status === "ok");

  // Slim public response when the token gate is active and the caller
  // didn't authenticate. Loadbalancers + Vercel deployment protection
  // only need the up/down signal; the full breakdown is for operators.
  if (!authenticatesAsOperator(req)) {
    return NextResponse.json(
      {
        status: allRequiredOk ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
      },
      {
        status: allRequiredOk ? 200 : 503,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  }

  const body = {
    status: allRequiredOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    region: process.env.VERCEL_REGION ?? "unknown",
    required,
    optional,
  };

  return NextResponse.json(body, {
    status: allRequiredOk ? 200 : 503,
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

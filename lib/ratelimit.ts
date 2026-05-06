/**
 * Rate-limit helper for /api/* routes. Backed by Upstash Ratelimit on
 * the same Redis we use for the cache layer (lib/cache.ts). Falls back
 * to a no-op limiter when Redis env vars aren't set so dev / preview
 * deploys without Redis still work — this is a defense-in-depth control,
 * not a hard auth boundary, and we don't want missing env vars to break
 * the app.
 *
 * Three pre-defined buckets:
 *   - `expensive`  : 10 req/min — for routes that hit Anthropic /
 *                    Replicate / Roboflow (each call costs real $$).
 *                    Burns Anthropic credits at ~$0.05-0.15/call.
 *   - `standard`   : 60 req/min — for routes that hit Google Solar /
 *                    Maps / BigQuery / OSM. Quota'd or cheap, but still
 *                    worth shielding.
 *   - `public`     : 5 req/min  — for the unauthenticated /api/leads
 *                    endpoint. Spam protection.
 *
 * Identifier strategy: prefer Vercel's `x-real-ip` / `x-forwarded-for`,
 * fall back to a constant so even hostile clients without IP headers
 * can't fully escape the bucket.
 *
 * Usage:
 *   ```ts
 *   import { rateLimit } from "@/lib/ratelimit";
 *   const limited = await rateLimit(req, "expensive");
 *   if (limited) return limited;
 *   ```
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";

type Bucket = "expensive" | "standard" | "public";

const BUCKET_LIMITS: Record<Bucket, { tokens: number; window: `${number} ${"s" | "m"}` }> = {
  expensive: { tokens: 10, window: "1 m" },
  standard: { tokens: 60, window: "1 m" },
  public: { tokens: 5, window: "1 m" },
};

let cachedLimiters: Partial<Record<Bucket, Ratelimit>> | null = null;
let probedRedis: boolean = false;

function getLimiter(bucket: Bucket): Ratelimit | null {
  if (!cachedLimiters) cachedLimiters = {};
  if (cachedLimiters[bucket]) return cachedLimiters[bucket]!;

  if (!probedRedis) {
    probedRedis = true;
    const url =
      process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
    const token =
      process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
    if (!url || !token) return null;
  }

  try {
    const url =
      process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
    const token =
      process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
    if (!url || !token) return null;
    const redis = new Redis({ url, token });
    const cfg = BUCKET_LIMITS[bucket];
    const limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(cfg.tokens, cfg.window),
      prefix: `pitch-rl:${bucket}`,
      analytics: false,
    });
    cachedLimiters[bucket] = limiter;
    return limiter;
  } catch (err) {
    console.warn(`[ratelimit] init failed for ${bucket}:`, err);
    return null;
  }
}

function clientIdentifier(req: Request): string {
  const headers = req.headers;
  const real = headers.get("x-real-ip");
  if (real) return real;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  // Last resort: bucket-everyone-as-one. Means a single IP-less attacker
  // can saturate, but at least there's still a cap.
  return "unknown";
}

/**
 * Returns `null` when the request should proceed, or a 429 NextResponse
 * when the request should be rejected. Pattern matches Next route
 * handlers — `if (limited) return limited;`.
 */
export async function rateLimit(
  req: Request,
  bucket: Bucket = "standard",
): Promise<NextResponse | null> {
  const limiter = getLimiter(bucket);
  if (!limiter) return null; // No Redis → fail open (dev / preview)

  const id = clientIdentifier(req);
  try {
    const { success, limit, remaining, reset } = await limiter.limit(id);
    if (success) return null;
    return NextResponse.json(
      {
        error: "Too many requests. Slow down a moment.",
        bucket,
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": String(remaining),
          "X-RateLimit-Reset": String(reset),
          "Retry-After": String(Math.max(1, Math.ceil((reset - Date.now()) / 1000))),
        },
      },
    );
  } catch (err) {
    // Redis hiccup — fail open. We'd rather serve a request than 503 on
    // a transient Upstash outage.
    console.warn(`[ratelimit] limiter.limit threw for ${bucket}:`, err);
    return null;
  }
}

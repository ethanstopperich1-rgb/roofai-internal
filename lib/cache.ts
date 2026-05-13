/**
 * Cache layer for analysis results, keyed by scope + lat/lng.
 *
 * Two-tier:
 *   1. In-memory Map (fast, scoped to a single warm Function instance)
 *   2. Upstash Redis (persistent across cold starts, shared across instances)
 *
 * Routes hit `getCached` first → if Redis returns a value, populate the
 * in-memory cache too so subsequent calls in the same warm instance are
 * sync-fast. `setCached` writes to both layers.
 *
 * Without Redis env vars, falls back to in-memory only — keeps dev working.
 *
 * Env vars (any of these enables Redis):
 *   - KV_REST_API_URL + KV_REST_API_TOKEN          (legacy Vercel-KV-compatible)
 *   - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *
 * Wire-up: enable Upstash Redis via Vercel Marketplace (Storage tab →
 * Connect Database → Upstash Redis). It auto-injects the env vars on
 * every deploy.
 */

import { Redis } from "@upstash/redis";

type Entry<T> = { value: T; expiresAt: number };

const STORE = new Map<string, Entry<unknown>>();
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

/** Suggested TTLs for callers that benefit from longer caches than the
 *  6h default. These are policy, not enforcement — `setCached` accepts
 *  any positive value and the caller picks what makes sense for their
 *  data freshness needs. */
export const CACHE_TTL = {
  /** 6h — the default for analysis results that may rev with model
   *  changes or for data that updates within a day or two. */
  default: 60 * 60 * 6,
  /** 24h — for negative cache entries from data sources where new
   *  data can fill in gaps (e.g. OSM building footprints — a previously
   *  untagged address can get an addr:housenumber added at any time).
   *  Long enough to amortize within a day's traffic, short enough to
   *  recover from coverage improvements within ~1 sleep cycle. */
  daily: 60 * 60 * 24,
  /** 7 days — for sentinels marking "this external service has no
   *  coverage for this lat/lng" (e.g. Solar findClosest 404). New
   *  coverage gets added slowly and we'd rather re-check weekly than
   *  pay an 8s timeout every request. */
  weekly: 60 * 60 * 24 * 7,
  /** 30 days — for results from data sources that rarely change
   *  (OSM building footprints, parcel boundaries). The TTL is the
   *  upper bound on staleness; the data is virtually always still
   *  correct after 30 days. */
  monthly: 60 * 60 * 24 * 30,
} as const;

let redisClient: Redis | null | undefined; // undefined = not yet probed

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
  if (!url || !token) {
    redisClient = null;
    return null;
  }
  try {
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch (err) {
    console.warn("[cache] Upstash Redis init failed:", err);
    redisClient = null;
    return null;
  }
}

function key(scope: string, lat: number, lng: number) {
  return `pitch:${scope}:${lat.toFixed(5)},${lng.toFixed(5)}`;
}

export async function getCached<T>(
  scope: string,
  lat: number,
  lng: number,
): Promise<T | null> {
  const k = key(scope, lat, lng);
  // Fast path: in-memory
  const hit = STORE.get(k);
  if (hit) {
    if (Date.now() > hit.expiresAt) {
      STORE.delete(k);
    } else {
      return hit.value as T;
    }
  }
  // Slow path: Redis
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = (await redis.get(k)) as T | null;
    if (value != null) {
      // Populate in-memory layer so the next call in this warm instance
      // is fast. We don't know the Redis-side TTL here, so use the
      // default — worst case the in-memory entry expires before the
      // Redis one and the next call repopulates from Redis (still cheap).
      STORE.set(k, { value, expiresAt: Date.now() + DEFAULT_TTL_MS });
    }
    return value;
  } catch (err) {
    console.warn(`[cache] redis.get failed for ${k}:`, err);
    return null;
  }
}

export async function setCached<T>(
  scope: string,
  lat: number,
  lng: number,
  value: T,
  /** Optional per-call TTL in seconds. Defaults to 6h. Use values
   *  from `CACHE_TTL` (weekly / monthly) for data sources that change
   *  rarely, such as OSM footprints or coverage-gap sentinels. */
  ttlSeconds?: number,
): Promise<void> {
  const ttlMs = ttlSeconds != null ? ttlSeconds * 1000 : DEFAULT_TTL_MS;
  const k = key(scope, lat, lng);
  STORE.set(k, { value, expiresAt: Date.now() + ttlMs });
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(k, value as unknown, {
      ex: ttlSeconds ?? 60 * 60 * 6,
    });
  } catch (err) {
    console.warn(`[cache] redis.set failed for ${k}:`, err);
  }
}

/** Whether persistent caching is active. UI / health endpoints can surface this. */
export function isPersistentCacheActive(): boolean {
  return getRedis() !== null;
}

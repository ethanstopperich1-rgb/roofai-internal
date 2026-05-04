/**
 * Best-effort in-memory cache for analysis results, keyed by lat/lng.
 * Serverless functions don't share memory across invocations — this only
 * helps within a single warm Function instance.
 *
 * TODO (Phase 2): swap for Vercel KV / Upstash for persistent caching.
 */

type Entry<T> = { value: T; expiresAt: number };

const STORE = new Map<string, Entry<unknown>>();
const TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function key(scope: string, lat: number, lng: number) {
  return `${scope}:${lat.toFixed(5)},${lng.toFixed(5)}`;
}

export function getCached<T>(scope: string, lat: number, lng: number): T | null {
  const k = key(scope, lat, lng);
  const hit = STORE.get(k);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    STORE.delete(k);
    return null;
  }
  return hit.value as T;
}

export function setCached<T>(scope: string, lat: number, lng: number, value: T): void {
  STORE.set(key(scope, lat, lng), { value, expiresAt: Date.now() + TTL_MS });
}

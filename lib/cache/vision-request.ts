import type { RoofVision } from "@/types/estimate";

const inflight = new Map<string, Promise<RoofVision | null>>();

/**
 * Request-scoped memoizer for /api/vision. Both Tier C sources need
 * vision data; this guarantees the call fires at most once per
 * runRoofPipeline invocation (keyed by requestId).
 *
 * Vision failures resolve to null, not rejections — solar-source and
 * vision-source both treat null as "empty objects + no material",
 * not as a source failure (per spec §3.4).
 */
export async function getMemoizedVision(opts: {
  lat: number;
  lng: number;
  requestId: string;
  fetcher: (lat: number, lng: number) => Promise<RoofVision | null>;
}): Promise<RoofVision | null> {
  const key = `${opts.requestId}:${opts.lat.toFixed(6)},${opts.lng.toFixed(6)}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await opts.fetcher(opts.lat, opts.lng);
    } catch (err) {
      console.warn("[vision-request] fetcher errored, returning null:", err);
      return null;
    } finally {
      setTimeout(() => inflight.delete(key), 5000);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

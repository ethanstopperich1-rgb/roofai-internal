import type { RoofVision } from "@/types/estimate";

export type VisionFetcher = (lat: number, lng: number) => Promise<RoofVision | null>;

// Holds both in-flight promises and recently-resolved entries during
// the 5s post-settlement cleanup window (so a second caller arriving
// just after resolution still gets the memoized result).
const memoByKey = new Map<string, Promise<RoofVision | null>>();

/**
 * Request-scoped memoizer for /api/vision. Both Tier C sources need
 * vision data; this guarantees the call fires at most once per
 * runRoofPipeline invocation when the second caller arrives within ~5s
 * of the first one resolving (the entry's cleanup window). In practice
 * runRoofPipeline's sources fan out within milliseconds, so this is
 * always the case; the 5s window is documented here so callers know
 * the contract isn't "forever."
 *
 * Vision failures resolve to null, not rejections — solar-source and
 * vision-source both treat null as "empty objects + no material",
 * not as a source failure (per spec §3.4).
 */
export async function getMemoizedVision(opts: {
  lat: number;
  lng: number;
  requestId: string;
  fetcher: VisionFetcher;
}): Promise<RoofVision | null> {
  const key = `${opts.requestId}:${opts.lat.toFixed(6)},${opts.lng.toFixed(6)}`;
  const existing = memoByKey.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      return await opts.fetcher(opts.lat, opts.lng);
    } catch (err) {
      console.warn(`[vision-request] ${opts.requestId} fetcher errored, returning null:`, err);
      return null;
    } finally {
      setTimeout(() => memoByKey.delete(key), 5000);
    }
  })();
  memoByKey.set(key, promise);
  return promise;
}

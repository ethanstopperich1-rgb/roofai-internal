/**
 * `fetchWithTimeout` — drop-in `fetch` replacement that adds a hard
 * AbortSignal-backed timeout. Without this, a hung upstream (Roboflow /
 * Replicate / Anthropic / OSM Overpass / Google Solar) can pin a Vercel
 * function instance for the full 300s function timeout, blocking
 * unrelated requests on the same Fluid Compute instance.
 *
 * Defaults:
 *   - 15s timeout, suitable for Solar / Maps / Roboflow / OSM.
 *   - For long ML calls (Replicate, Claude vision with 5 images) override
 *     with `timeoutMs: 60_000` or so.
 *
 * Returns the same `Response` shape as `fetch` so callers don't need to
 * change anything else. AbortError surfaces through normal try/catch.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  const userSignal = rest.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // If the caller already passed a signal, compose them so either source
  // can abort the request.
  const signal = userSignal
    ? AbortSignal.any([userSignal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...rest, signal });
}

/**
 * Validate a (lat, lng) pair from URL search params.
 * Returns { lat, lng } when both are finite numbers in valid ranges, else null.
 */
export function parseLatLng(
  params: URLSearchParams,
): { lat: number; lng: number } | null {
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

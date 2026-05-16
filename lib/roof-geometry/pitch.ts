/**
 * Pitch conversion + bucketing.
 *
 * Industry standard pitch notation in residential roofing is "X/12":
 * the roof rises X inches for every 12 inches of horizontal run.
 * Convert: degrees = atan(rise / 12), rise = 12 × tan(degrees).
 *
 * Slope multiplier (already in polygons.ts) is 1 / cos(degrees) —
 * surface area = footprint × slope.
 */

export type PitchOnTwelve = "1/12" | "2/12" | "3/12" | "4/12" | "5/12" | "6/12" | "7/12" | "8/12" | "9/12" | "10/12" | "11/12" | "12/12" | "12/12+";

export function degreesToRise(deg: number): number {
  if (!Number.isFinite(deg) || deg <= 0) return 0;
  if (deg >= 90) return Infinity;
  return Math.tan((deg * Math.PI) / 180) * 12;
}

export function riseToDegrees(rise: number): number {
  if (!Number.isFinite(rise) || rise <= 0) return 0;
  return (Math.atan(rise / 12) * 180) / Math.PI;
}

/** Snap pitch to the nearest industry-standard X/12 bucket. */
export function degreesToOnTwelve(deg: number | null | undefined): PitchOnTwelve | null {
  if (deg == null || !Number.isFinite(deg) || deg < 0) return null;
  const rise = Math.round(degreesToRise(deg));
  if (rise <= 0) return "1/12";
  if (rise > 12) return "12/12+";
  return `${rise}/12` as PitchOnTwelve;
}

/**
 * Group facets by pitch bucket. Used in the customer-facing detail
 * table — "1,800 sqft @ 5/12 + 800 sqft @ 7/12" beats "average 5.8/12".
 */
export function bucketByPitch<T extends { pitchDegrees: number }>(
  facets: T[],
): Map<PitchOnTwelve | "unknown", T[]> {
  const buckets = new Map<PitchOnTwelve | "unknown", T[]>();
  for (const f of facets) {
    const bucket = degreesToOnTwelve(f.pitchDegrees) ?? "unknown";
    const arr = buckets.get(bucket) ?? [];
    arr.push(f);
    buckets.set(bucket, arr);
  }
  return buckets;
}

/**
 * Predominant pitch bucket weighted by sloped area. Matches EagleView's
 * "Predominant Pitch" field semantics.
 */
export function predominantPitchOnTwelve<
  T extends { pitchDegrees: number; areaSqftSloped: number },
>(facets: T[]): PitchOnTwelve | null {
  if (facets.length === 0) return null;
  const totals = new Map<PitchOnTwelve, number>();
  for (const f of facets) {
    const k = degreesToOnTwelve(f.pitchDegrees);
    if (!k) continue;
    totals.set(k, (totals.get(k) ?? 0) + f.areaSqftSloped);
  }
  let best: PitchOnTwelve | null = null;
  let bestArea = -1;
  totals.forEach((area, k) => {
    if (area > bestArea) {
      best = k;
      bestArea = area;
    }
  });
  return best;
}

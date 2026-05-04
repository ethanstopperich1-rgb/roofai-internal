/**
 * Imagery × Storm Correlation
 *
 * The vision pipeline reads a single satellite tile (Solar API "findClosest").
 * That tile has a fixed `imageryDate` — typically 6-30 months stale. If a
 * major storm hit AFTER the imagery was captured, any damage from that
 * storm physically exists on the roof but DOESN'T appear in the tile we
 * analyzed. Vision will report "no damage" while the roof is actually
 * tarped.
 *
 * Catching this is the single most claim-critical signal we can produce
 * without paying for fresh imagery. It tells the rep:
 *   "Pitch's analysis underweights damage — the imagery predates this
 *   storm event. Document on-site to capture the full claim."
 *
 * It also tells the adjuster:
 *   "The contractor's estimate is reliable for pre-storm baseline; for
 *   post-storm damage, see the field photos."
 *
 * Logic:
 *   - imageryDate from Solar API (string YYYY-MM-DD or null)
 *   - storm events from /api/storms (we already pull these)
 *   - bucket each storm: BEFORE / DURING / AFTER imagery
 *   - flag the most-significant AFTER event (largest hail, then most-recent)
 */

export type StormBucket = "before" | "during" | "after";

export interface StormEventInput {
  type: string; // "Hail" / "Tornado" / "Thunderstorm Wind" / etc.
  date: string | null; // ISO date
  magnitude: number | null; // hail = inches; wind = knots
  distanceMiles: number | null;
}

export interface CorrelatedStorm extends StormEventInput {
  bucket: StormBucket;
  daysFromImagery: number | null;
}

export interface ImageryStormSummary {
  imageryDate: string | null;
  imageryAgeDays: number | null;
  /** Most concerning storm that hit AFTER the imagery date. */
  postImageryEvent: CorrelatedStorm | null;
  /** Count of post-imagery events. */
  postImageryCount: number;
  /** Pre-imagery storm count (informational — explains pre-existing damage in tile). */
  preImageryCount: number;
  events: CorrelatedStorm[];
  /** "underweighted" = post-imagery storms exist; "matched" = roof scan should
   *  reflect all relevant storm history; "unknown" = no imagery date provided. */
  status: "underweighted" | "matched" | "unknown";
}

// "Concerning" thresholds for surfacing the alert
const CONCERNING_HAIL_INCHES = 0.75;
const CONCERNING_WIND_KNOTS = 50;

function isConcerning(e: StormEventInput): boolean {
  if (!e.magnitude) return /tornado/i.test(e.type);
  if (/hail/i.test(e.type)) return e.magnitude >= CONCERNING_HAIL_INCHES;
  if (/wind/i.test(e.type)) return e.magnitude >= CONCERNING_WIND_KNOTS;
  if (/tornado/i.test(e.type)) return true;
  return false;
}

/** Sort key — "more concerning" stormstreated higher: tornadoes first,
 *  then biggest hail, then largest wind. */
function severityScore(e: StormEventInput): number {
  if (/tornado/i.test(e.type)) return 1000 + (e.magnitude ?? 1);
  if (/hail/i.test(e.type)) return 500 + (e.magnitude ?? 0) * 100;
  return 100 + (e.magnitude ?? 0);
}

export function correlate(
  imageryDate: string | null,
  events: StormEventInput[],
): ImageryStormSummary {
  if (!imageryDate || !events?.length) {
    return {
      imageryDate,
      imageryAgeDays: imageryDate
        ? Math.floor((Date.now() - new Date(imageryDate).getTime()) / 86400000)
        : null,
      postImageryEvent: null,
      postImageryCount: 0,
      preImageryCount: 0,
      events: [],
      status: imageryDate ? "matched" : "unknown",
    };
  }

  const imageryMs = new Date(imageryDate).getTime();
  const dayMs = 86400000;
  // Buffer of 14 days — Google's imagery date is the capture date, but
  // damage that close to capture would only barely register.
  const TOLERANCE_DAYS = 14;

  const correlated: CorrelatedStorm[] = events.map((e) => {
    if (!e.date) {
      return { ...e, bucket: "before", daysFromImagery: null };
    }
    const stormMs = new Date(e.date).getTime();
    const days = (stormMs - imageryMs) / dayMs;
    let bucket: StormBucket;
    if (Math.abs(days) <= TOLERANCE_DAYS) bucket = "during";
    else if (days < 0) bucket = "before";
    else bucket = "after";
    return { ...e, bucket, daysFromImagery: Math.round(days) };
  });

  // Worst post-imagery event
  const post = correlated.filter((c) => c.bucket === "after");
  const concerningPost = post.filter(isConcerning);
  const sorted = [...concerningPost].sort(
    (a, b) => severityScore(b) - severityScore(a),
  );
  const postImageryEvent = sorted[0] ?? null;

  return {
    imageryDate,
    imageryAgeDays: Math.floor((Date.now() - imageryMs) / dayMs),
    postImageryEvent,
    postImageryCount: post.length,
    preImageryCount: correlated.filter((c) => c.bucket === "before").length,
    events: correlated,
    status: postImageryEvent ? "underweighted" : "matched",
  };
}

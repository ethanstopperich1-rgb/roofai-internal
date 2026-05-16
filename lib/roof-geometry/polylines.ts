/**
 * Polyline (linear feature) measurement: ridge, hip, valley, rake, eave.
 *
 * Ridges + eaves are horizontal: their visible length on the tile is
 * their true linear feet. Hips, rakes, and valleys are sloped: their
 * visible length is the projected/horizontal run; the true linear
 * length = run × slope multiplier (1 / cos(pitch)).
 *
 * The pitch supplied per polyline is the LARGER of the two abutting
 * facets' pitches (slope-correction conservatism — measure the longer
 * run to size material). When pitch is unknown, slope = 1 (no
 * correction) and the result is the projected length.
 */

import type { LatLng, PixelPoint } from "./coordinates";
import { haversineMeters } from "./coordinates";
import { slopeMultiplier } from "./polygons";

const M_TO_FT = 3.28084;

export interface PixelSegment {
  start: PixelPoint;
  end: PixelPoint;
}

export interface LatLngSegment {
  start: LatLng;
  end: LatLng;
}

/**
 * Pixel-space segment length × metersPerPixel × slope correction → feet.
 */
export function pixelSegmentLengthFt(
  seg: PixelSegment,
  metersPerPixel: number,
  pitchDegrees: number | null = null,
): number {
  const runPx = Math.hypot(
    seg.end.x - seg.start.x,
    seg.end.y - seg.start.y,
  );
  const runM = runPx * metersPerPixel;
  const slope = pitchDegrees != null ? slopeMultiplier(pitchDegrees) : 1;
  return runM * M_TO_FT * slope;
}

export function latLngSegmentLengthFt(
  seg: LatLngSegment,
  pitchDegrees: number | null = null,
): number {
  const runM = haversineMeters(seg.start, seg.end);
  const slope = pitchDegrees != null ? slopeMultiplier(pitchDegrees) : 1;
  return runM * M_TO_FT * slope;
}

/**
 * Sum the LF of a list of segments at a single pitch. Used to total
 * ridges, hips, valleys etc. after Gemini emits them.
 */
export function totalSegmentLengthFt(
  segs: LatLngSegment[],
  pitchDegrees: number | null = null,
): number {
  let total = 0;
  for (const s of segs) total += latLngSegmentLengthFt(s, pitchDegrees);
  return total;
}

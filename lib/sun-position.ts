/**
 * Sun-position predictor — NOAA solar-position formula (PSA, simplified).
 * Given a (lat, lng, isoDate, localHour), returns sun azimuth + altitude
 * and the direction shadows fall in. Used as a soft penalty in the polygon
 * pipeline: edges that run along the predicted shadow axis are almost
 * certainly tracing tree-shadow rather than a real roof boundary.
 *
 * Accuracy: ±1° azimuth — plenty for shadow-direction work. Pure JS,
 * no dependencies, side-effect-free.
 */

export interface SunPosition {
  /** Azimuth from north, clockwise, in degrees (0=N, 90=E, 180=S, 270=W) */
  azimuthDeg: number;
  /** Altitude above horizon in degrees */
  altitudeDeg: number;
  /** Direction shadows point in (= sun azimuth + 180°), [0, 360) */
  shadowAzimuthDeg: number;
}

export function sunPositionAt(opts: {
  lat: number;
  lng: number;
  /** ISO date string (e.g. "2023-06-14"). Time portion ignored — use
   *  `localHour` for that. We typically pass Solar API's `imageryDate`. */
  isoDate: string;
  /** Hour of day in local time. Solar API doesn't give time-of-day, but
   *  Google's aerial imagery is captured near solar noon to minimize
   *  shadows — 11:00 is a reasonable default. */
  localHour?: number;
}): SunPosition | null {
  const m = opts.isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  const hour = opts.localHour ?? 11;

  // Julian day (Fliegel & Van Flandern)
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const mo = month + 12 * a - 3;
  const jdn =
    day + Math.floor((153 * mo + 2) / 5) + 365 * y +
    Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  // Local hour → UTC via lng/15° offset (good enough for solar position;
  // doesn't account for DST, but sun position is only weakly dependent on
  // exact time-of-day for shadow-direction purposes)
  const utcHour = hour - opts.lng / 15;
  const jd = jdn + (utcHour - 12) / 24;
  const n = jd - 2451545.0;

  // Mean longitude (deg), mean anomaly (rad), ecliptic longitude (rad)
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180;
  const lambda =
    (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180;

  // Obliquity (rad), right ascension (rad), declination (rad)
  const eps = (23.439 - 0.0000004 * n) * Math.PI / 180;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));

  // Greenwich mean sidereal time → local sidereal time → hour angle
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + opts.lng) * Math.PI / 180;
  const ha = lst - ra;

  const latRad = opts.lat * Math.PI / 180;
  const altRad = Math.asin(
    Math.sin(latRad) * Math.sin(dec) +
      Math.cos(latRad) * Math.cos(dec) * Math.cos(ha),
  );
  const azRad = Math.atan2(
    -Math.sin(ha),
    Math.tan(dec) * Math.cos(latRad) - Math.sin(latRad) * Math.cos(ha),
  );

  const azimuthDeg = ((azRad * 180 / Math.PI) + 360) % 360;
  const altitudeDeg = altRad * 180 / Math.PI;
  const shadowAzimuthDeg = (azimuthDeg + 180) % 360;
  return { azimuthDeg, altitudeDeg, shadowAzimuthDeg };
}

/**
 * Score how "shadow-aligned" a polygon edge is. 1.0 = exactly along the
 * predicted shadow axis (very suspicious — likely tracing shadow, not
 * roof). 0.0 = perpendicular to shadow (very legitimate roof edge).
 *
 * Used by the ensemble fuser as a soft penalty and as a per-edge
 * confidence input for the validators.
 */
export function edgeShadowAlignment(
  edge: { a: { lat: number; lng: number }; b: { lat: number; lng: number } },
  shadowAzimuthDeg: number,
): number {
  const dLat = edge.b.lat - edge.a.lat;
  const dLng = (edge.b.lng - edge.a.lng) * Math.cos((edge.a.lat * Math.PI) / 180);
  // Convert (dLng, dLat) → bearing: 0=N, increasing clockwise
  const edgeAz = ((Math.atan2(dLng, dLat) * 180 / Math.PI) + 360) % 360;
  // Edges are undirected; compare modulo 180°
  let delta = Math.abs(edgeAz - shadowAzimuthDeg) % 180;
  if (delta > 90) delta = 180 - delta;
  // 0° → 1.0 (aligned), 90° → 0.0 (perpendicular)
  return 1 - delta / 90;
}

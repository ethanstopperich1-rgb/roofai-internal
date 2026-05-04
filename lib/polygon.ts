/**
 * Pure-client polygon utilities — orthogonalization, simplification, etc.
 * Lives in its own module (separate from grounded-sam.ts) so the client
 * bundle doesn't pull in `sharp` / `replicate` Node-only deps.
 */

/**
 * Sanity check: is the polygon plausibly "the building at this address"?
 * Returns false when the polygon is clearly on a neighbour or wildly off
 * — e.g. the geocoded address point is farther than `toleranceM` from any
 * edge of the polygon AND not contained inside it. Blocks the wrong-house
 * failure mode where AI traces the brightest roof in the tile rather than
 * the actual target.
 */
export function polygonIsNearAddress(
  poly: Array<{ lat: number; lng: number }>,
  addressLat: number,
  addressLng: number,
  toleranceM: number = 15,
): boolean {
  if (!poly || poly.length < 3) return false;

  // Point-in-polygon (ray cast in lat/lng — accurate enough at house scale)
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat;
    const xj = poly[j].lng, yj = poly[j].lat;
    if (
      yi > addressLat !== yj > addressLat &&
      addressLng < ((xj - xi) * (addressLat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  if (inside) return true;

  // Not inside — measure distance to nearest edge in meters
  const cosLat = Math.cos((addressLat * Math.PI) / 180);
  const M = 111_320;
  const px = addressLng * M * cosLat;
  const py = addressLat * M;
  let minDistSq = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ax = a.lng * M * cosLat, ay = a.lat * M;
    const bx = b.lng * M * cosLat, by = b.lat * M;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const cx = ax + t * dx, cy = ay + t * dy;
    const ex = px - cx, ey = py - cy;
    const d2 = ex * ex + ey * ey;
    if (d2 < minDistSq) minDistSq = d2;
  }
  return Math.sqrt(minDistSq) <= toleranceM;
}

/**
 * Drop vertices that are within `mergeDistance` of their neighbour.
 * Orthogonalization can leave near-duplicate vertices when adjacent
 * snapped lines intersect very close to the original vertex — these
 * read as visual jaggies and cause the polygon edit handles to bunch
 * up. Merge them before returning to the renderer.
 */
export function mergeNearbyVertices(
  poly: Array<[number, number]>,
  mergeDistance: number = 2,
): Array<[number, number]> {
  if (poly.length <= 3) return poly;
  const out: Array<[number, number]> = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const last = out[out.length - 1];
    const dx = poly[i][0] - last[0];
    const dy = poly[i][1] - last[1];
    if (Math.hypot(dx, dy) >= mergeDistance) out.push(poly[i]);
  }
  // Re-check the wrap-around (last vs first)
  if (out.length > 3) {
    const last = out[out.length - 1];
    const first = out[0];
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) < mergeDistance) {
      out.pop();
    }
  }
  return out;
}

/**
 * Principal-axis bounding rectangle. Computes the 2D PCA of a polygon's
 * vertices and returns the minimum oriented rectangle aligned with its
 * dominant direction.
 *
 * Used for Claude AI source polygons — Claude consistently returns oval /
 * curved traces of what are actually rectangular suburban roofs. Rather
 * than orthogonalize-and-pray (which fails when no edges happen to be
 * cardinal-aligned), we just collapse the trace to its oriented bounding
 * rectangle. Guarantees a clean 4-vertex output that matches the building's
 * dominant axis. Reps can edit corners to add L/T-shape detail manually.
 *
 * For non-rectangular footprints (octagonal, round) this loses fidelity,
 * but residential roofs are virtually never round, and a too-aggressive
 * rectangle is far easier to fix than a bad oval.
 */
export function principalAxisRect(
  poly: Array<[number, number]>,
): Array<[number, number]> {
  if (poly.length < 4) return poly;

  // Centroid
  let cx = 0, cy = 0;
  for (const [x, y] of poly) { cx += x; cy += y; }
  cx /= poly.length;
  cy /= poly.length;

  // Sample-covariance components (use vertex set; for finer fit, sample
  // points along edges, but vertex sample is fine for short polygons)
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of poly) {
    const dx = x - cx;
    const dy = y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  // Closed-form 2×2 symmetric eigendecomposition: the major axis angle is
  // 0.5·atan2(2·sxy, sxx − syy).
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);

  // Rotate every vertex into axis-aligned space, find min/max, build 4
  // corners, rotate back to image coordinates.
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [x, y] of poly) {
    const dx = x - cx;
    const dy = y - cy;
    const u = dx * cos - dy * sin;
    const v = dx * sin + dy * cos;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const cosBack = Math.cos(angle);
  const sinBack = Math.sin(angle);
  const corners: Array<[number, number]> = [
    [minU, minV],
    [maxU, minV],
    [maxU, maxV],
    [minU, maxV],
  ];
  return corners.map(([u, v]) => [
    cx + u * cosBack - v * sinBack,
    cy + u * sinBack + v * cosBack,
  ]);
}

/**
 * Orthogonalize a polygon by snapping every edge to the nearest 0° / 90°
 * offset from the dominant building axis (defined as the angle of the
 * longest edge). Roofs are ~95% rectilinear — even L/T/U-shaped houses
 * have all edges parallel or perpendicular to a single dominant axis.
 *
 * Algorithm (JOSM-style):
 *   1. Pick the longest edge as the dominant axis.
 *   2. For each edge, if its angle is within `toleranceDeg` of a cardinal
 *      direction (0° or 90°) from baseline, snap to that direction.
 *   3. Recompute each vertex as the intersection of its two neighboring
 *      snapped edges' lines, anchored at each edge's original midpoint.
 *      Guarantees the polygon stays closed and respects edge positions.
 *
 * Bails when fewer than 50% of perimeter snaps — for non-rectilinear
 * shapes (round silo, octagonal gazebo) snapping would distort the outline.
 */
export function orthogonalizePolygon(
  poly: Array<[number, number]>,
  toleranceDeg: number = 14,
  /** When true, bypass the < 50% perimeter bail rule. Useful for sources
   *  like Claude vision that consistently return curved/oval traces of
   *  what should be rectangular roofs — we'd rather force the snap and
   *  accept distortion on truly round shapes (which residential roofs
   *  basically never are) than ship the curvy original. */
  forceSnap: boolean = false,
): Array<[number, number]> {
  // Default behaviour: longest-edge axis. For the multi-axis search use
  // bestOrthogonalize() below.
  return orthogonalizeAtAxis(poly, longestEdgeAngleDeg(poly), toleranceDeg, forceSnap)
    .polygon;
}

/**
 * Compute the angle (degrees, atan2-style — i.e. -180 < a ≤ 180) of the
 * longest edge in a polygon. Returns 0 for degenerate polygons.
 */
export function longestEdgeAngleDeg(poly: Array<[number, number]>): number {
  let bestLen = 0;
  let bestAngle = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len > bestLen) {
      bestLen = len;
      bestAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
    }
  }
  return bestAngle;
}

/**
 * Run orthogonalization at an explicit base axis. Returns the snapped
 * polygon plus the fraction of perimeter that aligned to a cardinal
 * direction from that axis (= the snap quality). bestOrthogonalize uses
 * `alignedRatio` to pick the winning axis among multiple candidates.
 */
export function orthogonalizeAtAxis(
  poly: Array<[number, number]>,
  baseAngleDeg: number,
  toleranceDeg: number = 14,
  forceSnap: boolean = false,
): { polygon: Array<[number, number]>; alignedRatio: number } {
  if (poly.length < 4) return { polygon: poly, alignedRatio: 0 };
  const n = poly.length;
  const baseAngle = baseAngleDeg;

  type Edge = {
    a: [number, number];
    b: [number, number];
    angle: number;
    length: number;
  };
  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) continue;
    edges.push({ a, b, angle: (Math.atan2(dy, dx) * 180) / Math.PI, length });
  }
  if (edges.length < 4) return { polygon: poly, alignedRatio: 0 };

  const snappedAngles: number[] = [];
  let alignedLength = 0;
  let totalLength = 0;
  for (const e of edges) {
    totalLength += e.length;
    let delta = e.angle - baseAngle;
    while (delta > 180) delta -= 360;
    while (delta <= -180) delta += 360;
    while (delta > 90) delta -= 180;
    while (delta <= -90) delta += 180;
    let target: number;
    if (Math.abs(delta) < 45) target = 0;
    else target = delta > 0 ? 90 : -90;
    if (Math.abs(delta - target) < toleranceDeg) {
      alignedLength += e.length;
      snappedAngles.push(baseAngle + target);
    } else {
      snappedAngles.push(e.angle);
    }
  }
  const alignedRatio = totalLength > 0 ? alignedLength / totalLength : 0;

  if (!forceSnap && alignedRatio < 0.5) return { polygon: poly, alignedRatio };

  const m = edges.length;
  const result: Array<[number, number]> = [];
  for (let i = 0; i < m; i++) {
    const prev = edges[(i - 1 + m) % m];
    const curr = edges[i];
    const prevAngle = snappedAngles[(i - 1 + m) % m];
    const currAngle = snappedAngles[i];

    const mPrev: [number, number] = [(prev.a[0] + prev.b[0]) / 2, (prev.a[1] + prev.b[1]) / 2];
    const mCurr: [number, number] = [(curr.a[0] + curr.b[0]) / 2, (curr.a[1] + curr.b[1]) / 2];

    const rPrev = (prevAngle * Math.PI) / 180;
    const rCurr = (currAngle * Math.PI) / 180;
    const dpx = Math.cos(rPrev), dpy = Math.sin(rPrev);
    const dcx = Math.cos(rCurr), dcy = Math.sin(rCurr);

    const det = dpx * -dcy - dpy * -dcx;
    if (Math.abs(det) < 1e-9) {
      result.push(curr.a);
      continue;
    }
    const rhsX = mCurr[0] - mPrev[0];
    const rhsY = mCurr[1] - mPrev[1];
    const t = (rhsX * -dcy - rhsY * -dcx) / det;
    const px = mPrev[0] + t * dpx;
    const py = mPrev[1] + t * dpy;

    // Cap movement to 3× avg edge length to defang pathological intersections
    const orig = curr.a;
    const moveDist = Math.hypot(px - orig[0], py - orig[1]);
    const avgEdge = totalLength / m;
    if (moveDist > avgEdge * 3) {
      result.push(orig);
    } else {
      result.push([px, py]);
    }
  }
  return { polygon: result, alignedRatio };
}

/**
 * Best-of-N axis orthogonalization. Tries multiple candidate base axes
 * (longest edge + any caller-supplied candidates like the OSM polygon's
 * principal axis or Solar's dominantAzimuthDeg) and returns the snapped
 * polygon with the highest aligned-perimeter ratio.
 *
 * Catches the failure mode where the longest edge is a porch eave that
 * doesn't actually represent the building's true axis — the OSM building
 * outline or Solar's facet azimuths often nail the real axis when the
 * longest-edge heuristic doesn't.
 */
export function bestOrthogonalize(opts: {
  poly: Array<[number, number]>;
  /** Candidate base axes, in degrees. Caller supplies these from external
   *  signals (OSM polygon principal axis, Solar dominant azimuth, etc.).
   *  The longest edge is always tried in addition to these. */
  candidateAxesDeg?: number[];
  toleranceDeg?: number;
}): {
  polygon: Array<[number, number]>;
  chosenAxisDeg: number;
  alignedRatio: number;
} {
  const { poly, candidateAxesDeg = [], toleranceDeg = 14 } = opts;
  const longest = longestEdgeAngleDeg(poly);
  // Always try longest + caller candidates + 0° (true north) as a safety net
  const candidates = Array.from(new Set([longest, ...candidateAxesDeg, 0]));

  let best = { polygon: poly, chosenAxisDeg: longest, alignedRatio: 0 };
  for (const axis of candidates) {
    const result = orthogonalizeAtAxis(poly, axis, toleranceDeg);
    if (result.alignedRatio > best.alignedRatio) {
      best = {
        polygon: result.polygon,
        chosenAxisDeg: axis,
        alignedRatio: result.alignedRatio,
      };
    }
  }
  return best;
}

/**
 * Principal axis (degrees) of a polygon's vertex distribution via PCA.
 * Used by §8 best-of-N orthogonalization to feed the OSM building axis
 * as a candidate. Returns the angle in atan2 convention (-180, 180].
 */
export function polygonPrincipalAxisDeg(
  poly: Array<{ lat: number; lng: number }> | Array<[number, number]>,
): number {
  if (poly.length < 3) return 0;
  // Normalise input shape
  const pts: Array<[number, number]> = poly.map((p) =>
    Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat],
  );
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length;
  cy /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    const dx = x - cx;
    const dy = y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const angle = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI;
  return angle;
}

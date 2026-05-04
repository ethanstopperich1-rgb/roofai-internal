/**
 * Pure-client polygon utilities — orthogonalization, simplification, etc.
 * Lives in its own module (separate from grounded-sam.ts) so the client
 * bundle doesn't pull in `sharp` / `replicate` Node-only deps.
 */

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
  if (poly.length < 4) return poly;
  const n = poly.length;

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
  if (edges.length < 4) return poly;

  let longest = edges[0];
  for (const e of edges) if (e.length > longest.length) longest = e;
  const baseAngle = longest.angle;

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

  if (!forceSnap && alignedLength / totalLength < 0.5) return poly;

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
  return result;
}

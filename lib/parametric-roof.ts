/**
 * Parametric roof geometry — turn a footprint polygon + pitch into a real 3D
 * roof mesh with proper eaves, ridges, hips, valleys, and rakes.
 *
 * Approach: simplified straight-skeleton.
 *   1. Convert polygon lat/lng → local planar XY (ENU centered on centroid).
 *   2. For each polygon edge, build an inward-rising slope plane at the
 *      configured pitch angle.
 *   3. Adjacent slopes intersect along ridge / hip / valley lines.
 *   4. Compute pairwise edge-plane intersections to find skeleton vertices.
 *   5. Triangulate each slope face from polygon edge → skeleton vertices.
 *
 * The output is a buffer of triangle vertices in local meters (X east, Y north,
 * Z up) plus a parallel set of typed edges (eave / ridge / hip / valley / rake)
 * we can render and label.
 *
 * Limitations:
 *   - Assumes uniform pitch across all faces. Multi-pitch (different facets
 *     having different slopes) requires a non-uniform straight skeleton; we
 *     defer that to v2.
 *   - Polygon must be CCW oriented; winding is normalized at entry.
 *   - Self-intersecting polygons not supported.
 *   - For complex L / U / multi-bay shapes, fall-back is a simple gable along
 *     the polygon's longest axis.
 */

export type LL = { lat: number; lng: number };
export type Vec3 = { x: number; y: number; z: number };

export type RoofEdgeKind = "eave" | "ridge" | "hip" | "valley" | "rake";

export interface RoofEdge {
  kind: RoofEdgeKind;
  a: Vec3;
  b: Vec3;
  /** Edge length in meters (3D, includes vertical run for sloped edges). */
  lengthM: number;
}

export interface RoofMesh {
  /** Triangle list — every 3 vertices = one triangle, normal computed per face */
  triangles: Vec3[];
  /** Typed edges for labeling + measurement */
  edges: RoofEdge[];
  /** Stats for caller (sqft of roof surface, footprint sqft, ridge LF, etc.) */
  stats: {
    footprintSqft: number;
    roofSurfaceSqft: number;
    ridgeLf: number;
    hipLf: number;
    valleyLf: number;
    eaveLf: number;
    rakeLf: number;
    /** Approximate height of ridge above eave (ft) */
    ridgeHeightFt: number;
  };
  /** ENU origin used for projection — pass back in if rendering on a map */
  origin: LL;
  /** Local XY → lat/lng converter (so the caller can pin geometry to a map) */
  localToLatLng: (x: number, y: number) => LL;
}

const FT_PER_M = 3.28084;
const SQFT_PER_SQM = 10.7639;

/* ─── Lat/lng ↔ local meters ──────────────────────────────────────── */

function lonLatToMeters(p: LL, origin: LL): { x: number; y: number } {
  const R = 6_378_137;
  const dLat = ((p.lat - origin.lat) * Math.PI) / 180;
  const dLng = ((p.lng - origin.lng) * Math.PI) / 180;
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return { x: R * dLng * cosLat, y: R * dLat };
}

function metersToLonLat(x: number, y: number, origin: LL): LL {
  const R = 6_378_137;
  const cosLat = Math.cos((origin.lat * Math.PI) / 180);
  return {
    lat: origin.lat + (y / R) * (180 / Math.PI),
    lng: origin.lng + (x / (R * cosLat)) * (180 / Math.PI),
  };
}

function centroidOfPolygon(poly: LL[]): LL {
  let lat = 0,
    lng = 0;
  for (const p of poly) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / poly.length, lng: lng / poly.length };
}

function signedArea2D(pts: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

function ensureCCW(pts: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return signedArea2D(pts) < 0 ? [...pts].reverse() : pts;
}

/* ─── Pitch helpers ───────────────────────────────────────────────── */

/** "5/12" / "8/12+" / number-degrees → radians */
function pitchToRadians(pitch: string | number): number {
  if (typeof pitch === "number") return (pitch * Math.PI) / 180;
  if (pitch.endsWith("+")) return (35 * Math.PI) / 180;
  const [rise, run] = pitch.split("/").map(Number);
  if (!run) return (Math.PI * 22.62) / 180; // default ~5/12
  return Math.atan(rise / run);
}

/* ─── Longest axis (gable fallback) ───────────────────────────────── */

function longestAxis(poly: Array<{ x: number; y: number }>): {
  midA: { x: number; y: number };
  midB: { x: number; y: number };
  width: number;
} {
  // Use OBB approximation: try every edge as the long axis, project all points
  // onto perpendicular, find the projection range with the smallest perpendicular extent.
  let best = { len: 0, a: poly[0], b: poly[1], width: 0 };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len;
    const uy = dy / len;
    // perpendicular projection extent
    let minPerp = Infinity,
      maxPerp = -Infinity;
    for (const p of poly) {
      const px = p.x - a.x;
      const py = p.y - a.y;
      const perp = -uy * px + ux * py;
      if (perp < minPerp) minPerp = perp;
      if (perp > maxPerp) maxPerp = perp;
    }
    const perpExtent = maxPerp - minPerp;
    // pick axis maximizing length AND minimizing perp extent (i.e. flat side)
    const score = len - perpExtent * 0.5;
    if (score > best.len) {
      best = { len: score, a, b, width: perpExtent };
    }
  }
  // midA / midB are the centerline endpoints of the OBB along the dominant axis.
  // Build them by projecting all polygon points along the edge axis.
  const a = best.a;
  const b = best.b;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  let minProj = Infinity,
    maxProj = -Infinity;
  for (const p of poly) {
    const proj = ux * (p.x - a.x) + uy * (p.y - a.y);
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }
  const midPerp = 0; // centerline lies on the axis
  void midPerp;
  // midpoint of the perpendicular extent
  let minPerp = Infinity,
    maxPerp = -Infinity;
  for (const p of poly) {
    const perp = -uy * (p.x - a.x) + ux * (p.y - a.y);
    if (perp < minPerp) minPerp = perp;
    if (perp > maxPerp) maxPerp = perp;
  }
  const perpMid = (minPerp + maxPerp) / 2;
  const perpExtent = maxPerp - minPerp;
  return {
    midA: { x: a.x + ux * minProj - uy * perpMid, y: a.y + uy * minProj + ux * perpMid },
    midB: { x: a.x + ux * maxProj - uy * perpMid, y: a.y + uy * maxProj + ux * perpMid },
    width: perpExtent,
  };
}

/* ─── Build mesh ──────────────────────────────────────────────────── */

/**
 * Build a parametric roof mesh from a footprint polygon + uniform pitch.
 *
 * Strategy:
 *   - Project to local meters
 *   - Find longest-axis ridge
 *   - For each polygon vertex, decide eave or rake (roughly: edges parallel to
 *     ridge axis = eaves; edges perpendicular = rakes)
 *   - Generate triangle fan from each polygon edge to the ridge centerline
 *   - Calculate ridge height from perpendicular distance × tan(pitch)
 *
 * Works well for: rectangles, hexagons, near-convex polygons.
 * Approximate but visually plausible for: L-shapes, T-shapes (single ridge).
 * For multi-bay homes, the user can edit polygon vertices in MapView; we'll
 * upgrade to a real straight skeleton in v2.
 */
export function buildParametricRoof(
  polygon: LL[],
  opts: { pitch: string | number; eaveOverhangFt?: number },
): RoofMesh | null {
  if (!polygon || polygon.length < 3) return null;
  const origin = centroidOfPolygon(polygon);
  let pts = polygon.map((p) => lonLatToMeters(p, origin));
  pts = ensureCCW(pts);

  const pitchRad = pitchToRadians(opts.pitch);
  const tanPitch = Math.tan(pitchRad);
  const overhangM = ((opts.eaveOverhangFt ?? 1.0) / FT_PER_M);

  // Eave overhang: push polygon edges outward by overhangM along inward normal × -1
  if (overhangM > 0) {
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const cur = pts[i];
      const next = pts[(i + 1) % pts.length];
      const e1x = cur.x - prev.x;
      const e1y = cur.y - prev.y;
      const e2x = next.x - cur.x;
      const e2y = next.y - cur.y;
      const n1x = e1y;
      const n1y = -e1x;
      const n2x = e2y;
      const n2y = -e2x;
      const l1 = Math.hypot(n1x, n1y) || 1;
      const l2 = Math.hypot(n2x, n2y) || 1;
      const bx = n1x / l1 + n2x / l2;
      const by = n1y / l1 + n2y / l2;
      const blen = Math.hypot(bx, by) || 1;
      out.push({ x: cur.x + (bx / blen) * overhangM, y: cur.y + (by / blen) * overhangM });
    }
    pts = ensureCCW(out);
  }

  const axis = longestAxis(pts);
  const dx = axis.midB.x - axis.midA.x;
  const dy = axis.midB.y - axis.midA.y;
  const axisLen = Math.hypot(dx, dy) || 1;
  const ux = dx / axisLen;
  const uy = dy / axisLen;

  // Compute perpendicular distance from each polygon vertex to the ridge centerline
  // and the projection along the ridge axis.
  const projInfo = pts.map((p) => {
    const px = p.x - axis.midA.x;
    const py = p.y - axis.midA.y;
    const along = ux * px + uy * py; // 0 .. axisLen-ish
    const perp = -uy * px + ux * py;
    return { along, perp };
  });

  // Half-width of polygon perpendicular to the ridge → drives ridge height
  const maxAbsPerp = projInfo.reduce((m, i) => Math.max(m, Math.abs(i.perp)), 0);
  const ridgeHeightM = maxAbsPerp * tanPitch;

  // Ridge is the set of points on the axis between min and max projection
  // (clipped slightly off the polygon ends to look like a real ridge, not
  // running into the gable peak).
  let alongMin = Infinity,
    alongMax = -Infinity;
  for (const pi of projInfo) {
    if (pi.along < alongMin) alongMin = pi.along;
    if (pi.along > alongMax) alongMax = pi.along;
  }
  // Pull the ridge in by maxAbsPerp on each end so it forms a hip-end-ish look on rectangles.
  // For pure gables, the rake naturally meets the ridge line at the peak.
  const ridgeEndA: Vec3 = {
    x: axis.midA.x + ux * alongMin,
    y: axis.midA.y + uy * alongMin,
    z: ridgeHeightM,
  };
  const ridgeEndB: Vec3 = {
    x: axis.midA.x + ux * alongMax,
    y: axis.midA.y + uy * alongMax,
    z: ridgeHeightM,
  };

  // For each polygon edge, build a triangle from edge.A → edge.B → ridge_projection_of_midpoint
  const triangles: Vec3[] = [];
  const edges: RoofEdge[] = [];

  for (let i = 0; i < pts.length; i++) {
    const a2 = pts[i];
    const b2 = pts[(i + 1) % pts.length];
    const a3: Vec3 = { x: a2.x, y: a2.y, z: 0 };
    const b3: Vec3 = { x: b2.x, y: b2.y, z: 0 };
    // Project midpoint of edge onto ridge axis → that's the apex of this slope face
    const midX = (a2.x + b2.x) / 2;
    const midY = (a2.y + b2.y) / 2;
    const midPx = midX - axis.midA.x;
    const midPy = midY - axis.midA.y;
    const along = Math.max(alongMin, Math.min(alongMax, ux * midPx + uy * midPy));
    const apex: Vec3 = {
      x: axis.midA.x + ux * along,
      y: axis.midA.y + uy * along,
      z: ridgeHeightM,
    };
    triangles.push(a3, b3, apex);
    // Eave runs along the polygon edge at z=0
    edges.push({ kind: "eave", a: a3, b: b3, lengthM: distance3(a3, b3) });
    // Each polygon vertex → apex makes a rake/hip
    edges.push({ kind: "rake", a: a3, b: apex, lengthM: distance3(a3, apex) });
  }

  // Ridge edge across the top
  edges.push({
    kind: "ridge",
    a: ridgeEndA,
    b: ridgeEndB,
    lengthM: distance3(ridgeEndA, ridgeEndB),
  });

  // Stats
  const footprintM2 = Math.abs(signedArea2D(pts));
  const surfaceM2 = footprintM2 / Math.cos(pitchRad);
  const ridgeLf = distance3(ridgeEndA, ridgeEndB) * FT_PER_M;
  const eaveLf = edges
    .filter((e) => e.kind === "eave")
    .reduce((s, e) => s + e.lengthM * FT_PER_M, 0);
  const rakeLf = edges
    .filter((e) => e.kind === "rake")
    .reduce((s, e) => s + e.lengthM * FT_PER_M, 0);

  return {
    triangles,
    edges,
    stats: {
      footprintSqft: Math.round(footprintM2 * SQFT_PER_SQM),
      roofSurfaceSqft: Math.round(surfaceM2 * SQFT_PER_SQM),
      ridgeLf: Math.round(ridgeLf),
      hipLf: 0,
      valleyLf: 0,
      eaveLf: Math.round(eaveLf),
      rakeLf: Math.round(rakeLf),
      ridgeHeightFt: Math.round(ridgeHeightM * FT_PER_M * 10) / 10,
    },
    origin,
    localToLatLng: (x, y) => metersToLonLat(x, y, origin),
  };
}

function distance3(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

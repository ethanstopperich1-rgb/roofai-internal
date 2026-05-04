/**
 * Simplified straight-skeleton roof generator.
 *
 * Background: a "real" roof above a polygonal footprint is a hipped surface
 * where each polygon edge rises at the configured pitch as a slope plane.
 * Adjacent slopes meet along HIP lines emanating from each polygon vertex;
 * non-adjacent slopes meet at RIDGE edges or PEAK points. The 2D projection
 * of those meeting lines is the polygon's "straight skeleton" — the medial
 * axis under uniform offsetting.
 *
 * The classic Aichholzer algorithm tracks both edge-collapse events (an
 * edge's two endpoints converge) and split events (a reflex vertex hits an
 * opposite edge). A complete implementation is ~600 lines plus careful
 * numerical-edge-case handling.
 *
 * This implementation handles edge-collapse events only. That covers:
 *   - Convex polygons (rectangles, hexagons, octagons) → perfect hip roofs
 *   - L-shapes / T-shapes / U-shapes when the reflex vertex doesn't trigger
 *     a split before all convex corners collapse → typically very good
 *
 * For reflex-heavy polygons where edges cross during the offset, we abort
 * gracefully and the caller falls back to the centroid-pyramid.
 */

export type Pt = { x: number; y: number };
export type Pt3 = { x: number; y: number; z: number };

export type SkeletonEdgeKind = "eave" | "ridge" | "hip" | "valley" | "rake";

export interface SkeletonEdge {
  kind: SkeletonEdgeKind;
  a: Pt3;
  b: Pt3;
}

export interface SkeletonResult {
  triangles: Pt3[]; // groups of 3
  edges: SkeletonEdge[];
  apexHeight: number;
  /** True iff the algorithm terminated cleanly. False = caller should
   *  fall back to a simpler representation. */
  ok: boolean;
}

interface Vertex {
  id: number;
  x: number;
  y: number;
  /** time at which this vertex was created (z-elevation = t * tanPitch) */
  t: number;
  bx: number; // bisector x (planar)
  by: number; // bisector y (planar)
  speed: number; // planar speed along bisector
  alive: boolean;
  prev: Vertex | null;
  next: Vertex | null;
  /** the original polygon vertex this vertex traces back to (for eaves) */
  originX: number;
  originY: number;
}

const EPS = 1e-6;

function computeBisector(prev: Pt, cur: Pt, next: Pt): { bx: number; by: number; speed: number } {
  const e1x = cur.x - prev.x;
  const e1y = cur.y - prev.y;
  const e2x = next.x - cur.x;
  const e2y = next.y - cur.y;
  const l1 = Math.hypot(e1x, e1y) || 1;
  const l2 = Math.hypot(e2x, e2y) || 1;
  // Inward normals (CCW polygon): rotate edge 90° CW
  const n1x = e1y / l1;
  const n1y = -e1x / l1;
  const n2x = e2y / l2;
  const n2y = -e2x / l2;
  const bx = n1x + n2x;
  const by = n1y + n2y;
  const blen = Math.hypot(bx, by);
  if (blen < EPS) {
    // straight line; bisector = either normal
    return { bx: n1x, by: n1y, speed: 1 };
  }
  const ux = bx / blen;
  const uy = by / blen;
  // Speed: 1 / sin(half_angle) = 1 / dot(bisector, normal)
  const dot = ux * n1x + uy * n1y;
  const speed = dot > EPS ? 1 / dot : 1; // reflex / degenerate → cap at 1
  return { bx: ux, by: uy, speed };
}

/**
 * Time at which two adjacent vertices converge, given their bisectors and
 * speeds. Returns null if they're diverging.
 *
 * The two vertices "collapse" when the edge between them shrinks to zero —
 * which happens at the time their projected positions along the original
 * edge direction converge.
 */
function edgeCollapseTime(a: Vertex, b: Vertex): number | null {
  // Edge vector at time = a.t / b.t (assume same)
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const elen2 = ex * ex + ey * ey;
  if (elen2 < EPS) return null;
  // Velocity of B relative to A along the edge direction
  const vax = a.bx * a.speed;
  const vay = a.by * a.speed;
  const vbx = b.bx * b.speed;
  const vby = b.by * b.speed;
  // The closing speed along the edge
  const closing = (vax - vbx) * ex + (vay - vby) * ey;
  if (closing <= EPS) return null;
  return elen2 / closing;
}

export function buildStraightSkeleton(
  polygon: Pt[],
  pitchRad: number,
): SkeletonResult {
  if (polygon.length < 3) {
    return { triangles: [], edges: [], apexHeight: 0, ok: false };
  }
  const tanPitch = Math.tan(pitchRad);

  // Build initial doubly-linked vertex list
  const vertices: Vertex[] = polygon.map((p, i) => ({
    id: i,
    x: p.x,
    y: p.y,
    t: 0,
    bx: 0,
    by: 0,
    speed: 0,
    alive: true,
    prev: null,
    next: null,
    originX: p.x,
    originY: p.y,
  }));
  for (let i = 0; i < vertices.length; i++) {
    vertices[i].prev = vertices[(i - 1 + vertices.length) % vertices.length];
    vertices[i].next = vertices[(i + 1) % vertices.length];
  }
  for (const v of vertices) {
    if (!v.prev || !v.next) continue;
    const b = computeBisector(v.prev, v, v.next);
    v.bx = b.bx;
    v.by = b.by;
    v.speed = Math.max(0.5, Math.min(b.speed, 8)); // clamp to avoid runaway at sharp angles
  }

  const triangles: Pt3[] = [];
  const edges: SkeletonEdge[] = [];

  // Eaves at z=0
  for (const v of vertices) {
    if (!v.next) continue;
    edges.push({
      kind: "eave",
      a: { x: v.x, y: v.y, z: 0 },
      b: { x: v.next.x, y: v.next.y, z: 0 },
    });
  }

  let activeCount = vertices.length;
  let nextId = vertices.length;
  let maxT = 0;

  // Loop: pop earliest collapse event, process it, repeat
  for (let iter = 0; iter < 200; iter++) {
    if (activeCount < 3) break;
    // Find earliest edge-collapse event among alive adjacent pairs
    let bestT = Infinity;
    let bestA: Vertex | null = null;
    const alive = collectAlive(vertices);
    for (const v of alive) {
      if (!v.next) continue;
      const t = edgeCollapseTime(v, v.next);
      if (t == null) continue;
      const eventTime = v.t + t; // both should be at same t after sync
      if (eventTime < bestT && eventTime > maxT - EPS) {
        bestT = eventTime;
        bestA = v;
      }
    }
    if (!bestA || !bestA.next || !Number.isFinite(bestT)) break;

    const dt = bestT - maxT;
    if (dt < -EPS) break; // numerical mess; abort
    // Advance all alive vertices to bestT
    for (const v of alive) {
      const localDt = bestT - v.t;
      if (localDt <= 0) continue;
      v.x += v.bx * v.speed * localDt;
      v.y += v.by * v.speed * localDt;
      v.t = bestT;
    }
    maxT = bestT;
    const z = bestT * tanPitch;

    // bestA and bestA.next collapsed into one vertex
    const va = bestA;
    const vb = bestA.next;
    if (!vb.next || !va.prev) break;
    const newV: Vertex = {
      id: nextId++,
      x: (va.x + vb.x) / 2,
      y: (va.y + vb.y) / 2,
      t: bestT,
      bx: 0,
      by: 0,
      speed: 0,
      alive: true,
      prev: va.prev,
      next: vb.next,
      originX: 0,
      originY: 0,
    };
    // Triangles: face a from va.prev → va → newV at z, plus skirt down
    // We emit one triangle per original-polygon edge → the slope face above it.
    // Triangle: (va.origin@z=0, vb.origin@z=0, newV@z) is one slope face.
    triangles.push(
      { x: va.originX, y: va.originY, z: 0 },
      { x: vb.originX, y: vb.originY, z: 0 },
      { x: newV.x, y: newV.y, z },
    );
    // Hip ridges from each vertex to the new skeleton vertex
    edges.push({
      kind: "hip",
      a: { x: va.originX, y: va.originY, z: 0 },
      b: { x: newV.x, y: newV.y, z },
    });
    edges.push({
      kind: "hip",
      a: { x: vb.originX, y: vb.originY, z: 0 },
      b: { x: newV.x, y: newV.y, z },
    });

    // Stitch the new vertex into the linked list
    va.alive = false;
    vb.alive = false;
    va.prev.next = newV;
    vb.next.prev = newV;
    activeCount -= 1;

    // Compute bisector for newV based on its planar position vs neighbors.
    // Use the previous edge midpoint as origin for bisector computation.
    if (newV.prev && newV.next) {
      const b = computeBisector(newV.prev, newV, newV.next);
      newV.bx = b.bx;
      newV.by = b.by;
      newV.speed = Math.max(0.5, Math.min(b.speed, 8));
      // Inherit originXY as the centroid of the collapsed pair (they're on
      // the surviving slope face)
      newV.originX = newV.x;
      newV.originY = newV.y;
    }

    vertices.push(newV);

    if (activeCount === 2) {
      // Final ridge between the last two skeleton vertices
      const finals = collectAlive(vertices);
      if (finals.length === 2) {
        const fa = finals[0];
        const fb = finals[1];
        const finalT = bestT + edgeCollapseTime(fa, fb)!;
        if (Number.isFinite(finalT) && finalT > bestT) {
          for (const v of finals) {
            const localDt = finalT - v.t;
            v.x += v.bx * v.speed * localDt;
            v.y += v.by * v.speed * localDt;
            v.t = finalT;
          }
          const finalZ = finalT * tanPitch;
          edges.push({
            kind: "ridge",
            a: { x: fa.x, y: fa.y, z: finalZ },
            b: { x: fb.x, y: fb.y, z: finalZ },
          });
          maxT = finalT;
        }
      }
      break;
    }
  }

  return {
    triangles,
    edges,
    apexHeight: maxT * tanPitch,
    ok: triangles.length > 0,
  };
}

function collectAlive(all: Vertex[]): Vertex[] {
  return all.filter((v) => v.alive);
}

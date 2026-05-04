"use client";

import { useMemo } from "react";
import { Compass, Ruler, Download } from "lucide-react";
import { downloadDxf } from "@/lib/dxf-export";

interface Props {
  /** Polygons in lat/lng space — same shape MapView consumes */
  polygons: Array<Array<{ lat: number; lng: number }>> | undefined;
  /** Optional total roof area in square feet for the centerpiece label.
   *  When omitted we compute footprint × slopeMult(pitch) from the polygons. */
  totalRoofSqft?: number;
  /** When true, the polygon is being edited live — render a subtle pulse */
  editing?: boolean;
  /** Optional source label shown in the corner ("Solar · 4 facets", etc.) */
  sourceLabel?: string;
  /** Average pitch in degrees. Used to project polygon footprint area →
   *  roof surface area when totalRoofSqft isn't supplied. Falls back to
   *  6/12 (26.57°) when null/undefined. */
  pitchDegrees?: number | null;
  /** Address — printed in the title block when provided */
  address?: string;
  /** Pitch as "5/12" / "8/12+" — printed in title block + per-facet arrow label */
  pitchLabel?: string;
}

const M_PER_DEG_LAT = 111_320;

/** Haversine-ish: meters between two close-by lat/lng points (good to <50km) */
function metersBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  const dLat = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dLng = (b.lng - a.lng) * M_PER_DEG_LAT * cosLat;
  return Math.hypot(dLat, dLng);
}

/** Polygon-area shoelace in m² (input in lat/lng) */
function polygonAreaM2(poly: Array<{ lat: number; lng: number }>): number {
  if (poly.length < 3) return 0;
  const cLat =
    poly.reduce((s, v) => s + v.lat, 0) / poly.length;
  const cosLat = Math.cos(cLat * (Math.PI / 180));
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ax = a.lng * M_PER_DEG_LAT * cosLat;
    const ay = a.lat * M_PER_DEG_LAT;
    const bx = b.lng * M_PER_DEG_LAT * cosLat;
    const by = b.lat * M_PER_DEG_LAT;
    sum += ax * by - bx * ay;
  }
  return Math.abs(sum) / 2;
}

const PALETTE = [
  { stroke: "#67dcff", fill: "rgba(103,220,255,0.10)" }, // cyan
  { stroke: "#5fe3b0", fill: "rgba(95,227,176,0.10)" }, // mint
  { stroke: "#c8a4ff", fill: "rgba(200,164,255,0.10)" }, // lavender
  { stroke: "#ffc878", fill: "rgba(255,200,120,0.10)" }, // gold
  { stroke: "#ffa8d9", fill: "rgba(255,168,217,0.10)" }, // pink
  { stroke: "#88e6ff", fill: "rgba(136,230,255,0.10)" }, // sky
];

/**
 * Point-in-polygon ray cast (used to disambiguate which side of an edge
 * is "outside" so we don't park labels on top of another facet).
 */
function pointInPoly(p: { x: number; y: number }, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

interface Rect { x: number; y: number; w: number; h: number; }
function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

export default function RoofBlueprint({
  polygons,
  totalRoofSqft,
  editing,
  sourceLabel,
  pitchDegrees,
  address,
  pitchLabel,
}: Props) {
  const data = useMemo(() => {
    if (!polygons || polygons.length === 0) return null;

    // Use the centroid of all vertices as the local origin
    const all = polygons.flat();
    if (all.length < 3) return null;

    const cLat = all.reduce((s, v) => s + v.lat, 0) / all.length;
    const cLng = all.reduce((s, v) => s + v.lng, 0) / all.length;
    const cosLat = Math.cos(cLat * (Math.PI / 180));

    // Convert lat/lng → meters (relative to centroid). Y inverted so up=north.
    const polysM = polygons.map((p) =>
      p.map((v) => ({
        x: (v.lng - cLng) * M_PER_DEG_LAT * cosLat,
        y: -(v.lat - cLat) * M_PER_DEG_LAT,
      })),
    );

    // BBox over all polygons
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of polysM) {
      for (const v of p) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
      }
    }
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;

    // Compute footprint sqft + per-edge feet (footprint, not roof surface)
    let totalFootprintM2 = 0;
    const polyEdges: Array<
      Array<{ x1: number; y1: number; x2: number; y2: number; ft: number }>
    > = polygons.map((poly, idx) => {
      totalFootprintM2 += polygonAreaM2(poly);
      const p = polysM[idx];
      const out: Array<{ x1: number; y1: number; x2: number; y2: number; ft: number }> = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const m = metersBetween(a, b);
        out.push({
          x1: p[i].x,
          y1: p[i].y,
          x2: p[(i + 1) % p.length].x,
          y2: p[(i + 1) % p.length].y,
          ft: m * 3.28084,
        });
      }
      return out;
    });
    const footprintSqft = Math.round(totalFootprintM2 * 10.7639);
    return { polysM, polyEdges, minX, minY, w, h, footprintSqft };
  }, [polygons]);

  if (!data) {
    return (
      <div className="glass rounded-3xl p-8 text-center">
        <div className="mx-auto w-9 h-9 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center text-slate-500 mb-3">
          <Ruler size={14} />
        </div>
        <div className="font-display font-semibold text-[14px] text-slate-300 tracking-tight">
          Blueprint
        </div>
        <div className="text-[11.5px] text-slate-500 mt-1">
          A clean architectural-style outline appears here once we&apos;ve traced the roof.
        </div>
      </div>
    );
  }

  // Layout: SVG viewbox is 1000×460 (extra 60px for the title block strip).
  // Drawing border insets 8px from edges; padding for the polygon area
  // accounts for the title block height + scale bar at the bottom.
  const VB_W = 1000;
  const VB_H = 460;
  const TITLE_BLOCK_H = 56;
  const DRAWING_INSET = 8;
  const PADDING = 64;
  const innerW = VB_W - 2 * PADDING;
  // Drawing area excludes the title block at the bottom
  const innerH = VB_H - PADDING - TITLE_BLOCK_H - PADDING;
  const scale = Math.min(innerW / data.w, innerH / data.h);
  const offsetX = PADDING + (innerW - data.w * scale) / 2 - data.minX * scale;
  const offsetY = PADDING + (innerH - data.h * scale) / 2 - data.minY * scale;
  // Scale-bar physical length in feet (1 m = 3.28084 ft). Pick a round value
  // such that the bar is ~120 px on screen.
  const targetBarPx = 120;
  const ftPerPx = 1 / (scale * 3.28084);
  const rawFt = targetBarPx * ftPerPx;
  // Round to a nice number (1, 2, 5, 10, 20, 50, 100 ft)
  const niceSteps = [1, 2, 5, 10, 20, 50, 100];
  let scaleBarFt = niceSteps[0];
  for (const s of niceSteps) {
    if (s <= rawFt) scaleBarFt = s;
  }
  const scaleBarPx = scaleBarFt * 3.28084 * scale;
  const project = (x: number, y: number) => [
    x * scale + offsetX,
    y * scale + offsetY,
  ];

  // Centroid of all polygons (for the headline area label)
  const allM = data.polysM.flat();
  const cm = allM.reduce(
    (acc, v) => ({ x: acc.x + v.x / allM.length, y: acc.y + v.y / allM.length }),
    { x: 0, y: 0 },
  );
  const [cmx, cmy] = project(cm.x, cm.y);

  const slopeMult =
    pitchDegrees != null && pitchDegrees > 0 && pitchDegrees < 60
      ? 1 / Math.cos((pitchDegrees * Math.PI) / 180)
      : 1.118;
  const surfaceSqft = totalRoofSqft ?? Math.round(data.footprintSqft * slopeMult);

  // Track placed label rects (in SVG viewbox coords) so successive labels
  // don't overlap each other. We also use the polygon outline itself as a
  // forbidden zone so labels sit clearly outside the eaves.
  const placedLabelRects: Rect[] = [];

  // Per-facet centroid (in SVG coords) — anchor for the pitch arrow + label
  const facetCentroids = data.polysM.map((poly) => {
    const cx = poly.reduce((s, v) => s + v.x, 0) / poly.length;
    const cy = poly.reduce((s, v) => s + v.y, 0) / poly.length;
    const [px, py] = project(cx, cy);
    return { x: px, y: py };
  });
  const today = new Date().toLocaleDateString();
  const drawingScale = `1" = ${Math.round(ftPerPx * 96)}'`;
  void drawingScale;

  return (
    <div className="glass rounded-3xl overflow-hidden border border-white/[0.07]">
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.05]">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-cy-300/10 border border-cy-300/20 flex items-center justify-center text-cy-300">
            <Ruler size={12} />
          </div>
          <div>
            <div className="font-display font-semibold tracking-tight text-[13px]">
              Roof blueprint
            </div>
            <div className="text-[10px] font-mono uppercase tracking-[0.14em] text-slate-500 -mt-0.5">
              measured outline · CAD view
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sourceLabel && <span className="chip chip-accent">{sourceLabel}</span>}
          {polygons && polygons.length > 0 && (
            <button
              type="button"
              onClick={() =>
                downloadDxf(
                  { polygons, address, pitchLabel, withDimensions: true },
                  `voxaris-pitch-roof-plan${address ? "-" + address.replace(/[^a-z0-9]/gi, "_").slice(0, 32) : ""}.dxf`,
                )
              }
              className="btn btn-ghost py-1.5 px-3 text-[12px]"
              title="Download CAD-compatible plan (.dxf — opens in AutoCAD, Revit, BricsCAD, etc.)"
            >
              <Download size={12} /> .dxf
            </button>
          )}
        </div>
      </div>

      <div className="relative" style={{ background: "#070a10" }}>
        {/* Subtle blueprint grid — drawn as a CSS background pattern */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(rgba(103,220,255,0.06) 1px, transparent 1px) 0 0/24px 24px",
            opacity: 0.7,
          }}
        />
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          xmlns="http://www.w3.org/2000/svg"
          className={`relative w-full h-auto ${editing ? "blueprint-pulse" : ""}`}
          style={{ maxHeight: "480px" }}
        >
          {/* CAD drawing border — heavy outer frame + inset hairline (architectural convention) */}
          <rect
            x={DRAWING_INSET}
            y={DRAWING_INSET}
            width={VB_W - DRAWING_INSET * 2}
            height={VB_H - DRAWING_INSET * 2}
            fill="none"
            stroke="rgba(103,220,255,0.55)"
            strokeWidth="1.5"
          />
          <rect
            x={DRAWING_INSET + 4}
            y={DRAWING_INSET + 4}
            width={VB_W - DRAWING_INSET * 2 - 8}
            height={VB_H - DRAWING_INSET * 2 - 8}
            fill="none"
            stroke="rgba(103,220,255,0.20)"
            strokeWidth="0.6"
          />

          {/* Compass rose */}
          <g transform={`translate(${VB_W - 60}, 60)`} fill="rgba(180,200,220,0.45)">
            <circle r="22" fill="rgba(7,10,16,0.6)" stroke="rgba(103,220,255,0.25)" strokeWidth="1" />
            <text x="0" y="-9" textAnchor="middle" fontSize="9" fontFamily="ui-monospace, monospace" fill="#67dcff">N</text>
            <line x1="0" y1="-3" x2="0" y2="-16" stroke="#67dcff" strokeWidth="1.5" />
            <text x="0" y="20" textAnchor="middle" fontSize="8" fontFamily="ui-monospace, monospace">S</text>
            <text x="-15" y="3" textAnchor="middle" fontSize="8" fontFamily="ui-monospace, monospace">W</text>
            <text x="15" y="3" textAnchor="middle" fontSize="8" fontFamily="ui-monospace, monospace">E</text>
          </g>

          {data.polyEdges.map((edges, polyIdx) => {
            const palette = PALETTE[polyIdx % PALETTE.length];
            const projected = edges.map(({ x1, y1, x2, y2 }) => {
              const [px1, py1] = project(x1, y1);
              const [px2, py2] = project(x2, y2);
              return { x1: px1, y1: py1, x2: px2, y2: py2 };
            });
            const points = projected.map((e) => `${e.x1},${e.y1}`).join(" ");

            return (
              <g key={polyIdx}>
                {/* Filled polygon (subtle) */}
                <polygon
                  points={points}
                  fill={palette.fill}
                  stroke={palette.stroke}
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                {/* Edge length labels — placed on the true edge normal,
                    flipped to whichever side is outside the polygon, then
                    checked against already-placed labels to avoid overlap. */}
                {(() => {
                  const polyPts = projected.map((q) => ({ x: q.x1, y: q.y1 }));
                  return edges.map((e, i) => {
                    if (e.ft < 4) return null; // skip tiny edges
                    const p = projected[i];
                    const mx = (p.x1 + p.x2) / 2;
                    const my = (p.y1 + p.y2) / 2;
                    const dx = p.x2 - p.x1;
                    const dy = p.y2 - p.y1;
                    const len = Math.hypot(dx, dy) || 1;
                    // True edge normal — rotate (dx,dy) 90°. Either (dy,-dx)
                    // or (-dy,dx) points outside the polygon; pick the one
                    // whose probe point lands OUTSIDE.
                    const nx = dy / len;
                    const ny = -dx / len;
                    const probe = { x: mx + nx * 0.5, y: my + ny * 0.5 };
                    const outside = !pointInPoly(probe, polyPts);
                    const sx = outside ? nx : -nx;
                    const sy = outside ? ny : -ny;

                    const ftLabel = `${Math.round(e.ft)} ft`;
                    const labelW = ftLabel.length * 6.2 + 4;
                    const labelH = 12;

                    // Try increasing offsets so we don't collide with
                    // previously-placed labels on adjacent short edges.
                    let labelX = mx;
                    let labelY = my;
                    let placed = false;
                    for (const offset of [14, 22, 30, 40]) {
                      const tx = mx + sx * offset;
                      const ty = my + sy * offset;
                      const r: Rect = {
                        x: tx - labelW / 2,
                        y: ty - labelH / 2,
                        w: labelW,
                        h: labelH,
                      };
                      const collides = placedLabelRects.some((q) => rectsOverlap(q, r));
                      if (!collides) {
                        labelX = tx; labelY = ty; placedLabelRects.push(r);
                        placed = true;
                        break;
                      }
                    }
                    if (!placed) return null; // skip rather than overlap

                    // Edge angle for tilting label (kept upright)
                    let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                    if (angle > 90) angle -= 180;
                    if (angle < -90) angle += 180;
                    return (
                      <g key={`l-${i}`}>
                        <text
                          x={labelX}
                          y={labelY}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          transform={`rotate(${angle}, ${labelX}, ${labelY})`}
                          fontSize="10"
                          fontFamily="ui-monospace, SFMono-Regular, monospace"
                          fontWeight="600"
                          fill={palette.stroke}
                          opacity="0.85"
                        >
                          {ftLabel}
                        </text>
                      </g>
                    );
                  });
                })()}
              </g>
            );
          })}

          {/* Pitch arrows on each facet — convention: arrow points UP-SLOPE
              (toward the ridge), with rise/run ratio next to it */}
          {pitchLabel && facetCentroids.map((c, i) => (
            <g key={`p-${i}`} transform={`translate(${c.x}, ${c.y})`} opacity="0.85">
              {/* Upward-pointing pitch arrow (always pointing up in plan view —
                  in v2 we'd rotate per-facet azimuth) */}
              <line
                x1="-9" y1="6" x2="-9" y2="-12"
                stroke="rgba(103,220,255,0.85)"
                strokeWidth="1.2"
              />
              <polygon
                points="-9,-15 -12,-9 -6,-9"
                fill="rgba(103,220,255,0.85)"
              />
              {/* Pitch ratio label */}
              <text
                x="-2" y="-3"
                textAnchor="start"
                fontSize="9"
                fontFamily="ui-monospace, monospace"
                fontWeight="600"
                fill="rgba(103,220,255,0.95)"
              >
                {pitchLabel}
              </text>
            </g>
          ))}

          {/* Scale bar — bottom-left, inside the drawing area but above the title block */}
          <g transform={`translate(${PADDING}, ${VB_H - TITLE_BLOCK_H - 28})`}>
            <text
              x="0" y="-6"
              fontSize="8"
              fontFamily="ui-monospace, monospace"
              fill="rgba(180,200,220,0.65)"
              letterSpacing="1.2"
            >
              SCALE
            </text>
            {/* Bar outline */}
            <rect
              x="0" y="0"
              width={scaleBarPx} height="6"
              fill="none"
              stroke="rgba(103,220,255,0.6)"
              strokeWidth="0.8"
            />
            {/* Alternating fill segments (5 ticks) */}
            {Array.from({ length: 5 }).map((_, i) => (
              <rect
                key={i}
                x={(scaleBarPx / 5) * i}
                y="0"
                width={scaleBarPx / 5}
                height="6"
                fill={i % 2 === 0 ? "rgba(103,220,255,0.55)" : "transparent"}
              />
            ))}
            <text
              x="0" y="20"
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill="rgba(220,230,245,0.85)"
            >
              0
            </text>
            <text
              x={scaleBarPx} y="20"
              textAnchor="end"
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill="rgba(220,230,245,0.85)"
            >
              {scaleBarFt} ft
            </text>
          </g>

          {/* Title block — bottom strip, 4-column layout: project | scale | sheet | date */}
          <g transform={`translate(0, ${VB_H - TITLE_BLOCK_H})`}>
            <rect
              x={DRAWING_INSET + 4}
              y={0}
              width={VB_W - DRAWING_INSET * 2 - 8}
              height={TITLE_BLOCK_H - 4}
              fill="rgba(7,10,16,0.7)"
              stroke="rgba(103,220,255,0.45)"
              strokeWidth="1"
            />
            {/* Vertical dividers */}
            {[0.55, 0.72, 0.86].map((p, i) => (
              <line
                key={i}
                x1={DRAWING_INSET + 4 + (VB_W - DRAWING_INSET * 2 - 8) * p}
                y1={0}
                x2={DRAWING_INSET + 4 + (VB_W - DRAWING_INSET * 2 - 8) * p}
                y2={TITLE_BLOCK_H - 4}
                stroke="rgba(103,220,255,0.30)"
                strokeWidth="0.8"
              />
            ))}
            {/* Column 1: Project */}
            <g transform={`translate(${DRAWING_INSET + 18}, 0)`}>
              <text
                x="0" y="14"
                fontSize="7.5"
                fontFamily="ui-monospace, monospace"
                fill="rgba(103,220,255,0.7)"
                letterSpacing="1.4"
              >
                PROJECT
              </text>
              <text
                x="0" y="32"
                fontSize="11"
                fontFamily="ui-monospace, monospace"
                fontWeight="700"
                fill="#e6edf5"
              >
                Roof Replacement — Plan View
              </text>
              <text
                x="0" y="46"
                fontSize="9"
                fontFamily="ui-monospace, monospace"
                fill="rgba(180,200,220,0.7)"
              >
                {address ? (address.length > 56 ? address.slice(0, 56) + "…" : address) : "—"}
              </text>
            </g>
            {/* Column 2: Scale */}
            <g transform={`translate(${DRAWING_INSET + 4 + (VB_W - DRAWING_INSET * 2 - 8) * 0.55 + 14}, 0)`}>
              <text x="0" y="14" fontSize="7.5" fontFamily="ui-monospace, monospace" fill="rgba(103,220,255,0.7)" letterSpacing="1.4">
                SCALE
              </text>
              <text x="0" y="34" fontSize="13" fontFamily="ui-monospace, monospace" fontWeight="700" fill="#e6edf5">
                1 ▭ = {scaleBarFt} ft
              </text>
            </g>
            {/* Column 3: Sheet */}
            <g transform={`translate(${DRAWING_INSET + 4 + (VB_W - DRAWING_INSET * 2 - 8) * 0.72 + 14}, 0)`}>
              <text x="0" y="14" fontSize="7.5" fontFamily="ui-monospace, monospace" fill="rgba(103,220,255,0.7)" letterSpacing="1.4">
                SHEET
              </text>
              <text x="0" y="34" fontSize="13" fontFamily="ui-monospace, monospace" fontWeight="700" fill="#e6edf5">
                A-1.0
              </text>
            </g>
            {/* Column 4: Date / Drawn-by */}
            <g transform={`translate(${DRAWING_INSET + 4 + (VB_W - DRAWING_INSET * 2 - 8) * 0.86 + 14}, 0)`}>
              <text x="0" y="14" fontSize="7.5" fontFamily="ui-monospace, monospace" fill="rgba(103,220,255,0.7)" letterSpacing="1.4">
                DATE
              </text>
              <text x="0" y="34" fontSize="11" fontFamily="ui-monospace, monospace" fontWeight="700" fill="#e6edf5">
                {today}
              </text>
            </g>
          </g>

          {/* Center area label */}
          <g transform={`translate(${cmx}, ${cmy})`}>
            <rect
              x="-72"
              y="-22"
              width="144"
              height="44"
              rx="10"
              ry="10"
              fill="rgba(7,10,16,0.85)"
              stroke="rgba(103,220,255,0.35)"
              strokeWidth="1"
            />
            <text
              x="0"
              y="-5"
              textAnchor="middle"
              fontSize="9"
              fontFamily="ui-monospace, monospace"
              fill="rgba(180,200,220,0.6)"
              letterSpacing="1.5"
            >
              ROOF AREA
            </text>
            <text
              x="0"
              y="14"
              textAnchor="middle"
              fontSize="18"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
              fontWeight="700"
              fill="#e6edf5"
            >
              {surfaceSqft.toLocaleString()} sf
            </text>
          </g>
        </svg>

        {/* Footer with hint */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.05] bg-black/40 text-[10px] font-mono uppercase tracking-[0.12em] text-slate-500">
          <span className="flex items-center gap-1.5">
            <Compass size={10} /> measurements estimated from polygon footprint
          </span>
          <span>{data.polyEdges.length} {data.polyEdges.length === 1 ? "facet" : "facets"}</span>
        </div>
      </div>

      <style jsx>{`
        @keyframes blueprintPulse {
          0%, 100% { filter: drop-shadow(0 0 0 rgba(103,220,255,0)); }
          50% { filter: drop-shadow(0 0 6px rgba(103,220,255,0.35)); }
        }
        .blueprint-pulse {
          animation: blueprintPulse 1.6s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}

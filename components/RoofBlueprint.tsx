"use client";

import { useMemo } from "react";
import { Compass, Ruler } from "lucide-react";

interface Props {
  /** Polygons in lat/lng space — same shape MapView consumes */
  polygons: Array<Array<{ lat: number; lng: number }>> | undefined;
  /** Optional total roof area in square feet for the centerpiece label.
   *  When omitted we compute footprint × 1.118 from the polygons. */
  totalRoofSqft?: number;
  /** When true, the polygon is being edited live — render a subtle pulse */
  editing?: boolean;
  /** Optional source label shown in the corner ("Solar · 4 facets", etc.) */
  sourceLabel?: string;
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

export default function RoofBlueprint({
  polygons,
  totalRoofSqft,
  editing,
  sourceLabel,
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

  // Layout: SVG viewbox is 1000×400. Scale roof to fit with padding.
  const VB_W = 1000;
  const VB_H = 400;
  const PADDING = 64;
  const innerW = VB_W - 2 * PADDING;
  const innerH = VB_H - 2 * PADDING;
  const scale = Math.min(innerW / data.w, innerH / data.h);
  const offsetX = PADDING + (innerW - data.w * scale) / 2 - data.minX * scale;
  const offsetY = PADDING + (innerH - data.h * scale) / 2 - data.minY * scale;
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

  const surfaceSqft = totalRoofSqft ?? Math.round(data.footprintSqft * 1.118);

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
        {sourceLabel && (
          <span className="chip chip-accent">{sourceLabel}</span>
        )}
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
          style={{ maxHeight: "420px" }}
        >
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
                {/* Edge length labels */}
                {edges.map((e, i) => {
                  if (e.ft < 4) return null; // skip tiny edges
                  const p = projected[i];
                  const mx = (p.x1 + p.x2) / 2;
                  const my = (p.y1 + p.y2) / 2;
                  // Outward normal so labels sit just outside the eave
                  const dx = p.x2 - p.x1;
                  const dy = p.y2 - p.y1;
                  const len = Math.hypot(dx, dy) || 1;
                  // Rotate (dx,dy) 90° clockwise → (dy, -dx) is the outward normal
                  // (assuming polygon is wound CCW after y-flip; some sources are CW
                  //  so we just push the label away from the polygon centroid)
                  const cx = projected.reduce((s, q) => s + q.x1, 0) / projected.length;
                  const cy = projected.reduce((s, q) => s + q.y1, 0) / projected.length;
                  const outx = mx - cx;
                  const outy = my - cy;
                  const olen = Math.hypot(outx, outy) || 1;
                  const labelX = mx + (outx / olen) * 14;
                  const labelY = my + (outy / olen) * 14;
                  // Edge angle for tilting label
                  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                  if (angle > 90) angle -= 180;
                  if (angle < -90) angle += 180;
                  const ftLabel = `${Math.round(e.ft)} ft`;
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
                })}
              </g>
            );
          })}

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

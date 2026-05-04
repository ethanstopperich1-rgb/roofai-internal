/**
 * Minimal DXF (AutoCAD Drawing Exchange Format) writer for roof polygons.
 *
 * AutoCAD R12 ASCII DXF — the most universally supported flavor. Output is
 * pure text and imports cleanly into AutoCAD, Revit, BricsCAD, LibreCAD,
 * Fusion 360, SketchUp (via plugin), and most BIM tools.
 *
 * We project lat/lng → local meters → convert to feet (CAD convention).
 * One LWPOLYLINE per facet, on layer ROOF. Per-edge dimensions printed
 * as TEXT entities on layer DIMENSIONS.
 */

const FT_PER_M = 3.28084;
const M_PER_DEG_LAT = 111_320;

export interface DxfExportOptions {
  polygons: Array<Array<{ lat: number; lng: number }>>;
  /** Address — written as a HEADER comment. */
  address?: string;
  /** Pitch label, e.g. "5/12". Written as comment. */
  pitchLabel?: string;
  /** When true, also write per-edge length labels as TEXT entities. */
  withDimensions?: boolean;
}

export function buildDxf({
  polygons,
  address,
  pitchLabel,
  withDimensions = true,
}: DxfExportOptions): string {
  if (!polygons.length) return "";
  // Project to local meters using centroid of all vertices
  const all = polygons.flat();
  const cLat = all.reduce((s, v) => s + v.lat, 0) / all.length;
  const cLng = all.reduce((s, v) => s + v.lng, 0) / all.length;
  const cosLat = Math.cos((cLat * Math.PI) / 180);

  const polysFt = polygons.map((p) =>
    p.map((v) => ({
      x: (v.lng - cLng) * M_PER_DEG_LAT * cosLat * FT_PER_M,
      // CAD convention: Y-up, north positive
      y: (v.lat - cLat) * M_PER_DEG_LAT * FT_PER_M,
    })),
  );

  const out: string[] = [];
  // Header
  out.push("999", `Voxaris Pitch — Roof Plan${address ? `: ${address}` : ""}`);
  if (pitchLabel) out.push("999", `Pitch: ${pitchLabel}`);
  out.push("0", "SECTION", "2", "HEADER");
  // Default units = decimal feet
  out.push("9", "$INSUNITS", "70", "2");
  out.push("0", "ENDSEC");

  // Tables: ROOF + DIMENSIONS layers
  out.push("0", "SECTION", "2", "TABLES");
  out.push("0", "TABLE", "2", "LAYER", "70", "2");
  out.push(
    "0", "LAYER",
    "2", "ROOF",
    "70", "0",
    "62", "5", // blue
    "6", "CONTINUOUS",
  );
  out.push(
    "0", "LAYER",
    "2", "DIMENSIONS",
    "70", "0",
    "62", "7", // white/black
    "6", "CONTINUOUS",
  );
  out.push("0", "ENDTAB", "0", "ENDSEC");

  // Entities — polylines + dimension text
  out.push("0", "SECTION", "2", "ENTITIES");

  for (const poly of polysFt) {
    if (poly.length < 3) continue;
    // LWPOLYLINE on ROOF layer
    out.push(
      "0", "LWPOLYLINE",
      "8", "ROOF",
      "62", "5",
      "90", String(poly.length),
      "70", "1", // closed
    );
    for (const v of poly) {
      out.push("10", v.x.toFixed(3), "20", v.y.toFixed(3));
    }
    if (!withDimensions) continue;
    // Per-edge length labels at midpoint
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 4) continue; // skip <4ft edges
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      out.push(
        "0", "TEXT",
        "8", "DIMENSIONS",
        "62", "7",
        "10", mx.toFixed(3),
        "20", my.toFixed(3),
        "30", "0.0",
        "40", "0.6", // 0.6 ft text height
        "1", `${Math.round(len)} ft`,
        "50", angle.toFixed(2),
        "72", "1", // center horiz
        "11", mx.toFixed(3),
        "21", my.toFixed(3),
        "31", "0.0",
      );
    }
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return out.join("\n");
}

export function downloadDxf(opts: DxfExportOptions, filename = "roof-plan.dxf") {
  const text = buildDxf(opts);
  const blob = new Blob([text], { type: "application/dxf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

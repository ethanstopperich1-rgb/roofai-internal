/**
 * Ground-truth eval harness.
 *
 * Loads every JSON file in scripts/eval-truth/, hits each polygon source
 * in the production pipeline (Solar, Solar mask, OSM building, Roboflow,
 * Microsoft Buildings, SAM-refine), and scores every source against the
 * hand-traced ground-truth polygon.
 *
 * Metrics:
 *   - IoU (Jaccard): 0–1, segmentation accuracy. >0.85 = excellent.
 *   - Area ratio: predicted_sqft / truth_sqft. 0.95–1.05 = great.
 *   - Hausdorff distance (m): worst-case edge offset. <2m = excellent.
 *
 * Usage:
 *   1. Start the dev server in one terminal: `npm run dev`
 *   2. In another terminal: `npm run eval:truth`
 *
 * The script hits localhost:3000 (configurable via EVAL_BASE_URL) so it
 * exercises the actual API routes — same code paths the production
 * pipeline runs.
 *
 * Hand-trace ground-truth polygons via the `/eval-trace` page in the app.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { polygonIoU, polygonAreaSqft } from "../lib/polygon";

const BASE_URL = process.env.EVAL_BASE_URL || "http://localhost:3000";
const TRUTH_DIR = join(process.cwd(), "scripts", "eval-truth");

type LatLng = { lat: number; lng: number };

interface GroundTruth {
  slug: string;
  address: string | null;
  lat: number;
  lng: number;
  polygon: LatLng[];
  notes?: string | null;
}

interface SourceResult {
  source: string;
  polygon: LatLng[] | null;
  errorMessage?: string;
  durationMs: number;
}

interface ScoredSource extends SourceResult {
  iou: number | null;
  areaRatio: number | null;
  hausdorffM: number | null;
}

function loadGroundTruths(): GroundTruth[] {
  if (!existsSync(TRUTH_DIR)) return [];
  const files = readdirSync(TRUTH_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        const data = JSON.parse(readFileSync(join(TRUTH_DIR, f), "utf8"));
        if (
          typeof data.lat === "number" &&
          typeof data.lng === "number" &&
          Array.isArray(data.polygon) &&
          data.polygon.length >= 3
        ) {
          return data as GroundTruth;
        }
      } catch {
        /* skip malformed */
      }
      return null;
    })
    .filter((g): g is GroundTruth => g != null);
}

/**
 * Hausdorff distance in meters: max over all edges of the predicted polygon
 * of (distance from the closest point on any edge of the truth polygon).
 * Symmetrized — we take max of both directions. Captures worst-case edge
 * misalignment in a way IoU averages over.
 */
function hausdorffM(a: LatLng[], b: LatLng[]): number {
  if (a.length < 3 || b.length < 3) return Infinity;
  const cLat = (a[0].lat + b[0].lat) / 2;
  const cLng = (a[0].lng + b[0].lng) / 2;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const M = 111_320;

  const project = (poly: LatLng[]) =>
    poly.map((v) => [
      (v.lng - cLng) * M * cosLat,
      (v.lat - cLat) * M,
    ] as [number, number]);

  const A = project(a);
  const B = project(b);

  const distPointToSegment = (
    p: [number, number],
    s1: [number, number],
    s2: [number, number],
  ): number => {
    const dx = s2[0] - s1[0];
    const dy = s2[1] - s1[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return Math.hypot(p[0] - s1[0], p[1] - s1[1]);
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - s1[0]) * dx + (p[1] - s1[1]) * dy) / len2),
    );
    const cx = s1[0] + t * dx;
    const cy = s1[1] + t * dy;
    return Math.hypot(p[0] - cx, p[1] - cy);
  };

  const distPointToPolyEdges = (p: [number, number], poly: [number, number][]) => {
    let min = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const d = distPointToSegment(p, poly[i], poly[(i + 1) % poly.length]);
      if (d < min) min = d;
    }
    return min;
  };

  let maxAB = 0;
  for (const p of A) {
    const d = distPointToPolyEdges(p, B);
    if (d > maxAB) maxAB = d;
  }
  let maxBA = 0;
  for (const p of B) {
    const d = distPointToPolyEdges(p, A);
    if (d > maxBA) maxBA = d;
  }
  return Math.max(maxAB, maxBA);
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

/**
 * Hit each polygon source's HTTP endpoint independently. None of these
 * should throw; the source returns null on any failure (no coverage,
 * timeout, etc.). We score "no result" as a separate bucket from "wrong
 * result" because the priority chain falls through silently — a 0% hit
 * rate on Solar in rural areas is fine; what matters is whether
 * Roboflow / SAM cover that gap.
 */
async function fetchAllSources(gt: GroundTruth): Promise<SourceResult[]> {
  const { lat, lng } = gt;
  const Q = `lat=${lat}&lng=${lng}`;

  // Solar mask (Project Sunroof's photogrammetric roof segmentation)
  const solarMask = await timed(async (): Promise<LatLng[] | null> => {
    const data = (await fetchJson(`${BASE_URL}/api/solar-mask?${Q}`)) as {
      latLng?: LatLng[];
    } | null;
    return data?.latLng && data.latLng.length >= 3 ? data.latLng : null;
  });

  // OSM building footprint
  const osm = await timed(async (): Promise<LatLng[] | null> => {
    const data = (await fetchJson(`${BASE_URL}/api/building?${Q}`)) as {
      latLng?: LatLng[];
    } | null;
    return data?.latLng && data.latLng.length >= 3 ? data.latLng : null;
  });

  // Roboflow Satellite Rooftop Map v3
  const roboflow = await timed(async (): Promise<LatLng[] | null> => {
    const data = (await fetchJson(`${BASE_URL}/api/roboflow?${Q}`)) as {
      polygon?: LatLng[];
    } | null;
    return data?.polygon && data.polygon.length >= 3 ? data.polygon : null;
  });

  // Microsoft Buildings (Nashville-bbox-only at the moment)
  const msBuildings = await timed(async (): Promise<LatLng[] | null> => {
    const data = (await fetchJson(`${BASE_URL}/api/microsoft-building?${Q}`)) as {
      polygon?: LatLng[];
    } | null;
    return data?.polygon && data.polygon.length >= 3 ? data.polygon : null;
  });

  // SAM-refine (Replicate; slow ~5–10s)
  const sam = await timed(async (): Promise<LatLng[] | null> => {
    const data = (await postJson(`${BASE_URL}/api/sam-refine`, { lat, lng })) as {
      polygon?: LatLng[];
    } | null;
    return data?.polygon && data.polygon.length >= 3 ? data.polygon : null;
  });

  return [
    { source: "solar-mask", polygon: solarMask.result, durationMs: solarMask.ms },
    { source: "roboflow", polygon: roboflow.result, durationMs: roboflow.ms },
    { source: "sam-refine", polygon: sam.result, durationMs: sam.ms },
    { source: "ms-buildings", polygon: msBuildings.result, durationMs: msBuildings.ms },
    { source: "osm", polygon: osm.result, durationMs: osm.ms },
  ];
}

function scoreSource(src: SourceResult, truth: LatLng[]): ScoredSource {
  if (!src.polygon) {
    return { ...src, iou: null, areaRatio: null, hausdorffM: null };
  }
  const iou = polygonIoU(src.polygon, truth);
  const truthSqft = polygonAreaSqft(truth);
  const predSqft = polygonAreaSqft(src.polygon);
  const areaRatio = truthSqft > 0 ? predSqft / truthSqft : null;
  const haus = hausdorffM(src.polygon, truth);
  return {
    ...src,
    iou,
    areaRatio,
    hausdorffM: isFinite(haus) ? haus : null,
  };
}

function fmt(n: number | null, digits: number = 2): string {
  if (n == null || !isFinite(n)) return "  —  ";
  return n.toFixed(digits);
}

function pad(s: string, w: number, right: boolean = false): string {
  if (s.length >= w) return s.slice(0, w);
  const padding = " ".repeat(w - s.length);
  return right ? padding + s : s + padding;
}

function printPerAddress(gt: GroundTruth, scored: ScoredSource[]) {
  const truthSqft = polygonAreaSqft(gt.polygon);
  console.log(
    `\n${gt.slug}  (${gt.address ?? `${gt.lat.toFixed(5)},${gt.lng.toFixed(5)}`})`,
  );
  console.log(`  truth: ${truthSqft.toFixed(0)} sqft, ${gt.polygon.length} verts`);
  console.log(
    `  ${pad("source", 16)}  ${pad("IoU", 6, true)}  ${pad("AreaRatio", 10, true)}  ${pad("Hausdorff_m", 12, true)}  ${pad("ms", 6, true)}`,
  );
  console.log(`  ${"-".repeat(60)}`);
  for (const s of scored) {
    const flag = s.polygon ? "" : "  (no result)";
    console.log(
      `  ${pad(s.source, 16)}  ${pad(fmt(s.iou), 6, true)}  ${pad(fmt(s.areaRatio), 10, true)}  ${pad(fmt(s.hausdorffM, 1), 12, true)}  ${pad(String(s.durationMs), 6, true)}${flag}`,
    );
  }
}

function printSummary(rows: Array<{ slug: string; scored: ScoredSource[] }>) {
  const sources = ["solar-mask", "roboflow", "sam-refine", "ms-buildings", "osm"];
  console.log("\n\n========= SUMMARY =========\n");
  console.log(
    `${pad("source", 16)}  ${pad("hits", 6, true)}  ${pad("avg IoU", 8, true)}  ${pad("p50 IoU", 8, true)}  ${pad("p90 IoU", 8, true)}  ${pad("avg Area×", 9, true)}  ${pad("avg Haus_m", 11, true)}`,
  );
  console.log("-".repeat(78));

  for (const source of sources) {
    const scoredFor = rows
      .map((r) => r.scored.find((s) => s.source === source))
      .filter((s): s is ScoredSource => !!s && s.polygon != null);
    const ious = scoredFor
      .map((s) => s.iou)
      .filter((v): v is number => v != null && isFinite(v))
      .sort((a, b) => a - b);
    const ratios = scoredFor
      .map((s) => s.areaRatio)
      .filter((v): v is number => v != null && isFinite(v));
    const hauses = scoredFor
      .map((s) => s.hausdorffM)
      .filter((v): v is number => v != null && isFinite(v));

    const avg = (xs: number[]) =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
    const pctile = (xs: number[], p: number) => {
      if (xs.length === 0) return null;
      const idx = Math.min(xs.length - 1, Math.floor((xs.length - 1) * p));
      return xs[idx];
    };

    console.log(
      `${pad(source, 16)}  ${pad(`${scoredFor.length}/${rows.length}`, 6, true)}  ${pad(fmt(avg(ious)), 8, true)}  ${pad(fmt(pctile(ious, 0.5)), 8, true)}  ${pad(fmt(pctile(ious, 0.9)), 8, true)}  ${pad(fmt(avg(ratios)), 9, true)}  ${pad(fmt(avg(hauses), 1), 11, true)}`,
    );
  }
  console.log("\nLegend:");
  console.log("  IoU      — Intersection-over-Union vs ground truth (1.0 = perfect)");
  console.log("  AreaRatio — predicted_sqft / truth_sqft (1.0 = perfect)");
  console.log("  Haus_m   — Hausdorff distance, worst-case edge offset (lower = better)");
  console.log("  hits     — count of addresses where the source returned a polygon");
  console.log("");
}

async function main() {
  const truths = loadGroundTruths();
  if (truths.length === 0) {
    console.error(
      `No ground truth files found in ${TRUTH_DIR}.\n` +
        `Hand-trace some via the /eval-trace page first, then re-run.`,
    );
    process.exit(1);
  }

  console.log(
    `Running eval against ${truths.length} ground-truth address${truths.length === 1 ? "" : "es"} via ${BASE_URL}\n`,
  );

  const rows: Array<{ slug: string; scored: ScoredSource[] }> = [];
  for (const gt of truths) {
    const sources = await fetchAllSources(gt);
    const scored = sources.map((s) => scoreSource(s, gt.polygon));
    printPerAddress(gt, scored);
    rows.push({ slug: gt.slug, scored });
  }

  printSummary(rows);
}

main().catch((err) => {
  console.error("eval-truth failed:", err);
  process.exit(1);
});

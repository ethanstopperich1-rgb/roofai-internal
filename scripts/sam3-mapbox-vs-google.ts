/**
 * SAM3 imagery-source comparison test.
 *
 * Fetches the same lat/lng tile from BOTH Mapbox and Google Static Maps,
 * runs each through the SAM3 Roboflow workflow, then prints polygon
 * pixel-area + lat/lng-area + boundary stats for comparison.
 *
 * Usage:
 *   pnpm tsx scripts/sam3-mapbox-vs-google.ts
 *
 * Env (loaded from .env.production):
 *   MAPBOX_ACCESS_TOKEN, GOOGLE_SERVER_KEY, ROBOFLOW_API_KEY
 *
 * Target: 813 Summerwood, Jupiter FL (the over-trace case)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Load .env.production manually (no dotenv dep)
const envFile = path.resolve(process.cwd(), ".env.production");
for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const LAT = 26.9325;
const LNG = -80.108;
const ZOOM = 20;
const SCALE = 2;
const SIZE_PX = 640;
const WORKFLOW_URL =
  process.env.ROBOFLOW_SAM3_WORKFLOW_URL ??
  "https://serverless.roboflow.com/infer/workflows/bradens-workspace/sam3-roof-segmentation-test-1778124556737";
const PROMPT = process.env.ROBOFLOW_SAM3_PROMPT ?? "entire house roof";
const CONFIDENCE = Number(process.env.ROBOFLOW_SAM3_CONFIDENCE ?? "0.3");

type TileBytes = { base64: string; mimeType: string; bytes: number };

async function fetchMapbox(): Promise<TileBytes> {
  const t = process.env.MAPBOX_ACCESS_TOKEN!;
  const retina = SCALE === 2 ? "@2x" : "";
  const url =
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/` +
    `${LNG},${LAT},${ZOOM}/${SIZE_PX}x${SIZE_PX}${retina}` +
    `?access_token=${t}&attribution=false&logo=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mapbox ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: "image/jpeg", bytes: buf.length };
}

async function fetchGoogle(): Promise<TileBytes> {
  const k = process.env.GOOGLE_SERVER_KEY!;
  const url =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${LAT},${LNG}&zoom=${ZOOM}&size=${SIZE_PX}x${SIZE_PX}` +
    `&scale=${SCALE}&maptype=satellite&key=${k}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`google ${res.status}: ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: "image/png", bytes: buf.length };
}

type Pred = {
  points?: Array<{ x: number; y: number }>;
  confidence?: number;
  class?: string;
};

async function runSam3(tile: TileBytes, label: string): Promise<{
  predictions: Pred[];
  imageWidth: number;
  imageHeight: number;
  raw: unknown;
}> {
  const apiKey = process.env.ROBOFLOW_API_KEY!;
  const body = {
    api_key: apiKey,
    inputs: {
      image: { type: "base64", value: tile.base64 },
      prompt: PROMPT,
      confidence: CONFIDENCE,
    },
  };
  const res = await fetch(WORKFLOW_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`roboflow[${label}] ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { outputs?: unknown[] };

  // Walk outputs[] looking for predictions[]
  let predictions: Pred[] = [];
  let imageWidth = SIZE_PX * SCALE;
  let imageHeight = SIZE_PX * SCALE;

  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const o = node as Record<string, unknown>;
    if (Array.isArray(o.predictions)) {
      predictions = o.predictions as Pred[];
      if (o.image && typeof o.image === "object") {
        const img = o.image as Record<string, unknown>;
        if (typeof img.width === "number") imageWidth = img.width;
        if (typeof img.height === "number") imageHeight = img.height;
      }
      return true;
    }
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) {
        for (const item of v) if (walk(item)) return true;
      } else if (walk(v)) return true;
    }
    return false;
  };
  walk(json);
  return { predictions, imageWidth, imageHeight, raw: json };
}

function shoelacePx(pts: Array<{ x: number; y: number }>): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

function pixelAreaToSqft(areaPx: number, lat: number, zoom: number, scale: number, tilePx: number, imgPx: number): number {
  // Meters per pixel at the tile we requested
  const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom + scale - 1);
  // If workflow resized image, the effective m/px is scaled
  const effMPerPx = mPerPx * (tilePx / imgPx);
  const areaM2 = areaPx * effMPerPx * effMPerPx;
  return areaM2 * 10.7639;
}

async function main() {
  console.log(`\n=== SAM3 Mapbox vs Google comparison ===`);
  console.log(`Target: 813 Summerwood, Jupiter (${LAT}, ${LNG})`);
  console.log(`Zoom ${ZOOM} scale ${SCALE} (${SIZE_PX * SCALE}px tile)`);
  console.log(`Prompt: "${PROMPT}"  confidence: ${CONFIDENCE}`);
  console.log(`Workflow: ${WORKFLOW_URL}\n`);

  console.log("Fetching tiles...");
  const hasMapbox = !!process.env.MAPBOX_ACCESS_TOKEN;
  const google = await fetchGoogle();
  const mapbox = hasMapbox ? await fetchMapbox() : null;
  if (!hasMapbox) {
    console.log("  (no MAPBOX_ACCESS_TOKEN set — Google-only run)");
  }
  if (mapbox) console.log(`  Mapbox: ${mapbox.bytes} bytes (${mapbox.mimeType})`);
  console.log(`  Google: ${google.bytes} bytes (${google.mimeType})`);

  // Save tiles for visual inspection
  if (mapbox) fs.writeFileSync("/tmp/sam3-mapbox-tile.jpg", Buffer.from(mapbox.base64, "base64"));
  fs.writeFileSync("/tmp/sam3-google-tile.png", Buffer.from(google.base64, "base64"));
  console.log(`  → saved tile(s) to /tmp\n`);

  console.log("Running SAM3...");
  const ggRes = await runSam3(google, "google");
  const mbRes = mapbox ? await runSam3(mapbox, "mapbox") : null;

  const tilePx = SIZE_PX * SCALE;

  const summarize = (label: string, r: typeof mbRes) => {
    console.log(`\n--- ${label} ---`);
    if (!r) { console.log("  (no result)"); return; }
    console.log(`  Image dims: ${r.imageWidth} x ${r.imageHeight}`);
    console.log(`  Predictions: ${r.predictions.length}`);
    if (r.predictions.length === 0) {
      console.log(`  → NO POLYGON RETURNED`);
      return;
    }
    // Sort by area descending, show top 3
    const sorted = r.predictions
      .map((p, i) => ({
        idx: i,
        cls: p.class ?? "?",
        conf: p.confidence ?? null,
        nPts: p.points?.length ?? 0,
        areaPx: p.points ? shoelacePx(p.points) : 0,
      }))
      .sort((a, b) => b.areaPx - a.areaPx);
    for (const s of sorted.slice(0, 3)) {
      const sqft = pixelAreaToSqft(s.areaPx, LAT, ZOOM, SCALE, tilePx, r.imageWidth);
      console.log(
        `  [${s.idx}] class=${s.cls} conf=${s.conf?.toFixed(3) ?? "—"} ` +
          `pts=${s.nPts} areaPx=${s.areaPx.toFixed(0)} → ~${sqft.toFixed(0)} sqft`,
      );
    }
    const top = sorted[0];
    if (top) {
      const sqft = pixelAreaToSqft(top.areaPx, LAT, ZOOM, SCALE, tilePx, r.imageWidth);
      console.log(`  WINNER: ~${sqft.toFixed(0)} sqft (${top.nPts} vertices)`);
    }
  };

  summarize("GOOGLE", ggRes);
  if (mbRes) summarize("MAPBOX", mbRes);

  // Save raw JSON for deeper inspection
  if (mbRes) fs.writeFileSync("/tmp/sam3-mapbox.json", JSON.stringify(mbRes.raw, null, 2));
  fs.writeFileSync("/tmp/sam3-google.json", JSON.stringify(ggRes.raw, null, 2));
  console.log(`\nRaw JSON saved: /tmp/sam3-mapbox.json /tmp/sam3-google.json`);

  // EagleView ground truth: 3651 sqft
  console.log(`\nGround truth (EagleView): 3,651 sqft`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

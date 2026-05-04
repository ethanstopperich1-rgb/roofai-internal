/**
 * Eval harness — runs the candidate Roboflow models against a list of
 * test addresses and dumps a side-by-side comparison.
 *
 * For each (address, model) pair it produces:
 *   - the raw inference response (predictions count, classes, confidences)
 *   - the cleaned RoboflowResult (post-confidence + proximity filter)
 *   - a PNG with the satellite tile + each polygon drawn over it
 *
 * Usage:
 *   npx tsx scripts/eval-roboflow.ts
 *
 * Env required:
 *   ROBOFLOW_API_KEY
 *   GOOGLE_SERVER_KEY  (or NEXT_PUBLIC_GOOGLE_MAPS_KEY as a fallback)
 *
 * Tweak the `ADDRESSES` constant below to point at your own failing
 * addresses — the more variety in roof type (gable / hip / L-shape /
 * complex), the more diagnostic the comparison.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

import {
  refineRoofWithRoboflow,
  CANDIDATE_MODELS,
  type RoboflowModel,
  type RoboflowResult,
} from "../lib/roboflow";

// ---------- env loading (no dotenv dep — keeps the script standalone) ----------

function loadEnvLocal() {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}
loadEnvLocal();

// ---------- inputs ----------

interface TestAddress {
  label: string;
  lat: number;
  lng: number;
  expectedRoofType?: string;
  notes?: string;
}

// Default test set spans roof complexity. Replace with your own failing
// addresses for diagnostic value — random suburban houses tell us about
// average-case behavior, not edge cases that are actually breaking.
const ADDRESSES: TestAddress[] = [
  {
    label: "tn-carefree-ln",
    lat: 36.0447191,
    lng: -86.5972602,
    expectedRoofType: "complex hip with multiple wings",
    notes: "2144 Carefree Ln, Antioch TN — failure case: tiles3d-vision returns a tilted rectangle instead of tracing the actual hip-roof outline",
  },
  {
    label: "tn-canterbury-chase",
    lat: 35.7824891,
    lng: -86.4763514,
    notes: "2319 Canterbury Chase, Murfreesboro TN — accurate at first, then a higher-priority slower source overrode with worse polygon",
  },
  {
    label: "tn-henley-rd",
    lat: 36.0685499,
    lng: -86.4750351,
    notes: "5385 Henley Rd, Mt. Juliet TN — Roboflow returned NOTHING in production; system fell through to ai then tiles3d-vision (both useless). Diagnose why.",
  },
];

// Trim to the winning model from the bake-off — Roof Seg 2 returned nothing
// on Carefree Ln, Roof Segmentation Final traced the wrong house. Keep the
// others around for future eval runs but skip them by default.
const ACTIVE_MODEL_KEYS = new Set(["satelliteRooftopMap"]);

const MODELS: Array<[string, RoboflowModel]> = Object.entries(CANDIDATE_MODELS)
  .filter(([key]) => ACTIVE_MODEL_KEYS.has(key));

// ---------- helpers ----------

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

async function fetchSatelliteTile(opts: {
  lat: number;
  lng: number;
  apiKey: string;
}): Promise<Buffer | null> {
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${opts.lat},${opts.lng}&zoom=20&size=640x640&scale=2&maptype=satellite&key=${opts.apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    console.error(`  satellite tile fetch failed: ${res.status}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

/** SVG overlay of polygon(s) over a 1280×1280 tile for visual comparison. */
function buildOverlaySvg(polygons: Array<Array<[number, number]>>, width = 1280): string {
  const colors = ["#ff3b30", "#34c759", "#007aff", "#ff9500", "#af52de"];
  const paths = polygons
    .map((poly, i) => {
      const d = poly.map(([x, y], j) => `${j === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ") + " Z";
      const stroke = colors[i % colors.length];
      return `<path d="${d}" fill="${stroke}33" stroke="${stroke}" stroke-width="3" />`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="0 0 ${width} ${width}">${paths}</svg>`;
}

async function compositeOverlay(
  tilePng: Buffer,
  polygons: Array<Array<[number, number]>>,
  outPath: string,
) {
  const svg = Buffer.from(buildOverlaySvg(polygons));
  await sharp(tilePng)
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toFile(outPath);
}

// ---------- main ----------

async function main() {
  const roboflowKey = process.env.ROBOFLOW_API_KEY;
  const googleKey =
    process.env.GOOGLE_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;

  if (!roboflowKey) {
    console.error("ROBOFLOW_API_KEY missing — set it in .env.local");
    process.exit(1);
  }
  if (!googleKey) {
    console.error("GOOGLE_SERVER_KEY (or NEXT_PUBLIC_GOOGLE_MAPS_KEY) missing — set in .env.local");
    process.exit(1);
  }

  const outRoot = join(process.cwd(), "scripts", "eval-output");
  ensureDir(outRoot);

  console.log(`[eval] ${ADDRESSES.length} address(es) × ${MODELS.length} model(s) = ${ADDRESSES.length * MODELS.length} runs\n`);

  const summary: Array<{
    address: string;
    model: string;
    polygonCount: number;
    primaryConfidence: number | null;
    primaryClass: string | null;
    primaryVertices: number | null;
    primaryAreaPx: number | null;
    error?: string;
  }> = [];

  for (const addr of ADDRESSES) {
    console.log(`\n=== ${addr.label} (${addr.lat}, ${addr.lng}) ===`);
    if (addr.notes) console.log(`    note: ${addr.notes}`);

    // Fetch satellite tile once per address — same image goes to every model.
    // This is also the same image the production pipeline feeds to SAM, so
    // model-vs-SAM comparisons stay apples-to-apples.
    const tile = await fetchSatelliteTile({
      lat: addr.lat,
      lng: addr.lng,
      apiKey: googleKey,
    });
    if (!tile) {
      console.log("  skip — satellite tile unavailable");
      continue;
    }
    const tilePath = join(outRoot, `${addr.label}.tile.png`);
    writeFileSync(tilePath, tile);

    for (const [name, model] of MODELS) {
      process.stdout.write(`  • ${name} (${model.slug}/${model.version}) ... `);
      const t0 = Date.now();
      let result: RoboflowResult | null = null;
      try {
        result = await refineRoofWithRoboflow({
          lat: addr.lat,
          lng: addr.lng,
          googleMapsKey: googleKey,
          roboflowKey,
          model,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`ERROR (${msg})`);
        summary.push({
          address: addr.label,
          model: name,
          polygonCount: 0,
          primaryConfidence: null,
          primaryClass: null,
          primaryVertices: null,
          primaryAreaPx: null,
          error: msg,
        });
        continue;
      }
      const elapsed = Date.now() - t0;

      if (!result || result.polygons.length === 0) {
        console.log(`no polygons (${elapsed}ms)`);
        summary.push({
          address: addr.label,
          model: name,
          polygonCount: 0,
          primaryConfidence: null,
          primaryClass: null,
          primaryVertices: null,
          primaryAreaPx: null,
        });
        continue;
      }

      const primary = result.polygons[0];
      console.log(
        `${result.polygons.length} polygon(s), primary: ${primary.class} @ ${primary.confidence.toFixed(2)}, ${primary.pixels.length} verts, ${Math.round(primary.pixelArea)}px² (${elapsed}ms)`,
      );

      const overlayPath = join(outRoot, `${addr.label}.${name}.png`);
      await compositeOverlay(tile, result.polygons.map((p) => p.pixels), overlayPath);

      summary.push({
        address: addr.label,
        model: name,
        polygonCount: result.polygons.length,
        primaryConfidence: primary.confidence,
        primaryClass: primary.class,
        primaryVertices: primary.pixels.length,
        primaryAreaPx: Math.round(primary.pixelArea),
      });
    }
  }

  // Final summary table — easier than scrolling through the per-run logs
  console.log("\n\n=== Summary ===");
  console.log("address                        model                       polys  conf  class      verts  area");
  console.log("-".repeat(95));
  for (const row of summary) {
    if (row.error) {
      console.log(
        `${row.address.padEnd(30)} ${row.model.padEnd(28)} ERROR: ${row.error}`,
      );
      continue;
    }
    console.log(
      `${row.address.padEnd(30)} ${row.model.padEnd(28)} ${String(row.polygonCount).padStart(3)}    ${
        row.primaryConfidence != null ? row.primaryConfidence.toFixed(2) : "—   "
      }  ${(row.primaryClass ?? "—").padEnd(10)} ${String(row.primaryVertices ?? "—").padStart(5)}  ${String(row.primaryAreaPx ?? "—").padStart(7)}`,
    );
  }

  console.log(`\nOverlays written to: ${outRoot}`);
  console.log("Inspect the .png files visually to pick the winner — confidence numbers ≠ correctness.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

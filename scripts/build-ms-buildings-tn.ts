/**
 * One-time data prep script — extracts Microsoft Building Footprints for
 * the Nashville metro operating area into a compact, gzipped static asset.
 *
 * Microsoft publishes per-state geojson dumps of ~3.2M Tennessee buildings
 * (890MB unzipped). We don't operate statewide so 99% of that data is
 * irrelevant. This script downloads the state file, filters to a bounding
 * box around the user's actual operating area, and writes a much smaller
 * file the runtime lib can load quickly.
 *
 * Usage:
 *   npx tsx scripts/build-ms-buildings-tn.ts
 *
 * Output:
 *   public/data/ms-buildings-tn-nashville.json.gz   (committed to repo)
 *
 * To expand to a new region, edit BBOX below and re-run.
 *
 * Source: microsoft/USBuildingFootprints (ODbL license)
 */

import { createGunzip } from "node:zlib";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const gzipAsync = promisify(gzip);

// Tennessee state file. ZIP-compressed GeoJSON FeatureCollection.
// 890MB unzipped, ~3.2M building polygons.
const TN_URL =
  "https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Tennessee.geojson.zip";

// Nashville metro operating area — covers the test addresses (Antioch ~36.04,
// Mt. Juliet ~36.07, Murfreesboro ~35.78) with a small buffer for nearby
// suburbs. ~50km × 50km. Expand by editing this and re-running the script.
//
// Initial run with a 80km × 90km bbox produced 567k buildings = 24.6MB
// gzipped — usable but slow to load on serverless cold start. Tightened
// to the actual operating zone.
const BBOX = {
  minLat: 35.7,
  maxLat: 36.2,
  minLng: -86.9,
  maxLng: -86.3,
};

const CACHE_DIR = join(process.cwd(), ".cache");
const TN_ZIP_PATH = join(CACHE_DIR, "tennessee.geojson.zip");
const TN_JSON_PATH = join(CACHE_DIR, "tennessee.geojson");
const OUTPUT_DIR = join(process.cwd(), "public", "data");
const OUTPUT_PATH = join(OUTPUT_DIR, "ms-buildings-tn-nashville.json.gz");

interface BuildingFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: number[][][] };
  properties?: Record<string, unknown>;
}

async function ensureDownloaded(): Promise<void> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  if (existsSync(TN_JSON_PATH)) {
    const size = statSync(TN_JSON_PATH).size;
    console.log(`[build] cached unzipped TN geojson found (${(size / 1024 / 1024).toFixed(0)} MB), skipping download`);
    return;
  }

  if (!existsSync(TN_ZIP_PATH)) {
    console.log(`[build] downloading TN building footprints from ${TN_URL}`);
    const res = await fetch(TN_URL);
    if (!res.ok || !res.body) {
      throw new Error(`download failed: ${res.status} ${res.statusText}`);
    }
    const sink = createWriteStream(TN_ZIP_PATH);
    // Node and DOM ReadableStream types differ; the runtime is fine.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await pipeline(Readable.fromWeb(res.body as any), sink);
    console.log(`[build] downloaded → ${TN_ZIP_PATH} (${(statSync(TN_ZIP_PATH).size / 1024 / 1024).toFixed(0)} MB)`);
  }

  // Decompress the .zip — Microsoft's zip wraps a single .geojson file.
  // node:zlib only handles gzip/deflate. Use unzip via a child process or a
  // tiny zip reader. We use `adm-zip` if installed, otherwise fall back to
  // streaming through `unzipper`. To keep this script standalone and dep-light,
  // we invoke the system unzip if available; on Windows, PowerShell.
  console.log("[build] extracting zip...");
  await extractZip(TN_ZIP_PATH, CACHE_DIR);
  // The extracted file may be named "Tennessee.geojson" or similar.
  // Look for any .geojson file in CACHE_DIR.
  const { readdirSync, renameSync } = await import("node:fs");
  const files = readdirSync(CACHE_DIR).filter((f) => f.toLowerCase().endsWith(".geojson"));
  if (files.length === 0) throw new Error("no .geojson found after unzip");
  if (files[0] !== "tennessee.geojson") {
    renameSync(join(CACHE_DIR, files[0]), TN_JSON_PATH);
  }
  console.log(`[build] extracted to ${TN_JSON_PATH} (${(statSync(TN_JSON_PATH).size / 1024 / 1024).toFixed(0)} MB)`);
}

async function extractZip(zipPath: string, outDir: string): Promise<void> {
  // Use system tools: PowerShell on Windows, unzip elsewhere
  const { execSync } = await import("node:child_process");
  if (process.platform === "win32") {
    // PowerShell Expand-Archive
    execSync(
      `powershell -Command "Expand-Archive -LiteralPath '${zipPath.replace(/\\/g, "\\\\")}' -DestinationPath '${outDir.replace(/\\/g, "\\\\")}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`unzip -o -d "${outDir}" "${zipPath}"`, { stdio: "inherit" });
  }
}

/**
 * Stream-parse the geojson and emit features whose geometry overlaps BBOX.
 *
 * Microsoft's TN file is a FeatureCollection but each Feature is on its
 * own line (after the `[` opening line). That makes line-by-line parsing
 * trivial: take each line, strip trailing comma, parse as JSON.
 *
 * Lines we ignore:
 *   - The 4-line header ({, "type"..., "features":, [)
 *   - The 2-line footer (], })
 * Lines we parse: anything starting with `{"type":"Feature"`
 */
async function* iterFeatures(): AsyncGenerator<BuildingFeature> {
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const stream = createReadStream(TN_JSON_PATH, { highWaterMark: 16 * 1024 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('{"type":"Feature"')) continue;
    // Strip trailing comma if present (geojson features in an array end with ",")
    const json = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
    try {
      const feature = JSON.parse(json) as BuildingFeature;
      if (feature.geometry?.type === "Polygon") {
        yield feature;
      }
    } catch {
      // skip malformed
    }
  }
}

function polygonOverlapsBBox(coords: number[][][]): { overlap: boolean; bbox: [number, number, number, number] } {
  // GeoJSON Polygon: array of rings, each ring is array of [lng, lat]
  const ring = coords[0];
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const overlap =
    maxLng >= BBOX.minLng &&
    minLng <= BBOX.maxLng &&
    maxLat >= BBOX.minLat &&
    minLat <= BBOX.maxLat;
  return { overlap, bbox: [minLng, minLat, maxLng, maxLat] };
}

async function main() {
  await ensureDownloaded();

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`[build] filtering features to bbox lat[${BBOX.minLat}..${BBOX.maxLat}] lng[${BBOX.minLng}..${BBOX.maxLng}]`);

  // Compact output: array of [bbox, polygon-ring]
  // bbox: [minLng, minLat, maxLng, maxLat]   (4 numbers)
  // polygon-ring: array of [lng, lat] pairs (flattened: [lng1, lat1, lng2, lat2, ...])
  const out: Array<{ b: [number, number, number, number]; p: number[] }> = [];

  let total = 0;
  let kept = 0;
  let lastReport = Date.now();
  for await (const feature of iterFeatures()) {
    total++;
    const { overlap, bbox } = polygonOverlapsBBox(feature.geometry.coordinates);
    if (overlap) {
      const ring = feature.geometry.coordinates[0];
      const flat: number[] = [];
      for (const [lng, lat] of ring) {
        // Round to 6 decimal places (~10cm precision) to save bytes
        flat.push(Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6);
      }
      out.push({
        b: [
          Math.round(bbox[0] * 1e6) / 1e6,
          Math.round(bbox[1] * 1e6) / 1e6,
          Math.round(bbox[2] * 1e6) / 1e6,
          Math.round(bbox[3] * 1e6) / 1e6,
        ],
        p: flat,
      });
      kept++;
    }
    if (Date.now() - lastReport > 5000) {
      console.log(`[build] processed ${total.toLocaleString()} features, kept ${kept.toLocaleString()}`);
      lastReport = Date.now();
    }
  }

  console.log(`[build] done. ${total.toLocaleString()} total, ${kept.toLocaleString()} kept (${((kept / total) * 100).toFixed(1)}%)`);

  const json = JSON.stringify({
    bbox: BBOX,
    sourceUrl: TN_URL,
    license: "ODbL",
    builtAt: new Date().toISOString(),
    count: kept,
    buildings: out,
  });
  console.log(`[build] uncompressed JSON: ${(json.length / 1024 / 1024).toFixed(2)} MB`);

  const compressed = await gzipAsync(json, { level: 9 });
  writeFileSync(OUTPUT_PATH, compressed);
  console.log(`[build] wrote ${OUTPUT_PATH} (${(compressed.length / 1024 / 1024).toFixed(2)} MB gzipped)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

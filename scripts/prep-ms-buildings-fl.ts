/**
 * scripts/prep-ms-buildings-fl.ts
 *
 * One-time prep for the MS Buildings cold tier.
 *
 * Pipeline:
 *   1. Download Microsoft's Florida.geojson.zip (~140 MB compressed,
 *      ~600 MB uncompressed, ~5.5M building polygons).
 *   2. Stream-unzip and parse line-by-line — never load all 5.5M
 *      polygons into RAM. Microsoft ships the file as line-delimited
 *      GeoJSON: one Feature per line plus a header/footer.
 *   3. For each polygon: compute centroid lat/lng, quadkey-16 via the
 *      same latLngToQuadkey() the runtime uses, append to a tile bucket.
 *   4. After all features processed, write one JSON file per quadkey-16
 *      to /tmp/ms-buildings-fl/{quadkey16}.json with shape
 *      `{ buildings: BuildingRecord[], fetchedAt: ISO }`.
 *   5. Upload each tile to Vercel Blob at path
 *      `ms-buildings/v1/{quadkey16}.json` with `access: 'public'` and
 *      `addRandomSuffix: false` — overwrites on rerun (idempotent).
 *
 * Usage:
 *   export BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx...
 *   npx tsx scripts/prep-ms-buildings-fl.ts
 *
 * Optional env:
 *   MS_BUILDINGS_SOURCE_URL — override the default Microsoft URL
 *   MS_BUILDINGS_WORK_DIR   — override /tmp/ms-buildings-fl
 *   MS_BUILDINGS_SKIP_DOWNLOAD=1 — reuse already-downloaded zip
 *   MS_BUILDINGS_SKIP_BUCKET=1   — reuse already-bucketed tile JSONs
 *   MS_BUILDINGS_SKIP_UPLOAD=1   — bucket only, don't upload
 *
 * Soft-fails on Vercel Blob upload by logging — the script continues so
 * one transient 429 doesn't abandon the other 99% of uploads.
 */

import { createWriteStream, createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";

import { put } from "@vercel/blob";

// Import the EXACT tile math the runtime uses, so prep + read agree.
import { latLngToQuadkey, type LatLng } from "@/lib/sources/ms-buildings";

// ─── Config ──────────────────────────────────────────────────────────

const SOURCE_URL =
  process.env.MS_BUILDINGS_SOURCE_URL ??
  "https://usbuildingdata.blob.core.windows.net/usbuildings-v2/Florida.geojson.zip";

const WORK_DIR =
  process.env.MS_BUILDINGS_WORK_DIR ?? "/tmp/ms-buildings-fl";

const TILES_DIR = path.join(WORK_DIR, "tiles");
const ZIP_PATH = path.join(WORK_DIR, "Florida.geojson.zip");
const GEOJSON_PATH = path.join(WORK_DIR, "Florida.geojson");

const SKIP_DOWNLOAD = process.env.MS_BUILDINGS_SKIP_DOWNLOAD === "1";
const SKIP_BUCKET = process.env.MS_BUILDINGS_SKIP_BUCKET === "1";
const SKIP_UPLOAD = process.env.MS_BUILDINGS_SKIP_UPLOAD === "1";

// Upload concurrency — Vercel Blob handles bursts fine, but we don't want
// to open thousands of sockets at once. 16 keeps a deploy machine warm
// without tripping rate limits.
const UPLOAD_CONCURRENCY = 16;

// ─── Types matching lib/sources/ms-buildings.ts BuildingRecord ───────

interface BuildingRecord {
  polygon: LatLng[];
  centroidLat: number;
  centroidLng: number;
  areaSqft: number;
}

// ─── Step 1: download ────────────────────────────────────────────────

async function downloadZip(): Promise<void> {
  if (SKIP_DOWNLOAD && existsSync(ZIP_PATH)) {
    console.log(`[prep] skip download — reusing ${ZIP_PATH}`);
    return;
  }
  console.log(`[prep] downloading ${SOURCE_URL} → ${ZIP_PATH}`);
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok || !resp.body) {
    throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
  }
  await mkdir(WORK_DIR, { recursive: true });
  // Node's `fetch` ReadableStream → fs write stream.
  const fileStream = createWriteStream(ZIP_PATH);
  // @ts-expect-error — Node's WebStream → NodeStream interop is fine at runtime
  await pipeline(resp.body, fileStream);
  const s = await stat(ZIP_PATH);
  console.log(`[prep] downloaded ${(s.size / 1e6).toFixed(1)} MB`);
}

// ─── Step 2: unzip → line-delimited GeoJSON ──────────────────────────
//
// Microsoft's distribution is a real ZIP file (PKZIP format), not a
// gzip stream. We extract the single inner .geojson via a tiny inline
// ZIP reader rather than pulling in `adm-zip` / `unzipper`. The ZIP
// stores the file with DEFLATE (method 8); we stream-inflate it.

async function extractGeoJson(): Promise<void> {
  if (existsSync(GEOJSON_PATH)) {
    const s = await stat(GEOJSON_PATH);
    console.log(`[prep] reusing extracted geojson (${(s.size / 1e6).toFixed(1)} MB)`);
    return;
  }
  console.log(`[prep] extracting ${ZIP_PATH} → ${GEOJSON_PATH}`);

  // Read local file headers sequentially. For Microsoft's release there's
  // exactly one entry. The local-file-header layout is fixed:
  //   0..4  : signature 0x04034b50
  //   4..6  : version
  //   6..8  : flags
  //   8..10 : compression method (8 = deflate, 0 = store)
  //   10..14: time + date
  //   14..18: crc32
  //   18..22: compressed size
  //   22..26: uncompressed size
  //   26..28: filename length
  //   28..30: extra field length
  //   30..  : filename, extra, then DATA
  const { open } = await import("node:fs/promises");
  const fh = await open(ZIP_PATH, "r");
  try {
    const header = Buffer.alloc(30);
    await fh.read(header, 0, 30, 0);
    const sig = header.readUInt32LE(0);
    if (sig !== 0x04034b50) {
      throw new Error(`unexpected ZIP signature 0x${sig.toString(16)}`);
    }
    const method = header.readUInt16LE(8);
    const flags = header.readUInt16LE(6);
    const compSize = header.readUInt32LE(18);
    const nameLen = header.readUInt16LE(26);
    const extraLen = header.readUInt16LE(28);
    const dataStart = 30 + nameLen + extraLen;

    // Streaming sized? If bit 3 of flags is set, sizes are in a data
    // descriptor after the data — we'd need the central directory. The
    // Microsoft release has sizes inline, so we assert that.
    if ((flags & 0x08) !== 0 && compSize === 0) {
      throw new Error(
        "ZIP uses streaming sizes (data descriptor) — central-dir read required",
      );
    }

    // Stream from dataStart for compSize bytes, inflate, pipe to file.
    const dataStream = createReadStream(ZIP_PATH, {
      start: dataStart,
      end: compSize > 0 ? dataStart + compSize - 1 : undefined,
    });
    const out = createWriteStream(GEOJSON_PATH);
    if (method === 8) {
      await pipeline(dataStream, createInflateRaw(), out);
    } else if (method === 0) {
      await pipeline(dataStream, out);
    } else if (method === 9) {
      // Some MS files use DEFLATE64. Fall back to gunzip won't work;
      // fail loudly so we know to swap libraries.
      throw new Error("ZIP uses DEFLATE64 — install `unzipper` and rerun");
    } else {
      throw new Error(`unsupported ZIP compression method ${method}`);
    }
  } finally {
    await fh.close();
  }
  const s = await stat(GEOJSON_PATH);
  console.log(`[prep] extracted ${(s.size / 1e6).toFixed(1)} MB`);
}

// ─── Step 3: bucket by quadkey-16 ────────────────────────────────────

interface BucketStats {
  features: number;
  buildings: number; // polygons that passed centroid/area sanity
  tiles: number;
}

async function bucketByTile(): Promise<BucketStats> {
  if (SKIP_BUCKET && existsSync(TILES_DIR)) {
    const files = await readdir(TILES_DIR);
    console.log(`[prep] skip bucket — reusing ${files.length} tile files`);
    return { features: 0, buildings: 0, tiles: files.length };
  }
  await mkdir(TILES_DIR, { recursive: true });

  // In-memory map: quadkey16 → BuildingRecord[]. With ~5.5M FL polygons
  // averaging ~5 vertices each (8 bytes per coord pair × 5 = 40 bytes
  // raw, plus centroid + area), the structure sits around 1–2 GB. That
  // fits on a modest dev machine; if it doesn't, flush per-tile to disk
  // periodically. For now, single-pass in-RAM is dramatically simpler.
  const tiles = new Map<string, BuildingRecord[]>();

  const rl = createInterface({
    input: createReadStream(GEOJSON_PATH, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let features = 0;
  let buildings = 0;
  let skipped = 0;
  let lineNum = 0;

  for await (const rawLine of rl) {
    lineNum++;
    const line = rawLine.trim();
    if (!line) continue;
    // Microsoft's file is either:
    //   (a) a FeatureCollection on one line per Feature — strip trailing
    //       comma, ignore the outer { "type": "FeatureCollection" ... }
    //       header / closing bracket.
    //   (b) true line-delimited GeoJSON (one Feature per line, no outer
    //       collection).
    // We handle both by attempting JSON.parse on lines that look like a
    // Feature and skipping anything that doesn't parse cleanly.
    if (!line.startsWith("{")) continue;

    // Strip trailing comma so FeatureCollection lines parse.
    const candidate = line.endsWith(",") ? line.slice(0, -1) : line;

    let feat: GeoJsonFeature | null = null;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.type === "Feature") feat = parsed;
    } catch {
      // Header / footer / partial line — skip silently.
      continue;
    }
    if (!feat) continue;
    features++;

    const polygon = extractOuterRing(feat);
    if (!polygon || polygon.length < 4) {
      skipped++;
      continue;
    }

    const { centroidLat, centroidLng } = polygonCentroid(polygon);
    const areaSqft = polygonAreaSqft(polygon);
    if (!Number.isFinite(areaSqft) || areaSqft <= 0) {
      skipped++;
      continue;
    }

    const q16 = latLngToQuadkey(centroidLat, centroidLng, 16);
    const rec: BuildingRecord = {
      polygon,
      centroidLat,
      centroidLng,
      areaSqft,
    };
    const arr = tiles.get(q16);
    if (arr) arr.push(rec);
    else tiles.set(q16, [rec]);
    buildings++;

    if (buildings % 100_000 === 0) {
      console.log(
        `[prep] bucketed ${buildings.toLocaleString()} buildings ` +
          `(${tiles.size.toLocaleString()} tiles, ${skipped} skipped, line ${lineNum.toLocaleString()})`,
      );
    }
  }

  console.log(
    `[prep] parse done: ${features.toLocaleString()} features, ` +
      `${buildings.toLocaleString()} buildings, ${tiles.size.toLocaleString()} tiles, ` +
      `${skipped} skipped`,
  );

  // Flush each tile to disk.
  const fetchedAt = new Date().toISOString();
  let written = 0;
  for (const [q16, recs] of tiles) {
    const out = { buildings: recs, fetchedAt };
    await writeFile(
      path.join(TILES_DIR, `${q16}.json`),
      JSON.stringify(out),
    );
    written++;
    if (written % 1000 === 0) {
      console.log(`[prep] wrote ${written.toLocaleString()}/${tiles.size.toLocaleString()} tile files`);
    }
  }
  console.log(`[prep] wrote ${written.toLocaleString()} tile files to ${TILES_DIR}`);

  return { features, buildings, tiles: tiles.size };
}

// ─── Step 4: upload to Vercel Blob ───────────────────────────────────

async function uploadTiles(): Promise<{ uploaded: number; failed: number; prefix: string | null }> {
  if (SKIP_UPLOAD) {
    console.log("[prep] skip upload (MS_BUILDINGS_SKIP_UPLOAD=1)");
    return { uploaded: 0, failed: 0, prefix: null };
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN not set — get one from the Vercel dashboard " +
        "(Project → Storage → Blob → connect → copy the rw token) and re-export.",
    );
  }

  const files = await readdir(TILES_DIR);
  console.log(`[prep] uploading ${files.length.toLocaleString()} tiles to Vercel Blob (concurrency=${UPLOAD_CONCURRENCY})`);

  let uploaded = 0;
  let failed = 0;
  let firstUrl: string | null = null;

  // Simple worker pool — splice fixed-size batches off the queue and
  // await each batch's Promise.all. Trades the ideal of "always 16 in
  // flight" for clearer error handling.
  for (let i = 0; i < files.length; i += UPLOAD_CONCURRENCY) {
    const batch = files.slice(i, i + UPLOAD_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (filename) => {
        const q16 = filename.replace(/\.json$/, "");
        const body = await readFile(path.join(TILES_DIR, filename));
        const blob = await put(`ms-buildings/v1/${q16}.json`, body, {
          access: "public",
          addRandomSuffix: false,
          contentType: "application/json",
          allowOverwrite: true,
        });
        return blob.url;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        uploaded++;
        if (!firstUrl) firstUrl = r.value;
      } else {
        failed++;
        console.warn("[prep] upload failed:", r.reason);
      }
    }
    if ((i + UPLOAD_CONCURRENCY) % 500 === 0 || i + UPLOAD_CONCURRENCY >= files.length) {
      console.log(
        `[prep] uploaded ${uploaded.toLocaleString()}/${files.length.toLocaleString()} (${failed} failed)`,
      );
    }
  }

  // Derive the public Blob prefix from the first uploaded URL — the user
  // needs this for the MS_BUILDINGS_BLOB_URL env var.
  let prefix: string | null = null;
  if (firstUrl) {
    const u = new URL(firstUrl);
    prefix = `${u.protocol}//${u.host}`;
  }

  return { uploaded, failed, prefix };
}

// ─── Geometry helpers (mirror runtime semantics) ─────────────────────

interface GeoJsonFeature {
  type: "Feature";
  geometry?: {
    type: "Polygon" | "MultiPolygon";
    coordinates: number[][][] | number[][][][];
  } | null;
  properties?: Record<string, unknown>;
}

/** Returns the outer ring as LatLng[]. For MultiPolygon, picks the
 *  largest-area outer ring (Microsoft's release is overwhelmingly
 *  single-polygon, but some structures with internal courtyards or
 *  detached wings serialize as MultiPolygon — we take the dominant ring
 *  so the area + centroid match the main mass). */
function extractOuterRing(feat: GeoJsonFeature): LatLng[] | null {
  const g = feat.geometry;
  if (!g) return null;
  if (g.type === "Polygon") {
    const ring = (g.coordinates as number[][][])[0];
    return ring.map(([lng, lat]) => ({ lat, lng }));
  }
  if (g.type === "MultiPolygon") {
    let best: LatLng[] | null = null;
    let bestArea = 0;
    for (const poly of g.coordinates as number[][][][]) {
      const ring = poly[0].map(([lng, lat]) => ({ lat, lng }));
      const a = Math.abs(shoelaceAreaDeg2(ring));
      if (a > bestArea) {
        bestArea = a;
        best = ring;
      }
    }
    return best;
  }
  return null;
}

function polygonCentroid(ring: LatLng[]): { centroidLat: number; centroidLng: number } {
  // Area-weighted centroid in lat/lng space. For small building polygons
  // (<100m on a side) the planar approximation is fine — sub-meter drift
  // at FL latitudes, well under quadkey-16 (~600m) tile resolution.
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng;
    const yi = ring[i].lat;
    const xj = ring[j].lng;
    const yj = ring[j].lat;
    const cross = xj * yi - xi * yj;
    twiceArea += cross;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }
  if (twiceArea === 0) {
    // Degenerate ring — fall back to simple vertex mean.
    let sLat = 0;
    let sLng = 0;
    for (const p of ring) {
      sLat += p.lat;
      sLng += p.lng;
    }
    return {
      centroidLat: sLat / ring.length,
      centroidLng: sLng / ring.length,
    };
  }
  const factor = 1 / (3 * twiceArea);
  return { centroidLat: cy * factor, centroidLng: cx * factor };
}

/** Shoelace area in deg², used only as a tiebreaker for MultiPolygon. */
function shoelaceAreaDeg2(ring: LatLng[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j].lng * ring[i].lat - ring[i].lng * ring[j].lat;
  }
  return s / 2;
}

/** Polygon area in sqft via equirectangular projection at the centroid
 *  latitude — accurate to better than 0.5% for building-sized polygons
 *  at FL latitudes. */
function polygonAreaSqft(ring: LatLng[]): number {
  // Reference latitude = mean lat of vertices.
  let sLat = 0;
  for (const p of ring) sLat += p.lat;
  const meanLat = sLat / ring.length;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  const METERS_PER_DEG_LAT = 111_320;
  const metersPerDegLng = METERS_PER_DEG_LAT * cosLat;

  let twoA = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = (ring[i].lng - ring[0].lng) * metersPerDegLng;
    const yi = (ring[i].lat - ring[0].lat) * METERS_PER_DEG_LAT;
    const xj = (ring[j].lng - ring[0].lng) * metersPerDegLng;
    const yj = (ring[j].lat - ring[0].lat) * METERS_PER_DEG_LAT;
    twoA += xj * yi - xi * yj;
  }
  const sqMeters = Math.abs(twoA) / 2;
  return sqMeters * 10.7639; // sqft per sqm
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[prep] MS Buildings FL — prep pipeline");
  console.log(`[prep] work dir: ${WORK_DIR}`);

  await mkdir(WORK_DIR, { recursive: true });
  await downloadZip();
  await extractGeoJson();
  const stats = await bucketByTile();

  // Summarize tile-dir size on disk.
  const tileFiles = await readdir(TILES_DIR);
  let totalBytes = 0;
  for (const f of tileFiles.slice(0, Math.min(1000, tileFiles.length))) {
    const s = await stat(path.join(TILES_DIR, f));
    totalBytes += s.size;
  }
  const avgBytes = totalBytes / Math.min(1000, tileFiles.length);
  const estTotalMb = (avgBytes * tileFiles.length) / 1e6;
  console.log(
    `[prep] tiles on disk: ${tileFiles.length.toLocaleString()} files, ` +
      `~${estTotalMb.toFixed(1)} MB estimated (sampled ${Math.min(1000, tileFiles.length)})`,
  );

  const up = await uploadTiles();
  console.log(`[prep] upload done: ${up.uploaded.toLocaleString()} uploaded, ${up.failed} failed`);
  if (up.prefix) {
    console.log(`[prep] >>> MS_BUILDINGS_BLOB_URL=${up.prefix}`);
    console.log("[prep] add this env var via: vercel env add MS_BUILDINGS_BLOB_URL production");
  }

  console.log("\n[prep] summary");
  console.log(`  features parsed : ${stats.features.toLocaleString()}`);
  console.log(`  buildings kept  : ${stats.buildings.toLocaleString()}`);
  console.log(`  tiles written   : ${stats.tiles.toLocaleString()}`);
  console.log(`  tiles uploaded  : ${up.uploaded.toLocaleString()}`);
}

main().catch((err) => {
  console.error("[prep] fatal:", err);
  process.exit(1);
});

/**
 * Standalone validator for the V2 vision pipeline.
 *
 * Exercises the exact code path /api/gemini-roof uses (fetch tile →
 * Gemini structured output → Solar match → geometry module) against
 * the two acceptance-criteria addresses: Jupiter (3,653 sqft EagleView
 * truth) and Orlando (Oak Park ~5,400 sqft if user's ground truth
 * holds, otherwise we just check the result is plausible).
 *
 * Usage:
 *   npx tsx scripts/test-gemini-roof-route.ts
 *
 * Reads .env.production for keys. Saves the input tile + raw Gemini
 * response + final measurements to /tmp/v2-test-{slug}.{ext} for
 * inspection.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  buildTileMetadata,
  pixelPolygonToLatLng,
  processVisionOutput,
  reconcileGeminiAgainstSolar,
  type ReconciliationResult,
  type SolarPlaneMatch,
  type VisionRoofOutput,
} from "../lib/roof-geometry";
import {
  GEMINI_ROOF_PROMPT,
  GEMINI_ROOF_SCHEMA,
} from "../lib/gemini-roof-prompt";

// Load env
const envPath = path.resolve(__dirname, "..", ".env.production");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const GEMINI_MODEL =
  process.env.GEMINI_MODEL ?? "gemini-3-pro-image-preview";

interface TestCase {
  name: string;
  lat: number;
  lng: number;
  truthSqft: number | null;
  truthName: string;
}

const CASES: TestCase[] = [
  {
    name: "813 Summerwood Dr Jupiter FL",
    lat: 26.93252,
    lng: -80.10804,
    truthSqft: 3654,
    truthName: "EagleView 3,653.5 sqft (sloped)",
  },
  {
    name: "2863 Newcomb Ct Orlando FL",
    lat: 28.5844052,
    lng: -81.17330439999999,
    truthSqft: 1592,
    truthName: "EagleView 1,592 sqft",
  },
  {
    name: "16538 Broadwater Ave Winter Garden FL",
    lat: 28.518061,
    lng: -81.6298012,
    truthSqft: null,
    truthName: "no truth (sanity check)",
  },
  {
    name: "8450 Oak Park Rd Orlando FL 32819",
    lat: 0,
    lng: 0,
    truthSqft: 5400,
    truthName: "user-reported ~5,400 sqft",
  },
];

async function geocode(addr: string): Promise<{ lat: number; lng: number }> {
  const key = process.env.GOOGLE_SERVER_KEY!;
  const r = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&key=${key}`,
  );
  const d = await r.json() as { results: Array<{ geometry: { location: { lat: number; lng: number } } }> };
  return d.results[0].geometry.location;
}

async function fetchGoogleTile(lat: number, lng: number, zoom = 20): Promise<Buffer> {
  const key = process.env.GOOGLE_SERVER_KEY!;
  const url =
    `https://maps.googleapis.com/maps/api/staticmap` +
    `?center=${lat},${lng}&zoom=${zoom}&size=640x640&scale=2` +
    `&maptype=satellite&key=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`google_static_${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Mirror of pickOptimalZoom in app/api/gemini-roof/route.ts — keeps
 *  the harness in lockstep with prod behavior. */
function pickOptimalZoom(
  bbox: { sw: { latitude: number; longitude: number }; ne: { latitude: number; longitude: number } },
  centerLat: number,
): number {
  const cosLat = Math.cos((centerLat * Math.PI) / 180);
  const widthM = (bbox.ne.longitude - bbox.sw.longitude) * 111_320 * cosLat;
  const heightM = (bbox.ne.latitude - bbox.sw.latitude) * 111_320;
  const longestM = Math.max(widthM, heightM, 8) * 1.2;
  const tilePx = 1280;
  const targetMPerPx = (longestM / 0.55) / tilePx;
  const num = 156_543.03392 * cosLat;
  const z = Math.log2(num / targetMPerPx) - 1; // scale=2 → minus 1
  return Math.min(22, Math.max(19, Math.round(z)));
}

interface GeminiResp {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

async function callGemini(tile: Buffer, promptOverride?: string): Promise<unknown> {
  const key = process.env.GEMINI_API_KEY!;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = {
    contents: [{
      parts: [
        { text: promptOverride ?? GEMINI_ROOF_PROMPT },
        { inline_data: { mime_type: "image/png", data: tile.toString("base64") } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: GEMINI_ROOF_SCHEMA,
    },
  };
  const t0 = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const dt = Date.now() - t0;
  const text = await r.text();
  if (!r.ok) throw new Error(`gemini_${r.status}: ${text.slice(0, 400)}`);
  console.log(`    Gemini ${r.status} in ${dt}ms`);
  const json = JSON.parse(text) as GeminiResp;
  const inner = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!inner) {
    console.log("    Full response:", JSON.stringify(json, null, 2).slice(0, 800));
    throw new Error("gemini_no_text_in_response");
  }
  return JSON.parse(inner);
}

interface SolarResponse {
  center?: { latitude: number; longitude: number };
  boundingBox?: { sw: { latitude: number; longitude: number }; ne: { latitude: number; longitude: number } };
  solarPotential?: {
    roofSegmentStats?: Array<{
      pitchDegrees?: number;
      azimuthDegrees?: number;
      stats?: { areaMeters2?: number };
      boundingBox?: { sw: { latitude: number; longitude: number }; ne: { latitude: number; longitude: number } };
    }>;
    wholeRoofStats?: { groundAreaMeters2?: number; areaMeters2?: number };
  };
  imageryDate?: { year: number; month: number; day: number };
  imageryQuality?: string;
}

async function callSolar(lat: number, lng: number): Promise<SolarResponse | null> {
  const key = process.env.GOOGLE_SERVER_KEY!;
  const url =
    `https://solar.googleapis.com/v1/buildingInsights:findClosest` +
    `?location.latitude=${lat}&location.longitude=${lng}` +
    `&requiredQuality=LOW&key=${key}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return (await r.json()) as SolarResponse;
}

function solarToMatches(s: SolarResponse | null): SolarPlaneMatch[] {
  const segs = s?.solarPotential?.roofSegmentStats ?? [];
  return segs
    .filter((seg) => seg.boundingBox && typeof seg.pitchDegrees === "number")
    .map((seg) => ({
      centerLat: (seg.boundingBox!.sw.latitude + seg.boundingBox!.ne.latitude) / 2,
      centerLng: (seg.boundingBox!.sw.longitude + seg.boundingBox!.ne.longitude) / 2,
      pitchDegrees: seg.pitchDegrees ?? 0,
      azimuthDeg: seg.azimuthDegrees ?? 0,
      solarAreaSqft: (seg.stats?.areaMeters2 ?? 0) * 10.7639,
    }));
}

async function run(c: TestCase): Promise<void> {
  const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  console.log(`\n${"=".repeat(72)}\n${c.name}  (${c.lat}, ${c.lng})`);
  console.log(`Truth: ${c.truthName}`);
  console.log("=".repeat(72));

  // FREE-ITERATION MODE — reuse the previously-paid Gemini response when
  // it exists on disk. Set FORCE_GEMINI=1 to bypass the cache and call
  // the model fresh (costs ~$0.075/call). Use this only after iterating
  // the prompt or schema; for geometry-math changes, the cache is fine.
  const forceGemini = process.env.FORCE_GEMINI === "1";
  const geminiCachePath = `/tmp/v2-test-${slug}-gemini.json`;
  const tilePath = `/tmp/v2-test-${slug}-tile.png`;

  let tile: Buffer;
  let geminiRaw: unknown;
  let solar: SolarResponse | null;
  // The Solar-driven tile re-centering needs these stored alongside the
  // cached JSON so the geometry-math iteration loop projects pixels to
  // the SAME lat/lng we got the polygon for. Saved as a sidecar file.
  let tileCenterLat = c.lat;
  let tileCenterLng = c.lng;
  let tileZoom = 20;

  const metaCachePath = `/tmp/v2-test-${slug}-meta.json`;

  if (!forceGemini && fs.existsSync(geminiCachePath) && fs.existsSync(tilePath) && fs.existsSync(metaCachePath)) {
    console.log("[cache] reusing cached Gemini JSON (set FORCE_GEMINI=1 to refresh)");
    tile = fs.readFileSync(tilePath);
    geminiRaw = JSON.parse(fs.readFileSync(geminiCachePath, "utf8"));
    const meta = JSON.parse(fs.readFileSync(metaCachePath, "utf8")) as { centerLat: number; centerLng: number; zoom: number };
    tileCenterLat = meta.centerLat;
    tileCenterLng = meta.centerLng;
    tileZoom = meta.zoom;
    solar = await callSolar(c.lat, c.lng);
    console.log(`    cached tile center=(${tileCenterLat.toFixed(5)},${tileCenterLng.toFixed(5)}) zoom=${tileZoom}`);
  } else {
    console.log("[1/5] Calling Solar first (free) to find building center + bbox…");
    solar = await callSolar(c.lat, c.lng);
    if (solar?.boundingBox && solar?.center) {
      tileCenterLat = solar.center.latitude;
      tileCenterLng = solar.center.longitude;
      tileZoom = pickOptimalZoom(solar.boundingBox, tileCenterLat);
      console.log(
        `    Solar recenter (${c.lat.toFixed(5)},${c.lng.toFixed(5)}) → ` +
        `(${tileCenterLat.toFixed(5)},${tileCenterLng.toFixed(5)}) zoom=${tileZoom}`,
      );
    } else {
      console.log("    Solar bbox unavailable; falling back to geocoded center + zoom 20");
    }

    console.log(`[2/5] Fetching Google tile at zoom ${tileZoom}…`);
    tile = await fetchGoogleTile(tileCenterLat, tileCenterLng, tileZoom);
    fs.writeFileSync(tilePath, tile);
    fs.writeFileSync(metaCachePath, JSON.stringify({ centerLat: tileCenterLat, centerLng: tileCenterLng, zoom: tileZoom }));
    console.log(`    saved ${tilePath} (${tile.length} bytes), meta sidecar saved`);

    // ── Phase 1: visual pin anchor (always applied) ────────────────────
    const annotatedPath = `/tmp/v2-test-${slug}-tile-pinned.png`;
    const PIN_X = 640;
    const PIN_Y = 640;
    execFileSync("python3", [
      path.resolve(__dirname, "annotate-tile-with-pin.py"),
      tilePath,
      annotatedPath,
      String(PIN_X),
      String(PIN_Y),
    ], { stdio: "inherit" });
    console.log(`    annotated tile saved to ${annotatedPath}`);

    // ── Phase 2 (PHASE_2=1): tight crop around the pin ────────────────
    // Cuts the 1280×1280 tile down to a 600×600 window centered on the
    // pin. Building must fit inside that window; if it overflows, eaves
    // get clipped. At zoom 21 the 600px crop is ~20m wide — large enough
    // for typical FL residential but borderline for the Jupiter building
    // (~22m wide). The experiment's purpose is to test whether tighter
    // visual context forces Gemini to commit to the full building.
    let toGemini: Buffer;
    const phase2 = process.env.PHASE_2 === "1";
    if (phase2) {
      const croppedPath = `/tmp/v2-test-${slug}-tile-pinned-cropped.png`;
      const CROP = 600;
      execFileSync("python3", [
        path.resolve(__dirname, "crop-tile-around-pin.py"),
        annotatedPath,
        croppedPath,
        String(PIN_X),
        String(PIN_Y),
        String(CROP),
      ], { stdio: "inherit" });
      toGemini = fs.readFileSync(croppedPath);
      console.log(`    PHASE 2: cropped to ${CROP}×${CROP} around pin`);
    } else {
      toGemini = fs.readFileSync(annotatedPath);
    }

    // For Phase 2 we send a 600×600 image, so the dimensions line in
    // the prompt is wrong. Substitute it inline rather than maintaining
    // a second hardcoded prompt.
    const promptForCall = phase2
      ? GEMINI_ROOF_PROMPT.replace(
          "Image dimensions: 1280 x 1280 pixels.",
          "Image dimensions: 600 x 600 pixels. The red crosshair sits at the exact center (300, 300).",
        )
      : undefined;

    console.log(`[3/5] Calling Gemini on the ${phase2 ? "cropped " : ""}pinned tile… (PAID CALL)`);
    const t0 = Date.now();
    geminiRaw = await callGemini(toGemini, promptForCall);
    fs.writeFileSync(geminiCachePath, JSON.stringify(geminiRaw, null, 2));
    console.log(`    fresh call took ${Date.now() - t0}ms, cached to ${geminiCachePath}`);
  }

  // Cast geminiRaw to expected shape (matches the revised schema)
  type Conf = "high" | "medium" | "low";
  const g = geminiRaw as {
    outline?: Array<{ x: number; y: number }>;
    facets?: Array<{ letter: string; polygon: Array<{ x: number; y: number }>; orientation: string; confidence: Conf }>;
    roof_lines?: Array<{ start: { x: number; y: number }; end: { x: number; y: number }; is_perimeter: boolean }>;
    objects?: Array<{ kind: "vent" | "chimney" | "hvac_unit" | "skylight" | "plumbing_boot" | "satellite_dish" | "solar_panel"; center: { x: number; y: number }; bbox: { x: number; y: number; width: number; height: number }; confidence: Conf }>;
  };
  console.log(`    Gemini: outline=${g.outline?.length ?? 0}v facets=${g.facets?.length ?? 0} lines=${g.roof_lines?.length ?? 0} objects=${g.objects?.length ?? 0}`);
  console.log(`    Solar:  segments=${solar?.solarPotential?.roofSegmentStats?.length ?? 0} quality=${solar?.imageryQuality ?? "—"}`);

  if ((g.outline?.length ?? 0) < 3) {
    console.log("[!] GEMINI RETURNED EMPTY OUTLINE — target roof not identifiable. Skipping geometry.");
    return;
  }

  // If PHASE_2=1, the image Gemini saw is 600×600 not 1280×1280, but the
  // geographic center stays at Solar's center (we cropped around the
  // centered pin). buildTileMetadata({ sizePx: 300, scale: 2 }) → 600px,
  // same mPerPx as the full tile. Pin lands at (300, 300) in the cropped
  // pixel frame.
  const phase2Active = process.env.PHASE_2 === "1";
  console.log(`[4/5] Geometry module (${phase2Active ? "Phase 2 / 600px" : "Phase 1 / 1280px"})…`);
  const tileMeta = buildTileMetadata({
    centerLat: tileCenterLat,
    centerLng: tileCenterLng,
    zoom: tileZoom,
    scale: 2,
    sizePx: phase2Active ? 300 : 640,
  });
  const vision: VisionRoofOutput = {
    outlinePx: g.outline ?? [],
    facets: (g.facets ?? []).map((f) => ({ letter: f.letter, polygonPx: f.polygon, orientation: f.orientation, confidence: f.confidence ?? "medium" })),
    roofLines: (g.roof_lines ?? []).map((lf) => ({ startPx: lf.start, endPx: lf.end, isPerimeter: lf.is_perimeter })),
    objects: (g.objects ?? []).map((o) => ({ kind: o.kind, centerPx: o.center, bboxPx: o.bbox, confidence: o.confidence ?? "medium" })),
  };
  const measurements = processVisionOutput({
    vision,
    tile: tileMeta,
    solarPlanes: solarToMatches(solar),
  });

  // Reconciler — Gemini outline vs Solar wholeRoofStats + bbox.
  // Mirrors what the live API does at /api/gemini-roof.
  let reconciliation: ReconciliationResult | null = null;
  const wholeRoofM2 = solar?.solarPotential?.wholeRoofStats?.groundAreaMeters2;
  if (solar?.center && solar?.boundingBox && typeof wholeRoofM2 === "number" && wholeRoofM2 > 0) {
    const geminiOutlineLatLng = pixelPolygonToLatLng(vision.outlinePx, tileMeta);
    reconciliation = reconcileGeminiAgainstSolar({
      geminiOutline: geminiOutlineLatLng,
      solarBuildingCenter: { lat: solar.center.latitude, lng: solar.center.longitude },
      solarWholeRoofAreaSqft: wholeRoofM2 * 10.7639,
      solarBoundingBox: {
        sw: { lat: solar.boundingBox.sw.latitude, lng: solar.boundingBox.sw.longitude },
        ne: { lat: solar.boundingBox.ne.latitude, lng: solar.boundingBox.ne.longitude },
      },
    });
    measurements.outlinePolygon = reconciliation.finalOutline;
  }
  fs.writeFileSync(`/tmp/v2-test-${slug}-measurements.json`, JSON.stringify(measurements, null, 2));

  console.log("[5/5] RECONCILIATION");
  if (reconciliation) {
    console.log(`    outlineSource:   ${reconciliation.outlineSource}`);
    console.log(`    acceptedAsIs:    ${reconciliation.acceptedAsIs}`);
    console.log(`    fallback:        ${reconciliation.fallback ?? "—"}`);
    console.log(`    areaRatio:       ${reconciliation.diagnostics.areaRatio.toFixed(2)}`);
    console.log(`    centroidOff:     ${reconciliation.diagnostics.centroidDistanceM.toFixed(1)} m`);
    console.log(`    geminiArea:      ${reconciliation.diagnostics.geminiAreaSqft} sqft`);
    console.log(`    solarArea:       ${reconciliation.diagnostics.solarAreaSqft} sqft`);
    console.log(`    reason: ${reconciliation.reason}`);
  } else {
    console.log("    (solar wholeRoofStats unavailable — no reconciliation)");
  }

  // Track per-case result for the final summary
  PER_CASE.push({
    name: c.name,
    truthSqft: c.truthSqft,
    reconciliation,
    measuredOutlineSqft: Math.round(measurements.outlineFootprintSqft),
    facets: measurements.facets.length,
    lines: vision.roofLines.length,
    objects: measurements.objects.length,
    solarMatchedFraction: measurements.solarMatchedFraction,
  });

  console.log("[6/6] GEOMETRY");
  console.log(`    outlineFootprintSqft:  ${Math.round(measurements.outlineFootprintSqft)} sqft`);
  console.log(`    totalSlopedSqft:       ${Math.round(measurements.totalSlopedSqft)} sqft`);
  console.log(`    totalFootprintSqft:    ${Math.round(measurements.totalFootprintSqft)} sqft`);
  console.log(`    facets:                ${measurements.facets.length}`);
  console.log(`    pitch:                 ${measurements.predominantPitchOnTwelve} (avg ${measurements.averagePitchDegrees.toFixed(1)}°)`);
  console.log(`    solarMatched:          ${(measurements.solarMatchedFraction * 100).toFixed(0)}%`);
  console.log(`    linear_features:`);
  for (const k of ["ridge", "hip", "valley", "rake", "eave"] as const) {
    console.log(`      ${k.padEnd(8)} ${Math.round(measurements.linearFeatureTotalsFt[k])} ft`);
  }
  console.log(`    objects: ${measurements.objects.length}`);
  const byKind: Record<string, number> = {};
  for (const o of measurements.objects) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
  for (const [k, n] of Object.entries(byKind)) console.log(`      ${k}: ${n}`);

  if (c.truthSqft) {
    const delta = Math.round(measurements.outlineFootprintSqft) - c.truthSqft;
    const pct = Math.abs(delta) / c.truthSqft * 100;
    const verdict = pct < 10 ? "✅" : pct < 25 ? "⚠️ " : "❌";
    console.log(`\n  vs EagleView ${c.truthSqft}: ${delta >= 0 ? "+" : ""}${delta} sqft (${pct.toFixed(1)}%) ${verdict}`);
  }
}

interface PerCaseResult {
  name: string;
  truthSqft: number | null;
  reconciliation: ReconciliationResult | null;
  measuredOutlineSqft: number;
  facets: number;
  lines: number;
  objects: number;
  solarMatchedFraction: number;
}
const PER_CASE: PerCaseResult[] = [];

async function main(): Promise<void> {
  console.log(`Model: ${GEMINI_MODEL}\n`);
  for (const c of CASES) {
    try {
      if (c.lat === 0 && c.lng === 0) {
        const g = await geocode(c.name);
        c.lat = g.lat;
        c.lng = g.lng;
        console.log(`Geocoded ${c.name} → (${g.lat}, ${g.lng})`);
      }
      await run(c);
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("\nAll artifacts saved to /tmp/v2-test-*");

  // ─── Final empirical summary (the data the user wants to decide on) ─
  console.log("\n" + "=".repeat(72));
  console.log("RECONCILIATION SUMMARY — what would happen in production");
  console.log("=".repeat(72));
  const total = PER_CASE.length;
  const accepted = PER_CASE.filter((r) => r.reconciliation?.acceptedAsIs).length;
  const fallbacks = {
    expand_to_solar_bbox: PER_CASE.filter((r) => r.reconciliation?.fallback === "expand_to_solar_bbox").length,
    clip_to_solar_bbox: PER_CASE.filter((r) => r.reconciliation?.fallback === "clip_to_solar_bbox").length,
    reject_use_solar: PER_CASE.filter((r) => r.reconciliation?.fallback === "reject_use_solar").length,
  };
  console.log(`Accept rate: ${accepted}/${total} = ${((accepted / total) * 100).toFixed(0)}%`);
  console.log(`Fallback distribution:`);
  console.log(`  expand_to_solar_bbox: ${fallbacks.expand_to_solar_bbox}`);
  console.log(`  clip_to_solar_bbox:   ${fallbacks.clip_to_solar_bbox}`);
  console.log(`  reject_use_solar:     ${fallbacks.reject_use_solar}`);
  console.log();
  console.log(`${"Address".padEnd(40)} ${"Source".padEnd(15)} ${"Ratio".padStart(6)} ${"Centroid".padStart(9)} ${"Truth".padStart(7)} ${"Measured".padStart(9)}`);
  console.log("-".repeat(95));
  for (const r of PER_CASE) {
    const src = r.reconciliation?.outlineSource ?? "—";
    const ratio = r.reconciliation ? r.reconciliation.diagnostics.areaRatio.toFixed(2) : "—";
    const cent = r.reconciliation ? `${r.reconciliation.diagnostics.centroidDistanceM.toFixed(1)}m` : "—";
    const truth = r.truthSqft ? `${r.truthSqft}` : "—";
    console.log(`${r.name.slice(0, 38).padEnd(40)} ${src.padEnd(15)} ${String(ratio).padStart(6)} ${cent.padStart(9)} ${truth.padStart(7)} ${String(r.measuredOutlineSqft).padStart(9)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

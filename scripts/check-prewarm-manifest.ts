/**
 * scripts/check-prewarm-manifest.ts
 *
 * CI consistency check for the pre-warmed-metros pipeline. Fails the
 * build when config/prewarmed_metros.json lists a quadkey that hasn't
 * been pre-warmed onto the Modal volume (i.e. missing from the volume
 * manifest).
 *
 * Without this check, a metro could be added to the config without
 * actually pre-warming its tiles, and runtime would silently fall back
 * to Azure cold fetches on every request (slow + cost).
 *
 * The Modal volume manifest is fetched from a public URL exposed by
 * the LiDAR service (we don't have direct filesystem access from CI).
 * When the LiDAR service isn't reachable in CI (PR from a fork without
 * secrets), this check WARNS but does not fail — manual prewarms are
 * still validated in the staging deploy step.
 *
 * Run:
 *     npx tsx scripts/check-prewarm-manifest.ts
 *
 * Exits:
 *     0 = OK (or warning issued)
 *     1 = quadkey listed in config but missing from manifest
 *     2 = setup error (file missing, JSON parse failed)
 */

import fs from "node:fs";
import path from "node:path";

interface PrewarmedMetros {
  version: number;
  release: string;
  metros: Array<{
    name: string;
    quadkeys_z9: string[];
  }>;
}

interface Manifest {
  tiles: Record<
    string,
    { release: string; sha256: string; fetched_at: string; feature_count: number }
  >;
  last_updated_at?: string;
}

const REPO_ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(REPO_ROOT, "config", "prewarmed_metros.json");
const RELEASE_PATH = path.join(REPO_ROOT, "config", "ms_buildings_release.json");

/** Where the LiDAR service exposes its volume manifest. The service
 *  reads from /cache/prewarmed_metros/_manifest.json and surfaces it
 *  unchanged at GET /ms-buildings-manifest. Optional — when the env
 *  var is unset, this check downgrades to a soft warning. */
const MANIFEST_URL_ENV = "MS_BUILDINGS_MANIFEST_URL";

async function main(): Promise<number> {
  // 1. Load config + release.
  const config = readJson<PrewarmedMetros>(CONFIG_PATH);
  const release = readJson<{ release: string }>(RELEASE_PATH);
  if (!config || !release) return 2;

  const expectedRelease = release.release;
  const configuredQuadkeys = new Set<string>();
  for (const metro of config.metros) {
    for (const qk of metro.quadkeys_z9) configuredQuadkeys.add(qk);
  }
  console.log(
    `[check-prewarm] config lists ${configuredQuadkeys.size} unique ` +
      `quadkeys across ${config.metros.length} metros for release ${expectedRelease}`,
  );

  // Cross-check: config-level `release` matches per-metro releases
  // (sanity — config has one `release` at top level; if we add per-
  // metro release tagging later, validate here).
  if (config.release !== expectedRelease) {
    console.error(
      `[check-prewarm] FAIL config/prewarmed_metros.json release ` +
        `(${config.release}) does not match config/ms_buildings_release.json ` +
        `release (${expectedRelease})`,
    );
    return 1;
  }

  // 2. Fetch the volume manifest (if possible).
  const manifestUrl = process.env[MANIFEST_URL_ENV];
  if (!manifestUrl) {
    console.warn(
      `[check-prewarm] WARN ${MANIFEST_URL_ENV} not set — skipping ` +
        `Modal-volume cross-check. Manifest consistency must be ` +
        `verified manually before deploy.`,
    );
    return 0;
  }

  let manifest: Manifest;
  try {
    const resp = await fetch(manifestUrl, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      console.warn(
        `[check-prewarm] WARN manifest fetch returned ${resp.status} — ` +
          "treating as soft-pass (deploy-time staging will catch this)",
      );
      return 0;
    }
    manifest = (await resp.json()) as Manifest;
  } catch (err) {
    console.warn(
      `[check-prewarm] WARN manifest fetch failed (${
        err instanceof Error ? err.message : String(err)
      }) — treating as soft-pass`,
    );
    return 0;
  }

  // 3. Validate every configured quadkey is in the manifest at the
  //    expected release.
  const missing: string[] = [];
  const stale: string[] = [];
  for (const qk of configuredQuadkeys) {
    const entry = manifest.tiles?.[qk];
    if (!entry) {
      missing.push(qk);
      continue;
    }
    if (entry.release !== expectedRelease) {
      stale.push(`${qk} (manifest=${entry.release}, expected=${expectedRelease})`);
    }
  }

  if (missing.length > 0 || stale.length > 0) {
    console.error("[check-prewarm] FAIL — prewarm needed before merge");
    if (missing.length > 0) {
      console.error(`  Missing tiles (${missing.length}):`);
      for (const m of missing) console.error(`    - ${m}`);
    }
    if (stale.length > 0) {
      console.error(`  Stale-release tiles (${stale.length}):`);
      for (const s of stale) console.error(`    - ${s}`);
    }
    console.error("");
    console.error("  To fix: run `modal run scripts.prewarm_ms_buildings`");
    console.error("  to populate the Modal volume with the missing tiles,");
    console.error("  then re-run this check.");
    return 1;
  }

  console.log(
    `[check-prewarm] OK — all ${configuredQuadkeys.size} configured ` +
      `quadkeys present in volume manifest at release ${expectedRelease}`,
  );
  return 0;
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch (err) {
    console.error(`[check-prewarm] FAIL reading ${p}: ${err}`);
    return null;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[check-prewarm] uncaught error", err);
    process.exit(2);
  });

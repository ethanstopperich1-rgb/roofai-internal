"""
scripts/prewarm_ms_buildings.py

Pre-warms the Microsoft Buildings tiles for the metros listed in
config/prewarmed_metros.json onto the Modal volume mounted at
/cache/prewarmed_metros/. Idempotent — re-running skips tiles that
are already present at the current release.

Usage (Modal):
    modal run scripts.prewarm_ms_buildings

Usage (local dev, no Modal):
    python scripts/prewarm_ms_buildings.py --local --out ./prewarmed-out

What this writes per tile:
    /cache/prewarmed_metros/{quadkey9}.geojsonl.gz
    /cache/prewarmed_metros/_manifest.json

The manifest tracks `{quadkey: {release, sha256, fetched_at}}` and is
consumed by:
  - scripts/check-prewarm-manifest.ts (CI consistency check)
  - the Modal LiDAR service's /ms-buildings-tile endpoint, which checks
    "does the prewarmed file exist?" before falling through to a live
    Azure fetch.

Output is GeoJSONL (one Feature per line) gzipped — keeps tile size
~5-15 MB per quadkey-9 of dense residential, well under Modal volume
free-tier limits.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import logging
import os
import sys
import time
from typing import Any

log = logging.getLogger("prewarm_ms_buildings")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ─── Config + paths ──────────────────────────────────────────────────

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREWARMED_METROS_PATH = os.path.join(REPO_ROOT, "config", "prewarmed_metros.json")
RELEASE_PATH = os.path.join(REPO_ROOT, "config", "ms_buildings_release.json")

# Modal volume mount path inside the running function. The volume is
# also mounted by the LiDAR service at the same path so reads + writes
# share the same filesystem.
VOLUME_PATH_DEFAULT = "/cache/prewarmed_metros"
MANIFEST_FILENAME = "_manifest.json"


def load_config() -> tuple[dict[str, Any], dict[str, Any]]:
    with open(PREWARMED_METROS_PATH) as f:
        metros = json.load(f)
    with open(RELEASE_PATH) as f:
        release = json.load(f)
    return metros, release


# ─── Azure fetch ─────────────────────────────────────────────────────


def read_dataset_links_csv(release_cfg: dict[str, Any]) -> dict[str, list[str]]:
    """Fetch MS's dataset-links.csv and return a {quadkey: [tile_urls]}
    map. MS partitions each release across multiple part files per
    quadkey; we collect them all and concatenate at write time."""
    import requests  # noqa: PLC0415

    url = release_cfg["dataset_links_csv"]
    log.info("fetching dataset-links.csv from %s", url)
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    by_quadkey: dict[str, list[str]] = {}
    for row in reader:
        # CSV header varies slightly by release; tolerate both common shapes.
        quadkey = row.get("QuadKey") or row.get("quadkey") or row.get("Quadkey")
        tile_url = row.get("Url") or row.get("url") or row.get("URL")
        if not quadkey or not tile_url:
            continue
        by_quadkey.setdefault(str(quadkey), []).append(tile_url)
    log.info("indexed %d quadkeys from dataset-links.csv", len(by_quadkey))
    return by_quadkey


def fetch_tile_features(tile_urls: list[str]) -> list[dict[str, Any]]:
    """Concatenate features from all part-files for one quadkey-9 tile.
    MS publishes each part as gzipped GeoJSONL (one Feature per line)."""
    import requests  # noqa: PLC0415

    all_features: list[dict[str, Any]] = []
    for url in tile_urls:
        log.info("  fetching %s", url)
        resp = requests.get(url, timeout=180, stream=True)
        resp.raise_for_status()
        raw = resp.content
        # MS publishes both .csv.gz and .geojsonl.gz across releases.
        # Detect by content first 2 bytes (0x1f 0x8b = gzip magic).
        if raw[:2] == b"\x1f\x8b":
            try:
                decompressed = gzip.decompress(raw)
            except OSError:
                decompressed = raw
        else:
            decompressed = raw
        for line in decompressed.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                feature = json.loads(line)
                if feature.get("type") == "Feature":
                    all_features.append(feature)
            except json.JSONDecodeError:
                continue
    log.info("  total %d features across %d part(s)", len(all_features), len(tile_urls))
    return all_features


# ─── Output ──────────────────────────────────────────────────────────


def write_tile(out_dir: str, quadkey: str, features: list[dict[str, Any]]) -> str:
    """Write features to {out_dir}/{quadkey}.geojsonl.gz. Returns
    sha256 of the uncompressed content for the manifest."""
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{quadkey}.geojsonl.gz")
    h = hashlib.sha256()
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
        for feature in features:
            line = (json.dumps(feature, separators=(",", ":")) + "\n").encode("utf-8")
            h.update(line)
            gz.write(line)
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    log.info("  wrote %s (%.2f MB, sha256=%s)", path,
             len(buf.getvalue()) / 1024 / 1024, h.hexdigest()[:16])
    return h.hexdigest()


def update_manifest(
    out_dir: str,
    quadkey: str,
    release: str,
    sha256: str,
    feature_count: int,
) -> None:
    """Merge a new entry into the on-disk manifest. The CI check reads
    this file to verify prewarmed_metros.json doesn't reference any
    quadkeys missing from the volume."""
    manifest_path = os.path.join(out_dir, MANIFEST_FILENAME)
    manifest: dict[str, Any] = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    manifest.setdefault("tiles", {})
    manifest["tiles"][quadkey] = {
        "release": release,
        "sha256": sha256,
        "feature_count": feature_count,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    manifest["last_updated_at"] = manifest["tiles"][quadkey]["fetched_at"]
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)


def load_manifest(out_dir: str) -> dict[str, Any]:
    path = os.path.join(out_dir, MANIFEST_FILENAME)
    if not os.path.exists(path):
        return {"tiles": {}}
    with open(path) as f:
        return json.load(f)


# ─── Orchestration ───────────────────────────────────────────────────


def run(out_dir: str, force: bool = False) -> int:
    metros, release_cfg = load_config()
    release = release_cfg["release"]

    needed_quadkeys: set[str] = set()
    for metro in metros["metros"]:
        for qk in metro.get("quadkeys_z9", []):
            needed_quadkeys.add(str(qk))
    log.info(
        "config lists %d unique quadkeys across %d metros for release %s",
        len(needed_quadkeys), len(metros["metros"]), release,
    )

    existing = load_manifest(out_dir).get("tiles", {})
    to_fetch: list[str] = []
    for qk in sorted(needed_quadkeys):
        entry = existing.get(qk)
        if entry and entry.get("release") == release and not force:
            log.info("  skip %s (already at release %s)", qk, release)
            continue
        to_fetch.append(qk)

    if not to_fetch:
        log.info("all quadkeys up to date — nothing to do")
        return 0

    log.info("will fetch %d quadkeys: %s", len(to_fetch), to_fetch)
    by_quadkey = read_dataset_links_csv(release_cfg)

    failures: list[str] = []
    for qk in to_fetch:
        urls = by_quadkey.get(qk, [])
        if not urls:
            log.warning("  quadkey %s not in dataset-links.csv — skipping", qk)
            failures.append(qk)
            continue
        try:
            features = fetch_tile_features(urls)
        except Exception as err:  # noqa: BLE001
            log.error("  fetch %s failed: %s", qk, err)
            failures.append(qk)
            continue
        sha = write_tile(out_dir, qk, features)
        update_manifest(out_dir, qk, release, sha, len(features))

    if failures:
        log.warning("FAILED %d quadkeys: %s", len(failures), failures)
        return 1
    log.info("OK — all %d quadkeys present at release %s", len(needed_quadkeys), release)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-warm MS Buildings tiles.")
    parser.add_argument(
        "--out", default=VOLUME_PATH_DEFAULT,
        help=f"Output directory (default {VOLUME_PATH_DEFAULT})",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Re-fetch even if the manifest says we're already at the release.",
    )
    parser.add_argument(
        "--local", action="store_true",
        help="Skip Modal mode; just run locally writing to --out.",
    )
    args = parser.parse_args()
    return run(args.out, force=args.force)


if __name__ == "__main__":
    sys.exit(main())

"""
services/roof-lidar/coverage_check.py

Decides whether the USGS 3DEP LiDAR archive has point cloud coverage
for a given lat/lng, and returns the EPT (Entwine Point Tile) project
URL that covers it.

Why EPT instead of LAZ tiles? EPT is a spatially-indexed S3-hosted
point-cloud format. PDAL's readers.ept supports bbox-bounded queries —
we fetch ~1-2 MB of points covering the parcel instead of downloading
a 360MB LAZ tile that covers 1500m × 1500m. Cold path drops from
~6 min to ~30 sec.

USGS hosts EPT versions of every 3DEP project at:
    https://s3-us-west-2.amazonaws.com/usgs-lidar-public/<PROJECT>/ept.json

Two-stage coverage resolution:
  1. Fast path — hardcoded FL_COUNTY_PROJECTS bounding-box table for the
     Voxaris service area. Rectangular bboxes that approximate county
     shapes; resolved in microseconds with zero network I/O.

  2. AWS fallback — when the fast path misses (address near a county
     line, outside FL, or new market), fetch the USGS-published
     boundaries GeoJSON from the same `usgs-lidar-public` S3 bucket
     (the authoritative AWS index of every 3DEP EPT project), do a
     point-in-polygon test, and return the most recent covering
     project. Cached on the Modal volume for 30 days so subsequent
     misses are still O(1).
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any

log = logging.getLogger(__name__)

EPT_BASE_URL = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public"
# Official AWS index of every EPT project boundary. ~17 MB GeoJSON;
# fetched once, cached on the Modal volume, then reused.
BOUNDARIES_URL = f"{EPT_BASE_URL}/boundaries/resources.geojson"
BOUNDARIES_CACHE_TTL_S = 30 * 24 * 3600  # 30 days

# Hardcoded FL county bounds (rough lat/lng rectangles). Maps each
# county to its USGS EPT project name. Expand as the service rolls
# out to new markets — replace with proper TIGER/Line lookup once
# we're outside Florida.
FL_COUNTY_PROJECTS: list[dict[str, Any]] = [
    # Orlando metro (Voxaris primary market)
    {"county": "Orange",  "project": "FL_Peninsular_FDEM_Orange_2018",   "min_lat": 28.34, "max_lat": 28.78, "min_lng": -81.66, "max_lng": -80.87},
    {"county": "Seminole","project": "FL_Peninsular_Seminole_2018",     "min_lat": 28.60, "max_lat": 28.86, "min_lng": -81.45, "max_lng": -81.00},
    {"county": "Osceola", "project": "FL_Peninsular_FDEM_Osceola_2018",  "min_lat": 27.78, "max_lat": 28.43, "min_lng": -81.65, "max_lng": -80.86},
    {"county": "Lake",    "project": "FL_Peninsular_Lake_2018",          "min_lat": 28.45, "max_lat": 29.05, "min_lng": -81.96, "max_lng": -81.34},
    {"county": "Volusia", "project": "FL_Peninsular_Volusia_2018",       "min_lat": 28.74, "max_lat": 29.39, "min_lng": -81.66, "max_lng": -80.78},
    # Tampa metro
    {"county": "Hillsborough", "project": "FL_Peninsular_Hillsborough_2018", "min_lat": 27.62, "max_lat": 28.17, "min_lng": -82.61, "max_lng": -82.05},
    {"county": "Pinellas",     "project": "FL_Peninsular_Pinellas_2018",     "min_lat": 27.58, "max_lat": 28.18, "min_lng": -82.85, "max_lng": -82.55},
    {"county": "Pasco",        "project": "FL_Peninsular_FDEM_Pasco_2018",   "min_lat": 28.16, "max_lat": 28.66, "min_lng": -82.78, "max_lng": -81.99},
    {"county": "Polk",         "project": "FL_Peninsular_FDEM_Polk_2018",    "min_lat": 27.66, "max_lat": 28.31, "min_lng": -82.10, "max_lng": -81.20},
    # South FL
    {"county": "Brevard",      "project": "FL_Peninsular_FDEM_Brevard_2018",  "min_lat": 27.78, "max_lat": 28.99, "min_lng": -80.93, "max_lng": -80.42},
    {"county": "PalmBeach",    "project": "FL_Peninsular_FDEM_PalmBeach_2019","min_lat": 26.32, "max_lat": 26.97, "min_lng": -80.42, "max_lng": -80.03},
    {"county": "Broward",      "project": "FL_Peninsular_FDEM_Broward_2018",  "min_lat": 25.95, "max_lat": 26.32, "min_lng": -80.49, "max_lng": -80.04},
    {"county": "Miami-Dade",   "project": "FL_Peninsular_FDEM_MiamiDade_2018","min_lat": 25.13, "max_lat": 25.98, "min_lng": -80.87, "max_lng": -80.12},
]


def check_3dep_coverage(
    *, lat: float, lng: float, cache_dir: str | None = None,
) -> dict[str, Any]:
    """Return dict with keys:
        covered: bool
        tile_ids: list[str]           — [ept_url] when covered (single EPT
                                        URL, not LAZ tile URLs anymore)
        project_name: str | None      — USGS project slug
        capture_date: str | None      — Hardcoded per-project; refine when
                                        we have project-metadata fetches
        coverage_pct: float           — 1.0 when project found, 0.0 otherwise

    Resolution: try the hardcoded FL fast-path first, then fall back to
    the AWS-published boundaries GeoJSON for any other US address."""
    project = _find_project(lat=lat, lng=lng)
    project_name: str | None = None
    if project:
        project_name = project["project"]
    else:
        project_name = _find_project_via_aws(
            lat=lat, lng=lng, cache_dir=cache_dir,
        )
        if not project_name:
            log.warning("no EPT project found for (%.6f, %.6f)", lat, lng)
            return _no_coverage()
        log.info(
            "AWS fallback matched project %s for (%.6f, %.6f)",
            project_name, lat, lng,
        )

    ept_url = f"{EPT_BASE_URL}/{project_name}/ept.json"
    return {
        "covered": True,
        # tile_ids[0] is the EPT URL. pull_lidar.py treats this as
        # a PDAL pipeline source, not a raw LAZ file.
        "tile_ids": [ept_url],
        "project_name": project_name,
        "capture_date": (project or {}).get("capture_date")
            or _infer_capture_date(project_name),
        "coverage_pct": 1.0,
    }


def _find_project(*, lat: float, lng: float) -> dict[str, Any] | None:
    """Match parcel lat/lng to the FL county whose bounds contain it.
    Fast-path only — exact county-bbox match. AWS fallback handles
    everything outside this table."""
    for proj in FL_COUNTY_PROJECTS:
        if proj["min_lat"] <= lat <= proj["max_lat"] and proj["min_lng"] <= lng <= proj["max_lng"]:
            return proj
    return None


def _find_project_via_aws(
    *, lat: float, lng: float, cache_dir: str | None = None,
) -> str | None:
    """AWS fallback. Fetches the official USGS 3DEP boundaries GeoJSON
    (https://registry.opendata.aws/usgs-lidar/), caches it locally,
    does a point-in-polygon test against every project boundary, and
    returns the most recent covering project's slug.

    Cache key: `boundaries.geojson` under `cache_dir` (Modal volume on
    prod; /tmp in local dev). TTL = 30 days. The GeoJSON is regenerated
    by USGS when new flights publish, but the rate is monthly at most
    — far slower than our cache window.

    Picking the "best" project when several overlap:
        - prefer the most recent year (last 4-digit run in the slug)
        - tiebreak by alphabetical project name (deterministic)
    """
    try:
        import requests  # noqa: PLC0415
        from shapely.geometry import Point, shape  # noqa: PLC0415
    except ImportError as err:
        log.warning("AWS fallback unavailable: %s", err)
        return None

    geojson = _load_boundaries_geojson(cache_dir=cache_dir, requests_mod=requests)
    if not geojson:
        return None

    pt = Point(lng, lat)
    candidates: list[tuple[int, str]] = []  # (year, project_name)
    for feature in geojson.get("features", []):
        props = feature.get("properties") or {}
        name = (props.get("name") or props.get("id") or "").strip()
        geom = feature.get("geometry")
        if not name or not geom:
            continue
        try:
            poly = shape(geom)
            if poly.contains(pt) or poly.touches(pt):
                year = _year_from_name(name)
                candidates.append((year, name))
        except Exception:  # noqa: BLE001
            continue

    if not candidates:
        return None

    # Most recent year first, alphabetical tiebreak. Newer LiDAR is
    # almost always more accurate — instrumentation has improved and
    # ground-control quality has gone up across the 3DEP program.
    candidates.sort(key=lambda t: (-t[0], t[1]))
    return candidates[0][1]


def _load_boundaries_geojson(
    *, cache_dir: str | None, requests_mod: Any,
) -> dict[str, Any] | None:
    """Fetch + cache the AWS boundaries GeoJSON. Returns None on failure
    so the caller can degrade gracefully (Tier A falls through to Tier C)."""
    base = cache_dir or "/tmp"
    try:
        os.makedirs(base, exist_ok=True)
    except OSError:
        pass
    cache_path = os.path.join(base, "usgs_3dep_boundaries.geojson")

    # Cache hit
    try:
        if os.path.exists(cache_path):
            age = time.time() - os.path.getmtime(cache_path)
            if age < BOUNDARIES_CACHE_TTL_S:
                with open(cache_path) as f:
                    return json.load(f)
    except (OSError, json.JSONDecodeError) as err:
        log.warning("boundaries cache read failed: %s", err)

    # Cache miss — fetch
    log.info("fetching USGS 3DEP boundaries from %s", BOUNDARIES_URL)
    try:
        resp = requests_mod.get(BOUNDARIES_URL, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as err:  # noqa: BLE001
        log.warning("boundaries fetch failed: %s", err)
        return None

    # Persist for next call
    try:
        with open(cache_path, "w") as f:
            json.dump(data, f)
    except OSError as err:
        log.warning("boundaries cache write failed: %s", err)
    return data


def _year_from_name(project_name: str) -> int:
    """Extract the most recent 4-digit year from a project slug. USGS
    slugs typically end with a year (e.g. `FL_Peninsular_FDEM_PalmBeach_2019`).
    A few have ranges (`USGS_LPC_..._2018_2019`); we pick the latter."""
    years = [
        int(y) for y in re.findall(r"\b(20\d{2})\b", project_name)
        if 2000 <= int(y) <= 2030
    ]
    return max(years) if years else 0


def _infer_capture_date(project_name: str) -> str | None:
    """Pull the year out of the project name as a coarse capture date.
    E.g. FL_Peninsular_FDEM_Orange_2018 → 2018-01-01. Replace with real
    metadata lookup once we have time-series projects in scope."""
    parts = project_name.split("_")
    for p in parts:
        if p.isdigit() and len(p) == 4 and 2000 <= int(p) <= 2030:
            return f"{p}-01-01"
    return None


def _no_coverage() -> dict[str, Any]:
    return {
        "covered": False,
        "tile_ids": [],
        "project_name": None,
        "capture_date": None,
        "coverage_pct": 0.0,
    }

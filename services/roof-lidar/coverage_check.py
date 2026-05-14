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

FL coverage is published per-county under FL_Peninsular_FDEM_<County>_2018
(2018/2019 statewide flight). When we expand outside FL we'll need
either reverse-geocoding to find the right project or the full
3DEP project index. For now: hardcoded map for Voxaris's service area.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

EPT_BASE_URL = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public"

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


def check_3dep_coverage(*, lat: float, lng: float) -> dict[str, Any]:
    """Return dict with keys:
        covered: bool
        tile_ids: list[str]           — [ept_url] when covered (single EPT
                                        URL, not LAZ tile URLs anymore)
        project_name: str | None      — USGS project slug
        capture_date: str | None      — Hardcoded per-project; refine when
                                        we have project-metadata fetches
        coverage_pct: float           — 1.0 when project found, 0.0 otherwise
    """
    project = _find_project(lat=lat, lng=lng)
    if not project:
        log.warning("no EPT project found for (%.6f, %.6f)", lat, lng)
        return _no_coverage()

    ept_url = f"{EPT_BASE_URL}/{project['project']}/ept.json"
    return {
        "covered": True,
        # tile_ids[0] is the EPT URL. pull_lidar.py treats this as
        # a PDAL pipeline source, not a raw LAZ file.
        "tile_ids": [ept_url],
        "project_name": project["project"],
        "capture_date": project.get("capture_date") or _infer_capture_date(project["project"]),
        "coverage_pct": 1.0,
    }


def _find_project(*, lat: float, lng: float) -> dict[str, Any] | None:
    """Match parcel lat/lng to the FL county whose bounds contain it."""
    for proj in FL_COUNTY_PROJECTS:
        if proj["min_lat"] <= lat <= proj["max_lat"] and proj["min_lng"] <= lng <= proj["max_lng"]:
            return proj
    return None


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

"""
services/roof-lidar/coverage_check.py

Decides whether the USGS 3DEP LiDAR archive has point cloud coverage
for a given lat/lng, and returns the tile download URLs that intersect
a ~500m bbox around the address plus the most recent capture date.

PRIMARY DATA SOURCE — USGS National Map TNM Access API:

    https://tnmaccess.nationalmap.gov/api/v1/products

This is the same REST endpoint that powers the USGS National Map
Viewer. It accepts a bbox query and returns matching products
(including Lidar Point Cloud) with download URLs, capture dates, and
size metadata. Much simpler — and CORRECT — than the previous attempt
of listing S3 prefixes by state (which silently failed for FL because
the project structure is nested several levels deep and the first 50
keys alphabetically are metadata/browse JPGs, not .laz tiles).

CONUS coverage is published at https://prd-tnm.s3.amazonaws.com/ under
`StagedProducts/Elevation/LPC/Projects/`. The TNM API maps a bbox to a
list of tiles; this function returns those tiles' direct-HTTPS
downloadURLs which pull_lidar.py fetches over HTTPS (no S3 client
needed for the data retrieval — TNM serves on rockyweb.usgs.gov).
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

TNM_API_URL = "https://tnmaccess.nationalmap.gov/api/v1/products"
# Half-extent in meters for the bbox we send to TNM. Residential
# parcels are typically <50m across; 250m gives margin for the 4
# adjacent tiles a flight stores them in. 500m would pull in
# neighbouring tiles unnecessarily.
BBOX_HALF_EXTENT_M = 250


def check_3dep_coverage(*, lat: float, lng: float) -> dict[str, Any]:
    """Return dict with keys:
        covered: bool
        tile_ids: list[str]           — Direct HTTPS download URLs for
                                        each LAZ tile that intersects
                                        the parcel bbox. pull_lidar.py
                                        fetches these directly.
        project_name: str | None      — USGS project slug
                                        (e.g. "FL_Peninsular_FDEM_2018_D19_DRRA")
        capture_date: str | None      — ISO date of the flight
                                        (publicationDate from TNM)
        coverage_pct: float           — fraction of the bbox covered.
                                        1.0 when TNM returned ≥1 tile.
    """
    try:
        import requests  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"requests not installed: {err}") from err

    bbox = _bbox_around(lat=lat, lng=lng, half_extent_m=BBOX_HALF_EXTENT_M)
    bbox_str = (
        f"{bbox['min_lng']},{bbox['min_lat']},{bbox['max_lng']},{bbox['max_lat']}"
    )

    params = {
        "datasets": "Lidar Point Cloud (LPC)",
        "bbox": bbox_str,
        "prodFormats": "LAS,LAZ",
        "max": 25,  # cap pulls — 1-4 typical for a residential parcel
    }
    try:
        response = requests.get(TNM_API_URL, params=params, timeout=15)
        response.raise_for_status()
    except Exception as err:  # noqa: BLE001
        log.warning("TNM API request failed: %s", err)
        return _no_coverage()

    payload = response.json()
    items = payload.get("items", []) or []
    if not items:
        return _no_coverage()

    # Each item has downloadURL + publicationDate. Filter to LAZ/LAS
    # only (TNM occasionally returns related artefacts).
    tiles: list[dict[str, Any]] = []
    for item in items:
        url = item.get("downloadURL")
        fmt = (item.get("format") or "").upper()
        if not url:
            continue
        if fmt not in ("LAZ", "LAS"):
            continue
        tiles.append({
            "url": url,
            "publicationDate": item.get("publicationDate"),
            "title": item.get("title"),
            "sizeInBytes": item.get("sizeInBytes"),
        })

    if not tiles:
        return _no_coverage()

    capture_date = max(
        (t["publicationDate"] for t in tiles if t.get("publicationDate")),
        default=None,
    )
    project_name = _infer_project_name(tiles[0]["url"])

    return {
        "covered": True,
        "tile_ids": [t["url"] for t in tiles],
        "project_name": project_name,
        "capture_date": capture_date,
        "coverage_pct": 1.0,
    }


def _no_coverage() -> dict[str, Any]:
    return {
        "covered": False,
        "tile_ids": [],
        "project_name": None,
        "capture_date": None,
        "coverage_pct": 0.0,
    }


def _bbox_around(*, lat: float, lng: float, half_extent_m: float) -> dict[str, float]:
    """Small WGS84 bbox using local-flat-earth approximation. Good
    enough for the ±250m TNM query — we're not doing precise geodesy."""
    import math  # noqa: PLC0415
    lat_per_m = 1.0 / 111_320.0
    lng_per_m = 1.0 / (111_320.0 * math.cos(math.radians(lat)))
    dlat = half_extent_m * lat_per_m
    dlng = half_extent_m * lng_per_m
    return {
        "min_lat": lat - dlat,
        "max_lat": lat + dlat,
        "min_lng": lng - dlng,
        "max_lng": lng + dlng,
    }


def _infer_project_name(url: str) -> str | None:
    """Pull the project slug out of a TNM download URL like
    https://rockyweb.usgs.gov/.../Projects/FL_Peninsular_FDEM_2018_D19_DRRA/...
    """
    parts = url.split("/")
    try:
        idx = parts.index("Projects")
        return parts[idx + 1] if idx + 1 < len(parts) else None
    except ValueError:
        return None

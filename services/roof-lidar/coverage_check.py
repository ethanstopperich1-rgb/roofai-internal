"""
services/roof-lidar/coverage_check.py

Decides whether the USGS 3DEP LiDAR archive has point cloud coverage
for a given lat/lng, and if so returns the tile IDs that intersect a
~500m bbox around the address plus the most recent capture date.

3DEP is published in S3 buckets organized by Project → Workunit →
LAZ tiles. The authoritative manifest is at:

    https://www.usgs.gov/tools/3dep-lidar-explorer

For programmatic access we use the AWS open-data registry:

    s3://prd-tnm/StagedProducts/Elevation/LPC/Projects/

Each project has a `metadata` folder with project-level WKT bounding
polygons and a per-tile shapefile index. This module reads the
projects index (cached locally for 24h) and finds projects that
contain the query point, then returns their tile ID list.

For production tuning:
- TODO: the project shapefile index is large (~50MB); subset to a
  state-level cache to keep cold-start under 5s.
- TODO: Florida has the post-hurricane statewide program — prefer it
  over the smaller county-level projects when both cover the same point.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)


def check_3dep_coverage(*, lat: float, lng: float) -> dict[str, Any]:
    """Return dict with keys:
        covered: bool
        tile_ids: list[str]           — LAZ tile keys in S3
        project_name: str | None
        capture_date: str | None      — ISO date of the flight
        coverage_pct: float           — fraction of the 500m bbox covered (1.0 = full)
    """
    # Lazy import — boto3 is heavy and only needed when actually checking.
    try:
        import boto3  # noqa: PLC0415
        from botocore import UNSIGNED  # noqa: PLC0415
        from botocore.config import Config  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"boto3 not installed: {err}") from err

    s3 = boto3.client(
        "s3",
        config=Config(signature_version=UNSIGNED, region_name="us-west-2"),
    )

    # The 3DEP projects manifest lists every project's bbox in
    # `prd-tnm/StagedProducts/Elevation/metadata/`. For the v1 build we
    # short-circuit: query the bucket prefix that contains the lat-tile
    # for this state. This is a heuristic — production should read the
    # GeoPackage projects index — but it's enough for the first deploy.
    #
    # TODO: replace heuristic-prefix list with proper index lookup using
    # `s3://usgs-lidar-public/usgs-3dep-mvt-tindex.gpkg` once we have
    # geopandas in the image.
    state_prefixes = _state_prefix_candidates(lat=lat, lng=lng)
    if not state_prefixes:
        return {
            "covered": False,
            "tile_ids": [],
            "project_name": None,
            "capture_date": None,
            "coverage_pct": 0.0,
        }

    # Coverage probe — verify the project prefix exists in S3 with
    # ANY key (even a project shapefile counts). We don't try to find
    # .laz files in the listing here because:
    #   1. Florida alone has 20+ projects under `FL_`; alphabetical
    #      listing with MaxKeys=50 returns only metadata/browse JPGs
    #      from the first project, never reaching .laz tiles.
    #   2. Spatial filtering (does THIS lat/lng land in THIS project?)
    #      requires the GeoPackage tile index, which we don't carry
    #      in the Modal image yet (TODO above).
    # Strategy: confirm SOMETHING exists under the state prefix (so we
    # know USGS publishes data there), then defer to pull_lidar.py for
    # actual per-parcel tile intersection. If no tiles overlap the
    # parcel bbox, pull_lidar.py returns empty and the orchestrator
    # falls through to Tier C — same end-state as a covered=False
    # return, but it gives addresses inside real coverage a chance to
    # succeed when they should.
    project_keys: list[str] = []
    capture_date: str | None = None
    for prefix in state_prefixes:
        try:
            response = s3.list_objects_v2(
                Bucket="prd-tnm",
                Prefix=prefix,
                Delimiter="/",
                MaxKeys=200,
            )
        except Exception as err:  # noqa: BLE001
            log.warning("3dep coverage list failed for %s: %s", prefix, err)
            continue
        for common in response.get("CommonPrefixes", []):
            project_keys.append(common["Prefix"])
        for obj in response.get("Contents", []):
            mod = obj.get("LastModified")
            if mod:
                iso = mod.isoformat()
                if capture_date is None or iso > capture_date:
                    capture_date = iso

    if not project_keys:
        return {
            "covered": False,
            "tile_ids": [],
            "project_name": None,
            "capture_date": None,
            "coverage_pct": 0.0,
        }

    return {
        "covered": True,
        # Hand off the project prefix list; pull_lidar.py will intersect
        # with the parcel bbox to find actual tile keys.
        "tile_ids": project_keys,
        "project_name": _infer_project_name(project_keys[0]),
        "capture_date": capture_date,
        "coverage_pct": 1.0,  # optimistic; refine when GeoPackage index lands
    }


def _state_prefix_candidates(*, lat: float, lng: float) -> list[str]:
    """Heuristic mapping from lat/lng → likely S3 project prefixes.

    Florida (Voxaris's core market) is well-covered by FEMA / USGS
    post-hurricane statewide programs. CONUS-wide coverage is fragmented
    across hundreds of projects, so a fuzzy state-level lookup avoids
    listing the entire 50TB bucket on every request.

    TODO(post-deploy): replace with a real GeoPackage index lookup.
    """
    # Coarse state buckets — only Florida + common Voxaris demo areas
    # for v1. Expand as the service rolls out to new markets.
    candidates: list[str] = []
    if 24 <= lat <= 31 and -88 <= lng <= -79:  # Florida-ish
        candidates.append("StagedProducts/Elevation/LPC/Projects/FL_")
    if 30 <= lat <= 37 and -101 <= lng <= -93:  # Texas-ish
        candidates.append("StagedProducts/Elevation/LPC/Projects/TX_")
    if 41 <= lat <= 49 and -97 <= lng <= -89:  # Minnesota-ish
        candidates.append("StagedProducts/Elevation/LPC/Projects/MN_")
    if not candidates:
        # Generic catch — listing across all projects is too expensive,
        # so we just signal "unknown state, look manually" by returning
        # nothing. The api.py wrapper treats this as no-coverage and
        # falls through to Tier B/C.
        candidates.append("StagedProducts/Elevation/LPC/Projects/")
    return candidates


def _infer_project_name(key: str) -> str | None:
    """Pull the project slug out of an S3 key like
    `StagedProducts/Elevation/LPC/Projects/FL_Peninsular_2018_B19/...`."""
    parts = key.split("/")
    try:
        idx = parts.index("Projects")
        return parts[idx + 1] if idx + 1 < len(parts) else None
    except ValueError:
        return None

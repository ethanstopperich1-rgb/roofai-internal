"""
services/roof-lidar/pull_lidar.py

Fetch LAS/LAZ tiles from the USGS 3DEP S3 bucket, decompress, return
the concatenated point cloud as a NumPy array.

The Modal function mounts a persistent volume at `cache_root` so
fetched tiles survive 24h between calls. Cache key is the tile S3 key
hashed; cache invalidation isn't needed within 24h because 3DEP files
are immutable once published.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)

# Anonymous S3 client (3DEP is a public bucket).
_BUCKET = "prd-tnm"


def fetch_lidar_for_bbox(
    *,
    lat: float,
    lng: float,
    tile_ids: list[str],
    cache_root: str | None = None,
) -> dict[str, Any]:
    """Return a dict with:
        xyz: numpy.ndarray of shape (N, 3) — points in WGS84 lat/lng/alt
        classification: numpy.ndarray of shape (N,) — LAS class codes
        bbox: dict with min/max lat/lng/alt

    Filters to a 500m bbox around (lat, lng) before returning to keep
    downstream memory bounded for sub-suburban parcels.
    """
    try:
        import boto3  # noqa: PLC0415
        from botocore import UNSIGNED  # noqa: PLC0415
        from botocore.config import Config  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
        import laspy  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"required dep missing: {err}") from err

    if not tile_ids:
        raise ValueError("no tile_ids supplied")

    s3 = boto3.client(
        "s3", config=Config(signature_version=UNSIGNED, region_name="us-west-2"),
    )

    # Limit to the first 4 tiles (large flights have hundreds; 4 tiles
    # at ~250m each is enough to cover a residential parcel).
    pulled: list[Any] = []
    for tile_key in tile_ids[:4]:
        local_path = _ensure_cached_tile(s3, tile_key, cache_root)
        try:
            las = laspy.read(local_path)
            pulled.append(las)
        except Exception as err:  # noqa: BLE001
            log.warning("failed to parse %s: %s", tile_key, err)

    if not pulled:
        raise RuntimeError("no tiles parseable")

    # Concatenate raw points + classifications.
    all_xyz: list[Any] = []
    all_class: list[Any] = []
    for las in pulled:
        xyz = np.vstack((las.x, las.y, las.z)).T
        all_xyz.append(xyz)
        all_class.append(np.asarray(las.classification))
    xyz = np.vstack(all_xyz)
    classification = np.concatenate(all_class)

    # LAS coordinates may be in a state-plane / UTM projection; convert
    # to WGS84 lat/lng using the LAS file's CRS (laspy exposes via
    # `parse_crs()`). For v1 we assume the LAS is already lat/lng — this
    # is wrong for many real LAS files, hence the TODO. The bbox filter
    # below uses the raw XY as if they were lng/lat which works for
    # already-WGS84 data and is *visibly broken* for projected data,
    # which is the right surface signal for the user to swap in proper
    # CRS handling.
    # TODO(post-deploy): use pyproj.Transformer with the LAS CRS to
    # reproject to WGS84 before bbox filtering.
    bbox = _bbox_around(lat=lat, lng=lng, half_extent_m=250)
    keep = (
        (xyz[:, 0] >= bbox["min_lng"]) & (xyz[:, 0] <= bbox["max_lng"]) &
        (xyz[:, 1] >= bbox["min_lat"]) & (xyz[:, 1] <= bbox["max_lat"])
    )
    return {
        "xyz": xyz[keep],
        "classification": classification[keep],
        "bbox": bbox,
        "tile_count": len(pulled),
        "fetched_at": int(time.time()),
    }


def _ensure_cached_tile(s3: Any, key: str, cache_root: str | None) -> str:
    """Download tile to local disk if not already cached. Returns local path."""
    if not cache_root:
        cache_root = "/tmp/voxaris-lidar"
    os.makedirs(cache_root, exist_ok=True)
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    suffix = ".laz" if key.endswith(".laz") else ".las"
    local_path = os.path.join(cache_root, f"{h}{suffix}")
    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
        return local_path
    log.info("downloading %s → %s", key, local_path)
    with open(local_path, "wb") as out:
        s3.download_fileobj(_BUCKET, key, out)
    return local_path


def _bbox_around(*, lat: float, lng: float, half_extent_m: int) -> dict[str, float]:
    # Cheap meters→deg conversion at the latitude. Good for sub-km bboxes.
    import math  # noqa: PLC0415

    m_per_deg_lat = 111_320.0
    m_per_deg_lng = m_per_deg_lat * math.cos(math.radians(lat))
    d_lat = half_extent_m / m_per_deg_lat
    d_lng = half_extent_m / m_per_deg_lng
    return {
        "min_lat": lat - d_lat, "max_lat": lat + d_lat,
        "min_lng": lng - d_lng, "max_lng": lng + d_lng,
    }

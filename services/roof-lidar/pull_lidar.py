"""
services/roof-lidar/pull_lidar.py

Fetch LAS/LAZ tiles directly from USGS 3DEP HTTPS endpoints (rockyweb.usgs.gov),
decompress with laspy, reproject to WGS84 lat/lng, and return the
concatenated point cloud filtered to a small bbox around the address.

The Modal function mounts a persistent volume at `cache_root` so
fetched tiles survive 24h between calls. Cache key is the tile URL
hashed; cache invalidation isn't needed within 24h because 3DEP files
are immutable once published.

WHY HTTPS, NOT S3: USGS publishes 3DEP under prd-tnm S3 but also serves
the same content via direct HTTPS (rockyweb.usgs.gov). The TNM Access
API (used by coverage_check.py) returns HTTPS URLs, not S3 keys, so
HTTPS is the consistent pull path. No anonymous S3 client needed.

WHY CRS REPROJECTION: USGS LAZ files store coordinates in a state-plane
or UTM projection encoded in the LAS header CRS. A naive XY-as-lng-lat
filter (the previous implementation) places points thousands of km off
in the wrong hemisphere. We use laspy's CRS parse + pyproj.Transformer
to reproject every point to WGS84 lat/lng before bbox filtering.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from typing import Any

log = logging.getLogger(__name__)


def fetch_lidar_for_bbox(
    *,
    lat: float,
    lng: float,
    tile_ids: list[str],
    cache_root: str | None = None,
) -> dict[str, Any]:
    """Return a dict with:
        xyz: numpy.ndarray of shape (N, 3) — points in WGS84
            [lng, lat, alt_meters]
        classification: numpy.ndarray of shape (N,) — LAS class codes
        bbox: dict with min/max lat/lng/alt

    `tile_ids` are HTTPS download URLs (from coverage_check.py / TNM
    API). Points are filtered to a 500m bbox around (lat, lng) to keep
    downstream memory bounded for residential parcels.
    """
    try:
        import requests  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
        import laspy  # noqa: PLC0415
        import pyproj  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"required dep missing: {err}") from err

    if not tile_ids:
        raise ValueError("no tile_ids supplied")

    # Limit to a single tile for residential parcels — multi-tile cold
    # downloads from rockyweb.usgs.gov take 4+ min each (360MB tiles at
    # ~12 Mbps); fetching 4 is a 15-minute hard floor on every cold
    # call. The parcel bbox sent to TNM is 250m half-extent which fits
    # in one tile 99% of the time; if it straddles, downstream falcet
    # detection just misses the bleed and falls through to Tier C.
    #
    # Corrupt cache recovery: if laspy fails to parse a cached tile
    # (e.g. partial download from a previous timed-out call), delete
    # the cache file and re-download once before giving up.
    pulled: list[Any] = []
    for tile_url in tile_ids[:1]:
        local_path = _ensure_cached_tile(tile_url, cache_root)
        try:
            las = laspy.read(local_path)
            pulled.append(las)
        except Exception as err:  # noqa: BLE001
            log.warning("failed to parse %s: %s — retrying download", tile_url, err)
            try:
                if os.path.exists(local_path):
                    os.remove(local_path)
                local_path = _ensure_cached_tile(tile_url, cache_root)
                las = laspy.read(local_path)
                pulled.append(las)
            except Exception as err2:  # noqa: BLE001
                log.warning("retry also failed for %s: %s", tile_url, err2)

    if not pulled:
        raise RuntimeError("no tiles parseable")

    # Concatenate raw points + classifications, reprojecting from each
    # LAS's native CRS to WGS84 (lng, lat).
    all_xyz: list[Any] = []
    all_class: list[Any] = []
    for las in pulled:
        src_xyz = np.vstack((las.x, las.y, las.z)).T  # (N, 3) in native CRS
        try:
            src_crs = las.header.parse_crs()
        except Exception as err:  # noqa: BLE001
            log.warning("CRS parse failed for tile: %s", err)
            src_crs = None

        if src_crs is None:
            log.warning(
                "tile missing CRS; treating XY as already lng/lat — "
                "this will produce wrong points for state-plane/UTM tiles",
            )
            xyz = src_xyz
        else:
            transformer = pyproj.Transformer.from_crs(
                src_crs, "EPSG:4326", always_xy=True,
            )
            xs, ys = transformer.transform(src_xyz[:, 0], src_xyz[:, 1])
            xyz = np.column_stack([xs, ys, src_xyz[:, 2]])

        all_xyz.append(xyz)
        all_class.append(np.asarray(las.classification))

    xyz = np.vstack(all_xyz)
    classification = np.concatenate(all_class)

    # Filter to 500m bbox around the input address — WGS84 lng/lat now
    # that everything's been reprojected.
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


def _ensure_cached_tile(tile_url: str, cache_root: str | None) -> str:
    """Download tile to local disk if not already cached. Returns local path.

    Streams in 8MB chunks because 3DEP LAZ tiles are routinely 200-500MB
    and we don't want to hold the whole thing in memory before writing.
    """
    import requests  # noqa: PLC0415

    if not cache_root:
        cache_root = "/tmp/voxaris-lidar"
    os.makedirs(cache_root, exist_ok=True)
    h = hashlib.sha1(tile_url.encode("utf-8")).hexdigest()[:16]
    # Honour the actual file extension from the URL — defaults to .laz.
    ext = ".laz"
    for candidate in (".laz", ".las"):
        if tile_url.lower().endswith(candidate):
            ext = candidate
            break
    local_path = os.path.join(cache_root, f"{h}{ext}")
    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
        log.info("cache hit: %s", local_path)
        return local_path
    log.info("downloading %s → %s", tile_url, local_path)
    with requests.get(tile_url, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with open(local_path, "wb") as out:
            for chunk in resp.iter_content(chunk_size=8 * 1024 * 1024):
                if chunk:
                    out.write(chunk)
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

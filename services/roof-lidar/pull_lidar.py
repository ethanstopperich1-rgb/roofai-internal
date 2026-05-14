"""
services/roof-lidar/pull_lidar.py

Fetch LiDAR points via PDAL's EPT reader (USGS-hosted Entwine Point Tile
sets) with bbox-bounded range reads. Replaces the old full-LAZ-tile
download path — instead of pulling 360MB to extract a 60m parcel, we
fetch ~1-2 MB of relevant points directly. Cold path drops from ~6 min
to ~30 sec.

Pipeline:
  1. Build a Web Mercator (EPSG:3857) bbox around the parcel — EPT
     stores coords in Web Mercator so PDAL's `bounds` arg must use it.
  2. Run a PDAL pipeline: readers.ept → filters.reprojection(EPSG:4326)
     → filters.crop (refine to exact bbox).
  3. Reproject to a local meter frame (AEQD centered on parcel) so
     downstream isolate_roof / segment_planes / build_facets can work
     in consistent meter-units.
"""

from __future__ import annotations

import logging
import math
import time
from typing import Any

log = logging.getLogger(__name__)


def fetch_lidar_for_bbox(
    *,
    lat: float,
    lng: float,
    tile_ids: list[str],
    cache_root: str | None = None,  # unused for EPT — kept for backwards-compat sig
) -> dict[str, Any]:
    """Return a dict with:
        xyz: numpy.ndarray of shape (N, 3) — points in LOCAL METER FRAME
            [east_m, north_m, alt_m] centered on the parcel
        classification: numpy.ndarray of shape (N,) — LAS class codes
        bbox: WGS84 bbox dict for downstream callers
        origin_lat / origin_lng / frame metadata for back-projection

    `tile_ids` is now [ept_url] from coverage_check.py — a single
    PDAL pipeline source URL, not a list of LAZ tile keys.
    """
    try:
        import numpy as np  # noqa: PLC0415
        import pdal  # noqa: PLC0415
        import pyproj  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"required dep missing: {err}") from err

    if not tile_ids:
        raise ValueError("no tile_ids supplied")

    ept_url = tile_ids[0]

    # Build a Web Mercator (EPSG:3857) bbox of HALF_EXTENT_M around the
    # parcel. EPT data is stored in Web Mercator so this is the native
    # bounds format PDAL expects.
    HALF_EXTENT_M = 75  # 150m × 150m square — covers oversized residential parcels
    to_wmerc = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    cx, cy = to_wmerc.transform(lng, lat)
    bounds_str = (
        f"([{cx - HALF_EXTENT_M}, {cx + HALF_EXTENT_M}], "
        f"[{cy - HALF_EXTENT_M}, {cy + HALF_EXTENT_M}])"
    )

    log.info("EPT query: url=%s bounds=%s", ept_url, bounds_str)

    # Run PDAL pipeline. readers.ept fetches only octree chunks that
    # intersect `bounds` — far cheaper than full LAZ download.
    pipeline_json = {
        "pipeline": [
            {
                "type": "readers.ept",
                "filename": ept_url,
                "bounds": bounds_str,
                # `threads` controls the number of parallel HTTP fetches
                # for octree chunks. Modern PDAL aliases this to
                # `requests` — only set one. 8 is plenty for a parcel-
                # sized bbox (typically 1-4 chunks).
                "threads": 8,
            },
            # Reproject from EPT's Web Mercator to WGS84 lng/lat first
            # (so we can apply consistent downstream logic).
            {
                "type": "filters.reprojection",
                "out_srs": "EPSG:4326",
            },
        ],
    }

    t0 = time.time()
    import json as _json  # noqa: PLC0415
    pipeline = pdal.Pipeline(_json.dumps(pipeline_json))
    n_points = pipeline.execute()
    log.info("PDAL EPT fetch returned %d points in %.1fs", n_points, time.time() - t0)

    if n_points == 0:
        raise RuntimeError("no points returned from EPT query — bounds may not intersect coverage")

    arr = pipeline.arrays[0]  # numpy structured array
    # Standard EPT fields: X, Y, Z, Classification, ReturnNumber, NumberOfReturns
    # After reprojection X=lng, Y=lat, Z=meters.
    src_lng = np.asarray(arr["X"], dtype=np.float64)
    src_lat = np.asarray(arr["Y"], dtype=np.float64)
    src_z = np.asarray(arr["Z"], dtype=np.float64)
    classification = np.asarray(arr["Classification"], dtype=np.uint8)

    # Now reproject lng/lat → local AEQD meter frame centered on the
    # parcel. Same frame downstream stages (isolate_roof, segment_planes,
    # build_facets) expect: x = meters east, y = meters north, z = meters.
    local_crs = pyproj.CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat} +lon_0={lng} +ellps=WGS84 +units=m",
    )
    to_local = pyproj.Transformer.from_crs("EPSG:4326", local_crs, always_xy=True)
    xs, ys = to_local.transform(src_lng, src_lat)
    xyz = np.column_stack([xs, ys, src_z])

    log.info(
        "reprojected to local meters: bbox x=[%.1f, %.1f] y=[%.1f, %.1f] z=[%.1f, %.1f]",
        xs.min(), xs.max(), ys.min(), ys.max(), src_z.min(), src_z.max(),
    )

    # Final tight bbox filter in local meters. Already filtered roughly
    # by the EPT bounds query, but EPT chunks return entire octree
    # leaves, so we may have points up to ~15m past the bbox edge.
    keep = (
        (np.abs(xyz[:, 0]) <= HALF_EXTENT_M) &
        (np.abs(xyz[:, 1]) <= HALF_EXTENT_M)
    )

    bbox_wgs = _bbox_around(lat=lat, lng=lng, half_extent_m=HALF_EXTENT_M)
    return {
        "xyz": xyz[keep],
        "classification": classification[keep],
        "bbox": bbox_wgs,
        "tile_count": 1,  # EPT = one query, not multi-tile concat
        "fetched_at": int(time.time()),
        "origin_lat": lat,
        "origin_lng": lng,
        "frame": "aeqd_meters",
    }


def _bbox_around(*, lat: float, lng: float, half_extent_m: int) -> dict[str, float]:
    m_per_deg_lat = 111_320.0
    m_per_deg_lng = m_per_deg_lat * math.cos(math.radians(lat))
    d_lat = half_extent_m / m_per_deg_lat
    d_lng = half_extent_m / m_per_deg_lng
    return {
        "min_lat": lat - d_lat, "max_lat": lat + d_lat,
        "min_lng": lng - d_lng, "max_lng": lng + d_lng,
    }

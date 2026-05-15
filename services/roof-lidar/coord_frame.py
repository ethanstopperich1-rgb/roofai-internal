"""
services/roof-lidar/coord_frame.py

Single source of truth for the local meter coordinate frame used
throughout the LiDAR pipeline.

We use Azimuthal Equidistant (AEQD) projection centered on each
parcel's geocoded lat/lng. At sub-km parcel sizes, AEQD provides
sub-millimeter ENU accuracy without per-point CRS lookups.

All downstream stages (isolate_roof, segment_planes, build_facets)
operate on (x, y, z) meters where:

    x = meters east of parcel center
    y = meters north of parcel center
    z = meters above WGS84 ellipsoid (preserved from source LAS)

Phase F note (Phase F audit): build_facets.py previously inverted the
projection with a cheap-flat-earth approximation that worked
numerically but bypassed pyproj entirely. That created a latent bug
where any upstream CRS change (e.g. swapping EPT's EPSG:3857 source
for a different projection) would silently desync the facet polygons
from the LiDAR returns they were measured from. This module
centralizes the forward + inverse transforms so the contract is
explicit and the round-trip is exact.

Public API:

    make_wgs84_to_aeqd(lat, lng) -> pyproj.Transformer
        Forward — (lng, lat) WGS84 → local meters.
        Used by pull_lidar after EPT-side reprojection from EPSG:3857.

    make_aeqd_to_wgs84(lat, lng) -> pyproj.Transformer
        Inverse — local meters → (lng, lat) WGS84.
        Used by build_facets to project facet polygons back to lat/lng
        for the TS-side RoofData payload.

Both transformers use `always_xy=True` so input/output order is
(lng, lat) consistent with the rest of the pipeline. They share the
same underlying AEQD CRS string, so the round-trip is exact to
floating-point precision (verified by scripts/verify_coord_roundtrip.py).
"""

from __future__ import annotations

from functools import lru_cache

import pyproj


def _aeqd_crs(lat: float, lng: float) -> pyproj.CRS:
    """Build the AEQD CRS for a parcel center.

    Why proj4 instead of an EPSG code: there's no EPSG code for an
    arbitrary-center AEQD projection — each parcel gets its own
    coordinate system. The proj4 string is the only way to express
    "AEQD centered at THIS specific lat/lng".
    """
    return pyproj.CRS.from_proj4(
        f"+proj=aeqd +lat_0={lat} +lon_0={lng} +ellps=WGS84 +units=m"
    )


# lru_cache keys on (lat, lng) pairs. In production we'd see one
# parcel per estimate, so the cache eviction policy doesn't matter
# much — but caching keeps repeat transforms within the same request
# from rebuilding the proj4 graph (~3-5ms saved per call).
@lru_cache(maxsize=128)
def make_wgs84_to_aeqd(lat: float, lng: float) -> pyproj.Transformer:
    """Forward: WGS84 (EPSG:4326) → AEQD meters centered at (lat, lng)."""
    return pyproj.Transformer.from_crs(
        "EPSG:4326", _aeqd_crs(lat, lng), always_xy=True,
    )


@lru_cache(maxsize=128)
def make_aeqd_to_wgs84(lat: float, lng: float) -> pyproj.Transformer:
    """Inverse: AEQD meters centered at (lat, lng) → WGS84 (lng, lat)."""
    return pyproj.Transformer.from_crs(
        _aeqd_crs(lat, lng), "EPSG:4326", always_xy=True,
    )

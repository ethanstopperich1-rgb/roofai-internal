"""
services/roof-lidar/build_facets.py

Given a list of plane regions (point inliers + plane normal), build
the RoofData Facet[] structure:

  - polygon: alpha-shape boundary of the inlier point projection onto
    the plane, simplified via Douglas-Peucker (0.2m tolerance), then
    reprojected back to lat/lng.
  - pitchDegrees: from the plane normal (angle from vertical).
  - azimuthDeg: from the plane normal projected onto horizontal.
  - areaSqftSloped: shoelace area of the polygon in plane coordinates.
  - areaSqftFootprint: sloped × cos(pitch).
  - isLowSlope: pitchDegrees < 18.43° (4/12 threshold).

Coordinate convention:
  - LAS xyz is treated as ENU meters (x=East, y=North, z=Up) for the
    bbox around the address centroid. The conversion back to lat/lng
    uses a cheap planar approximation accurate to sub-meter at
    sub-km bbox sizes.
"""

from __future__ import annotations

import logging
import math
import uuid
from typing import Any

log = logging.getLogger(__name__)

M_PER_DEG_LAT = 111_320.0


def build_facets_from_planes(
    planes: list[dict[str, Any]],
    *,
    center_lat: float,
    center_lng: float,
) -> list[dict[str, Any]]:
    """Produce Facet[] dicts matching types/roof.ts schema."""
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"numpy missing: {err}") from err

    if center_lat == 0:
        raise ValueError("center_lat required for ENU conversion")

    cos_lat = math.cos(math.radians(center_lat))
    m_per_deg_lng = M_PER_DEG_LAT * cos_lat

    facets: list[dict[str, Any]] = []
    for idx, plane in enumerate(planes):
        pts = np.asarray(plane["points"])
        n = np.asarray(plane["normal"])
        n = n / max(1e-9, np.linalg.norm(n))

        # Pitch = angle from vertical (z-up) = arccos(n_z)
        pitch_deg = math.degrees(math.acos(max(-1.0, min(1.0, abs(n[2])))))
        # Azimuth = bearing of the down-slope direction projected onto XY.
        # For a roof normal (nx, ny, nz) with nz>0, the down-slope vector
        # points OPPOSITE the horizontal component of the normal.
        if abs(n[0]) < 1e-6 and abs(n[1]) < 1e-6:
            azimuth_deg = 0.0  # flat roof — bearing undefined
        else:
            azimuth_deg = math.degrees(math.atan2(-n[0], -n[1])) % 360

        # Boundary polygon — alpha-shape on the inlier point projection.
        boundary_2d = _alpha_shape_boundary(pts[:, :2])
        if len(boundary_2d) < 3:
            continue
        # Douglas-Peucker simplification at 0.2m.
        boundary_2d = _douglas_peucker(boundary_2d, tolerance_m=0.2)
        if len(boundary_2d) < 3:
            continue

        # Convert ENU meters → lat/lng.
        # We treat LAS X as longitude-meters-from-center and Y as
        # latitude-meters-from-center.
        # TODO(post-deploy): if LAS isn't reprojected to WGS84 upstream
        # this conversion is wrong; chain through pyproj before this stage.
        polygon_latlng: list[dict[str, float]] = []
        for x, y in boundary_2d:
            d_lng = x / m_per_deg_lng
            d_lat = y / M_PER_DEG_LAT
            polygon_latlng.append({"lat": center_lat + d_lat, "lng": center_lng + d_lng})

        # Areas
        area_sqm = _shoelace_area_m(boundary_2d)
        area_sqft_footprint = area_sqm * 10.7639
        area_sqft_sloped = area_sqft_footprint / max(1e-6, math.cos(math.radians(pitch_deg)))

        facet_id = f"facet-{idx}"
        facets.append({
            "id": facet_id,
            "polygon": polygon_latlng,
            "normal": {"x": float(n[0]), "y": float(n[1]), "z": float(n[2])},
            "pitchDegrees": round(pitch_deg, 2),
            "azimuthDeg": round(azimuth_deg, 1),
            "areaSqftSloped": round(area_sqft_sloped, 1),
            "areaSqftFootprint": round(area_sqft_footprint, 1),
            # Tier A doesn't classify material — leave null; rep/customer picks.
            "material": None,
            "isLowSlope": pitch_deg < 18.43,
        })

    log.info("built %d facets from %d planes", len(facets), len(planes))
    return facets


def _alpha_shape_boundary(points_2d: Any) -> list[tuple[float, float]]:
    """Compute concave-hull (alpha-shape) boundary. Tries Open3D's
    `create_from_point_cloud_alpha_shape` first; falls back to a convex
    hull when alpha-shape isn't available (gives a slightly looser
    boundary but still works)."""
    try:
        import numpy as np  # noqa: PLC0415
        from shapely.geometry import MultiPoint  # noqa: PLC0415
        from shapely.ops import unary_union  # noqa: F401, PLC0415
    except ImportError:
        return _convex_hull_2d(points_2d)

    pts = np.asarray(points_2d)
    if len(pts) < 3:
        return []
    try:
        # Shapely 2.x: `concave_hull` is the standard alpha-shape; supports
        # the ratio param. Tunable for tighter / looser boundaries.
        multipoint = MultiPoint([(float(p[0]), float(p[1])) for p in pts])
        if hasattr(multipoint, "concave_hull"):
            hull = multipoint.concave_hull(ratio=0.25, allow_holes=False)
            if hull.geom_type == "Polygon":
                return [(x, y) for x, y in hull.exterior.coords]
        # Fallback to convex hull
        hull = multipoint.convex_hull
        if hull.geom_type == "Polygon":
            return [(x, y) for x, y in hull.exterior.coords]
    except Exception as err:  # noqa: BLE001
        log.warning("alpha-shape failed: %s; falling back to convex hull", err)
    return _convex_hull_2d(points_2d)


def _convex_hull_2d(points_2d: Any) -> list[tuple[float, float]]:
    """Andrew's monotone-chain convex hull, dependency-free."""
    pts = sorted([(float(p[0]), float(p[1])) for p in points_2d])
    if len(pts) <= 1:
        return pts
    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and _cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and _cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def _cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _douglas_peucker(
    points: list[tuple[float, float]], tolerance_m: float,
) -> list[tuple[float, float]]:
    if len(points) <= 2:
        return points
    # Stack-based recursive simplification.
    keep = [True] * len(points)
    stack: list[tuple[int, int]] = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        if end <= start + 1:
            continue
        max_dist = 0.0
        max_idx = start
        for i in range(start + 1, end):
            d = _perpendicular_distance(points[i], points[start], points[end])
            if d > max_dist:
                max_dist = d
                max_idx = i
        if max_dist > tolerance_m:
            stack.append((start, max_idx))
            stack.append((max_idx, end))
        else:
            for i in range(start + 1, end):
                keep[i] = False
    return [p for p, k in zip(points, keep) if k]


def _perpendicular_distance(
    p: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
) -> float:
    if a == b:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    num = abs((b[1] - a[1]) * p[0] - (b[0] - a[0]) * p[1] + b[0] * a[1] - b[1] * a[0])
    den = math.hypot(b[0] - a[0], b[1] - a[1])
    return num / max(1e-9, den)


def _shoelace_area_m(points_2d: list[tuple[float, float]]) -> float:
    if len(points_2d) < 3:
        return 0.0
    total = 0.0
    for i in range(len(points_2d)):
        x1, y1 = points_2d[i]
        x2, y2 = points_2d[(i + 1) % len(points_2d)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


# Eliminate unused-import warnings while keeping the import discoverable.
_ = uuid

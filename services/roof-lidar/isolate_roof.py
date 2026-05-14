"""
services/roof-lidar/isolate_roof.py

Separates roof returns from the rest of the point cloud:

  1. Ground-classify (LAS class 2) → reject ground points.
  2. Height threshold (returns more than 2m above local ground) → keeps
     building tops, rejects shrubs.
  3. Footprint mask via Microsoft Buildings polygon (optional input).
  4. Vertical-return filter — drop points whose neighborhood normal is
     near vertical (those are walls, not roof).

Returns the filtered point cloud.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)


def isolate_roof_points(
    *,
    las_points: dict[str, Any],
    lat: float,
    lng: float,
    parcel_polygon: list[dict[str, float]] | None,
) -> dict[str, Any]:
    """Return dict with:
        xyz: filtered points (N, 3)
        ground_z: scalar float, local ground elevation
        normal: per-point estimated normal vectors (N, 3) — used downstream
    """
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"numpy missing: {err}") from err

    xyz = las_points["xyz"]
    cls = las_points["classification"]
    if len(xyz) == 0:
        raise ValueError("no LAS points after bbox filter")

    # LAS class 2 = ground. Median ground elevation in the bbox is our
    # local "ground plane" baseline.
    ground_mask = cls == 2
    if ground_mask.sum() >= 50:
        ground_z = float(np.median(xyz[ground_mask, 2]))
    else:
        # Sparse-ground fallback — take the bottom 5% of returns as proxy.
        ground_z = float(np.percentile(xyz[:, 2], 5))

    # Building-top candidates: returns >2m above ground, and not classified
    # as ground (class 2) or low-veg (class 3).
    high_mask = (xyz[:, 2] > ground_z + 2.0) & ~np.isin(cls, [2, 3])
    candidates = xyz[high_mask]
    if len(candidates) == 0:
        raise ValueError("no above-ground returns")

    # Optional parcel-polygon footprint mask. When supplied (Microsoft
    # Buildings or Solar API building footprint), drop points outside it.
    if parcel_polygon and len(parcel_polygon) >= 3:
        candidates = _filter_by_polygon(candidates, parcel_polygon)

    # Estimate per-point normals via a kNN-PCA pass. Open3D handles this
    # well; we use a simple scipy KDTree fallback when Open3D isn't
    # available (e.g. local-dev w/o the heavy dep).
    normals = _estimate_normals(candidates)

    # Vertical-return filter: drop points whose local normal has |normal_z|
    # < 0.35 (steeply tilted local surface = wall, not roof).
    n_z_mask = np.abs(normals[:, 2]) >= 0.35
    roof_xyz = candidates[n_z_mask]
    roof_normals = normals[n_z_mask]

    log.info(
        "isolate_roof: %d → %d (after ground/height) → %d (after polygon) → %d (after wall filter)",
        len(xyz), high_mask.sum(),
        len(candidates), len(roof_xyz),
    )

    if len(roof_xyz) < 100:
        raise ValueError(
            f"too few roof points after filtering ({len(roof_xyz)}); coverage too sparse",
        )

    return {
        "xyz": roof_xyz,
        "normals": roof_normals,
        "ground_z": ground_z,
    }


def _filter_by_polygon(
    xyz: Any, polygon: list[dict[str, float]],
) -> Any:
    """Boolean-mask points inside the lat/lng polygon. Uses Shapely's
    point-in-polygon since the polygon vertex count is small (<20)."""
    try:
        from shapely.geometry import Point, Polygon  # noqa: PLC0415
        import numpy as np  # noqa: PLC0415
    except ImportError:
        return xyz  # no shapely → skip filter rather than fail outright

    poly = Polygon([(v["lng"], v["lat"]) for v in polygon])
    keep_idx = [i for i in range(len(xyz)) if poly.contains(Point(xyz[i, 0], xyz[i, 1]))]
    return xyz[np.asarray(keep_idx, dtype=int)] if keep_idx else xyz


def _estimate_normals(xyz: Any) -> Any:
    """Per-point normal estimation via kNN-PCA. Tries Open3D first, falls
    back to scipy + manual PCA. Returns (N, 3) unit normals."""
    try:
        import numpy as np  # noqa: PLC0415
        import open3d as o3d  # noqa: PLC0415
    except ImportError:
        return _estimate_normals_scipy(xyz)

    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(xyz)
    pcd.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamKNN(knn=20),
    )
    # Open3D normals don't have consistent orientation; force z-up.
    normals = np.asarray(pcd.normals)
    flip = normals[:, 2] < 0
    normals[flip] *= -1
    return normals


def _estimate_normals_scipy(xyz: Any) -> Any:
    """Scipy fallback when Open3D isn't installed. Slower but works."""
    import numpy as np  # noqa: PLC0415
    from scipy.spatial import cKDTree  # noqa: PLC0415

    tree = cKDTree(xyz)
    normals = np.zeros_like(xyz)
    for i, p in enumerate(xyz):
        _, idx = tree.query(p, k=20)
        nbhd = xyz[idx]
        cov = np.cov((nbhd - nbhd.mean(axis=0)).T)
        # Smallest eigenvector of the covariance = surface normal.
        evals, evecs = np.linalg.eigh(cov)
        n = evecs[:, 0]
        if n[2] < 0:
            n = -n
        normals[i] = n / max(1e-9, np.linalg.norm(n))
    return normals

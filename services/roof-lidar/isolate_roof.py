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

    # Building-top candidates. Phase 1 strengthens this filter with
    # CONDITIONAL class-6 enforcement: when the LAS file has enough
    # class-6 (building) points to trust the classifier, we take
    # CLASS 6 ONLY. When the file is poorly classified (some
    # contractors lump everything man-made into class 1 / unclassified),
    # we fall back to the loose negative filter.
    #
    # The conditional design avoids two failure modes:
    #   - good LAS + aggressive filter (everything correctly class 6,
    #     keep only class 6 → great)
    #   - bad LAS + aggressive filter (file has zero class 6 because
    #     contractor didn't classify → empty cloud, run fails)
    #
    # 200 class-6 points ≈ 50 m² at QL2 density (~4 pts/m²). Below
    # that, the classifier signal isn't trustworthy and we degrade
    # gracefully to the negative-filter path.
    #
    # Negative-filter classes: ground (2), low-veg (3), med-veg (4),
    # high-veg/trees (5). Class 4 + 5 were added pre-Phase-1 — see
    # commit history. Tree canopy was the dominant "phantom facet"
    # source on residential parcels before that fix.
    HARD_CLASS_6_THRESHOLD = 200
    n_class6 = int((cls == 6).sum())
    has_strong_class6 = n_class6 >= HARD_CLASS_6_THRESHOLD
    if has_strong_class6:
        # Trust the classifier. Height filter still applies as a sanity
        # backstop (mis-tagged ground points labeled class 6 do happen).
        high_mask = (xyz[:, 2] > ground_z + 2.0) & (cls == 6)
        log.info(
            "isolate_roof: class-6 enforcement on (%d class-6 points >= threshold %d)",
            n_class6, HARD_CLASS_6_THRESHOLD,
        )
    else:
        high_mask = (xyz[:, 2] > ground_z + 2.0) & ~np.isin(cls, [2, 3, 4, 5])
        log.info(
            "isolate_roof: loose negative filter (class-6 count %d below threshold %d)",
            n_class6, HARD_CLASS_6_THRESHOLD,
        )
    candidates = xyz[high_mask]
    if len(candidates) == 0:
        raise ValueError("no above-ground returns")

    # Optional parcel-polygon footprint mask. When supplied (Microsoft
    # Buildings or Solar API building footprint), drop points outside it.
    # The polygon is in WGS84 lng/lat; candidates are in the local meter
    # frame per pull_lidar's contract — _filter_by_polygon handles the
    # projection internally using origin_lat/origin_lng from las_points.
    if parcel_polygon and len(parcel_polygon) >= 3:
        origin_lat = las_points.get("origin_lat")
        origin_lng = las_points.get("origin_lng")
        candidates = _filter_by_polygon(
            candidates, parcel_polygon,
            origin_lat=origin_lat, origin_lng=origin_lng,
        )

    # Estimate per-point normals via a kNN-PCA pass. Open3D handles this
    # well; we use a simple scipy KDTree fallback when Open3D isn't
    # available (e.g. local-dev w/o the heavy dep).
    normals = _estimate_normals(candidates)

    # Vertical-return filter: drop points whose local normal has
    # |normal_z| < 0.30 (steeply tilted local surface = wall, not roof).
    # Phase 1 tightens this from 0.35 → 0.30: the smaller footprint
    # buffer (0.5m, was 1.5-2.5m) admits more near-wall returns that
    # need to be rejected here. 0.30 corresponds to ~73 deg from
    # horizontal; surfaces tilted more than that are almost certainly
    # walls rather than steep mansards (which max out around 65 deg).
    WALL_NORMAL_Z_THRESHOLD = 0.30
    n_z_mask = np.abs(normals[:, 2]) >= WALL_NORMAL_Z_THRESHOLD
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
    xyz: Any,
    polygon: list[dict[str, float]],
    origin_lat: float | None = None,
    origin_lng: float | None = None,
) -> Any:
    """Boolean-mask points inside the parcel polygon.

    xyz coordinates are in LOCAL METER FRAME (AEQD centered at origin_lat,
    origin_lng) per pull_lidar's contract. The polygon vertices are in
    WGS84 lng/lat degrees. We project the polygon vertices into the same
    local meter frame before the point-in-polygon test.

    Uses a vectorized matplotlib.path.Path.contains_points instead of
    Shapely's per-point .contains() — Shapely was O(N) Python loop on
    100k+ points (~30s); matplotlib's contains_points is a single C
    call (~50ms).
    """
    try:
        import numpy as np  # noqa: PLC0415
        from matplotlib.path import Path  # noqa: PLC0415
    except ImportError:
        return xyz  # no matplotlib → skip filter rather than fail outright

    if origin_lat is None or origin_lng is None:
        # Legacy path: polygon is assumed to match xyz's frame directly
        # (used when xyz is also in lng/lat). Kept for back-compat.
        try:
            from shapely.geometry import Point, Polygon  # noqa: PLC0415
        except ImportError:
            return xyz
        poly = Polygon([(v["lng"], v["lat"]) for v in polygon])
        keep_idx = [
            i for i in range(len(xyz))
            if poly.contains(Point(xyz[i, 0], xyz[i, 1]))
        ]
        return xyz[np.asarray(keep_idx, dtype=int)] if keep_idx else xyz

    # Project polygon vertices: lng/lat → local meters via the same
    # cheap-flat-earth approximation pull_lidar uses for the WGS84 bbox.
    # For sub-km parcels this matches AEQD reprojection to ~mm.
    import math  # noqa: PLC0415
    m_per_deg_lat = 111_320.0
    m_per_deg_lng = m_per_deg_lat * math.cos(math.radians(origin_lat))
    poly_meters = np.array(
        [
            [
                (v["lng"] - origin_lng) * m_per_deg_lng,
                (v["lat"] - origin_lat) * m_per_deg_lat,
            ]
            for v in polygon
        ],
        dtype=np.float64,
    )
    path = Path(poly_meters)
    keep = path.contains_points(xyz[:, :2])
    n_before = len(xyz)
    n_after = int(keep.sum())
    log.info(
        "polygon clip (local meters): %d → %d points (%.1f%% kept)",
        n_before, n_after, 100.0 * n_after / max(1, n_before),
    )
    return xyz[keep] if n_after > 0 else xyz


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
    """Vectorized scipy KDTree + batched PCA normal estimation. Used
    when Open3D isn't installed (e.g. Python 3.13 base image where
    open3d 0.19 doesn't have wheels). Performance: ~3-5s on 100k points.

    Approach:
      1. cKDTree.query(xyz, k=20) — one C-level call returns all neighbour
         indices at once.
      2. Gather neighbour blocks into a (N, 20, 3) array.
      3. Compute per-point centred covariance via einsum (fully vectorized).
      4. np.linalg.eigh on (N, 3, 3) batch — handles all points at once
         (eigh broadcasts over leading dims since numpy 1.8).
      5. Smallest-eigenvector → surface normal. Force z-up sign.
    """
    import numpy as np  # noqa: PLC0415
    from scipy.spatial import cKDTree  # noqa: PLC0415

    tree = cKDTree(xyz)
    _, idx = tree.query(xyz, k=20)  # (N, 20) neighbour indices
    nbhds = xyz[idx]                # (N, 20, 3)
    centred = nbhds - nbhds.mean(axis=1, keepdims=True)
    # Covariance per point: einsum sums (centred^T @ centred) / k
    cov = np.einsum("nkj,nkl->njl", centred, centred) / centred.shape[1]
    evals, evecs = np.linalg.eigh(cov)  # both (N, 3) and (N, 3, 3)
    normals = evecs[:, :, 0]  # smallest eigenvalue's eigenvector
    # Force z-up orientation (normals from PCA are sign-ambiguous).
    flip = normals[:, 2] < 0
    normals[flip] *= -1
    # Renormalize defensively — eigh outputs are already unit but
    # accumulated float error can drift slightly.
    norms = np.linalg.norm(normals, axis=1, keepdims=True)
    return normals / np.maximum(norms, 1e-9)

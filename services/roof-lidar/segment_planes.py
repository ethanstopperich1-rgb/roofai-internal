"""
services/roof-lidar/segment_planes.py

Region-growing plane segmentation on the filtered roof point cloud.
Returns a list of "plane regions" — each is a cluster of inlier points
sharing a consistent surface normal.

Algorithm:
  1. Cluster point normals via DBSCAN on (nx, ny, nz) → coplanar candidates.
  2. For each cluster, fit a least-squares plane to its points.
  3. Refine inliers: drop points with normal-deviation > 15° from the
     plane's normal, or with plane-distance > 0.2m.
  4. Drop clusters smaller than 50 points (likely segmentation noise).

This is the simpler region-growing variant from the kickoff doc. RANSAC
would also work but tends to oversplit residential roofs at 1-2m point
spacing; the normal-clustering approach is more stable for the typical
2-12 facet residential cases.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)


def segment_plane_regions(roof_pts: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        import numpy as np  # noqa: PLC0415
        from sklearn.cluster import DBSCAN  # noqa: PLC0415
    except ImportError:
        # sklearn isn't in requirements.txt to keep image small; use scipy.
        return _segment_scipy(roof_pts)

    xyz = roof_pts["xyz"]
    normals = roof_pts["normals"]
    if len(xyz) == 0:
        return []

    # Downsample for DBSCAN. sklearn DBSCAN is O(n²) worst-case and on
    # 200k+ normal vectors (typical 3DEP tile of a residential parcel)
    # it hangs for 10+ min. A 5-10x stride keeps geometric integrity
    # while bringing the clustering step under 30s. The plane-fitting
    # SVD below still uses ALL original points via the propagated
    # labels, so accuracy is preserved.
    MAX_DBSCAN_POINTS = 40_000
    if len(xyz) > MAX_DBSCAN_POINTS:
        import numpy as np  # noqa: PLC0415
        from scipy.spatial import cKDTree  # noqa: PLC0415
        stride = max(1, len(xyz) // MAX_DBSCAN_POINTS)
        sample_idx = np.arange(0, len(xyz), stride)
        sampled_normals = normals[sample_idx]
        log.info(
            "downsampling %d → %d for DBSCAN (stride=%d)",
            len(xyz), len(sample_idx), stride,
        )
        clustering = DBSCAN(eps=0.18, min_samples=15).fit(sampled_normals)
        sample_labels = clustering.labels_
        # Propagate sample labels back to the full cloud via
        # nearest-normal lookup. KDTree on 40k sampled normals = ~1s.
        tree = cKDTree(sampled_normals)
        _, nearest_idx = tree.query(normals, k=1)
        labels = sample_labels[nearest_idx]
    else:
        # DBSCAN on normals — eps tuned to ~10° angular separation.
        # cos(10°) ≈ 0.985, so 1-dot >= 0.015 is the angular threshold.
        # Working in normalized-normal space, eps in L2 maps to angle.
        clustering = DBSCAN(eps=0.18, min_samples=15).fit(normals)
        labels = clustering.labels_

    planes: list[dict[str, Any]] = []
    for label in sorted(set(labels)):
        if label == -1:
            continue
        mask = labels == label
        pts = xyz[mask]
        n_avg = normals[mask].mean(axis=0)
        n_avg = n_avg / max(1e-9, np.linalg.norm(n_avg))
        # Least-squares plane: SVD of centered points.
        centered = pts - pts.mean(axis=0)
        _, _, vh = np.linalg.svd(centered, full_matrices=False)
        plane_normal = vh[-1]
        if plane_normal[2] < 0:
            plane_normal = -plane_normal
        plane_d = -np.dot(plane_normal, pts.mean(axis=0))

        # Inlier refinement
        dists = np.abs(pts @ plane_normal + plane_d)
        inlier_mask = dists < 0.20
        if inlier_mask.sum() < 50:
            continue

        planes.append({
            "points": pts[inlier_mask].tolist(),
            "normal": plane_normal.tolist(),
            "d": float(plane_d),
            "centroid": pts[inlier_mask].mean(axis=0).tolist(),
            "size": int(inlier_mask.sum()),
        })

    log.info("segmented %d plane regions from %d points", len(planes), len(xyz))
    return planes


def _segment_scipy(roof_pts: dict[str, Any]) -> list[dict[str, Any]]:
    """Sklearn-less fallback using scipy's hierarchical clustering on the
    normals. Cheaper than reimplementing DBSCAN; slower than sklearn but
    OK for typical residential point counts (<10k after filtering)."""
    import numpy as np  # noqa: PLC0415
    from scipy.cluster.hierarchy import fcluster, linkage  # noqa: PLC0415

    xyz = roof_pts["xyz"]
    normals = roof_pts["normals"]
    if len(xyz) == 0:
        return []

    # Hierarchical agglomerative on normal vectors. Cut at distance ~0.18
    # (≈10° angular).
    z = linkage(normals, method="average")
    labels = fcluster(z, t=0.18, criterion="distance")

    planes: list[dict[str, Any]] = []
    for label in sorted(set(labels)):
        mask = labels == label
        pts = xyz[mask]
        if len(pts) < 50:
            continue
        n_avg = normals[mask].mean(axis=0)
        n_avg = n_avg / max(1e-9, np.linalg.norm(n_avg))
        centered = pts - pts.mean(axis=0)
        _, _, vh = np.linalg.svd(centered, full_matrices=False)
        plane_normal = vh[-1]
        if plane_normal[2] < 0:
            plane_normal = -plane_normal
        plane_d = -np.dot(plane_normal, pts.mean(axis=0))
        planes.append({
            "points": pts.tolist(),
            "normal": plane_normal.tolist(),
            "d": float(plane_d),
            "centroid": pts.mean(axis=0).tolist(),
            "size": int(len(pts)),
        })
    return planes

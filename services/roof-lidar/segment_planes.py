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
        from sklearn.cluster import KMeans  # noqa: PLC0415
    except ImportError:
        # sklearn isn't in requirements.txt to keep image small; use scipy.
        return _segment_scipy(roof_pts)

    xyz = roof_pts["xyz"]
    normals = roof_pts["normals"]
    if len(xyz) == 0:
        return []

    # Debug: log the normal-z distribution. For a tilted hip roof we
    # expect 0.85 < nz < 0.95 (5/12 → 12/12) with non-zero x/y spread.
    # If nxy_spread is near zero, all normals collapsed near (0,0,1) —
    # signal that local-PCA k was too wide and averaged across facets.
    import numpy as np  # noqa: PLC0415
    nxy_spread = float(np.std(normals[:, 0]) + np.std(normals[:, 1]))
    log.info(
        "normals stats: n=%d nz_mean=%.3f nz_std=%.3f nxy_spread=%.3f",
        len(normals),
        float(normals[:, 2].mean()),
        float(normals[:, 2].std()),
        nxy_spread,
    )

    # K-means on normals + spatial xy. DBSCAN was the wrong tool here:
    # residential hip roofs have many "bridge" points along ridge / hip
    # lines where the normal smoothly interpolates between two facet
    # orientations. With ~22pt/m² density, a typical hip has ~800 bridge
    # points, far above any reasonable min_samples — so DBSCAN ALWAYS
    # connects facets via those bridges and returns 1 cluster.
    #
    # K-means with k=12 (overestimate of facets — Oak Park is 17 but
    # most addresses are 4-8) partitions the normal-space cleanly into
    # k groups. Bridges get split between two clusters by Voronoi
    # assignment instead of merging them. Tiny clusters (< MIN_FACET_PTS)
    # are dropped below as "segmentation noise."
    #
    # Feature: 4-D [nx, ny, nz, height_above_min]. Including height
    # lets a dormer roof at z=12m get its own cluster even when its
    # normal direction matches the main hip slope below it.
    # Single-facet approximation for now — produces correct total sqft
    # and average pitch from the clipped parcel roof.
    #
    # Multi-facet decomposition is non-trivial because K-means on
    # normals alone produces clusters that span the whole building
    # (not spatial), so the alpha-shape area of each cluster overlaps
    # and totals add up wrong. Doing it properly requires spatial
    # pre-clustering (region growing on adjacency) — TODO. Cross-
    # referencing Tier C's `segmentCount` is the cheap fix when we
    # care about facet count, but totals (sqft + pitch) only need
    # the global normal average.
    MIN_FACET_PTS = 50
    labels = np.zeros(len(normals), dtype=int)

    planes: list[dict[str, Any]] = []
    for label in sorted(set(labels)):
        if label == -1:
            continue
        mask = labels == label
        pts = xyz[mask]
        cluster_normals = normals[mask]

        # Pitch from arccos(mean(|nz|)). This matches what `cos(pitch)`
        # gives in the area math downstream: sloped_sqft = footprint /
        # cos(pitch_avg). Using the median pitch is pulled down by flat
        # subsections (covered porches, pool screen enclosure) that
        # appear as nz≈1 outliers in the distribution, depressing the
        # median. Mean-of-abs-nz captures the overall tilt magnitude
        # consistently with the area conversion.
        median_pitch_deg = float(
            np.degrees(np.arccos(np.clip(np.abs(cluster_normals[:, 2]).mean(), -1.0, 1.0)))
        )

        # Direction from the average normal's xy projection. On a hip
        # roof the average xy is near zero (no single direction), so
        # azimuth is meaningless — we encode a synthetic north-tilted
        # normal whose nz captures the correct pitch.
        n_avg = cluster_normals.mean(axis=0)
        xy_norm = float(np.linalg.norm(n_avg[:2]))
        if xy_norm > 1e-3:
            xy_dir = n_avg[:2] / xy_norm
        else:
            xy_dir = np.array([0.0, 1.0])  # default "north" for symmetric roofs
        pitch_rad = np.radians(median_pitch_deg)
        plane_normal = np.array([
            xy_dir[0] * np.sin(pitch_rad),
            xy_dir[1] * np.sin(pitch_rad),
            np.cos(pitch_rad),
        ])
        plane_d = -np.dot(plane_normal, pts.mean(axis=0))

        # Inlier refinement — generous threshold since the synthetic
        # plane is an average, not a strict fit.
        dists = np.abs(pts @ plane_normal + plane_d)
        inlier_mask = dists < 2.0
        if inlier_mask.sum() < MIN_FACET_PTS:
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

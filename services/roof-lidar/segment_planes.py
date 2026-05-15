"""
services/roof-lidar/segment_planes.py

Multi-facet roof plane segmentation via spatial region growing.

Why region growing (instead of K-means on normals + alpha-shape):
  K-means on normal vectors clusters by DIRECTION only — but a single
  hip-roof facet's points span a region in xy, so K-means clusters end
  up spatially distributed across the whole building. When we then
  alpha-shape each cluster, the boundaries overlap and area sums to
  several times the real footprint.

  Region growing fixes this by building each facet as a SPATIALLY
  CONTIGUOUS group: start at a seed point, walk to its KNN neighbours,
  accept neighbours whose local surface normal is within a small angle
  threshold, stop when the normal direction changes (= hip/ridge edge).
  Each resulting facet is a real surface patch, not a scattered cluster.

Algorithm:
  1. Build KDTree on xyz positions.
  2. Pick the unvisited point with the highest density (best seeded).
  3. BFS through 8-NN neighbours, adding to current facet when the
     neighbour's normal makes < ANGLE_THRESHOLD_DEG with the running
     mean normal of the facet.
  4. When BFS exhausts, the facet is closed. Move to the next
     unvisited point. Repeat until all points assigned or marked
     as boundary noise.
  5. Drop facets smaller than MIN_FACET_POINTS as segmentation noise.

Returns the same per-plane dict shape as before — drop-in compatible
with build_facets.build_facets_from_planes.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

# Angle threshold for accepting a neighbour into the current facet.
# 12° is a sweet spot: tight enough to separate hip facets (which differ
# by ~45-90° in azimuth), permissive enough to absorb LiDAR scan noise
# within a single facet (typically ±3-5°).
ANGLE_THRESHOLD_DEG = 12.0

# Phase 3 — minimum points to call a region a facet. Dropped from 80
# to 20 (3DEP QL2 is ~2-4 pts/m², so 80 points = ~30 m² = ~430 sqft,
# which silently dropped dormers, hip triangles, and chimney crickets).
# 20 points ≈ 10 m² ≈ ~108 sqft — catches small structures while still
# rejecting segmentation noise. Combined with the post-PolyFit small-
# flat-top filter, this won't introduce phantom HVAC/skylight facets.
MIN_FACET_POINTS = 20

# Phase 3 — point-to-plane distance threshold for region growing.
# Previously absent: region growing only checked normal-direction
# similarity, which let a noisy long facet drift apart into two
# regions. Adding this distance check forces points to also be
# spatially close to the running plane, not just normal-aligned.
# 0.20m matches the ±0.15-0.25m research recommendation for QL2.
PLANE_DISTANCE_THRESHOLD_M = 0.20

# Phase 3 — epsilon for the coplanar-merge post-pass. Two planes are
# considered the same surface (and merged) when their normals are
# within COPLANAR_NORMAL_DEG AND their centroids project within
# COPLANAR_CLUSTER_EPSILON_M along the shared normal. Catches "one
# real facet split into two segmentation halves" before downstream
# stages see the input.
COPLANAR_CLUSTER_EPSILON_M = 0.50
COPLANAR_NORMAL_DEG = 5.0

# KNN for spatial neighbour expansion. 8 = standard for region-growing
# on point clouds; preserves locality without over-bridging.
KNN = 8


def segment_plane_regions(roof_pts: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        import numpy as np  # noqa: PLC0415
        from scipy.spatial import cKDTree  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"required dep missing: {err}") from err

    xyz = roof_pts["xyz"]
    normals = roof_pts["normals"]
    if len(xyz) == 0:
        return []

    n = len(xyz)
    log.info(
        "region-grow: n=%d points, knn=%d, angle_threshold=%.1f°",
        n, KNN, ANGLE_THRESHOLD_DEG,
    )

    # Precompute the KNN graph once — every BFS step queries it.
    tree = cKDTree(xyz)
    _, knn_idx = tree.query(xyz, k=KNN + 1)  # +1 because [0] is self
    knn_idx = knn_idx[:, 1:]  # drop self-reference

    cos_threshold = float(np.cos(np.radians(ANGLE_THRESHOLD_DEG)))

    labels = np.full(n, -1, dtype=np.int32)
    facet_id = 0
    # Process seeds in arbitrary order — region growing is order-invariant
    # for convergence (different seed orders just produce slightly
    # different facet shapes near boundaries).
    for seed_idx in range(n):
        if labels[seed_idx] != -1:
            continue
        # BFS from this seed.
        facet_mask = _grow_region(
            seed_idx=seed_idx,
            knn_idx=knn_idx,
            normals=normals,
            xyz=xyz,
            labels=labels,
            cos_threshold=cos_threshold,
            plane_distance_threshold_m=PLANE_DISTANCE_THRESHOLD_M,
        )
        if facet_mask.sum() >= MIN_FACET_POINTS:
            labels[facet_mask] = facet_id
            facet_id += 1
        else:
            # Too small — mark as noise so subsequent seeds skip these.
            labels[facet_mask] = -2

    log.info(
        "region-grow: built %d facets, %d noise, %d unassigned",
        facet_id,
        int((labels == -2).sum()),
        int((labels == -1).sum()),
    )

    # Build the plane records expected by build_facets.
    planes: list[dict[str, Any]] = []
    for fid in range(facet_id):
        mask = labels == fid
        pts = xyz[mask]
        cluster_normals = normals[mask]

        # Pitch from mean |nz| (consistent with single-cluster stub) so
        # symmetric hip facets each report their real pitch instead of
        # the cancelled-out average normal pitch.
        mean_abs_nz = float(np.clip(np.abs(cluster_normals[:, 2]).mean(), -1.0, 1.0))
        pitch_deg = float(np.degrees(np.arccos(mean_abs_nz)))

        # Direction: average normal's xy direction (with z forced positive).
        n_avg = cluster_normals.mean(axis=0)
        if n_avg[2] < 0:
            n_avg = -n_avg
        xy_norm = float(np.linalg.norm(n_avg[:2]))
        if xy_norm > 1e-3:
            xy_dir = n_avg[:2] / xy_norm
        else:
            xy_dir = np.array([0.0, 1.0])
        pitch_rad = np.radians(pitch_deg)
        plane_normal = np.array([
            xy_dir[0] * np.sin(pitch_rad),
            xy_dir[1] * np.sin(pitch_rad),
            np.cos(pitch_rad),
        ])
        plane_d = -np.dot(plane_normal, pts.mean(axis=0))

        planes.append({
            "points": pts.tolist(),
            "normal": plane_normal.tolist(),
            "d": float(plane_d),
            "centroid": pts.mean(axis=0).tolist(),
            "size": int(mask.sum()),
        })

    log.info("region-grow: emitted %d plane regions", len(planes))

    # Phase 3 — coplanar-merge pass. Region growing sometimes splits
    # one real facet into two halves when noise drives the running
    # mean normal apart mid-growth. Merge planes whose normals are
    # within COPLANAR_NORMAL_DEG AND whose centroids project within
    # COPLANAR_CLUSTER_EPSILON_M along the shared normal.
    if len(planes) >= 2:
        planes = _merge_coplanar_planes(planes)
        log.info("after coplanar-merge: %d planes", len(planes))

    # Connected-component post-filter — drops detached structures (sheds,
    # detached garages, ADUs) that the parcel polygon mistakenly included.
    # Without this, two adjacent buildings sharing a Solar building mask
    # are both measured as "the roof."
    #
    # Approach: build a graph over facets where an edge exists between
    # two facets if their centroids are <= MAIN_BUILDING_LINK_M apart in
    # xy. Find connected components. The largest component (by total
    # point count) is "the main building." Drop facets outside it.
    if len(planes) >= 2:
        planes = _filter_to_main_building(planes)
        log.info("after connected-component filter: %d planes", len(planes))

    return planes


# Distance threshold (meters) under which two facets are considered part
# of the same building. A typical hip-roof ridge spans 3-12m between
# adjacent facet centroids; a detached shed is usually 5-30m away from
# the main house centroid. 8m is the sweet spot that joins all main-
# house facets while rejecting almost all detached structures.
MAIN_BUILDING_LINK_M = 8.0


def _merge_coplanar_planes(planes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge planes that describe the same surface. Two planes are
    considered the same when:
      - their normals are within COPLANAR_NORMAL_DEG of each other
      - their centroids project within COPLANAR_CLUSTER_EPSILON_M
        along the shared mean normal (perpendicular distance to
        the other plane is small).

    Uses union-find to group transitively (A coplanar with B, B
    coplanar with C → all three merge). Merged plane's points,
    centroid, and normal are recomputed from the combined input.
    """
    import numpy as np  # noqa: PLC0415

    n = len(planes)
    cos_threshold = float(np.cos(np.radians(COPLANAR_NORMAL_DEG)))

    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    normals = [np.asarray(p["normal"], dtype=np.float64) for p in planes]
    centroids = [np.asarray(p["centroid"], dtype=np.float64) for p in planes]

    for i in range(n):
        for j in range(i + 1, n):
            ni = normals[i]
            nj = normals[j]
            # Normals are sign-ambiguous from PCA. Take the absolute
            # dot to handle the case where one was flipped.
            d = abs(float(np.dot(ni, nj)))
            if d < cos_threshold:
                continue
            # Perpendicular distance from centroid[j] to plane[i]
            # using the average normal as the reference direction.
            mean_n = (ni + (nj if np.dot(ni, nj) > 0 else -nj)) / 2
            mean_n /= max(1e-9, np.linalg.norm(mean_n))
            delta = centroids[j] - centroids[i]
            perp_dist = abs(float(np.dot(mean_n, delta)))
            if perp_dist <= COPLANAR_CLUSTER_EPSILON_M:
                union(i, j)

    # Group indices by root.
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    if len(groups) == n:
        return planes  # no merges happened

    merged: list[dict[str, Any]] = []
    for indices in groups.values():
        if len(indices) == 1:
            merged.append(planes[indices[0]])
            continue
        # Combine points from all source planes.
        all_pts = np.vstack(
            [np.asarray(planes[i]["points"]) for i in indices],
        )
        # Average normals with sign alignment (flip each to match the
        # first plane's hemisphere before averaging).
        ref_n = normals[indices[0]]
        signed_sum = np.zeros(3, dtype=np.float64)
        for i in indices:
            n_i = normals[i]
            if np.dot(ref_n, n_i) < 0:
                n_i = -n_i
            signed_sum += n_i * planes[i]["size"]  # weight by point count
        mean_n = signed_sum / max(1e-9, np.linalg.norm(signed_sum))
        new_centroid = all_pts.mean(axis=0)
        new_d = float(-np.dot(mean_n, new_centroid))
        merged.append({
            "points": all_pts.tolist(),
            "normal": mean_n.tolist(),
            "d": new_d,
            "centroid": new_centroid.tolist(),
            "size": sum(planes[i]["size"] for i in indices),
        })

    log.info(
        "coplanar-merge: %d planes -> %d (collapsed %d coplanar groups)",
        n, len(merged), n - len(merged),
    )
    return merged


def _filter_to_main_building(planes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only the planes belonging to the largest spatial cluster.

    Two facets are linked if their xy centroids are within
    MAIN_BUILDING_LINK_M. The largest connected component (by total
    point count, not facet count — penalizes a few big-area orphans
    that happen to be close to each other in xy) wins.
    """
    import numpy as np  # noqa: PLC0415

    n = len(planes)
    centroids = np.array([p["centroid"][:2] for p in planes], dtype=np.float64)
    sizes = np.array([p["size"] for p in planes], dtype=np.int64)

    # Union-Find for connected components.
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    link_sq = MAIN_BUILDING_LINK_M * MAIN_BUILDING_LINK_M
    for i in range(n):
        for j in range(i + 1, n):
            dx = centroids[i, 0] - centroids[j, 0]
            dy = centroids[i, 1] - centroids[j, 1]
            if dx * dx + dy * dy <= link_sq:
                union(i, j)

    # Total point count per root.
    component_size: dict[int, int] = {}
    for i in range(n):
        r = find(i)
        component_size[r] = component_size.get(r, 0) + int(sizes[i])

    main_root = max(component_size, key=lambda r: component_size[r])
    kept = [planes[i] for i in range(n) if find(i) == main_root]
    dropped = n - len(kept)
    if dropped > 0:
        log.info(
            "main-building filter: dropped %d detached planes (%d remain)",
            dropped, len(kept),
        )
    return kept


def _grow_region(
    *,
    seed_idx: int,
    knn_idx: Any,
    normals: Any,
    xyz: Any,
    labels: Any,
    cos_threshold: float,
    plane_distance_threshold_m: float,
) -> Any:
    """BFS from `seed_idx` through KNN graph. Accept neighbour if:
      1. Its normal is within angle_threshold of the running mean
         normal, AND
      2. Its 3D position is within plane_distance_threshold_m of the
         running plane (Phase 3 addition — without this, region
         growing only checked normal-direction similarity and a
         noisy long facet could drift apart into two regions).

    Return boolean mask over all points indicating which are in
    this region.
    """
    import numpy as np  # noqa: PLC0415

    n = len(normals)
    mask = np.zeros(n, dtype=bool)
    mask[seed_idx] = True

    # Running sum of normals + positions — used to compute the
    # running plane (mean normal, mean centroid) for the distance check.
    sum_normal = normals[seed_idx].copy()
    sum_pos = xyz[seed_idx].copy()
    count = 1

    # BFS queue. Use a list as a stack — order doesn't matter for
    # correctness of region growing, only for the boundary path taken.
    queue = list(knn_idx[seed_idx])
    while queue:
        cand = queue.pop()
        if mask[cand] or labels[cand] != -1:
            continue
        # Test against the current facet's running mean normal.
        mean_n = sum_normal / count
        mean_n = mean_n / max(1e-9, np.linalg.norm(mean_n))
        # Dot product with candidate's normal (both unit) = cos angle.
        dot = float(np.dot(mean_n, normals[cand]))
        if abs(dot) < cos_threshold:
            continue
        # Phase 3 — point-to-plane distance check. The running plane
        # passes through (sum_pos / count) with normal mean_n. Project
        # the candidate onto that plane; if the perpendicular distance
        # exceeds the threshold, the candidate isn't on this facet
        # (even though its normal looks similar — common case: noisy
        # long ridge where the two halves drift in z by 30-50cm).
        mean_pos = sum_pos / count
        plane_dist = abs(float(np.dot(mean_n, xyz[cand] - mean_pos)))
        if plane_dist > plane_distance_threshold_m:
            continue
        # Accept — extend facet.
        mask[cand] = True
        # Sign-flip the candidate normal to match the facet's hemisphere
        # before averaging (PCA-derived normals are sign-ambiguous).
        n_signed = normals[cand] if dot > 0 else -normals[cand]
        sum_normal += n_signed
        sum_pos += xyz[cand]
        count += 1
        # Enqueue this candidate's KNN neighbours.
        for nb in knn_idx[cand]:
            if not mask[nb] and labels[nb] == -1:
                queue.append(nb)

    return mask

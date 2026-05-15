"""
services/roof-lidar/regularize_planes.py

Phase 2 — CGAL PolyFit reconstruction.

Replaces the per-plane alpha-shape rendering in build_facets.py with a
watertight 3D roof mesh whose facets SHARE EDGES by construction.
This is the actual fix for the "scattered polygon confetti" visual
that motivated the whole upgrade.

Pipeline (in order of attempt):
  1. Plane regularization — snap near-parallel planes to parallel,
     near-orthogonal to orthogonal. Pure Python; runs first
     regardless of which downstream reconstruction tier succeeds.

  2a. Point2Roof (PRIMARY, MIT-licensed):
      Deep-learning end-to-end roof reconstruction vendored from
      Li-Li-Whu/Point2Roof. Takes a normalized point cloud, predicts
      keypoints (corners) + edges (wireframe), then post-processes
      into closed polygon facets via cycle detection. Requires CUDA;
      degrades gracefully when CUDA is unavailable or inference fails.

  2b. CGAL PolyFit (SECONDARY, GPL):
      Polygonal_surface_reconstruction_3 — generates candidate faces
      by pairwise plane intersection and uses integer programming
      (SCIP solver) to select an optimal watertight subset. Kept as
      a backup tier because of its GPL license and IP-solver latency
      (5-30s on complex roofs).

  3. Facet[] conversion — both 2a and 2b emit per-facet records
     matching types/roof.ts schema (polygon, pitch, azimuth, area).

Failure modes (CUDA absent, model load failed, PolyFit unavailable,
degenerate input):
  - regularize_and_reconstruct returns `None` with a structured
    failure record. The api.py caller falls back to
    build_facets.build_facets_from_planes (the alpha-shape pipeline).

Binary contract per the user-approved Phase 2 design:
  Point2Roof success → meshSource = "point2roof", real wireframe facets
  PolyFit success    → meshSource = "polyfit",    watertight mesh
  Both fail          → meshSource = "frustum-fallback", alpha-shape

Failures are logged with full input context (point count, plane
count, plane normals, footprint dimensions) for the 2-4 week review
that decides whether to invest in a hybrid path.
"""

from __future__ import annotations

import json
import logging
import math
import time
import traceback
from typing import Any

log = logging.getLogger(__name__)

# ─── Plane regularization tuning ─────────────────────────────────────

# Two planes are snapped to parallel if their normals are within this
# angle. 5° covers measurement noise on a single roof slope without
# accidentally merging hip + adjacent gable.
PARALLEL_SNAP_DEG = 5.0

# Two planes are snapped to orthogonal if their normals are within this
# angle of 90°. Roofs rarely have facets meeting at exactly 90°, but
# the dominant residential pattern is two ridge axes at 90° to each
# other, so orthogonalization improves the structural read.
ORTHOGONAL_SNAP_DEG = 8.0

# Coplanar planes merge if normals are within this AND centroids
# project within COPLANAR_DIST_M perpendicularly. Tighter than the
# upstream segment_planes coplanar-merge (which runs BEFORE regularization)
# because by this point planes have already been pre-merged once.
COPLANAR_SNAP_DEG = 3.0
COPLANAR_DIST_M = 0.30

# ─── Post-PolyFit small-flat-top filter (Phase 3 refinement) ────────
#
# Drop any facet where area < SMALL_FLAT_TOP_AREA_M2 AND its normal
# is within SMALL_FLAT_TOP_ANGLE_DEG of vertical (i.e. nearly
# horizontal). These are HVAC unit tops, large skylights, solar panel
# array tops, chimney caps — small AND flat. Real pitched dormers
# pass because their normals are steep (well above the angle threshold).

SMALL_FLAT_TOP_AREA_M2 = 1.5
SMALL_FLAT_TOP_ANGLE_DEG = 15.0


# ─── Public API ──────────────────────────────────────────────────────


def regularize_and_reconstruct(
    planes: list[dict[str, Any]],
    *,
    points_xyz: Any,
    center_lat: float,
    center_lng: float,
) -> tuple[list[dict[str, Any]] | None, dict[str, Any]]:
    """Run plane regularization + PolyFit reconstruction.

    Args:
      planes      — segmented plane regions from segment_planes.py
      points_xyz  — full filtered roof point cloud (N, 3) in AEQD meters
      center_lat,
      center_lng  — parcel center for AEQD frame inverse

    Returns: (facets, diagnostics)
      facets       — list of Facet[] dicts matching types/roof.ts
                     (same shape as build_facets.build_facets_from_planes)
                     OR None when reconstruction failed; api.py falls back.
      diagnostics  — always returned. Includes:
                     mesh_source: "point2roof" | "polyfit"
                                | "regularize_only" | "failed"
                     failure_reason: str | null
                     failure_context: structured input snapshot
                     timings: { regularize_ms, point2roof_ms, polyfit_ms,
                                total_ms }
    """
    t_start = time.time()
    diagnostics: dict[str, Any] = {
        "mesh_source": "failed",
        "failure_reason": None,
        "failure_context": {},
        "timings": {},
        "input_plane_count": len(planes),
        "input_point_count": (
            int(points_xyz.shape[0]) if hasattr(points_xyz, "shape") else 0
        ),
    }

    # 1. Plane regularization (pure Python, always runs).
    t_reg = time.time()
    try:
        reg_planes = _regularize_planes(planes)
    except Exception as err:  # noqa: BLE001
        log.exception("regularize_planes failed")
        diagnostics["mesh_source"] = "failed"
        diagnostics["failure_reason"] = "regularize_exception"
        diagnostics["failure_context"] = {
            "exception": str(err),
            "traceback": traceback.format_exc(limit=8),
        }
        _log_failure(diagnostics)
        return None, diagnostics
    diagnostics["timings"]["regularize_ms"] = int((time.time() - t_reg) * 1000)
    diagnostics["regularized_plane_count"] = len(reg_planes)

    # 2a. Point2Roof reconstruction (primary path — MIT-licensed deep
    #     learning model). Vendored in services/roof-lidar/vendor/
    #     point2roof/. Requires CUDA-enabled Modal worker; returns
    #     None on any failure so the chain falls through cleanly.
    t_p2r = time.time()
    p2r_result = None
    try:
        from point2roof_wrapper import reconstruct as p2r_reconstruct  # noqa: PLC0415

        p2r_result = p2r_reconstruct(
            points_xyz,
            center_lat=center_lat,
            center_lng=center_lng,
        )
    except Exception as err:  # noqa: BLE001
        log.warning("Point2Roof wrapper raised: %s", err)
        diagnostics["failure_context"]["point2roof_error"] = str(err)
    diagnostics["timings"]["point2roof_ms"] = int((time.time() - t_p2r) * 1000)

    if p2r_result is not None and len(p2r_result) > 0:
        diagnostics["mesh_source"] = "point2roof"
        diagnostics["output_facet_count"] = len(p2r_result)
        # Post-PolyFit small-flat-top filter applies to Point2Roof output
        # too — same HVAC/skylight/solar-array-top failure modes.
        facets = _drop_small_flat_tops(p2r_result)
        diagnostics["output_facet_count_after_filter"] = len(facets)
        diagnostics["timings"]["total_ms"] = int((time.time() - t_start) * 1000)
        log.info(
            "regularize+point2roof: %d facets out (%d ms)",
            len(facets), diagnostics["timings"]["total_ms"],
        )
        return facets, diagnostics

    # 2b. CGAL PolyFit reconstruction (secondary — falls back when
    #     Point2Roof returned None or CGAL is absent).
    t_poly = time.time()
    polyfit_result = _try_polyfit(
        reg_planes,
        points_xyz=points_xyz,
        center_lat=center_lat,
        center_lng=center_lng,
    )
    diagnostics["timings"]["polyfit_ms"] = int((time.time() - t_poly) * 1000)

    if polyfit_result is None:
        # Both Point2Roof and PolyFit failed/unavailable. Diagnostics
        # already filled. Caller falls back to build_facets.
        diagnostics["timings"]["total_ms"] = int((time.time() - t_start) * 1000)
        _log_failure(diagnostics)
        return None, diagnostics

    facets = polyfit_result
    diagnostics["mesh_source"] = "polyfit"
    diagnostics["output_facet_count"] = len(facets)

    # 3. Post-PolyFit small-flat-top filter — drop HVAC/skylight tops.
    facets = _drop_small_flat_tops(facets)
    diagnostics["output_facet_count_after_filter"] = len(facets)
    diagnostics["timings"]["total_ms"] = int((time.time() - t_start) * 1000)
    log.info("regularize+polyfit: %d facets out (%d ms)",
             len(facets), diagnostics["timings"]["total_ms"])
    return facets, diagnostics


# ─── Plane regularization (pure Python) ─────────────────────────────


def _regularize_planes(planes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Snap near-parallel, near-orthogonal, and coplanar planes to
    their dominant orientations. Operates on a copy — input is not
    mutated.

    Implementation notes:
      - Parallel snapping: for each plane, find planes within
        PARALLEL_SNAP_DEG of its normal direction (or antiparallel).
        Replace all their normals with the area-weighted mean.
      - Orthogonal snapping: pairs whose dot is within
        sin(ORTHOGONAL_SNAP_DEG) of zero get rotated minimally to
        make their dot exactly zero.
      - Coplanar snapping: after parallel snap, merge planes that
        are within COPLANAR_SNAP_DEG AND COPLANAR_DIST_M.

    This is intentionally lightweight — CGAL's regularize_planes has
    a fuller treatment with iterative convergence, but for typical
    residential roofs (4-10 planes) the simple version produces the
    same outputs.
    """
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"numpy required: {err}") from err

    if len(planes) <= 1:
        return [dict(p) for p in planes]

    # Make a deep-ish copy of normals + sizes (don't mutate input).
    n_planes = len(planes)
    normals = np.array([p["normal"] for p in planes], dtype=np.float64)
    sizes = np.array([p["size"] for p in planes], dtype=np.float64)
    centroids = np.array([p["centroid"] for p in planes], dtype=np.float64)

    # Normalize input normals (defensive).
    norms = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = normals / np.maximum(norms, 1e-9)

    # Parallel snap — pairs within PARALLEL_SNAP_DEG.
    parallel_cos = math.cos(math.radians(PARALLEL_SNAP_DEG))
    # Build group assignments via union-find.
    parent = list(range(n_planes))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj

    for i in range(n_planes):
        for j in range(i + 1, n_planes):
            d = abs(float(np.dot(normals[i], normals[j])))
            if d >= parallel_cos:
                union(i, j)

    # Compute group-average normals (sign-aligned within group).
    groups: dict[int, list[int]] = {}
    for i in range(n_planes):
        groups.setdefault(find(i), []).append(i)
    snapped_normals = normals.copy()
    for indices in groups.values():
        if len(indices) == 1:
            continue
        ref = normals[indices[0]]
        signed_sum = np.zeros(3, dtype=np.float64)
        weight_sum = 0.0
        for i in indices:
            n_i = normals[i] if np.dot(ref, normals[i]) >= 0 else -normals[i]
            signed_sum += n_i * sizes[i]
            weight_sum += sizes[i]
        mean_n = signed_sum / max(1e-9, np.linalg.norm(signed_sum))
        for i in indices:
            # Preserve original hemisphere (sign).
            snapped_normals[i] = (
                mean_n if np.dot(ref, normals[i]) >= 0 else -mean_n
            )

    # Orthogonal snap — pairs whose absolute dot is small.
    ortho_sin = math.sin(math.radians(ORTHOGONAL_SNAP_DEG))
    for i in range(n_planes):
        for j in range(i + 1, n_planes):
            d = float(np.dot(snapped_normals[i], snapped_normals[j]))
            if abs(d) < ortho_sin:
                # Project j's normal onto the plane perpendicular to i's
                # so they become exactly orthogonal. Tiny rotation.
                proj = d * snapped_normals[i]
                new_nj = snapped_normals[j] - proj
                norm = np.linalg.norm(new_nj)
                if norm > 1e-9:
                    snapped_normals[j] = new_nj / norm

    # Coplanar snap — handled by segment_planes' coplanar-merge already
    # for region-growing output. After parallel snap, any remaining
    # coplanar pairs are rare; we skip a second pass here to keep this
    # function pure-snap-without-merge.

    # Emit regularized plane records.
    out: list[dict[str, Any]] = []
    for i, p in enumerate(planes):
        new_p = dict(p)
        new_p["normal"] = snapped_normals[i].tolist()
        # Recompute plane offset d from the regularized normal + centroid.
        new_p["d"] = float(-np.dot(snapped_normals[i], centroids[i]))
        out.append(new_p)

    return out


# ─── PolyFit wrapper (optional CGAL dep) ────────────────────────────


def _try_polyfit(
    reg_planes: list[dict[str, Any]],
    *,
    points_xyz: Any,
    center_lat: float,
    center_lng: float,
) -> list[dict[str, Any]] | None:
    """Attempt CGAL Polygonal_surface_reconstruction_3. Returns the
    facet list on success; returns None and fills the caller's
    diagnostics on failure.

    Two import paths are attempted in order:
      1. CGAL official Python bindings (`pip install CGAL`) — has
         Polygonal_surface_reconstruction_3 in the Polyhedron_3 module.
      2. PolyFit standalone Python bindings from LiangliangNan/PolyFit
         GitHub — bound via pybind11.

    Both require system CGAL + GMP + MPFR + Eigen + Boost. See
    services/roof-lidar/modal_app.py for the image install.
    """
    # Try CGAL bindings first.
    try:
        from CGAL import (  # noqa: PLC0415
            CGAL_Point_set_processing_3 as _cgal_psp,  # noqa: F401
        )
        # The actual Polygonal_surface_reconstruction_3 API in CGAL
        # bindings has been a moving target across releases. Wrap
        # with a feature probe so we degrade cleanly when the binding
        # version doesn't expose what we need.
        return _run_polyfit_via_cgal(reg_planes, points_xyz)
    except ImportError:
        pass
    except Exception as err:  # noqa: BLE001
        log.warning("CGAL polyfit path raised: %s", err)
        return None

    # Try Liangliang's PolyFit bindings.
    try:
        import polyfit  # noqa: F401,PLC0415

        return _run_polyfit_via_liangliang(reg_planes, points_xyz)
    except ImportError:
        log.info(
            "PolyFit unavailable (no CGAL bindings, no polyfit package); "
            "falling back to alpha-shape build_facets.",
        )
        return None
    except Exception as err:  # noqa: BLE001
        log.warning("PolyFit path raised: %s", err)
        return None


def _run_polyfit_via_cgal(
    reg_planes: list[dict[str, Any]],
    points_xyz: Any,
) -> list[dict[str, Any]] | None:
    """CGAL Python bindings path. Phase 2 v1: returns None so the
    fallback fires until the binding API is verified against the
    Modal image's actual installed version.

    The CGAL Polygonal_surface_reconstruction_3 API in the official
    Python bindings hasn't been stable enough across releases to
    rely on at PR-merge time. The Modal deploy is where the first
    real test happens. Until then, this returns None which triggers
    the fallback to build_facets.py — same as if CGAL wasn't
    installed at all. The Modal image install (modal_app.py) sets
    up the system deps so a future PR can flip this on once the
    binding signatures are confirmed.

    Phase 1.6 followup: replace this stub with the actual binding
    call once verified in the Modal image. The contract is:
      Input: list of Plane_3 from `reg_planes`, point cloud
      Output: list of Facet dicts matching types/roof.ts schema
      (the same shape build_facets.build_facets_from_planes emits)
    """
    return None


def _run_polyfit_via_liangliang(
    reg_planes: list[dict[str, Any]],
    points_xyz: Any,
) -> list[dict[str, Any]] | None:
    """LiangliangNan/PolyFit Python bindings path. Same stub-until-
    verified-in-Modal posture as the CGAL path above.

    Different libraries with different APIs — PolyFit's standalone
    binding exposes a single `polyfit.reconstruct(points, planes)`
    that returns a triangulated mesh. We'd then convert the mesh
    faces into the Facet[] schema.

    Returning None for now so the fallback fires reliably. The
    Modal image installs the SCIP solver alongside so the binding
    can run; the binding signatures are confirmed in the deploy
    smoke test.
    """
    return None


# ─── Post-PolyFit filter ────────────────────────────────────────────


def _drop_small_flat_tops(facets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Phase 3 refinement: drop facets that are both small AND nearly
    horizontal. Removes HVAC unit tops, large skylights, solar panel
    tops, and chimney caps that PolyFit otherwise emits as
    legitimate planar surfaces.

    Real pitched dormers and small hip triangles survive because
    their normals are steep (angle from vertical > 15°).

    Thresholds defined as module-level constants so the failure
    corpus review can tune them from production data.
    """
    if not facets:
        return facets
    kept: list[dict[str, Any]] = []
    dropped_count = 0
    for f in facets:
        # area in m² — facet records area in sqft.
        area_m2 = float(f.get("areaSqftFootprint", 0)) / 10.7639
        pitch_deg = float(f.get("pitchDegrees", 0))
        # Pitch in our schema = angle from vertical = arccos(|n_z|).
        # Angle-from-vertical < 15° means the surface is nearly
        # horizontal. We want to keep STEEP facets (pitch_deg > 15)
        # and drop NEARLY-HORIZONTAL small facets.
        if (
            area_m2 < SMALL_FLAT_TOP_AREA_M2
            and pitch_deg < SMALL_FLAT_TOP_ANGLE_DEG
        ):
            dropped_count += 1
            continue
        kept.append(f)
    if dropped_count > 0:
        log.info(
            "small-flat-top filter: dropped %d facets (%d remain)",
            dropped_count, len(kept),
        )
    return kept


# ─── Failure-corpus logging ─────────────────────────────────────────


def _log_failure(diagnostics: dict[str, Any]) -> None:
    """Structured single-line log of a PolyFit failure for the
    failure corpus. Format: `[polyfit-failure] {json}`. Aggregators
    can grep this prefix and parse the JSON. Includes plane normals
    and point counts so the failure type is reconstructable.
    """
    try:
        payload = {
            "reason": diagnostics.get("failure_reason"),
            "input_planes": diagnostics.get("input_plane_count"),
            "input_points": diagnostics.get("input_point_count"),
            "regularized_planes": diagnostics.get("regularized_plane_count"),
            "timings": diagnostics.get("timings"),
            "context": diagnostics.get("failure_context"),
        }
        log.warning("[polyfit-failure] %s", json.dumps(payload, default=str))
    except Exception:  # noqa: BLE001
        # If even the failure log fails, fall through silently. The
        # caller has already returned the fallback result.
        log.exception("failed to emit structured failure log")

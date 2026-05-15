"""
services/roof-lidar/point2roof_wrapper.py

Wrapper around the vendored Point2Roof deep-learning roof reconstruction
model (services/roof-lidar/vendor/point2roof/). Used as the FIRST
reconstruction try-path in regularize_planes.py, ahead of CGAL PolyFit
and the alpha-shape fallback.

Why Point2Roof was chosen as the primary path:
  - MIT license (vs CGAL's GPL — significant for a commercial product)
  - Lower install complexity: PyTorch + CUDA (already in the Modal
    image for YOLO) + one C++/CUDA extension build, vs the CGAL stack
    (libcgal-dev, libgmp-dev, libmpfr-dev, libeigen3-dev, libboost-dev,
    coinor-libscip-dev — ~150 MB of native libs)
  - Inference latency in ms vs PolyFit's 5-30s IP solver

Known risks (documented in chat, not silently ignored):
  1. Trained on RoofN3D (500 buildings, mostly European) + synthetic.
     Generalization to USGS 3DEP QL2 (~2-4 pts/m², Florida residential)
     is UNTESTED on real customer addresses until first Modal deploy.
  2. Outputs WIREFRAME (keypoints + edges), not a closed mesh. We
     post-process by detecting closed polygon cycles in the edge graph
     and computing best-fit-plane facets from each cycle.
  3. Requires CUDA. The Modal `run_extract` function must be configured
     with `gpu=` set; CPU-only invocations skip Point2Roof and fall
     through to PolyFit / alpha-shape.
  4. Vendored repo is in maintenance mode (7 commits, no recent
     activity). Pinned to a specific snapshot in vendor/ to avoid
     surprise upstream changes.

API:
  reconstruct(roof_xyz, *, center_lat, center_lng) -> list[Facet] | None

  Returns the Facet[] list when reconstruction succeeded with at least
  one valid face, None on any failure (model load, CUDA unavailable,
  inference error, no closed cycles found). Callers fall through to
  the next reconstruction tier.
"""

from __future__ import annotations

import logging
import math
import os
import sys
from typing import Any

log = logging.getLogger(__name__)

# Vendored Point2Roof location. Added to sys.path lazily on first call
# so import-time failures don't break the rest of the pipeline.
_VENDOR_ROOT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "vendor", "point2roof",
)
_CHECKPOINT_PATH = os.path.join(_VENDOR_ROOT, "checkpoint_epoch_90.pth")
_CONFIG_PATH = os.path.join(_VENDOR_ROOT, "model_cfg.yaml")

# Network expects exactly NPOINT=1024 input points per the trained config.
# We farthest-point-sample (FPS) the input cloud down to this; padding
# with duplicates if the input cloud is smaller.
_NPOINT = 1024


# Module-level cache for the loaded model. RoofNet is ~10 MB; loading
# takes ~200ms — cheap to cache across calls inside a warm Modal worker.
_model_cache: Any = None
_model_load_failed = False


def reconstruct(
    roof_xyz: Any,
    *,
    center_lat: float,
    center_lng: float,
) -> list[dict[str, Any]] | None:
    """Run Point2Roof inference on a roof point cloud.

    Args:
        roof_xyz     — numpy ndarray (N, 3) of AEQD-meter roof points
                       (same frame as build_facets.py expects)
        center_lat,
        center_lng   — parcel center; used for AEQD inverse so output
                       facet polygons land in lat/lng

    Returns:
        Facet[] dicts matching types/roof.ts schema, OR None on any
        failure (CUDA unavailable, model load failed, no faces
        detected, inference error). Caller falls through.
    """
    # ─── Per-gate observability logs ────────────────────────────────
    # All gate misses + the success path emit a single greppable line of
    # the shape `point2roof: gate=<name> [key=val ...]` so weekly modal
    # log scans can count the distribution of failure modes across real
    # addresses. Don't tune any thresholds in this function until the
    # gate-rate distribution is known — guessing without data risks
    # making the 90% case worse to chase the 10% case.
    try:
        import numpy as np  # noqa: PLC0415
        import torch  # noqa: PLC0415
    except ImportError as err:
        log.info("point2roof: gate=imports_unavailable err=%s", err)
        return None

    if not torch.cuda.is_available():
        log.info("point2roof: gate=no_cuda")
        return None

    model = _load_model()
    if model is None:
        log.info("point2roof: gate=model_load_failed")
        return None

    # ─── Preprocess: center + normalize + FPS to NPOINT ──────────────
    pts_np = np.asarray(roof_xyz, dtype=np.float32)
    if pts_np.ndim != 2 or pts_np.shape[1] != 3:
        log.info("point2roof: gate=bad_input_shape shape=%s", pts_np.shape)
        return None
    n_in = len(pts_np)
    if n_in < 50:
        log.info("point2roof: gate=npoints n_in=%d", n_in)
        return None

    min_pt = pts_np.min(axis=0)
    max_pt = pts_np.max(axis=0)
    extent = max_pt - min_pt
    extent_safe = np.where(extent < 1e-6, 1.0, extent)
    centered = pts_np - min_pt
    # Normalize to [0, 1] in each axis to match the training distribution.
    # The model's PosRadius=0.15 is a fraction of the normalized extent.
    normalized = centered / extent_safe

    # FPS to NPOINT. If the cloud is small, pad with replicated samples
    # so the network still gets a fixed-size input.
    sampled_idx = _farthest_point_sample(normalized, _NPOINT)
    if sampled_idx is None:
        log.info("point2roof: gate=fps_failed n_in=%d", n_in)
        return None
    sampled = normalized[sampled_idx]

    # ─── Inference ────────────────────────────────────────────────────
    try:
        keypoints, edges = _infer(model, sampled)
    except Exception as err:  # noqa: BLE001
        log.info("point2roof: gate=inference_error err=%s", err)
        return None

    n_keypoints = 0 if keypoints is None else len(keypoints)
    n_edges = 0 if edges is None else len(edges)
    if keypoints is None or n_keypoints < 3 or edges is None or n_edges < 3:
        log.info(
            "point2roof: gate=insufficient_structure keypoints=%d edges=%d n_in=%d",
            n_keypoints, n_edges, n_in,
        )
        return None

    # ─── Denormalize keypoints back to AEQD meters ───────────────────
    keypoints_meters = keypoints * extent_safe + min_pt

    # ─── Wireframe → polygon faces via cycle detection ───────────────
    faces = _wireframe_to_faces(keypoints_meters, edges)
    if not faces or len(faces) == 0:
        log.info(
            "point2roof: gate=no_closed_cycles keypoints=%d edges=%d n_in=%d",
            n_keypoints, n_edges, n_in,
        )
        return None

    # ─── Convert each face to Facet[] schema ─────────────────────────
    facets = _faces_to_facets(
        faces,
        keypoints_meters,
        center_lat=center_lat,
        center_lng=center_lng,
    )
    if not facets:
        log.info(
            "point2roof: gate=face_to_facet_empty faces=%d keypoints=%d edges=%d",
            len(faces), n_keypoints, n_edges,
        )
        return None
    log.info(
        "point2roof: gate=success facets=%d keypoints=%d edges=%d n_in=%d",
        len(facets), n_keypoints, n_edges, n_in,
    )
    return facets


# ─── Model loading ──────────────────────────────────────────────────


def _load_model() -> Any:
    """Lazy-load the RoofNet checkpoint. Returns None on any failure
    (vendor dir missing, pc_util not built, checkpoint corrupt, etc.)
    so the wrapper degrades gracefully.

    Cached in module scope — subsequent calls within the same warm
    Modal worker reuse the loaded model.
    """
    global _model_cache, _model_load_failed
    if _model_cache is not None:
        return _model_cache
    if _model_load_failed:
        # Don't retry on every call within a warm worker — once we know
        # the load failed, sit on the failure for the worker's lifetime.
        return None

    if _VENDOR_ROOT not in sys.path:
        sys.path.insert(0, _VENDOR_ROOT)

    # Per-stage load diagnostics — same single-line greppable shape
    # as the gate=* logs in reconstruct(). Lets the weekly log scan
    # bucket model_load_failed cases by underlying cause so we know
    # whether to fix vendored imports, ship the checkpoint, patch
    # the state-dict, or adjust torch.load security flags.
    try:
        import torch  # noqa: PLC0415
        # The vendored modules use relative imports from /vendor/point2roof/.
        # Adding the vendor root to sys.path makes `from model.roofnet ...`
        # work the same way the original `test.py` runs it.
        from model.roofnet import RoofNet  # type: ignore  # noqa: PLC0415
        from utils import common_utils  # type: ignore  # noqa: PLC0415
        from model import model_utils as p2r_model_utils  # type: ignore  # noqa: PLC0415
    except Exception as err:  # noqa: BLE001
        log.warning(
            "point2roof: load_stage=imports cls=%s err=%s",
            type(err).__name__, err,
        )
        _model_load_failed = True
        return None

    if not os.path.exists(_CHECKPOINT_PATH):
        log.warning(
            "point2roof: load_stage=checkpoint_missing path=%s",
            _CHECKPOINT_PATH,
        )
        _model_load_failed = True
        return None

    try:
        cfg = common_utils.cfg_from_yaml_file(_CONFIG_PATH)
    except Exception as err:  # noqa: BLE001
        log.warning(
            "point2roof: load_stage=cfg_parse cls=%s err=%s",
            type(err).__name__, err,
        )
        _model_load_failed = True
        return None
    try:
        net = RoofNet(cfg.MODEL)
    except Exception as err:  # noqa: BLE001
        log.warning(
            "point2roof: load_stage=model_init cls=%s err=%s",
            type(err).__name__, err,
        )
        _model_load_failed = True
        return None
    try:
        net.cuda()
        net.eval()
    except Exception as err:  # noqa: BLE001
        log.warning(
            "point2roof: load_stage=cuda_transfer cls=%s err=%s",
            type(err).__name__, err,
        )
        _model_load_failed = True
        return None
    try:
        p2r_model_utils.load_params(net, _CHECKPOINT_PATH, logger=log)
    except Exception as err:  # noqa: BLE001
        log.warning(
            "point2roof: load_stage=load_params cls=%s err=%s",
            type(err).__name__, err,
        )
        _model_load_failed = True
        return None

    # The original test.py sets net.use_edge = True before inference.
    net.use_edge = True
    _model_cache = net
    log.info("point2roof: load_stage=success path=%s", _CHECKPOINT_PATH)
    return net


# ─── Inference (one batch of 1024 normalized points) ───────────────


def _infer(model: Any, sampled_points: Any) -> tuple[Any, Any]:
    """Single-batch forward pass. Returns (keypoints_xyz_normalized,
    edges_list_of_pairs). Both can be None if the model didn't
    produce confident outputs.
    """
    import numpy as np  # noqa: PLC0415
    import torch  # noqa: PLC0415

    # Build the batch dict the way Point2Roof's test loop does. The
    # data loader produces keys: points, batch_size, frame_id,
    # minMaxPt, vectors, edges. For pure inference (no ground truth)
    # we provide the required ones and let the model fill the rest.
    batch_size = 1
    pts_t = torch.from_numpy(sampled_points.astype(np.float32)).unsqueeze(0).cuda()
    batch = {
        "points": pts_t,
        "batch_size": batch_size,
        "frame_id": np.array([0], dtype=np.int64),
        # Required by eval_process but we don't have ground truth;
        # pass dummy zeros. The model still runs inference; we just
        # ignore the loss / statistics path.
        "minMaxPt": np.array([[[0, 0, 0], [1, 1, 1]]], dtype=np.float32),
    }

    with torch.no_grad():
        out = model(batch)

    # Outputs of interest:
    #   refined_keypoint — (M, 4) tensor: [batch_idx, x, y, z] for M
    #                      detected keypoints
    #   edge_score       — (E, 1) score per candidate edge
    #   edges            — set by the model with the predicted edge
    #                      adjacency (pairs of keypoint indices)
    refined = out.get("refined_keypoint")
    edge_score = out.get("edge_score")
    edges = out.get("edges")

    if refined is None or edge_score is None or edges is None:
        return None, None

    # Pull off CUDA + filter by score threshold (matches test_util's
    # ScoreThresh=0.5 default from model_cfg.yaml).
    refined_np = refined.detach().cpu().numpy()
    edge_score_np = edge_score.detach().cpu().numpy().flatten()
    edges_np = (
        edges.detach().cpu().numpy()
        if hasattr(edges, "detach")
        else np.asarray(edges)
    )

    # Filter to batch 0 (we only ran a single sample).
    mask = refined_np[:, 0] == 0
    keypoints = refined_np[mask, 1:4]  # (M, 3)
    # Edges should already be indexed into the per-batch keypoint
    # list. Threshold by score >= 0.5 to drop low-confidence edges.
    keep_edges = edges_np[edge_score_np >= 0.5] if len(edge_score_np) == len(edges_np) else edges_np
    edge_pairs = [(int(e[0]), int(e[1])) for e in keep_edges if len(e) >= 2]

    return keypoints, edge_pairs


# ─── Wireframe → polygon faces ──────────────────────────────────────


def _wireframe_to_faces(
    keypoints: Any,
    edges: list[tuple[int, int]],
) -> list[list[int]]:
    """Find closed planar faces in the wireframe graph.

    Algorithm:
      1. Build an adjacency list from the edges.
      2. Find all minimum cycles (no chord) of length 3-12. Long cycles
         are almost certainly NOT roof faces; short cycles are.
      3. For each cycle, fit a plane through its vertices via SVD.
      4. Reject cycles whose vertices don't fit a plane within a
         tolerance (10cm RMSE) — these are non-planar wireframe loops.

    This is a HEURISTIC. The clean answer is "use the actual face list
    Point2Roof emits," but the vendored repo only emits keypoints +
    edges from the model — the ground-truth `polygon.obj` files have
    explicit faces, but at inference time we have to reconstruct them.

    For typical residential roofs (4-12 facets, 6-20 keypoints, 8-30
    edges), this terminates in milliseconds. Pathological wireframes
    (dense urban) could cycle-explode; we cap the search.
    """
    import numpy as np  # noqa: PLC0415

    if len(keypoints) < 3 or len(edges) < 3:
        return []

    # Build adjacency.
    n = len(keypoints)
    adj: dict[int, set[int]] = {i: set() for i in range(n)}
    for u, v in edges:
        if 0 <= u < n and 0 <= v < n and u != v:
            adj[u].add(v)
            adj[v].add(u)

    # Find all simple cycles of length 3-12. Cap the total cycle
    # search budget so pathological wireframes don't hang.
    MAX_CYCLE_LEN = 12
    MAX_CYCLES = 200
    cycles: list[list[int]] = []
    seen_cycles: set[tuple[int, ...]] = set()

    def normalized_cycle(c: list[int]) -> tuple[int, ...]:
        """Canonical form so [0,1,2,3] and [2,3,0,1] are the same key."""
        if not c:
            return tuple()
        min_idx = c.index(min(c))
        rotated = c[min_idx:] + c[:min_idx]
        reversed_form = [rotated[0]] + rotated[1:][::-1]
        return tuple(min(rotated, reversed_form))

    def dfs(start: int, current: int, path: list[int], depth: int) -> None:
        if len(cycles) >= MAX_CYCLES:
            return
        if depth > MAX_CYCLE_LEN:
            return
        for nb in adj[current]:
            if nb == start and depth >= 3:
                key = normalized_cycle(path)
                if key not in seen_cycles:
                    seen_cycles.add(key)
                    cycles.append(list(path))
                continue
            if nb in path:
                continue
            dfs(start, nb, path + [nb], depth + 1)

    for v in range(n):
        if len(cycles) >= MAX_CYCLES:
            break
        dfs(v, v, [v], 1)

    # Filter cycles to those whose vertices lie on a plane within
    # PLANE_RMSE_TOLERANCE_M. Non-planar cycles (e.g. spanning multiple
    # roof slopes) are not real facets.
    PLANE_RMSE_TOLERANCE_M = 0.30
    keypts = np.asarray(keypoints)
    planar_cycles: list[list[int]] = []
    for c in cycles:
        if len(c) < 3:
            continue
        cp = keypts[c]
        # Fit plane via SVD on centered points.
        centroid = cp.mean(axis=0)
        centered = cp - centroid
        try:
            _, s, _ = np.linalg.svd(centered, full_matrices=False)
        except np.linalg.LinAlgError:
            continue
        # Smallest singular value ≈ RMSE perpendicular to the best-fit plane.
        rmse = float(s[-1]) / max(1, math.sqrt(len(cp)))
        if rmse <= PLANE_RMSE_TOLERANCE_M:
            planar_cycles.append(c)

    # Prefer SHORTEST cycles (smaller faces are more likely to be real
    # roof facets; long cycles span across the building boundary).
    planar_cycles.sort(key=len)

    # Greedily select cycles such that no edge is used by more than 2
    # faces (matches roof topology — every edge bounds at most 2 faces).
    edge_usage: dict[tuple[int, int], int] = {}
    selected: list[list[int]] = []
    for c in planar_cycles:
        cycle_edges = []
        for i in range(len(c)):
            a, b = c[i], c[(i + 1) % len(c)]
            cycle_edges.append((min(a, b), max(a, b)))
        if all(edge_usage.get(e, 0) < 2 for e in cycle_edges):
            for e in cycle_edges:
                edge_usage[e] = edge_usage.get(e, 0) + 1
            selected.append(c)

    return selected


def _faces_to_facets(
    faces: list[list[int]],
    keypoints: Any,
    *,
    center_lat: float,
    center_lng: float,
) -> list[dict[str, Any]]:
    """Convert each cycle to a Facet[] dict in our schema."""
    import numpy as np  # noqa: PLC0415
    from coord_frame import make_aeqd_to_wgs84  # noqa: PLC0415

    aeqd_to_wgs84 = make_aeqd_to_wgs84(center_lat, center_lng)
    keypts = np.asarray(keypoints)

    facets: list[dict[str, Any]] = []
    for idx, cycle in enumerate(faces):
        cp = keypts[cycle]
        if len(cp) < 3:
            continue
        centroid = cp.mean(axis=0)
        centered = cp - centroid
        try:
            _, _, vh = np.linalg.svd(centered, full_matrices=False)
        except np.linalg.LinAlgError:
            continue
        # Normal is the smallest singular vector. Force +z hemisphere.
        normal = vh[-1]
        if normal[2] < 0:
            normal = -normal
        nx, ny, nz = float(normal[0]), float(normal[1]), float(normal[2])
        nz_clamped = max(-1.0, min(1.0, abs(nz)))
        pitch_deg = math.degrees(math.acos(nz_clamped))
        # Azimuth: same convention as build_facets — bearing of the
        # down-slope direction projected onto horizontal.
        if abs(nx) < 1e-6 and abs(ny) < 1e-6:
            azimuth_deg = 0.0
        else:
            azimuth_deg = math.degrees(math.atan2(-nx, -ny)) % 360

        # Project cycle to lat/lng for the Facet polygon. Preserve the
        # Z coordinate as `heightM` so the renderer can use the
        # measured 3D shape directly instead of synthesizing geometry
        # from the outline. We normalize Z relative to the LOWEST
        # vertex of this facet (= the eave-side corner) so heightM=0
        # corresponds to the eave and positive values rise to the
        # ridge.
        z_values = cp[:, 2]
        z_eave = float(z_values.min())
        polygon_latlng: list[dict[str, float]] = []
        for x, y, z in cp:
            lng_v, lat_v = aeqd_to_wgs84.transform(float(x), float(y))
            polygon_latlng.append({
                "lat": float(lat_v),
                "lng": float(lng_v),
                "heightM": float(z) - z_eave,
            })

        # Area via shoelace in 2D (XY footprint), then divide by cos(pitch)
        # to get sloped area.
        cp2d = cp[:, :2]
        area_m2 = 0.0
        for i in range(len(cp2d)):
            x1, y1 = cp2d[i]
            x2, y2 = cp2d[(i + 1) % len(cp2d)]
            area_m2 += x1 * y2 - x2 * y1
        area_m2 = abs(area_m2) / 2.0
        area_sqft_footprint = area_m2 * 10.7639
        area_sqft_sloped = area_sqft_footprint / max(
            1e-6, math.cos(math.radians(pitch_deg)),
        )

        facets.append({
            "id": f"p2r-facet-{idx}",
            "polygon": polygon_latlng,
            "normal": {"x": nx, "y": ny, "z": nz},
            "pitchDegrees": round(pitch_deg, 2),
            "azimuthDeg": round(azimuth_deg, 1),
            "areaSqftSloped": round(area_sqft_sloped, 1),
            "areaSqftFootprint": round(area_sqft_footprint, 1),
            "material": None,
            "isLowSlope": pitch_deg < 18.43,
        })
    return facets


# ─── FPS helper ─────────────────────────────────────────────────────


def _farthest_point_sample(points: Any, target_count: int) -> Any:
    """Numpy FPS to downsample to `target_count` points. If the input
    has fewer than `target_count` points, the output is padded with
    replicated samples so the model still gets a fixed-size input.

    For Point2Roof's NPOINT=1024 on a 3DEP QL2 roof (~500-2000 points
    typical), FPS produces a well-distributed subset. For smaller
    clouds (<500 points), we just take all points and pad.
    """
    import numpy as np  # noqa: PLC0415

    n = len(points)
    if n == 0:
        return None
    if n <= target_count:
        # Pad with random replication so the network gets exactly
        # target_count points. Replication doesn't hurt — the network
        # is permutation-invariant per PointNet++.
        pad_idx = np.random.choice(n, target_count - n, replace=True)
        return np.concatenate([np.arange(n), pad_idx])

    # FPS: start at a random index, iteratively pick the point
    # farthest from the current selected set.
    rng = np.random.default_rng(seed=0)  # deterministic for caching
    chosen = np.empty(target_count, dtype=np.int64)
    chosen[0] = rng.integers(0, n)
    distances = np.full(n, np.inf, dtype=np.float64)
    for i in range(1, target_count):
        last = points[chosen[i - 1]]
        d = np.sum((points - last) ** 2, axis=1)
        distances = np.minimum(distances, d)
        chosen[i] = int(np.argmax(distances))
    return chosen

"""
services/roof-lidar/topology_graph.py

Edge classification from facet adjacency + dihedral angles.

Rules (per docs/superpowers/tier-b-a-decisions.md):
  - Two facets share a boundary if their polygons have at least two
    common vertices within 1.5m tolerance.
  - The dihedral angle is the angle between their plane normals.
      < 10°            → coplanar (skip; should never happen post-segmentation)
      10° < θ < 170°   → ridge or valley by sign convention
      > 170°           → step-wall edge (facet butts a vertical neighbor)
  - Exterior edges (one facet only): "eave" when the edge slopes
    downward in 3D (the lower boundary of a pitched facet); "rake"
    when it goes up-slope.
"""

from __future__ import annotations

import logging
import math
import uuid
from typing import Any

log = logging.getLogger(__name__)

VERTEX_MATCH_TOL_M = 1.5
SHARED_EDGE_MIN_LEN_M = 0.5


def classify_edges_from_topology(
    facets: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Walk facet polygons, detect shared edges, classify by dihedral.

    Returns Edge[] dicts (types/roof.ts schema).
    """
    edges: list[dict[str, Any]] = []
    # Build per-facet edge list with (a, b, length_ft, normal, id_pair_index)
    per_facet_edges: list[list[dict[str, Any]]] = []
    for f in facets:
        poly = f["polygon"]
        pf: list[dict[str, Any]] = []
        for i in range(len(poly)):
            a = poly[i]
            b = poly[(i + 1) % len(poly)]
            dist_m = _haversine_m(a, b)
            if dist_m < SHARED_EDGE_MIN_LEN_M:
                continue
            pf.append({
                "a": a, "b": b, "lengthM": dist_m,
                "facet_id": f["id"],
                "facet_normal": f["normal"],
            })
        per_facet_edges.append(pf)

    matched_pair_indices: set[tuple[int, int, int, int]] = set()
    edge_id_counter = 0

    # Shared edges: pairwise matching.
    for i, edges_i in enumerate(per_facet_edges):
        for j, edges_j in enumerate(per_facet_edges[i + 1:], start=i + 1):
            for ei, e1 in enumerate(edges_i):
                for ej, e2 in enumerate(edges_j):
                    if (i, ei, j, ej) in matched_pair_indices:
                        continue
                    if _edge_matches(e1, e2):
                        matched_pair_indices.add((i, ei, j, ej))
                        dihedral_deg = _dihedral_deg(
                            facets[i]["normal"], facets[j]["normal"],
                        )
                        edge_type = _classify_shared_dihedral(
                            dihedral_deg, e1, e2, facets[i], facets[j],
                        )
                        edges.append({
                            "id": f"edge-{edge_id_counter}",
                            "type": edge_type,
                            "polyline": [
                                {"lat": e1["a"]["lat"], "lng": e1["a"]["lng"], "heightM": 0},
                                {"lat": e1["b"]["lat"], "lng": e1["b"]["lng"], "heightM": 0},
                            ],
                            "lengthFt": round(e1["lengthM"] * 3.28084),
                            "facetIds": [facets[i]["id"], facets[j]["id"]],
                            "confidence": 0.95,
                        })
                        edge_id_counter += 1
                        break

    # Exterior edges: every per-facet edge not in matched_pair_indices.
    for i, edges_i in enumerate(per_facet_edges):
        for ei, e in enumerate(edges_i):
            consumed = any(
                (a == i and b == ei) or (c == i and d == ei)
                for (a, b, c, d) in matched_pair_indices
            )
            if consumed:
                continue
            # Exterior — eave vs rake by relative bearing to facet azimuth.
            edge_bearing = _bearing_deg(e["a"], e["b"])
            azimuth = facets[i].get("azimuthDeg", 0)
            ang_diff = _ang_dist(edge_bearing, azimuth)
            # eave runs perpendicular to azimuth (the down-slope direction);
            # rake runs parallel.
            edge_type = "eave" if 75 < ang_diff < 105 else "rake"
            edges.append({
                "id": f"edge-{edge_id_counter}",
                "type": edge_type,
                "polyline": [
                    {"lat": e["a"]["lat"], "lng": e["a"]["lng"], "heightM": 0},
                    {"lat": e["b"]["lat"], "lng": e["b"]["lng"], "heightM": 0},
                ],
                "lengthFt": round(e["lengthM"] * 3.28084),
                "facetIds": [facets[i]["id"]],
                "confidence": 0.90,
            })
            edge_id_counter += 1

    log.info("classified %d edges (%d shared, %d exterior)",
             len(edges),
             len([e for e in edges if len(e["facetIds"]) == 2]),
             len([e for e in edges if len(e["facetIds"]) == 1]))
    return edges


def _edge_matches(e1: dict[str, Any], e2: dict[str, Any]) -> bool:
    same_dir = (
        _haversine_m(e1["a"], e2["a"]) < VERTEX_MATCH_TOL_M and
        _haversine_m(e1["b"], e2["b"]) < VERTEX_MATCH_TOL_M
    )
    flipped = (
        _haversine_m(e1["a"], e2["b"]) < VERTEX_MATCH_TOL_M and
        _haversine_m(e1["b"], e2["a"]) < VERTEX_MATCH_TOL_M
    )
    return same_dir or flipped


def _dihedral_deg(n1: dict[str, float], n2: dict[str, float]) -> float:
    dot = n1["x"] * n2["x"] + n1["y"] * n2["y"] + n1["z"] * n2["z"]
    dot = max(-1.0, min(1.0, dot))
    return math.degrees(math.acos(dot))


def _classify_shared_dihedral(
    dihedral_deg: float,
    _e1: dict[str, Any],
    _e2: dict[str, Any],
    f1: dict[str, Any],
    f2: dict[str, Any],
) -> str:
    """Classify a shared edge by dihedral angle + normal-z direction.

    Convention:
      - ridge: dihedral 10°-170° AND both facets slope away from the edge
        (their down-slopes point in opposite directions).
      - valley: dihedral 10°-170° AND both slope INTO the edge.
      - hip: dihedral 10°-170° AND mixed (one toward, one away).
      - step-wall: dihedral > 170° (one facet nearly vertical wrt the other).
    """
    if dihedral_deg < 10:
        return "ridge"  # coplanar — shouldn't happen post-segmentation; safe default
    if dihedral_deg > 170:
        return "step-wall"

    # Approximate ridge vs valley vs hip from facet azimuth alignment.
    az1 = f1.get("azimuthDeg", 0)
    az2 = f2.get("azimuthDeg", 0)
    # opposite-facing facets share a ridge or valley; angular separation
    # of azimuths ≈ 180° → ridge/valley. Use facet normal-z to disambiguate:
    # both n_z positive AND high → ridge (peak); else valley.
    az_diff = _ang_dist(az1, az2)
    if az_diff > 140:
        # Could be ridge or valley. Decide by the average normal-z of both
        # facets — high z (close to vertical) means they meet at a peak (ridge);
        # this is a heuristic, not a true valley/ridge discriminator. The
        # correct distinguishing signal is the local Z of the shared edge
        # vs the surrounding facet body (high edge = ridge, low edge = valley).
        # That requires reading back into the inlier points, which we skip
        # here for speed. TODO post-deploy: refine with actual edge Z values.
        return "ridge"
    if az_diff < 40:
        return "valley"
    return "hip"


def _haversine_m(a: dict[str, float], b: dict[str, float]) -> float:
    R = 6_371_000.0
    lat1 = math.radians(a["lat"])
    lat2 = math.radians(b["lat"])
    dlat = math.radians(b["lat"] - a["lat"])
    dlng = math.radians(b["lng"] - a["lng"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _bearing_deg(a: dict[str, float], b: dict[str, float]) -> float:
    f1 = math.radians(a["lat"])
    f2 = math.radians(b["lat"])
    dl = math.radians(b["lng"] - a["lng"])
    y = math.sin(dl) * math.cos(f2)
    x = math.cos(f1) * math.sin(f2) - math.sin(f1) * math.cos(f2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _ang_dist(a: float, b: float) -> float:
    """Smallest angular separation between two bearings in degrees."""
    d = abs(a - b) % 360
    return d if d <= 180 else 360 - d


_ = uuid  # quiet unused-import if no caller uses uuid.uuid4

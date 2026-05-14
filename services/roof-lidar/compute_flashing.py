"""
services/roof-lidar/compute_flashing.py

Tier A flashing math. Mirrors lib/roof-engine.ts:computeFlashing
on the TS side so RoofData returned by the Python service has a
fully-populated FlashingBreakdown and the TS consumer doesn't need to
re-run the math (it can if it wants — same algorithm yields same result).

Tier A's contribution over Tier C: real `wallStepLf` from dihedral-
classified step-wall edges (no oblique-inspection guess required).
"""

from __future__ import annotations

from typing import Any


def compute_flashing_breakdown(
    *,
    facets: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    objects: list[dict[str, Any]],
) -> dict[str, Any]:
    _ = facets  # reserved for downstream extensions (cricket math, etc.)

    # Per-object flashing
    chimneys = [o for o in objects if o.get("kind") == "chimney"]
    chimney_lf = sum(2 * (o["dimensionsFt"]["width"] + o["dimensionsFt"]["length"]) for o in chimneys)
    skylights = [o for o in objects if o.get("kind") == "skylight"]
    skylight_lf = sum(2 * (o["dimensionsFt"]["width"] + o["dimensionsFt"]["length"]) for o in skylights)
    dormers = [o for o in objects if o.get("kind") == "dormer"]
    dormer_step_lf = sum(2 * o["dimensionsFt"]["length"] for o in dormers)

    # Per-edge flashing
    valley_raw = sum(e["lengthFt"] for e in edges if e["type"] == "valley")
    valley_lf = valley_raw * 1.05  # 5% overlap
    eave_lf = sum(e["lengthFt"] for e in edges if e["type"] == "eave")
    rake_lf = sum(e["lengthFt"] for e in edges if e["type"] == "rake")
    drip_edge_lf = eave_lf + rake_lf

    # Tier A's wallStepLf comes directly from dihedral-classified
    # step-wall edges. headwall / apron are Tier B/A-only signals that
    # require more refined classification — for v1 we lump them all
    # under wallStepLf and let downstream consumers refine later.
    wall_step_lf = sum(e["lengthFt"] for e in edges if e["type"] == "step-wall")

    iws_sqft = round(eave_lf * 3 + valley_lf * 6)
    pipe_boot_count = sum(1 for o in objects if o.get("kind") in {"vent", "stack"})

    return {
        "chimneyLf": round(chimney_lf),
        "skylightLf": round(skylight_lf),
        "dormerStepLf": round(dormer_step_lf),
        "wallStepLf": round(wall_step_lf),
        "headwallLf": 0,  # Tier A v1 doesn't separate; future work.
        "apronLf": 0,
        "valleyLf": round(valley_lf),
        "dripEdgeLf": round(drip_edge_lf),
        "pipeBootCount": pipe_boot_count,
        "iwsSqft": iws_sqft,
    }

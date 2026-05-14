"""
services/roof-lidar/api.py

FastAPI orchestrator. Wires the per-stage pipeline modules into a single
/extract-roof endpoint that returns a RoofData-shaped payload matching
the TypeScript types/roof.ts schema.

Each stage is fail-tolerant: a stage that errors logs the failure and
emits a `diagnostics.warnings` entry, falling through to either a
degraded result or to skipping that stage's contribution. Tier A is
the highest-priority source in runRoofPipeline — degrading cleanly
beats throwing.
"""

from __future__ import annotations

import logging
import time
import traceback
from typing import Any

from fastapi import FastAPI

from coverage_check import check_3dep_coverage
from pull_lidar import fetch_lidar_for_bbox
from isolate_roof import isolate_roof_points
from segment_planes import segment_plane_regions
from build_facets import build_facets_from_planes
from topology_graph import classify_edges_from_topology
from detect_objects import detect_roof_objects
from compute_flashing import compute_flashing_breakdown
from freshness_check import compare_lidar_vs_imagery

log = logging.getLogger("roof-lidar")
logging.basicConfig(level=logging.INFO)


def extract_roof_pipeline(
    request_data: dict[str, Any],
    cache_root: str | None = None,
) -> dict[str, Any]:
    """Core pipeline. Pure function — no Modal-specific code so it can be
    called from a local FastAPI dev server too."""
    t0 = time.time()

    lat = float(request_data.get("lat") or 0)
    lng = float(request_data.get("lng") or 0)
    address = request_data.get("address") or ""
    imagery_date = request_data.get("imageryDate")
    parcel_polygon = request_data.get("parcelPolygon")  # optional list of {lat,lng}

    warnings: list[str] = []
    attempts: list[dict[str, str]] = []
    needs_review: list[dict[str, str]] = []

    if not lat or not lng:
        return _degraded_response(
            address, lat, lng,
            warnings=["lat/lng required"],
            latency_ms=int((time.time() - t0) * 1000),
        )

    # ---- Stage 1: coverage check ------------------------------------------
    try:
        coverage = check_3dep_coverage(lat=lat, lng=lng)
        attempts.append({"stage": "coverage_check", "outcome": "succeeded"})
    except Exception as err:
        log.exception("coverage_check failed")
        attempts.append({
            "stage": "coverage_check", "outcome": "failed-error", "reason": str(err),
        })
        return _degraded_response(
            address, lat, lng,
            warnings=["3DEP coverage manifest unreachable"],
            attempts=attempts,
            latency_ms=int((time.time() - t0) * 1000),
        )

    if not coverage.get("covered"):
        return _degraded_response(
            address, lat, lng,
            warnings=["No 3DEP LiDAR coverage at this address"],
            attempts=attempts,
            coverage=coverage,
            latency_ms=int((time.time() - t0) * 1000),
        )

    # ---- Stage 2: pull LiDAR (cached 24h per bbox) ------------------------
    try:
        las_points = fetch_lidar_for_bbox(
            lat=lat, lng=lng,
            tile_ids=coverage.get("tile_ids") or [],
            cache_root=cache_root,
        )
        attempts.append({"stage": "pull_lidar", "outcome": "succeeded"})
    except Exception as err:
        log.exception("pull_lidar failed")
        attempts.append({
            "stage": "pull_lidar", "outcome": "failed-error", "reason": str(err),
        })
        return _degraded_response(
            address, lat, lng,
            warnings=[f"Failed to fetch 3DEP tiles: {err}"],
            attempts=attempts,
            latency_ms=int((time.time() - t0) * 1000),
        )

    # ---- Stage 3: isolate roof points -------------------------------------
    try:
        roof_pts = isolate_roof_points(
            las_points=las_points,
            lat=lat, lng=lng,
            parcel_polygon=parcel_polygon,
        )
        attempts.append({"stage": "isolate_roof", "outcome": "succeeded"})
    except Exception as err:
        log.exception("isolate_roof failed")
        attempts.append({
            "stage": "isolate_roof", "outcome": "failed-error", "reason": str(err),
        })
        return _degraded_response(
            address, lat, lng,
            warnings=[f"Failed to isolate roof: {err}"],
            attempts=attempts,
            latency_ms=int((time.time() - t0) * 1000),
        )

    # ---- Stage 4: plane segmentation --------------------------------------
    try:
        planes = segment_plane_regions(roof_pts)
        attempts.append({"stage": "segment_planes", "outcome": "succeeded"})
    except Exception as err:
        log.exception("segment_planes failed")
        attempts.append({
            "stage": "segment_planes", "outcome": "failed-error", "reason": str(err),
        })
        planes = []
        warnings.append(f"Plane segmentation failed: {err}")

    if not planes:
        return _degraded_response(
            address, lat, lng,
            warnings=warnings + ["No roof planes detected"],
            attempts=attempts,
            latency_ms=int((time.time() - t0) * 1000),
        )

    # ---- Stage 5: build facets from plane inliers -------------------------
    try:
        facets = build_facets_from_planes(planes, center_lat=lat, center_lng=lng)
        attempts.append({"stage": "build_facets", "outcome": "succeeded"})
    except Exception as err:
        log.exception("build_facets failed")
        attempts.append({
            "stage": "build_facets", "outcome": "failed-error", "reason": str(err),
        })
        return _degraded_response(
            address, lat, lng,
            warnings=warnings + [f"Facet build failed: {err}"],
            attempts=attempts,
            latency_ms=int((time.time() - t0) * 1000),
        )

    # ---- Stage 6: edge topology + classification --------------------------
    try:
        edges = classify_edges_from_topology(facets)
        attempts.append({"stage": "topology_graph", "outcome": "succeeded"})
    except Exception as err:
        log.exception("topology_graph failed")
        attempts.append({
            "stage": "topology_graph", "outcome": "failed-error", "reason": str(err),
        })
        edges = []
        warnings.append(f"Edge classification failed: {err}")

    # ---- Stage 7: object detection (YOLO on ortho) ------------------------
    try:
        objects = detect_roof_objects(
            roof_pts=roof_pts, facets=facets, center_lat=lat, center_lng=lng,
        )
        attempts.append({"stage": "detect_objects", "outcome": "succeeded"})
    except Exception as err:
        log.exception("detect_objects failed")
        attempts.append({
            "stage": "detect_objects", "outcome": "failed-error", "reason": str(err),
        })
        objects = []
        warnings.append(f"Object detection failed: {err}")

    # ---- Stage 8: flashing breakdown --------------------------------------
    try:
        flashing = compute_flashing_breakdown(facets=facets, edges=edges, objects=objects)
        attempts.append({"stage": "compute_flashing", "outcome": "succeeded"})
    except Exception as err:
        log.exception("compute_flashing failed")
        attempts.append({
            "stage": "compute_flashing", "outcome": "failed-error", "reason": str(err),
        })
        flashing = _zero_flashing()

    # ---- Stage 9: freshness check ----------------------------------------
    try:
        freshness = compare_lidar_vs_imagery(
            lidar_capture_date=coverage.get("capture_date"),
            imagery_date=imagery_date,
        )
        if freshness.get("flag"):
            warnings.append(freshness["message"])
        attempts.append({"stage": "freshness_check", "outcome": "succeeded"})
    except Exception as err:
        log.exception("freshness_check failed")
        attempts.append({
            "stage": "freshness_check", "outcome": "failed-error", "reason": str(err),
        })
        freshness = {"flag": False, "message": ""}

    # ---- Assemble RoofData ------------------------------------------------
    confidence = 0.95
    if freshness.get("flag"):
        confidence = 0.75
    coverage_pct = float(coverage.get("coverage_pct") or 1.0)
    if coverage_pct < 0.70:
        confidence = min(confidence, 0.50)
        warnings.append(
            f"3DEP coverage only {int(coverage_pct * 100)}% of parcel — "
            "results may be partial. Falling back to other sources is recommended.",
        )

    totals = _compute_totals(facets, edges, objects)
    latency_ms = int((time.time() - t0) * 1000)

    return {
        "roofData": {
            "address": {
                "formatted": address, "lat": lat, "lng": lng,
            },
            "source": "tier-a-lidar",
            "refinements": [],
            "confidence": confidence,
            "imageryDate": imagery_date,
            "ageYearsEstimate": None,
            "ageBucket": None,
            "facets": facets,
            "edges": edges,
            "objects": objects,
            "flashing": flashing,
            "totals": totals,
            "diagnostics": {
                "attempts": attempts,
                "warnings": warnings,
                "needsReview": needs_review,
            },
        },
        "lidarCaptureDate": coverage.get("capture_date"),
        "latencyMs": latency_ms,
        "freshness": freshness,
    }


def _zero_flashing() -> dict[str, Any]:
    return {
        "chimneyLf": 0, "skylightLf": 0, "dormerStepLf": 0, "wallStepLf": 0,
        "headwallLf": 0, "apronLf": 0, "valleyLf": 0, "dripEdgeLf": 0,
        "pipeBootCount": 0, "iwsSqft": 0,
    }


def _compute_totals(
    facets: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    objects: list[dict[str, Any]],
) -> dict[str, Any]:
    total_sloped = sum(f.get("areaSqftSloped", 0) for f in facets)
    total_footprint = sum(f.get("areaSqftFootprint", 0) for f in facets)
    total_squares = round((total_sloped / 100.0) * 3) / 3 if total_sloped else 0
    avg_pitch = (
        sum(f.get("pitchDegrees", 0) * f.get("areaSqftSloped", 0) for f in facets)
        / total_sloped if total_sloped else 0
    )
    # Tier A inherits Tier C's complexity buckets + suggested waste %.
    facet_count = len(facets)
    dormers = sum(1 for o in objects if o.get("kind") == "dormer")
    valley_lf = sum(e.get("lengthFt", 0) for e in edges if e.get("type") == "valley")
    if facet_count >= 6 or dormers >= 3 or valley_lf >= 60:
        complexity, waste_pct = "complex", 14
    elif facet_count >= 3 or dormers >= 1 or valley_lf >= 20:
        complexity, waste_pct = "moderate", 11
    else:
        complexity, waste_pct = "simple", 7

    # Predominant material — Tier A doesn't classify; let the consumer pick.
    return {
        "facetsCount": facet_count,
        "edgesCount": len(edges),
        "objectsCount": len(objects),
        "totalRoofAreaSqft": round(total_sloped),
        "totalFootprintSqft": round(total_footprint),
        "totalSquares": total_squares,
        "averagePitchDegrees": round(avg_pitch * 10) / 10,
        "wastePct": waste_pct,
        "complexity": complexity,
        "predominantMaterial": None,
    }


def _degraded_response(
    address: str, lat: float, lng: float, *,
    warnings: list[str],
    attempts: list[dict[str, str]] | None = None,
    coverage: dict[str, Any] | None = None,
    latency_ms: int,
) -> dict[str, Any]:
    """Returned when the pipeline can't produce a useful RoofData. The
    TS adapter unpacks `roofData.source === "none"` → null, so the pipeline
    falls through to Tier B/C."""
    return {
        "roofData": {
            "address": {"formatted": address, "lat": lat, "lng": lng},
            "source": "none",
            "refinements": [],
            "confidence": 0,
            "imageryDate": None,
            "ageYearsEstimate": None,
            "ageBucket": None,
            "facets": [],
            "edges": [],
            "objects": [],
            "flashing": _zero_flashing(),
            "totals": {
                "facetsCount": 0, "edgesCount": 0, "objectsCount": 0,
                "totalRoofAreaSqft": 0, "totalFootprintSqft": 0, "totalSquares": 0,
                "averagePitchDegrees": 0, "wastePct": 11, "complexity": "moderate",
                "predominantMaterial": None,
            },
            "diagnostics": {
                "attempts": attempts or [],
                "warnings": warnings,
                "needsReview": [],
            },
        },
        "lidarCaptureDate": (coverage or {}).get("capture_date"),
        "latencyMs": latency_ms,
        "freshness": {"flag": False, "message": ""},
    }


# ---------------------------------------------------------------------------
# Local-dev FastAPI app (for `python modal_app.py` w/o Modal).
# ---------------------------------------------------------------------------

def build_local_app() -> FastAPI:
    app = FastAPI(title="voxaris-roof-lidar (local)")

    @app.post("/extract-roof")
    def _extract(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            return extract_roof_pipeline(payload, cache_root="/tmp/voxaris-lidar-cache")
        except Exception as err:  # noqa: BLE001
            log.exception("local extract_roof failed")
            return {
                "error": "pipeline_error",
                "message": str(err),
                "traceback": traceback.format_exc(),
            }

    @app.get("/health")
    def _health() -> dict[str, Any]:
        return {"ok": True, "mode": "local"}

    return app

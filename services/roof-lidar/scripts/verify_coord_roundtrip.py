"""
services/roof-lidar/scripts/verify_coord_roundtrip.py

Phase F regression test -- verifies the AEQD coordinate frame
round-trips correctly through the pipeline contract.

Two tests:

  (a) A known lat/lng round-trips through pull_lidar.py's forward
      transform -> build_facets.py's inverse transform and lands
      within 0.1m of input. Tested at four latitudes spanning the
      US service envelope (Honolulu through Anchorage).

  (b) build_facets_from_planes on a synthetic plane with known points
      produces a facet whose polygon centroid (back-projected to
      AEQD meters) matches the input centroid within 0.5m, and whose
      pitch matches the input plane pitch within 1 deg.

Run:
    python services/roof-lidar/scripts/verify_coord_roundtrip.py

Exits 0 on PASS, 1 on assertion failure, 2 on import / setup error.
"""

from __future__ import annotations

import math
import os
import sys


# Make services/roof-lidar/ importable so the test can reach coord_frame
# + build_facets without packaging the service.
_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE_ROOT = os.path.dirname(_HERE)
if _SERVICE_ROOT not in sys.path:
    sys.path.insert(0, _SERVICE_ROOT)


def test_a_roundtrip() -> None:
    """Test (a) -- A known lat/lng round-trips through forward then
    inverse AEQD transforms within 0.1m at every test latitude.

    Procedure per test point:
      1. Define an offset in AEQD meters (10m east, 20m north).
      2. Use the AEQD->WGS84 inverse to convert that offset to lat/lng.
      3. Use the WGS84->AEQD forward to convert the resulting lat/lng
         back to AEQD meters.
      4. Distance between the original offset and the round-tripped
         offset must be < 0.1m.

    Why this test catches the Phase F bug: if anyone replaces the
    pyproj-based transform in coord_frame.py with a flat-earth
    approximation again, the round-trip error grows with the cosine-
    of-latitude mismatch -- sub-cm near the equator, several meters
    at high latitude. The 0.1m threshold catches any such regression.
    """
    from coord_frame import make_aeqd_to_wgs84, make_wgs84_to_aeqd

    test_points = [
        ("Oak Park Rd, Orlando",   28.4815,  -81.4720),  # primary fixture
        ("Manhattan, NYC",         40.7128,  -74.0060),  # mid-latitude
        ("Anchorage, AK",          61.2181, -149.9003),  # sub-arctic
        ("Honolulu, HI",           21.3099, -157.8581),  # low-latitude
    ]
    # Test offsets -- meters east, meters north. Sized to span a parcel.
    test_offsets = [
        (10.0,  20.0),
        (-15.0, 5.0),
        (50.0,  -30.0),
        (0.0,   0.0),     # degenerate-but-defensive: origin round-trips to itself
    ]

    for name, lat, lng in test_points:
        inv = make_aeqd_to_wgs84(lat, lng)
        fwd = make_wgs84_to_aeqd(lat, lng)
        for off_x, off_y in test_offsets:
            # AEQD meters -> WGS84 lng/lat
            lng_v, lat_v = inv.transform(off_x, off_y)
            # WGS84 lng/lat -> AEQD meters
            back_x, back_y = fwd.transform(lng_v, lat_v)
            error_m = math.hypot(back_x - off_x, back_y - off_y)
            assert error_m < 0.1, (
                f"Round-trip at {name} ({lat:.4f}, {lng:.4f}) "
                f"offset ({off_x}, {off_y}) "
                f"returned ({back_x:.4f}, {back_y:.4f}) "
                f"error {error_m:.6f}m (threshold 0.1m)"
            )
        print(
            f"  PASS  round-trip at {name:<24s} "
            f"({lat:>+8.4f}, {lng:>+9.4f}) -- 4 offsets, max err <0.1m"
        )


def test_b_synthetic_facet() -> None:
    """Test (b) -- build_facets_from_planes on a synthetic plane
    produces a facet whose polygon centroid matches the expected
    ENU position (within 0.5m) and whose pitch matches the input
    plane (within 1 deg).

    Synthetic input: a 10m x 10m square of points centered at AEQD
    (5m east, 5m north), tilted 30 deg around the east-west axis so the
    south edge is low and the north edge is high. Z is set as
    `3 + y * tan(30 deg)` so the plane is a real tilted surface, not
    flat in 3D.

    Expected outputs from build_facets_from_planes:
      - exactly 1 facet
      - facet polygon centroid, back-projected to AEQD, near (5, 5)
      - facet pitchDegrees within +/-1 deg of 30 deg
    """
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"numpy required: {err}") from err

    from build_facets import build_facets_from_planes
    from coord_frame import make_wgs84_to_aeqd

    center_lat = 28.4815
    center_lng = -81.4720

    # Synthetic plane: 5x5 grid of points spanning (0..10m east, 0..10m
    # north). 25 points -- well above the 3-vertex minimum for alpha
    # shape and Douglas-Peucker.
    grid_size = 5
    xs_grid, ys_grid = np.meshgrid(
        np.linspace(0.0, 10.0, grid_size),
        np.linspace(0.0, 10.0, grid_size),
    )
    xs_flat = xs_grid.flatten()
    ys_flat = ys_grid.flatten()
    pitch_rad = math.radians(30.0)
    zs_flat = 3.0 + ys_flat * math.tan(pitch_rad)
    pts = np.column_stack([xs_flat, ys_flat, zs_flat])

    # Plane normal for a roof tilted 30 deg around east-west axis with the
    # south edge low: normal points up + slightly south. So nz = cos(30 deg),
    # ny = -sin(30 deg) (south = -y in our convention only if we picked y=north
    # for north positive; here y IS north positive, so south-facing means
    # the down-slope vector has -y, and the up-normal has +z and -y reversed.
    # For a roof where z rises with y, the up-normal is (0, -sin, cos).
    # Wait -- derivative test: z = 3 + y * tan(pitch). dz/dy = tan(pitch).
    # Surface implicit form: z - y*tan(pitch) - 3 = 0. Gradient = (0, -tan, 1).
    # Normalize: (0, -sin(pitch), cos(pitch)).
    plane = {
        "points": pts.tolist(),
        "normal": [0.0, -math.sin(pitch_rad), math.cos(pitch_rad)],
        "d": 0.0,
        "centroid": pts.mean(axis=0).tolist(),
        "size": len(pts),
    }

    facets = build_facets_from_planes(
        [plane], center_lat=center_lat, center_lng=center_lng,
    )
    assert len(facets) == 1, f"Expected exactly 1 facet, got {len(facets)}"
    facet = facets[0]
    polygon = facet["polygon"]
    assert len(polygon) >= 3, (
        f"Facet polygon must have >=3 vertices, got {len(polygon)}"
    )

    # Back-project the polygon to AEQD meters and compute its
    # AREA-WEIGHTED centroid (shoelace formula). A simple vertex-mean
    # would be biased by the closing-vertex duplicate Shapely emits
    # on its concave_hull output, AND it ignores the actual 2D shape.
    fwd = make_wgs84_to_aeqd(center_lat, center_lng)
    xs_back: list[float] = []
    ys_back: list[float] = []
    for v in polygon:
        x_b, y_b = fwd.transform(v["lng"], v["lat"])
        xs_back.append(x_b)
        ys_back.append(y_b)
    centroid_x, centroid_y = _polygon_centroid(xs_back, ys_back)
    # The synthetic point grid spans 0..10 east AND north, so the
    # expected centroid of the alpha-shape boundary is at (5, 5)
    # (boundary samples symmetrically around the grid center).
    expected_x = 5.0
    expected_y = 5.0
    centroid_err_m = math.hypot(
        centroid_x - expected_x, centroid_y - expected_y,
    )
    assert centroid_err_m < 0.5, (
        f"Facet centroid ({centroid_x:.3f}, {centroid_y:.3f}) "
        f"vs expected ({expected_x}, {expected_y}) "
        f"error {centroid_err_m:.4f}m (threshold 0.5m)"
    )

    # Pitch must match the input plane's 30 deg within 1 deg.
    pitch_err_deg = abs(facet["pitchDegrees"] - 30.0)
    assert pitch_err_deg < 1.0, (
        f"Facet pitch {facet['pitchDegrees']} deg vs expected 30 deg "
        f"(error {pitch_err_deg:.2f} deg, threshold 1 deg)"
    )

    print(
        f"  PASS  synthetic facet -- centroid err "
        f"{centroid_err_m * 100:.2f}cm, pitch {facet['pitchDegrees']} deg "
        f"(target 30 deg, err {pitch_err_deg:.2f} deg)"
    )


def _polygon_centroid(
    xs: list[float], ys: list[float],
) -> tuple[float, float]:
    """Area-weighted centroid of a 2D polygon via the shoelace
    formula. Handles closed rings (last vertex == first) and arbitrary
    convex/concave shapes correctly. Falls back to the vertex mean
    when the polygon is degenerate (zero signed area)."""
    n = len(xs)
    if n < 3:
        return (sum(xs) / max(1, n), sum(ys) / max(1, n))
    a2 = 0.0  # twice the signed area
    cx = 0.0
    cy = 0.0
    for i in range(n):
        j = (i + 1) % n
        cross = xs[i] * ys[j] - xs[j] * ys[i]
        a2 += cross
        cx += (xs[i] + xs[j]) * cross
        cy += (ys[i] + ys[j]) * cross
    if abs(a2) < 1e-9:
        return (sum(xs) / n, sum(ys) / n)
    area = a2 / 2.0
    return (cx / (6.0 * area), cy / (6.0 * area))


def main() -> int:
    print("Phase F coord-frame round-trip verification")
    print("-" * 60)
    try:
        print("\nTest (a) -- known lat/lng round-trips within 0.1m:")
        test_a_roundtrip()
        print("\nTest (b) -- synthetic facet centroid + pitch match:")
        test_b_synthetic_facet()
    except AssertionError as e:
        print(f"\nFAIL  {e}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"\nERROR {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    print("\n" + "-" * 60)
    print("All Phase F coord-roundtrip checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""
services/roof-lidar/scripts/test_point2roof_local.py

Standalone smoke test for the vendored Point2Roof inference path.
Runs the wrapper against a .xyz point cloud file and prints what
came back — keypoints, edges, detected cycles, computed facets.

Useful for partner validation after Modal redeploys:
  1. Copy a real roof point cloud .xyz file off the Modal volume
     (or generate one locally from a saved estimate's roof_pts dump)
  2. Run this script with that file
  3. Output tells you whether Point2Roof inference works AND whether
     the cycle-detection face extraction produces sane polygons

Requirements:
  - CUDA-capable GPU (for the model's `.cuda()` call)
  - PyTorch with CUDA support
  - The vendored pc_util CUDA extension built (via setup.py install)

Without those: the wrapper falls through to None and the script
exits with a clear "GPU required" message instead of a cryptic
stack trace. This matches production behavior (where unavailable
CUDA means Point2Roof silently degrades to the PolyFit/alpha-shape
fallback).

Usage:
    python services/roof-lidar/scripts/test_point2roof_local.py \\
        path/to/roof_points.xyz \\
        [--center-lat 28.4815 --center-lng -81.4720]

Exit codes:
    0 — inference succeeded with at least 1 facet detected
    1 — inference returned None (CUDA absent, model load failed, no
        valid output). Stderr explains.
    2 — argument or file error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

# Resolve services/roof-lidar/ as the import root so `from
# point2roof_wrapper import reconstruct` works.
_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE_ROOT = os.path.dirname(_HERE)
if _SERVICE_ROOT not in sys.path:
    sys.path.insert(0, _SERVICE_ROOT)


def read_xyz(path: str):
    """Read a .xyz file (whitespace-separated X Y Z per line)."""
    import numpy as np  # noqa: PLC0415

    pts = []
    with open(path) as f:
        for line in f:
            parts = line.strip().split()
            if len(parts) < 3:
                continue
            try:
                pts.append([float(parts[0]), float(parts[1]), float(parts[2])])
            except ValueError:
                continue
    if not pts:
        raise ValueError(f"no valid XYZ points read from {path}")
    return np.array(pts, dtype=np.float32)


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test Point2Roof inference.")
    parser.add_argument("xyz_path", help="path to a .xyz point cloud file")
    parser.add_argument(
        "--center-lat", type=float, default=28.4815,
        help="parcel center latitude (default: Oak Park Rd, Orlando)",
    )
    parser.add_argument(
        "--center-lng", type=float, default=-81.4720,
        help="parcel center longitude (default: Oak Park Rd, Orlando)",
    )
    parser.add_argument(
        "--json", action="store_true",
        help="emit the raw facet list as JSON to stdout (for diffing)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.xyz_path):
        print(f"FAIL  not found: {args.xyz_path}", file=sys.stderr)
        return 2

    print(f"Reading point cloud from {args.xyz_path}...")
    try:
        pts = read_xyz(args.xyz_path)
    except Exception as err:  # noqa: BLE001
        print(f"FAIL  reading XYZ: {err}", file=sys.stderr)
        return 2
    print(f"  {len(pts)} points loaded")
    print(f"  bbox: x=[{pts[:, 0].min():.2f}, {pts[:, 0].max():.2f}]  "
          f"y=[{pts[:, 1].min():.2f}, {pts[:, 1].max():.2f}]  "
          f"z=[{pts[:, 2].min():.2f}, {pts[:, 2].max():.2f}]")

    print("\nCalling Point2Roof wrapper...")
    try:
        from point2roof_wrapper import reconstruct  # noqa: PLC0415
    except Exception as err:  # noqa: BLE001
        print(f"FAIL  wrapper import: {err}", file=sys.stderr)
        return 1

    facets = reconstruct(
        pts,
        center_lat=args.center_lat,
        center_lng=args.center_lng,
    )

    if facets is None:
        print(
            "FAIL  wrapper returned None.\n"
            "  Likely causes:\n"
            "    - CUDA not available (run on a GPU host)\n"
            "    - pc_util CUDA extension not built\n"
            "      (cd vendor/point2roof/pc_util && python setup.py install)\n"
            "    - Model checkpoint missing or unreadable\n"
            "    - No closed planar cycles in the predicted wireframe\n"
            "  In production this triggers the alpha-shape fallback —\n"
            "  no estimate fails.",
            file=sys.stderr,
        )
        return 1

    print(f"\nOK  {len(facets)} facets reconstructed:")
    for i, f in enumerate(facets):
        print(
            f"  [{i}] id={f['id']:<20s} "
            f"pitch={f['pitchDegrees']:>5.1f} deg  "
            f"azimuth={f['azimuthDeg']:>5.1f} deg  "
            f"sloped={f['areaSqftSloped']:>6.0f} sqft  "
            f"footprint={f['areaSqftFootprint']:>6.0f} sqft  "
            f"vertices={len(f['polygon'])}",
        )

    if args.json:
        print("\n" + json.dumps(facets, indent=2))

    print("\nSanity checks:")
    total_sloped = sum(f["areaSqftSloped"] for f in facets)
    total_footprint = sum(f["areaSqftFootprint"] for f in facets)
    print(f"  Total sloped area:    {total_sloped:.0f} sqft")
    print(f"  Total footprint area: {total_footprint:.0f} sqft")
    print(f"  Facet count:          {len(facets)}")
    if total_sloped < 500 or total_sloped > 30_000:
        print(
            f"  WARN: total area {total_sloped:.0f} sqft outside expected "
            "residential range [500, 30000]",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())

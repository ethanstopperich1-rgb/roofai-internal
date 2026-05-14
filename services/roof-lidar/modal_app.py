"""
services/roof-lidar/modal_app.py

Modal stub that exposes the FastAPI roof-lidar service as a web endpoint.

Deploy:
    modal deploy services/roof-lidar/modal_app.py

The URL is emitted on a successful deploy — set it as `LIDAR_SERVICE_URL`
in the Next.js app's environment (.env.local / Vercel project env).

Build cost: ~3-5 min cold image build (PDAL native libs + open3d + torch).
Runtime cost: ~$0.05-0.20 per /extract-roof call depending on parcel size.
"""

from __future__ import annotations

import os

import modal

# ----------------------------------------------------------------------------
# Image: Python 3.12 + native deps for Open3D / YOLO.
# Originally listed `libpdal-dev` + `pdal`, but Debian Bookworm dropped those
# from the main repo (would need `bookworm-backports`) AND nothing in this
# service actually imports `pdal` — point clouds are read by laspy (pure
# Python + Rust LAZ via lazrs) and processed by open3d. Removed PDAL and
# stripped GDAL/PROJ system packages too: pyproj and shapely ship with
# their own vendored PROJ / GEOS in their pip wheels, so the system libs
# were unused dead weight that slowed the build by ~2 min.
# ----------------------------------------------------------------------------

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        # Open3D viewport deps — open3d's C++ binaries link against these
        # even when we use it headless for plane segmentation only.
        "libgl1",
        "libglib2.0-0",
        "libsm6",
        "libxext6",
        "libxrender-dev",
        # Image manipulation for ortho composites + YOLO input
        "libjpeg-dev",
        "libpng-dev",
    )
    .pip_install_from_requirements("requirements.txt")
    # Modal 1.0+ renamed copy_local_dir → add_local_dir. The new method
    # defaults to runtime mount (faster iteration); we pass copy=True
    # so the .py files land in the image layer and subsequent FastAPI
    # imports / @app.function decorators see them at build time.
    .add_local_dir(".", "/app", copy=True)
    .workdir("/app")
)

app = modal.App("voxaris-roof-lidar")

# Volume for the 24h raw-LiDAR cache (parcel bbox → LAZ tiles). Modal volumes
# are persistent across function invocations.
lidar_cache_volume = modal.Volume.from_name(
    "voxaris-lidar-cache", create_if_missing=True
)

VOLUME_PATH = "/cache/lidar"


@app.function(
    image=image,
    volumes={VOLUME_PATH: lidar_cache_volume},
    timeout=300,
    # Memory headroom for point clouds — typical residential parcel @ 2pt/m²
    # is ~30k points, but commercial / large parcels can hit 500k+.
    memory=4096,
    # CPU-only — YOLO inference is small enough to not need GPU for the
    # n-model on 1280x1280 ortho renders.
    cpu=2.0,
)
@modal.fastapi_endpoint(method="POST")
def extract_roof(request_data: dict) -> dict:
    """
    POST /extract-roof
    Body:  { lat, lng, address, parcelPolygon?, imageryDate? }
    Resp:  { roofData: RoofData, lidarCaptureDate, latencyMs, freshness }

    Loaded inside the function so Modal's cold-import only touches the
    FastAPI app definition, not the heavy LiDAR/Open3D/PyTorch imports
    on every cold start of the Modal control plane.
    """
    from api import extract_roof_pipeline  # noqa: PLC0415

    return extract_roof_pipeline(request_data, cache_root=VOLUME_PATH)


@app.function(image=image, timeout=15, cpu=0.25)
@modal.fastapi_endpoint(method="GET")
def health() -> dict:
    """Liveness check used by the Next.js side to skip-or-call decision."""
    return {
        "ok": True,
        "service": "voxaris-roof-lidar",
        "modal_env": os.environ.get("MODAL_ENVIRONMENT", "unknown"),
    }


if __name__ == "__main__":
    # `python modal_app.py` runs the FastAPI app locally for dev w/o Modal.
    import uvicorn
    from api import build_local_app  # noqa: PLC0415

    uvicorn.run(build_local_app(), host="0.0.0.0", port=8000)

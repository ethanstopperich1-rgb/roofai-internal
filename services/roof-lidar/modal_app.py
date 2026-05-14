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
# Image: micromamba (conda-forge) Python 3.12 + native PDAL for COPC/EPT
# spatial range reads. Switched from debian_slim to micromamba because PDAL
# needs the native C++ library + GDAL/PROJ/etc. — pip alone can't install
# these on Debian Bookworm (libpdal-dev is bookworm-backports only). Conda-
# forge bundles everything cleanly.
#
# WHY PDAL: USGS publishes 3DEP data as Entwine Point Tile (EPT) sets
# indexed in S3. PDAL's readers.ept supports bbox-bounded reads — we
# fetch ~1-2 MB of points for a 60m parcel out of a 50 GB project,
# instead of downloading 360MB LAZ tiles. Cold path goes from 6 min
# → 30 sec.
# ----------------------------------------------------------------------------

image = (
    # PDAL's official Docker image — known-good GDAL/PROJ/SQLite combo.
    # micromamba kept producing sqlite version conflicts because the
    # conda solver chose libgdal compiled against a newer sqlite than
    # the one it pulled in. This image bakes a complete working stack.
    modal.Image.from_registry("pdal/pdal:latest", add_python="3.12")
    .apt_install(
        # Open3D viewport deps
        "libgl1",
        "libglib2.0-0",
        "libsm6",
        "libxext6",
        "libxrender-dev",
        "libjpeg-dev",
        "libpng-dev",
    )
    # PDAL Python bindings — package is `pdal` on PyPI (different from
    # conda's `python-pdal`). The official pdal/pdal Docker image has
    # the native libs in /usr/local; this binds them to Python.
    .pip_install("pdal>=3.5")
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
    timeout=900,  # 15 min — covers cold 360MB LAZ download + processing
    # Memory headroom for point clouds. Empirical: 1 tile @ 450k raw
    # points = ~1.2GB after laspy.read + pyproj reproject + open3d
    # PointCloud copy. Plane segmentation on 200k filtered points peaks
    # at ~3.5GB total. The previous 4GB ceiling SIGKILL'd consistently.
    # 16GB gives 4x headroom for commercial parcels (500k+ points).
    memory=16384,
    # CPU-only — YOLO inference is small enough to not need GPU for the
    # n-model on 1280x1280 ortho renders.
    cpu=2.0,
    # No automatic retries on failure. Tier A is expected to fall
    # through to Tier C when it can't measure; retrying an OOM 10x
    # just burns money and never recovers. The TS adapter handles
    # failure correctly (returns null, pipeline falls through).
    retries=0,
)
def run_extract(request_data: dict) -> dict:
    """Long-running heavy function. Runs the full Tier A pipeline:
    coverage check → LAZ pull (200-500MB tiles, ~2-4 min cold) →
    isolate roof → segment planes → build facets → topology →
    YOLO detect → compute flashing.

    Invoked via `run_extract.spawn(...)` from the public-facing
    submit/result endpoints below — never directly via HTTP because
    Modal's HTTP gateway caps sync responses at 150s and a cold-cache
    Tier A call routinely needs 300-500s.
    """
    from api import extract_roof_pipeline  # noqa: PLC0415

    return extract_roof_pipeline(request_data, cache_root=VOLUME_PATH)


@app.function(image=image, timeout=30, cpu=0.25)
@modal.fastapi_endpoint(method="POST")
def submit(request_data: dict) -> dict:
    """POST /submit — spawns the Tier A pipeline as a background
    function call and returns {call_id} immediately. Pair with GET
    /result?call_id=... below to retrieve the result.

    Body:  { lat, lng, address, parcelPolygon?, imageryDate? }
    Resp:  { call_id: string }
    """
    call = run_extract.spawn(request_data)
    return {"call_id": call.object_id}


@app.function(image=image, timeout=30, cpu=0.25)
@modal.fastapi_endpoint(method="GET")
def result(call_id: str) -> dict:
    """GET /result?call_id=... — non-blocking poll. Returns:
      { status: "pending" }                            (HTTP 202-equivalent in body)
      { status: "done", result: { roofData, ... } }    (HTTP 200)
      { status: "error", error: string }               (HTTP 200, app-level error)
    """
    fc = modal.FunctionCall.from_id(call_id)
    try:
        result = fc.get(timeout=0)
        return {"status": "done", "result": result}
    except TimeoutError:
        return {"status": "pending"}
    except modal.exception.OutputExpiredError:
        return {"status": "error", "error": "output_expired"}
    except Exception as err:  # noqa: BLE001
        return {"status": "error", "error": f"{type(err).__name__}: {err}"}


@app.function(
    image=image,
    volumes={VOLUME_PATH: lidar_cache_volume},
    timeout=900,
    memory=4096,
    cpu=2.0,
)
@modal.fastapi_endpoint(method="POST")
def extract_roof(request_data: dict) -> dict:
    """LEGACY synchronous endpoint — kept for backwards compatibility
    with older TS adapters that haven't switched to submit/poll. New
    callers should use POST /submit + GET /result.

    This will 303-redirect after 150s of processing per Modal's HTTP
    timeout; the TS adapter sees that as a failure and falls through
    to Tier C. Not ideal but it's the documented async fallback.
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

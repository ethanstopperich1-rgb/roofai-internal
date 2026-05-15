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
        # Phase 2 — CGAL + dependencies for the PolyFit reconstruction
        # SECONDARY tier. Point2Roof (deep-learning, MIT) is now the
        # primary; CGAL kept as backup for when Point2Roof returns no
        # confident output. Image size +~150 MB.
        #
        # NOTE: coinor-libscip-dev was removed from Ubuntu Noble (24.04)
        # — the pdal/pdal:latest image is on Noble. SCIP is the MILP
        # solver CGAL PolyFit uses for face-selection. Without it,
        # CGAL PolyFit silently falls through to alpha-shape, which is
        # already the tier C fallback. Point2Roof (primary) is unaffected.
        # TODO(post-deploy): build SCIP from source or wire a Noble PPA
        # if we want CGAL PolyFit as a real secondary tier.
        "libcgal-dev",
        "libgmp-dev",
        "libmpfr-dev",
        "libeigen3-dev",
        "libboost-dev",
        # Point2Roof — needs build tools to compile the vendored
        # pc_util C++/CUDA extension (custom ops for ball_query, FPS,
        # group_points, interpolate, sampling, cluster). nvcc comes
        # from the CUDA toolkit installed alongside torch.
        "build-essential",
        "ninja-build",
    )
    # PDAL Python bindings — package is `pdal` on PyPI (different from
    # conda's `python-pdal`). The official pdal/pdal Docker image has
    # the native libs in /usr/local; this binds them to Python.
    .pip_install("pdal>=3.5")
    .pip_install_from_requirements("requirements.txt")
    # Point2Roof — install PyTorch with CUDA support BEFORE building
    # pc_util so the extension build sees the right torch + nvcc paths.
    # The base pdal/pdal image doesn't ship CUDA dev tools by default,
    # but torch's wheels include the runtime; for nvcc we pull the
    # cuda-toolkit. Pinning torch to a version known to build cleanly
    # with the pc_util sources from the vendored Point2Roof snapshot.
    .pip_install(
        "torch==2.1.2",
        "torchvision==0.16.2",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
    .apt_install("cuda-toolkit-12-1")
    .add_local_dir(".", "/app", copy=True)
    .workdir("/app")
    # Build the Point2Roof pc_util CUDA extension. The build is
    # ~20-40s; runs once at image build, output is bundled into the
    # image layer. If the build fails (CUDA version mismatch, missing
    # nvcc), the build doesn't abort the image — pc_util import fails
    # at runtime, point2roof_wrapper logs the failure, and the
    # pipeline falls back to PolyFit / alpha-shape.
    .run_commands(
        "cd /app/vendor/point2roof/pc_util && "
        "TORCH_CUDA_ARCH_LIST='7.5;8.0;8.6' python setup.py install || "
        "echo 'WARN: pc_util build failed — Point2Roof tier will fall through'",
    )
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
    memory=16384,
    cpu=2.0,
    # Point2Roof inference requires CUDA. T4 is the cheapest Modal GPU
    # that runs PyTorch CUDA — ~$0.59/hr active. With a 5-15s warm
    # estimate and ~30s warm-container hold, marginal cost per estimate
    # is ~$0.001-0.005. Acceptable for the accuracy gain. When CUDA
    # is unavailable (e.g. local-dev), the wrapper logs and falls
    # through to the CGAL PolyFit / alpha-shape tiers — no failure.
    gpu="T4",
    retries=0,
    min_containers=1,
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

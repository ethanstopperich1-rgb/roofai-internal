"""
services/roof-lidar/detect_objects.py

Object detection on the orthorectified top-down render of the roof.
Uses pretrained YOLOv8n (ultralytics) since LiDAR alone can't classify
chimney vs vent vs skylight — we still need imagery.

Pipeline:
  1. Render the LiDAR point cloud as a top-down ortho image (height-
     colored) sized to ~10cm/pixel over the parcel bbox.
  2. Run YOLOv8n on the image.
  3. Map COCO classes to RoofObject kinds (skylight/chimney/vent/etc).
     Many COCO classes don't apply; for v1 we use a small allow-list
     and skip everything else.
  4. For each detected box, compute its lat/lng centroid + dimensions.

For production tuning:
- TODO: replace pretrained YOLOv8n with a custom roof-objects model
  once a labeled training set is available. The pretrained model
  detects "stop sign" and "boat" but misses "chimney" and "skylight"
  entirely — only "satellite dish" is in its taxonomy. This means
  Tier A object detection is currently weak; chimney/skylight counts
  will be near-zero until custom-training lands. The flashing math
  degrades to "edge-derived only" in this state, which still beats
  Tier C's nothing.
- TODO: use Google 3D Tiles ortho render instead of LiDAR height map
  for higher detection recall once R3F/Cesium integration lands in A.2.
"""

from __future__ import annotations

import logging
import math
from typing import Any

log = logging.getLogger(__name__)

M_PER_DEG_LAT = 111_320.0

# Pretrained YOLOv8n classes that map to roof objects.
# Most don't, but satellite-dish gets us at least one useful detection.
_COCO_TO_KIND: dict[str, str] = {
    "satellite dish": "satellite-dish",
    # No good COCO mapping for chimney/skylight/vent — those need a custom
    # model. Listed here as a stub for when custom training lands.
}


def detect_roof_objects(
    *,
    roof_pts: dict[str, Any],
    facets: list[dict[str, Any]],
    center_lat: float,
    center_lng: float,
) -> list[dict[str, Any]]:
    """Render a top-down ortho of the roof point cloud, run YOLO,
    return RoofObject[] dicts."""
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError as err:
        raise RuntimeError(f"numpy missing: {err}") from err

    xyz = roof_pts.get("xyz")
    if xyz is None or len(xyz) == 0:
        return []

    # Render ortho image. We need px ≈ 10cm/pixel over a ~100m bbox.
    ortho_img = _render_ortho_image(xyz, center_lat=center_lat, center_lng=center_lng)
    if ortho_img is None:
        return []

    detections = _run_yolo(ortho_img)
    if not detections:
        return []

    cos_lat = math.cos(math.radians(center_lat))
    m_per_deg_lng = M_PER_DEG_LAT * cos_lat
    image_extent_m = 100  # matches the render bbox in _render_ortho_image
    img_size = ortho_img.shape[0]

    objects: list[dict[str, Any]] = []
    for i, det in enumerate(detections):
        coco_label = det.get("label")
        kind = _COCO_TO_KIND.get(coco_label) if coco_label else None
        if not kind:
            continue
        # Convert pixel box → lat/lng + dims in ft.
        cx, cy = det["cx_px"], det["cy_px"]
        w_px, h_px = det["w_px"], det["h_px"]
        # Center of image = (0,0) at center_lat,center_lng.
        x_m = (cx - img_size / 2) * (image_extent_m / img_size)
        y_m = (img_size / 2 - cy) * (image_extent_m / img_size)
        w_m = w_px * (image_extent_m / img_size)
        h_m = h_px * (image_extent_m / img_size)
        objects.append({
            "id": f"obj-{i}",
            "kind": kind,
            "position": {
                "lat": center_lat + (y_m / M_PER_DEG_LAT),
                "lng": center_lng + (x_m / m_per_deg_lng),
                "heightM": 0,
            },
            "dimensionsFt": {
                "width": round(w_m * 3.28084, 1),
                "length": round(h_m * 3.28084, 1),
            },
            # Facet attribution: lookup which facet polygon contains
            # the object centroid. Tier A has real facet polygons so we
            # can resolve this (unlike Tier C which leaves it null).
            "facetId": _attribute_to_facet(
                lat=center_lat + (y_m / M_PER_DEG_LAT),
                lng=center_lng + (x_m / m_per_deg_lng),
                facets=facets,
            ),
        })

    return objects


def _render_ortho_image(xyz: Any, *, center_lat: float, center_lng: float) -> Any:
    """Render the roof point cloud as a height-colored top-down image."""
    try:
        import numpy as np  # noqa: PLC0415
    except ImportError:
        return None

    # 1024x1024 image covering a 100x100m bbox → ~10cm/pixel.
    img_size = 1024
    extent_m = 100.0
    img = np.zeros((img_size, img_size, 3), dtype=np.uint8)

    # Convert points to image pixels.
    # LAS xyz is treated as ENU meters from center per pull_lidar's
    # convention. (See its TODO about proper CRS handling.)
    pts = np.asarray(xyz)
    px = ((pts[:, 0]) / extent_m * img_size + img_size / 2).astype(int)
    py = (img_size / 2 - (pts[:, 1]) / extent_m * img_size).astype(int)
    in_bounds = (px >= 0) & (px < img_size) & (py >= 0) & (py < img_size)
    px, py = px[in_bounds], py[in_bounds]
    z = pts[in_bounds, 2]
    if len(z) == 0:
        return None
    z_norm = ((z - z.min()) / max(1e-6, (z.max() - z.min())) * 255).astype(np.uint8)
    img[py, px, 0] = z_norm  # red channel = height
    img[py, px, 1] = z_norm
    img[py, px, 2] = z_norm

    # `center_lat, center_lng` accepted for symmetry with caller; unused here.
    _ = center_lat
    _ = center_lng
    return img


def _run_yolo(image: Any) -> list[dict[str, Any]]:
    """Run YOLOv8n on the ortho image. Returns list of detections with
    bbox in pixel coords + label."""
    try:
        from ultralytics import YOLO  # noqa: PLC0415
    except ImportError:
        log.warning("ultralytics not installed; YOLO detection skipped")
        return []

    try:
        model = YOLO("yolov8n.pt")
        results = model.predict(image, verbose=False)
    except Exception as err:  # noqa: BLE001
        log.warning("YOLO predict failed: %s", err)
        return []

    detections: list[dict[str, Any]] = []
    for r in results:
        if not hasattr(r, "boxes") or r.boxes is None:
            continue
        names = r.names
        for box in r.boxes:
            cls_id = int(box.cls[0]) if hasattr(box, "cls") else None
            label = names[cls_id] if cls_id is not None else None
            xywh = box.xywh[0].tolist() if hasattr(box, "xywh") else None
            if not label or not xywh:
                continue
            detections.append({
                "label": label,
                "cx_px": xywh[0], "cy_px": xywh[1],
                "w_px": xywh[2], "h_px": xywh[3],
                "conf": float(box.conf[0]) if hasattr(box, "conf") else 0.5,
            })
    return detections


def _attribute_to_facet(
    *, lat: float, lng: float, facets: list[dict[str, Any]],
) -> str | None:
    """Lookup which facet's polygon contains the (lat, lng) point.
    Returns the facet id, or None if no facet contains it."""
    try:
        from shapely.geometry import Point, Polygon  # noqa: PLC0415
    except ImportError:
        return None
    p = Point(lng, lat)
    for f in facets:
        try:
            poly = Polygon([(v["lng"], v["lat"]) for v in f["polygon"]])
            if poly.contains(p):
                return f["id"]
        except Exception:  # noqa: BLE001
            continue
    return None

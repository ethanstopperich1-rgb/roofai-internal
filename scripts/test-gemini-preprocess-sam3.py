"""
Test the "Gemini cleans the image, SAM3 segments the cleaned image" hypothesis.

Two failure modes:
  1. Pavement-vs-roof confusion (Winter Garden 16538 Broadwater Ave) —
     SAM3 raw over-traces into driveway because driveway concrete and
     shingle have similar luminance in the satellite tile.
  2. Tree canopy occlusion (Jupiter 813 Summerwood Dr) — SAM3 raw
     over-traces into surrounding tree canopy because dense vegetation
     and dark shingle have similar luminance.

For each address:
  - Fetch Google Static Maps tile
  - Send to Gemini for image cleanup (Nano Banana / 2.5 Flash Image)
  - Send BOTH the raw and cleaned tiles to the Roboflow SAM3 workflow
  - Compare resulting polygon area to:
      * EagleView truth (Winter Garden TBD, Jupiter 3,653.5 sqft)
      * Solar API's footprint × slope factor

Hypothesis the analysis predicts:
  - Winter Garden: cleaned-tile SAM3 polygon ≈ 3,300-4,000 sqft (vs raw 13,334)
  - Jupiter: cleaned-tile SAM3 polygon ≈ 3,400-4,000 sqft (vs raw 15,950)

If hypothesis holds: the over-trace bug is solvable upstream via image
cleanup, no reconciler clip needed, polygon stays beautiful + accurate.

If hypothesis fails: Gemini hallucinates roof under canopy / can't remove
pavement, and we keep SAM3 raw + Solar-undercount as the architecture.
"""

import base64
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

# Load .env.production
ENV_PATH = Path(__file__).parent.parent / ".env.production"
for line in ENV_PATH.read_text().splitlines():
    m = line.strip()
    if "=" in m and not m.startswith("#"):
        k, v = m.split("=", 1)
        v = v.strip('"')
        if k not in os.environ:
            os.environ[k] = v

GEMINI_KEY = os.environ["GEMINI_API_KEY"]
ROBOFLOW_KEY = os.environ["ROBOFLOW_API_KEY"]
GOOGLE_KEY = os.environ["GOOGLE_SERVER_KEY"]
SAM3_WORKFLOW = "https://serverless.roboflow.com/infer/workflows/bradens-workspace/sam3-roof-segmentation-test-1778124556737"

# Gemini image-editing endpoint — "Nano Banana" is gemini-2.5-flash-image
GEMINI_MODEL = "gemini-2.5-flash-image-preview"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"

CLEANUP_PROMPT = """Edit this aerial satellite image to make it easier to identify the roof of the house at the center of the image. Specifically:

1. Remove tree shadows that fall across the roof or onto surrounding ground.
2. Enhance the contrast between roof material (shingles, tile, or metal) and surrounding surfaces like driveway, pool deck, lawn, and sidewalk.
3. Do not modify the roof shape, color, or features.
4. Do not change the overall layout or building positions.
5. Preserve photographic realism — do not make the image look artificial.

The goal is a cleaner image that emphasizes the natural boundary between the roof and the ground around it."""


def fetch_google_tile(lat: float, lng: float, out_path: str, zoom: int = 20, scale: int = 2, size_px: int = 640) -> bytes:
    url = (
        f"https://maps.googleapis.com/maps/api/staticmap"
        f"?center={lat},{lng}&zoom={zoom}&size={size_px}x{size_px}"
        f"&scale={scale}&maptype=satellite&key={GOOGLE_KEY}"
    )
    buf = urllib.request.urlopen(url, timeout=30).read()
    Path(out_path).write_bytes(buf)
    print(f"  ↳ Google tile saved: {out_path} ({len(buf)} bytes)")
    return buf


def gemini_clean(tile_bytes: bytes, out_path: str) -> bytes | None:
    body = {
        "contents": [{
            "parts": [
                {"text": CLEANUP_PROMPT},
                {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(tile_bytes).decode()}}
            ]
        }],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "temperature": 0.2,
        },
    }
    req = urllib.request.Request(
        GEMINI_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"  ↳ Gemini ERROR {e.code}: {e.read().decode()[:400]}")
        return None
    dt = time.time() - t0
    # Walk response for inline_data image
    image_b64 = None
    for cand in res.get("candidates", []):
        for part in (cand.get("content") or {}).get("parts", []):
            if "inlineData" in part:
                image_b64 = part["inlineData"]["data"]
                break
            if "inline_data" in part:
                image_b64 = part["inline_data"]["data"]
                break
        if image_b64:
            break
    if not image_b64:
        print(f"  ↳ Gemini returned no image. Response keys: {list(res.keys())}")
        # Save full response for debugging
        Path(out_path + ".error.json").write_text(json.dumps(res, indent=2)[:4000])
        return None
    out = base64.b64decode(image_b64)
    Path(out_path).write_bytes(out)
    print(f"  ↳ Gemini cleaned: {out_path} ({len(out)} bytes, {dt:.1f}s)")
    return out


def sam3_segment(tile_bytes: bytes, label: str, lat: float) -> tuple[int, list[dict]]:
    """Returns (sqft, predictions). sqft computed via shoelace × m/px²."""
    body = {
        "api_key": ROBOFLOW_KEY,
        "inputs": {
            "image": {"type": "base64", "value": base64.b64encode(tile_bytes).decode()},
            "prompt": "entire house roof",
            "confidence": 0.3,
            "pixels_per_unit": 1,
        },
    }
    req = urllib.request.Request(
        SAM3_WORKFLOW,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as r:
        res = json.load(r)
    dt = time.time() - t0

    # Walk response for predictions[]
    preds = []
    def walk(node):
        if isinstance(node, dict):
            if "predictions" in node and isinstance(node["predictions"], list):
                preds.extend(node["predictions"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node: walk(v)
    walk(res)

    # Compute sqft from top prediction
    def shoelace(pts):
        if len(pts) < 3: return 0
        a = 0
        for i in range(len(pts)):
            j = (i+1) % len(pts)
            a += pts[i]["x"] * pts[j]["y"] - pts[j]["x"] * pts[i]["y"]
        return abs(a) / 2

    Z, S, TILE_PX = 20, 2, 1280
    m_per_px = 156543.03392 * math.cos(lat * math.pi / 180) / (2 ** (Z + S - 1))
    sqft_per_px2 = (m_per_px ** 2) * 10.7639

    sized = []
    for p in preds:
        pts = p.get("points") or p.get("polygon") or []
        area_px = shoelace(pts)
        sized.append({"class": p.get("class", "?"), "conf": p.get("confidence"), "pts": len(pts), "areaPx": area_px, "sqft": int(area_px * sqft_per_px2)})

    sized.sort(key=lambda x: -x["sqft"])
    top_sqft = sized[0]["sqft"] if sized else 0
    print(f"  ↳ SAM3 [{label}]: {len(preds)} preds, top {top_sqft} sqft, {dt:.1f}s")
    for s in sized[:3]:
        print(f"      [{s['class']}] conf={s['conf']:.3f} verts={s['pts']} → {s['sqft']} sqft")
    return top_sqft, sized


def run_test(name: str, lat: float, lng: float, truth_sqft: int | None):
    print(f"\n{'='*72}\n{name}  ({lat}, {lng})")
    if truth_sqft:
        print(f"  EagleView truth: {truth_sqft} sqft")
    print('='*72)

    tag = name.lower().replace(" ", "_").replace("/", "_")
    raw_path = f"/tmp/test-gemini-{tag}-raw.png"
    clean_path = f"/tmp/test-gemini-{tag}-cleaned.png"

    print("\n[1] Fetching Google tile…")
    raw = fetch_google_tile(lat, lng, raw_path)

    print("\n[2] Gemini cleanup…")
    cleaned = gemini_clean(raw, clean_path)

    print("\n[3] SAM3 on RAW tile…")
    raw_sqft, _ = sam3_segment(raw, "raw", lat)

    if cleaned:
        print("\n[4] SAM3 on CLEANED tile…")
        clean_sqft, _ = sam3_segment(cleaned, "cleaned", lat)
    else:
        print("\n[4] SKIPPED (no cleaned tile)")
        clean_sqft = None

    print(f"\n--- RESULT for {name} ---")
    print(f"  Raw SAM3:     {raw_sqft} sqft")
    if clean_sqft is not None:
        print(f"  Cleaned SAM3: {clean_sqft} sqft")
        if truth_sqft:
            raw_pct = abs(raw_sqft - truth_sqft) / truth_sqft * 100
            clean_pct = abs(clean_sqft - truth_sqft) / truth_sqft * 100
            print(f"  Raw vs truth:     {raw_pct:.0f}% off")
            print(f"  Cleaned vs truth: {clean_pct:.0f}% off")
            if clean_pct < raw_pct * 0.5:
                print(f"  → ✅ CLEANUP HELPED (>2x improvement)")
            elif clean_pct < raw_pct:
                print(f"  → ⚠️  Cleanup helped marginally")
            else:
                print(f"  → ❌ Cleanup did NOT help")
    print(f"  Visual proof: {raw_path}  vs  {clean_path}")


if __name__ == "__main__":
    run_test("Winter Garden (driveway-confusion)", 28.518061, -81.6298012, None)
    run_test("Jupiter (canopy-occlusion)", 26.93252, -80.10804, 3654)

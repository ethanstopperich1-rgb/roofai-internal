#!/usr/bin/env python3
"""
ingest_mrms.py — daily ingest of MRMS Maximum Estimated Size of Hail.

Downloads the most-recent MRMS_MESH_Max_1440min product for a given UTC
date from the public AWS NOAA MRMS-PDS bucket, decodes the GRIB2 (PNG-
compressed; eccodes/pygrib handles the template-41 data section that no
pure-JS GRIB2 lib on npm currently parses), filters to cells with hail
>= 12.7mm (0.5"), restricted to a CONUS sub-bbox covering RSS's three
service states (FL, MN, TX) plus generous padding, and writes a flat
JSON document to Vercel Blob keyed by date.

Why this architecture:
  - Vercel's Python serverless runtime cannot install eccodes (the
    system C library pygrib needs). GitHub Actions Ubuntu runners CAN
    (`apt-get install libeccodes-dev`), so we run the ingest there and
    push the decoded result to Vercel Blob. The hot-path /api/hail-mrms
    route reads the per-day Blob files; no GRIB2 parsing at request
    time.
  - One file per UTC date keeps the index simple. Cells are pre-filtered
    so each day's JSON is ~50-200 KB even on heavy storm days, instead
    of the 1.1 MB raw GRIB2.
  - Hail data once published doesn't change — cache the per-day Blob
    indefinitely, never invalidate.

Usage:
  ingest_mrms.py --date 20240805
  ingest_mrms.py --date yesterday
  ingest_mrms.py --backfill 2024-01-01:2024-12-31

Env vars (required for upload):
  BLOB_READ_WRITE_TOKEN  - Vercel Blob token

The output Blob path is `mrms-hail/YYYYMMDD.json` (also written to
`mrms-hail/latest.json` for quick "what was the most-recent ingest"
checks). The HTTP API in app/api/hail-mrms reads these.
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import sys
import urllib.request
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

import numpy as np
import pygrib  # type: ignore[import-not-found]


# --- Bounds covering RSS's three service states + ~50mi padding ---
# Wide bbox keeps a single per-day file useful even when RSS expands
# into adjacent states. Sub-bbox filtering at request time picks the
# right cells.
RSS_BBOX = {
    "min_lat": 24.0,   # south of FL Keys
    "max_lat": 50.0,   # north of MN
    "min_lng": -107.0, # west of TX panhandle
    "max_lng": -79.0,  # east of FL Atlantic coast
}

# Hail size threshold for inclusion. 12.7mm = 0.5". Below this, the
# event isn't actionable for roofing claims (sub-1" causes minimal
# granule loss; below 0.5" is essentially unreportable).
MIN_HAIL_MM = 12.7

# MRMS bucket. Anonymous public access — no AWS auth required.
MRMS_BUCKET = "noaa-mrms-pds"
MRMS_PRODUCT_PREFIX = "CONUS/MESH_Max_1440min_00.50"


# ----------------------------------------------------------------------
# Bucket discovery — find the most recent MESH file for a given UTC date
# ----------------------------------------------------------------------

def list_files_for_date(yyyymmdd: str) -> list[str]:
    """List MESH GRIB2 keys for a UTC date partition. Anonymous S3 ListObjectsV2."""
    url = (
        f"https://{MRMS_BUCKET}.s3.amazonaws.com/?list-type=2"
        f"&prefix={urllib.parse.quote(MRMS_PRODUCT_PREFIX)}/{yyyymmdd}/"
    )
    with urllib.request.urlopen(url, timeout=30) as r:
        body = r.read().decode("utf-8")
    # Tiny XML parser — avoid pulling in lxml/etree for one element.
    keys = []
    pos = 0
    while True:
        a = body.find("<Key>", pos)
        if a < 0:
            break
        b = body.find("</Key>", a)
        keys.append(body[a + 5 : b])
        pos = b + 6
    return [k for k in keys if k.endswith(".grib2.gz")]


def pick_latest_file(keys: list[str]) -> Optional[str]:
    """MESH_Max_1440min files publish every 30 min. Pick the one closest
    to 23:59 UTC for the date — that's the day's true 24-hour maximum."""
    if not keys:
        return None
    return sorted(keys)[-1]


# ----------------------------------------------------------------------
# GRIB2 decode + cell filter
# ----------------------------------------------------------------------

def fetch_grib2(key: str) -> bytes:
    """Download + gunzip a MESH GRIB2 from the bucket."""
    url = f"https://{MRMS_BUCKET}.s3.amazonaws.com/{urllib.parse.quote(key)}"
    with urllib.request.urlopen(url, timeout=60) as r:
        gz = r.read()
    return gzip.decompress(gz)


def decode_mesh(grib_bytes: bytes) -> Tuple[np.ndarray, dict]:
    """Decode the MESH grid. Returns (values_mm, grid_info)."""
    # pygrib needs a file path or open file. Write to a tmp file (in
    # memory pseudofile via /dev/stdin doesn't work cross-platform).
    tmp = "/tmp/_mrms_in.grib2"
    with open(tmp, "wb") as f:
        f.write(grib_bytes)
    grbs = pygrib.open(tmp)
    msg = grbs.message(1)
    values = msg.values  # (Nj, Ni) = (3500, 7000)
    grid = {
        "ni": int(msg.Ni),
        "nj": int(msg.Nj),
        "la1": float(msg.latitudeOfFirstGridPointInDegrees),
        "lo1": float(msg.longitudeOfFirstGridPointInDegrees),
        "la2": float(msg.latitudeOfLastGridPointInDegrees),
        "lo2": float(msg.longitudeOfLastGridPointInDegrees),
        "di": float(msg.iDirectionIncrementInDegrees),
        "dj": float(msg.jDirectionIncrementInDegrees),
        "reference_date": int(msg.dataDate),
        "reference_time": int(msg.dataTime),
    }
    return values, grid


def cells_above_threshold(values: np.ndarray, grid: dict) -> list[dict]:
    """Find every grid cell with hail >= MIN_HAIL_MM inside RSS_BBOX.

    Math:
        col = (lng - lo1) / di   (with lo1 wrapped to -180..180)
        row = (la1 - lat) / dj   (la1 is the NORTH edge; rows count south)
    """
    lo1 = grid["lo1"] - 360.0 if grid["lo1"] > 180.0 else grid["lo1"]
    la1, di, dj = grid["la1"], grid["di"], grid["dj"]
    nj, ni = grid["nj"], grid["ni"]

    # Row/col bounds for RSS_BBOX
    col_min = max(0, int((RSS_BBOX["min_lng"] - lo1) / di))
    col_max = min(ni, int((RSS_BBOX["max_lng"] - lo1) / di) + 1)
    row_min = max(0, int((la1 - RSS_BBOX["max_lat"]) / dj))
    row_max = min(nj, int((la1 - RSS_BBOX["min_lat"]) / dj) + 1)

    sub = values[row_min:row_max, col_min:col_max]
    # Treat MRMS sentinel values (negative) as no-data
    mask = sub >= MIN_HAIL_MM
    rows, cols = np.where(mask)

    out = []
    for r, c in zip(rows, cols):
        full_r = row_min + int(r)
        full_c = col_min + int(c)
        # Cell center, not corner
        lat = la1 - (full_r + 0.5) * dj
        lng = lo1 + (full_c + 0.5) * di
        mm = float(sub[r, c])
        out.append({
            "lat": round(lat, 4),
            "lng": round(lng, 4),
            "mm": round(mm, 2),
            "in": round(mm / 25.4, 2),
        })
    return out


# ----------------------------------------------------------------------
# Vercel Blob upload
# ----------------------------------------------------------------------

def upload_to_blob(path: str, payload: dict, token: Optional[str] = None) -> Optional[str]:
    """Upload JSON to Vercel Blob via the public REST API.

    Vercel Blob's PUT endpoint is `https://blob.vercel-storage.com/upload`
    with the path as a query param + Authorization Bearer header. Using
    raw urllib so this script has zero non-stdlib deps beyond pygrib +
    numpy (already pinned in the GH Action).
    """
    token = token or os.environ.get("BLOB_READ_WRITE_TOKEN")
    if not token:
        print("[mrms] BLOB_READ_WRITE_TOKEN not set; skipping upload", file=sys.stderr)
        return None

    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    url = f"https://blob.vercel-storage.com/{urllib.parse.quote(path)}"
    req = urllib.request.Request(
        url,
        data=body,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-content-type": "application/json",
            "x-add-random-suffix": "0",
            "x-cache-control-max-age": "31536000",  # 1 year — hail past doesn't change
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.loads(r.read().decode("utf-8"))
    return resp.get("url")


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

def ingest_one_day(yyyymmdd: str, *, dry_run: bool = False) -> dict:
    print(f"[mrms] ingesting {yyyymmdd}")
    keys = list_files_for_date(yyyymmdd)
    key = pick_latest_file(keys)
    if not key:
        print(f"[mrms] no MRMS files for {yyyymmdd} — bucket gap")
        return {"date": yyyymmdd, "status": "no_data", "cells": []}

    print(f"[mrms]   fetching {key}")
    grib_bytes = fetch_grib2(key)
    print(f"[mrms]   decoded {len(grib_bytes):,} bytes; parsing")
    values, grid = decode_mesh(grib_bytes)
    cells = cells_above_threshold(values, grid)
    print(f"[mrms]   {len(cells):,} cells with hail >= {MIN_HAIL_MM}mm")

    payload = {
        "date": yyyymmdd,
        "ingestedAt": datetime.now(timezone.utc).isoformat(),
        "source": f"s3://{MRMS_BUCKET}/{key}",
        "referenceDate": grid["reference_date"],
        "referenceTime": grid["reference_time"],
        "thresholdMm": MIN_HAIL_MM,
        "bbox": RSS_BBOX,
        "cellCount": len(cells),
        "cells": cells,
    }

    if dry_run:
        print(f"[mrms]   dry run — skipping Blob upload")
        return payload

    blob_path = f"mrms-hail/{yyyymmdd}.json"
    blob_url = upload_to_blob(blob_path, payload)
    if blob_url:
        print(f"[mrms]   uploaded → {blob_url}")
        # Also update mrms-hail/latest.json so the API can find the most
        # recent ingest cheaply without listing the whole prefix.
        latest = {"date": yyyymmdd, "url": blob_url, "cellCount": len(cells)}
        upload_to_blob("mrms-hail/latest.json", latest)
    return payload


def parse_date_arg(s: str) -> str:
    if s == "yesterday":
        d = datetime.now(timezone.utc) - timedelta(days=1)
        return d.strftime("%Y%m%d")
    if s == "today":
        return datetime.now(timezone.utc).strftime("%Y%m%d")
    if len(s) == 8 and s.isdigit():
        return s
    raise ValueError(f"bad date: {s!r}")


def parse_backfill_arg(s: str) -> list[str]:
    """`2024-01-01:2024-12-31` → list of YYYYMMDD."""
    a, b = s.split(":")
    da = datetime.strptime(a, "%Y-%m-%d").date()
    db = datetime.strptime(b, "%Y-%m-%d").date()
    out = []
    while da <= db:
        out.append(da.strftime("%Y%m%d"))
        da += timedelta(days=1)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="YYYYMMDD or 'yesterday' or 'today'")
    ap.add_argument(
        "--backfill",
        help="Inclusive date range YYYY-MM-DD:YYYY-MM-DD — runs ingest for every day in range.",
    )
    ap.add_argument("--dry-run", action="store_true", help="Skip Blob upload; print summary.")
    args = ap.parse_args()

    if args.backfill:
        dates = parse_backfill_arg(args.backfill)
        print(f"[mrms] backfilling {len(dates)} days")
        for d in dates:
            try:
                ingest_one_day(d, dry_run=args.dry_run)
            except Exception as e:
                print(f"[mrms]   {d} FAILED: {e}", file=sys.stderr)
        return 0

    date = parse_date_arg(args.date or "yesterday")
    ingest_one_day(date, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())

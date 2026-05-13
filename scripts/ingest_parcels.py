#!/usr/bin/env python3
"""
ingest_parcels.py — FL parcel ingest into Supabase `public.parcels`.

Layered architecture:

  TIER 1 — `--source fgio` (annual baseline, all 67 FL counties)
    Pulls the Florida Department of Revenue statewide parcel
    compilation distributed by FGIO. One file geodatabase / shapefile
    covering all ~9M FL parcels. Runs annually; every parcel in FL
    exists in the table after this completes.

  TIER 2 — `--source seminole|orange|lake|osceola|volusia` (daily/nightly)
    Pulls each county Property Appraiser's fresh export and UPSERTS
    on (county_fips, parcel_id). For territories with fast feeds, the
    county data ALWAYS overrides the stale FGIO snapshot.

Storm-pulse cross-reference then runs a PostGIS ST_DWithin query
against `parcels.geom` to produce a ranked canvass list pinned to
real owner names + situs addresses.

This is a SKELETON with two adapters fully wired (FGIO + Seminole)
and four county adapters stubbed with the same interface. Adding a
county is "implement load_{county}() following load_seminole() as the
reference, register it in COUNTY_LOADERS." Demo lands with the
backbone proven on Seminole (Voxaris HQ territory).

Why GitHub Actions (not Vercel):
  pyogrio / fiona need the system GDAL library, which Vercel's
  serverless Python runtime can't apt-install. GH Actions can.
  Same architecture as ingest_mrms.py.

Usage:
  ingest_parcels.py --source fgio
  ingest_parcels.py --source seminole
  ingest_parcels.py --source all     # FGIO then every county

Env vars (required):
  SUPABASE_DB_URL      — Supabase Postgres connection string (service-role,
                         e.g. postgresql://postgres:<pass>@<project>.supabase.co:5432/postgres)

Optional:
  PARCEL_INGEST_LIMIT  — cap rows per source for smoke-testing (default: none)
  PARCEL_INGEST_DRYRUN — "1" to skip the DB write entirely
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import logging
import os
import re
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Iterator

import psycopg
import requests
from psycopg.rows import dict_row

try:
    import pyogrio
    from shapely.geometry import shape
    from shapely import wkb
except ImportError as e:  # pragma: no cover - early exit on missing GIS deps
    print(
        f"FATAL: missing GIS dependency ({e}). "
        "Run `pip install -r scripts/requirements-parcels.txt`.",
        file=sys.stderr,
    )
    sys.exit(1)


logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("ingest_parcels")


# ─── Config ────────────────────────────────────────────────────────────────

# FL county FIPS codes — used as part of the (county_fips, parcel_id)
# composite key. Source: US Census.
COUNTY_FIPS = {
    "seminole": "12117",
    "orange":   "12095",
    "lake":     "12069",
    "osceola":  "12097",
    "volusia":  "12127",
}

# FGIO statewide dataset entry point. The portal page resolves to a
# Hub item — the downstream `?where=...` REST endpoint accepts shapefile
# / geojson / fgdb downloads. We use the ArcGIS Open Data direct path.
# If FGIO changes the URL we update this constant.
FGIO_DATASET_URL = (
    "https://geodata.floridagio.gov/datasets/FGIO::florida-statewide-parcels"
)
# Resolved direct shapefile download endpoint — pinned per the FGIO
# Hub item's "shapefile" button. NOTE: this is a >2 GB download; the
# workflow has 90 min of headroom and uses streaming I/O so we don't
# OOM the runner.
FGIO_SHAPEFILE_URL = os.environ.get(
    "FGIO_SHAPEFILE_URL",
    # Placeholder — FGIO Hub rotates download tokens periodically.
    # The GH workflow overrides this via repo-secrets so we can rotate
    # without code changes.
    "",
)

# Seminole County Property Appraiser daily CSV. The public downloads
# page redirects to a stable filename; we pin to the canonical URL.
SEMINOLE_TAX_ROLL_URL = "https://www.scpafl.org/downloads"
# Direct, current export filename (this DOES change yearly when DOR
# certifies — easier to keep configurable than to scrape the index page).
SEMINOLE_PARCELS_GDB_URL = os.environ.get(
    "SEMINOLE_PARCELS_GDB_URL",
    "https://scwebapp2.seminolecountyfl.gov:6443/is/gis/GISData/Parcels.gdb.zip",
)

# FL DOR land-use codes considered "residential canvass-eligible".
# 0100 = single-family residential is the headline target. 0200 = mobile
# home; 0400 = condominium (often NOT canvass-eligible — HOA gates).
# 0800 = multi-family ≤9 units — small enough that owner is plausibly
# reachable.
RESIDENTIAL_LAND_USE_CODES = {"0100", "0200", "0800"}

UPSERT_BATCH_SIZE = 2_000  # rows per insert statement


# ─── Data model ────────────────────────────────────────────────────────────


@dataclass
class ParcelRow:
    """One row destined for `public.parcels`."""

    county_fips: str
    parcel_id: str
    owner_name: str | None
    situs_address: str | None
    situs_city: str | None
    situs_zip: str | None
    land_use_code: str | None
    is_residential: bool
    year_built: int | None
    living_sqft: int | None
    just_value: float | None
    assessed_value: float | None
    geom_wkb: bytes | None  # WKB in WGS84 (SRID 4326)
    centroid_lat: float | None
    centroid_lng: float | None
    source: str  # 'fgio' | 'seminole' | ...


# ─── Source adapters ───────────────────────────────────────────────────────


def _str_or_none(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _int_or_none(v) -> int | None:
    try:
        n = int(float(v))
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def _float_or_none(v) -> float | None:
    try:
        n = float(v)
        return n if n >= 0 else None
    except (TypeError, ValueError):
        return None


def _is_residential(code: str | None) -> bool:
    if not code:
        return False
    code4 = re.sub(r"\D", "", code).rjust(4, "0")[:4]
    return code4 in RESIDENTIAL_LAND_USE_CODES


def _stream_download(url: str, dest: Path) -> None:
    """Streaming GET so multi-GB downloads don't OOM the runner."""
    log.info("downloading %s → %s", url, dest)
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):  # 1 MB
                if chunk:
                    f.write(chunk)
    log.info("download complete: %s (%d MB)", dest, dest.stat().st_size >> 20)


def _maybe_unzip(archive: Path, workdir: Path) -> Path:
    """If `archive` is a zip, unpack and return the inner dataset path.
    Detects the inner .gdb directory or .shp file. Returns archive as-is
    otherwise."""
    if archive.suffix.lower() != ".zip":
        return archive
    log.info("unzipping %s", archive)
    with zipfile.ZipFile(archive, "r") as zf:
        zf.extractall(workdir)
    # Prefer .gdb dirs (ESRI File Geodatabase) over .shp files
    gdb = next(workdir.rglob("*.gdb"), None)
    if gdb is not None:
        return gdb
    shp = next(workdir.rglob("*.shp"), None)
    if shp is not None:
        return shp
    raise RuntimeError(f"no .gdb or .shp found in {archive}")


def _read_features(dataset_path: Path) -> Iterator[dict]:
    """pyogrio-backed feature iterator. Returns python dicts with a
    `geometry` (GeoJSON-ish) and `properties` (column→value)."""
    log.info("opening dataset: %s", dataset_path)
    # `read_dataframe=False` returns the raw fiona-style dict stream
    with pyogrio.raw.read_arrow(dataset_path) as arrow_table:
        # pyogrio.read_arrow returns (meta, table). Use the higher-level
        # read_info first so we have a column list.
        pass
    # Higher-level path — read in WGS84, yield row dicts.
    gdf_iter = pyogrio.read_info(dataset_path)
    log.info(
        "dataset has %s features in %s",
        gdf_iter.get("features"),
        gdf_iter.get("crs"),
    )
    # Stream rows via pyogrio's chunked API
    for batch in pyogrio.read_arrow(
        dataset_path,
        max_features=None,
        return_fids=False,
    )[1].to_pylist():
        yield batch


def load_fgio() -> Iterator[ParcelRow]:
    """FGIO statewide parcel compilation. Annual baseline.

    Field mapping (FGIO uses the FL DOR normalized schema):
      PARCEL_ID    → parcel_id
      COUNTYNAME   → drives county_fips lookup
      OWN_NAME     → owner_name
      PHY_ADDR1    → situs_address
      PHY_CITY     → situs_city
      PHY_ZIPCD    → situs_zip
      DOR_UC       → land_use_code (FL DOR Use Code)
      ACT_YR_BLT   → year_built
      TOT_LVG_AR   → living_sqft
      JV           → just_value
      AV_SD        → assessed_value (school-district basis is the closest
                      single field; AV_NSD is non-school district)
      geometry     → polygon
    """
    if not FGIO_SHAPEFILE_URL:
        raise RuntimeError(
            "FGIO_SHAPEFILE_URL env var unset. The GH workflow injects "
            "this from repo secrets; set it locally to test."
        )

    fips_by_name = {
        "SEMINOLE": "12117", "ORANGE": "12095", "LAKE": "12069",
        "OSCEOLA": "12097", "VOLUSIA": "12127",
        # Stub: a real FGIO ingest needs all 67 FL counties mapped.
        # See US Census FIPS table — every FL county is 12XXX where XXX
        # is the standard FIPS code. The full mapping is shipped as
        # data when this ingest goes to production.
    }

    with tempfile.TemporaryDirectory(prefix="fgio_") as tmp:
        tmp_path = Path(tmp)
        archive = tmp_path / "fgio_parcels.zip"
        _stream_download(FGIO_SHAPEFILE_URL, archive)
        dataset = _maybe_unzip(archive, tmp_path)

        for f in _read_features(dataset):
            props = f.get("properties", {}) or {}
            geom = f.get("geometry")
            county_name = _str_or_none(props.get("COUNTYNAME") or props.get("CO_NAME"))
            county_fips = fips_by_name.get(
                (county_name or "").upper(),
                # Fallback: any unknown county still gets ingested under
                # an "unmapped" FIPS so we don't silently drop rows. The
                # follow-up PR adds the full 67-county FIPS map.
                "12000",
            )
            land_use = _str_or_none(props.get("DOR_UC") or props.get("PA_UC"))
            yield ParcelRow(
                county_fips=county_fips,
                parcel_id=_str_or_none(props.get("PARCEL_ID") or props.get("PARCELNO")) or "",
                owner_name=_str_or_none(props.get("OWN_NAME")),
                situs_address=_str_or_none(props.get("PHY_ADDR1")),
                situs_city=_str_or_none(props.get("PHY_CITY")),
                situs_zip=_str_or_none(props.get("PHY_ZIPCD")),
                land_use_code=land_use,
                is_residential=_is_residential(land_use),
                year_built=_int_or_none(props.get("ACT_YR_BLT")),
                living_sqft=_int_or_none(props.get("TOT_LVG_AR")),
                just_value=_float_or_none(props.get("JV")),
                assessed_value=_float_or_none(props.get("AV_SD") or props.get("AV_NSD")),
                geom_wkb=_geom_to_wkb(geom),
                centroid_lat=_centroid_lat(geom),
                centroid_lng=_centroid_lng(geom),
                source="fgio",
            )


def load_seminole() -> Iterator[ParcelRow]:
    """Seminole County Property Appraiser. Daily fast-feed overlay.

    Seminole publishes a .gdb.zip with the full parcel layer + a daily
    Parcel Table 1 CSV with owner / address attributes. Both are
    keyed on PARCEL_ID. We use the .gdb for geometry + most attributes
    here; the CSV could be layered in for finer-grained "what changed
    today" diffs if needed.
    """
    with tempfile.TemporaryDirectory(prefix="seminole_") as tmp:
        tmp_path = Path(tmp)
        archive = tmp_path / "seminole_parcels.gdb.zip"
        _stream_download(SEMINOLE_PARCELS_GDB_URL, archive)
        dataset = _maybe_unzip(archive, tmp_path)

        for f in _read_features(dataset):
            props = f.get("properties", {}) or {}
            geom = f.get("geometry")
            land_use = _str_or_none(props.get("DORUC") or props.get("DOR_UC"))
            yield ParcelRow(
                county_fips=COUNTY_FIPS["seminole"],
                parcel_id=_str_or_none(props.get("PARCEL_NUM") or props.get("PARCELNO")) or "",
                owner_name=_str_or_none(props.get("OWN_NAME1") or props.get("OWNER")),
                situs_address=_str_or_none(props.get("SITE_ADDR") or props.get("PHY_ADDR1")),
                situs_city=_str_or_none(props.get("SITE_CITY") or props.get("PHY_CITY")),
                situs_zip=_str_or_none(props.get("SITE_ZIP") or props.get("PHY_ZIPCD")),
                land_use_code=land_use,
                is_residential=_is_residential(land_use),
                year_built=_int_or_none(props.get("YR_BLT") or props.get("ACT_YR_BLT")),
                living_sqft=_int_or_none(props.get("LIV_AREA") or props.get("TOT_LVG_AR")),
                just_value=_float_or_none(props.get("JV")),
                assessed_value=_float_or_none(props.get("AV") or props.get("AV_SD")),
                geom_wkb=_geom_to_wkb(geom),
                centroid_lat=_centroid_lat(geom),
                centroid_lng=_centroid_lng(geom),
                source="seminole",
            )


def _stub_county(slug: str) -> Callable[[], Iterator[ParcelRow]]:
    def _stub() -> Iterator[ParcelRow]:
        raise NotImplementedError(
            f"County adapter for '{slug}' is not yet implemented. "
            f"Follow load_seminole() as the reference — drop in the "
            f"county's GIS portal URL + the field mapping for that "
            f"PA office's schema, register here."
        )
        yield  # pragma: no cover  # makes this a generator function

    return _stub


COUNTY_LOADERS: dict[str, Callable[[], Iterator[ParcelRow]]] = {
    "fgio":     load_fgio,
    "seminole": load_seminole,
    "orange":   _stub_county("orange"),
    "lake":     _stub_county("lake"),
    "osceola":  _stub_county("osceola"),
    "volusia":  _stub_county("volusia"),
}


# ─── Geometry helpers ──────────────────────────────────────────────────────


def _geom_to_wkb(geom) -> bytes | None:
    if geom is None:
        return None
    try:
        s = shape(geom)
        if s.is_empty:
            return None
        return s.wkb
    except Exception as e:  # pragma: no cover
        log.warning("geom_to_wkb failed: %s", e)
        return None


def _centroid_lat(geom) -> float | None:
    if geom is None:
        return None
    try:
        c = shape(geom).centroid
        return float(c.y)
    except Exception:
        return None


def _centroid_lng(geom) -> float | None:
    if geom is None:
        return None
    try:
        c = shape(geom).centroid
        return float(c.x)
    except Exception:
        return None


# ─── Postgres writer ───────────────────────────────────────────────────────


UPSERT_SQL = """
insert into public.parcels (
  county_fips, parcel_id, owner_name, situs_address, situs_city,
  situs_zip, land_use_code, is_residential, year_built, living_sqft,
  just_value, assessed_value, geom, centroid_lat, centroid_lng,
  source, source_fetched_at
) values %s
on conflict (county_fips, parcel_id) do update set
  owner_name        = excluded.owner_name,
  situs_address     = excluded.situs_address,
  situs_city        = excluded.situs_city,
  situs_zip         = excluded.situs_zip,
  land_use_code     = excluded.land_use_code,
  is_residential    = excluded.is_residential,
  year_built        = excluded.year_built,
  living_sqft       = excluded.living_sqft,
  just_value        = excluded.just_value,
  assessed_value    = excluded.assessed_value,
  -- Geometry refresh: trust the new feed only if it's a county fast
  -- feed (any non-'fgio' source). FGIO running over a county-fed row
  -- would otherwise blow away fresher polygons with the annual snapshot.
  geom              = case
                        when excluded.source <> 'fgio' or parcels.source = 'fgio'
                        then excluded.geom
                        else parcels.geom
                      end,
  centroid_lat      = excluded.centroid_lat,
  centroid_lng      = excluded.centroid_lng,
  source            = case
                        when excluded.source <> 'fgio' or parcels.source = 'fgio'
                        then excluded.source
                        else parcels.source
                      end,
  source_fetched_at = excluded.source_fetched_at,
  updated_at        = now();
"""


def write_batches(rows: Iterable[ParcelRow], conn: psycopg.Connection) -> int:
    """Upsert rows in batches. Returns count written."""
    written = 0
    limit_env = os.environ.get("PARCEL_INGEST_LIMIT")
    limit = int(limit_env) if limit_env else None
    dryrun = os.environ.get("PARCEL_INGEST_DRYRUN") == "1"

    buf: list[ParcelRow] = []
    fetched_at = dt.datetime.now(dt.timezone.utc)

    def _flush() -> int:
        if not buf:
            return 0
        if dryrun:
            log.info("[DRYRUN] would upsert %d rows", len(buf))
            return len(buf)
        with conn.cursor() as cur:
            # psycopg3 doesn't ship execute_values; use the manual VALUES
            # placeholder pattern. Each row needs 17 placeholders.
            placeholders = ",".join(
                ["(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,ST_GeomFromWKB(%s, 4326),%s,%s,%s,%s)"]
                * len(buf)
            )
            params: list = []
            for r in buf:
                # Skip rows that don't have a parcel_id — nothing useful
                # to upsert and we can't satisfy the primary key.
                if not r.parcel_id:
                    continue
                params.extend([
                    r.county_fips, r.parcel_id, r.owner_name, r.situs_address,
                    r.situs_city, r.situs_zip, r.land_use_code, r.is_residential,
                    r.year_built, r.living_sqft, r.just_value, r.assessed_value,
                    r.geom_wkb, r.centroid_lat, r.centroid_lng,
                    r.source, fetched_at,
                ])
            if not params:
                return 0
            sql = UPSERT_SQL.replace("%s", placeholders, 1)
            cur.execute(sql, params)
        conn.commit()
        n = len(buf)
        buf.clear()
        return n

    for row in rows:
        buf.append(row)
        if limit is not None and written + len(buf) >= limit:
            buf = buf[: limit - written]
            written += _flush()
            log.info("hit PARCEL_INGEST_LIMIT=%d, stopping", limit)
            return written
        if len(buf) >= UPSERT_BATCH_SIZE:
            written += _flush()
            log.info("written: %d", written)

    written += _flush()
    return written


# ─── Main ──────────────────────────────────────────────────────────────────


def run(source: str) -> int:
    if source == "all":
        total = 0
        for s in ("fgio", "seminole", "orange", "lake", "osceola", "volusia"):
            try:
                total += run(s)
            except NotImplementedError as e:
                log.warning("skipping %s: %s", s, e)
        return total

    loader = COUNTY_LOADERS.get(source)
    if loader is None:
        raise SystemExit(f"unknown --source {source!r}")

    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url and os.environ.get("PARCEL_INGEST_DRYRUN") != "1":
        raise SystemExit("SUPABASE_DB_URL env var required (or PARCEL_INGEST_DRYRUN=1)")

    log.info("starting ingest source=%s", source)
    with psycopg.connect(db_url, row_factory=dict_row) if db_url else _NullConn() as conn:
        written = write_batches(loader(), conn)
    log.info("done source=%s rows=%d", source, written)
    return written


class _NullConn:
    """No-op connection for dryrun smoke-tests without a Postgres URL."""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        raise RuntimeError("dryrun: no real cursor")

    def commit(self):
        pass


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--source",
        required=True,
        choices=["all", "fgio", "seminole", "orange", "lake", "osceola", "volusia"],
        help="Which feed to ingest. 'all' runs every implemented adapter.",
    )
    args = p.parse_args()
    run(args.source)


if __name__ == "__main__":
    main()

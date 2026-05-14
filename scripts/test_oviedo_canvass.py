#!/usr/bin/env python3
"""
test_oviedo_canvass.py — one-off manual canvass-list run.

Standalone. No Supabase needed. Built to validate the full pipeline
end-to-end against yesterday's real Oviedo hail event (2026-05-12,
1.00" hail at 28.68, -81.22, 16:01 UTC):

  1. Pulls residential addresses near the hail center from
     OpenStreetMap via Overpass (free, public, no auth).
  2. Sorts by distance to the hail point.
  3. Takes top-N (default 20).
  4. For each address, queries Seminole County permit portal via
     CloakBrowser and parses the result.
  5. Applies the hot-lead scoring rubric.
  6. Writes a CSV to stdout (or --out path).

Usage:
  python scripts/test_oviedo_canvass.py
  python scripts/test_oviedo_canvass.py --top-n 20 --out /tmp/oviedo.csv
  python scripts/test_oviedo_canvass.py --debug    # screenshots + page dumps

CloakBrowser must be installed in the venv:
  pip install -r scripts/requirements-permits.txt

First run downloads a ~200MB stealth Chromium binary (cached at
~/.cache/cloakbrowser/).
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import math
import random
import re
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path

import httpx
from dateutil import parser as dateparser

# Shared skip-trace helpers (TruePeopleSearch / FastPeopleSearch / etc).
# Sibling import works because both files live in scripts/.
import os as _os
sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from skip_trace import skip_trace_phone, PhoneFinding  # noqa: E402


# ─── Storm context (real data from IEM, 2026-05-12) ───────────────────────

STORM_DATE = dt.date(2026, 5, 12)
HAIL_LAT = 28.68
HAIL_LNG = -81.22
HAIL_INCHES = 1.00
HAIL_RADIUS_MILES = 1.5

# ─── Scoring (kept in sync with lib/parcel-canvass.ts::scoreHotLead) ──────

ROOF_PERMIT_PATTERN = re.compile(
    r"\b("
    r"re-?roof"
    r"|roof\s*(replace(ment)?|repair)"
    r"|new\s*roof"
    r"|roofing"
    r"|building\s*[-–—\s]\s*roof"
    r"|roof"
    r")\b",
    re.IGNORECASE,
)

# Seminole's StreetType dropdown uses the FULL word in uppercase.
# Customer addresses use short suffixes ("CT", "DR", "RD"). Map between
# them — the dropdown is REQUIRED by the portal, missing it fails the
# search with a validation error and we get back zero results.
STREET_SUFFIX_MAP = {
    "ALY": "ALLEY", "ALLEY": "ALLEY",
    "AVE": "AVENUE", "AVENUE": "AVENUE",
    "BLVD": "BOULEVARD", "BOULEVARD": "BOULEVARD",
    "CIR": "CIRCLE", "CIRCLE": "CIRCLE",
    "CT": "COURT", "COURT": "COURT",
    "CV": "COVE", "COVE": "COVE",
    "CRES": "CRESCENT", "CRESCENT": "CRESCENT",
    "XING": "CROSSING", "CROSSING": "CROSSING",
    "DR": "DRIVE", "DRIVE": "DRIVE",
    "HWY": "HIGHWAY", "HIGHWAY": "HIGHWAY",
    "HL": "HILL", "HILL": "HILL",
    "HOLW": "HOLLOW", "HOLLOW": "HOLLOW",
    "LN": "LANE", "LANE": "LANE",
    "LOOP": "LOOP",
    "PKWY": "PARKWAY", "PARKWAY": "PARKWAY",
    "PATH": "PATH",
    "PL": "PLACE", "PLACE": "PLACE",
    "PLZ": "PLAZA", "PLAZA": "PLAZA",
    "RD": "ROAD", "ROAD": "ROAD",
    "RUN": "RUN",
    "SQ": "SQUARE", "SQUARE": "SQUARE",
    "ST": "STREET", "STREET": "STREET",
    "TER": "TERRACE", "TERRACE": "TERRACE",
    "TRCE": "TRACE", "TRACE": "TRACE",
    "TRL": "TRAIL", "TRAIL": "TRAIL",
    "WAY": "WAY",
    "VW": "VIEW", "VIEW": "VIEW",
    "VLG": "VILLAGE", "VILLAGE": "VILLAGE",
}


# ─── Data shapes ──────────────────────────────────────────────────────────


@dataclass
class Address:
    address_line: str
    city: str
    zip: str
    lat: float
    lng: float
    distance_miles: float
    building_kind: str


@dataclass
class PermitFinding:
    has_recent_roof_permit: bool | None
    last_permit_type: str | None
    last_permit_date: dt.date | None
    last_permit_number: str | None
    raw_summary: str
    portal_error: str | None = None


@dataclass
class CanvassRow:
    rank: int
    address_line: str
    city: str
    zip: str
    lat: float
    lng: float
    distance_miles: float
    hail_inches: float
    storm_date: str
    year_built: int | None
    home_age: int | None
    has_recent_roof_permit: bool | None
    last_permit_date: str | None
    last_permit_type: str | None
    phone_number: str | None
    phone_source: str | None
    phone_confidence: str | None
    score: float
    notes: str


# ─── Geometry ─────────────────────────────────────────────────────────────


def haversine_mi(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 3958.7613
    rl1, rl2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rl1) * math.cos(rl2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ─── Address harvest (Overpass) ───────────────────────────────────────────


OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def fetch_addresses_overpass(top_n: int) -> list[Address]:
    """Query Overpass for address-tagged residential buildings near the
    hail center. Returns the top-N closest. Tries multiple Overpass
    mirrors with backoff — the main endpoint is regularly overloaded."""
    radius_m = int(HAIL_RADIUS_MILES * 1609.344)
    query = f"""
[out:json][timeout:25];
(
  way["building"]["addr:housenumber"](around:{radius_m},{HAIL_LAT},{HAIL_LNG});
  node["addr:housenumber"](around:{radius_m},{HAIL_LAT},{HAIL_LNG});
);
out center 400;
"""
    headers = {
        "User-Agent": "Voxaris-Canvass-Test (+admin@voxaris.io)",
    }
    print(f"  → fetching addresses near {HAIL_LAT},{HAIL_LNG} (radius {HAIL_RADIUS_MILES}mi)…", file=sys.stderr)

    data = None
    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            print(f"    trying {endpoint}…", file=sys.stderr)
            with httpx.Client(timeout=45.0, headers=headers) as c:
                r = c.post(endpoint, data={"data": query})
                r.raise_for_status()
                data = r.json()
                print(f"    ok via {endpoint}", file=sys.stderr)
                break
        except Exception as e:
            last_err = e
            print(f"    failed: {type(e).__name__}: {e}", file=sys.stderr)
            time.sleep(2.0)
    if data is None:
        raise RuntimeError(f"all Overpass endpoints failed; last error: {last_err}")

    residential = {"house", "residential", "detached", "semidetached_house",
                   "bungalow", "terrace", "yes"}
    addrs: list[Address] = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        hn = tags.get("addr:housenumber")
        street = tags.get("addr:street")
        if not hn or not street:
            continue
        if el["type"] == "way":
            c_ = el.get("center", {})
            lat, lng = c_.get("lat"), c_.get("lon")
        else:
            lat, lng = el.get("lat"), el.get("lon")
        if lat is None or lng is None:
            continue
        bldg = tags.get("building", "")
        if bldg not in residential:
            continue
        addrs.append(Address(
            address_line=f"{hn} {street}".upper(),
            city=(tags.get("addr:city") or "").upper(),
            zip=tags.get("addr:postcode") or "",
            lat=lat,
            lng=lng,
            distance_miles=haversine_mi(HAIL_LAT, HAIL_LNG, lat, lng),
            building_kind=bldg,
        ))

    addrs.sort(key=lambda a: a.distance_miles)
    # Dedupe on address — OSM sometimes has the same house tagged twice
    seen = set()
    deduped: list[Address] = []
    for a in addrs:
        key = (a.address_line, a.zip)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(a)

    print(f"  → got {len(deduped)} unique residential addresses; taking top {top_n}", file=sys.stderr)
    return deduped[:top_n]


# ─── Seminole permit portal via CloakBrowser ──────────────────────────────


# Real Seminole County permit search portal — found via
# seminolecountyfl.gov/departments-services/development-services/building.
# Two candidates; primary is the BuildingPermitWebInquiry portal.
SEMINOLE_PERMIT_SEARCH = "https://scccap01.seminolecountyfl.gov/BuildingPermitWebInquiry/"
SEMINOLE_PERMIT_FALLBACK = "https://scwebapp2.seminolecountyfl.gov:6443/contractorpermitinquiry/"

# Seminole County Property Appraiser — different system from the permit
# portal. Public parcel records including YEAR_BUILT, OWNER_NAME,
# JUST_VALUE, etc. We hit this in the same CloakBrowser session as the
# permit search, separately for each address, to get year_built before
# applying the hot-lead scoring rubric.
#
# scpafl.org publishes a "Parcel Search" page that accepts address
# queries. Until we apply the parcels migration + run the full ingest,
# this is the per-address year_built source for the test script.
SCPA_PARCEL_SEARCH = "https://www.scpafl.org/ParcelDetails"


def query_scpa_year_built(page, addr: Address, debug_dir: Path | None) -> int | None:
    """Query Seminole County Property Appraiser for year_built. Hits
    the public Parcel Search page, fills the address, parses the
    resulting parcel-details page for the "Year Built" / "Actual Year
    Built" field.

    Returns None on any failure — the caller still scores the address
    using base + recency, just without the new-construction short-
    circuit. That biases scores slightly hot on misses, which is the
    safer failure mode (over-canvass a few houses vs. miss a real one).

    NOTE: this is a stop-gap until the parcels migration + full FGIO
    ingest land. At that point year_built comes from the parcels
    table in O(1), no portal query needed.
    """
    try:
        # SCPA's main search portal — the front-end is JS-rendered, so
        # we use CloakBrowser to navigate. The search form lives at
        # scpafl.org and submits to a parcel-details page.
        page.goto("https://www.scpafl.org/", wait_until="domcontentloaded", timeout=20_000)
    except Exception as e:
        log_dbg(f"scpa goto failed: {e}")
        return None

    # SCPA's search input changes across portal versions. Try a few
    # selector patterns, fall back to the search box we can find.
    search_selectors = [
        "input[id*='ParcelSearch']",
        "input[name*='ParcelSearch']",
        "input[placeholder*='earch']",
        "input[type='search']",
        "input.search",
        "#searchBox",
    ]

    filled = False
    full_addr = f"{addr.address_line} {addr.city} {addr.zip}".strip()
    for s in search_selectors:
        try:
            if page.locator(s).count() > 0:
                page.fill(s, full_addr, timeout=3_000)
                page.press(s, "Enter")
                filled = True
                break
        except Exception:
            continue
    if not filled:
        log_dbg("scpa: no search input found")
        return None

    try:
        page.wait_for_load_state("domcontentloaded", timeout=15_000)
        # Brief settle for JS-rendered result page
        page.wait_for_timeout(2000)
    except Exception:
        pass

    if debug_dir:
        try:
            page.screenshot(
                path=str(debug_dir / f"{addr.address_line[:25]}_scpa.png")
            )
            (debug_dir / f"{addr.address_line[:25]}_scpa.html").write_text(
                page.content(), encoding="utf-8"
            )
        except Exception:
            pass

    # Parse year built from the rendered text. SCPA labels it as
    # "Year Built", "Actual Year Built", or "ACT YR BLT" depending on
    # the page section. Regex out the first reasonable year.
    try:
        body_text = page.locator("body").inner_text()[:20_000]
    except Exception:
        return None

    # Be picky — "Year Built 2020" or "Actual Year Built: 1992" patterns.
    # Avoid matching random 4-digit numbers elsewhere on the page.
    m = re.search(
        r"(?:actual\s+)?year\s*built\s*[:\-]?\s*(\d{4})",
        body_text,
        re.IGNORECASE,
    )
    if m:
        year = int(m.group(1))
        if 1900 <= year <= dt.date.today().year:
            return year
    return None


def log_dbg(msg: str) -> None:
    print(f"    [scpa] {msg}", file=sys.stderr)


def query_seminole_permit(page, addr: Address, debug_dir: Path | None) -> PermitFinding:
    """Search Seminole permit portal for one address. Returns
    PermitFinding with all None / portal_error set when the portal
    didn't load or selectors didn't resolve — the script keeps
    going for the other 19 addresses."""
    m = re.match(r"^\s*(\d+)\s+(.+?)\s*$", addr.address_line)
    if not m:
        return PermitFinding(None, None, None, None, "address parse failed",
                              portal_error="address_parse")
    street_num, street_name = m.group(1), m.group(2)
    # Strip common suffixes that some portals don't want
    street_name_clean = re.sub(
        r"\s+(DR|RD|ST|AVE|LN|BLVD|CT|WAY|CIR|TRL|PL|TER|CV|XING|HWY)\.?$",
        "", street_name, flags=re.IGNORECASE,
    ).strip()
    # Map the suffix to Seminole's StreetType dropdown value (full word).
    # The portal REQUIRES this dropdown — without it the search returns
    # validation errors and zero results.
    suffix_match = re.search(
        r"\s+(\w+)\.?$", street_name, flags=re.IGNORECASE,
    )
    street_type = None
    if suffix_match:
        street_type = STREET_SUFFIX_MAP.get(suffix_match.group(1).upper())

    last_goto_err = None
    for portal in (SEMINOLE_PERMIT_SEARCH, SEMINOLE_PERMIT_FALLBACK):
        try:
            page.goto(portal, wait_until="domcontentloaded", timeout=25_000)
            last_goto_err = None
            break
        except Exception as e:
            last_goto_err = e
    if last_goto_err is not None:
        return PermitFinding(None, None, None, None, "",
                              portal_error=f"goto-all-failed: {last_goto_err}")

    if debug_dir:
        try:
            page.screenshot(path=str(debug_dir / f"{street_num}_{street_name_clean[:20]}_landing.png"))
            (debug_dir / f"{street_num}_{street_name_clean[:20]}_landing.html").write_text(
                page.content(), encoding="utf-8"
            )
        except Exception:
            pass

    # Seminole's BuildingPermitWebInquiry portal is an ASP.NET WebForms
    # app with Telerik AjaxControlToolkit. The address fields are
    # hidden until you pick "Address" from the SearchByDropDownList,
    # which fires a partial postback (UpdatePanel) that swaps in the
    # form. Step one: select Address. Step two: wait for any of the
    # address-input candidates to actually appear — DON'T wait for
    # networkidle, because Telerik keeps long-polling forever and
    # networkidle never fires (which is why our first run timed out
    # at 12s with the page itself fully loaded).
    candidate_inputs = ", ".join([
        "input[id*='StreetNumber']",
        "input[id*='HouseNumber']",
        "input[id*='AddressNumber']",
        "input[name*='StreetNumber']",
        "input[id$='StreetNumberTextBox']",
    ])
    dropdown_err = None
    try:
        dd = page.locator("select[id*='SearchByDropDownList']")
        if dd.count() > 0:
            dd.select_option("Address")
            # Wait for the form to materialize. The partial postback is
            # fast (<1s on a good day), but allow up to 10s.
            try:
                page.wait_for_selector(candidate_inputs, state="visible", timeout=10_000)
            except Exception:
                # Inputs didn't appear under any candidate selector —
                # don't fail hard, save the artifacts and fall through
                # to the fill attempt. That step will report a clearer
                # error if the form really didn't render.
                page.wait_for_timeout(1500)
        else:
            dropdown_err = "SearchByDropDownList not found"
    except Exception as e:
        dropdown_err = f"select-option failed: {e}"

    # ALWAYS save the post-dropdown artifacts — useful for diagnosing
    # selector misses even when the dropdown step itself succeeded.
    if debug_dir:
        try:
            page.screenshot(path=str(debug_dir / f"{street_num}_{street_name_clean[:20]}_after_dropdown.png"))
            (debug_dir / f"{street_num}_{street_name_clean[:20]}_after_dropdown.html").write_text(
                page.content(), encoding="utf-8"
            )
        except Exception:
            pass

    if dropdown_err:
        return PermitFinding(None, None, None, None, "",
                              portal_error=f"dropdown: {dropdown_err}")

    # Try a few selector variants — the actual portal markup is what
    # we'll discover via debug screenshots. Each variant fails fast.
    # Selectors verified against the real Seminole portal markup
    # captured in /tmp/oviedo_debug/*_after_dropdown.html:
    #   StreetNumberTextBox / StreetNameTextBox / ZipCode / SubmitButton
    # CRITICAL: do NOT match `Search` substring — there's a
    # SearchImageButton that's a form-COLLAPSE toggle, not the search
    # button. Clicking it hides the form. Earlier run did exactly
    # that, which is why every row came back "no permits returned."
    selectors_num = [
        "input[id$='StreetNumberTextBox']",
        "input[name$='StreetNumberTextBox']",
        "input[id*='StreetNumber']",
    ]
    selectors_name = [
        "input[id$='StreetNameTextBox']",
        "input[name$='StreetNameTextBox']",
        "input[id*='StreetName']",
    ]
    selectors_zip = [
        "input[id$='_ZipCode']",
        "input[name$='ZipCode']",
        "input[id*='ZipCode']",
    ]
    selectors_submit = [
        # Exact-ID match first — most reliable
        "input[id$='SubmitButton']",
        "input[name$='SubmitButton']",
        "input[type='submit'][value='Submit']",
        "input[type='submit']",
    ]

    filled_num = False
    for s in selectors_num:
        try:
            if page.locator(s).count() > 0:
                page.fill(s, street_num, timeout=3_000)
                filled_num = True
                break
        except Exception:
            continue
    if not filled_num:
        return PermitFinding(None, None, None, None, "", portal_error="no_street_num_input")

    filled_name = False
    for s in selectors_name:
        try:
            if page.locator(s).count() > 0:
                page.fill(s, street_name_clean, timeout=3_000)
                filled_name = True
                break
        except Exception:
            continue
    if not filled_name:
        return PermitFinding(None, None, None, None, "", portal_error="no_street_name_input")

    # Street Type dropdown — REQUIRED by the portal. Without it,
    # validation fails and the search returns "no Permits for the
    # address searched" even on real addresses.
    if street_type:
        for s in [
            "select[id$='StreetTypeDropDownList']",
            "select[name$='StreetTypeDropDownList']",
            "select[id*='StreetType']",
            "select[id*='StreetSuffix']",
        ]:
            try:
                if page.locator(s).count() > 0:
                    page.select_option(s, value=street_type)
                    break
            except Exception:
                # Try by label if value match fails — some portals
                # store the dropdown options with leading whitespace.
                try:
                    page.select_option(s, label=street_type)
                    break
                except Exception:
                    continue

    # Zip code — best-effort. If the portal requires it (some configs
    # do) the search will fail silently without it. If it doesn't,
    # filling it just narrows results, which is fine.
    if addr.zip:
        for s in selectors_zip:
            try:
                if page.locator(s).count() > 0:
                    page.fill(s, addr.zip, timeout=2_000)
                    break
            except Exception:
                continue

    clicked = False
    for s in selectors_submit:
        try:
            if page.locator(s).count() > 0:
                page.click(s, timeout=3_000)
                clicked = True
                break
        except Exception:
            continue
    if not clicked:
        return PermitFinding(None, None, None, None, "", portal_error="no_submit_button")

    try:
        page.wait_for_load_state("networkidle", timeout=12_000)
    except Exception:
        pass

    if debug_dir:
        try:
            page.screenshot(path=str(debug_dir / f"{street_num}_{street_name_clean[:20]}_results.png"))
            (debug_dir / f"{street_num}_{street_name_clean[:20]}_results.html").write_text(
                page.content(), encoding="utf-8"
            )
        except Exception:
            pass

    # Check for portal-explicit "no permits" message before parsing —
    # avoids returning a misleading "parse failed" when the search
    # actually ran and returned a legitimate empty result.
    try:
        body_text = page.locator("body").inner_text()[:8000]
    except Exception:
        body_text = ""
    no_records_pattern = re.compile(
        r"(no permits? for the address searched"
        r"|no records? (found|matching|to display)"
        r"|0 results?"
        r"|no matching results)",
        re.IGNORECASE,
    )
    if no_records_pattern.search(body_text):
        # Real empty result — return the canonical "no permit on file"
        # finding. has_recent_roof_permit=False, last_permit_date=None
        # is exactly what the hot-lead scorer wants for "+50 / hot".
        return PermitFinding(False, None, None, None,
                              "portal: no permits for this address",
                              portal_error=None)

    # Parse the result table — generic enough to catch a few common
    # table shapes (Telerik RadGrid, plain HTML tables, etc.)
    permits: list[dict] = []
    for table_sel in [
        "table.rgMasterTable tr",  # Telerik RadGrid main table
        "table[id*='Result'] tr",
        "table.results tr",
        "table tbody tr",
        "table tr",
    ]:
        rows = page.query_selector_all(table_sel)
        if len(rows) <= 1:
            continue
        for tr in rows[1:]:
            cells = [td.inner_text().strip() for td in tr.query_selector_all("td")]
            if len(cells) < 3:
                continue
            permits.append({"number": cells[0], "type": cells[1], "date": cells[2]})
        if permits:
            break

    return summarize_permits(permits)


def summarize_permits(permits: list[dict]) -> PermitFinding:
    if not permits:
        return PermitFinding(False, None, None, None, "no permits returned by portal")
    most_recent = None
    most_recent_date = None
    for p in permits:
        if not ROOF_PERMIT_PATTERN.search(p.get("type", "") or ""):
            continue
        try:
            pd = dateparser.parse(p.get("date", "") or "").date()
        except (ValueError, TypeError):
            continue
        if most_recent_date is None or pd > most_recent_date:
            most_recent = p
            most_recent_date = pd
    if most_recent is None:
        summary = "\n".join(f"{p.get('date','?')} {p.get('type','?')} #{p.get('number','?')}"
                             for p in permits[:5])
        return PermitFinding(False, None, None, None, summary[:4000])
    return PermitFinding(
        True,
        most_recent.get("type"),
        most_recent_date,
        most_recent.get("number"),
        f"{most_recent_date} {most_recent.get('type')} #{most_recent.get('number')}"[:4000],
    )


# ─── Hot-lead scoring (port of lib/parcel-canvass.ts::scoreHotLead) ───────
# Kept BIT-FOR-BIT identical with the canonical TS implementation. Three
# things must stay in sync across:
#   * lib/parcel-canvass.ts::scoreHotLead
#   * scripts/enrich_permits.py::score_hot_lead
#   * THIS function
# If you change one, change all three. The score column drives the rep
# UI sort order; drift = misranked canvass lists.


def score_hot_lead(
    distance_miles: float,
    last_permit_date: dt.date | None,
    year_built: int | None = None,
) -> float:
    base = HAIL_INCHES * 10 * (1 / (1 + max(0.0, distance_miles)))
    score = base
    today = dt.date.today()

    # Post-storm activity penalty — competitor already moved on the
    # property. Returns early; the recency bonus shouldn't also fire
    # for a permit pulled in response to this storm.
    if last_permit_date and last_permit_date > STORM_DATE:
        return round(max(-200, min(200, score - 100)), 2)

    # New-construction short-circuit — see lib/parcel-canvass.ts.
    # <10 yr home = original roof, under warranty, "no permit" expected,
    # not a hot-lead signal. Return base only.
    if year_built is not None:
        home_age = today.year - year_built
        if home_age < 10:
            return round(max(-200, min(200, score)), 2)

    # Roof permit recency tier
    if last_permit_date is None:
        years_since = float("inf")
    else:
        years_since = (today - last_permit_date).days / 365.25

    if years_since < 5:
        score += -40
    elif years_since >= 15:
        score += 50
    elif years_since >= 10:
        score += 30
    # 5-10 years = neutral (no bonus, no penalty)

    # Estimated roof age bonus (only fires for 20+ yr homes — already
    # past the <10 yr short-circuit above).
    if year_built is not None:
        home_age = today.year - year_built
        no_recent_permit = years_since >= 10
        if home_age > 20 and no_recent_permit:
            score += 25

    return round(max(-200, min(200, score)), 2)


# ─── Main ─────────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--top-n", type=int, default=20)
    p.add_argument("--out", type=str, default="-", help="CSV path or '-' for stdout")
    p.add_argument("--debug", action="store_true",
                    help="Save screenshots + HTML to /tmp/oviedo_debug/")
    p.add_argument("--skip-portal", action="store_true",
                    help="Skip CloakBrowser; emit CSV with permit columns blank")
    args = p.parse_args()

    print(f"[oviedo-test] storm: {STORM_DATE} {HAIL_INCHES}\" hail @ {HAIL_LAT},{HAIL_LNG}", file=sys.stderr)
    addrs = fetch_addresses_overpass(args.top_n)
    if not addrs:
        print("[oviedo-test] no addresses returned from Overpass — aborting", file=sys.stderr)
        sys.exit(1)

    debug_dir = None
    if args.debug:
        debug_dir = Path("/tmp/oviedo_debug")
        debug_dir.mkdir(parents=True, exist_ok=True)
        print(f"[oviedo-test] debug artifacts → {debug_dir}", file=sys.stderr)

    rows: list[CanvassRow] = []

    if args.skip_portal:
        print("[oviedo-test] --skip-portal set, no permit queries", file=sys.stderr)
        for i, a in enumerate(addrs, 1):
            score = score_hot_lead(a.distance_miles, None)
            rows.append(CanvassRow(
                rank=i, address_line=a.address_line, city=a.city, zip=a.zip,
                lat=a.lat, lng=a.lng, distance_miles=round(a.distance_miles, 3),
                hail_inches=HAIL_INCHES, storm_date=STORM_DATE.isoformat(),
                year_built=None, home_age=None,
                has_recent_roof_permit=None, last_permit_date=None,
                last_permit_type=None,
                phone_number=None, phone_source=None, phone_confidence=None,
                score=score,
                notes="permit lookup skipped",
            ))
    else:
        from cloakbrowser import launch
        print("[oviedo-test] launching CloakBrowser (first run downloads ~200MB)…", file=sys.stderr)
        with launch(humanize=True) as browser:
            ctx = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/130.0.0.0 Safari/537.36 "
                    "Voxaris-Canvass-Test (+admin@voxaris.io)"
                ),
            )
            page = ctx.new_page()
            for i, a in enumerate(addrs, 1):
                print(f"  [{i}/{len(addrs)}] {a.address_line} ({a.distance_miles:.2f} mi)…",
                      file=sys.stderr)
                # Step 1 — permit lookup (Seminole BuildingPermitWebInquiry)
                try:
                    finding = query_seminole_permit(page, a, debug_dir)
                except Exception as e:
                    finding = PermitFinding(None, None, None, None, "",
                                            portal_error=f"exception: {e}")
                # Polite-scrape pause BETWEEN the two portals so we
                # don't double-hit Seminole back-to-back.
                time.sleep(random.uniform(2.0, 3.0))
                # Step 2 — year_built lookup (Seminole Property Appraiser).
                # This is critical for accurate scoring: a 4yr-old home
                # with "no permit" is NOT hot (warranty roof), it's a
                # cold lead. Without year_built the scoring biases hot.
                try:
                    year_built = query_scpa_year_built(page, a, debug_dir)
                except Exception as e:
                    print(f"    scpa exception: {e}", file=sys.stderr)
                    year_built = None
                if year_built:
                    home_age = dt.date.today().year - year_built
                    print(f"    year_built={year_built} (age {home_age}yr)", file=sys.stderr)
                else:
                    print("    year_built=unknown (scoring without age signal)",
                          file=sys.stderr)
                score = score_hot_lead(
                    a.distance_miles, finding.last_permit_date, year_built,
                )

                # Step 3 — skip-trace phone enrichment via the shared
                # module. Polite-scrape pause built into the module
                # itself between sources.
                time.sleep(random.uniform(2.0, 3.0))
                try:
                    phone_finding = skip_trace_phone(
                        page,
                        a.address_line,
                        a.city,
                        a.zip,
                        owner_name=None,  # Overpass doesn't give us owner
                        debug_dir=debug_dir,
                    )
                except Exception as e:
                    print(f"    skip-trace exception: {e}", file=sys.stderr)
                    phone_finding = PhoneFinding(None, None, None, "", error=str(e))
                if phone_finding.phone_number:
                    print(
                        f"    phone={phone_finding.phone_number} "
                        f"({phone_finding.source}, {phone_finding.confidence} confidence)",
                        file=sys.stderr,
                    )
                else:
                    print("    phone=unknown", file=sys.stderr)

                # Compose a notes string that surfaces year_built when
                # known so the CSV reader doesn't have to guess.
                base_note = finding.portal_error or finding.raw_summary[:80]
                year_note = f" · built {year_built}" if year_built else ""
                rows.append(CanvassRow(
                    rank=i,
                    address_line=a.address_line,
                    city=a.city,
                    zip=a.zip,
                    lat=a.lat,
                    lng=a.lng,
                    distance_miles=round(a.distance_miles, 3),
                    hail_inches=HAIL_INCHES,
                    storm_date=STORM_DATE.isoformat(),
                    year_built=year_built,
                    home_age=(dt.date.today().year - year_built) if year_built else None,
                    has_recent_roof_permit=finding.has_recent_roof_permit,
                    last_permit_date=(finding.last_permit_date.isoformat()
                                        if finding.last_permit_date else None),
                    last_permit_type=finding.last_permit_type,
                    phone_number=phone_finding.phone_number,
                    phone_source=phone_finding.source,
                    phone_confidence=phone_finding.confidence,
                    score=score,
                    notes=(base_note + year_note).strip(),
                ))
                # Polite-scrape rate limit between addresses
                time.sleep(random.uniform(3.0, 5.0))

    # Re-sort by final score for the output
    rows.sort(key=lambda r: r.score, reverse=True)
    for i, r in enumerate(rows, 1):
        r.rank = i

    # Write CSV
    fieldnames = list(asdict(rows[0]).keys())
    if args.out == "-":
        w = csv.DictWriter(sys.stdout, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(asdict(r))
    else:
        with open(args.out, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            for r in rows:
                w.writerow(asdict(r))
        print(f"[oviedo-test] wrote {len(rows)} rows → {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
enrich_permits.py — flag canvass_targets with recent-roof-permit data.

Runs AFTER storm-pulse populates canvass_targets. Pulls the top-N
ranked rows where permit_checked_at is null, queries each county's
permit portal via CloakBrowser, parses the result, and writes
has_recent_roof_permit / last_permit_date / last_permit_number back
to the row.

Why CloakBrowser instead of plain Playwright:
  Seminole's citizenservice portal sits behind a Cloudflare challenge
  that headless Chromium fails. CloakBrowser's source-level fingerprint
  patches pass the challenge with no extra code. Same Python API as
  Playwright — drop-in replacement.

Polite-scrape posture (these are NOT optional):
  * Volume cap: TOP_N default 500 per run. Configurable via env.
  * Rate limit: 3-5 second randomized interval between queries.
    Single concurrent worker. No parallel requests against any county.
  * Identifying User-Agent: "Voxaris-Canvass-Bot (+hello@voxaris.io)"
    appended to the standard UA so the county IT team can identify us
    and reach out if there's an issue.
  * Respect robots.txt: probed once per county at startup. If
    Disallow matches the search path, we abort that county and log it.
  * Public records only: every county portal we hit publishes permit
    data under FL Sunshine Law. No login walls, no paywalls.
  * Fail open: any single-address error is logged + marked
    permit_checked_at=now with has_recent_roof_permit=null, so the
    canvass list isn't blocked on a flaky portal.

Usage:
  enrich_permits.py --county seminole --top-n 500
  enrich_permits.py --county orange --top-n 200
  enrich_permits.py --county all

Env vars (required):
  SUPABASE_DB_URL    — service-role Postgres connection
Optional:
  PERMIT_TOP_N       — override default of 500
  PERMIT_DRYRUN      — "1" to run portal queries but skip the DB write
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import random
import re
import sys
import time
import urllib.robotparser
from dataclasses import dataclass
from typing import Callable, Iterable
from urllib.parse import urlparse

import psycopg
from dateutil import parser as dateparser

try:
    from cloakbrowser import launch
except ImportError:
    print(
        "FATAL: cloakbrowser not installed. "
        "Run `pip install -r scripts/requirements-permits.txt`.",
        file=sys.stderr,
    )
    sys.exit(1)


logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="[%(asctime)s] %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("enrich_permits")


# ─── Posture ───────────────────────────────────────────────────────────────

CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "hello@voxaris.io")
USER_AGENT_SUFFIX = f"Voxaris-Canvass-Bot (+{CONTACT_EMAIL})"

DEFAULT_TOP_N = int(os.environ.get("PERMIT_TOP_N", "500"))
RATE_LIMIT_MIN_SEC = 3.0
RATE_LIMIT_MAX_SEC = 5.0

# Permit types we count as roof activity. Matches the Noland's canvass
# rubric's keyword list verbatim, with variant spelling tolerance:
#   roof | reroof | re-roof | roof replacement | roof repair |
#   building – roof  (em-dash, en-dash, hyphen, or space all OK)
# Anything that doesn't match the regex is non-roof permit activity
# (pool, fence, HVAC, etc.) and is ignored by the scoring logic.
ROOF_PERMIT_PATTERN = re.compile(
    r"\b("
    r"re-?roof"                              # reroof, re-roof
    r"|roof\s*(replace(ment)?|repair)"       # roof replacement, roof repair
    r"|new\s*roof"                            # new roof
    r"|roofing"                               # roofing
    r"|building\s*[-–—\s]\s*roof"             # building – roof (any dash/space)
    r"|roof"                                  # bare "roof" — fallback (least specific)
    r")\b",
    re.IGNORECASE,
)

# We track ALL roof permits going back as far as the portal returns,
# not just the last 24 months. The hot-lead scoring rubric needs to
# distinguish "permit < 5 yrs" (cold) from "permit 10-15 yrs" (warm)
# from ">15 yrs or never" (hot), so we surface the actual last-permit
# date and let the scorer apply the tiered bonuses.
PORTAL_LOOKBACK_DAYS = 25 * 365  # 25 years — plenty for the 15-year recency tier


# ─── Models ────────────────────────────────────────────────────────────────


@dataclass
class CanvassRow:
    id: str
    address_line: str
    city: str | None
    zip: str | None
    score: float
    # Context needed for the hot-lead re-score after permit data is in
    storm_date: dt.date
    year_built: int | None


@dataclass
class PermitFinding:
    has_recent_roof_permit: bool
    last_permit_type: str | None
    last_permit_date: dt.date | None
    last_permit_number: str | None
    raw_summary: str


# ─── County adapters ───────────────────────────────────────────────────────


def _check_robots(portal_url: str) -> bool:
    """Probe robots.txt at the portal origin. Returns True if our
    User-Agent is allowed at the path. False = abort that county."""
    try:
        parsed = urlparse(portal_url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(robots_url)
        rp.read()
        allowed = rp.can_fetch(USER_AGENT_SUFFIX, portal_url)
        log.info("robots.txt at %s → allowed=%s", robots_url, allowed)
        return allowed
    except Exception as e:
        # If robots is missing or unreachable, default-allow with a
        # warning. This is the conservative choice for sites that
        # don't publish a robots.txt at all.
        log.warning("robots.txt probe failed (%s); default-allow", e)
        return True


def query_seminole(page, row: CanvassRow) -> PermitFinding | None:
    """Seminole County permit portal.

    Portal: https://citizenservice.seminolecountyfl.gov/
    Search path: /Permits/SearchByAddress.aspx (or equivalent ASPX
    search form depending on portal version).

    Returns None on a parse/portal failure (caller marks checked_at
    but leaves has_recent_roof_permit null). Returns a populated
    PermitFinding otherwise.
    """
    SEARCH_URL = "https://citizenservice.seminolecountyfl.gov/Permits/SearchByAddress.aspx"
    try:
        page.goto(SEARCH_URL, wait_until="networkidle", timeout=20_000)
        # Address input — selectors verified against the public portal.
        # If Seminole changes their portal markup, update here and the
        # script keeps working for everyone else.
        page.fill("input[id*='StreetNumber']", _parse_street_number(row.address_line))
        page.fill("input[id*='StreetName']", _parse_street_name(row.address_line))
        page.click("input[id*='SearchButton']")
        page.wait_for_load_state("networkidle", timeout=15_000)
        # Result table rows
        rows = page.query_selector_all("table.results tr, table[id*='Results'] tr")
        permits: list[dict] = []
        for tr in rows[1:]:  # skip header
            cells = [td.inner_text().strip() for td in tr.query_selector_all("td")]
            if len(cells) < 4:
                continue
            permits.append({
                "number": cells[0],
                "type":   cells[1],
                "date":   cells[2],
                "status": cells[3] if len(cells) > 3 else None,
            })
        return _summarize_permits(permits)
    except Exception as e:
        log.warning("seminole query failed for %s: %s", row.address_line, e)
        return None


def query_orange(page, row: CanvassRow) -> PermitFinding | None:
    """Orange County FastTrack permit portal.

    Portal: https://fasttrack.ocfl.net/
    Search: /OnlineServices/Permits/Search

    Same fail-open semantics as Seminole.
    """
    SEARCH_URL = "https://fasttrack.ocfl.net/OnlineServices/Permits/Search"
    try:
        page.goto(SEARCH_URL, wait_until="networkidle", timeout=20_000)
        page.fill("input[name='address']", row.address_line)
        page.click("button[type='submit']")
        page.wait_for_load_state("networkidle", timeout=15_000)
        rows = page.query_selector_all("table tbody tr")
        permits: list[dict] = []
        for tr in rows:
            cells = [td.inner_text().strip() for td in tr.query_selector_all("td")]
            if len(cells) < 4:
                continue
            permits.append({
                "number": cells[0],
                "type":   cells[1],
                "date":   cells[2],
                "status": cells[3] if len(cells) > 3 else None,
            })
        return _summarize_permits(permits)
    except Exception as e:
        log.warning("orange query failed for %s: %s", row.address_line, e)
        return None


COUNTY_QUERIES: dict[str, dict] = {
    "seminole": {
        "portal_url": "https://citizenservice.seminolecountyfl.gov/Permits/",
        "query": query_seminole,
        "county_fips": "12117",
    },
    "orange": {
        "portal_url": "https://fasttrack.ocfl.net/OnlineServices/Permits/",
        "query": query_orange,
        "county_fips": "12095",
    },
}


# ─── Parsing helpers ───────────────────────────────────────────────────────


def _parse_street_number(address: str) -> str:
    m = re.match(r"^\s*(\d+)\b", address or "")
    return m.group(1) if m else ""


def _parse_street_name(address: str) -> str:
    """Strip leading number + trailing unit/apt/suite, return the rest."""
    s = re.sub(r"^\s*\d+\s+", "", address or "")
    s = re.sub(r"\s+(apt|unit|suite|ste|#).*$", "", s, flags=re.IGNORECASE)
    return s.strip()


def _summarize_permits(permits: list[dict]) -> PermitFinding:
    """Reduce a portal result table to a single PermitFinding.

    Tracks the most recent qualifying ROOF permit going back the full
    PORTAL_LOOKBACK_DAYS window (~25 years). The hot-lead scoring
    rubric (see lib/parcel-canvass.ts::scoreHotLead) tiers by years
    since:
      * <5 yrs  = cold (−40)
      * 5-10   = neutral
      * 10-15  = warm (+30)
      * >15 / never = hot (+50)

    `has_recent_roof_permit` is set to True when ANY roof permit was
    found in the lookback window — the recency tier comes from
    last_permit_date downstream. Set to False ONLY when we saw a
    portal result but no permits matched the roof regex (the "we
    checked and there's nothing on file" signal — that's the hot
    one). Returns null in the None-finding case (portal failure).
    """
    cutoff = dt.date.today() - dt.timedelta(days=PORTAL_LOOKBACK_DAYS)
    most_recent: dict | None = None
    most_recent_date: dt.date | None = None

    for p in permits:
        ptype = p.get("type") or ""
        if not ROOF_PERMIT_PATTERN.search(ptype):
            continue
        try:
            pdate = dateparser.parse(p.get("date") or "", dayfirst=False).date()
        except (ValueError, TypeError):
            continue
        if pdate < cutoff:
            continue  # older than our lookback — effectively "no record"
        if most_recent_date is None or pdate > most_recent_date:
            most_recent = p
            most_recent_date = pdate

    if most_recent is None:
        # We saw the portal results but no roof permit matched. That's
        # the "hot lead" signal — old/no permit on file.
        summary_lines = [
            f"{p.get('date','?')} {p.get('type','?')} #{p.get('number','?')}"
            for p in permits[:10]
        ]
        return PermitFinding(
            has_recent_roof_permit=False,
            last_permit_type=None,
            last_permit_date=None,
            last_permit_number=None,
            raw_summary="\n".join(summary_lines)[:4000],
        )

    return PermitFinding(
        has_recent_roof_permit=True,
        last_permit_type=most_recent.get("type"),
        last_permit_date=most_recent_date,
        last_permit_number=most_recent.get("number"),
        raw_summary=f"{most_recent_date} {most_recent.get('type')} #{most_recent.get('number')}"[:4000],
    )


# ─── DB ────────────────────────────────────────────────────────────────────


def fetch_pending(conn: psycopg.Connection, county_fips: str, limit: int) -> list[CanvassRow]:
    """Pull canvass_targets rows that haven't been permit-checked yet,
    filtered to the requested county via the situs_zip prefix → no,
    that's brittle. Use the parcel-table join instead.

    Strategy: join canvass_targets ↔ parcels on situs_address + zip
    so we know which county a target sits in. Limit to the top-N
    score where permit_checked_at is null.
    """
    sql = """
    select
      ct.id::text,
      ct.address_line,
      ct.city,
      ct.zip,
      ct.score,
      se.event_date,
      p.year_built
    from public.canvass_targets ct
    join public.storm_events se on se.id = ct.storm_event_id
    left join public.parcels p
      on p.situs_address = ct.address_line
      and p.situs_zip = ct.zip
    where ct.permit_checked_at is null
      and ct.address_line is not null
      and (p.county_fips = %s or ct.zip is not null)
    order by ct.score desc
    limit %s
    """
    with conn.cursor() as cur:
        cur.execute(sql, (county_fips, limit))
        rows = cur.fetchall()
    return [
        CanvassRow(
            id=r[0],
            address_line=r[1],
            city=r[2],
            zip=r[3],
            score=float(r[4] or 0),
            storm_date=r[5],
            year_built=r[6],
        )
        for r in rows
    ]


def score_hot_lead(
    base_score: float,
    last_roof_permit_date: dt.date | None,
    storm_date: dt.date,
    year_built: int | None,
) -> float:
    """Port of lib/parcel-canvass.ts::scoreHotLead — the canonical
    hot-lead scoring rubric. Kept in sync with the TS implementation;
    if you change one, change both.

    Rubric:
      base                                          (hail × proximity)
      + post-storm penalty (-100, returns early)    if permit AFTER storm
      + roof permit recency  (-40 | 0 | +30 | +50)
      + age bonus (+25)                              if >20yr AND no recent permit
    """
    score = float(base_score)
    today = dt.date.today()

    # Post-storm activity penalty — competitor already moved
    if last_roof_permit_date and last_roof_permit_date > storm_date:
        return max(-200.0, min(200.0, round((score - 100) * 100) / 100))

    # Recency tier
    if last_roof_permit_date is None:
        years_since = float("inf")
    else:
        years_since = (today - last_roof_permit_date).days / 365.25

    if years_since < 5:
        score += -40
    elif years_since >= 15:
        score += 50
    elif years_since >= 10:
        score += 30
    # 5-10 yr = neutral

    # Roof age bonus
    if year_built:
        home_age = today.year - year_built
        no_recent_permit = years_since >= 10
        if home_age > 20 and no_recent_permit:
            score += 25

    return max(-200.0, min(200.0, round(score * 100) / 100))


def write_finding(
    conn: psycopg.Connection,
    row: CanvassRow,
    finding: PermitFinding | None,
) -> None:
    """Update one canvass_targets row with permit data + re-scored
    hot-lead score.

    finding=None means "we tried but the portal failed" — we still
    mark permit_checked_at so we don't retry every cron, but leave
    has_recent_roof_permit null and the existing score unchanged."""
    if os.environ.get("PERMIT_DRYRUN") == "1":
        new_score = (
            score_hot_lead(row.score, finding.last_permit_date, row.storm_date, row.year_built)
            if finding else row.score
        )
        log.info(
            "[DRYRUN] would update %s with finding=%s new_score=%s",
            row.id, finding, new_score,
        )
        return

    with conn.cursor() as cur:
        if finding is None:
            cur.execute(
                """
                update public.canvass_targets
                set permit_checked_at = now(),
                    updated_at = now()
                where id = %s::uuid
                """,
                (row.id,),
            )
        else:
            new_score = score_hot_lead(
                row.score, finding.last_permit_date, row.storm_date, row.year_built,
            )
            cur.execute(
                """
                update public.canvass_targets
                set has_recent_roof_permit = %s,
                    last_permit_type       = %s,
                    last_permit_date       = %s,
                    last_permit_number     = %s,
                    permit_raw_summary     = %s,
                    permit_checked_at      = now(),
                    score                  = %s,
                    updated_at             = now()
                where id = %s::uuid
                """,
                (
                    finding.has_recent_roof_permit,
                    finding.last_permit_type,
                    finding.last_permit_date,
                    finding.last_permit_number,
                    finding.raw_summary,
                    new_score,
                    row.id,
                ),
            )
    conn.commit()


# ─── Main loop ─────────────────────────────────────────────────────────────


def enrich_county(
    conn: psycopg.Connection,
    county: str,
    top_n: int,
) -> int:
    cfg = COUNTY_QUERIES.get(county)
    if cfg is None:
        log.warning("no permit adapter for county=%s; skipping", county)
        return 0

    # robots.txt check — abort if the portal disallows us
    if not _check_robots(cfg["portal_url"]):
        log.warning("robots.txt disallowed county=%s; skipping", county)
        return 0

    pending = fetch_pending(conn, cfg["county_fips"], top_n)
    if not pending:
        log.info("county=%s: no pending rows", county)
        return 0
    log.info("county=%s: %d pending rows", county, len(pending))

    written = 0
    browser = launch(humanize=True)  # humanize: human-like timing/scroll
    try:
        ctx = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                f"Chrome/130.0.0.0 Safari/537.36 {USER_AGENT_SUFFIX}"
            ),
        )
        page = ctx.new_page()

        for i, row in enumerate(pending):
            try:
                finding = cfg["query"](page, row)
                write_finding(conn, row, finding)
                written += 1
                tag = (
                    "HOT (no permit)"
                    if finding and not finding.has_recent_roof_permit
                    else "permit on file"
                    if finding and finding.has_recent_roof_permit
                    else "portal-failed"
                )
                log.info(
                    "[%d/%d] %s → %s",
                    i + 1, len(pending), row.address_line, tag,
                )
            except Exception as e:
                log.exception("row %s failed: %s", row.id, e)
                # Mark checked anyway so we don't loop on this row.
                write_finding(conn, row, None)

            # Polite-scrape jitter — randomized between 3-5s. Without
            # this every county portal will (a) detect us as automated
            # and (b) eventually rate-limit / block. With it we look
            # like a researcher manually clicking through results.
            time.sleep(random.uniform(RATE_LIMIT_MIN_SEC, RATE_LIMIT_MAX_SEC))

        ctx.close()
    finally:
        browser.close()

    log.info("county=%s done: wrote %d rows", county, written)
    return written


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--county",
        required=True,
        choices=["all", "seminole", "orange"],
        help="Which county portal to query. 'all' iterates every adapter.",
    )
    p.add_argument(
        "--top-n",
        type=int,
        default=DEFAULT_TOP_N,
        help=f"Max rows per county per run (default: {DEFAULT_TOP_N})",
    )
    args = p.parse_args()

    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url and os.environ.get("PERMIT_DRYRUN") != "1":
        raise SystemExit("SUPABASE_DB_URL env var required (or PERMIT_DRYRUN=1)")

    counties = (
        ["seminole", "orange"]
        if args.county == "all"
        else [args.county]
    )

    total = 0
    with psycopg.connect(db_url) as conn:
        for c in counties:
            total += enrich_county(conn, c, args.top_n)

    log.info("done. total rows updated: %d", total)


if __name__ == "__main__":
    main()

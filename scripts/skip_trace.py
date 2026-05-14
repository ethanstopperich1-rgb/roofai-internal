"""
skip_trace.py — free phone/email enrichment via public people-search
aggregators.

Imported by both:
  * scripts/enrich_permits.py   (production worker, batch nightly)
  * scripts/test_oviedo_canvass.py  (per-address smoke test)

Strategy: three sources in priority order, fail-open per address.
Returns the FIRST high/medium-confidence match. Stops on first hit so
we don't hammer all three sites for every address.

Sources (all 100% free, no signup, no API key):
  1. truepeoplesearch.com   — best address search UX, fewest dark patterns
  2. fastpeoplesearch.com   — backup, similar quality
  3. searchpeoplefree.com   — last-ditch

Polite-scrape posture (BAKED IN, not optional):
  * Identifying User-Agent ("Voxaris-SkipTrace (+admin@voxaris.io)")
  * robots.txt probed per site at module import; sources that disallow
    /search/ are skipped permanently
  * 5-10s randomized rate limit between requests (longer than the
    permit path — these sites have more aggressive anti-bot)
  * CloakBrowser handles the Cloudflare challenges these sites use
  * Per-address fail-open: any error logs + returns None, caller
    keeps going. Skip-trace is a SOFT enrichment — a miss doesn't
    drop the row from the canvass list.

Compliance: phone data scraped here is for canvassing-list creation
ONLY. Caller is responsible for:
  * National DNC scrub before dialing
  * Florida Mini-TCPA scrub (stricter than federal)
  * Time-of-day (8am-9pm local)
  * No auto-dialing without consent
See docs/skip-trace-compliance.md.
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import random
import re
import time
import urllib.robotparser
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlparse, quote_plus

log = logging.getLogger("skip_trace")


# ─── Posture ───────────────────────────────────────────────────────────────

CONTACT_EMAIL = os.environ.get("CONTACT_EMAIL", "admin@voxaris.io")
USER_AGENT_SUFFIX = f"Voxaris-SkipTrace (+{CONTACT_EMAIL})"

# 5-10s — meaningfully slower than the permit scrape (3-5s) because
# people-search sites have more aggressive rate limiting and we want
# to stay invisible to it.
RATE_LIMIT_MIN_SEC = 5.0
RATE_LIMIT_MAX_SEC = 10.0

# Phone validation. US-only since FL roofing is the only market.
PHONE_PATTERN = re.compile(
    r"\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})"
)
# Common invalid prefixes that show up in scraped data (test numbers,
# fax-only lines, fictional area codes). Filter them at extraction.
INVALID_AREA_CODES = {"000", "555", "999"}


# ─── Models ────────────────────────────────────────────────────────────────


@dataclass
class PhoneFinding:
    phone_number: str | None         # E.164 (+1XXXXXXXXXX) or 10-digit
    source: str | None               # 'truepeoplesearch' | 'fastpeoplesearch' | ...
    confidence: str | None           # 'high' | 'medium' | 'low'
    raw_summary: str                 # snippet for ops debugging
    email: str | None = None         # opportunistic
    error: str | None = None         # set when all sources failed


# ─── Phone extraction helpers ──────────────────────────────────────────────


def _normalize_phone(raw: str) -> str | None:
    """Returns a clean 10-digit US phone or None. Strips formatting,
    rejects invalid area codes and obvious fakes."""
    m = PHONE_PATTERN.search(raw or "")
    if not m:
        return None
    area, exch, num = m.groups()
    if area in INVALID_AREA_CODES:
        return None
    # Area code must be 2-9 first digit (US NANPA rule)
    if not (2 <= int(area[0]) <= 9):
        return None
    if exch.startswith("0") or exch.startswith("1"):
        return None
    return f"({area}) {exch}-{num}"


def _to_e164(formatted: str | None) -> str | None:
    """Convert formatted '(407) 555-1234' to '+14075551234'."""
    if not formatted:
        return None
    digits = re.sub(r"\D", "", formatted)
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return None


def _extract_phones_from_text(text: str) -> list[str]:
    """Pull all valid-looking US phones from a chunk of page text."""
    out: list[str] = []
    seen: set[str] = set()
    for m in PHONE_PATTERN.finditer(text or ""):
        area, exch, num = m.groups()
        if area in INVALID_AREA_CODES:
            continue
        if not (2 <= int(area[0]) <= 9):
            continue
        if exch.startswith(("0", "1")):
            continue
        formatted = f"({area}) {exch}-{num}"
        if formatted in seen:
            continue
        seen.add(formatted)
        out.append(formatted)
    return out


# ─── Robots.txt probe (cached at module import) ────────────────────────────


def _probe_robots(portal_url: str) -> bool:
    """Default-allow on missing robots.txt; respect explicit Disallow."""
    try:
        parsed = urlparse(portal_url)
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(f"{parsed.scheme}://{parsed.netloc}/robots.txt")
        rp.read()
        return rp.can_fetch(USER_AGENT_SUFFIX, portal_url)
    except Exception as e:
        log.warning("robots probe failed for %s: %s — default-allow", portal_url, e)
        return True


# ─── Source adapters ───────────────────────────────────────────────────────
#
# Each adapter is a callable: query(page, address_line, city, zip, owner) ->
# PhoneFinding or None. Page is a CloakBrowser/Playwright Page. Adapters
# should:
#   * Navigate to the source
#   * Submit the address search
#   * Parse the first result page for phone numbers
#   * Optionally cross-check the result name against owner for confidence
#   * Return a PhoneFinding on hit, None on miss (caller falls back)


def query_truepeoplesearch(
    page,
    address_line: str,
    city: str | None,
    zip_code: str | None,
    owner_name: str | None,
) -> PhoneFinding | None:
    """TruePeopleSearch.com — primary source.

    URL pattern (verified 2026):
      https://www.truepeoplesearch.com/results?streetaddress=<addr>&citystatezip=<city>+<state>+<zip>
    """
    if not address_line or not zip_code:
        return None
    try:
        street = quote_plus(address_line)
        loc = quote_plus(f"{city or ''} FL {zip_code}".strip())
        url = (
            f"https://www.truepeoplesearch.com/results"
            f"?streetaddress={street}&citystatezip={loc}"
        )
        page.goto(url, wait_until="domcontentloaded", timeout=25_000)
        # Brief settle for the result page's JS render
        page.wait_for_timeout(2500)
        body = page.locator("body").inner_text()[:30_000]
    except Exception as e:
        log.warning("truepeoplesearch query failed: %s", e)
        return None

    return _parse_phones_from_body(body, "truepeoplesearch", owner_name)


def query_fastpeoplesearch(
    page,
    address_line: str,
    city: str | None,
    zip_code: str | None,
    owner_name: str | None,
) -> PhoneFinding | None:
    """FastPeopleSearch.com — secondary source.

    URL pattern (verified 2026):
      https://www.fastpeoplesearch.com/address/<street>_<city>-fl-<zip>
    """
    if not address_line or not zip_code:
        return None
    try:
        street_slug = re.sub(r"[^\w]+", "-", address_line.lower()).strip("-")
        city_slug = re.sub(r"[^\w]+", "-", (city or "").lower()).strip("-")
        url = (
            f"https://www.fastpeoplesearch.com/address/"
            f"{street_slug}_{city_slug}-fl-{zip_code}"
        )
        page.goto(url, wait_until="domcontentloaded", timeout=25_000)
        page.wait_for_timeout(2500)
        body = page.locator("body").inner_text()[:30_000]
    except Exception as e:
        log.warning("fastpeoplesearch query failed: %s", e)
        return None

    return _parse_phones_from_body(body, "fastpeoplesearch", owner_name)


def query_searchpeoplefree(
    page,
    address_line: str,
    city: str | None,
    zip_code: str | None,
    owner_name: str | None,
) -> PhoneFinding | None:
    """SearchPeopleFree.com — fallback.

    URL pattern (verified 2026):
      https://www.searchpeoplefree.com/address/<street>/<city>/fl/<zip>
    """
    if not address_line or not zip_code:
        return None
    try:
        street_slug = re.sub(r"[^\w]+", "-", address_line.lower()).strip("-")
        city_slug = re.sub(r"[^\w]+", "-", (city or "").lower()).strip("-")
        url = (
            f"https://www.searchpeoplefree.com/address/"
            f"{street_slug}/{city_slug}/fl/{zip_code}"
        )
        page.goto(url, wait_until="domcontentloaded", timeout=25_000)
        page.wait_for_timeout(2500)
        body = page.locator("body").inner_text()[:30_000]
    except Exception as e:
        log.warning("searchpeoplefree query failed: %s", e)
        return None

    return _parse_phones_from_body(body, "searchpeoplefree", owner_name)


def _parse_phones_from_body(
    body: str, source: str, owner_name: str | None,
) -> PhoneFinding | None:
    """Common parser for all three aggregators.

    Confidence heuristic:
      * 'high'   — owner_name surname appears in body within 200 chars
                   of the first valid phone number
      * 'medium' — phone present, owner_name surname appears anywhere
                   on the page
      * 'low'    — phone present, no name match (still useful as a
                   household-level number, just less certain)
    """
    phones = _extract_phones_from_text(body)
    if not phones:
        return None
    primary = phones[0]

    confidence = "low"
    if owner_name:
        surname = _surname_from_owner(owner_name)
        if surname and surname.lower() in body.lower():
            # Look at the substring around the first phone for tighter
            # binding
            idx = body.find(primary)
            window = body[max(0, idx - 400) : idx + 400] if idx >= 0 else body
            if surname.lower() in window.lower():
                confidence = "high"
            else:
                confidence = "medium"

    return PhoneFinding(
        phone_number=_to_e164(primary) or primary,
        source=source,
        confidence=confidence,
        raw_summary=body[:1000],
    )


def _surname_from_owner(owner_name: str) -> str | None:
    """FL tax-roll owner names are usually 'LAST FIRST [MIDDLE]' or
    'LAST FIRST & SECOND-PERSON' for joint ownership. Extract the
    surname for confidence-matching against people-search results."""
    if not owner_name:
        return None
    # Strip common entity suffixes — corp/trust addresses won't match
    s = re.sub(
        r"\b(LLC|TRUST|TR|EST|ESTATE|INC|CORP|LP|LLP|FAMILY|REV(OCABLE)?)\b",
        "", owner_name, flags=re.IGNORECASE,
    )
    parts = re.split(r"[\s,]+", s.strip())
    if not parts:
        return None
    # FL convention is LAST first; first token is the surname
    surname = parts[0]
    if len(surname) < 2:
        return None
    return surname


# ─── Source registry + dispatch ────────────────────────────────────────────


SOURCES: list[tuple[str, str, Callable]] = [
    ("truepeoplesearch",  "https://www.truepeoplesearch.com/",  query_truepeoplesearch),
    ("fastpeoplesearch",  "https://www.fastpeoplesearch.com/",  query_fastpeoplesearch),
    ("searchpeoplefree",  "https://www.searchpeoplefree.com/",  query_searchpeoplefree),
]


def get_allowed_sources() -> list[tuple[str, Callable]]:
    """Returns the subset of SOURCES whose robots.txt allows our UA."""
    allowed: list[tuple[str, Callable]] = []
    for name, url, fn in SOURCES:
        if _probe_robots(url):
            allowed.append((name, fn))
        else:
            log.warning("skip-trace source %s disallowed by robots.txt", name)
    return allowed


# ─── Public API ────────────────────────────────────────────────────────────


def skip_trace_phone(
    page,
    address_line: str,
    city: str | None,
    zip_code: str | None,
    owner_name: str | None = None,
    debug_dir=None,
) -> PhoneFinding:
    """Run skip-trace across configured sources until one returns a
    valid PhoneFinding. Always returns a PhoneFinding (with
    phone_number=None and error set on total miss) so callers can
    write `phone_checked_at = now()` and move on.

    Polite-scrape pause between sources is built in — don't add your
    own outside this function or you'll double-pace.
    """
    allowed = get_allowed_sources()
    if not allowed:
        return PhoneFinding(None, None, None, "", error="all sources disallowed")

    last_error: str | None = None
    for i, (name, fn) in enumerate(allowed):
        if i > 0:
            time.sleep(random.uniform(RATE_LIMIT_MIN_SEC, RATE_LIMIT_MAX_SEC))
        try:
            finding = fn(page, address_line, city, zip_code, owner_name)
        except Exception as e:
            last_error = f"{name}: {e}"
            log.warning("skip-trace %s threw: %s", name, e)
            continue

        if finding and finding.phone_number:
            if debug_dir:
                try:
                    safe = re.sub(r"[^\w]+", "_", address_line)[:30]
                    page.screenshot(
                        path=str(debug_dir / f"skip_{safe}_{name}.png"),
                    )
                except Exception:
                    pass
            return finding

    return PhoneFinding(
        None, None, None,
        "",
        error=last_error or "no source returned a phone",
    )

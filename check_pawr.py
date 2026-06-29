#!/usr/bin/env python3
"""
Compare pawr.com rehab facility listings against docs/data/facilities.json.

Uses a *reference-based* approach: instead of scraping facility names from
bold tags (which also contain person names, species codes, and junk text),
we check whether each known facility from facilities.json still appears on
its county page.  We also scan each county page for potential NEW facilities
by looking for text blocks that contain address + phone patterns but don't
match any known facility.

Produces pawr_diff.json with any additions, removals, or phone-number
mismatches.

Dependencies: requests, beautifulsoup4 (both in requirements.txt).
"""

from __future__ import annotations

import json
import logging
import re
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PAWR_HOME = "https://pawr.com/"
FACILITIES_PATH = Path(__file__).resolve().parent / "docs" / "data" / "facilities.json"
IGNORE_PATH = Path(__file__).resolve().parent / "pawr_ignore.json"
OUTPUT_PATH = Path(__file__).resolve().parent / "pawr_diff.json"
FETCH_DELAY = 1  # seconds between county page fetches
REQUEST_TIMEOUT = 30
USER_AGENT = "Mozilla/5.0 (compatible; PAWRChecker/1.0)"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
)
logger = logging.getLogger("check_pawr")

# ---------------------------------------------------------------------------
# Text normalisation helpers
# ---------------------------------------------------------------------------

_MULTI_WS = re.compile(r"\s+")

# PA address pattern: number + street text + comma/newline + city + PA + zip
_PA_ADDRESS_RE = re.compile(
    r"\b(P\.?O\.?\s*Box\s+\d+|\d+\s+[\w\s.]+(?:Road|Rd|Street|St|Drive|Dr|"
    r"Ave|Avenue|Way|Lane|Ln|Blvd|Highway|Hwy|Run|Circle|Pike|Trail)\.?)"
    r"[,\s]+([A-Za-z\s.]+),?\s*PA\s+(\d{5})",
    re.IGNORECASE,
)

# Phone pattern: (xxx) xxx-xxxx or xxx-xxx-xxxx or xxx.xxx.xxxx
_PHONE_RE = re.compile(
    r"\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}"
)


def _normalise_text(raw: str) -> str:
    """Normalise text for comparison: NFKD, casefold, collapse whitespace."""
    s = unicodedata.normalize("NFKD", raw)
    s = s.casefold().strip()
    s = _MULTI_WS.sub(" ", s)
    return s


def _normalise_phone(raw: str) -> str:
    """Strip a phone string to digits only."""
    return re.sub(r"\D", "", raw)


# ---------------------------------------------------------------------------
# Scraping helpers
# ---------------------------------------------------------------------------


def _get_session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def discover_county_urls(session: requests.Session) -> List[str]:
    """Fetch pawr.com homepage and return all county page URLs."""
    logger.info("Fetching PAWR homepage: %s", PAWR_HOME)
    resp = session.get(PAWR_HOME, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    urls: List[str] = []
    for a in soup.find_all("a", href=True):
        href: str = a["href"]
        if re.match(r"https?://pawr\.com/[\w-]+-county/?$", href, re.IGNORECASE):
            if href not in urls:
                urls.append(href)

    logger.info("Discovered %d county page URLs", len(urls))
    return urls


def _county_from_url(url: str) -> str:
    """Extract a human-readable county name from a PAWR county URL.

    e.g. https://pawr.com/allegheny-county/ -> Allegheny
    """
    slug = url.rstrip("/").rsplit("/", 1)[-1]
    slug = re.sub(r"-county$", "", slug, flags=re.IGNORECASE)
    return slug.replace("-", " ").title()


def _fetch_county_page_text(
    url: str, session: requests.Session
) -> Optional[str]:
    """Fetch a county page and return the main content area as plain text."""
    try:
        resp = session.get(url, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.warning("Failed to fetch %s: %s", url, exc)
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    content = soup.find(
        "div", class_=re.compile(r"entry-content|post-content|page-content")
    )
    if content is None:
        content = soup.find("article") or soup.find("main") or soup.body
    if content is None:
        logger.warning("No content container found on %s", url)
        return None

    return content.get_text(" ", strip=False)


def _extract_phones_near(text: str, anchor: str) -> List[str]:
    """Find phone numbers near *anchor* text within *text*.

    Looks in a window of ~300 chars after the anchor position.
    Returns digits-only phone strings.
    """
    norm_text = _normalise_text(text)
    norm_anchor = _normalise_text(anchor)
    idx = norm_text.find(norm_anchor)
    if idx < 0:
        return []

    # Search in a window around the anchor (mostly after, some before).
    start = max(0, idx - 50)
    end = min(len(text), idx + len(anchor) + 400)
    window = text[start:end]

    phones = []
    for m in _PHONE_RE.finditer(window):
        digits = _normalise_phone(m.group())
        if len(digits) == 10:
            phones.append(digits)
    return phones


# ---------------------------------------------------------------------------
# Reference-based checking
# ---------------------------------------------------------------------------


def _build_county_url_map(county_urls: List[str]) -> Dict[str, str]:
    """Map normalised county name -> URL."""
    result: Dict[str, str] = {}
    for url in county_urls:
        county = _county_from_url(url)
        result[county.lower()] = url
    return result


def _facility_appears_on_page(facility_name: str, page_text: str) -> bool:
    """Check if a facility name appears on the page (case-insensitive substring)."""
    norm_page = _normalise_text(page_text)
    norm_name = _normalise_text(facility_name)

    # Direct substring match.
    if norm_name in norm_page:
        return True

    # Try without common suffixes (Inc., LLC, etc.) for looser matching.
    stripped = re.sub(
        r",?\s*(inc\.?|llc\.?|corp\.?)$", "", norm_name, flags=re.IGNORECASE
    ).strip()
    if stripped and stripped != norm_name and stripped in norm_page:
        return True

    # Try matching with punctuation removed from both sides.
    clean_name = re.sub(r"[^\w\s]", "", norm_name)
    clean_name = _MULTI_WS.sub(" ", clean_name).strip()
    clean_page = re.sub(r"[^\w\s]", "", norm_page)
    clean_page = _MULTI_WS.sub(" ", clean_page).strip()
    if clean_name and clean_name in clean_page:
        return True

    return False


def _is_candidate_name(text: str) -> bool:
    """Return True if *text* could plausibly be a facility or rehabber name.

    Intentionally permissive — it's better to flag a false positive than miss
    a real addition.  Only rejects text that is clearly NOT a name (phone
    numbers, bare addresses, species codes, city/state/zip lines).
    """
    if len(text) < 3 or len(text) > 120:
        return False

    lower = text.lower()

    # Reject strings that start with common intake-status phrases.
    status_prefixes = [
        "closed to", "open for", "currently", "not accepting",
        "no longer", "temporarily",
    ]
    if any(lower.startswith(p) for p in status_prefixes):
        return False

    # Reject boilerplate and status text.
    reject_phrases = [
        "closed to", "temporarily", "not accepting", "no longer",
        "by appointment", "until further notice",
        "specializing in", "rehabilitates", "species category",
        "please speak", "please call", "please contact",
        "physical address", "mailing address",
        "p.o. box", "po box",
        "website", "email", "facebook", "phone", "fax",
        "click here", "back to", "navigation",
        "search", "menu", "home", "legend",
        "ext ", "ext.",
    ]
    if any(kw in lower for kw in reject_phrases):
        return False

    # Reject if it looks like a phone number or digit-only fragment.
    if re.match(r"^[\d\s()\-.\+]+$", text):
        return False
    if _PHONE_RE.match(text):
        return False

    # Reject street address lines (e.g. "1531 Upper Stump Road").
    if re.match(
        r"^\d+\s+[\w\s.]+(?:Road|Rd|Street|St|Drive|Dr|Ave|Avenue|Way|"
        r"Lane|Ln|Blvd|Highway|Hwy|Run|Circle|Pike|Trail)\.?,?$",
        text, re.IGNORECASE,
    ):
        return False

    # Reject species code lines (e.g. "M, P, R, RVS, END, RA").
    if re.match(r"^[MPRVSENDA,\s–\-]+$", text, re.IGNORECASE):
        return False

    # Reject city/state/zip lines (e.g. "Chalfont, PA 18914-1715").
    if re.match(
        r"^[A-Za-z\s.]+,?\s*PA\s+\d{5}(-\d{4})?$", text, re.IGNORECASE
    ):
        return False

    # Reject lines that are just a county name heading.
    if re.match(r"^[A-Za-z\s]+ county$", text, re.IGNORECASE):
        return False

    return True


def _scan_for_new_facilities(
    page_text: str,
    county: str,
    known_names: List[str],
    ignore_names: List[str],
) -> List[Dict[str, str]]:
    """Scan page text for potential new facilities not in the known list.

    For each PA address found on the page, checks a tight window (~200 chars
    before the address) for a known facility name.  If no known facility is
    nearby, looks for a candidate name (person or org) in the preceding text.

    Names appearing in *ignore_names* (case-insensitive) are silently skipped.
    """
    new_facilities: List[Dict[str, str]] = []
    norm_ignore = {_normalise_text(n) for n in ignore_names}

    for m in _PA_ADDRESS_RE.finditer(page_text):
        addr_start = m.start()

        # Use a tight window before the address to check for known facilities.
        # This avoids cross-contamination from adjacent facility blocks.
        window_before = page_text[max(0, addr_start - 200):addr_start]

        # Check if any known facility name appears in this window.
        window_has_known = False
        for known in known_names:
            if known and _facility_appears_on_page(known, window_before):
                window_has_known = True
                break
        if window_has_known:
            continue

        # No known facility near this address — look for a candidate name.
        lines = [ln.strip() for ln in window_before.split("\n") if ln.strip()]

        candidate_name = None
        for line in reversed(lines):
            if _is_candidate_name(line):
                candidate_name = line
                break

        if not candidate_name:
            continue

        # Skip names on the ignore list.
        norm_candidate = _normalise_text(candidate_name)
        if norm_candidate in norm_ignore:
            logger.info("  IGNORED (in pawr_ignore.json): %s", candidate_name)
            continue

        # Extract phone after the address.
        window_end = min(len(page_text), m.end() + 200)
        phone_window = page_text[m.start():window_end]
        phone_match = _PHONE_RE.search(phone_window)
        phone = _normalise_phone(phone_match.group()) if phone_match else ""

        # Avoid duplicates.
        if any(
            _normalise_text(nf["name"]) == norm_candidate
            for nf in new_facilities
        ):
            continue

        new_facilities.append({
            "name": candidate_name,
            "phone": phone,
            "county": county,
        })

    return new_facilities


# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------


def load_facilities_json() -> List[Dict[str, Any]]:
    """Load the local facilities.json."""
    with open(FACILITIES_PATH, encoding="utf-8") as fh:
        data = json.load(fh)
    logger.info("Loaded %d facilities from %s", len(data), FACILITIES_PATH)
    return data


def load_ignore_list() -> List[str]:
    """Load pawr_ignore.json (names to skip when scanning for new facilities)."""
    if not IGNORE_PATH.exists():
        return []
    with open(IGNORE_PATH, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        logger.warning("pawr_ignore.json is not a JSON array — ignoring")
        return []
    logger.info("Loaded %d entries from %s", len(data), IGNORE_PATH)
    return [str(item) for item in data]


def check_facilities(
    session: requests.Session,
    local_facilities: List[Dict[str, Any]],
    ignore_names: List[str],
) -> List[Dict[str, Any]]:
    """Check each facility in facilities.json against its PAWR county page.

    Returns a list of diff entries.
    """
    county_urls = discover_county_urls(session)
    county_url_map = _build_county_url_map(county_urls)

    # Group local facilities by county.
    by_county: Dict[str, List[Dict[str, Any]]] = {}
    for fac in local_facilities:
        county = fac.get("county", "").strip()
        by_county.setdefault(county, []).append(fac)

    diffs: List[Dict[str, Any]] = []
    counties_checked = 0
    all_known_names = [f.get("name", "") for f in local_facilities]

    # Collect all county keys we need to visit (from local facilities + discovered URLs).
    all_counties = set(c.lower() for c in by_county.keys()) | set(county_url_map.keys())

    fetched = 0
    for county_key in sorted(all_counties):
        url = county_url_map.get(county_key)
        if not url:
            # County in facilities.json but no PAWR page found.
            logger.warning(
                "No PAWR county page found for: %s", county_key.title()
            )
            continue

        if fetched > 0:
            time.sleep(FETCH_DELAY)
        fetched += 1

        county_name = county_key.title()
        logger.info("Checking county: %s (%s)", county_name, url)

        page_text = _fetch_county_page_text(url, session)
        if page_text is None:
            logger.warning("Could not fetch page for %s — skipping", county_name)
            continue

        counties_checked += 1

        # Check each known facility in this county.
        county_facilities = by_county.get(county_name, [])
        for fac in county_facilities:
            name = fac.get("name", "")
            if not name:
                continue

            if _facility_appears_on_page(name, page_text):
                # Facility found — check phone number.
                phones = _extract_phones_near(page_text, name)
                local_phone = _normalise_phone(fac.get("phone", ""))
                if phones and local_phone:
                    # Check if any extracted phone matches.
                    if local_phone not in phones:
                        diffs.append({
                            "type": "phone mismatch",
                            "name": name,
                            "county": county_name,
                            "pawr_phone": phones[0],
                            "local_phone": local_phone,
                        })
                logger.info("  FOUND: %s", name)
            else:
                # Facility not found on page.
                diffs.append({
                    "type": "possible removal",
                    "name": name,
                    "county": county_name,
                })
                logger.info("  NOT FOUND: %s", name)

        # Scan for potential new facilities on this page.
        new_facs = _scan_for_new_facilities(page_text, county_name, all_known_names, ignore_names)
        for nf in new_facs:
            diffs.append({
                "type": "possible addition",
                "name": nf["name"],
                "county": nf["county"],
            })
            logger.info("  NEW: %s", nf["name"])

    logger.info("Checked %d counties", counties_checked)
    return diffs


def main() -> int:
    session = _get_session()
    local_facilities = load_facilities_json()
    ignore_names = load_ignore_list()

    try:
        diffs = check_facilities(session, local_facilities, ignore_names)
    except requests.RequestException as exc:
        logger.error("Fatal error checking PAWR: %s", exc)
        return 1

    OUTPUT_PATH.write_text(
        json.dumps(diffs, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    if diffs:
        logger.info(
            "Found %d difference(s) — written to %s", len(diffs), OUTPUT_PATH
        )
        for d in diffs:
            logger.info(
                "  %s: %s (%s)", d["type"].upper(), d["name"], d.get("county", "")
            )
    else:
        logger.info("No differences found between PAWR and facilities.json")

    # Print a human-readable summary to stdout.
    additions = sum(1 for d in diffs if d["type"] == "possible addition")
    removals = sum(1 for d in diffs if d["type"] == "possible removal")
    phone_mismatches = sum(1 for d in diffs if d["type"] == "phone mismatch")
    print(
        f"Checked {len(local_facilities)} facilities across PAWR county pages. "
        f"Differences: {additions} possible additions, {removals} possible removals, "
        f"{phone_mismatches} phone mismatches."
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())

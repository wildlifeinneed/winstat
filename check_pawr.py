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
from typing import Any, Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup, Tag

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PAWR_HOME = "https://pawr.com/"
FACILITIES_PATH = Path(__file__).resolve().parent / "docs" / "data" / "facilities.json"
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


def _looks_like_person_name(text: str) -> bool:
    """Return True if *text* looks like a person's name rather than an org."""
    # Person names are typically 2-4 capitalised words with no org keywords.
    words = text.split()
    if len(words) < 2 or len(words) > 5:
        return False
    # If it contains org-like keywords, it's not a person name.
    lower = text.lower()
    org_keywords = (
        "center", "centre", "wildlife", "rescue", "rehab", "rehabilitation",
        "sanctuary", "foundation", "inc", "llc", "society", "hospital",
        "conservation", "education", "environmental", "works", "recovery",
        "friends", "acres", "ridge", "creek", "rock", "metro", "helping",
        "hands", "good samaritan", "episode", "pocono", "tamarack",
        "diamond", "raven", "acorn", "wildbird", "forest", "west shore",
        "bat", "cats",
    )
    if any(kw in lower for kw in org_keywords):
        return False
    # Person names: each word is capitalised and short, no digits.
    if re.search(r"\d", text):
        return False
    # Check if all words look like name parts (capitalised, no special chars).
    for w in words:
        # Allow "and" as a connector.
        if w.lower() in ("and", "&"):
            continue
        if not re.match(r"^[A-Z][a-z]+\.?$", w):
            return False
    return True


def _looks_like_facility_name(text: str) -> bool:
    """Return True if *text* plausibly looks like a facility/org name."""
    if len(text) < 5 or len(text) > 120:
        return False
    lower = text.lower()

    # Reject obvious non-facility text.
    reject_patterns = [
        "closed to", "temporarily", "specializing", "rehabilitates",
        "species category", "appointment only", "please speak",
        "please call", "physical address", "mailing address",
        "p.o. box", "po box", "website", "email", "facebook",
        "phone", "fax", "click here", "back to", "navigation",
        "search", "menu", "home", "county", "legend", "note",
        "important", "ext ", "ext.",
    ]
    if any(kw in lower for kw in reject_patterns):
        return False

    # Reject if it looks like a phone number or fragment.
    if re.match(r"^[\d\s()\-.\+]+$", text):
        return False
    if _PHONE_RE.match(text):
        return False

    # Reject street address lines (e.g. "1531 Upper Stump Road").
    if re.match(
        r"^\d+\s+[\w\s.]+(?:Road|Rd|Street|St|Drive|Dr|Ave|Avenue|Way|"
        r"Lane|Ln|Blvd|Highway|Hwy|Run|Circle|Pike|Trail)\.?$",
        text, re.IGNORECASE,
    ):
        return False

    # Reject species code lines.
    if re.match(r"^[MPRVSENDA,\s–\-]+$", text, re.IGNORECASE):
        return False

    # Reject city/state/zip lines (e.g. "Chalfont, PA 18914-1715").
    if re.match(
        r"^[A-Za-z\s.]+,?\s*PA\s+\d{5}(-\d{4})?$", text, re.IGNORECASE
    ):
        return False

    # Reject if it looks like a person name.
    if _looks_like_person_name(text):
        return False

    return True


def _scan_for_new_facilities(
    page_text: str,
    county: str,
    known_names: List[str],
) -> List[Dict[str, str]]:
    """Scan page text for potential new facilities not in the known list.

    Looks for text blocks containing PA address patterns that don't match
    any known facility name.  Returns a list of dicts with name, phone, county.
    """
    new_facilities: List[Dict[str, str]] = []

    # Find all PA address matches in the page text.
    for m in _PA_ADDRESS_RE.finditer(page_text):
        addr_start = m.start()

        # Look backwards from the address for a potential facility name.
        preceding = page_text[max(0, addr_start - 300):addr_start]

        # Split into lines and look for the last non-empty line that looks
        # like a facility/org name.
        lines = [ln.strip() for ln in preceding.split("\n") if ln.strip()]

        candidate_name = None
        for line in reversed(lines):
            if _looks_like_facility_name(line):
                candidate_name = line
                break

        if not candidate_name:
            continue

        # Check if this candidate matches any known facility.
        is_known = False
        for known in known_names:
            if _facility_appears_on_page(known, candidate_name):
                is_known = True
                break
            if _facility_appears_on_page(candidate_name, known):
                is_known = True
                break

        if is_known:
            continue

        # Extract phone near the address.
        window_end = min(len(page_text), m.end() + 200)
        phone_window = page_text[m.start():window_end]
        phone_match = _PHONE_RE.search(phone_window)
        phone = _normalise_phone(phone_match.group()) if phone_match else ""

        # Avoid duplicates.
        norm_candidate = _normalise_text(candidate_name)
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


def check_facilities(
    session: requests.Session,
    local_facilities: List[Dict[str, Any]],
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
                            "type": "phone_mismatch",
                            "name": name,
                            "county": county_name,
                            "pawr_phone": phones[0],
                            "local_phone": local_phone,
                        })
                logger.info("  FOUND: %s", name)
            else:
                # Facility not found on page.
                diffs.append({
                    "type": "removed",
                    "name": name,
                    "county": county_name,
                })
                logger.info("  NOT FOUND: %s", name)

        # Scan for potential new facilities on this page.
        new_facs = _scan_for_new_facilities(page_text, county_name, all_known_names)
        for nf in new_facs:
            diffs.append({
                "type": "added",
                "name": nf["name"],
                "county": nf["county"],
            })
            logger.info("  NEW: %s", nf["name"])

    logger.info("Checked %d counties", counties_checked)
    return diffs


def main() -> int:
    session = _get_session()
    local_facilities = load_facilities_json()

    try:
        diffs = check_facilities(session, local_facilities)
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
    added = sum(1 for d in diffs if d["type"] == "added")
    removed = sum(1 for d in diffs if d["type"] == "removed")
    phone_mismatches = sum(1 for d in diffs if d["type"] == "phone_mismatch")
    print(
        f"Checked {len(local_facilities)} facilities across PAWR county pages. "
        f"Differences: {added} added, {removed} removed, "
        f"{phone_mismatches} phone mismatches."
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())

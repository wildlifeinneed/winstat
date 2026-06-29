#!/usr/bin/env python3
"""
Compare pawr.com rehab facility listings against docs/data/facilities.json.

Scrapes the PAWR homepage to discover county pages, then extracts facility
names and phone numbers from each county page.  Produces pawr_diff.json with
any additions, removals, or phone-number mismatches.

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

# Pattern to strip common suffixes that vary between sources.
_STRIP_SUFFIXES = re.compile(
    r",?\s*(inc\.?|llc\.?|corp\.?|incorporated|limited)$",
    re.IGNORECASE,
)

# Collapse multiple whitespace / non-breaking spaces.
_MULTI_WS = re.compile(r"\s+")


def _normalise_name(raw: str) -> str:
    """Return a canonical, comparison-ready facility name.

    * Unicode NFKD normalisation (curly quotes -> straight, etc.)
    * Case-fold
    * Strip leading/trailing whitespace
    * Collapse internal whitespace
    * Remove trailing Inc./LLC/Corp.
    * Remove all punctuation except hyphens (keep "T&D" -> "td")
    """
    s = unicodedata.normalize("NFKD", raw)
    s = s.casefold().strip()
    s = _MULTI_WS.sub(" ", s)
    s = _STRIP_SUFFIXES.sub("", s).strip()
    # Remove punctuation except hyphens and spaces.
    s = re.sub(r"[^\w\s-]", "", s)
    s = _MULTI_WS.sub(" ", s).strip()
    return s


def _normalise_phone(raw: str) -> str:
    """Strip a phone string to digits only."""
    return re.sub(r"\D", "", raw)


# ---------------------------------------------------------------------------
# Scraping
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
        # County links look like https://pawr.com/allegheny-county/
        if re.match(r"https?://pawr\.com/[\w-]+-county/?$", href, re.IGNORECASE):
            if href not in urls:
                urls.append(href)

    logger.info("Discovered %d county page URLs", len(urls))
    return urls


def _county_from_url(url: str) -> str:
    """Extract a human-readable county name from a PAWR county URL.

    e.g. https://pawr.com/allegheny-county/ -> Allegheny
    """
    slug = url.rstrip("/").rsplit("/", 1)[-1]  # allegheny-county
    slug = re.sub(r"-county$", "", slug, flags=re.IGNORECASE)
    return slug.replace("-", " ").title()


def _extract_phone(text: str) -> Optional[str]:
    """Find the first US phone number in *text* and return digits-only."""
    m = re.search(
        r"(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})", text
    )
    if m:
        return _normalise_phone(m.group(1))
    return None


def scrape_county_page(
    url: str, session: requests.Session
) -> List[Dict[str, str]]:
    """Scrape a single PAWR county page for facility entries.

    Returns a list of dicts with keys ``name``, ``phone``, ``county``.
    """
    county = _county_from_url(url)
    logger.info("Scraping county page: %s (%s)", county, url)

    try:
        resp = session.get(url, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.warning("Failed to fetch %s: %s", url, exc)
        return []

    soup = BeautifulSoup(resp.text, "html.parser")

    # The PAWR county pages embed facility info inside the WordPress post
    # body.  Facility names are typically wrapped in <strong> or <b> tags.
    # We look for bold elements and treat each as a potential facility header,
    # then scan the surrounding text for a phone number.

    content = soup.find("div", class_=re.compile(r"entry-content|post-content|page-content"))
    if content is None:
        # Fallback: try the main article or body.
        content = soup.find("article") or soup.find("main") or soup.body
    if content is None:
        logger.warning("No content container found on %s", url)
        return []

    facilities: List[Dict[str, str]] = []
    seen_names: set = set()

    # Strategy: find all <strong> and <b> tags inside the content area.
    bold_tags = content.find_all(["strong", "b"])

    for bold in bold_tags:
        raw_name = bold.get_text(strip=True)
        if not raw_name or len(raw_name) < 3:
            continue

        # Skip headings that are clearly not facility names.
        lower = raw_name.lower()
        if any(
            kw in lower
            for kw in [
                "county",
                "species",
                "code",
                "legend",
                "note",
                "important",
                "click here",
                "back to",
                "home",
                "menu",
                "search",
                "navigation",
            ]
        ):
            continue

        norm = _normalise_name(raw_name)
        if norm in seen_names or len(norm) < 3:
            continue
        seen_names.add(norm)

        # Gather surrounding text to find a phone number.
        # Walk siblings and parent text after this bold tag.
        phone = None
        context_text = _gather_context_after(bold)
        if context_text:
            phone = _extract_phone(context_text)

        facilities.append(
            {
                "name": raw_name.strip(),
                "phone": phone or "",
                "county": county,
            }
        )

    logger.info("  Found %d facilities in %s county", len(facilities), county)
    return facilities


def _gather_context_after(tag: Tag, max_chars: int = 500) -> str:
    """Collect text from siblings after *tag* until the next bold tag or max_chars."""
    parts: List[str] = []
    total = 0
    node = tag.next_sibling
    while node and total < max_chars:
        if isinstance(node, Tag):
            if node.name in ("strong", "b"):
                break
            text = node.get_text(" ", strip=True)
        else:
            text = str(node).strip()
        if text:
            parts.append(text)
            total += len(text)
        node = node.next_sibling

    # Also check the parent element's remaining text after the bold tag.
    if not parts and tag.parent:
        parent_text = tag.parent.get_text(" ", strip=True)
        # Take text after the bold tag's own text.
        bold_text = tag.get_text(strip=True)
        idx = parent_text.find(bold_text)
        if idx >= 0:
            after = parent_text[idx + len(bold_text) :]
            parts.append(after)

    return " ".join(parts)


def scrape_all_counties(
    session: requests.Session,
) -> List[Dict[str, str]]:
    """Scrape all county pages and return combined facility list."""
    urls = discover_county_urls(session)
    all_facilities: List[Dict[str, str]] = []

    for i, url in enumerate(urls):
        if i > 0:
            time.sleep(FETCH_DELAY)
        facilities = scrape_county_page(url, session)
        all_facilities.extend(facilities)

    logger.info("Total facilities scraped from PAWR: %d", len(all_facilities))
    return all_facilities


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------


def load_facilities_json() -> List[Dict[str, Any]]:
    """Load the local facilities.json."""
    with open(FACILITIES_PATH, encoding="utf-8") as fh:
        data = json.load(fh)
    logger.info("Loaded %d facilities from %s", len(data), FACILITIES_PATH)
    return data


def _fuzzy_match(name_a: str, name_b: str) -> bool:
    """Return True if two normalised names are close enough to be the same facility."""
    if name_a == name_b:
        return True
    # Check if one is a substring of the other (handles abbreviation differences).
    if name_a in name_b or name_b in name_a:
        return True
    # Simple Jaccard on word sets for short names.
    words_a = set(name_a.split())
    words_b = set(name_b.split())
    if not words_a or not words_b:
        return False
    intersection = words_a & words_b
    union = words_a | words_b
    jaccard = len(intersection) / len(union)
    return jaccard >= 0.6


def compare(
    pawr_facilities: List[Dict[str, str]],
    local_facilities: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Compare scraped PAWR data against local facilities.json.

    Returns a list of diff entries (empty list = no changes).
    Each entry has keys: type (added|removed|phone_mismatch), name, county,
    and optionally pawr_phone / local_phone.
    """
    # Build lookup by normalised name for local facilities.
    local_by_norm: Dict[str, Dict[str, Any]] = {}
    for f in local_facilities:
        norm = _normalise_name(f.get("name", ""))
        if norm:
            local_by_norm[norm] = f

    # Build lookup for PAWR facilities.
    pawr_by_norm: Dict[str, Dict[str, str]] = {}
    for f in pawr_facilities:
        norm = _normalise_name(f.get("name", ""))
        if norm:
            pawr_by_norm[norm] = f

    diffs: List[Dict[str, Any]] = []
    matched_local: set = set()

    # Check each PAWR facility against local.
    for p_norm, p_fac in pawr_by_norm.items():
        # Try exact normalised match first.
        match_key = None
        if p_norm in local_by_norm:
            match_key = p_norm
        else:
            # Try fuzzy match.
            for l_norm in local_by_norm:
                if l_norm not in matched_local and _fuzzy_match(p_norm, l_norm):
                    match_key = l_norm
                    break

        if match_key is None:
            # New facility on PAWR not in local.
            diffs.append(
                {
                    "type": "added",
                    "name": p_fac["name"],
                    "county": p_fac.get("county", ""),
                }
            )
        else:
            matched_local.add(match_key)
            # Check phone mismatch.
            local_fac = local_by_norm[match_key]
            pawr_phone = _normalise_phone(p_fac.get("phone", ""))
            local_phone = _normalise_phone(local_fac.get("phone", ""))
            if pawr_phone and local_phone and pawr_phone != local_phone:
                diffs.append(
                    {
                        "type": "phone_mismatch",
                        "name": p_fac["name"],
                        "county": p_fac.get("county", ""),
                        "pawr_phone": pawr_phone,
                        "local_phone": local_phone,
                    }
                )

    # Check for local facilities not found on PAWR.
    for l_norm, l_fac in local_by_norm.items():
        if l_norm not in matched_local:
            # Check fuzzy against all PAWR names (may have been matched above).
            found = False
            for p_norm in pawr_by_norm:
                if _fuzzy_match(l_norm, p_norm):
                    found = True
                    break
            if not found:
                diffs.append(
                    {
                        "type": "removed",
                        "name": l_fac.get("name", ""),
                        "county": l_fac.get("county", ""),
                    }
                )

    return diffs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    session = _get_session()

    try:
        pawr_facilities = scrape_all_counties(session)
    except requests.RequestException as exc:
        logger.error("Fatal error scraping PAWR: %s", exc)
        return 1

    if not pawr_facilities:
        logger.warning(
            "No facilities scraped from PAWR — site may be down or structure changed. "
            "Skipping comparison to avoid false removals."
        )
        # Write empty diff so the workflow doesn't fail.
        OUTPUT_PATH.write_text("[]", encoding="utf-8")
        return 0

    local_facilities = load_facilities_json()
    diffs = compare(pawr_facilities, local_facilities)

    OUTPUT_PATH.write_text(
        json.dumps(diffs, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    if diffs:
        logger.info("Found %d difference(s) — written to %s", len(diffs), OUTPUT_PATH)
        for d in diffs:
            logger.info("  %s: %s (%s)", d["type"].upper(), d["name"], d.get("county", ""))
    else:
        logger.info("No differences found between PAWR and facilities.json")

    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Refresh Connecteam volunteer capacity from Monday.com.

Pulls volunteers from the Connecteam_Users board, aggregates per-county
capacity by role bucket (C&T no-RVS / C&T+RVS / Courier), and writes
docs/data/county_capacity.json.

Usage:
  python3 refresh_monday.py
  python3 refresh_monday.py --dry-run
  python3 refresh_monday.py --diff
  python3 refresh_monday.py --diff --dry-run
  python3 refresh_monday.py --introspect
  python3 refresh_monday.py --verbose
  python3 refresh_monday.py --if-stale
  python3 refresh_monday.py --if-stale --dry-run

Token resolution order:
  1. .monday_token file in the current working directory (gitignored).
  2. MONDAY_API_TOKEN environment variable.

Availability semantics (per spec, easy to flip here):
  - Empty/missing availability text  -> AVAILABLE (active by default).
  - If text matches AVAILABILITY_DENYLIST_RE -> UNAVAILABLE.
  Set DEFAULT_AVAILABLE_WHEN_BLANK = False below to invert.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import sys
import tempfile
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests

import county_pip
import county_win
import dispatch_core
import geocoder


# ---------------------------------------------------------------------------
# CONSTANTS — discovered via Monday GraphQL introspection on board 9092079933.
# Column IDs are NOT the same as the human-visible labels. Run with
# `--introspect` against a real token to refresh these mappings if Monday
# admins rename or recreate columns.
# ---------------------------------------------------------------------------

MONDAY_API_URL = "https://api.monday.com/v2"
MONDAY_API_VERSION = "2024-10"

BOARD_ID = "9092079933"          # Connecteam_Users
GROUP_TITLES = ["users", "non-users"]  # groups to fetch volunteers from
GROUP_TITLE = GROUP_TITLES[0]    # back-compat alias

# Phase 1.5 — staleness gate. Tracker board records when the volunteer DB
# was last refreshed. We query just this board (cheap) before doing the
# full pull when --if-stale is set.
TRACKER_BOARD_ID = "6750158385"          # VolDB_Status
TRACKER_GROUP_TITLE = "VolunteerDB Last Update"
TRACKER_COL_TITLE_LAST_UPDATED = "Last_Updated"
SIDECAR_REL_PATH = Path("docs") / "data" / ".last_remote_update"

# Human-visible column titles we care about. The script resolves these to
# their concrete column IDs at runtime via the boards.columns query, so a
# Monday admin renaming a column only requires updating the title here.
COL_TITLE_COUNTY = "County"
COL_TITLE_ROLES = "Roles"
COL_TITLE_AVAILABILITY = "Availability"
COL_TITLE_WIN_AREA = "WIN Area"

# Phase B — address columns for geocoding. These are resolved by concrete
# column ID (not human title) because the address columns are unlabeled /
# duplicated on the board; the IDs below were confirmed via introspection.
# The geocoded output is a PRIVATE coords dataset (see COORDS_REL_PATH) and is
# never committed to the repo.
ADDRESS_COL_IDS = {
    "street": "text_mkqqsnmj",
    "city": "text_mkqq3x8t",
    "state": "text_mkqqka4z",
    "zip": "text_mkqqez45",
}

# Roles that qualify a volunteer for dispatch capacity. Anyone who only has
# Dispatch / Board / IT / TestUsers tags is filtered out.
QUALIFYING_ROLES = {"C&T", "RVS", "Courier"}

# Availability denylist — if any of these substrings (regex, case-insensitive)
# appears in the availability long-text field, the volunteer is treated as
# UNAVAILABLE for the snapshot. Empty text == AVAILABLE.
AVAILABILITY_KEYWORDS = [
    "vacation",
    "out",
    "inactive",
    # "unavail" is a substring of both "Unavail" (shorthand) and
    # "Unavailable" (long form), so this single entry catches both. The
    # positive token "available" does NOT contain "unavail", so positive
    # shorthand still passes the denylist.
    "unavail",
    "leave",
    "away",
    "on hold",
    "extended",
    "hiatus",
]
AVAILABILITY_DENYLIST_RE = re.compile(
    r"|".join(AVAILABILITY_KEYWORDS), re.IGNORECASE
)
DEFAULT_AVAILABLE_WHEN_BLANK = True

# Date-range parser for temporary unavailability clauses appended to a
# volunteer's normal schedule. Matches "Unavail" or "Unavailable" followed
# by one or more M/D dates or M/D-M/D ranges, comma-separated. Supports
# ASCII hyphen, en-dash (U+2013), and em-dash (U+2014) as range separator.
# Examples:
#   "Unavail 5/12"
#   "Unavail 5/12-5/21"
#   "Unavail 5/12 - 5/21"
#   "Unavail 8/12-8/18, 8/26-8/28, 9/9-9/14"
# Limitation: M/D is parsed using today.year; year-wrap cases (e.g. today
# = Dec 28 with range 1/5-1/12) are NOT handled — the late-December range
# would resolve to the current year, not next, and may incorrectly read
# as "in the past". Acceptable for the dispatcher use case where ranges
# are short and entered close to their start date.
UNAVAIL_DATE_CLAUSE_RE = re.compile(
    r"\bunavail(?:able)?\b\s*"
    r"\d{1,2}/\d{1,2}"
    r"(?:\s*[-\u2013\u2014]\s*\d{1,2}/\d{1,2})?"
    r"(?:\s*,\s*\d{1,2}/\d{1,2}"
    r"(?:\s*[-\u2013\u2014]\s*\d{1,2}/\d{1,2})?)*",
    re.IGNORECASE,
)
# Secondary scan for "Unavail TBD" / "Unavail later" style markers — the
# date-clause regex above won't match these (no digits) so they fall
# through to the keyword denylist (correctly treated as unavailable),
# but we emit a warning so the Monday entry can be cleaned up.
_UNAVAIL_TBD_RE = re.compile(
    r"\bunavail(?:able)?\b\s+(tbd|tba|later)\b",
    re.IGNORECASE,
)
_MD_TOKEN_RE = re.compile(r"(\d{1,2})/(\d{1,2})")

# Marginal threshold: when (county, bucket) available count is <= this,
# emit the volunteer roster so dispatchers can see who's borderline.
# This is the baked-in default used when docs/data/config.json is missing
# or doesn't override marginal_threshold for a given county. Tunable
# per-county via docs/data/config.json (Phase 2.5).
MARGINAL_THRESHOLD = 1

# Phase 2.5 — tunable thresholds config (docs/data/config.json).
CONFIG_REL_PATH = Path("docs") / "data" / "config.json"
DEFAULT_CONFIG: Dict[str, Any] = {
    "marginal_threshold": 1,
    "escalate_to_game_commission": {
        "ct_rvs_capture_min_available": 1,
        "ct_any_capture_min_available": 1,
        "courier_transport_min_available": 1,
    },
    "county_overrides": {},
}

# Canonical PA county list (kept in sync with docs/assets/dispatcher.js).
PA_COUNTIES = (
    "Adams", "Allegheny", "Armstrong", "Beaver", "Bedford", "Berks", "Blair",
    "Bradford", "Bucks", "Butler", "Cambria", "Cameron", "Carbon", "Centre",
    "Chester", "Clarion", "Clearfield", "Clinton", "Columbia", "Crawford",
    "Cumberland", "Dauphin", "Delaware", "Elk", "Erie", "Fayette", "Forest",
    "Franklin", "Fulton", "Greene", "Huntingdon", "Indiana", "Jefferson",
    "Juniata", "Lackawanna", "Lancaster", "Lawrence", "Lebanon", "Lehigh",
    "Luzerne", "Lycoming", "McKean", "Mercer", "Mifflin", "Monroe",
    "Montgomery", "Montour", "Northampton", "Northumberland", "Perry",
    "Philadelphia", "Pike", "Potter", "Schuylkill", "Snyder", "Somerset",
    "Sullivan", "Susquehanna", "Tioga", "Union", "Venango", "Warren",
    "Washington", "Wayne", "Westmoreland", "Wyoming", "York",
)

# Phase C — RehabDB board. Rehabbers are PUBLIC-FACING facilities (public
# websites + addresses); their data needs NO anonymization and IS committed to
# the public docs/ folder. Lat/lon are ALREADY present on the board, so no
# geocoding is needed. Column IDs were confirmed via introspection and are
# addressed by concrete ID (the human titles are duplicated/ambiguous on the
# board).
REHAB_BOARD_ID = "9092004762"          # RehabDB
REHAB_COL_IDS = {
    "rehab_name": "text_mkv6bp9s",
    "facility_name": "text_mm4esfft",
    "city": "text_mkqqc1s1",
    "address": "text_mkqqff5k",
    "state": "text_mkqqk1xk",
    "zip": "text_mkqqe6qe",
    "county": "text_mkqqk5cb",
    "phone": "text_mkqqtre3",
    "latitude": "text_mkqqj30w",
    "longitude": "text_mkqqrt6e",
    "website": "text_mkv8njgj",
    "availability": "text_mkqqgq94",
}
# NOTE: the board's open/closed status column (color_mkv6xbc) is intentionally
# NOT pulled. The dispatcher org does not keep that field current (real-time
# status lives in a separate beta "rehab status" app, not wired in here), so
# surfacing it would be misleading. It is omitted from the data pipeline.

# PRIMARY join key for facilities.json. The RehabDB board has a dedicated
# "Facility Name" column (text_mm4esfft) holding the full facility name; this is
# the clean Option-A join key, matched (normalized: case/whitespace/punctuation)
# against the Google Sheet facility names. It is partially populated today (the
# org is filling it in), so rows where it is BLANK fall back to the thin
# facility_name_map.json (then an Availability-parsed name, then 'Rehab Name').
# As the column is filled, the map shrinks toward empty with no code change.

# Area Coordinators board. The county->area map stays in counties.xlsx
# (stable); only the volatile coordinator NAME is sourced here so a Monday
# rename flows through the normal refresh. The board's ITEM NAME is the WIN
# area string (e.g. "15N"/"10"); long_text_mm455k2n is the coordinator name.
#
# HARD PII RULE: the coordinator PHONE column (phone_mm45s2h0) is NEVER
# fetched, stored, or emitted — the dispatcher site is public GitHub Pages.
# Only the area (item name) + coordinator name are read.
COORDINATORS_BOARD_ID = "18416913502"   # Area Coordinators
COORDINATORS_GROUP_TITLE = "Coordinators"
COORD_COL_IDS = {
    "name": "long_text_mm455k2n",
}

# Output file — relative to this script's directory.
OUTPUT_REL_PATH = Path("docs") / "data" / "county_capacity.json"

# Phase C — PUBLIC rehabber dataset. Unlike the volunteer coords (private,
# gitignored), this file IS committed: rehabbers are public-facing facilities.
REHABBERS_REL_PATH = Path("docs") / "data" / "rehabbers.json"

# Facility-status page dataset (Option A: join-at-read). This is the PUBLIC
# BASE-facility dataset consumed by docs/facilities.html, which merges it with
# the Google-Sheet STATUS feed by normalized facility name at read time. It
# carries ONLY base fields {name, address, city, state, zip, phone, website,
# lat, lon, county} — NEVER any open/closed/status field (the Monday status
# column is never kept current; status lives exclusively in the Sheet). These
# are PUBLIC facility addresses (the page already displays them), NOT volunteer
# PII, so the file IS committed to docs/.
FACILITIES_REL_PATH = Path("docs") / "data" / "facilities.json"

# Join-key bridge (FALLBACK ONLY). The RehabDB board now has a dedicated
# "Facility Name" column (REHAB_COL_IDS['facility_name'] = text_mm4esfft) which
# is the PRIMARY join key: its value is matched (normalized) against the Google
# Sheet facility name in facilities.html. That column is only partially filled
# today, so for rows where it is still blank we fall back through this committed,
# hand-maintained map (Monday 'Rehab Name' abbreviation -> full Sheet name),
# then a name parsed from the 'Availability' free text, then the raw 'Rehab
# Name'. Add a new entry here only for an as-yet-unfilled facility; once the
# "Facility Name" column is fully populated this map becomes unused with no
# code change. Unmatched names are reported on stderr so the map stays current.
FACILITY_NAME_MAP_REL_PATH = Path("docs") / "data" / "facility_name_map.json"

# Area-coordinator NAME dataset. PUBLIC-safe (coordinator names are agreed
# public; phone is excluded). Maps area-string -> coordinator name. Consumed
# by county_win.py as an override on top of the static counties.xlsx column.
COORDINATORS_REL_PATH = Path("docs") / "data" / "coordinators.json"

# Phase B — PRIVATE volunteer coords dataset. This path is GITIGNORED and the
# file is NEVER committed to the repo (it derives from PII addresses, though it
# itself contains only lat/lon/roles/home_county/win_area). Lives under data/
# (NOT docs/) so it is never published by the static site.
COORDS_REL_PATH = Path("data") / "volunteer_coords.json"

TOKEN_FILE = ".monday_token"
TOKEN_ENV = "MONDAY_API_TOKEN"

PAGE_LIMIT = 100  # max items per items_page call

logger = logging.getLogger("refresh_monday")


# ---------------------------------------------------------------------------
# Token / HTTP plumbing
# ---------------------------------------------------------------------------


class MondayAuthError(RuntimeError):
    pass


class MondayAPIError(RuntimeError):
    pass


class MondayTokenFormatError(RuntimeError):
    """Raised when the token file/env var is present but malformed.

    The exception message MUST NOT include the token value itself —
    only the source (file path or env var name) — to avoid leaking the
    secret into terminals, log files, or paste buffers.
    """


# JWT-safe character set: base64url alphabet plus the two `.` separators.
_JWT_SAFE_RE = re.compile(r"^[A-Za-z0-9._\-]+$")


def _validate_token_shape(raw: str, source_desc: str) -> str:
    """Strip + validate a token value. Returns the stripped token.

    Raises MondayTokenFormatError with an actionable, secret-free message
    if the value is empty, RTF-wrapped, contains whitespace/control chars,
    or contains characters outside the JWT-safe set.
    """
    stripped = raw.strip()
    if not stripped:
        raise MondayTokenFormatError(
            f"TOKEN FILE FORMAT ERROR: {source_desc} is empty after "
            f"stripping whitespace."
        )
    # RTF wrapper detection — TextEdit on macOS silently saves as RTF.
    if stripped.startswith("{\\rtf") or stripped.startswith("{\rtf"):
        raise MondayTokenFormatError(
            f"TOKEN FILE FORMAT ERROR: {source_desc} appears to be Rich "
            f"Text Format (RTF), not plain text. Re-save it from a "
            f"plain-text editor (nano, vim, VS Code) or run: "
            f"printf %s YOUR_TOKEN > {TOKEN_FILE}"
        )
    # Internal whitespace / control chars are never valid in a JWT.
    for ch in stripped:
        if ch in ("\n", "\r", "\t") or ord(ch) < 0x20 or ord(ch) == 0x7F:
            raise MondayTokenFormatError(
                f"TOKEN FILE FORMAT ERROR: {source_desc} contains "
                f"embedded whitespace or control characters. Re-save it "
                f"as a single line of plain text (no newlines, tabs, or "
                f"spaces inside the token)."
            )
    if not _JWT_SAFE_RE.match(stripped):
        raise MondayTokenFormatError(
            f"TOKEN FILE FORMAT ERROR: {source_desc} contains characters "
            f"outside the JWT-safe set [A-Za-z0-9._-]. Re-save it as a "
            f"single line of plain text containing only the token."
        )
    return stripped


def load_token(cwd: Optional[Path] = None) -> str:
    """Read the API token from .monday_token, falling back to env var.

    Validates the token's shape before returning it so malformed inputs
    (RTF-wrapped files from TextEdit, embedded newlines, etc.) fail with
    a clear, secret-free error rather than reaching the HTTP layer.
    """
    cwd = cwd or Path.cwd()
    token_path = cwd / TOKEN_FILE
    if token_path.exists():
        raw = token_path.read_text(encoding="utf-8", errors="replace")
        return _validate_token_shape(raw, source_desc=str(token_path))
    env_raw = os.environ.get(TOKEN_ENV, "")
    if env_raw.strip():
        return _validate_token_shape(env_raw, source_desc=f"${TOKEN_ENV}")
    raise MondayAuthError(
        "No Monday.com API token found. "
        f"Create {TOKEN_FILE} with your Monday.com API v2 token in the project "
        f"root, or set {TOKEN_ENV} env var. "
        "Get a token from Monday -> Profile -> Developer -> API Token."
    )


def graphql_request(
    query: str,
    variables: Optional[Dict[str, Any]] = None,
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
    _retry: bool = True,
) -> Dict[str, Any]:
    """POST a GraphQL query to Monday and return the parsed `data` block.

    Handles a single 429 retry honoring Retry-After.
    """
    if token is None:
        token = load_token()
    session = session or requests.Session()
    headers = {
        "Authorization": token,
        "Content-Type": "application/json",
        "API-Version": MONDAY_API_VERSION,
    }
    payload: Dict[str, Any] = {"query": query}
    if variables is not None:
        payload["variables"] = variables

    resp = session.post(MONDAY_API_URL, json=payload, headers=headers, timeout=30)

    if resp.status_code == 429 and _retry:
        retry_after = int(resp.headers.get("Retry-After", "5") or 5)
        logger.warning("429 rate-limited by Monday; sleeping %ss then retrying once", retry_after)
        time.sleep(retry_after)
        return graphql_request(query, variables, token=token, session=session, _retry=False)

    if resp.status_code >= 400:
        raise MondayAPIError(f"HTTP {resp.status_code} from Monday: {resp.text[:500]}")

    body = resp.json()
    if "errors" in body and body["errors"]:
        raise MondayAPIError(f"GraphQL errors: {body['errors']}")
    return body.get("data") or {}


# ---------------------------------------------------------------------------
# Column-id discovery
# ---------------------------------------------------------------------------

INTROSPECT_QUERY = """
query ($board_ids: [ID!]) {
  boards(ids: $board_ids) {
    id
    name
    columns { id title type }
    groups { id title }
  }
}
"""


def discover_board_metadata(
    titles: Sequence[str],
    group_titles: "str | Sequence[str]",
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> Dict[str, Any]:
    """Resolve column ids AND volunteer group id(s) in one introspection call.

    ``group_titles`` may be a single string or a list of strings.

    Returns {"column_ids": {title -> column_id}, "group_ids": {title -> group_id}}.
    For back-compat, also includes "group_id" set to the first resolved id.
    """
    if isinstance(group_titles, str):
        group_titles = [group_titles]

    data = graphql_request(
        INTROSPECT_QUERY,
        variables={"board_ids": [BOARD_ID]},
        token=token,
        session=session,
    )
    boards = data.get("boards") or []
    if not boards:
        raise MondayAPIError(f"Board {BOARD_ID} not visible to this token.")
    board = boards[0]

    columns = board.get("columns") or []
    by_title = {c["title"]: c["id"] for c in columns if c.get("title")}
    column_ids: Dict[str, str] = {}
    missing: List[str] = []
    for t in titles:
        if t in by_title:
            column_ids[t] = by_title[t]
        else:
            missing.append(t)
    if missing:
        raise MondayAPIError(
            f"Could not find column titles {missing} on board {BOARD_ID}. "
            f"Available titles: {sorted(by_title.keys())}"
        )

    groups = board.get("groups") or []
    groups_by_title = {g.get("title"): g.get("id") for g in groups if g.get("title")}
    resolved_groups: Dict[str, str] = {}
    missing_groups: List[str] = []
    for gt in group_titles:
        if gt in groups_by_title:
            resolved_groups[gt] = groups_by_title[gt]
        else:
            missing_groups.append(gt)
    if missing_groups:
        available = sorted(groups_by_title.keys())
        raise MondayAPIError(
            f"Group(s) {missing_groups!r} not found on board {BOARD_ID}. "
            f"Available groups: {available}"
        )

    logger.info("Resolved column ids: %s, group_ids: %s", column_ids, resolved_groups)
    first_group_id = resolved_groups[group_titles[0]]
    return {"column_ids": column_ids, "group_ids": resolved_groups, "group_id": first_group_id}


# ---------------------------------------------------------------------------
# Item fetch
# ---------------------------------------------------------------------------

ITEMS_QUERY = """
query ($board_ids: [ID!], $group_ids: [String], $col_ids: [String!], $limit: Int!, $cursor: String) {
  boards(ids: $board_ids) {
    groups(ids: $group_ids) {
      id
      items_page(limit: $limit, cursor: $cursor) {
        cursor
        items {
          id
          name
          column_values(ids: $col_ids) {
            id
            text
            value
            type
          }
        }
      }
    }
  }
}
"""


def fetch_volunteers(
    column_ids: Dict[str, str],
    group_id: str,
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> List[Dict[str, Any]]:
    """Fetch all items in BOARD_ID/group_id and return a list of raw dicts.

    Narrow-fetch: only the County / Roles / Availability column_values are
    requested (mirrors the tracker query pattern shipped in Phase 1.5) to
    stay under Monday's per-query complexity budget. Fetching all 17
    columns on this board tripped the same 429 the tracker query hit.
    """
    col_ids = [
        column_ids[COL_TITLE_COUNTY],
        column_ids[COL_TITLE_AVAILABILITY],
        column_ids[COL_TITLE_ROLES],
        column_ids[COL_TITLE_WIN_AREA],
    ]
    # Phase B — also pull the 4 address columns (resolved by concrete ID) so
    # the geocoder can build the private coords dataset.
    col_ids.extend(ADDRESS_COL_IDS.values())
    out: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    page = 0
    while True:
        page += 1
        data = graphql_request(
            ITEMS_QUERY,
            variables={
                "board_ids": [BOARD_ID],
                "group_ids": [group_id],
                "col_ids": col_ids,
                "limit": PAGE_LIMIT,
                "cursor": cursor,
            },
            token=token,
            session=session,
        )
        boards = data.get("boards") or []
        if not boards:
            break
        groups = boards[0].get("groups") or []
        if not groups:
            logger.warning("Group %s not found on board %s", group_id, BOARD_ID)
            break
        page_block = groups[0].get("items_page") or {}
        items = page_block.get("items") or []
        logger.debug("Page %d: %d items", page, len(items))
        for it in items:
            out.append(it)
        cursor = page_block.get("cursor")
        if not cursor:
            break
    return out


# ---------------------------------------------------------------------------
# Per-volunteer parsing + filters
# ---------------------------------------------------------------------------


def _column_text(item: Dict[str, Any], col_id: str) -> str:
    for cv in item.get("column_values") or []:
        if cv.get("id") == col_id:
            return (cv.get("text") or "").strip()
    return ""


def parse_roles(text: str) -> List[str]:
    """Tags column `text` is a comma-separated list of tag labels."""
    if not text:
        return []
    return [t.strip() for t in text.split(",") if t.strip()]


# Valid WIN area labels are "Area 01" through "Area 16" (two-digit, zero-padded).
# The Monday.com column is a comma-separated text field that may also contain
# "NoArea", "Test Area", or freeform notes — only real areas pass through.
_VALID_WIN_AREAS = frozenset(f"Area {i:02d}" for i in range(1, 17))
# Mapping from zero-padded label ("Area 03") to the bare area number the rest
# of the pipeline uses ("3").
_WIN_AREA_LABEL_TO_NUM = {f"Area {i:02d}": str(i) for i in range(1, 17)}


def parse_monitored_areas(text: str) -> List[str]:
    """Parse the WIN Area column into a sorted list of area number strings.

    Input examples: "Area 03, Area 10", "Area 03", "Area 6", "NoArea", "".
    Output: ["3", "10"], ["3"], ["6"], [], [].
    Only areas 1–16 are retained; "NoArea", "Test Area", and any other
    freeform text are silently dropped.

    Tolerates both zero-padded ("Area 06") and unpadded ("Area 6") labels.
    """
    if not text:
        return []
    areas = []
    for part in text.split(","):
        label = part.strip()
        # Try exact match first (zero-padded "Area 06")
        if label in _VALID_WIN_AREAS:
            areas.append(_WIN_AREA_LABEL_TO_NUM[label])
            continue
        # Fallback: extract trailing digits from "Area N" pattern (unpadded)
        if label.lower().startswith("area"):
            digits = label[4:].strip().lstrip("0") or "0"
            if digits.isdigit():
                num = int(digits)
                if 1 <= num <= 16:
                    areas.append(str(num))
    return sorted(set(areas), key=int)


def _evaluate_unavail_date_clauses(
    text: str, today: date
) -> Tuple[str, bool]:
    """Parse 'Unavail M/D[-M/D][, ...]' clauses and decide vs. `today`.

    Returns ``(cleaned_text, currently_unavailable)``:
      * If ``today`` falls inside ANY parsed range → ``currently_unavailable``
        is True and the original text is returned unchanged (caller
        short-circuits to unavailable).
      * Otherwise all successfully-parsed clauses are stripped from the
        text so the surrounding schedule prose (e.g. "Avail Weekends.")
        can be re-checked against the keyword denylist without the
        residual "unavail" keyword tripping it.
      * If a clause matches the regex but a date fails ``date()``
        construction (e.g. month=13), the clause is left in place and a
        warning is logged — the keyword denylist will then conservatively
        treat the volunteer as unavailable.
    """
    spans_to_strip: List[Tuple[int, int]] = []
    for m in UNAVAIL_DATE_CLAUSE_RE.finditer(text):
        clause = m.group(0)
        pairs: List[Tuple[date, date]] = []
        parse_ok = True
        for chunk in clause.split(","):
            mds = _MD_TOKEN_RE.findall(chunk)
            if not mds:
                continue
            try:
                start = date(today.year, int(mds[0][0]), int(mds[0][1]))
                if len(mds) >= 2:
                    end = date(today.year, int(mds[1][0]), int(mds[1][1]))
                else:
                    end = start
            except ValueError as exc:
                logger.warning(
                    "Could not parse Unavail date clause %r: %s — "
                    "treating volunteer as unavailable.",
                    clause,
                    exc,
                )
                parse_ok = False
                break
            if end < start:
                start, end = end, start
            pairs.append((start, end))
        if not parse_ok or not pairs:
            continue  # leave clause in place so keyword denylist catches it
        if any(s <= today <= e for s, e in pairs):
            return text, True
        spans_to_strip.append(m.span())

    # Non-date markers like "Unavail TBD" — warn but leave in place.
    for m in _UNAVAIL_TBD_RE.finditer(text):
        logger.warning(
            "Unparseable Unavail clause %r in availability text; "
            "treating volunteer as unavailable.",
            m.group(0),
        )

    if not spans_to_strip:
        return text, False
    cleaned = text
    for start, end in reversed(spans_to_strip):
        cleaned = cleaned[:start] + cleaned[end:]
    return cleaned, False


def is_available(
    availability_text: str, today: Optional[date] = None
) -> bool:
    """True if volunteer is considered available for dispatch right now.

    ``today`` is injected for testability; production callers leave it
    as None and the function uses ``date.today()``.
    """
    if not availability_text or not availability_text.strip():
        return DEFAULT_AVAILABLE_WHEN_BLANK
    if today is None:
        today = date.today()
    # Day-of-week patterns — must be checked BEFORE the generic denylist so
    # that 'Unavail weekends' isn't swallowed by the 'unavail' denylist keyword.

    # Check for BOTH weekdays AND weekends → always available (or unavailable).
    # Must come before the single-match logic so 'Avail Weekdays, Weekends'
    # isn't short-circuited to weekdays-only.
    _DOW_BOTH_WD = re.compile(
        r"\b(un)?avail(?:able)?\s+weekdays?\b", re.IGNORECASE
    )
    _DOW_BOTH_WE = re.compile(r"\bweekends?\b", re.IGNORECASE)
    if _DOW_BOTH_WD.search(availability_text) and _DOW_BOTH_WE.search(availability_text):
        if re.search(r"\bunavail", availability_text, re.IGNORECASE):
            return False
        return True

    _DOW_RE = re.compile(
        r"\b(un)?avail(?:able)?\s+week(end|day)s?\b", re.IGNORECASE
    )
    dow_match = _DOW_RE.search(availability_text)
    if dow_match:
        negated   = bool(dow_match.group(1))   # True when 'un' prefix present
        period    = dow_match.group(2).lower()  # 'end' or 'day'
        is_weekend = today.weekday() >= 5       # Sat=5, Sun=6
        if period == "end":
            # 'Unavail weekends' → unavail on Sat/Sun
            # 'Avail weekends'   → avail ONLY on Sat/Sun
            if negated:
                return not is_weekend
            else:
                return is_weekend
        else:  # 'day'
            # 'Avail weekdays'   → avail ONLY Mon-Fri
            # 'Unavail weekdays' → unavail Mon-Fri (unusual but handled)
            if negated:
                return is_weekend
            else:
                return not is_weekend

    cleaned, currently_unavail = _evaluate_unavail_date_clauses(
        availability_text, today
    )
    if currently_unavail:
        return False
    return not bool(AVAILABILITY_DENYLIST_RE.search(cleaned))


def build_volunteer_record(
    item: Dict[str, Any], column_ids: Dict[str, str],
    connecteam_user: bool = True,
) -> Optional[Dict[str, Any]]:
    """Convert a raw Monday item to a normalized volunteer dict.

    Returns a record for ANY volunteer regardless of role so that
    aggregate_by_county (which gates on volunteer_buckets) remains the
    single source of truth for Tier-1 capacity filtering.  Volunteers
    without C&T / RVS / Courier roles will have has_ct/has_rvs/has_courier
    all False, so volunteer_buckets returns [] and they are skipped by
    aggregate_by_county — county_capacity.json is unaffected.
    """
    name = (item.get("name") or "").strip()
    county = _column_text(item, column_ids[COL_TITLE_COUNTY])
    roles_text = _column_text(item, column_ids[COL_TITLE_ROLES])
    availability_text = _column_text(item, column_ids[COL_TITLE_AVAILABILITY])

    roles = parse_roles(roles_text)
    role_set = set(roles)

    return {
        "name": name,
        "county": county,
        "roles": roles,
        "availability_text": availability_text,
        "has_ct": "C&T" in role_set,
        "has_rvs": "RVS" in role_set,
        "has_courier": "Courier" in role_set,
        "available": is_available(availability_text),
        "connecteam_user": connecteam_user,
    }


def build_geocode_input(
    item: Dict[str, Any], column_ids: Dict[str, str],
    connecteam_user: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    """Build a geocoder-input dict (with address fields) from a raw item.

    Returns a dict for ANY volunteer with a non-blank street+city so the
    full board population (all 163 users/non-users) is geocoded and uploaded
    to the VOLUNTEER_COORDS KV namespace.  QUALIFYING_ROLES is intentionally
    NOT checked here — role filtering at geocode time was the root cause of
    the DuBois/Area-44 "0 volunteers found" bug (non-C&T volunteers were
    invisible to Tier-2 radius search).  The 'roles' field is still
    propagated on each record so the Worker can apply role-based filtering
    (role_counts, findContextRows qualify-only gate) at query time.

    The address fields are PII and are consumed only in-memory by the
    geocoder; they are NEVER written to the output dataset.
    """
    county = _column_text(item, column_ids[COL_TITLE_COUNTY])
    roles_text = _column_text(item, column_ids[COL_TITLE_ROLES])
    roles = parse_roles(roles_text)

    availability_text = _column_text(item, column_ids[COL_TITLE_AVAILABILITY])
    win_area_text = _column_text(item, column_ids[COL_TITLE_WIN_AREA])
    return {
        "county": county,
        "roles": roles,
        # Availability is computed here (SAME definition as build_volunteer_record
        # / Tier 1 county capacity) so the geocoder can propagate a PII-free
        # boolean onto each coords record. This lets the Worker tally Tier 2
        # availability the same way Tier 1 does.
        "available": is_available(availability_text),
        "availability_text": availability_text,
        # Carry the Connecteam-membership flag (same derivation as Tier 1 /
        # build_volunteer_record: group_title == 'users') through to the
        # geocoder so it lands on each coords record -> volunteer_coords.json
        # -> KV. PII-free boolean (or None when unknown). Without this the
        # Tier-2 KV dataset omitted the flag and the Worker coerced every row
        # to "not on Connecteam" (the DuBois 7-of-7 banner bug).
        "connecteam_user": connecteam_user,
        # WIN Area column from Monday.com: parsed list of area numbers the
        # volunteer monitors (e.g. ["3", "10"]). PII-free, carried through to
        # the KV dataset so the Worker/UI can identify vols monitoring areas
        # outside their home county.
        "monitored_areas": parse_monitored_areas(win_area_text),
        "street": _column_text(item, ADDRESS_COL_IDS["street"]),
        "city": _column_text(item, ADDRESS_COL_IDS["city"]),
        "state": _column_text(item, ADDRESS_COL_IDS["state"]),
        "zip": _column_text(item, ADDRESS_COL_IDS["zip"]),
    }


# ---------------------------------------------------------------------------
# Phase C — RehabDB fetch + transform (PUBLIC rehabber dataset)
# ---------------------------------------------------------------------------

# Board-level items query (no group filter): RehabDB rehabbers are not split
# into the users/non-users groups the volunteer board uses.
REHAB_ITEMS_QUERY = """
query ($board_ids: [ID!], $col_ids: [String!], $limit: Int!, $cursor: String) {
  boards(ids: $board_ids) {
    items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
        id
        name
        column_values(ids: $col_ids) {
          id
          text
          value
          type
        }
      }
    }
  }
}
"""


def fetch_rehabbers(
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> List[Dict[str, Any]]:
    """Fetch all items on the RehabDB board and return raw item dicts.

    Narrow-fetch: only the REHAB_COL_IDS column_values are requested (mirrors
    the volunteer fetch pattern) to stay under Monday's per-query complexity
    budget. Paginates via items_page cursor.
    """
    col_ids = list(REHAB_COL_IDS.values())
    out: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    page = 0
    while True:
        page += 1
        data = graphql_request(
            REHAB_ITEMS_QUERY,
            variables={
                "board_ids": [REHAB_BOARD_ID],
                "col_ids": col_ids,
                "limit": PAGE_LIMIT,
                "cursor": cursor,
            },
            token=token,
            session=session,
        )
        boards = data.get("boards") or []
        if not boards:
            break
        page_block = boards[0].get("items_page") or {}
        items = page_block.get("items") or []
        logger.debug("RehabDB page %d: %d items", page, len(items))
        for it in items:
            out.append(it)
        cursor = page_block.get("cursor")
        if not cursor:
            break
    return out


def _parse_float(text: str) -> Optional[float]:
    """Parse a coordinate string to float, or None if blank/unparseable."""
    if text is None:
        return None
    s = text.strip()
    if not s:
        return None
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def build_rehabber_record(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Convert a raw RehabDB item to a PUBLIC-safe rehabber dict.

    Emits ONLY the public fields {rehab_name, lat, lon, county, phone,
    website, availability} (lat/lon as floats). The
    ``phone`` field is the facility's PUBLIC phone (verbatim board text,
    empty string when blank) — a public-org contact number, NOT volunteer
    PII. The ``availability`` field is the raw 'Availability' cell text carried through
    verbatim (the M/P/RVS key letters the dispatcher reads) — NOT parsed,
    normalized, or interpreted here; empty string when blank. It is
    facility-level key letters only, so it introduces no volunteer PII. Rows
    missing a parseable lat OR lon are skipped with a logged warning. The
    rehab_name falls back to the item name (rehabber's last name) when the
    dedicated column is blank, so the record is still identifiable.
    """
    rehab_name = _column_text(item, REHAB_COL_IDS["rehab_name"])
    if not rehab_name:
        rehab_name = (item.get("name") or "").strip()

    lat = _parse_float(_column_text(item, REHAB_COL_IDS["latitude"]))
    lon = _parse_float(_column_text(item, REHAB_COL_IDS["longitude"]))
    if lat is None or lon is None:
        logger.warning(
            "Skipping rehabber %r: missing/unparseable lat/lon "
            "(lat=%r, lon=%r)",
            rehab_name or item.get("id"),
            _column_text(item, REHAB_COL_IDS["latitude"]),
            _column_text(item, REHAB_COL_IDS["longitude"]),
        )
        return None

    return {
        "rehab_name": rehab_name,
        "lat": lat,
        "lon": lon,
        "county": _column_text(item, REHAB_COL_IDS["county"]),
        "phone": _column_text(item, REHAB_COL_IDS["phone"]),
        "website": _column_text(item, REHAB_COL_IDS["website"]),
        "availability": _column_text(item, REHAB_COL_IDS["availability"]),
    }


def build_rehabbers(items: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Transform raw RehabDB items into the list of public rehabber records.

    Rows missing lat/lon are skipped (build_rehabber_record warns).
    """
    out: List[Dict[str, Any]] = []
    for it in items:
        rec = build_rehabber_record(it)
        if rec is not None:
            out.append(rec)
    return out


# ---------------------------------------------------------------------------
# Facility-status page BASE dataset (Option A: join-at-read)
# ---------------------------------------------------------------------------
#
# docs/facilities.html merges this BASE-facility dataset with the Google-Sheet
# STATUS feed by NORMALIZED facility name at read time. We emit ONLY base
# fields here; the Monday open/closed column (color_mkv6xbc) is NEVER pulled
# (it is not kept current). The full facility name — the join key against the
# Sheet — is sourced from the FACILITY_NAME_MAP_REL_PATH bridge because the
# board's 'Rehab Name' column is an abbreviation; see that constant's comment.


def load_facility_name_map(repo_root: Path) -> Dict[str, str]:
    """Load the committed Monday-abbreviation -> full-facility-name map.

    Returns {} (with a warning) when the file is missing so a fresh checkout
    still runs; malformed JSON raises so a typo fails loud rather than
    silently degrading every facility's join key.
    """
    path = repo_root / FACILITY_NAME_MAP_REL_PATH
    if not path.exists():
        logger.warning(
            "%s not found; facility names will fall back to the raw "
            "'Rehab Name' abbreviation (Sheet join will likely miss).",
            FACILITY_NAME_MAP_REL_PATH,
        )
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(
            f"{FACILITY_NAME_MAP_REL_PATH} must be a JSON object "
            f"(abbreviation -> full name), got {type(data).__name__}."
        )
    return {str(k): str(v) for k, v in data.items()}


def parse_facility_name_from_availability(text: str) -> str:
    """Best-effort full facility name from the free-text 'Availability' column.

    Availability is free text that usually LEADS with the facility name followed
    by animal-code tokens / notes (e.g. "Schuylkill Wildlife Rehabilitation
    Center M,P,R,RA" or "Adams County Wildlife Care\\nM"). We take the first
    line, then strip a trailing run of animal-code tokens (1-4 uppercase letters,
    optionally separated by commas/slashes/spaces) and any trailing punctuation.
    Returns "" when nothing name-like can be extracted. This is a FALLBACK only;
    the owner column and the static map take precedence.
    """
    if not text:
        return ""
    first = re.split(r"[\n\r]", text, maxsplit=1)[0]
    # Split off an explicit notes tail and double-space separated code blocks.
    first = re.split(r"\s{2,}|;|\bNOTE\b", first, maxsplit=1)[0]
    # Strip a trailing animal-code cluster like " M,P,R,RA" or " P/R" or " M".
    first = re.sub(
        r"\s+[A-Z]{1,4}(?:\s*[,/]\s*[A-Z]{1,4})*\.?\s*$", "", first
    )
    first = first.strip().strip(",").strip()
    # If what remains is itself just an animal-code cluster (e.g. the field was
    # only "M,P,R" with no facility name), treat it as no name at all so the
    # caller falls through to the raw abbreviation.
    if re.fullmatch(r"[A-Z]{1,4}(?:\s*[,/]\s*[A-Z]{1,4})*\.?", first):
        return ""
    return first


def _resolve_facility_join_name(
    item: Dict[str, Any],
    name_map: Dict[str, str],
) -> str:
    """Resolve a facility's join name via the Option-A precedence chain.

    Precedence:
      1. dedicated 'Facility Name' column (PRIMARY, clean join key) when non-empty
      2. static facility_name_map.json keyed on 'Rehab Name' (thin fallback)
      3. name parsed from the free-text 'Availability' column
      4. raw 'Rehab Name' (or item name) as a last resort
    """
    # 1) Dedicated full-name column — the clean Option-A join key. Populated
    # incrementally by the org; non-empty value always wins.
    facility = _column_text(item, REHAB_COL_IDS["facility_name"])
    if facility:
        return facility

    abbr = _column_text(item, REHAB_COL_IDS["rehab_name"])
    if not abbr:
        abbr = (item.get("name") or "").strip()

    # 2) Hand-maintained abbreviation -> full Sheet name map (fallback only for
    # rows where the Facility Name column is not yet filled).
    mapped = name_map.get(abbr)
    if mapped:
        return mapped

    # 3) Parse the leading facility name out of the Availability free text.
    parsed = parse_facility_name_from_availability(
        _column_text(item, REHAB_COL_IDS["availability"])
    )
    if parsed:
        logger.warning(
            "Facility %r has a blank Facility Name column and no %s entry; "
            "using name parsed from Availability (%r). Fill the Facility Name "
            "column (or add a map entry) to pin it.",
            abbr or item.get("id"),
            FACILITY_NAME_MAP_REL_PATH,
            parsed,
        )
        return parsed

    # 4) Last resort: the raw abbreviation.
    logger.warning(
        "Facility %r has a blank Facility Name column, no %s entry, and no "
        "parseable Availability name; falling back to the raw abbreviation as "
        "the join name.",
        abbr or item.get("id"),
        FACILITY_NAME_MAP_REL_PATH,
    )
    return abbr


def build_facility_record(
    item: Dict[str, Any],
    name_map: Dict[str, str],
) -> Optional[Dict[str, Any]]:
    """Convert a raw RehabDB item to a BASE-facility record for facilities.json.

    Emits ONLY base fields: {name, address, city, state, zip, phone, website,
    lat, lon, county}. NO status/open-closed field is ever included. ``name``
    is the join key against the Google Sheet, resolved via the Option-A
    precedence chain in _resolve_facility_join_name (Facility Name column ->
    name-map -> Availability-parsed -> raw 'Rehab Name'). Rows missing a
    parseable lat OR lon are skipped with a logged warning (same rule as
    build_rehabber_record).
    """
    name = _resolve_facility_join_name(item, name_map)

    lat = _parse_float(_column_text(item, REHAB_COL_IDS["latitude"]))
    lon = _parse_float(_column_text(item, REHAB_COL_IDS["longitude"]))
    if lat is None or lon is None:
        logger.warning(
            "Skipping facility %r: missing/unparseable lat/lon "
            "(lat=%r, lon=%r)",
            name or item.get("id"),
            _column_text(item, REHAB_COL_IDS["latitude"]),
            _column_text(item, REHAB_COL_IDS["longitude"]),
        )
        return None

    return {
        "name": name,
        "address": _column_text(item, REHAB_COL_IDS["address"]),
        "city": _column_text(item, REHAB_COL_IDS["city"]),
        "state": _column_text(item, REHAB_COL_IDS["state"]),
        "zip": _column_text(item, REHAB_COL_IDS["zip"]),
        "phone": _column_text(item, REHAB_COL_IDS["phone"]),
        "website": _column_text(item, REHAB_COL_IDS["website"]),
        "lat": lat,
        "lon": lon,
        "county": _column_text(item, REHAB_COL_IDS["county"]),
    }


def build_facilities(
    items: Iterable[Dict[str, Any]],
    name_map: Dict[str, str],
) -> List[Dict[str, Any]]:
    """Transform raw RehabDB items into the BASE-facility list for the page.

    Rows missing lat/lon are skipped (build_facility_record warns).
    """
    out: List[Dict[str, Any]] = []
    for it in items:
        rec = build_facility_record(it, name_map)
        if rec is not None:
            out.append(rec)
    return out


# ---------------------------------------------------------------------------
# Area-coordinator NAME fetch + transform (PUBLIC-safe area->name dataset)
# ---------------------------------------------------------------------------
#
# The county->area map stays in counties.xlsx (stable). Only the volatile
# coordinator NAME is refreshed from Monday so a coordinator change flows
# through the normal refresh. The board ITEM NAME is the WIN area string
# (matched EXACTLY against county_win area values like "15N"/"10"); the
# coordinator name lives in long_text_mm455k2n.
#
# HARD PII RULE: the phone column (phone_mm45s2h0) is NEVER requested, stored,
# or emitted. We only ever ask Monday for COORD_COL_IDS (the name column) and
# read the item name — phone never enters this pipeline.

# Group-scoped query: coordinators live in the 'Coordinators' topics group.
COORDINATORS_ITEMS_QUERY = """
query ($board_ids: [ID!], $group_ids: [String], $col_ids: [String!], $limit: Int!, $cursor: String) {
  boards(ids: $board_ids) {
    groups(ids: $group_ids) {
      id
      items_page(limit: $limit, cursor: $cursor) {
        cursor
        items {
          id
          name
          column_values(ids: $col_ids) {
            id
            text
            value
            type
          }
        }
      }
    }
  }
}
"""


def discover_coordinators_group_id(
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> str:
    """Resolve the 'Coordinators' group id on the Area Coordinators board.

    Mirrors the volunteer group resolution but is scoped to
    COORDINATORS_BOARD_ID so it can run independently of the volunteer
    board introspection.
    """
    data = graphql_request(
        INTROSPECT_QUERY,
        variables={"board_ids": [COORDINATORS_BOARD_ID]},
        token=token,
        session=session,
    )
    boards = data.get("boards") or []
    if not boards:
        raise MondayAPIError(
            f"Board {COORDINATORS_BOARD_ID} not visible to this token."
        )
    groups = boards[0].get("groups") or []
    by_title = {g.get("title"): g.get("id") for g in groups if g.get("title")}
    gid = by_title.get(COORDINATORS_GROUP_TITLE)
    if not gid:
        raise MondayAPIError(
            f"Group {COORDINATORS_GROUP_TITLE!r} not found on board "
            f"{COORDINATORS_BOARD_ID}. Available groups: "
            f"{sorted(by_title.keys())}"
        )
    return gid


def fetch_coordinators(
    group_id: str,
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> List[Dict[str, Any]]:
    """Fetch coordinator items and return raw item dicts.

    Narrow-fetch: ONLY the COORD_COL_IDS name column is requested (the phone
    column is deliberately excluded — see HARD PII RULE above). Paginates via
    items_page cursor like the other board fetches.
    """
    col_ids = list(COORD_COL_IDS.values())
    out: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    page = 0
    while True:
        page += 1
        data = graphql_request(
            COORDINATORS_ITEMS_QUERY,
            variables={
                "board_ids": [COORDINATORS_BOARD_ID],
                "group_ids": [group_id],
                "col_ids": col_ids,
                "limit": PAGE_LIMIT,
                "cursor": cursor,
            },
            token=token,
            session=session,
        )
        boards = data.get("boards") or []
        if not boards:
            break
        groups = boards[0].get("groups") or []
        if not groups:
            break
        page_block = groups[0].get("items_page") or {}
        items = page_block.get("items") or []
        logger.debug("Coordinators page %d: %d items", page, len(items))
        for it in items:
            out.append(it)
        cursor = page_block.get("cursor")
        if not cursor:
            break
    return out


def build_coordinators(items: Iterable[Dict[str, Any]]) -> Dict[str, str]:
    """Transform raw coordinator items into an area-string -> name mapping.

    The item NAME is the WIN area string (kept verbatim so it matches the
    county_win area values exactly). The coordinator name comes from the
    COORD_COL_IDS["name"] long-text column. Items with a blank area name or a
    blank coordinator name are skipped (nothing to override with). Phone is
    never read. Returns a plain dict suitable for atomic_write_json.
    """
    out: Dict[str, str] = {}
    for it in items:
        area = (it.get("name") or "").strip()
        name = _column_text(it, COORD_COL_IDS["name"])
        if not area or not name:
            continue
        out[area] = name
    return out


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

BUCKETS = ("ct_no_rvs", "ct_rvs", "courier")


# ---------------------------------------------------------------------------
# Phase 2.5 — config file (tunable thresholds + per-county overrides)
# ---------------------------------------------------------------------------


def load_config(repo_root: Path) -> Dict[str, Any]:
    """Load docs/data/config.json relative to repo_root.

    Missing file: log a warning and return {} (callers fall back to
    DEFAULT_CONFIG via resolve_*). Malformed JSON: re-raise so the caller
    fails loud — silently swallowing bad config would mask dispatcher
    misconfiguration.
    """
    path = repo_root / CONFIG_REL_PATH
    if not path.exists():
        logger.warning("config.json not found at %s; using defaults", path)
        return {}
    raw = path.read_text(encoding="utf-8")
    return json.loads(raw)  # JSONDecodeError propagates up


def _warn_unknown_county_overrides(config: Dict[str, Any]) -> None:
    """Log a warning for any county_overrides key not in PA_COUNTIES.

    Called once per process (cached via a module-level set) so the same
    misspelling doesn't spam the log on every per-county resolution.
    """
    overrides = (config or {}).get("county_overrides") or {}
    if not isinstance(overrides, dict):
        return
    known = set(PA_COUNTIES)
    for name in overrides:
        if name in known:
            continue
        if name in _warn_unknown_county_overrides._seen:  # type: ignore[attr-defined]
            continue
        _warn_unknown_county_overrides._seen.add(name)  # type: ignore[attr-defined]
        logger.warning("Unknown county in config.county_overrides: %s", name)


_warn_unknown_county_overrides._seen = set()  # type: ignore[attr-defined]


def resolve_marginal_threshold(config: Dict[str, Any], county: str) -> int:
    """Resolve the marginal_threshold for a given county.

    Deep-merge rule: start with DEFAULT_CONFIG['marginal_threshold'], then
    overlay config['marginal_threshold'] (global), then overlay
    config['county_overrides'][county]['marginal_threshold'] if present.
    """
    _warn_unknown_county_overrides(config)
    threshold = DEFAULT_CONFIG["marginal_threshold"]
    if isinstance(config, dict):
        if "marginal_threshold" in config:
            threshold = config["marginal_threshold"]
        overrides = (config.get("county_overrides") or {}).get(county) or {}
        if isinstance(overrides, dict) and "marginal_threshold" in overrides:
            threshold = overrides["marginal_threshold"]
    return int(threshold)


def volunteer_buckets(v: Dict[str, Any]) -> List[str]:
    buckets: List[str] = []
    if v["has_ct"] and not v["has_rvs"]:
        buckets.append("ct_no_rvs")
    if v["has_ct"] and v["has_rvs"]:
        buckets.append("ct_rvs")
    if v["has_courier"]:
        buckets.append("courier")
    return buckets


def aggregate_by_county(
    volunteers: Iterable[Dict[str, Any]],
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Dict[str, Any]]:
    """Build the {county: {bucket: {total, available, marginal_volunteers}}} map.

    `config` is the parsed docs/data/config.json (or None / {} for defaults).
    The marginal threshold is resolved per-county so a single county can
    have a different threshold than the global default.
    """
    counties: Dict[str, Dict[str, Dict[str, Any]]] = {}

    for v in volunteers:
        county = v["county"] or ""
        if not county:
            logger.debug("Skipping volunteer with no county: %s", v.get("name"))
            continue
        bucket_list = volunteer_buckets(v)
        if not bucket_list:
            continue
        cdata = counties.setdefault(county, {})
        for b in bucket_list:
            slot = cdata.setdefault(
                b, {"total": 0, "available": 0, "_members": []}
            )
            slot["total"] += 1
            if v["available"]:
                slot["available"] += 1
            slot["_members"].append(
                {
                    "availability_note": v["availability_text"],
                    "connecteam_user": v.get("connecteam_user", True),
                }
            )

    # Finalize: drop _members into marginal_volunteers only when warranted,
    # and ensure all three bucket keys exist for each emitted county.
    cfg = config or {}
    final: Dict[str, Dict[str, Any]] = {}
    for county, cdata in counties.items():
        threshold = resolve_marginal_threshold(cfg, county)
        out: Dict[str, Any] = {}
        for b in BUCKETS:
            slot = cdata.get(b)
            if slot is None:
                out[b] = {"total": 0, "available": 0, "marginal_volunteers": []}
                continue
            members = slot.pop("_members", [])
            if slot["available"] <= threshold:
                slot["marginal_volunteers"] = members
            else:
                slot["marginal_volunteers"] = []
            out[b] = slot
        final[county] = out

    return final


def build_snapshot(
    volunteers: Iterable[Dict[str, Any]],
    group_id: str = "",
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    counties = aggregate_by_county(volunteers, config=config)
    return {
        "generated_at": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "source_board_id": BOARD_ID,
        "source_group_id": group_id,
        "availability_keywords": list(AVAILABILITY_KEYWORDS),
        "counties": counties,
    }


# ---------------------------------------------------------------------------
# Atomic write + diff
# ---------------------------------------------------------------------------


def atomic_write_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_existing_snapshot(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        logger.warning("Could not parse existing snapshot %s: %s", path, exc)
        return None


def _county_signature(c: Dict[str, Any]) -> Tuple:
    return tuple(
        (b, c.get(b, {}).get("total", 0), c.get(b, {}).get("available", 0))
        for b in BUCKETS
    )


def print_diff(old: Optional[Dict[str, Any]], new: Dict[str, Any]) -> None:
    old_counties = (old or {}).get("counties", {}) or {}
    new_counties = new.get("counties", {}) or {}
    old_keys = set(old_counties)
    new_keys = set(new_counties)

    added = sorted(new_keys - old_keys)
    removed = sorted(old_keys - new_keys)
    common = sorted(old_keys & new_keys)

    if added:
        print("Added counties:")
        for k in added:
            print(f"  + {k}")
    if removed:
        print("Removed counties:")
        for k in removed:
            print(f"  - {k}")
    changed = 0
    for k in common:
        if _county_signature(old_counties[k]) != _county_signature(new_counties[k]):
            changed += 1
            print(f"Changed: {k}")
            for b in BUCKETS:
                o = old_counties[k].get(b, {})
                n = new_counties[k].get(b, {})
                if (o.get("total"), o.get("available")) != (n.get("total"), n.get("available")):
                    print(
                        f"  * {b}: total {o.get('total', 0)} -> {n.get('total', 0)}, "
                        f"available {o.get('available', 0)} -> {n.get('available', 0)}"
                    )
    if not added and not removed and changed == 0:
        print("No changes.")


# ---------------------------------------------------------------------------
# Phase 1.5 — staleness gate (tracker board + sidecar)
# ---------------------------------------------------------------------------

class StalenessError(RuntimeError):
    """Raised when the tracker-board response is malformed (no items, missing
    column, unparseable date). Causes --if-stale to fail loud rather than
    silently fall through to a full pull."""


TRACKER_DISCOVERY_QUERY = """
query ($board_ids: [ID!]) {
  boards(ids: $board_ids) {
    id
    columns { id title }
    groups { id title }
  }
}
"""

TRACKER_ITEMS_QUERY = """
query ($board_ids: [ID!], $group_ids: [String], $col_ids: [String!], $limit: Int!) {
  boards(ids: $board_ids) {
    groups(ids: $group_ids) {
      id
      items_page(limit: $limit) {
        items {
          id
          column_values(ids: $col_ids) { id text value }
        }
      }
    }
  }
}
"""

TRACKER_ITEMS_LIMIT = 25


def _parse_remote_datetime(text: str, value_json: Optional[str]) -> datetime:
    """Parse a Monday date+time column into a tz-aware UTC datetime.

    Tries the JSON `value` first ({"date": "YYYY-MM-DD", "time": "HH:MM:SS"})
    and falls back to the human `text` ("YYYY-MM-DD HH:MM:SS" or
    "YYYY-MM-DD"). Monday returns these in UTC.
    """
    if value_json:
        try:
            v = json.loads(value_json)
            if isinstance(v, dict) and v.get("date"):
                date_part = v["date"]
                time_part = v.get("time") or "00:00:00"
                dt = datetime.strptime(f"{date_part} {time_part}", "%Y-%m-%d %H:%M:%S")
                return dt.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError, json.JSONDecodeError):
            pass
    if text:
        t = text.strip()
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                return datetime.strptime(t, fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
    raise StalenessError(
        f"Unparseable Last_Updated value (text={text!r}, value={value_json!r})"
    )


def fetch_remote_last_updated(
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> datetime:
    """Query the VolDB_Status tracker board and return MAX(Last_Updated) as
    a tz-aware UTC datetime.

    Two-step to stay under Monday's per-query complexity budget:
      1. Discovery: flat metadata (columns + groups, no items, no values)
         to resolve col_id and group_id by title — cheap.
      2. Narrow fetch: items_page scoped to the resolved group with
         column_values filtered to the resolved col_id only, limit 25.
    The earlier single-call shape (all groups x items_page(100) x ALL
    column_values) cost ~5M complexity per call and tripped 429s.

    Raises StalenessError if the response is malformed (group missing,
    column missing, no items, all values unparseable)."""
    disc = graphql_request(
        TRACKER_DISCOVERY_QUERY,
        variables={"board_ids": [TRACKER_BOARD_ID]},
        token=token,
        session=session,
    )
    boards = disc.get("boards") or []
    if not boards:
        raise StalenessError(
            f"Tracker board {TRACKER_BOARD_ID} not visible to this token."
        )
    board = boards[0]

    columns = board.get("columns") or []
    col_id: Optional[str] = None
    for c in columns:
        if c.get("title") == TRACKER_COL_TITLE_LAST_UPDATED:
            col_id = c.get("id")
            break
    if not col_id:
        available = sorted(c.get("title") for c in columns if c.get("title"))
        raise StalenessError(
            f"Column {TRACKER_COL_TITLE_LAST_UPDATED!r} not found on tracker "
            f"board {TRACKER_BOARD_ID}. Available titles: {available}"
        )

    groups = board.get("groups") or []
    group_id: Optional[str] = None
    for g in groups:
        if g.get("title") == TRACKER_GROUP_TITLE:
            group_id = g.get("id")
            break
    if group_id is None:
        available = sorted(g.get("title") for g in groups if g.get("title"))
        raise StalenessError(
            f"Group {TRACKER_GROUP_TITLE!r} not found on tracker "
            f"board {TRACKER_BOARD_ID}. Available titles: {available}"
        )

    data = graphql_request(
        TRACKER_ITEMS_QUERY,
        variables={
            "board_ids": [TRACKER_BOARD_ID],
            "group_ids": [group_id],
            "col_ids": [col_id],
            "limit": TRACKER_ITEMS_LIMIT,
        },
        token=token,
        session=session,
    )
    boards2 = data.get("boards") or []
    groups2 = (boards2[0].get("groups") if boards2 else None) or []
    items = ((groups2[0].get("items_page") if groups2 else None) or {}).get("items") or []
    if not items:
        raise StalenessError(
            f"Group {TRACKER_GROUP_TITLE!r} on tracker board "
            f"{TRACKER_BOARD_ID} has zero items; cannot determine "
            f"Last_Updated."
        )

    timestamps: List[datetime] = []
    for it in items:
        for cv in it.get("column_values") or []:
            if cv.get("id") == col_id:
                text = (cv.get("text") or "").strip()
                value_json = cv.get("value")
                if not text and not value_json:
                    continue  # blank cell — skip, but don't fail yet
                timestamps.append(_parse_remote_datetime(text, value_json))
                break
    if not timestamps:
        raise StalenessError(
            f"Last_Updated column has no values in group "
            f"{TRACKER_GROUP_TITLE!r} (scanned {len(items)} items)."
        )
    return max(timestamps)


def _format_iso_z(dt: datetime) -> str:
    """Format a tz-aware datetime as ISO8601 UTC with Z suffix, no microseconds."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc).replace(microsecond=0)
    return dt.isoformat().replace("+00:00", "Z")


def read_sidecar(path: Path) -> Optional[datetime]:
    """Return the parsed sidecar timestamp, or None if missing/empty.

    Unparseable contents raise StalenessError so callers can decide whether
    to surface or swallow."""
    if not path.exists():
        return None
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return None
    text = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError as exc:
        raise StalenessError(
            f"Sidecar {path} contains unparseable timestamp: {raw!r} ({exc})"
        )
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def atomic_write_sidecar(path: Path, dt: datetime) -> None:
    """Write the timestamp as a single ISO8601-Z line, atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(_format_iso_z(dt) + "\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Post-processing validation
# ---------------------------------------------------------------------------
#
# Two independent safety nets that run AFTER all per-volunteer records are
# built but BEFORE the private coords dataset is written / uploaded to KV:
#
#   * Check 1 — record integrity (BLOCKING). Every emitted coords record must
#     carry all required fields, and each field must still belong to the SAME
#     volunteer it was built from (no cross-volunteer field bleed — e.g. coords
#     from one person paired with another person's roles). A failure means we
#     refuse to publish: the caller exits non-zero so bad data never reaches KV.
#
#   * Check 2 — geocode accuracy (NON-BLOCKING / on-demand). A reverse sanity
#     check that the stored (lat, lon) actually fall inside the volunteer's
#     stated home county (point-in-polygon via county_pip) and, optionally, that
#     a re-geocode lands within ~1 mile of the stored coords. Mismatches are
#     logged as warnings; this is wired to a `--validate` mode so it can run in
#     CI / on demand rather than blocking every refresh.

# The fields every coords record MUST carry. ``home_county`` is the geocoder's
# name for the Monday "County" field; ``connecteam_user`` is the PII-free
# stand-in for name/identity carried onto each record (tri-state True/False/None,
# where None == unknown but the KEY must still be present).
REQUIRED_COORDS_FIELDS = (
    "lat",
    "lon",
    "home_county",
    "win_area",
    "roles",
    "available",
    "connecteam_user",
)

# How far a re-geocode may drift from the stored coords before we flag it.
GEOCODE_ACCURACY_TOLERANCE_MI = 1.0


class RecordIntegrityError(RuntimeError):
    """Raised (by the caller, after collecting all failures) when any coords
    record fails the required-field / cross-volunteer-association check. The
    pipeline must exit non-zero on this so partial / scrambled data is never
    written or uploaded."""


def validate_record_integrity(
    coords: Sequence[Dict[str, Any]],
) -> List[str]:
    """Check 1 — record integrity. Returns a list of human-readable error
    strings (empty == all records valid).

    For each coords record we assert:
      1. all REQUIRED_COORDS_FIELDS keys are present (``None`` is allowed ONLY
         for ``win_area`` — an unknown county — and ``connecteam_user`` — an
         unknown Connecteam membership; every other field must be non-None),
      2. ``lat`` / ``lon`` are finite numbers,
      3. ``roles`` is a list,
      4. fields still belong to the SAME volunteer: ``win_area`` must equal the
         WIN area that ``home_county`` resolves to via county_win. A mismatch is
         the tell-tale of cross-volunteer field bleed (coords/roles from person
         A stitched onto person B's county), so it is flagged as an integrity
         error rather than a soft warning.

    The function NEVER raises — it returns the full list of problems so the
    caller can log every failure (which volunteer index, which field) in one
    pass before deciding to abort.
    """
    errors: List[str] = []
    # win_area and connecteam_user may legitimately be None (unknown).
    nullable = {"win_area", "connecteam_user"}

    for idx, rec in enumerate(coords):
        # A stable, PII-free label for the offending record. home_county +
        # win_area + roles are non-identifying, so they are safe to log.
        label = (
            f"record #{idx} "
            f"(home_county={rec.get('home_county')!r}, "
            f"win_area={rec.get('win_area')!r})"
            if isinstance(rec, dict)
            else f"record #{idx}"
        )

        if not isinstance(rec, dict):
            errors.append(f"{label}: not a dict (got {type(rec).__name__}).")
            continue

        # 1. Required-field presence.
        for field in REQUIRED_COORDS_FIELDS:
            if field not in rec:
                errors.append(f"{label}: missing required field {field!r}.")
                continue
            if rec.get(field) is None and field not in nullable:
                errors.append(
                    f"{label}: required field {field!r} is None."
                )

        # 2. lat/lon must be finite numbers.
        for coord_field in ("lat", "lon"):
            val = rec.get(coord_field)
            if val is None:
                continue  # already reported above
            try:
                fval = float(val)
            except (TypeError, ValueError):
                errors.append(
                    f"{label}: {coord_field}={val!r} is not numeric."
                )
                continue
            if not math.isfinite(fval):
                errors.append(
                    f"{label}: {coord_field}={val!r} is not finite."
                )

        # 3. roles must be a list.
        if "roles" in rec and not isinstance(rec.get("roles"), list):
            errors.append(
                f"{label}: roles must be a list, got "
                f"{type(rec.get('roles')).__name__}."
            )

        # 4. Cross-volunteer association: win_area must match the area that
        # home_county resolves to. A blank county legitimately yields
        # win_area=None (no county to resolve), so only check when a county
        # is present.
        home_county = (rec.get("home_county") or "").strip()
        if home_county:
            info = county_win.lookup_county(home_county)
            expected_area = info.area if info is not None else None
            actual_area = rec.get("win_area")
            if expected_area != actual_area:
                errors.append(
                    f"{label}: win_area {actual_area!r} does not match the "
                    f"area {expected_area!r} that home_county "
                    f"{home_county!r} resolves to — possible cross-volunteer "
                    f"field mismatch."
                )

    return errors


def validate_geocode_accuracy(
    coords: Sequence[Dict[str, Any]],
    geocode_inputs: Optional[Sequence[Dict[str, Any]]] = None,
    session: Optional[requests.Session] = None,
    re_geocode: bool = False,
    tolerance_mi: float = GEOCODE_ACCURACY_TOLERANCE_MI,
) -> List[str]:
    """Check 2 — geocode accuracy (reverse sanity check). Returns a list of
    human-readable WARNING strings (empty == nothing suspicious).

    Two complementary modes (both PII-free in their output):

      * county match (always): the stored (lat, lon) is reverse-looked-up to a
        PA county via point-in-polygon (county_pip). If that county differs
        from the volunteer's stated ``home_county`` the coords are likely wrong
        (gross error — wrong town/state). Border edge-effects (PIP returns
        None) are reported as a soft "could not confirm", not a hard mismatch.

      * re-geocode (when ``re_geocode`` and ``geocode_inputs`` are supplied):
        re-run the address through the Census geocoder and compare to the
        stored coords. A drift greater than ``tolerance_mi`` (~1 mile) is
        flagged. ``geocode_inputs`` must be positionally aligned with
        ``coords`` is NOT assumed — instead each input is matched by its
        address signature so re-ordering can't cause a false mismatch.

    This is intentionally NON-fatal: it returns warnings for the caller to log.
    The refresh pipeline only fails on Check 1 (integrity); accuracy drift is
    surfaced for a human to investigate.
    """
    warnings: List[str] = []
    provider = dispatch_core.HaversineProvider()

    # Index geocode inputs by address signature for the optional re-geocode
    # pass. Only built when needed.
    inputs_by_sig: Dict[str, Dict[str, Any]] = {}
    if re_geocode and geocode_inputs:
        for gin in geocode_inputs:
            if not isinstance(gin, dict):
                continue
            sig = geocoder._address_signature(
                gin.get("street", ""),
                gin.get("city", ""),
                gin.get("state", ""),
                gin.get("zip", ""),
            )
            inputs_by_sig[sig] = gin
        session = session or requests.Session()

    for idx, rec in enumerate(coords):
        if not isinstance(rec, dict):
            continue
        home_county = (rec.get("home_county") or "").strip()
        lat = rec.get("lat")
        lon = rec.get("lon")
        label = (
            f"record #{idx} (home_county={home_county!r}, "
            f"win_area={rec.get('win_area')!r})"
        )
        if lat is None or lon is None:
            continue
        try:
            flat = float(lat)
            flon = float(lon)
        except (TypeError, ValueError):
            warnings.append(f"{label}: lat/lon not numeric; skipping accuracy check.")
            continue

        # (a) County match via reverse point-in-polygon.
        if home_county:
            pip = county_pip.lookup_latlon(flat, flon)
            if pip is None:
                warnings.append(
                    f"{label}: coords ({flat:.5f}, {flon:.5f}) fall outside "
                    f"every PA county polygon — could not confirm against "
                    f"home_county {home_county!r} (border edge or bad coords)."
                )
            elif _normalize_county(pip.get("county")) != _normalize_county(home_county):
                warnings.append(
                    f"{label}: coords reverse-geocode to county "
                    f"{pip.get('county')!r} but home_county is "
                    f"{home_county!r} — county mismatch."
                )

        # (b) Optional re-geocode drift check.
        if re_geocode and inputs_by_sig:
            sig = rec.get("_addr_sig")
            gin = inputs_by_sig.get(str(sig)) if sig else None
            if gin is None:
                continue
            fresh = geocoder.geocode_address(
                gin.get("street", ""),
                gin.get("city", ""),
                gin.get("state", ""),
                gin.get("zip", ""),
                session=session,
            )
            if fresh is None:
                warnings.append(
                    f"{label}: re-geocode returned no match; cannot verify "
                    f"stored coords."
                )
                continue
            drift = provider.distance_mi(flat, flon, fresh[0], fresh[1])
            if drift > tolerance_mi:
                warnings.append(
                    f"{label}: re-geocode landed {drift:.2f} mi from the "
                    f"stored coords (> {tolerance_mi:.1f} mi tolerance)."
                )

    return warnings


def _normalize_county(name: Optional[str]) -> str:
    """Case/whitespace-insensitive county-name key (mirrors county_win)."""
    return str(name or "").strip().casefold()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Refresh county capacity snapshot from Monday.com."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch + print JSON to stdout, do not write file.",
    )
    parser.add_argument(
        "--diff",
        action="store_true",
        help="Compare new snapshot to existing file and print county-level diff.",
    )
    parser.add_argument(
        "--introspect",
        action="store_true",
        help="Print the resolved column id mapping for the configured titles and exit.",
    )
    parser.add_argument("--verbose", action="store_true", help="DEBUG logging.")
    parser.add_argument(
        "--validate",
        action="store_true",
        help=(
            "Run the geocode-accuracy reverse sanity check (Check 2) after "
            "geocoding: confirm each volunteer's stored coords fall in their "
            "stated home county (point-in-polygon). Logs warnings only — does "
            "NOT block the refresh. Intended for CI / on-demand runs. The "
            "blocking record-integrity check (Check 1) always runs regardless "
            "of this flag."
        ),
    )
    parser.add_argument(
        "--revalidate-geocode",
        action="store_true",
        help=(
            "With --validate, also re-geocode each address via the Census API "
            "and warn when the fresh result drifts > ~1 mile from the stored "
            "coords. Slower (one network call per volunteer) and best run on "
            "demand / in CI."
        ),
    )
    parser.add_argument(
        "--if-stale",
        action="store_true",
        help=(
            "Cheap pre-check: query the VolDB_Status tracker board only. "
            "If the remote Last_Updated is newer than the sidecar "
            "timestamp (or sidecar is missing), proceed with full pull "
            "and update the sidecar on success. Otherwise print 'fresh, "
            "skipping' to stderr and exit 0."
        ),
    )
    args = parser.parse_args(argv)

    _setup_logging(args.verbose)

    repo_root = Path(__file__).resolve().parent
    try:
        config = load_config(repo_root)
    except json.JSONDecodeError as exc:
        print(
            f"ERROR: malformed {CONFIG_REL_PATH}: {exc}",
            file=sys.stderr,
        )
        return 7

    try:
        token = load_token()
    except MondayTokenFormatError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 6
    except MondayAuthError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    session = requests.Session()

    sidecar_path = Path(__file__).resolve().parent / SIDECAR_REL_PATH
    remote_ts: Optional[datetime] = None

    if args.if_stale:
        try:
            remote_ts = fetch_remote_last_updated(token=token, session=session)
        except (MondayAPIError, StalenessError) as exc:
            print(f"ERROR: staleness check failed: {exc}", file=sys.stderr)
            return 5
        try:
            local_ts = read_sidecar(sidecar_path)
        except StalenessError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 5
        if local_ts is not None and remote_ts <= local_ts:
            print(
                f"fresh, skipping (remote={_format_iso_z(remote_ts)} "
                f"local={_format_iso_z(local_ts)})",
                file=sys.stderr,
            )
            return 0
        logger.info(
            "stale: remote=%s local=%s — proceeding with full pull",
            _format_iso_z(remote_ts),
            _format_iso_z(local_ts) if local_ts else "<missing>",
        )

    try:
        meta = discover_board_metadata(
            [COL_TITLE_COUNTY, COL_TITLE_ROLES, COL_TITLE_AVAILABILITY,
             COL_TITLE_WIN_AREA],
            GROUP_TITLES,
            token=token,
            session=session,
        )
    except MondayAPIError as exc:
        print(f"ERROR: column discovery failed: {exc}", file=sys.stderr)
        return 3

    column_ids = meta["column_ids"]
    group_ids = meta["group_ids"]  # {title: group_id}

    if args.introspect:
        print(json.dumps(column_ids, indent=2))
        return 0

    # If we didn't already fetch remote_ts via --if-stale, do it now so we
    # can stamp the sidecar with the actual remote timestamp after a
    # successful pull. (Bare run still proceeds even if this fails — we
    # only fail loud on --if-stale; otherwise we log the warning and
    # skip the sidecar update.)
    if remote_ts is None:
        try:
            remote_ts = fetch_remote_last_updated(token=token, session=session)
        except (MondayAPIError, StalenessError) as exc:
            logger.warning(
                "Tracker board lookup failed (sidecar will not be updated): %s",
                exc,
            )

    # Fetch volunteers from each group, tagging with connecteam_user
    all_raw_items: List[Tuple[Dict[str, Any], bool]] = []
    volunteers: List[Dict[str, Any]] = []
    for group_title, gid in group_ids.items():
        is_connecteam = (group_title == "users")
        try:
            raw_items = fetch_volunteers(column_ids, gid, token=token, session=session)
        except MondayAPIError as exc:
            print(f"ERROR: fetch failed for group {group_title!r}: {exc}", file=sys.stderr)
            return 4
        logger.info("Group %r: %d raw items fetched", group_title, len(raw_items))
        # Pair each raw item with its group-derived Connecteam flag so the
        # geocode pass (Phase B) can carry it onto the coords records.
        all_raw_items.extend((item, is_connecteam) for item in raw_items)
        for item in raw_items:
            rec = build_volunteer_record(item, column_ids, connecteam_user=is_connecteam)
            if rec is not None:
                volunteers.append(rec)

    snapshot = build_snapshot(
        volunteers, group_id=",".join(group_ids.values()), config=config
    )

    out_path = Path(__file__).resolve().parent / OUTPUT_REL_PATH
    existing = load_existing_snapshot(out_path)

    if args.diff:
        print_diff(existing, snapshot)

    if args.dry_run:
        json.dump(snapshot, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        atomic_write_json(out_path, snapshot)
        logger.info("Wrote %s", out_path)
        if remote_ts is not None:
            atomic_write_sidecar(sidecar_path, remote_ts)
            logger.info(
                "Updated sidecar %s -> %s",
                sidecar_path,
                _format_iso_z(remote_ts),
            )

    # Phase B — geocode volunteer addresses into the PRIVATE coords dataset.
    # Built from the same raw items; the geocoder strips all PII and emits only
    # {lat,lon,roles,home_county,win_area}. Written to a GITIGNORED path
    # (COORDS_REL_PATH) and never committed. Idempotent: reuses cached coords
    # from any existing output when the address signature is unchanged.
    coords_path = Path(__file__).resolve().parent / COORDS_REL_PATH
    geocode_inputs: List[Dict[str, Any]] = []
    for item, is_connecteam in all_raw_items:
        gin = build_geocode_input(item, column_ids, connecteam_user=is_connecteam)
        if gin is not None:
            geocode_inputs.append(gin)

    existing_coords = load_existing_snapshot(coords_path)
    existing_coord_records = (
        existing_coords if isinstance(existing_coords, list) else None
    )
    coords = geocoder.batch_geocode_volunteers(
        geocode_inputs, existing=existing_coord_records, session=session
    )

    # Check 1 — record integrity (BLOCKING). Validate every coords record has
    # all required fields and that each field still belongs to the SAME
    # volunteer (no cross-volunteer field bleed) BEFORE we write/upload. Any
    # failure aborts the pipeline with a non-zero exit so scrambled / partial
    # data never reaches the private coords file or KV.
    integrity_errors = validate_record_integrity(coords)
    if integrity_errors:
        logger.error(
            "Record integrity check FAILED — %d problem(s); refusing to "
            "write/upload coords:",
            len(integrity_errors),
        )
        for err in integrity_errors:
            logger.error("  integrity: %s", err)
        print(
            f"ERROR: record integrity check failed "
            f"({len(integrity_errors)} problem(s)) — see log; not writing "
            f"coords.",
            file=sys.stderr,
        )
        return 10
    logger.info(
        "Record integrity check passed for %d coord records.", len(coords)
    )

    # Check 2 — geocode accuracy (NON-BLOCKING). On-demand via --validate: a
    # reverse sanity check that stored coords match the stated home county
    # (and, with --revalidate-geocode, that a re-geocode lands within ~1 mile).
    # Warnings only — accuracy drift never blocks a refresh.
    if getattr(args, "validate", False):
        accuracy_warnings = validate_geocode_accuracy(
            coords,
            geocode_inputs=geocode_inputs,
            session=session,
            re_geocode=getattr(args, "revalidate_geocode", False),
        )
        if accuracy_warnings:
            logger.warning(
                "Geocode accuracy check flagged %d record(s):",
                len(accuracy_warnings),
            )
            for warn in accuracy_warnings:
                logger.warning("  accuracy: %s", warn)
        else:
            logger.info(
                "Geocode accuracy check passed for %d coord records.",
                len(coords),
            )

    if args.dry_run:
        logger.info(
            "[dry-run] would write %d coord records to %s",
            len(coords),
            coords_path,
        )
    else:
        atomic_write_json(coords_path, coords)
        logger.info("Wrote %d coord records to %s", len(coords), coords_path)

    # Phase C — fetch the RehabDB board and emit the PUBLIC rehabber dataset.
    # Unlike volunteer coords, rehabbers are public-facing facilities; this
    # file IS committed to docs/. Lat/lon are already on the board (no
    # geocoding). Rows missing lat/lon are skipped with a warning.
    rehabbers_path = Path(__file__).resolve().parent / REHABBERS_REL_PATH
    try:
        rehab_items = fetch_rehabbers(token=token, session=session)
    except MondayAPIError as exc:
        print(f"ERROR: RehabDB fetch failed: {exc}", file=sys.stderr)
        return 8
    rehabbers = build_rehabbers(rehab_items)
    if args.dry_run:
        logger.info(
            "[dry-run] would write %d rehabber records to %s",
            len(rehabbers),
            rehabbers_path,
        )
    else:
        atomic_write_json(rehabbers_path, rehabbers)
        logger.info(
            "Wrote %d rehabber records to %s", len(rehabbers), rehabbers_path
        )

    # Facility-status page BASE dataset (Option A: join-at-read). Built from the
    # SAME RehabDB items already fetched above; emits ONLY base fields (NO
    # status/open-closed). docs/facilities.html merges this with the Google
    # Sheet STATUS feed by normalized facility name. The full facility name
    # (the join key) is resolved via: the dedicated 'Facility Name' column when
    # filled, else the committed abbreviation->full-name map (then a name parsed
    # from Availability, then the raw 'Rehab Name').
    facilities_path = Path(__file__).resolve().parent / FACILITIES_REL_PATH
    name_map = load_facility_name_map(repo_root)
    facilities = build_facilities(rehab_items, name_map)
    if args.dry_run:
        logger.info(
            "[dry-run] would write %d facility records to %s",
            len(facilities),
            facilities_path,
        )
    else:
        atomic_write_json(facilities_path, facilities)
        logger.info(
            "Wrote %d facility records to %s", len(facilities), facilities_path
        )

    # Area coordinators — fetch the coordinator NAME per WIN area and emit the
    # PUBLIC-safe area->name dataset. The phone column is NEVER requested or
    # written (see fetch_coordinators / build_coordinators). Consumed by
    # county_win.py as an override on top of the static counties.xlsx column.
    coordinators_path = Path(__file__).resolve().parent / COORDINATORS_REL_PATH
    try:
        coord_gid = discover_coordinators_group_id(token=token, session=session)
        coord_items = fetch_coordinators(coord_gid, token=token, session=session)
    except MondayAPIError as exc:
        print(f"ERROR: coordinators fetch failed: {exc}", file=sys.stderr)
        return 9
    coordinators = build_coordinators(coord_items)
    if args.dry_run:
        logger.info(
            "[dry-run] would write %d coordinator names to %s",
            len(coordinators),
            coordinators_path,
        )
    else:
        atomic_write_json(coordinators_path, coordinators)
        logger.info(
            "Wrote %d coordinator names to %s",
            len(coordinators),
            coordinators_path,
        )

    n_all = len(all_raw_items)
    n_counties = len(snapshot["counties"])
    # Qualifying count: volunteers that map to at least one capacity bucket.
    n_qualifying = sum(1 for v in volunteers if volunteer_buckets(v))
    print(
        f"{n_all} volunteers fetched, {n_qualifying} qualifying roles "
        f"(C&T/RVS/Courier), {len(geocode_inputs)} geocode-eligible, "
        f"{n_counties} counties with capacity",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests


# ---------------------------------------------------------------------------
# CONSTANTS — discovered via Monday GraphQL introspection on board 9092079933.
# Column IDs are NOT the same as the human-visible labels. Run with
# `--introspect` against a real token to refresh these mappings if Monday
# admins rename or recreate columns.
# ---------------------------------------------------------------------------

MONDAY_API_URL = "https://api.monday.com/v2"
MONDAY_API_VERSION = "2024-10"

BOARD_ID = "9092079933"          # Connecteam_Users
GROUP_TITLE = "users"            # default 'topics' group on Connecteam_Users

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
    "unavailable",
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

# Output file — relative to this script's directory.
OUTPUT_REL_PATH = Path("docs") / "data" / "county_capacity.json"

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
    group_title: str,
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> Dict[str, Any]:
    """Resolve column ids AND the volunteer group id in one introspection call.

    Returns {"column_ids": {title -> column_id}, "group_id": str}. Mirrors
    the Phase 1.5 tracker pattern: resolve groups by human-visible TITLE
    rather than baking a stale internal id into source.
    """
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
    group_id: Optional[str] = None
    for g in groups:
        if g.get("title") == group_title:
            group_id = g.get("id")
            break
    if group_id is None:
        available = sorted(g.get("title") for g in groups if g.get("title"))
        raise MondayAPIError(
            f"Group {group_title!r} not found on board {BOARD_ID}. "
            f"Available groups: {available}"
        )

    logger.info("Resolved column ids: %s, group_id: %s", column_ids, group_id)
    return {"column_ids": column_ids, "group_id": group_id}


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
    ]
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


def is_available(availability_text: str) -> bool:
    """True if volunteer is considered available for dispatch right now."""
    if not availability_text or not availability_text.strip():
        return DEFAULT_AVAILABLE_WHEN_BLANK
    return not bool(AVAILABILITY_DENYLIST_RE.search(availability_text))


def build_volunteer_record(
    item: Dict[str, Any], column_ids: Dict[str, str]
) -> Optional[Dict[str, Any]]:
    """Convert a raw Monday item to a normalized volunteer dict.

    Returns None if the volunteer doesn't qualify for dispatch (no
    C&T / RVS / Courier role).
    """
    name = (item.get("name") or "").strip()
    county = _column_text(item, column_ids[COL_TITLE_COUNTY])
    roles_text = _column_text(item, column_ids[COL_TITLE_ROLES])
    availability_text = _column_text(item, column_ids[COL_TITLE_AVAILABILITY])

    roles = parse_roles(roles_text)
    role_set = set(roles)
    if not (role_set & QUALIFYING_ROLES):
        return None

    return {
        "name": name,
        "county": county,
        "roles": roles,
        "availability_text": availability_text,
        "has_ct": "C&T" in role_set,
        "has_rvs": "RVS" in role_set,
        "has_courier": "Courier" in role_set,
        "available": is_available(availability_text),
    }


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
            [COL_TITLE_COUNTY, COL_TITLE_ROLES, COL_TITLE_AVAILABILITY],
            GROUP_TITLE,
            token=token,
            session=session,
        )
    except MondayAPIError as exc:
        print(f"ERROR: column discovery failed: {exc}", file=sys.stderr)
        return 3

    column_ids = meta["column_ids"]
    group_id = meta["group_id"]

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

    try:
        raw_items = fetch_volunteers(column_ids, group_id, token=token, session=session)
    except MondayAPIError as exc:
        print(f"ERROR: fetch failed: {exc}", file=sys.stderr)
        return 4

    volunteers: List[Dict[str, Any]] = []
    for item in raw_items:
        rec = build_volunteer_record(item, column_ids)
        if rec is not None:
            volunteers.append(rec)

    snapshot = build_snapshot(volunteers, group_id=group_id, config=config)

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

    matched = len(volunteers)
    n_counties = len(snapshot["counties"])
    print(
        f"{len(raw_items)} volunteers fetched, {matched} matched roles, "
        f"{n_counties} counties with capacity",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

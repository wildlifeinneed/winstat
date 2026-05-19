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
GROUP_ID = "group_mm39mf3n"      # users group only

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
MARGINAL_THRESHOLD = 1

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


def load_token(cwd: Optional[Path] = None) -> str:
    """Read the API token from .monday_token, falling back to env var."""
    cwd = cwd or Path.cwd()
    token_path = cwd / TOKEN_FILE
    if token_path.exists():
        token = token_path.read_text(encoding="utf-8").strip()
        if token:
            return token
    env_token = os.environ.get(TOKEN_ENV, "").strip()
    if env_token:
        return env_token
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
  }
}
"""


def discover_column_ids(
    titles: Sequence[str],
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> Dict[str, str]:
    """Return {title -> column_id} resolved from the board's column metadata."""
    data = graphql_request(
        INTROSPECT_QUERY,
        variables={"board_ids": [BOARD_ID]},
        token=token,
        session=session,
    )
    boards = data.get("boards") or []
    if not boards:
        raise MondayAPIError(f"Board {BOARD_ID} not visible to this token.")
    columns = boards[0].get("columns") or []
    by_title = {c["title"]: c["id"] for c in columns if c.get("title")}
    resolved: Dict[str, str] = {}
    missing: List[str] = []
    for t in titles:
        if t in by_title:
            resolved[t] = by_title[t]
        else:
            missing.append(t)
    if missing:
        raise MondayAPIError(
            f"Could not find column titles {missing} on board {BOARD_ID}. "
            f"Available titles: {sorted(by_title.keys())}"
        )
    logger.info("Resolved column ids: %s", resolved)
    return resolved


# ---------------------------------------------------------------------------
# Item fetch
# ---------------------------------------------------------------------------

ITEMS_QUERY = """
query ($board_ids: [ID!], $group_ids: [String], $limit: Int!, $cursor: String) {
  boards(ids: $board_ids) {
    groups(ids: $group_ids) {
      id
      items_page(limit: $limit, cursor: $cursor) {
        cursor
        items {
          id
          name
          column_values {
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
    token: Optional[str] = None,
    session: Optional[requests.Session] = None,
) -> List[Dict[str, Any]]:
    """Fetch all items in BOARD_ID/GROUP_ID and return a list of raw dicts."""
    out: List[Dict[str, Any]] = []
    cursor: Optional[str] = None
    page = 0
    while True:
        page += 1
        data = graphql_request(
            ITEMS_QUERY,
            variables={
                "board_ids": [BOARD_ID],
                "group_ids": [GROUP_ID],
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
            logger.warning("Group %s not found on board %s", GROUP_ID, BOARD_ID)
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


def volunteer_buckets(v: Dict[str, Any]) -> List[str]:
    buckets: List[str] = []
    if v["has_ct"] and not v["has_rvs"]:
        buckets.append("ct_no_rvs")
    if v["has_ct"] and v["has_rvs"]:
        buckets.append("ct_rvs")
    if v["has_courier"]:
        buckets.append("courier")
    return buckets


def aggregate_by_county(volunteers: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Build the {county: {bucket: {total, available, marginal_volunteers}}} map."""
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
                    "name": v["name"],
                    "availability_note": v["availability_text"],
                }
            )

    # Finalize: drop _members into marginal_volunteers only when warranted,
    # and ensure all three bucket keys exist for each emitted county.
    final: Dict[str, Dict[str, Any]] = {}
    for county, cdata in counties.items():
        out: Dict[str, Any] = {}
        for b in BUCKETS:
            slot = cdata.get(b)
            if slot is None:
                out[b] = {"total": 0, "available": 0, "marginal_volunteers": []}
                continue
            members = slot.pop("_members", [])
            if slot["available"] <= MARGINAL_THRESHOLD:
                slot["marginal_volunteers"] = members
            else:
                slot["marginal_volunteers"] = []
            out[b] = slot
        final[county] = out

    return final


def build_snapshot(volunteers: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    counties = aggregate_by_county(volunteers)
    return {
        "generated_at": datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "source_board_id": BOARD_ID,
        "source_group_id": GROUP_ID,
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
    args = parser.parse_args(argv)

    _setup_logging(args.verbose)

    try:
        token = load_token()
    except MondayAuthError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    session = requests.Session()

    try:
        column_ids = discover_column_ids(
            [COL_TITLE_COUNTY, COL_TITLE_ROLES, COL_TITLE_AVAILABILITY],
            token=token,
            session=session,
        )
    except MondayAPIError as exc:
        print(f"ERROR: column discovery failed: {exc}", file=sys.stderr)
        return 3

    if args.introspect:
        print(json.dumps(column_ids, indent=2))
        return 0

    try:
        raw_items = fetch_volunteers(column_ids, token=token, session=session)
    except MondayAPIError as exc:
        print(f"ERROR: fetch failed: {exc}", file=sys.stderr)
        return 4

    volunteers: List[Dict[str, Any]] = []
    for item in raw_items:
        rec = build_volunteer_record(item, column_ids)
        if rec is not None:
            volunteers.append(rec)

    snapshot = build_snapshot(volunteers)

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

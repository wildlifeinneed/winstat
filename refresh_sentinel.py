#!/usr/bin/env python3
"""
Phase F sentinel — cheap staleness gate for the CI refresh job.

This module is a thin wrapper around the Monday API client already shipped
in ``refresh_monday.py`` (it does NOT reinvent the HTTP layer). It answers a
single question for CI: "has the VolDB_Status tracker advanced since the last
time we ran a full refresh?"

It queries board id=6750158385 (VolDB_Status), group "VolunteerDB Last Update",
column "Last_Updated" (a date column) and compares the date there against a
locally-stored, gitignored date file.

FAIL-SAFE CONTRACT (matches the existing repo posture in refresh_monday.py
where bare runs never let tracker hiccups block/false-trigger work):
  * ``needs_refresh`` returns False on ANY Monday API / parse error. We NEVER
    refresh on error and NEVER raise out of this function — a flaky tracker
    read must not crash the CI run nor trigger an expensive board download.
  * Missing stored date  -> True (first run / cache reset must refresh).
  * Sentinel date strictly newer than stored date -> True.
  * Sentinel date equal to or older than stored date -> False.

Note on the canonical 'Item 1' single item: the tracker board's update group
holds a single row whose ``Last_Updated`` is the canonical timestamp. We reuse
``refresh_monday.fetch_remote_last_updated`` which already resolves the column
and group by title and returns MAX(Last_Updated) across the group's items, so
a single 'Item 1' row resolves to exactly that row's date.
"""

from __future__ import annotations

import json
import logging
import tempfile
import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import requests

import refresh_monday as rm


logger = logging.getLogger("refresh_sentinel")

# Board / group / column are defined once in refresh_monday and re-exported
# here so callers and tests have a single source of truth.
VOLDB_STATUS_BOARD_ID = rm.TRACKER_BOARD_ID          # "6750158385"
VOLDB_STATUS_GROUP_TITLE = rm.TRACKER_GROUP_TITLE     # "VolunteerDB Last Update"
VOLDB_STATUS_COL_TITLE = rm.TRACKER_COL_TITLE_LAST_UPDATED  # "Last_Updated"

# Gitignored JSON file recording the last sentinel date we acted on. Lives
# alongside refresh_monday.py (repo root) since there is no dispatcher/ dir.
DEFAULT_STORED_PATH = Path(__file__).resolve().parent / "last_refresh_date.json"


def get_last_updated(
    monday_token: str,
    session: Optional[requests.Session] = None,
) -> Optional[date]:
    """Return the VolDB_Status Last_Updated date, or None if unreadable.

    Reuses ``refresh_monday.fetch_remote_last_updated`` (which performs the
    cheap two-call discovery + narrow fetch against the tracker board) and
    collapses its tz-aware UTC datetime to a calendar date. Never raises:
    any Monday API or parse error returns None so the caller can fail safe.
    """
    try:
        dt = rm.fetch_remote_last_updated(token=monday_token, session=session)
    except Exception as exc:  # noqa: BLE001 — fail-safe: swallow ALL errors
        logger.warning("Sentinel: could not read VolDB_Status Last_Updated: %s", exc)
        return None
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).date()


def get_stored_date(path: "str | Path") -> Optional[date]:
    """Read the locally-stored last-seen date from the gitignored JSON file.

    Returns None if the file is missing, empty, or unparseable (treated as
    "no record" -> caller will refresh).
    """
    p = Path(path)
    if not p.exists():
        return None
    try:
        raw = p.read_text(encoding="utf-8").strip()
    except OSError as exc:
        logger.warning("Sentinel: could not read stored date file %s: %s", p, exc)
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning("Sentinel: stored date file %s is not valid JSON: %s", p, exc)
        return None
    date_str = data.get("last_updated") if isinstance(data, dict) else None
    if not date_str:
        return None
    try:
        return date.fromisoformat(str(date_str))
    except ValueError as exc:
        logger.warning(
            "Sentinel: stored date %r in %s is not an ISO date: %s",
            date_str, p, exc,
        )
        return None


def save_stored_date(value: date, path: "str | Path") -> None:
    """Atomically write the date to the gitignored JSON file.

    Stored as ``{"last_updated": "YYYY-MM-DD"}``. Mirrors the atomic-write
    idiom used in refresh_monday so a crashed write never leaves a partial
    file behind.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {"last_updated": value.isoformat()}
    fd, tmp = tempfile.mkstemp(prefix=p.name + ".", suffix=".tmp", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def needs_refresh(
    monday_token: str,
    stored_path: "str | Path",
    session: Optional[requests.Session] = None,
) -> bool:
    """Decide whether a full Monday refresh is warranted.

    Returns:
      * True  if the sentinel date is strictly newer than the stored date,
        OR the stored date is missing.
      * False if the sentinel date is equal to / older than the stored date.
      * False on ANY Monday API error (FAIL-SAFE — never refresh on error,
        never crash the CI run).
    """
    sentinel = get_last_updated(monday_token, session=session)
    if sentinel is None:
        # Fail-safe: unreadable sentinel -> do NOT refresh, do NOT crash.
        logger.info("Sentinel unreadable; skipping refresh (fail-safe).")
        return False

    stored = get_stored_date(stored_path)
    if stored is None:
        logger.info("No stored date; refresh needed (sentinel=%s).", sentinel.isoformat())
        return True

    if sentinel > stored:
        logger.info(
            "Sentinel advanced: %s > stored %s; refresh needed.",
            sentinel.isoformat(), stored.isoformat(),
        )
        return True

    logger.info(
        "Sentinel not advanced: %s <= stored %s; no refresh.",
        sentinel.isoformat(), stored.isoformat(),
    )
    return False

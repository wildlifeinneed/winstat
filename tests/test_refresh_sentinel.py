"""Phase F tests — refresh_sentinel staleness gate.

All Monday GraphQL calls are mocked. NO real network access.

Covers the needs_refresh contract:
  * sentinel newer than stored      -> True
  * sentinel same as stored         -> False
  * sentinel older than stored      -> False
  * stored missing                  -> True
  * Monday API raises / errors       -> False (FAIL-SAFE)
plus the get_stored_date / save_stored_date round-trip helpers.
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import refresh_sentinel as rs  # noqa: E402
import refresh_monday as rm  # noqa: E402


# ---------------------------------------------------------------------------
# get_stored_date / save_stored_date
# ---------------------------------------------------------------------------

def test_stored_date_roundtrip(tmp_path):
    p = tmp_path / "last_refresh_date.json"
    d = date(2026, 5, 19)
    rs.save_stored_date(d, p)
    assert json.loads(p.read_text(encoding="utf-8")) == {"last_updated": "2026-05-19"}
    assert rs.get_stored_date(p) == d


def test_stored_date_missing_returns_none(tmp_path):
    assert rs.get_stored_date(tmp_path / "nope.json") is None


def test_stored_date_empty_returns_none(tmp_path):
    p = tmp_path / "empty.json"
    p.write_text("", encoding="utf-8")
    assert rs.get_stored_date(p) is None


def test_stored_date_bad_json_returns_none(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("{not json", encoding="utf-8")
    assert rs.get_stored_date(p) is None


def test_stored_date_bad_iso_returns_none(tmp_path):
    p = tmp_path / "bad_iso.json"
    p.write_text(json.dumps({"last_updated": "not-a-date"}), encoding="utf-8")
    assert rs.get_stored_date(p) is None


# ---------------------------------------------------------------------------
# get_last_updated — collapses the tracker datetime to a date, fail-safe
# ---------------------------------------------------------------------------

def test_get_last_updated_returns_date():
    dt = datetime(2026, 5, 19, 14, 30, 0, tzinfo=timezone.utc)
    with mock.patch.object(rm, "fetch_remote_last_updated", return_value=dt):
        assert rs.get_last_updated("TOKEN") == date(2026, 5, 19)


def test_get_last_updated_error_returns_none():
    with mock.patch.object(
        rm, "fetch_remote_last_updated", side_effect=rm.MondayAPIError("boom")
    ):
        assert rs.get_last_updated("TOKEN") is None


# ---------------------------------------------------------------------------
# needs_refresh — the core contract
# ---------------------------------------------------------------------------

def _patch_sentinel(d):
    """Patch get_last_updated to return date d (or None)."""
    return mock.patch.object(rs, "get_last_updated", return_value=d)


def test_needs_refresh_sentinel_newer_than_stored(tmp_path):
    p = tmp_path / "last_refresh_date.json"
    rs.save_stored_date(date(2026, 5, 10), p)
    with _patch_sentinel(date(2026, 5, 19)):
        assert rs.needs_refresh("TOKEN", p) is True


def test_needs_refresh_sentinel_same_as_stored(tmp_path):
    p = tmp_path / "last_refresh_date.json"
    rs.save_stored_date(date(2026, 5, 19), p)
    with _patch_sentinel(date(2026, 5, 19)):
        assert rs.needs_refresh("TOKEN", p) is False


def test_needs_refresh_sentinel_older_than_stored(tmp_path):
    p = tmp_path / "last_refresh_date.json"
    rs.save_stored_date(date(2026, 5, 19), p)
    with _patch_sentinel(date(2026, 5, 10)):
        assert rs.needs_refresh("TOKEN", p) is False


def test_needs_refresh_stored_missing(tmp_path):
    p = tmp_path / "last_refresh_date.json"
    assert not p.exists()
    with _patch_sentinel(date(2026, 5, 19)):
        assert rs.needs_refresh("TOKEN", p) is True


def test_needs_refresh_monday_error_is_fail_safe(tmp_path):
    """Monday API raising must NOT refresh and must NOT crash -> False."""
    p = tmp_path / "last_refresh_date.json"
    rs.save_stored_date(date(2026, 5, 10), p)  # stored is OLDER -> would refresh if sentinel read
    with mock.patch.object(
        rm, "fetch_remote_last_updated", side_effect=rm.MondayAPIError("api down")
    ):
        assert rs.needs_refresh("TOKEN", p) is False


def test_needs_refresh_monday_error_no_stored_still_false(tmp_path):
    """Even with no stored date, an API error must fail safe to False."""
    p = tmp_path / "last_refresh_date.json"
    with mock.patch.object(
        rm, "fetch_remote_last_updated", side_effect=rm.StalenessError("malformed")
    ):
        assert rs.needs_refresh("TOKEN", p) is False

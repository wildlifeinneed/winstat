"""Tests for refresh_monday.py — fully offline, GraphQL is mocked."""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from pathlib import Path
from unittest import mock

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import refresh_monday as rm  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

COLUMN_IDS = {
    rm.COL_TITLE_COUNTY: "country_or_region",  # arbitrary mock ids
    rm.COL_TITLE_ROLES: "tags__1",
    rm.COL_TITLE_AVAILABILITY: "long_text__1",
}

# Resolved id the introspection fixture maps GROUP_TITLE ('users') to.
RESOLVED_GROUP_ID = "group_abc"


def _item(name: str, county: str, roles: str, availability: str = "") -> dict:
    return {
        "id": name.replace(" ", "_"),
        "name": name,
        "column_values": [
            {"id": COLUMN_IDS[rm.COL_TITLE_COUNTY], "text": county, "value": None, "type": "status"},
            {"id": COLUMN_IDS[rm.COL_TITLE_ROLES], "text": roles, "value": None, "type": "tags"},
            {"id": COLUMN_IDS[rm.COL_TITLE_AVAILABILITY], "text": availability, "value": None, "type": "long_text"},
        ],
    }


# ---------------------------------------------------------------------------
# 1. Tag filtering
# ---------------------------------------------------------------------------

def test_dispatch_only_volunteer_excluded():
    rec = rm.build_volunteer_record(
        _item("Alex Dispatch", "Bucks", "Dispatch"),
        COLUMN_IDS,
    )
    assert rec is None


def test_ct_volunteer_included():
    rec = rm.build_volunteer_record(
        _item("Casey CT", "Bucks", "C&T"),
        COLUMN_IDS,
    )
    assert rec is not None
    assert rec["has_ct"] is True
    assert rec["has_rvs"] is False
    assert rec["has_courier"] is False


def test_board_and_it_only_excluded():
    assert rm.build_volunteer_record(_item("B Member", "Bucks", "Board, IT"), COLUMN_IDS) is None
    assert rm.build_volunteer_record(_item("T User", "Bucks", "TestUsers"), COLUMN_IDS) is None


# ---------------------------------------------------------------------------
# 2. Role flag combinations
# ---------------------------------------------------------------------------

def test_ct_and_rvs_flags():
    rec = rm.build_volunteer_record(
        _item("Pat", "Chester", "C&T, RVS"),
        COLUMN_IDS,
    )
    assert rec["has_ct"] and rec["has_rvs"]
    assert rec["has_courier"] is False


def test_courier_flag():
    rec = rm.build_volunteer_record(
        _item("Sam", "Chester", "Courier"),
        COLUMN_IDS,
    )
    assert rec["has_courier"] is True
    assert rec["has_ct"] is False
    assert rec["has_rvs"] is False


def test_courier_plus_rvs_counts_in_courier_bucket():
    rec = rm.build_volunteer_record(
        _item("Robin", "York", "Courier, RVS"),
        COLUMN_IDS,
    )
    assert rec is not None
    assert rec["has_courier"] is True
    assert rec["has_rvs"] is True
    assert rec["has_ct"] is False
    assert rm.volunteer_buckets(rec) == ["courier"]


# ---------------------------------------------------------------------------
# 3. Availability keyword detection
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text,expected_available",
    [
        ("on vacation until June", False),
        ("Currently on hiatus", False),
        ("Inactive — moving out of state", False),
        ("Mon-Fri 9-5", True),
        ("", True),
        ("   ", True),
        ("Available evenings", True),
        ("On extended leave", False),
        ("Away through summer", False),
    ],
)
def test_availability_keyword(text, expected_available):
    assert rm.is_available(text) is expected_available


# ---------------------------------------------------------------------------
# 3b. "unavail" shorthand + date-range parsing (today-aware)
# ---------------------------------------------------------------------------

def test_unavail_shorthand_alone_marks_unavailable():
    # Plain "Unavail" with no surrounding schedule — must not be counted
    # as available just because the long-form "unavailable" isn't present.
    assert rm.is_available("Unavail") is False


def test_unavailable_long_form_still_unavailable():
    # Backwards-compat: existing "Unavailable until June" pattern must
    # keep working (the new "unavail" substring catches it).
    assert rm.is_available("Unavailable until June") is False


def test_buried_unavail_until_further_notice_marks_unavailable():
    # The buried-bug case from production: positive schedule followed by
    # ", unavail until further notice". Old code missed it because
    # "unavailable" is not a substring of "unavail".
    text = "Avail Sat & Sun, unavail until further notice"
    assert rm.is_available(text) is False


def test_unavail_date_range_today_inside_marks_unavailable():
    text = "Avail Mon-Fri 5PM. Unavail 6/1-6/7"
    assert rm.is_available(text, today=date(2026, 6, 3)) is False


def test_unavail_date_range_today_outside_marks_available():
    # Clause is stripped → "Avail Mon-Fri 5PM. " has no denylist match.
    text = "Avail Mon-Fri 5PM. Unavail 6/1-6/7"
    assert rm.is_available(text, today=date(2026, 5, 15)) is True


def test_unavail_multiple_ranges_inside_one_of_them():
    text = "Unavail 8/12-8/18, 8/26-8/28, 9/9-9/14"
    assert rm.is_available(text, today=date(2026, 8, 27)) is False


def test_unavail_multiple_ranges_between_ranges_marks_available():
    text = "Unavail 8/12-8/18, 8/26-8/28, 9/9-9/14"
    assert rm.is_available(text, today=date(2026, 8, 22)) is True


def test_unavail_endash_separator_marks_unavailable():
    # En-dash with surrounding spaces, as actually written in Monday.
    text = "Avail Weekends. Unavail 5/12 \u2013 5/21"
    assert rm.is_available(text, today=date(2026, 5, 15)) is False


def test_unavail_single_date_on_that_day_marks_unavailable():
    text = "Avail Weekends. Unavail 5/12"
    assert rm.is_available(text, today=date(2026, 5, 12)) is False


def test_unavail_single_date_off_that_day_marks_available():
    text = "Avail Weekends. Unavail 5/12"
    assert rm.is_available(text, today=date(2026, 5, 13)) is True


def test_unavail_tbd_falls_back_to_keyword_with_warning(caplog):
    # Malformed (non-date) marker: defensive fallback — volunteer
    # treated as unavailable, and a warning is emitted to stderr so
    # the Monday entry can be cleaned up.
    text = "Avail Weekends. Unavail TBD"
    with caplog.at_level("WARNING", logger="refresh_monday"):
        result = rm.is_available(text, today=date(2026, 5, 20))
    assert result is False
    assert any(
        "Unparseable Unavail clause" in rec.message for rec in caplog.records
    )


def test_positive_available_substring_no_false_unavail():
    # Sanity: "Available weekdays" must NOT be flagged by the new
    # "unavail" keyword. The substring check confirms "available" does
    # not contain "unavail".
    assert rm.is_available("Available weekdays") is True


# ---------------------------------------------------------------------------
# 4. Aggregation
# ---------------------------------------------------------------------------

def test_aggregate_three_volunteers_in_bucks():
    items = [
        _item("CT Only", "Bucks", "C&T", "Mon-Fri"),
        _item("CT+RVS", "Bucks", "C&T, RVS", "weekends"),
        _item("Courier", "Bucks", "Courier", "anytime"),
    ]
    volunteers = [rm.build_volunteer_record(it, COLUMN_IDS) for it in items]
    snap = rm.build_snapshot(volunteers)
    bucks = snap["counties"]["Bucks"]
    assert bucks["ct_no_rvs"]["total"] == 1
    assert bucks["ct_no_rvs"]["available"] == 1
    assert bucks["ct_rvs"]["total"] == 1
    assert bucks["ct_rvs"]["available"] == 1
    assert bucks["courier"]["total"] == 1
    assert bucks["courier"]["available"] == 1


def test_aggregate_omits_empty_counties():
    snap = rm.build_snapshot([])
    assert snap["counties"] == {}


def test_aggregate_skips_county_blanks():
    items = [_item("Nameless", "", "C&T")]
    volunteers = [rm.build_volunteer_record(it, COLUMN_IDS) for it in items]
    snap = rm.build_snapshot(volunteers)
    assert snap["counties"] == {}


# ---------------------------------------------------------------------------
# 5. Marginal volunteers populated when available <= 1
# ---------------------------------------------------------------------------

def test_marginal_populated_when_available_one():
    items = [_item("Only One", "Adams", "C&T", "Mon-Fri")]
    volunteers = [rm.build_volunteer_record(it, COLUMN_IDS) for it in items]
    snap = rm.build_snapshot(volunteers)
    bucket = snap["counties"]["Adams"]["ct_no_rvs"]
    assert bucket["available"] == 1
    assert bucket["marginal_volunteers"] == [
        {"availability_note": "Mon-Fri", "connecteam_user": True}
    ]
    # Phase 4a: volunteer name MUST NOT be present in the JSON output.
    for mv in bucket["marginal_volunteers"]:
        assert "name" not in mv


def test_marginal_empty_when_available_two_or_more():
    items = [
        _item("First", "Lehigh", "C&T", "Mon-Fri"),
        _item("Second", "Lehigh", "C&T", "weekends"),
    ]
    volunteers = [rm.build_volunteer_record(it, COLUMN_IDS) for it in items]
    snap = rm.build_snapshot(volunteers)
    bucket = snap["counties"]["Lehigh"]["ct_no_rvs"]
    assert bucket["total"] == 2
    assert bucket["available"] == 2
    assert bucket["marginal_volunteers"] == []


def test_marginal_populated_when_zero_available():
    items = [
        _item("Out A", "York", "Courier", "on vacation"),
        _item("Out B", "York", "Courier", "inactive"),
    ]
    volunteers = [rm.build_volunteer_record(it, COLUMN_IDS) for it in items]
    snap = rm.build_snapshot(volunteers)
    bucket = snap["counties"]["York"]["courier"]
    assert bucket["total"] == 2
    assert bucket["available"] == 0
    # Phase 4a: marginal_volunteers no longer carries volunteer names.
    notes = sorted(m["availability_note"] for m in bucket["marginal_volunteers"])
    assert notes == ["inactive", "on vacation"]
    for mv in bucket["marginal_volunteers"]:
        assert "name" not in mv


# ---------------------------------------------------------------------------
# 6. Atomic write — failure mid-write leaves existing file untouched
# ---------------------------------------------------------------------------

def test_atomic_write_failure_preserves_existing(tmp_path):
    target = tmp_path / "out.json"
    target.write_text('{"original": true}\n', encoding="utf-8")

    # Force os.replace to blow up so the temp file never reaches `target`.
    with mock.patch.object(rm.os, "replace", side_effect=OSError("disk on fire")):
        with pytest.raises(OSError):
            rm.atomic_write_json(target, {"new": True})

    assert json.loads(target.read_text(encoding="utf-8")) == {"original": True}
    # And no leftover .tmp files.
    leftovers = [p for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_atomic_write_success(tmp_path):
    target = tmp_path / "snap.json"
    rm.atomic_write_json(target, {"hello": "world"})
    assert json.loads(target.read_text(encoding="utf-8")) == {"hello": "world"}


# ---------------------------------------------------------------------------
# 7. Schema sanity
# ---------------------------------------------------------------------------

def test_snapshot_schema_top_level_keys():
    snap = rm.build_snapshot([], group_id=RESOLVED_GROUP_ID)
    for key in ("generated_at", "source_board_id", "source_group_id",
                "availability_keywords", "counties"):
        assert key in snap
    assert snap["source_board_id"] == rm.BOARD_ID
    assert snap["source_group_id"] == RESOLVED_GROUP_ID
    assert isinstance(snap["availability_keywords"], list) and snap["availability_keywords"]


def test_county_bucket_schema():
    items = [
        _item("A", "Bucks", "C&T", ""),
        _item("B", "Bucks", "C&T, RVS", ""),
        _item("C", "Bucks", "Courier", ""),
    ]
    volunteers = [rm.build_volunteer_record(it, COLUMN_IDS) for it in items]
    snap = rm.build_snapshot(volunteers)
    cdata = snap["counties"]["Bucks"]
    assert set(cdata.keys()) == {"ct_no_rvs", "ct_rvs", "courier"}
    for b in ("ct_no_rvs", "ct_rvs", "courier"):
        slot = cdata[b]
        assert set(slot.keys()) == {"total", "available", "marginal_volunteers"}
        assert isinstance(slot["total"], int)
        assert isinstance(slot["available"], int)
        assert isinstance(slot["marginal_volunteers"], list)


# ---------------------------------------------------------------------------
# Token loader
# ---------------------------------------------------------------------------

def test_load_token_from_file(tmp_path, monkeypatch):
    monkeypatch.delenv(rm.TOKEN_ENV, raising=False)
    (tmp_path / rm.TOKEN_FILE).write_text("FAKE_TOKEN\n", encoding="utf-8")
    assert rm.load_token(cwd=tmp_path) == "FAKE_TOKEN"


def test_load_token_from_env(tmp_path, monkeypatch):
    monkeypatch.setenv(rm.TOKEN_ENV, "ENV_TOKEN")
    assert rm.load_token(cwd=tmp_path) == "ENV_TOKEN"


def test_load_token_missing_raises(tmp_path, monkeypatch):
    monkeypatch.delenv(rm.TOKEN_ENV, raising=False)
    with pytest.raises(rm.MondayAuthError):
        rm.load_token(cwd=tmp_path)


# ---------------------------------------------------------------------------
# Token format hardening (Phase 1.5)
# ---------------------------------------------------------------------------

# A realistic JWT-shaped fake token (base64url chars + two dots). Used as a
# secret-leak canary: it must NEVER appear in stderr on the failure paths.
_FAKE_JWT = (
    "eyJhbGciOiJIUzI1NiJ9."
    "eyJ0aWQiOjEyMzQ1LCJ1aWQiOjY3ODkwLCJpYXQiOjE3MDAwMDAwMDB9."
    "abcDEFghiJKLmnoPQRstuVWXyz0123456789_-AAAA"
)


def test_load_token_rejects_rtf_wrapper(tmp_path, monkeypatch):
    monkeypatch.delenv(rm.TOKEN_ENV, raising=False)
    rtf_blob = (
        "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2761\n"
        "\\fonttbl\\f0\\fswiss Helvetica;}\n"
        f"{{\\f0 {_FAKE_JWT}}}\n"
        "}"
    )
    (tmp_path / rm.TOKEN_FILE).write_text(rtf_blob, encoding="utf-8")
    with pytest.raises(rm.MondayTokenFormatError) as ei:
        rm.load_token(cwd=tmp_path)
    msg = str(ei.value)
    assert "Rich Text Format" in msg
    assert "RTF" in msg
    # Must not leak the token value.
    assert _FAKE_JWT not in msg


def test_load_token_rejects_embedded_newline(tmp_path, monkeypatch):
    monkeypatch.delenv(rm.TOKEN_ENV, raising=False)
    bad = _FAKE_JWT[:20] + "\n" + _FAKE_JWT[20:]
    (tmp_path / rm.TOKEN_FILE).write_text(bad, encoding="utf-8")
    with pytest.raises(rm.MondayTokenFormatError) as ei:
        rm.load_token(cwd=tmp_path)
    assert bad not in str(ei.value)
    assert _FAKE_JWT[:20] not in str(ei.value)


def test_load_token_rejects_embedded_space(tmp_path, monkeypatch):
    monkeypatch.delenv(rm.TOKEN_ENV, raising=False)
    bad = _FAKE_JWT[:20] + " " + _FAKE_JWT[20:]
    (tmp_path / rm.TOKEN_FILE).write_text(bad, encoding="utf-8")
    with pytest.raises(rm.MondayTokenFormatError) as ei:
        rm.load_token(cwd=tmp_path)
    assert bad not in str(ei.value)


def test_load_token_rejects_empty_file(tmp_path, monkeypatch):
    monkeypatch.delenv(rm.TOKEN_ENV, raising=False)
    (tmp_path / rm.TOKEN_FILE).write_text("   \n\t\n", encoding="utf-8")
    with pytest.raises(rm.MondayTokenFormatError):
        rm.load_token(cwd=tmp_path)


def test_load_token_accepts_valid_jwt_with_trailing_newline(tmp_path, monkeypatch):
    monkeypatch.delenv(rm.TOKEN_ENV, raising=False)
    (tmp_path / rm.TOKEN_FILE).write_text(_FAKE_JWT + "\n", encoding="utf-8")
    assert rm.load_token(cwd=tmp_path) == _FAKE_JWT


def test_load_token_env_rejects_rtf(tmp_path, monkeypatch):
    monkeypatch.setenv(rm.TOKEN_ENV, "{\\rtf1\\ansi " + _FAKE_JWT + "}")
    with pytest.raises(rm.MondayTokenFormatError) as ei:
        rm.load_token(cwd=tmp_path)
    assert _FAKE_JWT not in str(ei.value)


def test_main_exits_6_on_rtf_token(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv(rm.TOKEN_ENV, raising=False)
    monkeypatch.chdir(tmp_path)
    rtf_blob = "{\\rtf1\\ansi " + _FAKE_JWT + "}"
    (tmp_path / rm.TOKEN_FILE).write_text(rtf_blob, encoding="utf-8")
    rc = rm.main([])
    assert rc == 6
    err = capsys.readouterr().err
    assert "TOKEN FILE FORMAT ERROR" in err
    assert "Rich Text Format" in err
    # Critical: the token value must never appear in stderr.
    assert _FAKE_JWT not in err


# ---------------------------------------------------------------------------
# Mocked end-to-end: fetch + build via mocked GraphQL
# ---------------------------------------------------------------------------

def _fake_graphql_factory(items, groups=None):
    """Return a fake graphql_request that handles introspect + items_page calls.

    ``groups`` is a list of {"id": ..., "title": ...} dicts for the board.
    If not provided, defaults to the single "users" group for back-compat.
    ``items`` may be a flat list (served for any group) or a dict keyed by
    group_id for multi-group tests.
    """
    if groups is None:
        groups = [
            {"id": RESOLVED_GROUP_ID, "title": rm.GROUP_TITLE},
            {"id": "group_xyz", "title": "archived"},
        ]
    introspect_response = {
        "boards": [
            {
                "id": rm.BOARD_ID,
                "name": "Connecteam_Users",
                "columns": [
                    {"id": COLUMN_IDS[rm.COL_TITLE_COUNTY], "title": rm.COL_TITLE_COUNTY, "type": "status"},
                    {"id": COLUMN_IDS[rm.COL_TITLE_ROLES], "title": rm.COL_TITLE_ROLES, "type": "tags"},
                    {"id": COLUMN_IDS[rm.COL_TITLE_AVAILABILITY], "title": rm.COL_TITLE_AVAILABILITY, "type": "long_text"},
                    {"id": "name", "title": "Name", "type": "name"},
                ],
                "groups": groups,
            }
        ]
    }

    def fake(query, variables=None, token=None, session=None, _retry=True):
        if "columns" in query and "items_page" not in query:
            return introspect_response
        # Determine which group was requested
        requested_gids = (variables or {}).get("group_ids", [])
        gid = requested_gids[0] if requested_gids else RESOLVED_GROUP_ID
        if isinstance(items, dict):
            group_items = items.get(gid, [])
        else:
            group_items = items
        return {
            "boards": [
                {"groups": [{"id": gid, "items_page": {"cursor": None, "items": group_items}}]}
            ]
        }

    return fake


def test_end_to_end_with_mocked_api(tmp_path, monkeypatch):
    items = [
        _item("Alpha CT", "Bucks", "C&T", "Mon-Fri 9-5"),
        _item("Bravo CT+RVS", "Bucks", "C&T, RVS", ""),
        _item("Charlie Courier", "Bucks", "Courier", "on vacation until June"),
        _item("Dana Dispatch", "Bucks", "Dispatch", ""),  # filtered out
        _item("Eve Courier", "Chester", "Courier", ""),
    ]

    monkeypatch.setenv(rm.TOKEN_ENV, "TEST_TOKEN")
    monkeypatch.chdir(tmp_path)

    fake = _fake_graphql_factory(items)
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        meta = rm.discover_board_metadata(
            [rm.COL_TITLE_COUNTY, rm.COL_TITLE_ROLES, rm.COL_TITLE_AVAILABILITY],
            rm.GROUP_TITLE,
        )
        col_ids = meta["column_ids"]
        group_id = meta["group_id"]
        raw = rm.fetch_volunteers(col_ids, group_id)
    assert len(raw) == 5

    volunteers = [rm.build_volunteer_record(it, col_ids) for it in raw]
    volunteers = [v for v in volunteers if v is not None]
    assert len(volunteers) == 4  # Dispatch-only is dropped

    snap = rm.build_snapshot(volunteers)
    assert set(snap["counties"].keys()) == {"Bucks", "Chester"}

    bucks = snap["counties"]["Bucks"]
    assert bucks["ct_no_rvs"]["total"] == 1
    assert bucks["ct_no_rvs"]["available"] == 1
    assert bucks["ct_rvs"]["total"] == 1
    assert bucks["ct_rvs"]["available"] == 1
    assert bucks["courier"]["total"] == 1
    assert bucks["courier"]["available"] == 0  # 'on vacation' keyword
    # Phase 4a: marginal_volunteers carries availability_note only (no name).
    assert bucks["courier"]["marginal_volunteers"][0]["availability_note"] == \
        "on vacation until June"
    assert "name" not in bucks["courier"]["marginal_volunteers"][0]

    chester = snap["counties"]["Chester"]
    assert chester["courier"]["total"] == 1
    assert chester["courier"]["available"] == 1


# ---------------------------------------------------------------------------
# Diff
# ---------------------------------------------------------------------------

def test_diff_added_removed_changed(capsys):
    old = {
        "counties": {
            "Bucks": {
                "ct_no_rvs": {"total": 2, "available": 2, "marginal_volunteers": []},
                "ct_rvs":    {"total": 1, "available": 1, "marginal_volunteers": []},
                "courier":   {"total": 1, "available": 1, "marginal_volunteers": []},
            },
            "Removed": {
                "ct_no_rvs": {"total": 1, "available": 1, "marginal_volunteers": []},
                "ct_rvs":    {"total": 0, "available": 0, "marginal_volunteers": []},
                "courier":   {"total": 0, "available": 0, "marginal_volunteers": []},
            },
        }
    }
    new = {
        "counties": {
            "Bucks": {
                "ct_no_rvs": {"total": 3, "available": 2, "marginal_volunteers": []},
                "ct_rvs":    {"total": 1, "available": 1, "marginal_volunteers": []},
                "courier":   {"total": 1, "available": 1, "marginal_volunteers": []},
            },
            "Added": {
                "ct_no_rvs": {"total": 1, "available": 1, "marginal_volunteers": []},
                "ct_rvs":    {"total": 0, "available": 0, "marginal_volunteers": []},
                "courier":   {"total": 0, "available": 0, "marginal_volunteers": []},
            },
        }
    }
    rm.print_diff(old, new)
    out = capsys.readouterr().out
    assert "+ Added" in out
    assert "- Removed" in out
    assert "Changed: Bucks" in out
    assert "ct_no_rvs" in out


# ---------------------------------------------------------------------------
# Phase 1 fix: narrow volunteer items query
# ---------------------------------------------------------------------------

def test_volunteer_items_query_uses_narrow_columns():
    """fetch_volunteers must request column_values filtered to exactly the
    3 resolved column ids (County / Availability / Roles), not titles, and
    not all 17 columns on the board."""
    captured: list = []

    def fake(query, variables=None, token=None, session=None, _retry=True):
        if "columns" in query and "items_page" not in query:
            return {
                "boards": [
                    {
                        "id": rm.BOARD_ID,
                        "name": "Connecteam_Users",
                        "columns": [
                            {"id": COLUMN_IDS[rm.COL_TITLE_COUNTY], "title": rm.COL_TITLE_COUNTY, "type": "status"},
                            {"id": COLUMN_IDS[rm.COL_TITLE_ROLES], "title": rm.COL_TITLE_ROLES, "type": "tags"},
                            {"id": COLUMN_IDS[rm.COL_TITLE_AVAILABILITY], "title": rm.COL_TITLE_AVAILABILITY, "type": "long_text"},
                        ],
                        "groups": [
                            {"id": RESOLVED_GROUP_ID, "title": rm.GROUP_TITLE},
                        ],
                    }
                ]
            }
        captured.append({"query": query, "variables": variables})
        return {
            "boards": [
                {"groups": [{"id": RESOLVED_GROUP_ID, "items_page": {"cursor": None, "items": []}}]}
            ]
        }

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        meta = rm.discover_board_metadata(
            [rm.COL_TITLE_COUNTY, rm.COL_TITLE_ROLES, rm.COL_TITLE_AVAILABILITY],
            rm.GROUP_TITLE,
        )
        rm.fetch_volunteers(meta["column_ids"], meta["group_id"])

    assert captured, "items_page query was not issued"
    items_call = captured[0]
    # Query must use the col_ids variable on column_values
    assert "$col_ids" in items_call["query"]
    assert "column_values(ids: $col_ids)" in items_call["query"]
    # Variables must include the 3 resolved capacity column ids (not titles)
    # plus the 4 Phase B address column ids (resolved by concrete id) — 7 total.
    sent = items_call["variables"]["col_ids"]
    assert isinstance(sent, list)
    assert len(sent) == 7
    assert set(sent) == {
        COLUMN_IDS[rm.COL_TITLE_COUNTY],
        COLUMN_IDS[rm.COL_TITLE_ROLES],
        COLUMN_IDS[rm.COL_TITLE_AVAILABILITY],
        *rm.ADDRESS_COL_IDS.values(),
    }
    # Sanity: must NOT be the human titles
    assert rm.COL_TITLE_COUNTY not in sent
    assert rm.COL_TITLE_ROLES not in sent
    assert rm.COL_TITLE_AVAILABILITY not in sent


# ---------------------------------------------------------------------------
# Phase 1 fix: resolve Connecteam_Users group by TITLE (not stale hardcoded id)
# ---------------------------------------------------------------------------

def test_group_resolved_by_title():
    """fetch_volunteers must send variables.group_ids=[<resolved id>], where
    the id comes from the introspection response keyed by GROUP_TITLE — not
    the title string and not any hardcoded constant."""
    captured: list = []

    def fake(query, variables=None, token=None, session=None, _retry=True):
        if "columns" in query and "items_page" not in query:
            return {
                "boards": [
                    {
                        "id": rm.BOARD_ID,
                        "name": "Connecteam_Users",
                        "columns": [
                            {"id": COLUMN_IDS[rm.COL_TITLE_COUNTY], "title": rm.COL_TITLE_COUNTY, "type": "status"},
                            {"id": COLUMN_IDS[rm.COL_TITLE_ROLES], "title": rm.COL_TITLE_ROLES, "type": "tags"},
                            {"id": COLUMN_IDS[rm.COL_TITLE_AVAILABILITY], "title": rm.COL_TITLE_AVAILABILITY, "type": "long_text"},
                        ],
                        "groups": [
                            {"id": "group_abc", "title": "users"},
                            {"id": "group_xyz", "title": "archived"},
                        ],
                    }
                ]
            }
        captured.append({"query": query, "variables": variables})
        return {
            "boards": [
                {"groups": [{"id": "group_abc", "items_page": {"cursor": None, "items": []}}]}
            ]
        }

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        meta = rm.discover_board_metadata(
            [rm.COL_TITLE_COUNTY, rm.COL_TITLE_ROLES, rm.COL_TITLE_AVAILABILITY],
            rm.GROUP_TITLE,
        )
        assert meta["group_id"] == "group_abc"
        rm.fetch_volunteers(meta["column_ids"], meta["group_id"])

    assert captured, "items_page query was not issued"
    sent_groups = captured[0]["variables"]["group_ids"]
    assert sent_groups == ["group_abc"]
    # Must NOT be the title string and must NOT be the old hardcoded id.
    assert "users" not in sent_groups
    assert "group_mm39mf3n" not in sent_groups


def test_missing_group_title_raises():
    """If GROUP_TITLE is absent on the board, raise MondayAPIError with the
    available group titles in the message so an admin can fix it."""

    def fake(query, variables=None, token=None, session=None, _retry=True):
        return {
            "boards": [
                {
                    "id": rm.BOARD_ID,
                    "name": "Connecteam_Users",
                    "columns": [
                        {"id": COLUMN_IDS[rm.COL_TITLE_COUNTY], "title": rm.COL_TITLE_COUNTY, "type": "status"},
                        {"id": COLUMN_IDS[rm.COL_TITLE_ROLES], "title": rm.COL_TITLE_ROLES, "type": "tags"},
                        {"id": COLUMN_IDS[rm.COL_TITLE_AVAILABILITY], "title": rm.COL_TITLE_AVAILABILITY, "type": "long_text"},
                    ],
                    "groups": [
                        {"id": "group_xyz", "title": "archived"},
                        {"id": "group_qrs", "title": "topics"},
                    ],
                }
            ]
        }

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        with pytest.raises(rm.MondayAPIError) as ei:
            rm.discover_board_metadata(
                [rm.COL_TITLE_COUNTY, rm.COL_TITLE_ROLES, rm.COL_TITLE_AVAILABILITY],
                rm.GROUP_TITLE,
            )
    msg = str(ei.value)
    assert "Available groups:" in msg
    assert "'users'" in msg or "users" in msg


# ---------------------------------------------------------------------------
# Phase 2.5 — config file (tunable thresholds + per-county overrides)
# ---------------------------------------------------------------------------


def _ct_only(name, county, avail=""):
    return _item(name, county, "C&T", avail)


def test_resolve_marginal_threshold_default_when_no_config():
    assert rm.resolve_marginal_threshold({}, "Bucks") == 1


def test_resolve_marginal_threshold_global_override():
    cfg = {"marginal_threshold": 3}
    assert rm.resolve_marginal_threshold(cfg, "Bucks") == 3
    assert rm.resolve_marginal_threshold(cfg, "Chester") == 3


def test_resolve_marginal_threshold_per_county_override():
    cfg = {
        "marginal_threshold": 1,
        "county_overrides": {"Bucks": {"marginal_threshold": 0}},
    }
    assert rm.resolve_marginal_threshold(cfg, "Bucks") == 0
    # Other counties keep the global.
    assert rm.resolve_marginal_threshold(cfg, "Chester") == 1


def test_resolve_marginal_threshold_county_override_with_only_escalate_falls_through():
    cfg = {
        "marginal_threshold": 2,
        "county_overrides": {
            "Bucks": {"escalate_to_game_commission": {"ct_any_capture_min_available": 0}}
        },
    }
    # Bucks override has no marginal_threshold → fall through to global.
    assert rm.resolve_marginal_threshold(cfg, "Bucks") == 2


def test_aggregate_uses_global_threshold_three_includes_marginal_for_two():
    """With threshold=3, a bucket with available=2 should populate marginal_volunteers."""
    items = [
        _ct_only("First", "Lehigh", "Mon-Fri"),
        _ct_only("Second", "Lehigh", "weekends"),
    ]
    volunteers = [rm.build_volunteer_record(it, COLUMN_IDS) for it in items]
    snap = rm.build_snapshot(volunteers, config={"marginal_threshold": 3})
    bucket = snap["counties"]["Lehigh"]["ct_no_rvs"]
    assert bucket["available"] == 2
    notes = {m["availability_note"] for m in bucket["marginal_volunteers"]}
    assert notes == {"Mon-Fri", "weekends"}
    for mv in bucket["marginal_volunteers"]:
        assert "name" not in mv


def test_aggregate_per_county_override_suppresses_marginal_in_bucks():
    """Bucks override threshold=0 → no marginal even when available=1.
    Other counties keep global threshold=1 → marginal still populated."""
    items = [
        _ct_only("BucksOnly", "Bucks", "Mon-Fri"),
        _ct_only("ChesterOnly", "Chester", "Mon-Fri"),
    ]
    volunteers = [rm.build_volunteer_record(it, COLUMN_IDS) for it in items]
    cfg = {
        "marginal_threshold": 1,
        "county_overrides": {"Bucks": {"marginal_threshold": 0}},
    }
    snap = rm.build_snapshot(volunteers, config=cfg)
    assert snap["counties"]["Bucks"]["ct_no_rvs"]["available"] == 1
    assert snap["counties"]["Bucks"]["ct_no_rvs"]["marginal_volunteers"] == []
    assert snap["counties"]["Chester"]["ct_no_rvs"]["available"] == 1
    chester_mv = snap["counties"]["Chester"]["ct_no_rvs"]["marginal_volunteers"]
    assert chester_mv[0]["availability_note"] == "Mon-Fri"
    assert "name" not in chester_mv[0]


def test_load_config_missing_warns_and_returns_empty(tmp_path, caplog):
    # Use an empty repo root — no docs/data/config.json there.
    with caplog.at_level("WARNING", logger="refresh_monday"):
        cfg = rm.load_config(tmp_path)
    assert cfg == {}
    assert any(
        "config.json not found" in rec.message for rec in caplog.records
    )


def test_load_config_malformed_raises(tmp_path):
    cfg_dir = tmp_path / "docs" / "data"
    cfg_dir.mkdir(parents=True)
    (cfg_dir / "config.json").write_text("{not valid json", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        rm.load_config(tmp_path)


def test_load_config_valid_roundtrip(tmp_path):
    cfg_dir = tmp_path / "docs" / "data"
    cfg_dir.mkdir(parents=True)
    payload = {
        "marginal_threshold": 2,
        "county_overrides": {"Bucks": {"marginal_threshold": 0}},
    }
    (cfg_dir / "config.json").write_text(json.dumps(payload), encoding="utf-8")
    assert rm.load_config(tmp_path) == payload


def test_unknown_county_override_warns_but_does_not_fail(caplog):
    # Reset the dedup cache so the warning fires for this test.
    rm._warn_unknown_county_overrides._seen.clear()
    cfg = {
        "marginal_threshold": 1,
        "county_overrides": {"Atlantis": {"marginal_threshold": 5}},
    }
    with caplog.at_level("WARNING", logger="refresh_monday"):
        # Resolve for a real county; the warning should still fire because
        # the override map is scanned at resolution time.
        assert rm.resolve_marginal_threshold(cfg, "Bucks") == 1
    assert any(
        "Unknown county in config.county_overrides: Atlantis" in rec.message
        for rec in caplog.records
    )


def test_existing_baseline_threshold_one_still_works():
    """Sanity: passing config={'marginal_threshold': 1} matches the
    historical hardcoded behavior — marginal populated when available <= 1."""
    items = [_ct_only("Solo", "Adams", "Mon-Fri")]
    volunteers = [rm.build_volunteer_record(it, COLUMN_IDS) for it in items]
    snap = rm.build_snapshot(volunteers, config={"marginal_threshold": 1})
    bucket = snap["counties"]["Adams"]["ct_no_rvs"]
    assert bucket["available"] == 1
    assert bucket["marginal_volunteers"][0]["availability_note"] == "Mon-Fri"
    assert "name" not in bucket["marginal_volunteers"][0]


# ---------------------------------------------------------------------------
# Multi-group fetch: users + non-users merged with connecteam_user tag
# ---------------------------------------------------------------------------

NONUSER_GROUP_ID = "group_nonusers"


def test_multi_group_fetch_merges_and_tags_connecteam_user():
    """Volunteers from 'users' and 'non-users' groups are merged into a
    single pool, correctly tagged with connecteam_user, and aggregated
    together in county counts."""
    users_items = [
        _item("Alice CT", "Bucks", "C&T", "Mon-Fri"),
        _item("Bob Dispatch", "Bucks", "Dispatch", ""),  # filtered
    ]
    nonusers_items = [
        _item("Charlie Courier", "Bucks", "Courier", "weekends"),
        _item("Dana CT+RVS", "Chester", "C&T, RVS", "Does not use Connecteam"),
    ]

    groups = [
        {"id": RESOLVED_GROUP_ID, "title": "users"},
        {"id": NONUSER_GROUP_ID, "title": "non-users"},
    ]
    items_by_group = {
        RESOLVED_GROUP_ID: users_items,
        NONUSER_GROUP_ID: nonusers_items,
    }
    fake = _fake_graphql_factory(items_by_group, groups=groups)

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        meta = rm.discover_board_metadata(
            [rm.COL_TITLE_COUNTY, rm.COL_TITLE_ROLES, rm.COL_TITLE_AVAILABILITY],
            rm.GROUP_TITLES,
        )
        col_ids = meta["column_ids"]
        group_ids_map = meta["group_ids"]

    # Fetch + build for each group
    volunteers = []
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        for title, gid in group_ids_map.items():
            is_connecteam = (title == "users")
            raw = rm.fetch_volunteers(col_ids, gid)
            for item in raw:
                rec = rm.build_volunteer_record(item, col_ids, connecteam_user=is_connecteam)
                if rec is not None:
                    volunteers.append(rec)

    # 3 qualify (Bob filtered out)
    assert len(volunteers) == 3

    # Check tagging
    alice = next(v for v in volunteers if v["name"] == "Alice CT")
    assert alice["connecteam_user"] is True
    charlie = next(v for v in volunteers if v["name"] == "Charlie Courier")
    assert charlie["connecteam_user"] is False
    dana = next(v for v in volunteers if v["name"] == "Dana CT+RVS")
    assert dana["connecteam_user"] is False

    # Aggregation merges both groups
    snap = rm.build_snapshot(volunteers)
    bucks = snap["counties"]["Bucks"]
    assert bucks["ct_no_rvs"]["total"] == 1  # Alice
    assert bucks["courier"]["total"] == 1    # Charlie
    chester = snap["counties"]["Chester"]
    assert chester["ct_rvs"]["total"] == 1   # Dana

    # connecteam_user propagates to marginal_volunteers
    assert bucks["ct_no_rvs"]["marginal_volunteers"][0]["connecteam_user"] is True
    assert bucks["courier"]["marginal_volunteers"][0]["connecteam_user"] is False


# ---------------------------------------------------------------------------
# REGRESSION-LOCK (2026-06-10): the geocode-input pipeline MUST carry
# connecteam_user through so the flag reaches volunteer_coords.json -> KV ->
# the Worker's Tier-2 rows. Without it the Worker coerced every row to "not on
# Connecteam" (the false DuBois "7 of 7" banner). Tri-state: True / False / None
# (unknown) must each survive verbatim.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("flag", [True, False, None])
def test_regression_build_geocode_input_carries_connecteam_user(flag):
    out = rm.build_geocode_input(
        _item("Geo Vol", "Bucks", "C&T", "Mon-Fri"),
        COLUMN_IDS,
        connecteam_user=flag,
    )
    assert out is not None, "geocode input is produced for an addressable volunteer"
    assert "connecteam_user" in out, "connecteam_user key MUST be present in geocode input"
    assert out["connecteam_user"] is flag, (
        "connecteam_user must pass through verbatim (tri-state), got %r" % (out["connecteam_user"],)
    )


def test_regression_build_geocode_input_default_connecteam_user_is_none():
    # When the caller omits the flag (unknown group), it defaults to None
    # (unknown) -- NEVER False -- so the Worker never flags it as non-Connecteam.
    out = rm.build_geocode_input(
        _item("Geo Vol2", "Bucks", "C&T"),
        COLUMN_IDS,
    )
    assert out["connecteam_user"] is None

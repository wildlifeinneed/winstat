"""Tests for refresh_monday.py — fully offline, GraphQL is mocked."""

from __future__ import annotations

import json
import os
import sys
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
        {"name": "Only One", "availability_note": "Mon-Fri"}
    ]


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
    assert {m["name"] for m in bucket["marginal_volunteers"]} == {"Out A", "Out B"}


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

def _fake_graphql_factory(items):
    """Return a fake graphql_request that handles introspect + items_page calls."""
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
                "groups": [
                    {"id": RESOLVED_GROUP_ID, "title": rm.GROUP_TITLE},
                    {"id": "group_xyz", "title": "archived"},
                ],
            }
        ]
    }
    items_response = {
        "boards": [
            {"groups": [{"id": RESOLVED_GROUP_ID, "items_page": {"cursor": None, "items": items}}]}
        ]
    }

    def fake(query, variables=None, token=None, session=None, _retry=True):
        if "columns" in query and "items_page" not in query:
            return introspect_response
        return items_response

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
    assert bucks["courier"]["marginal_volunteers"][0]["name"] == "Charlie Courier"

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
    # Variables must include exactly the 3 resolved column ids (not titles)
    sent = items_call["variables"]["col_ids"]
    assert isinstance(sent, list)
    assert len(sent) == 3
    assert set(sent) == {
        COLUMN_IDS[rm.COL_TITLE_COUNTY],
        COLUMN_IDS[rm.COL_TITLE_ROLES],
        COLUMN_IDS[rm.COL_TITLE_AVAILABILITY],
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

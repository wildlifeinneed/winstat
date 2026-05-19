"""Phase 1.5 tests — staleness gate / --if-stale flag.

All Monday GraphQL calls are mocked. No real network access.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import refresh_monday as rm  # noqa: E402


COLUMN_IDS = {
    rm.COL_TITLE_COUNTY: "country_or_region",
    rm.COL_TITLE_ROLES: "tags__1",
    rm.COL_TITLE_AVAILABILITY: "long_text__1",
}

TRACKER_COL_ID = "date_lu"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _vol_item(name, county, roles, availability=""):
    return {
        "id": name.replace(" ", "_"),
        "name": name,
        "column_values": [
            {"id": COLUMN_IDS[rm.COL_TITLE_COUNTY], "text": county, "value": None, "type": "status"},
            {"id": COLUMN_IDS[rm.COL_TITLE_ROLES], "text": roles, "value": None, "type": "tags"},
            {"id": COLUMN_IDS[rm.COL_TITLE_AVAILABILITY], "text": availability, "value": None, "type": "long_text"},
        ],
    }


TRACKER_GROUP_ID = "topics"


def _tracker_response(items, *, include_column=True, include_group=True):
    """Returns a 2-element list mirroring the two-call shape of
    fetch_remote_last_updated: [discovery_resp, narrow_items_resp]."""
    columns = []
    if include_column:
        columns.append({"id": TRACKER_COL_ID, "title": rm.TRACKER_COL_TITLE_LAST_UPDATED})
    columns.append({"id": "name", "title": "Name"})
    groups = []
    if include_group:
        groups.append({"id": TRACKER_GROUP_ID, "title": rm.TRACKER_GROUP_TITLE})
    discovery = {"boards": [{"id": rm.TRACKER_BOARD_ID, "columns": columns, "groups": groups}]}
    narrow = {"boards": [{"groups": [{"id": TRACKER_GROUP_ID, "items_page": {"items": items}}]}]}
    return [discovery, narrow]


def _tracker_item(name, last_updated_text):
    return {
        "id": name,
        "name": name,
        "column_values": [
            {"id": TRACKER_COL_ID, "text": last_updated_text, "value": None, "type": "date"},
        ],
    }


def _main_introspect():
    return {
        "boards": [{
            "id": rm.BOARD_ID,
            "name": "Connecteam_Users",
            "columns": [
                {"id": COLUMN_IDS[rm.COL_TITLE_COUNTY], "title": rm.COL_TITLE_COUNTY, "type": "status"},
                {"id": COLUMN_IDS[rm.COL_TITLE_ROLES], "title": rm.COL_TITLE_ROLES, "type": "tags"},
                {"id": COLUMN_IDS[rm.COL_TITLE_AVAILABILITY], "title": rm.COL_TITLE_AVAILABILITY, "type": "long_text"},
            ],
        }]
    }


def _main_items(items):
    return {"boards": [{"groups": [{"id": rm.GROUP_ID, "items_page": {"cursor": None, "items": items}}]}]}


def _make_dispatcher(*, tracker_resp, main_items=None, raise_on_items=False):
    """Return a fake graphql_request that routes by query content.

    `tracker_resp` is either a list of sequential responses (popped per
    tracker call) or a single Exception to raise on first tracker call.
    Tracks call counts in `.calls` and tracker variables in
    `.tracker_vars` for assertions.
    """
    calls = {"tracker": 0, "introspect": 0, "items": 0}
    tracker_queue = list(tracker_resp) if isinstance(tracker_resp, list) else None
    tracker_vars: list = []

    def fake(query, variables=None, token=None, session=None, _retry=True):
        if variables and variables.get("board_ids") == [rm.TRACKER_BOARD_ID]:
            calls["tracker"] += 1
            tracker_vars.append(dict(variables))
            if tracker_queue is not None:
                if not tracker_queue:
                    raise AssertionError("tracker called more times than responses provided")
                resp = tracker_queue.pop(0)
            else:
                resp = tracker_resp
            if isinstance(resp, Exception):
                raise resp
            return resp
        if variables and variables.get("board_ids") == [rm.BOARD_ID] and "items_page" not in query:
            calls["introspect"] += 1
            return _main_introspect()
        if "items_page" in query:
            calls["items"] += 1
            if raise_on_items:
                raise AssertionError("items query should not have happened")
            return _main_items(main_items or [])
        raise AssertionError(f"Unexpected query: {query[:80]}")

    fake.calls = calls
    fake.tracker_vars = tracker_vars
    return fake


@pytest.fixture
def patched_paths(tmp_path, monkeypatch):
    """Redirect script-relative output paths into tmp_path."""
    out_json = tmp_path / "county_capacity.json"
    sidecar = tmp_path / ".last_remote_update"

    real_path_cls = rm.Path

    class FakePath(type(real_path_cls())):
        pass

    def fake_resolve_parent_div(self_path):
        # Patch the (Path(__file__).resolve().parent / REL) idiom by
        # patching the two REL constants to absolute tmp paths instead.
        return self_path

    monkeypatch.setattr(rm, "OUTPUT_REL_PATH", out_json)
    monkeypatch.setattr(rm, "SIDECAR_REL_PATH", sidecar)
    # Path(__file__).resolve().parent / abs_path returns abs_path, so the
    # script will write into tmp_path.
    monkeypatch.setenv(rm.TOKEN_ENV, "TEST_TOKEN")
    monkeypatch.chdir(tmp_path)
    return {"out": out_json, "sidecar": sidecar, "tmp": tmp_path}


# ---------------------------------------------------------------------------
# Pure-function tests for the new helpers
# ---------------------------------------------------------------------------

def test_parse_remote_datetime_from_value_json():
    dt = rm._parse_remote_datetime("", json.dumps({"date": "2026-05-19", "time": "14:30:00"}))
    assert dt == datetime(2026, 5, 19, 14, 30, 0, tzinfo=timezone.utc)


def test_parse_remote_datetime_from_text():
    dt = rm._parse_remote_datetime("2026-05-19 14:30:00", None)
    assert dt == datetime(2026, 5, 19, 14, 30, 0, tzinfo=timezone.utc)


def test_parse_remote_datetime_date_only():
    dt = rm._parse_remote_datetime("2026-05-19", None)
    assert dt == datetime(2026, 5, 19, 0, 0, 0, tzinfo=timezone.utc)


def test_parse_remote_datetime_unparseable_raises():
    with pytest.raises(rm.StalenessError):
        rm._parse_remote_datetime("not a date", None)


def test_format_iso_z():
    dt = datetime(2026, 5, 19, 14, 30, 0, tzinfo=timezone.utc)
    assert rm._format_iso_z(dt) == "2026-05-19T14:30:00Z"


def test_sidecar_roundtrip(tmp_path):
    p = tmp_path / ".last_remote_update"
    dt = datetime(2026, 5, 19, 14, 30, 0, tzinfo=timezone.utc)
    rm.atomic_write_sidecar(p, dt)
    assert p.read_text(encoding="utf-8").strip() == "2026-05-19T14:30:00Z"
    assert rm.read_sidecar(p) == dt


def test_sidecar_missing_returns_none(tmp_path):
    assert rm.read_sidecar(tmp_path / "nope") is None


def test_sidecar_unparseable_raises(tmp_path):
    p = tmp_path / "bad"
    p.write_text("garbage\n", encoding="utf-8")
    with pytest.raises(rm.StalenessError):
        rm.read_sidecar(p)


# ---------------------------------------------------------------------------
# fetch_remote_last_updated
# ---------------------------------------------------------------------------

def test_fetch_remote_last_updated_max_of_multiple():
    resps = _tracker_response([
        _tracker_item("a", "2026-05-10 12:00:00"),
        _tracker_item("b", "2026-05-19 14:30:00"),  # max
        _tracker_item("c", "2026-05-15 09:00:00"),
    ])
    with mock.patch.object(rm, "graphql_request", side_effect=resps) as mocked:
        ts = rm.fetch_remote_last_updated(token="X")
    assert ts == datetime(2026, 5, 19, 14, 30, 0, tzinfo=timezone.utc)
    assert mocked.call_count == 2


def test_tracker_query_uses_two_calls():
    """Phase 1.5 fix: discovery + narrow fetch, with resolved group_id
    threaded into the second call's variables."""
    resps = _tracker_response([_tracker_item("a", "2026-05-19 14:30:00")])
    with mock.patch.object(rm, "graphql_request", side_effect=resps) as mocked:
        rm.fetch_remote_last_updated(token="X")
    assert mocked.call_count == 2
    second = mocked.call_args_list[1]
    second_vars = second.kwargs.get("variables")
    if second_vars is None:
        second_vars = second.args[1]
    assert second_vars["group_ids"] == [TRACKER_GROUP_ID]
    assert second_vars["col_ids"] == [TRACKER_COL_ID]
    assert second_vars["board_ids"] == [rm.TRACKER_BOARD_ID]
    # Narrow fetch must use a small limit, not the old 100.
    assert second_vars["limit"] <= 25


def test_fetch_remote_last_updated_zero_items_fails_loud():
    resps = _tracker_response([])
    with mock.patch.object(rm, "graphql_request", side_effect=resps):
        with pytest.raises(rm.StalenessError, match="zero items"):
            rm.fetch_remote_last_updated(token="X")


def test_fetch_remote_last_updated_missing_column_fails():
    resps = _tracker_response([_tracker_item("a", "2026-05-19")], include_column=False)
    with mock.patch.object(rm, "graphql_request", side_effect=resps) as mocked:
        with pytest.raises(rm.StalenessError, match="not found"):
            rm.fetch_remote_last_updated(token="X")
    # Discovery alone surfaces the missing column — no narrow call.
    assert mocked.call_count == 1


def test_fetch_remote_last_updated_missing_group_fails():
    resps = _tracker_response([], include_group=False)
    with mock.patch.object(rm, "graphql_request", side_effect=resps) as mocked:
        with pytest.raises(rm.StalenessError, match="not found"):
            rm.fetch_remote_last_updated(token="X")
    assert mocked.call_count == 1


def test_fetch_remote_last_updated_bad_date_fails():
    resps = _tracker_response([_tracker_item("a", "totally-not-a-date")])
    with mock.patch.object(rm, "graphql_request", side_effect=resps):
        with pytest.raises(rm.StalenessError):
            rm.fetch_remote_last_updated(token="X")


def test_fetch_remote_last_updated_all_blank_values():
    """Items present but Last_Updated cell is blank on every row."""
    resps = _tracker_response([_tracker_item("a", "")])
    with mock.patch.object(rm, "graphql_request", side_effect=resps):
        with pytest.raises(rm.StalenessError, match="no values"):
            rm.fetch_remote_last_updated(token="X")


# ---------------------------------------------------------------------------
# CLI — --if-stale paths
# ---------------------------------------------------------------------------

def test_if_stale_remote_newer_triggers_full_pull(patched_paths):
    sidecar = patched_paths["sidecar"]
    out_json = patched_paths["out"]
    sidecar.write_text("2026-05-10T00:00:00Z\n", encoding="utf-8")

    fake = _make_dispatcher(
        tracker_resp=_tracker_response([_tracker_item("a", "2026-05-19 14:30:00")]),
        main_items=[_vol_item("Alpha", "Bucks", "C&T")],
    )
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        rc = rm.main(["--if-stale"])
    assert rc == 0
    assert fake.calls["tracker"] == 2
    assert fake.calls["items"] == 1
    # Sidecar updated to remote ts.
    assert sidecar.read_text(encoding="utf-8").strip() == "2026-05-19T14:30:00Z"
    # Snapshot written.
    assert json.loads(out_json.read_text())["counties"]["Bucks"]["ct_no_rvs"]["total"] == 1


def test_if_stale_fresh_skips_pull(patched_paths, capsys):
    sidecar = patched_paths["sidecar"]
    out_json = patched_paths["out"]
    sidecar.write_text("2026-05-19T14:30:00Z\n", encoding="utf-8")
    sidecar_mtime = sidecar.stat().st_mtime

    fake = _make_dispatcher(
        tracker_resp=_tracker_response([_tracker_item("a", "2026-05-19 14:30:00")]),
        raise_on_items=True,
    )
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        rc = rm.main(["--if-stale"])
    assert rc == 0
    assert fake.calls["tracker"] == 2
    assert fake.calls["items"] == 0
    assert fake.calls["introspect"] == 0
    # Sidecar untouched.
    assert sidecar.stat().st_mtime == sidecar_mtime
    assert not out_json.exists()
    err = capsys.readouterr().err
    assert "fresh, skipping" in err
    assert "remote=2026-05-19T14:30:00Z" in err


def test_if_stale_missing_sidecar_treated_as_stale(patched_paths):
    sidecar = patched_paths["sidecar"]
    assert not sidecar.exists()
    fake = _make_dispatcher(
        tracker_resp=_tracker_response([_tracker_item("a", "2026-05-19 14:30:00")]),
        main_items=[_vol_item("Alpha", "Bucks", "C&T")],
    )
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        rc = rm.main(["--if-stale"])
    assert rc == 0
    assert fake.calls["items"] == 1
    assert sidecar.read_text(encoding="utf-8").strip() == "2026-05-19T14:30:00Z"


def test_if_stale_malformed_remote_fails_loud(patched_paths, capsys):
    sidecar = patched_paths["sidecar"]
    sidecar.write_text("2026-05-10T00:00:00Z\n", encoding="utf-8")
    sidecar_mtime = sidecar.stat().st_mtime

    fake = _make_dispatcher(
        tracker_resp=_tracker_response([]),  # zero items
        raise_on_items=True,
    )
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        rc = rm.main(["--if-stale"])
    assert rc != 0
    assert fake.calls["items"] == 0
    # Sidecar untouched.
    assert sidecar.stat().st_mtime == sidecar_mtime
    err = capsys.readouterr().err
    assert "ERROR" in err


def test_if_stale_dry_run_stale_does_not_write_sidecar(patched_paths, capsys):
    sidecar = patched_paths["sidecar"]
    out_json = patched_paths["out"]
    sidecar.write_text("2026-05-10T00:00:00Z\n", encoding="utf-8")
    original_sidecar = sidecar.read_text(encoding="utf-8")

    fake = _make_dispatcher(
        tracker_resp=_tracker_response([_tracker_item("a", "2026-05-19 14:30:00")]),
        main_items=[_vol_item("Alpha", "Bucks", "C&T")],
    )
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        rc = rm.main(["--if-stale", "--dry-run"])
    assert rc == 0
    # Sidecar unchanged in dry-run.
    assert sidecar.read_text(encoding="utf-8") == original_sidecar
    # Snapshot file not written in dry-run.
    assert not out_json.exists()
    out = capsys.readouterr().out
    # JSON snapshot was printed.
    assert "Bucks" in out


# ---------------------------------------------------------------------------
# CLI — bare run writes sidecar
# ---------------------------------------------------------------------------

def test_bare_run_writes_sidecar(patched_paths):
    sidecar = patched_paths["sidecar"]
    out_json = patched_paths["out"]
    assert not sidecar.exists()

    fake = _make_dispatcher(
        tracker_resp=_tracker_response([_tracker_item("a", "2026-05-19 14:30:00")]),
        main_items=[_vol_item("Alpha", "Bucks", "C&T")],
    )
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        rc = rm.main([])
    assert rc == 0
    assert sidecar.read_text(encoding="utf-8").strip() == "2026-05-19T14:30:00Z"
    assert out_json.exists()


def test_bare_run_dry_run_does_not_write_sidecar(patched_paths):
    sidecar = patched_paths["sidecar"]
    out_json = patched_paths["out"]
    fake = _make_dispatcher(
        tracker_resp=_tracker_response([_tracker_item("a", "2026-05-19 14:30:00")]),
        main_items=[_vol_item("Alpha", "Bucks", "C&T")],
    )
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        rc = rm.main(["--dry-run"])
    assert rc == 0
    assert not sidecar.exists()
    assert not out_json.exists()


def test_bare_run_tracker_failure_does_not_break_pull(patched_paths, capsys):
    """Bare run must not be hard-blocked by tracker board hiccups (only
    --if-stale fails loud). Sidecar simply isn't updated."""
    sidecar = patched_paths["sidecar"]
    out_json = patched_paths["out"]

    fake = _make_dispatcher(
        tracker_resp=_tracker_response([]),  # malformed
        main_items=[_vol_item("Alpha", "Bucks", "C&T")],
    )
    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        rc = rm.main([])
    assert rc == 0
    assert out_json.exists()
    assert not sidecar.exists()

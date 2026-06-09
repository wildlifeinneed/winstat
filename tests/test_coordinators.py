"""Tests for the area-coordinator NAME pipeline — fully offline.

The Area Coordinators Monday board is mocked; NO live network is used. Covers:
  * item NAME -> area, long_text_mm455k2n -> coordinator name mapping
  * the phone column (phone_mm45s2h0) is NEVER requested NOR emitted
  * blank area / blank name rows are skipped
  * fetch_coordinators issues a narrow group-scoped items_page query
  * county_win prefers coordinators.json override, falls back to xlsx
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import refresh_monday as rm  # noqa: E402
import county_win as cw  # noqa: E402


# The phone column id that MUST NEVER appear in any query or output.
PHONE_COL_ID = "phone_mm45s2h0"


def _coord_item(area="15N", name="Jane Coordinator", phone="555-1234") -> dict:
    """Build a raw coordinator item.

    The phone column is present in the RAW board payload (as it would be on
    Monday) so the tests can prove our code does NOT read it.
    """
    return {
        "id": f"item_{area}",
        "name": area,
        "column_values": [
            {
                "id": rm.COORD_COL_IDS["name"],
                "text": name,
                "value": None,
                "type": "long_text",
            },
            {"id": PHONE_COL_ID, "text": phone, "value": None, "type": "phone"},
        ],
    }


# ---------------------------------------------------------------------------
# 1. Mapping: item name -> area, long_text -> coordinator name
# ---------------------------------------------------------------------------

def test_build_coordinators_maps_name_to_area_and_longtext_to_name():
    items = [
        _coord_item(area="15N", name="Alice"),
        _coord_item(area="10", name="Bob"),
        _coord_item(area="1", name="Carol"),
    ]
    result = rm.build_coordinators(items)
    assert result == {"15N": "Alice", "10": "Bob", "1": "Carol"}


def test_build_coordinators_areas_kept_verbatim():
    # Split codes like 15N/15S must match county_win area strings EXACTLY.
    items = [_coord_item(area="15S", name="Dave")]
    result = rm.build_coordinators(items)
    assert "15S" in result
    assert result["15S"] == "Dave"


def test_build_coordinators_skips_blank_area_or_name():
    items = [
        _coord_item(area="", name="NoArea"),
        _coord_item(area="10", name=""),
        _coord_item(area="15N", name="Keep"),
    ]
    result = rm.build_coordinators(items)
    assert result == {"15N": "Keep"}


# ---------------------------------------------------------------------------
# 2. Phone column is NEVER read NOR emitted
# ---------------------------------------------------------------------------

def test_build_coordinators_never_emits_phone():
    items = [_coord_item(area="15N", name="Alice", phone="555-9999")]
    result = rm.build_coordinators(items)
    # Output is area->name only; no phone value or key anywhere.
    assert result == {"15N": "Alice"}
    blob = json.dumps(result)
    assert "555-9999" not in blob
    assert PHONE_COL_ID not in blob


def test_phone_column_id_not_in_coord_col_ids():
    # Defensive: the phone column id must not be in the requested column set.
    assert PHONE_COL_ID not in rm.COORD_COL_IDS.values()


def test_fetch_coordinators_does_not_request_phone_column():
    captured: list = []
    items = [_coord_item(area="15N", name="Alice", phone="555-1234")]

    def fake(query, variables=None, token=None, session=None, _retry=True):
        captured.append({"query": query, "variables": variables})
        return {
            "boards": [
                {"groups": [{"items_page": {"cursor": None, "items": items}}]}
            ]
        }

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        raw = rm.fetch_coordinators("grp1", token="TEST")

    call = captured[0]
    sent_cols = call["variables"]["col_ids"]
    # Phone column id is NEVER requested.
    assert PHONE_COL_ID not in sent_cols
    assert set(sent_cols) == set(rm.COORD_COL_IDS.values())
    # And the resulting mapping never carries the phone value.
    result = rm.build_coordinators(raw)
    assert result == {"15N": "Alice"}


# ---------------------------------------------------------------------------
# 3. fetch_coordinators: narrow group-scoped query + pagination + board id
# ---------------------------------------------------------------------------

def test_fetch_coordinators_narrow_group_scoped_query():
    captured: list = []
    items = [_coord_item(area="15N", name="Alice")]

    def fake(query, variables=None, token=None, session=None, _retry=True):
        captured.append({"query": query, "variables": variables})
        return {
            "boards": [
                {"groups": [{"items_page": {"cursor": None, "items": items}}]}
            ]
        }

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        raw = rm.fetch_coordinators("grpX", token="TEST")

    assert len(raw) == 1
    call = captured[0]
    assert "column_values(ids: $col_ids)" in call["query"]
    assert "groups(ids: $group_ids)" in call["query"]
    assert call["variables"]["board_ids"] == [rm.COORDINATORS_BOARD_ID]
    assert call["variables"]["group_ids"] == ["grpX"]


def test_fetch_coordinators_paginates_via_cursor():
    page1 = [_coord_item(area="15N", name="P1")]
    page2 = [_coord_item(area="10", name="P2")]
    responses = [
        {"boards": [{"groups": [{"items_page": {"cursor": "next", "items": page1}}]}]},
        {"boards": [{"groups": [{"items_page": {"cursor": None, "items": page2}}]}]},
    ]

    def fake(query, variables=None, token=None, session=None, _retry=True):
        return responses.pop(0)

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        raw = rm.fetch_coordinators("grp1", token="TEST")

    result = rm.build_coordinators(raw)
    assert result == {"15N": "P1", "10": "P2"}


def test_discover_coordinators_group_id_resolves_title():
    def fake(query, variables=None, token=None, session=None, _retry=True):
        assert variables["board_ids"] == [rm.COORDINATORS_BOARD_ID]
        return {
            "boards": [
                {
                    "groups": [
                        {"id": "topics", "title": "Coordinators"},
                        {"id": "other", "title": "Archive"},
                    ]
                }
            ]
        }

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        gid = rm.discover_coordinators_group_id(token="TEST")
    assert gid == "topics"


# ---------------------------------------------------------------------------
# 4. county_win: override precedence (coordinators.json) + xlsx fallback
# ---------------------------------------------------------------------------

def _reset_cw_override_cache():
    cw._COORD_OVERRIDE = None


def test_county_win_prefers_override_when_present(tmp_path, monkeypatch):
    # Area 10 = Allegheny/Beaver; override the coordinator name.
    override = tmp_path / "coordinators.json"
    override.write_text(json.dumps({"10": "Override Coordinator"}), encoding="utf-8")
    monkeypatch.setattr(cw, "COORDINATORS_JSON_PATH", override)
    _reset_cw_override_cache()
    monkeypatch.setattr(cw, "_COORD_OVERRIDE", None)

    info = cw.lookup_county("Allegheny")
    assert info is not None
    assert info.area == "10"
    assert info.coordinator == "Override Coordinator"

    # Reverse lookup also honors the override.
    counties, coordinator = cw.counties_for_area("10")
    assert coordinator == "Override Coordinator"

    _reset_cw_override_cache()


def test_county_win_falls_back_to_xlsx_when_area_absent(tmp_path, monkeypatch):
    # Override only covers area 1 -> Allegheny (area 10) must fall back to xlsx.
    override = tmp_path / "coordinators.json"
    override.write_text(json.dumps({"1": "Erie Boss"}), encoding="utf-8")
    monkeypatch.setattr(cw, "COORDINATORS_JSON_PATH", override)
    monkeypatch.setattr(cw, "_COORD_OVERRIDE", None)

    # Capture the raw spreadsheet coordinator (no override applied).
    monkeypatch.setattr(cw, "_COORD_OVERRIDE", {})
    xlsx_coord = cw.lookup_county("Allegheny").coordinator

    # Now apply the partial override; Allegheny still uses xlsx value.
    monkeypatch.setattr(cw, "_COORD_OVERRIDE", None)
    info = cw.lookup_county("Allegheny")
    assert info.coordinator == xlsx_coord

    # Erie (area 1) IS overridden.
    assert cw.lookup_county("Erie").coordinator == "Erie Boss"

    _reset_cw_override_cache()


def test_county_win_falls_back_when_file_missing(tmp_path, monkeypatch):
    missing = tmp_path / "does_not_exist.json"
    monkeypatch.setattr(cw, "COORDINATORS_JSON_PATH", missing)
    monkeypatch.setattr(cw, "_COORD_OVERRIDE", None)

    # Must not raise; coordinator comes from xlsx (non-empty).
    info = cw.lookup_county("Allegheny")
    assert info is not None
    assert info.coordinator.strip()

    _reset_cw_override_cache()


def test_county_win_falls_back_when_file_malformed(tmp_path, monkeypatch):
    bad = tmp_path / "coordinators.json"
    bad.write_text("{ not valid json", encoding="utf-8")
    monkeypatch.setattr(cw, "COORDINATORS_JSON_PATH", bad)
    monkeypatch.setattr(cw, "_COORD_OVERRIDE", None)

    info = cw.lookup_county("Allegheny")
    assert info is not None
    assert info.coordinator.strip()

    _reset_cw_override_cache()


def test_county_win_return_shape_unchanged(tmp_path, monkeypatch):
    override = tmp_path / "coordinators.json"
    override.write_text(json.dumps({"10": "X"}), encoding="utf-8")
    monkeypatch.setattr(cw, "COORDINATORS_JSON_PATH", override)
    monkeypatch.setattr(cw, "_COORD_OVERRIDE", None)

    info = cw.lookup_county("Allegheny")
    # Still a CountyInfo(area, coordinator) NamedTuple.
    assert isinstance(info, cw.CountyInfo)
    assert info._fields == ("area", "coordinator")

    _reset_cw_override_cache()

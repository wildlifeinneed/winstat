"""Tests for the facilities.json BASE dataset (Option A join-at-read) — offline.

The RehabDB Monday board is mocked; NO live network is used. Covers:
  * build_facility_record emits exactly the BASE schema (name/address/city/
    state/zip/phone/website/lat/lon/county) and NEVER a status/open-closed key
  * the join name is resolved via the abbreviation -> full-name map, with a
    warning + raw-abbreviation fallback when unmapped
  * a row missing lat/lon is skipped AND a warning is logged
  * load_facility_name_map loads/validates the committed map
  * the COMMITTED docs/data/facilities.json has the correct base schema and no
    status field
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import refresh_monday as rm  # noqa: E402


BASE_FIELDS = {
    "name", "address", "city", "state", "zip",
    "phone", "website", "lat", "lon", "county",
}

def _rehab_item(
    name="Doe",
    rehab_name="Doe Wildlife",
    city="Quakertown",
    address="123 Owl Ln",
    state="PA",
    zip_code="18951",
    county="Bucks",
    phone="610-555-0100",
    latitude="40.4406",
    longitude="-75.3413",
    website="https://example.org",
    availability="M/P/RVS",
    facility_name=None,
) -> dict:
    c = rm.REHAB_COL_IDS
    cols = [
        {"id": c["rehab_name"], "text": rehab_name, "value": None, "type": "text"},
        {"id": c["city"], "text": city, "value": None, "type": "text"},
        {"id": c["address"], "text": address, "value": None, "type": "text"},
        {"id": c["state"], "text": state, "value": None, "type": "text"},
        {"id": c["zip"], "text": zip_code, "value": None, "type": "text"},
        {"id": c["county"], "text": county, "value": None, "type": "text"},
        {"id": c["phone"], "text": phone, "value": None, "type": "text"},
        {"id": c["latitude"], "text": latitude, "value": None, "type": "text"},
        {"id": c["longitude"], "text": longitude, "value": None, "type": "text"},
        {"id": c["website"], "text": website, "value": None, "type": "text"},
        {"id": c["availability"], "text": availability, "value": None, "type": "text"},
    ]
    if facility_name is not None:
        cols.append({"id": c["facility_name"], "text": facility_name, "value": None, "type": "text"})
    return {
        "id": name.replace(" ", "_"),
        "name": name,
        "column_values": cols,
    }


# ---------------------------------------------------------------------------
# 1. BASE schema + join-name mapping
# ---------------------------------------------------------------------------

def test_base_record_full_schema_and_mapped_name():
    rec = rm.build_facility_record(
        _rehab_item(
            rehab_name="Adams Co",
            address="37 West King Street",
            city="Littlestown",
            state="PA",
            zip_code="17340",
            county="Adams",
            phone="7174515616",
            website="",
            latitude="39.74",
            longitude="-77.08",
        ),
        {"Adams Co": "Adams County Wildlife Care"},
    )
    assert rec == {
        "name": "Adams County Wildlife Care",
        "address": "37 West King Street",
        "city": "Littlestown",
        "state": "PA",
        "zip": "17340",
        "phone": "7174515616",
        "website": "",
        "lat": 39.74,
        "lon": -77.08,
        "county": "Adams",
    }


def test_base_record_shape_is_exactly_base_fields():
    rec = rm.build_facility_record(
        _rehab_item(rehab_name="Adams Co"),
        {"Adams Co": "Adams County Wildlife Care"},
    )
    assert set(rec.keys()) == BASE_FIELDS


def test_no_status_field_ever():
    rec = rm.build_facility_record(
        _rehab_item(rehab_name="Adams Co"),
        {"Adams Co": "Adams County Wildlife Care"},
    )
    for forbidden in ("status", "Status", "open_closed", "is_open", "is_closed", "availability"):
        assert forbidden not in rec


def test_unmapped_name_falls_back_to_abbreviation_and_warns(caplog):
    # Default Availability "M/P/RVS" is pure codes (no name), so with no owner
    # column and no map entry the join name drops to the raw abbreviation.
    with caplog.at_level("WARNING", logger="refresh_monday"):
        rec = rm.build_facility_record(_rehab_item(rehab_name="Unknown Abbr"), {})
    assert rec is not None
    assert rec["name"] == "Unknown Abbr"
    assert any("raw abbreviation" in r.message for r in caplog.records)


def test_blank_rehab_name_falls_back_to_item_name():
    rec = rm.build_facility_record(
        _rehab_item(name="Smith Item", rehab_name=""),
        {"Smith Item": "Smith Wildlife Center"},
    )
    assert rec is not None
    assert rec["name"] == "Smith Wildlife Center"


# ---------------------------------------------------------------------------
# 2. lat/lon handling
# ---------------------------------------------------------------------------

def test_lat_lon_parsed_to_float():
    rec = rm.build_facility_record(
        _rehab_item(rehab_name="Adams Co", latitude="41.12345", longitude="-77.98765"),
        {"Adams Co": "Adams County Wildlife Care"},
    )
    assert isinstance(rec["lat"], float) and isinstance(rec["lon"], float)
    assert rec["lat"] == 41.12345
    assert rec["lon"] == -77.98765


def test_missing_lat_skipped_and_warned(caplog):
    with caplog.at_level("WARNING", logger="refresh_monday"):
        rec = rm.build_facility_record(
            _rehab_item(rehab_name="Adams Co", latitude="", longitude="-75.0"),
            {"Adams Co": "Adams County Wildlife Care"},
        )
    assert rec is None
    assert any("missing/unparseable lat/lon" in r.message for r in caplog.records)


def test_build_facilities_skips_missing_and_keeps_valid():
    name_map = {"A": "Alpha Center", "Bad": "Bad Center", "B": "Beta Center"}
    items = [
        _rehab_item(rehab_name="A", latitude="40.0", longitude="-75.0"),
        _rehab_item(rehab_name="Bad", latitude="", longitude=""),
        _rehab_item(rehab_name="B", latitude="41.0", longitude="-76.0"),
    ]
    recs = rm.build_facilities(items, name_map)
    assert [r["name"] for r in recs] == ["Alpha Center", "Beta Center"]


# ---------------------------------------------------------------------------
# 3. name-map loader
# ---------------------------------------------------------------------------

def test_load_facility_name_map_reads_committed_file():
    m = rm.load_facility_name_map(ROOT)
    assert isinstance(m, dict) and m
    # Sanity: a known abbreviation maps to its full name.
    assert m.get("Adams Co") == "Adams County Wildlife Care"


def test_load_facility_name_map_missing_returns_empty(tmp_path, caplog):
    with caplog.at_level("WARNING", logger="refresh_monday"):
        m = rm.load_facility_name_map(tmp_path)
    assert m == {}
    assert any("not found" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# 3b. Option-A join-key precedence (Facility Name col -> map -> Availability -> abbr)
# ---------------------------------------------------------------------------

def test_facility_name_column_is_primary_join_key():
    # Facility Name column present + non-empty wins over BOTH the map and abbr.
    rec = rm.build_facility_record(
        _rehab_item(rehab_name="Adams Co", facility_name="Adams County Wildlife Care"),
        {"Adams Co": "WRONG MAP NAME"},
    )
    assert rec["name"] == "Adams County Wildlife Care"


def test_empty_facility_name_column_falls_back_to_map():
    # Facility Name column present but blank -> use the map.
    rec = rm.build_facility_record(
        _rehab_item(rehab_name="Adams Co", facility_name=""),
        {"Adams Co": "Adams County Wildlife Care"},
    )
    assert rec["name"] == "Adams County Wildlife Care"


def test_no_facility_name_column_uses_map():
    # Facility Name column absent on the item -> use the map.
    rec = rm.build_facility_record(
        _rehab_item(rehab_name="Adams Co"),
        {"Adams Co": "Adams County Wildlife Care"},
    )
    assert rec["name"] == "Adams County Wildlife Care"


def test_unmapped_falls_back_to_parsed_availability(caplog):
    # No Facility Name col, not in map -> parse the name out of Availability.
    with caplog.at_level("WARNING", logger="refresh_monday"):
        rec = rm.build_facility_record(
            _rehab_item(
                rehab_name="Schuylkil",
                availability="Schuylkill Wildlife Rehabilitation Center M,P,R,RA",
            ),
            {},
        )
    assert rec["name"] == "Schuylkill Wildlife Rehabilitation Center"
    assert any("parsed from Availability" in r.message for r in caplog.records)


def test_raw_abbreviation_last_resort(caplog):
    # No Facility Name col, no map, Availability has no name -> raw abbreviation.
    with caplog.at_level("WARNING", logger="refresh_monday"):
        rec = rm.build_facility_record(
            _rehab_item(rehab_name="Mystery", availability="M,P,R"),
            {},
        )
    assert rec["name"] == "Mystery"


def test_parse_facility_name_from_availability():
    p = rm.parse_facility_name_from_availability
    assert p("Schuylkill Wildlife Rehabilitation Center M,P,R,RA") == \
        "Schuylkill Wildlife Rehabilitation Center"
    assert p("Adams County Wildlife Care\nM") == "Adams County Wildlife Care"
    assert p("Pocono Wildlife Rehab Center  M P R") == "Pocono Wildlife Rehab Center"
    assert p("Centre Wildlife Care; NOTE: call first") == "Centre Wildlife Care"
    assert p("") == ""
    # All-codes (no name) collapses to empty so the caller drops to raw abbr.
    assert p("M,P,R") == ""


# ---------------------------------------------------------------------------
# 4. The COMMITTED facilities.json has the right base schema, no status
# ---------------------------------------------------------------------------

def test_committed_facilities_json_base_schema_no_status():
    path = ROOT / "docs" / "data" / "facilities.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(data, list) and data, "facilities.json is a non-empty list"
    for rec in data:
        assert set(rec.keys()) == BASE_FIELDS, f"unexpected keys in {rec.get('name')!r}"
        for forbidden in ("status", "Status", "open_closed", "is_open", "is_closed"):
            assert forbidden not in rec

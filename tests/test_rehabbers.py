"""Tests for the Phase C public rehabber dataset — fully offline.

The RehabDB Monday board is mocked; NO live network is used. Covers:
  * correct field mapping from board columns -> public record
  * lat/lon parsed to float
  * open/closed status label mapping (from the color/status column text)
  * a row missing lat/lon is skipped AND a warning is logged
  * PII-free shape: exactly the 6 public fields and nothing else
  * fetch_rehabbers issues a narrow board-level items_page query
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import refresh_monday as rm  # noqa: E402


PUBLIC_FIELDS = {"rehab_name", "lat", "lon", "county", "phone", "open_closed", "website", "availability"}


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
    open_closed="Open",
    website="https://example.org",
    availability="M/P/RVS",
) -> dict:
    """Build a raw RehabDB item with all REHAB_COL_IDS columns populated."""
    c = rm.REHAB_COL_IDS
    return {
        "id": name.replace(" ", "_"),
        "name": name,
        "column_values": [
            {"id": c["rehab_name"], "text": rehab_name, "value": None, "type": "text"},
            {"id": c["city"], "text": city, "value": None, "type": "text"},
            {"id": c["address"], "text": address, "value": None, "type": "text"},
            {"id": c["state"], "text": state, "value": None, "type": "text"},
            {"id": c["zip"], "text": zip_code, "value": None, "type": "text"},
            {"id": c["county"], "text": county, "value": None, "type": "text"},
            {"id": c["phone"], "text": phone, "value": None, "type": "text"},
            {"id": c["latitude"], "text": latitude, "value": None, "type": "text"},
            {"id": c["longitude"], "text": longitude, "value": None, "type": "text"},
            {"id": c["open_closed"], "text": open_closed, "value": None, "type": "color"},
            {"id": c["website"], "text": website, "value": None, "type": "text"},
            {"id": c["availability"], "text": availability, "value": None, "type": "text"},
        ],
    }


# ---------------------------------------------------------------------------
# 1. Field mapping
# ---------------------------------------------------------------------------

def test_field_mapping_full_record():
    rec = rm.build_rehabber_record(
        _rehab_item(
            rehab_name="Owl Haven",
            county="Bucks",
            phone="215-555-0188",
            latitude="40.5",
            longitude="-75.25",
            open_closed="Open",
            website="https://owlhaven.example",
            availability="M/P",
        )
    )
    assert rec == {
        "rehab_name": "Owl Haven",
        "lat": 40.5,
        "lon": -75.25,
        "county": "Bucks",
        "phone": "215-555-0188",
        "open_closed": "Open",
        "website": "https://owlhaven.example",
        "availability": "M/P",
    }


def test_rehab_name_falls_back_to_item_name_when_blank():
    rec = rm.build_rehabber_record(
        _rehab_item(name="Smith", rehab_name="")
    )
    assert rec is not None
    assert rec["rehab_name"] == "Smith"


# ---------------------------------------------------------------------------
# 2. lat/lon float parsing
# ---------------------------------------------------------------------------

def test_lat_lon_parsed_to_float():
    rec = rm.build_rehabber_record(
        _rehab_item(latitude="41.12345", longitude="-77.98765")
    )
    assert isinstance(rec["lat"], float)
    assert isinstance(rec["lon"], float)
    assert rec["lat"] == 41.12345
    assert rec["lon"] == -77.98765


def test_lat_lon_with_surrounding_whitespace_parsed():
    rec = rm.build_rehabber_record(
        _rehab_item(latitude="  40.0 ", longitude=" -75.0  ")
    )
    assert rec["lat"] == 40.0
    assert rec["lon"] == -75.0


# ---------------------------------------------------------------------------
# 3. open/closed label mapping
# ---------------------------------------------------------------------------

def test_open_closed_label_open():
    rec = rm.build_rehabber_record(_rehab_item(open_closed="Open"))
    assert rec["open_closed"] == "Open"


def test_open_closed_label_closed():
    rec = rm.build_rehabber_record(_rehab_item(open_closed="Closed"))
    assert rec["open_closed"] == "Closed"


def test_open_closed_blank_preserved_as_empty():
    rec = rm.build_rehabber_record(_rehab_item(open_closed=""))
    assert rec["open_closed"] == ""


# ---------------------------------------------------------------------------
# 3b. availability raw passthrough (no parsing / normalization)
# ---------------------------------------------------------------------------

def test_availability_raw_text_carried_through_verbatim():
    rec = rm.build_rehabber_record(_rehab_item(availability="M/P/RVS"))
    assert rec["availability"] == "M/P/RVS"


def test_availability_not_normalized():
    # Mixed-case / spacing preserved exactly — the dispatcher reads the letters.
    rec = rm.build_rehabber_record(_rehab_item(availability=" m / p "))
    assert rec["availability"] == "m / p"


# ---------------------------------------------------------------------------
# 3c. phone passthrough (public-org contact; verbatim; blank -> "")
# ---------------------------------------------------------------------------

def test_phone_carried_through_verbatim():
    rec = rm.build_rehabber_record(_rehab_item(phone="(610) 555-0100"))
    assert rec["phone"] == "(610) 555-0100"


def test_phone_blank_preserved_as_empty():
    rec = rm.build_rehabber_record(_rehab_item(phone=""))
    assert rec["phone"] == ""


def test_availability_blank_preserved_as_empty():
    rec = rm.build_rehabber_record(_rehab_item(availability=""))
    assert rec["availability"] == ""


# ---------------------------------------------------------------------------
# 4. Missing lat/lon -> skipped + warned
# ---------------------------------------------------------------------------

def test_missing_lat_skipped_and_warned(caplog):
    with caplog.at_level("WARNING", logger="refresh_monday"):
        rec = rm.build_rehabber_record(
            _rehab_item(rehab_name="No Lat", latitude="", longitude="-75.0")
        )
    assert rec is None
    assert any(
        "missing/unparseable lat/lon" in r.message for r in caplog.records
    )


def test_missing_lon_skipped_and_warned(caplog):
    with caplog.at_level("WARNING", logger="refresh_monday"):
        rec = rm.build_rehabber_record(
            _rehab_item(rehab_name="No Lon", latitude="40.0", longitude="")
        )
    assert rec is None
    assert any(
        "missing/unparseable lat/lon" in r.message for r in caplog.records
    )


def test_unparseable_lat_skipped_and_warned(caplog):
    with caplog.at_level("WARNING", logger="refresh_monday"):
        rec = rm.build_rehabber_record(
            _rehab_item(rehab_name="Bad Lat", latitude="not-a-number", longitude="-75.0")
        )
    assert rec is None
    assert any(
        "missing/unparseable lat/lon" in r.message for r in caplog.records
    )


def test_build_rehabbers_skips_missing_and_keeps_valid(caplog):
    items = [
        _rehab_item(rehab_name="Good A", latitude="40.0", longitude="-75.0"),
        _rehab_item(rehab_name="Bad", latitude="", longitude=""),
        _rehab_item(rehab_name="Good B", latitude="41.0", longitude="-76.0"),
    ]
    with caplog.at_level("WARNING", logger="refresh_monday"):
        recs = rm.build_rehabbers(items)
    names = [r["rehab_name"] for r in recs]
    assert names == ["Good A", "Good B"]
    assert any("missing/unparseable lat/lon" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# 5. PII-free shape: exactly the 6 public fields
# ---------------------------------------------------------------------------

def test_record_shape_is_pii_free():
    rec = rm.build_rehabber_record(
        _rehab_item(
            address="123 Secret St",
            city="Quakertown",
            state="PA",
            zip_code="18951",
        )
    )
    # Exactly the 6 public fields — no address/city/state/zip/name leakage.
    assert set(rec.keys()) == PUBLIC_FIELDS
    for forbidden in ("address", "city", "state", "zip", "name"):
        assert forbidden not in rec


def test_dataset_shape_is_pii_free():
    items = [
        _rehab_item(rehab_name="A", address="1 Private Rd", city="Foo"),
        _rehab_item(rehab_name="B", address="2 Private Rd", city="Bar"),
    ]
    recs = rm.build_rehabbers(items)
    assert len(recs) == 2
    for rec in recs:
        assert set(rec.keys()) == PUBLIC_FIELDS


# ---------------------------------------------------------------------------
# 6. fetch_rehabbers issues a narrow board-level items_page query
# ---------------------------------------------------------------------------

def test_fetch_rehabbers_narrow_query_and_mapping():
    captured: list = []
    items = [
        _rehab_item(rehab_name="Owl Haven", county="Bucks"),
        _rehab_item(rehab_name="Fox Den", county="Chester", latitude="40.0", longitude="-75.7"),
    ]

    def fake(query, variables=None, token=None, session=None, _retry=True):
        captured.append({"query": query, "variables": variables})
        return {
            "boards": [
                {"items_page": {"cursor": None, "items": items}}
            ]
        }

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        raw = rm.fetch_rehabbers(token="TEST")

    assert len(raw) == 2
    # Narrow query: filtered column_values + correct board id.
    call = captured[0]
    assert "column_values(ids: $col_ids)" in call["query"]
    assert call["variables"]["board_ids"] == [rm.REHAB_BOARD_ID]
    sent = call["variables"]["col_ids"]
    assert set(sent) == set(rm.REHAB_COL_IDS.values())
    assert len(sent) == len(rm.REHAB_COL_IDS)

    # End-to-end transform.
    recs = rm.build_rehabbers(raw)
    assert [r["rehab_name"] for r in recs] == ["Owl Haven", "Fox Den"]
    assert recs[1]["county"] == "Chester"
    assert recs[1]["lat"] == 40.0


def test_fetch_rehabbers_paginates_via_cursor():
    page1 = [_rehab_item(rehab_name="P1")]
    page2 = [_rehab_item(rehab_name="P2")]
    responses = [
        {"boards": [{"items_page": {"cursor": "next", "items": page1}}]},
        {"boards": [{"items_page": {"cursor": None, "items": page2}}]},
    ]

    def fake(query, variables=None, token=None, session=None, _retry=True):
        return responses.pop(0)

    with mock.patch.object(rm, "graphql_request", side_effect=fake):
        raw = rm.fetch_rehabbers(token="TEST")

    recs = rm.build_rehabbers(raw)
    assert [r["rehab_name"] for r in recs] == ["P1", "P2"]

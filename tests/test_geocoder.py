"""Tests for geocoder.py — fully offline, the Census API is mocked.

Covers:
  * successful geocode returns (lat, lon)
  * failed geocode (no match / HTTP error / network error) returns None + warns
  * batch_geocode_volunteers strips ALL PII (only lat/lon/roles/home_county/
    win_area + internal _addr_sig survive)
  * idempotency: a cached coord for an unchanged address is reused without
    calling the Census API again
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest import mock

import pytest
import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import geocoder  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers — fake requests.Session whose .get returns a canned response.
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, json_body, status_code=200):
        self._json = json_body
        self.status_code = status_code

    def json(self):
        if isinstance(self._json, Exception):
            raise self._json
        return self._json


class _FakeSession:
    """Stand-in for requests.Session.get with a programmable response."""

    def __init__(self, response=None, exc=None):
        self._response = response
        self._exc = exc
        self.calls = 0

    def get(self, url, params=None, timeout=None):
        self.calls += 1
        if self._exc is not None:
            raise self._exc
        return self._response


def _match_body(lat, lon):
    """A Census-shaped success body with one address match."""
    return {
        "result": {
            "addressMatches": [
                {"coordinates": {"x": lon, "y": lat}}
            ]
        }
    }


def _empty_body():
    return {"result": {"addressMatches": []}}


# ---------------------------------------------------------------------------
# 1. geocode_address — success
# ---------------------------------------------------------------------------


def test_geocode_address_success_returns_lat_lon():
    session = _FakeSession(_FakeResponse(_match_body(40.1234, -76.5678)))
    result = geocoder.geocode_address(
        "100 Main St", "Lancaster", "PA", "17601", session=session
    )
    assert result == (40.1234, -76.5678)
    assert session.calls == 1


def test_geocode_address_coordinates_coerced_to_float():
    session = _FakeSession(_FakeResponse(_match_body("41.5", "-75.5")))
    result = geocoder.geocode_address(
        "1 A St", "Scranton", "PA", "18503", session=session
    )
    assert result == (41.5, -75.5)
    assert all(isinstance(c, float) for c in result)


# ---------------------------------------------------------------------------
# 2. geocode_address — failure modes return None + warn
# ---------------------------------------------------------------------------


def test_geocode_address_no_match_returns_none_and_warns(caplog):
    session = _FakeSession(_FakeResponse(_empty_body()))
    with caplog.at_level("WARNING", logger="geocoder"):
        result = geocoder.geocode_address(
            "999 Nowhere", "Faketown", "PA", "00000", session=session
        )
    assert result is None
    assert any("No Census address match" in r.message for r in caplog.records)


def test_geocode_address_http_error_returns_none_and_warns(caplog):
    session = _FakeSession(_FakeResponse({}, status_code=500))
    with caplog.at_level("WARNING", logger="geocoder"):
        result = geocoder.geocode_address(
            "1 Main", "Erie", "PA", "16501", session=session
        )
    assert result is None
    assert any("HTTP 500" in r.message for r in caplog.records)


def test_geocode_address_network_error_returns_none_and_warns(caplog):
    session = _FakeSession(exc=requests.ConnectionError("boom"))
    with caplog.at_level("WARNING", logger="geocoder"):
        result = geocoder.geocode_address(
            "1 Main", "Erie", "PA", "16501", session=session
        )
    assert result is None
    assert any("request failed" in r.message for r in caplog.records)


def test_geocode_address_missing_street_skips_without_calling(caplog):
    session = _FakeSession(_FakeResponse(_match_body(40.0, -76.0)))
    with caplog.at_level("WARNING", logger="geocoder"):
        result = geocoder.geocode_address("", "Lancaster", "PA", "17601", session=session)
    assert result is None
    assert session.calls == 0
    assert any("missing street/city" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# 3. batch_geocode_volunteers — PII stripping
# ---------------------------------------------------------------------------


def test_batch_strips_all_pii_fields():
    volunteers = [
        {
            "name": "Jane Volunteer",
            "phone": "555-1212",
            "email": "jane@example.com",
            "street": "100 Main St",
            "city": "Lancaster",
            "state": "PA",
            "zip": "17601",
            "county": "Lancaster",
            "roles": ["C&T", "RVS"],
        }
    ]
    with mock.patch.object(
        geocoder, "geocode_address", return_value=(40.0, -76.3)
    ):
        out = geocoder.batch_geocode_volunteers(volunteers)

    assert len(out) == 1
    rec = out[0]
    # ONLY these keys allowed (plus the internal, non-PII _addr_sig and the
    # PII-free `available` boolean used for Tier 2 availability tallying).
    assert set(rec.keys()) == {
        "lat", "lon", "roles", "home_county", "win_area", "available", "_addr_sig",
    }
    # No PII leaked.
    for forbidden in ("name", "phone", "email", "street", "city", "address"):
        assert forbidden not in rec
    assert rec["lat"] == 40.0
    assert rec["lon"] == -76.3
    assert rec["roles"] == ["C&T", "RVS"]
    assert rec["home_county"] == "Lancaster"
    # available defaults to True when the input omits it (mirrors
    # DEFAULT_AVAILABLE_WHEN_BLANK).
    assert rec["available"] is True
    # win_area resolved via county_win (Lancaster is a real PA county).
    assert isinstance(rec["win_area"], str) and rec["win_area"]
    # _addr_sig must not contain the raw, human-readable street value.
    assert "100 Main St" not in rec["_addr_sig"]


def test_batch_unknown_county_yields_null_win_area():
    volunteers = [
        {
            "street": "1 A St",
            "city": "Somewhere",
            "state": "PA",
            "zip": "11111",
            "county": "NotARealCounty",
            "roles": ["Courier"],
        }
    ]
    with mock.patch.object(
        geocoder, "geocode_address", return_value=(39.0, -77.0)
    ):
        out = geocoder.batch_geocode_volunteers(volunteers)
    assert out[0]["win_area"] is None


def test_batch_skips_failed_geocode_without_aborting(caplog):
    volunteers = [
        {"street": "bad", "city": "x", "state": "PA", "zip": "1", "county": "Bucks", "roles": ["C&T"]},
        {"street": "good", "city": "Lancaster", "state": "PA", "zip": "17601", "county": "Lancaster", "roles": ["C&T"]},
    ]

    def fake_geocode(street, city, state, zip_code, session=None):
        return None if street == "bad" else (40.0, -76.3)

    with mock.patch.object(geocoder, "geocode_address", side_effect=fake_geocode):
        out = geocoder.batch_geocode_volunteers(volunteers)

    # The bad one is skipped; the batch still produces the good record.
    assert len(out) == 1
    assert out[0]["home_county"] == "Lancaster"


# ---------------------------------------------------------------------------
# 4. Idempotency — cached coord reused, no second API call
# ---------------------------------------------------------------------------


def test_batch_reuses_cached_coord_for_unchanged_address():
    volunteer = {
        "street": "100 Main St",
        "city": "Lancaster",
        "state": "PA",
        "zip": "17601",
        "county": "Lancaster",
        "roles": ["C&T"],
    }
    sig = geocoder._address_signature("100 Main St", "Lancaster", "PA", "17601")
    existing = [
        {
            "lat": 40.0,
            "lon": -76.3,
            "roles": ["C&T"],
            "home_county": "Lancaster",
            "win_area": "07",
            "_addr_sig": sig,
        }
    ]

    with mock.patch.object(geocoder, "geocode_address") as m:
        out = geocoder.batch_geocode_volunteers([volunteer], existing=existing)
        # Cached hit -> geocode_address must NOT be called.
        m.assert_not_called()

    assert len(out) == 1
    assert out[0]["lat"] == 40.0
    assert out[0]["lon"] == -76.3


def test_batch_changed_address_does_not_reuse_cache():
    volunteer = {
        "street": "200 New Ave",  # changed
        "city": "Lancaster",
        "state": "PA",
        "zip": "17601",
        "county": "Lancaster",
        "roles": ["C&T"],
    }
    old_sig = geocoder._address_signature(
        "100 Main St", "Lancaster", "PA", "17601"
    )
    existing = [
        {"lat": 40.0, "lon": -76.3, "roles": ["C&T"],
         "home_county": "Lancaster", "win_area": "07", "_addr_sig": old_sig}
    ]

    with mock.patch.object(
        geocoder, "geocode_address", return_value=(41.1, -77.7)
    ) as m:
        out = geocoder.batch_geocode_volunteers([volunteer], existing=existing)
        m.assert_called_once()

    assert out[0]["lat"] == 41.1
    assert out[0]["lon"] == -77.7


def test_address_signature_is_case_and_whitespace_insensitive():
    a = geocoder._address_signature("100 Main St", "Lancaster", "PA", "17601")
    b = geocoder._address_signature("  100 MAIN st ", "lancaster ", " pa", "17601 ")
    assert a == b


# ---------------------------------------------------------------------------
# 4. availability propagation — feeds Tier 2 available/total tally
# ---------------------------------------------------------------------------


def test_batch_propagates_available_flag_true_and_false():
    """The PII-free `available` boolean from build_geocode_input flows through
    to the coords record so the Worker can tally Tier 2 availability the same
    way Tier 1 does. Counts/ratios only — never identity."""
    volunteers = [
        {
            "street": "1 Avail St", "city": "Lancaster", "state": "PA",
            "zip": "17601", "county": "Lancaster", "roles": ["C&T"],
            "available": True,
        },
        {
            "street": "2 Busy Rd", "city": "Lancaster", "state": "PA",
            "zip": "17601", "county": "Lancaster", "roles": ["Courier"],
            "available": False,
        },
    ]
    with mock.patch.object(
        geocoder, "geocode_address", return_value=(40.0, -76.3)
    ):
        out = geocoder.batch_geocode_volunteers(volunteers)

    assert len(out) == 2
    assert out[0]["available"] is True
    assert out[1]["available"] is False
    # available is a plain boolean, never carries identity.
    for rec in out:
        assert isinstance(rec["available"], bool)

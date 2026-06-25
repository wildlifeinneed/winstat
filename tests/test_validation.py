"""Tests for the post-processing validation checks in refresh_monday.py.

Two checks are covered:

  * Check 1 — validate_record_integrity (BLOCKING): every coords record must
    carry all required fields and each field must still belong to the SAME
    volunteer (win_area consistent with home_county). Returns a list of error
    strings; the pipeline exits non-zero when non-empty.

  * Check 2 — validate_geocode_accuracy (NON-BLOCKING): reverse sanity check
    that stored coords fall inside the stated home county (point-in-polygon)
    and, optionally, that a re-geocode lands within ~1 mile. Returns warnings.

All tests are fully offline: county_win / county_pip read committed local
data, and the re-geocode path is mocked so no network calls are made.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest import mock

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import county_win  # noqa: E402
import refresh_monday as rm  # noqa: E402


# Adams County resolves to WIN area "12" (see county_win); a point near the
# Adams centroid is used for the point-in-polygon accuracy checks.
ADAMS_AREA = county_win.lookup_county("Adams").area
ADAMS_LAT, ADAMS_LON = 39.87, -77.22


def _good_record(**overrides):
    """A fully-valid Adams-County coords record; override any field."""
    rec = {
        "lat": ADAMS_LAT,
        "lon": ADAMS_LON,
        "roles": ["C&T"],
        "home_county": "Adams",
        "win_area": ADAMS_AREA,
        "available": True,
        "availability_note": "",
        "connecteam_user": True,
        "_addr_sig": "100 main|gettysburg|pa|17325",
    }
    rec.update(overrides)
    return rec


# ---------------------------------------------------------------------------
# Check 1 — record integrity
# ---------------------------------------------------------------------------

def test_integrity_passes_for_valid_records():
    errors = rm.validate_record_integrity([_good_record(), _good_record()])
    assert errors == []


def test_integrity_blank_county_is_allowed():
    # A blank home_county legitimately yields win_area=None; no area check runs.
    rec = _good_record(home_county="", win_area=None)
    assert rm.validate_record_integrity([rec]) == []


@pytest.mark.parametrize("field", list(rm.REQUIRED_COORDS_FIELDS))
def test_integrity_flags_missing_required_field(field):
    rec = _good_record()
    del rec[field]
    errors = rm.validate_record_integrity([rec])
    assert any("missing required field" in e and field in e for e in errors), (
        f"expected a missing-field error for {field!r}, got {errors!r}"
    )


@pytest.mark.parametrize("field", ["lat", "lon", "home_county", "roles", "available"])
def test_integrity_flags_none_non_nullable_field(field):
    rec = _good_record(**{field: None})
    errors = rm.validate_record_integrity([rec])
    assert any(field in e and "is None" in e for e in errors), (
        f"expected a None error for non-nullable {field!r}, got {errors!r}"
    )


@pytest.mark.parametrize("field", ["win_area", "connecteam_user"])
def test_integrity_allows_none_for_nullable_fields(field):
    # win_area / connecteam_user may be None (unknown) PROVIDED home_county is
    # blank (so the area-consistency check does not fire).
    rec = _good_record(home_county="", **{field: None})
    if field != "win_area":
        rec["win_area"] = None  # blank county => win_area must be None too
    errors = rm.validate_record_integrity([rec])
    assert errors == [], f"None should be allowed for {field!r}, got {errors!r}"


def test_integrity_flags_non_finite_coords():
    rec = _good_record(lat=float("nan"))
    errors = rm.validate_record_integrity([rec])
    assert any("not finite" in e for e in errors), errors


def test_integrity_flags_non_numeric_coords():
    rec = _good_record(lon="not-a-number")
    errors = rm.validate_record_integrity([rec])
    assert any("not numeric" in e for e in errors), errors


def test_integrity_flags_roles_not_a_list():
    rec = _good_record(roles="C&T")
    errors = rm.validate_record_integrity([rec])
    assert any("roles must be a list" in e for e in errors), errors


def test_integrity_flags_cross_volunteer_win_area_mismatch():
    # The tell-tale of field bleed: Adams coords/county stitched onto a DIFFERENT
    # volunteer's win_area. Adams resolves to area 12, so win_area '3' is wrong.
    rec = _good_record(win_area="3")
    errors = rm.validate_record_integrity([rec])
    assert any("does not match" in e and "cross-volunteer" in e for e in errors), errors


def test_integrity_flags_non_dict_record():
    errors = rm.validate_record_integrity(["not-a-dict"])
    assert any("not a dict" in e for e in errors), errors


def test_integrity_reports_every_failure_in_one_pass():
    # One good + two distinct bad records: all problems surface together so the
    # operator sees the full picture before the pipeline aborts.
    recs = [
        _good_record(),
        _good_record(win_area="99"),          # area mismatch
        _good_record(lat=None),               # missing/None coord
    ]
    errors = rm.validate_record_integrity(recs)
    assert len(errors) >= 2
    assert any("record #1" in e for e in errors)
    assert any("record #2" in e for e in errors)


# ---------------------------------------------------------------------------
# Check 2 — geocode accuracy (county match)
# ---------------------------------------------------------------------------

def test_accuracy_passes_when_coords_in_home_county():
    # Adams coords + home_county Adams => point-in-polygon agrees, no warnings.
    warnings = rm.validate_geocode_accuracy([_good_record()])
    assert warnings == []


def test_accuracy_flags_county_mismatch():
    # Adams coords but the volunteer claims a different home county => gross error.
    rec = _good_record(home_county="Lycoming", win_area=county_win.lookup_county("Lycoming").area)
    warnings = rm.validate_geocode_accuracy([rec])
    assert any("county mismatch" in w for w in warnings), warnings


def test_accuracy_reports_out_of_polygon_coords():
    # Coords far outside PA (mid-Atlantic ocean) fall in no county polygon.
    rec = _good_record(lat=10.0, lon=-40.0)
    warnings = rm.validate_geocode_accuracy([rec])
    assert any("outside every PA county polygon" in w for w in warnings), warnings


# ---------------------------------------------------------------------------
# Check 2 — geocode accuracy (re-geocode drift), network mocked
# ---------------------------------------------------------------------------

def test_accuracy_regeocode_within_tolerance_no_warning():
    rec = _good_record()
    gin = {
        "street": "100 main", "city": "gettysburg", "state": "pa", "zip": "17325",
        "roles": ["C&T"], "county": "Adams",
    }
    # Align the record's _addr_sig with the input signature.
    rec["_addr_sig"] = rm.geocoder._address_signature("100 main", "gettysburg", "pa", "17325")

    # Fresh geocode returns essentially the same point (~0 mi drift).
    with mock.patch.object(rm.geocoder, "geocode_address", return_value=(ADAMS_LAT, ADAMS_LON)):
        warnings = rm.validate_geocode_accuracy(
            [rec], geocode_inputs=[gin], re_geocode=True
        )
    assert all("re-geocode landed" not in w for w in warnings), warnings


def test_accuracy_regeocode_beyond_tolerance_warns():
    rec = _good_record()
    gin = {
        "street": "100 main", "city": "gettysburg", "state": "pa", "zip": "17325",
        "roles": ["C&T"], "county": "Adams",
    }
    rec["_addr_sig"] = rm.geocoder._address_signature("100 main", "gettysburg", "pa", "17325")

    # Fresh geocode lands ~10 miles north => exceeds the ~1 mile tolerance.
    with mock.patch.object(
        rm.geocoder, "geocode_address", return_value=(ADAMS_LAT + 0.15, ADAMS_LON)
    ):
        warnings = rm.validate_geocode_accuracy(
            [rec], geocode_inputs=[gin], re_geocode=True
        )
    assert any("re-geocode landed" in w and "tolerance" in w for w in warnings), warnings


def test_accuracy_regeocode_matches_by_signature_not_order():
    # Two records whose geocode_inputs are supplied in REVERSE order. Matching is
    # by address signature, so each record is compared against ITS OWN address —
    # re-ordering must not produce a false drift warning.
    rec_a = _good_record()
    rec_a["_addr_sig"] = rm.geocoder._address_signature("a st", "gettysburg", "pa", "17325")
    rec_b = _good_record(lat=ADAMS_LAT + 0.01, lon=ADAMS_LON + 0.01)
    rec_b["_addr_sig"] = rm.geocoder._address_signature("b st", "gettysburg", "pa", "17325")

    gin_a = {"street": "a st", "city": "gettysburg", "state": "pa", "zip": "17325", "county": "Adams", "roles": []}
    gin_b = {"street": "b st", "city": "gettysburg", "state": "pa", "zip": "17325", "county": "Adams", "roles": []}

    def fake_geocode(street, city, state, zip_code, session=None):
        # Return the stored coord for whichever address is asked for.
        return (rec_a["lat"], rec_a["lon"]) if street == "a st" else (rec_b["lat"], rec_b["lon"])

    with mock.patch.object(rm.geocoder, "geocode_address", side_effect=fake_geocode):
        warnings = rm.validate_geocode_accuracy(
            [rec_a, rec_b], geocode_inputs=[gin_b, gin_a], re_geocode=True  # reversed
        )
    assert all("re-geocode landed" not in w for w in warnings), warnings


# ---------------------------------------------------------------------------
# CLI wiring
# ---------------------------------------------------------------------------

def test_validate_flags_accepted_by_real_main_parser():
    # Prove the real main() argparse accepts --validate / --revalidate-geocode
    # by letting it parse, then short-circuiting at load_config (return 7).
    # An unrecognized flag would instead raise SystemExit(2) from argparse.
    with mock.patch.object(rm, "load_config", side_effect=rm.json.JSONDecodeError("x", "y", 0)):
        rc = rm.main(["--validate", "--revalidate-geocode", "--dry-run"])
    assert rc == 7  # reached load_config => flags parsed cleanly


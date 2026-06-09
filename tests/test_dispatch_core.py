"""Tests for dispatch_core.py — pure unit tests, fully offline (no network).

Covers Phase D:
  * haversine distance correctness vs known point pairs
  * radius filtering incl. in/out boundary
  * per-role aggregation (C&T / RVS C&T / COURIER), multi-role volunteers
  * distinct WIN-area set among in-range volunteers
  * AggregateResult is PII-FREE (no name/coord/address keys)
  * closest-rehabber selection incl. prefer-open + closed-flag
  * recommendation assembly resolves coordinators via county_win
  * radius clamp/validate (default 20, max 100)

All coordinates are KNOWN synthetic values; the DistanceProvider interface lets
us inject a deterministic stub where exact geometry would be noise.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import dispatch_core as dc  # noqa: E402
import county_win as cw  # noqa: E402


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _GridProvider(dc.DistanceProvider):
    """Deterministic stub: distance = |b_lat - a_lat| (a synthetic 'mile' axis).

    Lets us place volunteers at exact integer 'miles' along the lat axis and
    reason about radius boundaries without haversine arithmetic.
    """

    def distance_mi(self, a_lat, a_lon, b_lat, b_lon):
        return abs(float(b_lat) - float(a_lat))


def _vol(lat, roles, win_area, lon=0.0, home_county="X"):
    return {
        "lat": lat,
        "lon": lon,
        "roles": roles,
        "home_county": home_county,
        "win_area": win_area,
    }


def _rehab(name, lat, open_closed="Open", lon=0.0, website="https://x"):
    return {
        "rehab_name": name,
        "lat": lat,
        "lon": lon,
        "county": "Bucks",
        "open_closed": open_closed,
        "website": website,
    }


# ---------------------------------------------------------------------------
# 1. Haversine distance correctness vs known pairs
# ---------------------------------------------------------------------------


def test_haversine_same_point_is_zero():
    p = dc.HaversineProvider()
    assert p.distance_mi(40.0, -75.0, 40.0, -75.0) == 0.0


def test_haversine_one_degree_latitude_approx_69_miles():
    p = dc.HaversineProvider()
    # One degree of latitude is ~69 miles anywhere on Earth.
    assert p.distance_mi(0.0, 0.0, 1.0, 0.0) == pytest.approx(69.09, abs=0.1)


def test_haversine_pittsburgh_to_philadelphia():
    p = dc.HaversineProvider()
    # PGH (40.4406, -79.9959) -> PHL (39.9526, -75.1652): ~257 mi straight-line.
    d = p.distance_mi(40.4406, -79.9959, 39.9526, -75.1652)
    assert d == pytest.approx(257.13, abs=1.0)


def test_haversine_is_symmetric():
    p = dc.HaversineProvider()
    a = p.distance_mi(41.0, -77.0, 40.0, -76.0)
    b = p.distance_mi(40.0, -76.0, 41.0, -77.0)
    assert a == pytest.approx(b)


# ---------------------------------------------------------------------------
# 2. Radius filtering incl. in/out boundary
# ---------------------------------------------------------------------------


def test_radius_filter_boundary_inclusive_and_exclusive():
    # Animal at lat 0; volunteers at 5, 10 (==radius), 11 (just outside).
    dataset = [
        _vol(5.0, ["C&T"], "1"),
        _vol(10.0, ["C&T"], "2"),   # exactly on the boundary -> included
        _vol(11.0, ["C&T"], "3"),   # just outside -> excluded
    ]
    agg = dc.find_volunteers_in_radius(
        0.0, 0.0, 10.0, dataset, provider=_GridProvider()
    )
    assert agg.total_in_range == 2
    assert set(agg.win_areas) == {"1", "2"}


def test_radius_filter_skips_records_missing_coords():
    dataset = [
        _vol(2.0, ["C&T"], "1"),
        {"roles": ["C&T"], "win_area": "9"},  # no lat/lon -> skipped
    ]
    agg = dc.find_volunteers_in_radius(
        0.0, 0.0, 20.0, dataset, provider=_GridProvider()
    )
    assert agg.total_in_range == 1
    assert agg.win_areas == ["1"]


def test_empty_dataset_yields_zero_aggregate():
    agg = dc.find_volunteers_in_radius(0.0, 0.0, 20.0, [], provider=_GridProvider())
    assert agg.total_in_range == 0
    assert agg.win_areas == []
    assert agg.role_counts == {"C&T": 0, "RVS C&T": 0, "COURIER": 0}


# ---------------------------------------------------------------------------
# 3. Per-role aggregation
# ---------------------------------------------------------------------------


def test_per_role_aggregation_counts():
    dataset = [
        _vol(1.0, ["C&T"], "1"),
        _vol(2.0, ["RVS C&T"], "1"),
        _vol(3.0, ["COURIER"], "2"),
        _vol(4.0, ["C&T", "COURIER"], "2"),  # multi-role volunteer
    ]
    agg = dc.find_volunteers_in_radius(
        0.0, 0.0, 50.0, dataset, provider=_GridProvider()
    )
    assert agg.total_in_range == 4
    assert agg.role_counts["C&T"] == 2
    assert agg.role_counts["RVS C&T"] == 1
    assert agg.role_counts["COURIER"] == 2


def test_role_matching_is_case_and_space_insensitive():
    dataset = [
        _vol(1.0, ["rvs c&t"], "1"),
        _vol(2.0, ["  RVS   C&T "], "1"),
        _vol(3.0, ["courier"], "2"),
    ]
    agg = dc.find_volunteers_in_radius(
        0.0, 0.0, 50.0, dataset, provider=_GridProvider()
    )
    assert agg.role_counts["RVS C&T"] == 2
    assert agg.role_counts["COURIER"] == 1


def test_out_of_range_volunteers_do_not_count_roles():
    dataset = [
        _vol(5.0, ["C&T"], "1"),
        _vol(99.0, ["RVS C&T"], "2"),  # far outside radius
    ]
    agg = dc.find_volunteers_in_radius(
        0.0, 0.0, 10.0, dataset, provider=_GridProvider()
    )
    assert agg.total_in_range == 1
    assert agg.role_counts["C&T"] == 1
    assert agg.role_counts["RVS C&T"] == 0


# ---------------------------------------------------------------------------
# 4. Distinct WIN-area set
# ---------------------------------------------------------------------------


def test_win_area_set_is_distinct_and_sorted():
    dataset = [
        _vol(1.0, ["C&T"], "5"),
        _vol(2.0, ["C&T"], "3"),
        _vol(3.0, ["C&T"], "5"),   # duplicate area
        _vol(4.0, ["C&T"], "15N"),
    ]
    agg = dc.find_volunteers_in_radius(
        0.0, 0.0, 50.0, dataset, provider=_GridProvider()
    )
    assert agg.win_areas == ["15N", "3", "5"]


def test_win_area_blank_or_none_excluded():
    dataset = [
        _vol(1.0, ["C&T"], None),
        _vol(2.0, ["C&T"], ""),
        _vol(3.0, ["C&T"], "7"),
    ]
    agg = dc.find_volunteers_in_radius(
        0.0, 0.0, 50.0, dataset, provider=_GridProvider()
    )
    assert agg.win_areas == ["7"]
    assert agg.total_in_range == 3  # still counted, just no area contributed


# ---------------------------------------------------------------------------
# 5. AggregateResult is PII-FREE
# ---------------------------------------------------------------------------


def test_aggregate_result_has_no_pii_fields():
    dataset = [
        {
            "lat": 1.0,
            "lon": 2.0,
            "roles": ["C&T"],
            "home_county": "Bucks",
            "win_area": "8",
            "name": "Jane Doe",        # PII that MUST NOT survive aggregation
            "address": "123 Owl Ln",
        }
    ]
    agg = dc.find_volunteers_in_radius(
        0.0, 0.0, 50.0, dataset, provider=_GridProvider()
    )
    # The complete public shape: exactly these three fields.
    assert set(agg._fields) == {"total_in_range", "role_counts", "win_areas"}
    # No coordinate / address / name leakage anywhere in the result.
    flat = repr(agg)
    for forbidden in ("Jane Doe", "Owl Ln", "home_county", "lat", "lon", "address"):
        assert forbidden not in flat


# ---------------------------------------------------------------------------
# 6. Closest-rehabber selection incl. prefer-open + closed-flag
# ---------------------------------------------------------------------------


def test_closest_rehabber_picks_nearest_open():
    dataset = [
        _rehab("Far Open", 30.0, "Open"),
        _rehab("Near Open", 5.0, "Open"),
        _rehab("Nearest Closed", 1.0, "Closed"),
    ]
    res = dc.find_closest_rehabber(
        0.0, 0.0, dataset, provider=_GridProvider(), prefer_open=True
    )
    assert res is not None
    assert res.rehab_name == "Near Open"
    assert res.distance_mi == pytest.approx(5.0)
    assert res.is_closed is False


def test_closest_rehabber_flags_closed_when_no_open_available():
    dataset = [
        _rehab("Closed A", 10.0, "Closed"),
        _rehab("Closed B", 3.0, "Closed"),
    ]
    res = dc.find_closest_rehabber(
        0.0, 0.0, dataset, provider=_GridProvider(), prefer_open=True
    )
    assert res is not None
    assert res.rehab_name == "Closed B"
    assert res.is_closed is True


def test_closest_rehabber_prefer_open_false_returns_absolute_nearest():
    dataset = [
        _rehab("Open Far", 9.0, "Open"),
        _rehab("Closed Near", 2.0, "Closed"),
    ]
    res = dc.find_closest_rehabber(
        0.0, 0.0, dataset, provider=_GridProvider(), prefer_open=False
    )
    assert res.rehab_name == "Closed Near"
    assert res.is_closed is True


def test_closest_rehabber_empty_dataset_returns_none():
    assert dc.find_closest_rehabber(0.0, 0.0, [], provider=_GridProvider()) is None


def test_closest_rehabber_skips_records_without_coords():
    dataset = [
        {"rehab_name": "No Coords", "open_closed": "Open"},
        _rehab("Valid", 4.0, "Open"),
    ]
    res = dc.find_closest_rehabber(0.0, 0.0, dataset, provider=_GridProvider())
    assert res.rehab_name == "Valid"


# ---------------------------------------------------------------------------
# 7. Recommendation assembly (resolves coordinators via county_win)
# ---------------------------------------------------------------------------


def test_recommendation_resolves_coordinators_via_county_win():
    # Use a real area present in counties.xlsx so county_win resolves a name.
    agg = dc.AggregateResult(
        total_in_range=3,
        role_counts={"C&T": 2, "RVS C&T": 1, "COURIER": 0},
        win_areas=["10"],
    )
    rehab = dc.ClosestRehabber("Owl Haven", 4.2, "Open", "https://o", False)
    rec = dc.build_recommendation(agg, rehab)

    # Coordinator NAME for area 10 must match county_win's reverse lookup.
    _counties, expected_name = cw.counties_for_area("10")
    assert rec.coordinators == [expected_name]

    types = [a["type"] for a in rec.actions]
    assert "connecteam_tasking" in types
    assert "contact_coordinator" in types
    assert "transport_to_rehabber" in types
    assert "call_pgc" not in types  # qualified volunteers exist


def test_recommendation_calls_pgc_when_no_qualified_volunteers():
    agg = dc.AggregateResult(
        total_in_range=0,
        role_counts={"C&T": 0, "RVS C&T": 0, "COURIER": 0},
        win_areas=[],
    )
    rec = dc.build_recommendation(agg, None)
    types = [a["type"] for a in rec.actions]
    assert "call_pgc" in types
    assert "connecteam_tasking" not in types
    assert rec.coordinators == []
    assert rec.closest_rehabber is None


def test_recommendation_transport_action_carries_closed_flag():
    agg = dc.AggregateResult(
        total_in_range=1,
        role_counts={"C&T": 1, "RVS C&T": 0, "COURIER": 0},
        win_areas=["3"],
    )
    rehab = dc.ClosestRehabber("Last Resort", 12.0, "Closed", "https://x", True)
    rec = dc.build_recommendation(agg, rehab, coordinator_lookup=lambda areas: ["Stub Coord"])
    transport = [a for a in rec.actions if a["type"] == "transport_to_rehabber"][0]
    assert transport["is_closed"] is True
    assert transport["rehab_name"] == "Last Resort"
    assert rec.coordinators == ["Stub Coord"]


def test_recommendation_supporting_counts_mirror_aggregate():
    agg = dc.AggregateResult(
        total_in_range=2,
        role_counts={"C&T": 2, "RVS C&T": 1, "COURIER": 0},
        win_areas=["5"],
    )
    rec = dc.build_recommendation(agg, None, coordinator_lookup=lambda a: [])
    assert rec.supporting_counts == {"C&T": 2, "RVS C&T": 1, "COURIER": 0}


# ---------------------------------------------------------------------------
# 8. Radius clamp / validate (default 20, max 100)
# ---------------------------------------------------------------------------


def test_clamp_radius_default_for_none():
    assert dc.clamp_radius(None) == dc.DEFAULT_RADIUS_MI == 20.0


def test_clamp_radius_default_for_non_numeric():
    assert dc.clamp_radius("abc") == 20.0


def test_clamp_radius_caps_at_max():
    assert dc.clamp_radius(500) == dc.MAX_RADIUS_MI == 100.0


def test_clamp_radius_negative_clamps_to_zero():
    assert dc.clamp_radius(-5) == 0.0


def test_clamp_radius_passes_valid_value_through():
    assert dc.clamp_radius(35) == 35.0


def test_clamp_radius_non_finite_falls_back_to_default():
    assert dc.clamp_radius(float("inf")) == 20.0
    assert dc.clamp_radius(float("nan")) == 20.0


def test_find_volunteers_applies_radius_clamp():
    # Request a huge radius; it clamps to 100, so a volunteer at 150 'mi' is out.
    dataset = [_vol(150.0, ["C&T"], "1"), _vol(50.0, ["C&T"], "2")]
    agg = dc.find_volunteers_in_radius(
        0.0, 0.0, 9999, dataset, provider=_GridProvider()
    )
    assert agg.total_in_range == 1
    assert agg.win_areas == ["2"]

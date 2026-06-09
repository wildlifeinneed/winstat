"""Tests for county_win.py — pure data module, fully offline (no network)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import county_win as cw  # noqa: E402


# All 67 PA counties — coverage assertion source of truth.
ALL_COUNTIES = [
    "Adams", "Allegheny", "Armstrong", "Beaver", "Bedford", "Berks", "Blair",
    "Bradford", "Bucks", "Butler", "Cambria", "Cameron", "Carbon", "Centre",
    "Chester", "Clarion", "Clearfield", "Clinton", "Columbia", "Crawford",
    "Cumberland", "Dauphin", "Delaware", "Elk", "Erie", "Fayette", "Forest",
    "Franklin", "Fulton", "Greene", "Huntingdon", "Indiana", "Jefferson",
    "Juniata", "Lackawanna", "Lancaster", "Lawrence", "Lebanon", "Lehigh",
    "Luzerne", "Lycoming", "McKean", "Mercer", "Mifflin", "Monroe",
    "Montgomery", "Montour", "Northampton", "Northumberland", "Perry",
    "Philadelphia", "Pike", "Potter", "Schuylkill", "Snyder", "Somerset",
    "Sullivan", "Susquehanna", "Tioga", "Union", "Venango", "Warren",
    "Washington", "Wayne", "Westmoreland", "Wyoming", "York",
]


# ---------------------------------------------------------------------------
# 1. All-67-county coverage
# ---------------------------------------------------------------------------

def test_exactly_67_counties_loaded():
    assert len(cw._tables().forward) == 67


@pytest.mark.parametrize("county", ALL_COUNTIES)
def test_every_county_resolves_to_nonempty_area_and_coordinator(county):
    info = cw.lookup_county(county)
    assert info is not None, f"{county} failed to resolve"
    assert isinstance(info.area, str) and info.area.strip(), f"{county} has empty area"
    assert info.coordinator.strip(), f"{county} has empty coordinator"


def test_all_67_distinct_counties_in_parametrize_list():
    # Guard against an accidental duplicate/typo in ALL_COUNTIES itself.
    assert len(set(c.casefold() for c in ALL_COUNTIES)) == 67


# ---------------------------------------------------------------------------
# 2. Defensive county-name normalization (case / whitespace)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("variant", ["McKean", "mckean ", "  MCKEAN", "mcKEAN  "])
def test_county_name_normalization(variant):
    info = cw.lookup_county(variant)
    assert info is not None
    canonical = cw.lookup_county("McKean")
    assert info == canonical


# ---------------------------------------------------------------------------
# 3. 15N / 15S area is a STRING, not an int
# ---------------------------------------------------------------------------

def test_area_values_are_strings():
    for county in ALL_COUNTIES:
        info = cw.lookup_county(county)
        assert isinstance(info.area, str)


def test_split_areas_15n_15s_present_as_strings():
    all_areas = {cw.lookup_county(c).area for c in ALL_COUNTIES}
    assert "15N" in all_areas
    assert "15S" in all_areas
    # Numeric-looking areas are still strings with no float artifact.
    assert "12" in all_areas
    assert not any(a.endswith(".0") for a in all_areas)


# ---------------------------------------------------------------------------
# 4. Reverse lookup: area -> counties + coordinator
# ---------------------------------------------------------------------------

def test_reverse_lookup_returns_counties_and_coordinator():
    result = cw.counties_for_area("15N")
    assert result is not None
    counties, coordinator = result
    assert counties, "expected at least one county for area 15N"
    assert coordinator.strip()
    # Every returned county must forward-resolve back to the same area.
    for c in counties:
        assert cw.lookup_county(c).area == "15N"


def test_reverse_lookup_is_sorted():
    counties, _ = cw.counties_for_area("15N")
    assert counties == sorted(counties)


def test_reverse_lookup_unknown_area_returns_none():
    assert cw.counties_for_area("999") is None


def test_reverse_lookup_numeric_area_matches_string():
    # Passing an int should still match the string-keyed area.
    result = cw.counties_for_area(10)
    assert result is not None
    counties, _ = result
    assert "Allegheny" in counties


# ---------------------------------------------------------------------------
# 5. areas_for_counties -> DISTINCT set of WIN areas
# ---------------------------------------------------------------------------

def test_areas_for_counties_distinct_set():
    # Allegheny + Beaver share area 10; Erie is area 1 -> {"10", "1"}.
    areas = cw.areas_for_counties(["Allegheny", "Beaver", "Erie"])
    assert areas == {"10", "1"}


def test_areas_for_counties_dedups_same_area():
    areas = cw.areas_for_counties(["Allegheny", "allegheny ", "ALLEGHENY"])
    assert areas == {"10"}


def test_areas_for_counties_skips_unknown():
    areas = cw.areas_for_counties(["Erie", "Nowhereville"])
    assert areas == {"1"}


def test_areas_for_counties_empty_input():
    assert cw.areas_for_counties([]) == set()


# ---------------------------------------------------------------------------
# 6. Unknown / misspelled county path (graceful, no crash)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad", ["Nowhereville", "McKeen", "", "   ", None])
def test_unknown_county_returns_none(bad):
    assert cw.lookup_county(bad) is None


# ---------------------------------------------------------------------------
# 7. Caching: workbook is read once
# ---------------------------------------------------------------------------

def test_workbook_loaded_once_and_cached(monkeypatch):
    cw._TABLES = None  # reset cache
    calls = {"n": 0}
    real_load = cw._load

    def counting_load(*args, **kwargs):
        calls["n"] += 1
        return real_load(*args, **kwargs)

    monkeypatch.setattr(cw, "_load", counting_load)
    cw.lookup_county("Erie")
    cw.lookup_county("Allegheny")
    cw.counties_for_area("10")
    cw.areas_for_counties(["Erie", "McKean"])
    assert calls["n"] == 1


# ---------------------------------------------------------------------------
# 8. Coordinator set sanity (7 distinct coordinators per design doc)
# ---------------------------------------------------------------------------

def test_seven_distinct_coordinators():
    coordinators = {cw.lookup_county(c).coordinator for c in ALL_COUNTIES}
    assert len(coordinators) == 7

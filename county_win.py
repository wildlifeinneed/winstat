#!/usr/bin/env python3
"""
County -> WIN area lookup (Phase A of the Dispatcher address-radius feature).

Pure data module. NO network, NO Monday.com, NO PII, NO Cloudflare. Reads the
repo-root ``counties.xlsx`` once (cached) and exposes:

  1. forward lookup:  county name        -> (WIN area, coordinator name)
  2. reverse lookup:  WIN area           -> ([counties...], coordinator name)
  3. distinct-areas:  iterable of counties -> distinct set of WIN areas

counties.xlsx columns (cols A-C): ``county`` / ``area`` / ``coordinator``.
All 67 PA counties map to exactly ONE WIN area. ``area`` is treated as a STRING
(values include split codes like ``"15N"`` / ``"15S"``). ``coordinator`` is a
NAME only (no contact info).

County names are normalized defensively (case + surrounding whitespace) so that
``"McKean"``, ``"mckean "`` and ``"MCKEAN"`` all resolve. Unknown / misspelled
counties resolve to ``None`` (no exception).
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, Iterable, List, NamedTuple, Optional, Set, Tuple

import openpyxl

# Repo-root counties.xlsx (this module lives at the repo root).
XLSX_PATH = Path(__file__).resolve().parent / "counties.xlsx"

# Column titles expected in row 1 (cols A-C). If the real file differs, loading
# raises a clear error rather than silently guessing.
COL_COUNTY = "county"
COL_AREA = "area"
COL_COORDINATOR = "coordinator"


class CountyInfo(NamedTuple):
    """Forward-lookup result for a single county."""

    area: str
    coordinator: str


class _Tables(NamedTuple):
    """Everything derived from a single read of counties.xlsx."""

    # normalized county key -> CountyInfo(area, coordinator)
    forward: Dict[str, CountyInfo]
    # normalized county key -> original-cased county name (for reverse output)
    display: Dict[str, str]


# Single cached load of the workbook. Populated once on first access.
_TABLES: Optional[_Tables] = None


def _normalize(county: str) -> str:
    """Case- and whitespace-insensitive normalization key for a county name."""
    return str(county).strip().casefold()


def _coerce_area(area_raw) -> str:
    """Treat area as a STRING ('15N'/'15S'); avoid int->'12.0' artifacts."""
    if isinstance(area_raw, float) and area_raw.is_integer():
        return str(int(area_raw))
    return str(area_raw).strip()


def _load(path: Path = XLSX_PATH) -> _Tables:
    """Read counties.xlsx (cols A-C) once into forward + display tables.

    Raises ValueError if the header columns are not county/area/coordinator.
    """
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        ws = wb.active
        rows = ws.iter_rows(values_only=True)

        try:
            header = next(rows)
        except StopIteration:
            raise ValueError(f"{path} is empty (no header row).")

        cols = [str(c).strip().casefold() if c is not None else "" for c in header[:3]]
        expected = [COL_COUNTY, COL_AREA, COL_COORDINATOR]
        if cols != expected:
            raise ValueError(
                f"{path} columns A-C are {cols!r}; expected {expected!r}. "
                "Refusing to guess — verify the spreadsheet layout."
            )

        forward: Dict[str, CountyInfo] = {}
        display: Dict[str, str] = {}
        for row in rows:
            if not row or row[0] in (None, ""):
                continue
            county = str(row[0]).strip()
            area = _coerce_area(row[1])
            coordinator = str(row[2]).strip() if row[2] is not None else ""

            key = _normalize(county)
            forward[key] = CountyInfo(area=area, coordinator=coordinator)
            display[key] = county

        return _Tables(forward=forward, display=display)
    finally:
        wb.close()


def _tables() -> _Tables:
    """Return the cached tables, loading the workbook on first use only."""
    global _TABLES
    if _TABLES is None:
        _TABLES = _load()
    return _TABLES


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def lookup_county(county: str) -> Optional[CountyInfo]:
    """Forward lookup: county name -> CountyInfo(area, coordinator).

    Returns None for an unknown / misspelled county (never raises on miss).
    """
    if county is None:
        return None
    return _tables().forward.get(_normalize(county))


def counties_for_area(area: str) -> Optional[Tuple[List[str], str]]:
    """Reverse lookup: WIN area -> (sorted list of counties, coordinator name).

    ``area`` is matched as a string ("15N", "10", ...). Returns None if no
    county maps to the given area.
    """
    if area is None:
        return None
    target = str(area).strip()
    tables = _tables()

    counties: List[str] = []
    coordinator = ""
    for key, info in tables.forward.items():
        if info.area == target:
            counties.append(tables.display[key])
            coordinator = info.coordinator

    if not counties:
        return None
    return sorted(counties), coordinator


def areas_for_counties(counties: Iterable[str]) -> Set[str]:
    """Helper: iterable of county names -> DISTINCT set of WIN areas.

    Unknown counties are skipped (they contribute no area). This is what the
    recommendation engine uses to say e.g. "task WIN areas 03 and 05".
    """
    areas: Set[str] = set()
    for county in counties:
        info = lookup_county(county)
        if info is not None:
            areas.add(info.area)
    return areas

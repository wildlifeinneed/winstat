#!/usr/bin/env python3
"""
County -> WIN area lookup (Phase A of the Dispatcher address-radius feature).

Mostly-pure data module. NO network, NO Monday.com, NO PII, NO Cloudflare.
Reads the repo-root ``counties.xlsx`` once (cached) and exposes:

  1. forward lookup:  county name        -> (WIN area, coordinator name)
  2. reverse lookup:  WIN area           -> ([counties...], coordinator name)
  3. distinct-areas:  iterable of counties -> distinct set of WIN areas

counties.xlsx columns (cols A-C): ``county`` / ``area`` / ``coordinator``.
All 67 PA counties map to exactly ONE WIN area. ``area`` is treated as a STRING
(values include split codes like ``"15N"`` / ``"15S"``). ``coordinator`` is a
NAME only (no contact info).

Coordinator-NAME precedence (area -> name resolution):
  1. ``docs/data/coordinators.json`` (refreshed from the Area Coordinators
     Monday board) when the file is present AND contains the area. This lets a
     coordinator rename flow through the normal refresh without editing the
     spreadsheet.
  2. The ``coordinator`` column in ``counties.xlsx`` otherwise (stable
     fallback). If the override file is absent, malformed, or simply missing
     an area, resolution silently falls back to the spreadsheet — this module
     NEVER crashes because the board file isn't there.

The county->area MAP itself always comes from the spreadsheet (stable). Only
the coordinator NAME is overridable. ``lookup_county`` / ``counties_for_area``
return shapes are UNCHANGED (still ``CountyInfo(area, coordinator)``).

County names are normalized defensively (case + surrounding whitespace) so that
``"McKean"``, ``"mckean "`` and ``"MCKEAN"`` all resolve. Unknown / misspelled
counties resolve to ``None`` (no exception).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Iterable, List, NamedTuple, Optional, Set, Tuple

import openpyxl

# Repo-root counties.xlsx (this module lives at the repo root).
XLSX_PATH = Path(__file__).resolve().parent / "counties.xlsx"

# Area-coordinator NAME override, refreshed from the Area Coordinators Monday
# board by refresh_monday.py. A JSON object mapping area-string -> coordinator
# name. Public-safe (phone excluded at the source). Optional: when absent we
# fall back to the spreadsheet coordinator column.
COORDINATORS_JSON_PATH = (
    Path(__file__).resolve().parent / "docs" / "data" / "coordinators.json"
)

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

# Cached area -> coordinator-name override loaded from coordinators.json.
# Sentinel (not-yet-loaded) is None; an empty/absent file caches as {} so we
# don't re-stat the disk on every lookup.
_COORD_OVERRIDE: Optional[Dict[str, str]] = None


def _load_coordinator_override(
    path: Optional[Path] = None,
) -> Dict[str, str]:
    """Load the area -> coordinator-name override from coordinators.json.

    Graceful by design: returns an empty dict if the file is absent, empty,
    malformed, or not a JSON object. NEVER raises — a missing/broken board
    file must simply fall back to the spreadsheet, never crash the lookup.
    Only string area -> string name pairs are kept. ``path`` defaults to the
    module-level ``COORDINATORS_JSON_PATH`` resolved at call time (so tests can
    monkeypatch the constant).
    """
    if path is None:
        path = COORDINATORS_JSON_PATH
    try:
        if not path.exists():
            return {}
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, str] = {}
    for area, name in raw.items():
        if isinstance(area, str) and isinstance(name, str) and name.strip():
            out[area] = name.strip()
    return out


def _coord_override() -> Dict[str, str]:
    """Return the cached coordinator-name override, loading it on first use."""
    global _COORD_OVERRIDE
    if _COORD_OVERRIDE is None:
        _COORD_OVERRIDE = _load_coordinator_override()
    return _COORD_OVERRIDE


def _coordinator_for_area(area: str, fallback: str) -> str:
    """Resolve the coordinator NAME for an area, preferring the override.

    Precedence: coordinators.json[area] when present, else the spreadsheet
    ``fallback`` (the counties.xlsx coordinator column value).
    """
    return _coord_override().get(area, fallback)


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

    The coordinator NAME prefers the coordinators.json override (keyed by WIN
    area) and falls back to the spreadsheet coordinator column. Returns None
    for an unknown / misspelled county (never raises on miss).
    """
    if county is None:
        return None
    info = _tables().forward.get(_normalize(county))
    if info is None:
        return None
    coordinator = _coordinator_for_area(info.area, info.coordinator)
    if coordinator == info.coordinator:
        return info
    return CountyInfo(area=info.area, coordinator=coordinator)


def counties_for_area(area: str) -> Optional[Tuple[List[str], str]]:
    """Reverse lookup: WIN area -> (sorted list of counties, coordinator name).

    The coordinator NAME prefers the coordinators.json override (keyed by WIN
    area) and falls back to the spreadsheet coordinator column. ``area`` is
    matched as a string ("15N", "10", ...). Returns None if no county maps to
    the given area.
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
    coordinator = _coordinator_for_area(target, coordinator)
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

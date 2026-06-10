#!/usr/bin/env python3
"""
Point-in-polygon county lookup for PA volunteer home-county derivation.

Loads docs/data/pa_counties.json (GeoJSON FeatureCollection, 67 PA counties)
once at import time and exposes a single function::

    lookup_latlon(lat, lon) -> Optional[Dict[str, str]]

Returns {"county": "Lycoming", "win_area": "9"} for a point inside Lycoming
County, or None if the point does not fall inside any PA county polygon.

Uses a pure-Python ray-casting algorithm (no shapely dependency).
Handles both Polygon and MultiPolygon geometry types (Chester is the only
MultiPolygon in the 67-county dataset).

Holes (interior rings) are checked: a point inside a hole is outside the
polygon, per GeoJSON spec.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("county_pip")

# Resolve relative to this module's location (repo root).
_GEOJSON_PATH = (
    Path(__file__).resolve().parent / "docs" / "data" / "pa_counties.json"
)


# ---------------------------------------------------------------------------
# Ray-casting helpers
# ---------------------------------------------------------------------------


def _ray_cast(lon: float, lat: float, ring: List[Tuple[float, float]]) -> bool:
    """Return True if (lon, lat) is inside the polygon ring via ray casting.

    ``ring`` is a list of (lon, lat) vertex tuples (GeoJSON coordinate order).
    The last vertex may or may not repeat the first — both cases are handled.
    """
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (
            yj - yi
        ) + xi:
            inside = not inside
        j = i
    return inside


def _point_in_polygon(lon: float, lat: float, geom: Dict[str, Any]) -> bool:
    """Return True if (lon, lat) is inside the GeoJSON geometry.

    Supports ``Polygon`` and ``MultiPolygon`` types.

    For Polygon: exterior ring (index 0) must contain the point and NO hole
    ring (indices 1+) may contain the point.

    For MultiPolygon: True if the point is inside ANY sub-polygon (exterior
    contains + not in any hole).
    """
    gtype = geom.get("type")
    coords = geom.get("coordinates") or []

    if gtype == "Polygon":
        if not coords:
            return False
        exterior = [(c[0], c[1]) for c in coords[0]]
        if not _ray_cast(lon, lat, exterior):
            return False
        for hole_ring in coords[1:]:
            hole = [(c[0], c[1]) for c in hole_ring]
            if _ray_cast(lon, lat, hole):
                return False
        return True

    elif gtype == "MultiPolygon":
        for poly_coords in coords:
            if not poly_coords:
                continue
            exterior = [(c[0], c[1]) for c in poly_coords[0]]
            if not _ray_cast(lon, lat, exterior):
                continue
            in_hole = False
            for hole_ring in poly_coords[1:]:
                hole = [(c[0], c[1]) for c in hole_ring]
                if _ray_cast(lon, lat, hole):
                    in_hole = True
                    break
            if not in_hole:
                return True
        return False

    else:
        logger.warning("Unsupported geometry type: %s", gtype)
        return False


# ---------------------------------------------------------------------------
# Module-level cache: load GeoJSON once.
# ---------------------------------------------------------------------------

_features: Optional[List[Dict[str, Any]]] = None


def _load_features() -> List[Dict[str, Any]]:
    global _features
    if _features is not None:
        return _features
    try:
        with open(_GEOJSON_PATH, encoding="utf-8") as f:
            data = json.load(f)
        _features = data.get("features") or []
        logger.debug(
            "Loaded %d county features from %s", len(_features), _GEOJSON_PATH
        )
    except Exception as exc:
        logger.error("Failed to load pa_counties.json: %s", exc)
        _features = []
    return _features


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def lookup_latlon(lat: float, lon: float) -> Optional[Dict[str, str]]:
    """Return {county, win_area} for the PA county containing (lat, lon).

    Returns None if the point does not fall inside any county polygon (e.g.
    border edge effects or a point outside PA).

    GeoJSON coordinates are (lon, lat); this function accepts (lat, lon) in
    the conventional geographic order and inverts internally.
    """
    features = _load_features()
    for feature in features:
        geom = feature.get("geometry") or {}
        if _point_in_polygon(lon, lat, geom):
            props = feature.get("properties") or {}
            return {
                "county": props.get("county") or "",
                "win_area": props.get("win_area") or "",
            }
    return None

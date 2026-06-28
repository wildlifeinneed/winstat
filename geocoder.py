#!/usr/bin/env python3
"""
Volunteer address geocoding (Phase B of the Dispatcher address-radius feature).

Takes the 4 address columns pulled from Monday.com (street/city/state/zip),
geocodes them to (lat, lon) via the free, keyless US Census Geocoding API, and
produces a PRIVATE coords dataset that is NEVER committed to the public repo.

PII rules (hard):
  * The emitted records contain ONLY {lat, lon, roles, home_county, win_area,
    available}. NO name, NO address string, NO phone, NO email.
  * The caller (refresh_monday.py) is responsible for writing the result to a
    gitignored path (e.g. data/volunteer_coords.json) — this module never
    writes any file itself.

``win_area`` is resolved from ``home_county`` via county_win.lookup_county()
(Phase A). Unknown counties resolve to win_area=None (no exception).

Idempotency: ``batch_geocode_volunteers`` accepts the previously-written output
records and reuses a cached (lat, lon) when the volunteer's address signature is
unchanged, so re-runs don't hammer the Census API for addresses we already
geocoded.

Graceful failure: a geocode miss / network error for one volunteer logs a
warning and skips that volunteer (no coords emitted); it never aborts the batch.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

import requests

import county_win

logger = logging.getLogger("geocoder")

# US Census one-line/structured address geocoder — free, no API key required.
CENSUS_GEOCODER_URL = (
    "https://geocoding.geo.census.gov/geocoder/locations/address"
)
CENSUS_BENCHMARK = "Public_AR_Current"
GEOCODE_TIMEOUT = 30


def _address_signature(
    street: str, city: str, state: str, zip_code: str
) -> str:
    """Stable, case/whitespace-insensitive key for an address.

    Used to decide whether a cached coordinate can be reused on re-run.
    """
    parts = [
        str(street or "").strip().casefold(),
        str(city or "").strip().casefold(),
        str(state or "").strip().casefold(),
        str(zip_code or "").strip().casefold(),
    ]
    return "|".join(parts)


def geocode_address(
    street: str,
    city: str,
    state: str,
    zip_code: str,
    session: Optional[requests.Session] = None,
) -> Optional[Tuple[float, float]]:
    """Geocode a structured US address to ``(lat, lon)`` via the Census API.

    Returns ``None`` (never raises) if the address can't be geocoded — no
    match, malformed response, or any network/HTTP error. The caller logs +
    skips on None so a single bad address never aborts a batch.
    """
    if not str(street or "").strip() or not str(city or "").strip():
        logger.warning(
            "Skipping geocode: missing street/city (street=%r city=%r)",
            street,
            city,
        )
        return None

    session = session or requests.Session()
    params = {
        "street": str(street).strip(),
        "city": str(city).strip(),
        "state": str(state or "").strip(),
        "zip": str(zip_code or "").strip(),
        "benchmark": CENSUS_BENCHMARK,
        "format": "json",
    }

    try:
        resp = session.get(
            CENSUS_GEOCODER_URL, params=params, timeout=GEOCODE_TIMEOUT
        )
    except requests.RequestException as exc:
        logger.warning("Census geocode request failed: %s", exc)
        return None

    if resp.status_code >= 400:
        logger.warning(
            "Census geocode HTTP %s for city=%r zip=%r",
            resp.status_code,
            city,
            zip_code,
        )
        return None

    try:
        body = resp.json()
    except ValueError as exc:
        logger.warning("Census geocode returned non-JSON: %s", exc)
        return None

    matches = (
        (body.get("result") or {}).get("addressMatches") or []
        if isinstance(body, dict)
        else []
    )
    if not matches:
        logger.warning(
            "No Census address match for city=%r state=%r zip=%r",
            city,
            state,
            zip_code,
        )
        return None

    coords = (matches[0] or {}).get("coordinates") or {}
    lat = coords.get("y")
    lon = coords.get("x")
    if lat is None or lon is None:
        logger.warning(
            "Census match missing coordinates for city=%r zip=%r",
            city,
            zip_code,
        )
        return None

    try:
        return float(lat), float(lon)
    except (TypeError, ValueError) as exc:
        logger.warning("Census coordinates not numeric (%r, %r): %s", lat, lon, exc)
        return None


def _coords_by_signature(
    existing: Optional[List[Dict[str, Any]]],
) -> Dict[str, Tuple[float, float]]:
    """Index previously-written records by their address signature.

    Existing records are expected to carry an ``_addr_sig`` field (written by
    this module on the prior run) plus ``lat``/``lon``. Records missing the
    signature or coords are ignored (they simply won't be reused).
    """
    cache: Dict[str, Tuple[float, float]] = {}
    for rec in existing or []:
        if not isinstance(rec, dict):
            continue
        sig = rec.get("_addr_sig")
        lat = rec.get("lat")
        lon = rec.get("lon")
        if sig and lat is not None and lon is not None:
            try:
                cache[str(sig)] = (float(lat), float(lon))
            except (TypeError, ValueError):
                continue
    return cache


def batch_geocode_volunteers(
    volunteers: List[Dict[str, Any]],
    existing: Optional[List[Dict[str, Any]]] = None,
    session: Optional[requests.Session] = None,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    """Geocode a list of volunteer dicts into the PRIVATE coords dataset.

    Each input volunteer dict is expected to carry the address fields
    ``street`` / ``city`` / ``state`` / ``zip`` plus ``roles`` and
    ``county`` (home county).  An optional ``name`` field (the volunteer's
    display name from Monday.com) is used only for failure reporting — it is
    NEVER propagated to the output coords records.

    Output records contain ONLY::

        {lat, lon, roles, home_county, win_area, available, _addr_sig}

    NO name, NO address string, NO phone, NO email is propagated. ``_addr_sig``
    is an internal, non-PII hash of the address used purely for idempotent
    re-runs; it is not the address itself.

    Idempotency: when ``existing`` (the prior output records) is supplied and a
    volunteer's address signature matches a previously geocoded record, the
    cached ``(lat, lon)`` is reused instead of calling the Census API again.

    Graceful: any volunteer that can't be geocoded (and has no cached coord) is
    logged and skipped — the batch always completes.

    Returns a ``(coords, failures)`` tuple where ``failures`` is a list of
    ``{"name": ..., "address": ..., "reason": ...}`` dicts for every
    volunteer whose geocode failed (no cached coord and Census returned no
    match / errored).
    """
    session = session or requests.Session()
    cache = _coords_by_signature(existing)

    out: List[Dict[str, Any]] = []
    failures: List[Dict[str, str]] = []
    for v in volunteers:
        if not isinstance(v, dict):
            continue
        street = v.get("street", "")
        city = v.get("city", "")
        state = v.get("state", "")
        zip_code = v.get("zip", "")

        sig = _address_signature(street, city, state, zip_code)

        coord = cache.get(sig)
        if coord is not None:
            logger.debug("Reusing cached coord for signature %s", sig)
        else:
            coord = geocode_address(
                street, city, state, zip_code, session=session
            )
            if coord is None:
                # geocode_address already logged the reason; skip this one.
                # Record the failure with the volunteer name for reporting.
                vol_name = v.get("name", "")
                addr_parts = [
                    str(street or "").strip(),
                    str(city or "").strip(),
                    str(state or "").strip(),
                    str(zip_code or "").strip(),
                ]
                addr_display = ", ".join(p for p in addr_parts if p)
                reason = "No Census address match"
                if not str(street or "").strip() or not str(city or "").strip():
                    reason = "Missing street or city"
                failures.append({
                    "name": vol_name,
                    "address": addr_display,
                    "reason": reason,
                })
                continue

        lat, lon = coord
        home_county = (v.get("county") or "").strip()
        info = county_win.lookup_county(home_county) if home_county else None
        win_area = info.area if info is not None else None

        out.append(
            {
                "lat": lat,
                "lon": lon,
                "roles": list(v.get("roles") or []),
                "home_county": home_county,
                "win_area": win_area,
                # PII-free availability flag (boolean) so the Worker can tally
                # Tier 2 availability the SAME way Tier 1 does. Computed upstream
                # by build_geocode_input via the shared is_available() rule;
                # defaults to True when absent (mirrors DEFAULT_AVAILABLE_WHEN_BLANK).
                "available": bool(v.get("available", True)),
                "availability_note": v.get("availability_text", ""),
                # PII-free Connecteam-membership flag (group_title == 'users'),
                # carried through from build_geocode_input so the Worker can
                # tell genuine non-Connecteam volunteers apart from "unknown".
                # Pass through as-is (True/False/None) — None means unknown and
                # the Worker treats it as such (never flagged in the banner).
                "connecteam_user": v.get("connecteam_user"),
                # Monitored WIN areas from Monday.com — list of area number
                # strings the volunteer actively monitors (may include areas
                # outside their home county). PII-free, carried through to KV.
                "monitored_areas": v.get("monitored_areas") or [],
                "_addr_sig": sig,
            }
        )

    logger.info(
        "Geocoded %d/%d volunteers into private coords dataset",
        len(out),
        len(volunteers),
    )
    if failures:
        logger.warning(
            "%d volunteer(s) failed geocoding", len(failures),
        )
    return out, failures

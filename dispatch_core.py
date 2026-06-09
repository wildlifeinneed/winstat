#!/usr/bin/env python3
"""
Distance + recommendation core (Phase D of the Dispatcher address-radius feature).

PURE LOGIC module. NO network, NO Monday.com, NO Cloudflare, NO file I/O of the
private coords dataset. Everything operates on in-memory datasets passed by the
caller. The only cross-module dependency is ``county_win`` (Phase A) for the
area -> coordinator NAME resolution, which is itself a mostly-pure data module.

What lives here:

  1. ``DistanceProvider`` (abstract) + ``HaversineProvider`` (straight-line
     miles). The interface is intentionally minimal -- ``distance_mi(a_lat,
     a_lon, b_lat, b_lon) -> float`` -- so a driving-distance provider (OSRM,
     Phase H) can drop in behind the SAME interface later.

  2. ``find_volunteers_in_radius`` -> ``AggregateResult``. Filters the PRIVATE
     in-memory volunteer-coords dataset to those within ``radius_mi`` of the
     animal and returns AGGREGATE-ONLY counts. NO names, NO coords, NO
     addresses ever appear in the result (hard PII rule).

  3. ``find_closest_rehabber`` -> ``ClosestRehabber``. Rehabber data is
     PUBLIC-safe (the served facilities page already surfaces it), so the
     nearest facility NAME + distance + open/closed + website MAY be returned.

  4. ``build_recommendation`` -> ``RecommendationResult``. Synthesizes the
     dispatcher-facing actions (Connecteam tasking to the present WIN areas,
     contact the Area coordinator NAME(s), call PGC when the pool is empty,
     transport to the closest open rehabber). Output is STRUCTURED fields, not
     free prose. Coordinator NAME only (phone is excluded project-wide).

Radius policy: default 20 mi, hard max 100 mi. ``clamp_radius`` validates +
clamps a requested radius into ``[0, MAX_RADIUS_MI]`` and substitutes the
default for a missing/invalid value.

Volunteer roles: the private record carries a ``roles`` list. We bucket each
in-range volunteer into exactly the role labels it declares among the three
qualifying capabilities -- ``C&T`` / ``RVS C&T`` / ``COURIER`` -- using a
defensive, case/separator-insensitive match (so ``"rvs c&t"`` and ``"RVS C&T"``
both count). A single volunteer can contribute to multiple role counts.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from typing import (
    Any,
    Dict,
    Iterable,
    List,
    NamedTuple,
    Optional,
    Sequence,
    Set,
)

import county_win

# ---------------------------------------------------------------------------
# Radius policy
# ---------------------------------------------------------------------------

DEFAULT_RADIUS_MI: float = 20.0
MAX_RADIUS_MI: float = 100.0

# Mean Earth radius in miles (used by the haversine formula).
EARTH_RADIUS_MI: float = 3958.7613


# Canonical qualifying role labels, in the order they should appear in output.
ROLE_CT = "C&T"
ROLE_RVS_CT = "RVS C&T"
ROLE_COURIER = "COURIER"
QUALIFYING_ROLES = (ROLE_CT, ROLE_RVS_CT, ROLE_COURIER)


def clamp_radius(radius_mi: Optional[float]) -> float:
    """Validate + clamp a requested radius into ``[0, MAX_RADIUS_MI]``.

    A ``None`` / non-numeric / non-finite request falls back to
    ``DEFAULT_RADIUS_MI``. A negative request clamps to ``0`` (matches nothing
    rather than erroring). A request above the cap clamps to ``MAX_RADIUS_MI``.
    Never raises -- a bad radius must degrade gracefully, not crash dispatch.
    """
    if radius_mi is None:
        return DEFAULT_RADIUS_MI
    try:
        value = float(radius_mi)
    except (TypeError, ValueError):
        return DEFAULT_RADIUS_MI
    if not math.isfinite(value):
        return DEFAULT_RADIUS_MI
    if value < 0:
        return 0.0
    if value > MAX_RADIUS_MI:
        return MAX_RADIUS_MI
    return value


# ---------------------------------------------------------------------------
# Distance provider interface
# ---------------------------------------------------------------------------


class DistanceProvider(ABC):
    """Abstract straight-line/driving distance provider.

    Implementations return distance in MILES between two (lat, lon) points.
    Keeping the surface tiny lets an OSRM driving-distance provider (Phase H)
    implement the same method and drop in wherever a ``HaversineProvider`` is
    used today.
    """

    @abstractmethod
    def distance_mi(
        self, a_lat: float, a_lon: float, b_lat: float, b_lon: float
    ) -> float:
        """Return distance in miles between points A and B."""
        raise NotImplementedError


class HaversineProvider(DistanceProvider):
    """Great-circle (straight-line) distance in miles via the haversine formula.

    Always available, no network, no egress -- this is the guaranteed fallback
    metric described in the design doc (§4b). Distances are approximate
    straight-line miles, NOT driving miles.
    """

    def distance_mi(
        self, a_lat: float, a_lon: float, b_lat: float, b_lon: float
    ) -> float:
        lat1 = math.radians(float(a_lat))
        lat2 = math.radians(float(b_lat))
        dlat = lat2 - lat1
        dlon = math.radians(float(b_lon) - float(a_lon))
        h = (
            math.sin(dlat / 2.0) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2.0) ** 2
        )
        c = 2.0 * math.asin(min(1.0, math.sqrt(h)))
        return EARTH_RADIUS_MI * c


# A module-level default instance so callers don't have to construct one.
_DEFAULT_PROVIDER = HaversineProvider()


# ---------------------------------------------------------------------------
# Result shapes
# ---------------------------------------------------------------------------


class AggregateResult(NamedTuple):
    """PII-FREE aggregate of the volunteers within radius.

    Contains ONLY counts + the set of WIN areas present + the total in-range
    count. By construction there are NO names, NO coordinates, NO addresses,
    NO per-volunteer rows here -- the fields below are the COMPLETE public
    shape, and the unit tests assert no PII keys ever leak.

    ``role_counts`` maps each qualifying role label (``C&T`` / ``RVS C&T`` /
    ``COURIER``) to the number of in-range volunteers declaring it (a volunteer
    may count toward more than one role). ``win_areas`` is the sorted list of
    distinct WIN areas among the in-range volunteers' home counties.
    """

    total_in_range: int
    role_counts: Dict[str, int]
    win_areas: List[str]


class ClosestRehabber(NamedTuple):
    """Nearest rehabber result -- PUBLIC-safe (facility data is public).

    ``is_closed`` flags that the nearest reported facility is NOT open (either
    explicitly "Closed" or a blank/unknown status) so the caller can warn while
    still surfacing it. When no rehabber dataset is usable, ``find_closest_
    rehabber`` returns ``None`` instead of this tuple.
    """

    rehab_name: str
    distance_mi: float
    open_closed: str
    website: str
    is_closed: bool


class RecommendationResult(NamedTuple):
    """Structured dispatcher-facing recommendation (NOT free prose).

    ``actions`` is an ordered list of structured action dicts (each with a
    stable ``type`` plus type-specific fields). ``supporting_counts`` echoes
    the aggregate counts that justify the actions. ``win_areas`` / ``coordinators``
    are the present areas and their resolved coordinator NAMES (name only -- no
    phone). ``closest_rehabber`` mirrors the ``ClosestRehabber`` fields (or
    ``None``).
    """

    actions: List[Dict[str, Any]]
    supporting_counts: Dict[str, int]
    win_areas: List[str]
    coordinators: List[str]
    closest_rehabber: Optional[Dict[str, Any]]


# ---------------------------------------------------------------------------
# Role matching (defensive)
# ---------------------------------------------------------------------------


def _normalize_role(role: Any) -> str:
    """Collapse a role label to a comparison key (lowercase, no spaces)."""
    return "".join(str(role).split()).casefold()


# Precomputed comparison keys for the qualifying roles.
_ROLE_KEYS = {
    ROLE_CT: _normalize_role(ROLE_CT),
    ROLE_RVS_CT: _normalize_role(ROLE_RVS_CT),
    ROLE_COURIER: _normalize_role(ROLE_COURIER),
}


def _roles_of(volunteer: Dict[str, Any]) -> Set[str]:
    """Return the set of canonical qualifying roles a volunteer declares."""
    declared = volunteer.get("roles") or []
    if isinstance(declared, (str, bytes)):
        declared = [declared]
    declared_keys = {_normalize_role(r) for r in declared}
    matched: Set[str] = set()
    for canonical, key in _ROLE_KEYS.items():
        if key in declared_keys:
            matched.add(canonical)
    return matched


# ---------------------------------------------------------------------------
# Core operations
# ---------------------------------------------------------------------------


def find_volunteers_in_radius(
    animal_lat: float,
    animal_lon: float,
    radius_mi: Optional[float],
    coords_dataset: Sequence[Dict[str, Any]],
    provider: Optional[DistanceProvider] = None,
) -> AggregateResult:
    """Aggregate the volunteers within ``radius_mi`` straight-line of the animal.

    ``coords_dataset`` is the PRIVATE in-memory volunteer-coords dataset
    (records shaped ``{lat, lon, roles, home_county, win_area, ...}``). It is
    passed in by the trusted caller; this function never reads it from disk.

    Returns an :class:`AggregateResult` containing ONLY counts, the distinct
    set of in-range WIN areas, and the total in-range count. NO names, NO
    coords, NO addresses are returned -- this is the PII boundary.

    ``radius_mi`` is validated/clamped via :func:`clamp_radius` (default 20,
    max 100). Records missing/invalid lat or lon are skipped defensively.
    """
    provider = provider or _DEFAULT_PROVIDER
    radius = clamp_radius(radius_mi)

    role_counts: Dict[str, int] = {role: 0 for role in QUALIFYING_ROLES}
    win_areas: Set[str] = set()
    total = 0

    for rec in coords_dataset or ():
        if not isinstance(rec, dict):
            continue
        lat = rec.get("lat")
        lon = rec.get("lon")
        if lat is None or lon is None:
            continue
        try:
            dist = provider.distance_mi(
                animal_lat, animal_lon, float(lat), float(lon)
            )
        except (TypeError, ValueError):
            continue
        if dist > radius:
            continue

        total += 1
        for role in _roles_of(rec):
            role_counts[role] += 1

        area = rec.get("win_area")
        if area is not None and str(area).strip():
            win_areas.add(str(area).strip())

    return AggregateResult(
        total_in_range=total,
        role_counts=role_counts,
        win_areas=sorted(win_areas),
    )


def _is_open(open_closed: Any) -> bool:
    """True only when a facility's status string is explicitly 'open'."""
    return str(open_closed or "").strip().casefold() == "open"


def find_closest_rehabber(
    animal_lat: float,
    animal_lon: float,
    rehabbers_dataset: Sequence[Dict[str, Any]],
    provider: Optional[DistanceProvider] = None,
    prefer_open: bool = True,
) -> Optional[ClosestRehabber]:
    """Return the nearest rehabber (PUBLIC-safe name/distance/open/website).

    Records are shaped ``{rehab_name, lat, lon, county, open_closed, website}``.
    When ``prefer_open`` is True (default) and at least one OPEN facility is
    usable, the nearest OPEN facility is returned. If NO open facility is
    usable, the nearest facility overall is returned with ``is_closed=True`` so
    the caller can still report it while flagging that it is not open.

    Returns ``None`` if the dataset has no usable (lat/lon-bearing) record.
    """
    provider = provider or _DEFAULT_PROVIDER

    closest_open: Optional[ClosestRehabber] = None
    closest_open_d = math.inf
    closest_any: Optional[ClosestRehabber] = None
    closest_any_d = math.inf

    for rec in rehabbers_dataset or ():
        if not isinstance(rec, dict):
            continue
        lat = rec.get("lat")
        lon = rec.get("lon")
        if lat is None or lon is None:
            continue
        try:
            dist = provider.distance_mi(
                animal_lat, animal_lon, float(lat), float(lon)
            )
        except (TypeError, ValueError):
            continue

        open_closed = str(rec.get("open_closed") or "")
        is_open = _is_open(open_closed)
        candidate = ClosestRehabber(
            rehab_name=str(rec.get("rehab_name") or ""),
            distance_mi=dist,
            open_closed=open_closed,
            website=str(rec.get("website") or ""),
            is_closed=not is_open,
        )

        if dist < closest_any_d:
            closest_any_d = dist
            closest_any = candidate
        if is_open and dist < closest_open_d:
            closest_open_d = dist
            closest_open = candidate

    if prefer_open and closest_open is not None:
        return closest_open
    return closest_any


# ---------------------------------------------------------------------------
# Recommendation assembly
# ---------------------------------------------------------------------------


def _coordinators_for_areas(areas: Iterable[str]) -> List[str]:
    """Resolve distinct coordinator NAMES for the given WIN areas (sorted).

    Uses ``county_win.counties_for_area`` (area -> (counties, coordinator)).
    Unknown areas contribute no coordinator. Name only -- no phone.
    """
    names: Set[str] = set()
    for area in areas:
        result = county_win.counties_for_area(area)
        if result is None:
            continue
        _counties, coordinator = result
        if coordinator and coordinator.strip():
            names.add(coordinator.strip())
    return sorted(names)


def build_recommendation(
    aggregate: AggregateResult,
    closest_rehabber: Optional[ClosestRehabber],
    coordinator_lookup=_coordinators_for_areas,
) -> RecommendationResult:
    """Synthesize structured dispatcher actions from aggregate + closest rehabber.

    ``coordinator_lookup`` is injectable (defaults to the ``county_win``-backed
    resolver) so tests can supply a deterministic stub. It maps an iterable of
    WIN areas -> a sorted list of coordinator NAMES.

    Actions emitted (in order, only when applicable):
      * ``connecteam_tasking`` -- when in-range volunteers exist, task the
        present WIN area(s) via Connecteam.
      * ``contact_coordinator`` -- contact the Area coordinator NAME(s) for the
        present areas (name only).
      * ``call_pgc`` -- when NO qualifying volunteers are in range, call the PA
        Game Commission.
      * ``transport_to_rehabber`` -- transport to the closest rehabber; carries
        ``is_closed`` so the UI can warn if the nearest is not open.

    The result is STRUCTURED (lists/dicts), never free prose, and the
    coordinator field is a NAME only.
    """
    win_areas = list(aggregate.win_areas)
    coordinators = list(coordinator_lookup(win_areas)) if win_areas else []
    has_qualified = any(aggregate.role_counts.get(r, 0) > 0 for r in QUALIFYING_ROLES)

    actions: List[Dict[str, Any]] = []

    if aggregate.total_in_range > 0 and win_areas:
        actions.append(
            {
                "type": "connecteam_tasking",
                "win_areas": win_areas,
                "in_range_total": aggregate.total_in_range,
            }
        )

    if coordinators:
        actions.append(
            {
                "type": "contact_coordinator",
                "coordinators": coordinators,
                "win_areas": win_areas,
            }
        )

    if not has_qualified:
        actions.append(
            {
                "type": "call_pgc",
                "reason": "no_qualified_volunteers_in_radius",
            }
        )

    rehabber_field: Optional[Dict[str, Any]] = None
    if closest_rehabber is not None:
        rehabber_field = {
            "rehab_name": closest_rehabber.rehab_name,
            "distance_mi": closest_rehabber.distance_mi,
            "open_closed": closest_rehabber.open_closed,
            "website": closest_rehabber.website,
            "is_closed": closest_rehabber.is_closed,
        }
        actions.append(
            {
                "type": "transport_to_rehabber",
                "rehab_name": closest_rehabber.rehab_name,
                "distance_mi": closest_rehabber.distance_mi,
                "is_closed": closest_rehabber.is_closed,
                "website": closest_rehabber.website,
            }
        )

    return RecommendationResult(
        actions=actions,
        supporting_counts=dict(aggregate.role_counts),
        win_areas=win_areas,
        coordinators=coordinators,
        closest_rehabber=rehabber_field,
    )

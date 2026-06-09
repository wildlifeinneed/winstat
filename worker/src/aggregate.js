'use strict';
/**
 * PURE aggregate core for the Dispatcher Worker.
 *
 * Direct JS port of the PII-boundary logic in dispatch_core.py:
 *   - clampRadius()           <- clamp_radius()
 *   - haversineMi()           <- HaversineProvider.distance_mi()
 *   - findVolunteersInRadius()<- find_volunteers_in_radius() -> AggregateResult
 *
 * NO network, NO KV, NO request parsing here -- this module is intentionally
 * pure so it can be unit-tested on any Node (incl. Node 12) with no build step
 * and no install. The Worker entry (index.js) imports this and only adds the
 * request/CORS/KV/Census plumbing around it.
 *
 * HARD PII RULE (mirrors dispatch_core.py): the returned object contains ONLY
 *   { total_in_range, role_counts, win_areas }
 * No names, no coords, no addresses, no per-volunteer rows ever appear here.
 */

// --- Radius policy (mirror DEFAULT_RADIUS_MI / MAX_RADIUS_MI) ---------------
const DEFAULT_RADIUS_MI = 20.0;
const MAX_RADIUS_MI = 100.0;

// Mean Earth radius in miles (must match EARTH_RADIUS_MI in dispatch_core.py).
const EARTH_RADIUS_MI = 3958.7613;

// Canonical qualifying role labels, in output order (mirror QUALIFYING_ROLES).
const ROLE_CT = 'C&T';
const ROLE_RVS_CT = 'RVS C&T';
const ROLE_COURIER = 'COURIER';
const QUALIFYING_ROLES = [ROLE_CT, ROLE_RVS_CT, ROLE_COURIER];

/**
 * Validate + clamp a requested radius into [0, MAX_RADIUS_MI].
 * None/non-numeric/non-finite -> DEFAULT_RADIUS_MI. Negative -> 0. >max -> max.
 * Never throws (mirror clamp_radius()).
 */
function clampRadius(radiusMi) {
  if (radiusMi === null || radiusMi === undefined || radiusMi === '') {
    return DEFAULT_RADIUS_MI;
  }
  const value = typeof radiusMi === 'number' ? radiusMi : Number(radiusMi);
  if (!Number.isFinite(value)) {
    return DEFAULT_RADIUS_MI;
  }
  if (value < 0) {
    return 0.0;
  }
  if (value > MAX_RADIUS_MI) {
    return MAX_RADIUS_MI;
  }
  return value;
}

function toRadians(deg) {
  return (deg * Math.PI) / 180.0;
}

/**
 * Great-circle straight-line distance in miles (mirror HaversineProvider).
 */
function haversineMi(aLat, aLon, bLat, bLon) {
  const lat1 = toRadians(Number(aLat));
  const lat2 = toRadians(Number(bLat));
  const dlat = lat2 - lat1;
  const dlon = toRadians(Number(bLon) - Number(aLon));
  const h =
    Math.sin(dlat / 2.0) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2.0) ** 2;
  const c = 2.0 * Math.asin(Math.min(1.0, Math.sqrt(h)));
  return EARTH_RADIUS_MI * c;
}

/** Collapse a role label to a comparison key (mirror _normalize_role). */
function normalizeRole(role) {
  return String(role).replace(/\s+/g, '').toLowerCase();
}

const ROLE_KEYS = {};
ROLE_KEYS[ROLE_CT] = normalizeRole(ROLE_CT);
ROLE_KEYS[ROLE_RVS_CT] = normalizeRole(ROLE_RVS_CT);
ROLE_KEYS[ROLE_COURIER] = normalizeRole(ROLE_COURIER);

/** Return the set of canonical qualifying roles a volunteer declares. */
function rolesOf(volunteer) {
  let declared = (volunteer && volunteer.roles) || [];
  if (typeof declared === 'string') {
    declared = [declared];
  }
  const declaredKeys = new Set();
  if (Array.isArray(declared)) {
    for (const r of declared) {
      declaredKeys.add(normalizeRole(r));
    }
  }
  const matched = new Set();
  for (const canonical of QUALIFYING_ROLES) {
    if (declaredKeys.has(ROLE_KEYS[canonical])) {
      matched.add(canonical);
    }
  }
  return matched;
}

/**
 * Aggregate the volunteers within radiusMi straight-line of the animal.
 *
 * coordsDataset is the PRIVATE in-memory volunteer-coords dataset (records
 * shaped {lat, lon, roles, home_county, win_area, ...}). Returns ONLY the
 * PII-free AggregateResult shape. Records missing/invalid lat or lon are
 * skipped defensively. Inclusive boundary (dist <= radius), mirror Python.
 *
 * @returns {{total_in_range:number, role_counts:Object, win_areas:string[]}}
 */
function findVolunteersInRadius(animalLat, animalLon, radiusMi, coordsDataset, distanceFn) {
  const dist = distanceFn || haversineMi;
  const radius = clampRadius(radiusMi);

  const roleCounts = {};
  for (const role of QUALIFYING_ROLES) {
    roleCounts[role] = 0;
  }
  const winAreas = new Set();
  let total = 0;

  const dataset = Array.isArray(coordsDataset) ? coordsDataset : [];
  for (const rec of dataset) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      continue;
    }
    const lat = rec.lat;
    const lon = rec.lon;
    if (lat === null || lat === undefined || lon === null || lon === undefined) {
      continue;
    }
    let d;
    try {
      d = dist(animalLat, animalLon, Number(lat), Number(lon));
    } catch (e) {
      continue;
    }
    if (!Number.isFinite(d) || d > radius) {
      continue;
    }

    total += 1;
    for (const role of rolesOf(rec)) {
      roleCounts[role] += 1;
    }

    const area = rec.win_area;
    if (area !== null && area !== undefined && String(area).trim() !== '') {
      winAreas.add(String(area).trim());
    }
  }

  return {
    total_in_range: total,
    role_counts: roleCounts,
    win_areas: Array.from(winAreas).sort(),
  };
}

module.exports = {
  DEFAULT_RADIUS_MI,
  MAX_RADIUS_MI,
  EARTH_RADIUS_MI,
  QUALIFYING_ROLES,
  clampRadius,
  haversineMi,
  normalizeRole,
  rolesOf,
  findVolunteersInRadius,
};

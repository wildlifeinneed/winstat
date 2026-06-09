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

// --- Tier 2 "widen" out-of-county context list -----------------------------

// Overflow policy (user-locked, supersedes any max_rows default):
//   N = number of out-of-county matches within the clamped radius.
//   N > 15  -> return ONLY the nearest 5 rows; radius_too_broad = truncated = true
//   N <= 15 -> return ALL matched rows;        radius_too_broad = false
const OVERFLOW_THRESHOLD = 15;
const OVERFLOW_NEAREST = 5;

/** Round to 1 decimal place (mirror the response schema's distance_mi). */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Normalize a county name for comparison (mirror county_win._normalize). */
function normalizeCounty(name) {
  if (name === null || name === undefined) {
    return '';
  }
  return String(name).trim().toLowerCase();
}

/**
 * Build the PII-SAFE out-of-county context rows for the Tier 2 "widen" search.
 *
 * For each KV record (same defensive guards as findVolunteersInRadius):
 *   - skip invalid/missing lat/lon;
 *   - compute straight-line distance; skip if non-finite or > clamped radius;
 *   - skip if normalize(home_county) === normalize(excludeCounty)
 *     (out-of-county ONLY -- Tier 1 already covers the in-county set);
 *   - produce ONE ROW PER VOLUNTEER (not per role) carrying their qualifying
 *     roles[] + rounded distance + coarse win_area/county context.
 *
 * Rows are sorted ascending by distance_mi. This function NEVER copies
 * lat/lon/_addr_sig/name/phone/email/address/monday_item_id -- it projects
 * only the whitelisted per-row fields so raw KV objects never flow onward.
 *
 * @returns {Array<{roles:string[], distance_mi:number, win_area:(string|null), county:(string|null)}>}
 */
function findContextRows(animalLat, animalLon, radiusMi, coordsDataset, excludeCounty, distanceFn) {
  const dist = distanceFn || haversineMi;
  const radius = clampRadius(radiusMi);
  const excludeNorm = normalizeCounty(excludeCounty);

  const rows = [];
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

    // Out-of-county filter: skip records whose home_county matches excludeCounty.
    if (excludeNorm !== '' && normalizeCounty(rec.home_county) === excludeNorm) {
      continue;
    }

    const matchedRoles = Array.from(rolesOf(rec));
    if (matchedRoles.length === 0) {
      continue;
    }

    const area = rec.win_area;
    const winArea =
      area !== null && area !== undefined && String(area).trim() !== ''
        ? String(area).trim()
        : null;
    const county =
      rec.home_county !== null && rec.home_county !== undefined && String(rec.home_county).trim() !== ''
        ? String(rec.home_county).trim()
        : null;

    rows.push({
      roles: matchedRoles,
      distance_mi: round1(d),
      win_area: winArea,
      county: county,
    });
  }

  rows.sort((a, b) => a.distance_mi - b.distance_mi);
  return rows;
}

/**
 * SINGLE serialization seam for the Tier 2 response. This is the ONLY place the
 * Tier 2 JSON object is constructed; it explicitly WHITELISTS keys:
 *   top-level: { total_in_range, role_counts, win_areas, out_of_county,
 *                out_of_county_truncated, radius_too_broad }
 *   per row:   { roles, distance_mi, win_area, county }
 *
 * It receives ALREADY-projected rows from findContextRows (which never copies
 * lat/lon/_addr_sig/etc.), so raw KV objects are never passed here.
 *
 * Overflow rule (user-locked): if contextRows.length > 15, emit ONLY the
 * nearest 5 (rows are pre-sorted ascending) and set radius_too_broad = true +
 * out_of_county_truncated = true; otherwise emit all rows, radius_too_broad =
 * false.
 *
 * @param {{total_in_range:number, role_counts:Object, win_areas:string[]}} aggregate
 * @param {Array} contextRows  rows from findContextRows (already projected/sorted)
 * @returns {Object} PII-safe Tier 2 response object
 */
function buildTier2Response(aggregate, contextRows) {
  const agg = aggregate || {};

  // Re-whitelist the aggregate block (never spread unknown keys through).
  const roleCounts = {};
  for (const role of QUALIFYING_ROLES) {
    roleCounts[role] =
      agg.role_counts && Number.isFinite(Number(agg.role_counts[role]))
        ? Number(agg.role_counts[role])
        : 0;
  }
  const winAreas = Array.isArray(agg.win_areas) ? agg.win_areas.slice() : [];

  const allRows = Array.isArray(contextRows) ? contextRows : [];
  const overflow = allRows.length > OVERFLOW_THRESHOLD;
  const selected = overflow ? allRows.slice(0, OVERFLOW_NEAREST) : allRows;

  // Per-row whitelist: copy ONLY {roles, distance_mi, win_area, county}.
  const outOfCounty = selected.map((r) => ({
    roles: Array.isArray(r.roles) ? r.roles.slice() : [],
    distance_mi: r.distance_mi,
    win_area: r.win_area === undefined ? null : r.win_area,
    county: r.county === undefined ? null : r.county,
  }));

  return {
    total_in_range: Number.isFinite(Number(agg.total_in_range)) ? Number(agg.total_in_range) : 0,
    role_counts: roleCounts,
    win_areas: winAreas,
    out_of_county: outOfCounty,
    out_of_county_truncated: overflow,
    radius_too_broad: overflow,
  };
}

module.exports = {
  DEFAULT_RADIUS_MI,
  MAX_RADIUS_MI,
  EARTH_RADIUS_MI,
  QUALIFYING_ROLES,
  OVERFLOW_THRESHOLD,
  OVERFLOW_NEAREST,
  clampRadius,
  haversineMi,
  normalizeRole,
  normalizeCounty,
  round1,
  rolesOf,
  findVolunteersInRadius,
  findContextRows,
  buildTier2Response,
};

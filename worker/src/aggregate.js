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

// Marginal-capacity threshold (mirror DEFAULT_CONFIG.marginal_threshold in
// refresh_monday.py AND dispatcher.js). Tier 2 is radius-scoped across many
// counties (not a single county), so it uses the GLOBAL default threshold --
// the same value Tier 1 falls back to when no per-county override applies. A
// (role) bucket is "marginal" when its available count <= this threshold.
const DEFAULT_MARGINAL_THRESHOLD = 1;

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

// Separate role token the data pipeline emits alongside 'C&T'. The DERIVED
// 'RVS C&T' bucket means a volunteer who declares BOTH 'C&T' AND 'RVS' (see
// refresh_monday.volunteer_buckets: has_ct && has_rvs -> ct_rvs). The literal
// pre-combined token 'RVS C&T' (normalizes to 'rvsc&t') is ALSO accepted for
// datasets that already store the combined label.
const RVS_KEY = normalizeRole('RVS');

/**
 * Return the set of canonical qualifying roles a volunteer declares.
 *
 * Tier-1 parity (refresh_monday.volunteer_buckets, ~lines 1051-1059): the
 * 'C&T' vs 'RVS C&T' buckets are MUTUALLY EXCLUSIVE -- a volunteer with both
 * C&T and RVS is counted ONLY in the RVS C&T (ct_rvs) bucket, never in the
 * plain C&T (ct_no_rvs) bucket. To agree with the county tier exactly, this
 * SYNTHESIZES 'RVS C&T' when the record declares BOTH separate 'C&T' and 'RVS'
 * tokens (and does NOT also emit plain 'C&T'). A literal combined 'RVS C&T'
 * token is honored the same way. Courier and C&T-only emissions are unchanged.
 */
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

  const hasCt = declaredKeys.has(ROLE_KEYS[ROLE_CT]);
  const hasRvs = declaredKeys.has(RVS_KEY);
  // Combined: either a literal 'RVS C&T' token, OR both separate C&T + RVS.
  const hasRvsCt = declaredKeys.has(ROLE_KEYS[ROLE_RVS_CT]) || (hasCt && hasRvs);
  const hasCourier = declaredKeys.has(ROLE_KEYS[ROLE_COURIER]);

  const matched = new Set();
  if (hasRvsCt) {
    // ct_rvs bucket: emit ONLY 'RVS C&T' (exclusive of plain 'C&T'), matching
    // Tier 1's ct_no_rvs vs ct_rvs exclusivity so role_counts agree.
    matched.add(ROLE_RVS_CT);
  } else if (hasCt) {
    matched.add(ROLE_CT);
  }
  if (hasCourier) {
    matched.add(ROLE_COURIER);
  }
  return matched;
}

/**
 * Decide whether a coords record counts as AVAILABLE.
 *
 * Mirrors the Tier 1 / county_capacity definition exactly: the refresh job
 * computes a boolean ``available`` per volunteer (refresh_monday.is_available,
 * DEFAULT_AVAILABLE_WHEN_BLANK = True) and the geocoder now propagates it onto
 * each PII-free coords record. To stay consistent with that default-available
 * semantics AND remain backward compatible with older datasets that predate
 * the field, a record is treated as available UNLESS it explicitly carries
 * available === false (or a falsey availability flag). Missing/undefined ->
 * available, identical to Tier 1's "blank availability => active".
 */
function isAvailableRecord(rec) {
  if (!rec || typeof rec !== 'object') {
    return false;
  }
  return rec.available !== false;
}

/**
 * Normalize a Connecteam-membership flag into a TRI-STATE value so the
 * frontend can distinguish "explicitly not on Connecteam" (false) from
 * "unknown / field not carried through the pipeline" (null). Returns:
 *   true  -> volunteer is a Connecteam app user
 *   false -> volunteer is EXPLICITLY not a Connecteam user (flag in banner)
 *   null  -> unknown (missing/undefined/null) -> never flagged in the banner
 * This prevents the old bug where a missing flag was coerced to `false` and
 * every qualified row was counted as "not on Connecteam".
 */
function normalizeConnecteamUser(v) {
  if (v === true) return true;
  if (v === false) return false;
  return null;
}

/**
 * Aggregate the volunteers within radiusMi straight-line of the animal.
 *
 * coordsDataset is the PRIVATE in-memory volunteer-coords dataset (records
 * shaped {lat, lon, roles, home_county, win_area, available, ...}). Returns
 * ONLY the PII-free AggregateResult shape. Records missing/invalid lat or lon
 * are skipped defensively. Inclusive boundary (dist <= radius), mirror Python.
 *
 * In addition to the presence counts (role_counts / total_in_range), this now
 * tallies AVAILABILITY the SAME way Tier 1 does: role_available[role] is the
 * count of in-radius volunteers declaring that role who are currently
 * available, and total_available is the count of distinct in-radius volunteers
 * who are available. These are COUNTS only -- never per-volunteer identity --
 * so the PII boundary is preserved.
 *
 * @returns {{total_in_range:number, role_counts:Object,
 *            role_available:Object, total_available:number, win_areas:string[]}}
 */
function findVolunteersInRadius(animalLat, animalLon, radiusMi, coordsDataset, distanceFn) {
  const dist = distanceFn || haversineMi;
  const radius = clampRadius(radiusMi);

  const roleCounts = {};
  const roleAvailable = {};
  const countyByRole = {};
  for (const role of QUALIFYING_ROLES) {
    roleCounts[role] = 0;
    roleAvailable[role] = 0;
    countyByRole[role] = {};
  }
  const winAreas = new Set();
  let total = 0;
  let totalAvailable = 0;

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
    const available = isAvailableRecord(rec);
    if (available) {
      totalAvailable += 1;
    }
    const recCounty =
      rec.home_county !== null && rec.home_county !== undefined && String(rec.home_county).trim() !== ''
        ? String(rec.home_county).trim() : '';
    for (const role of rolesOf(rec)) {
      roleCounts[role] += 1;
      if (available) {
        roleAvailable[role] += 1;
      }
      if (recCounty) {
        countyByRole[role][recCounty] = (countyByRole[role][recCounty] || 0) + 1;
      }
    }

    const area = rec.win_area;
    if (area !== null && area !== undefined && String(area).trim() !== '') {
      winAreas.add(String(area).trim());
    }
  }

  return {
    total_in_range: total,
    role_counts: roleCounts,
    role_available: roleAvailable,
    total_available: totalAvailable,
    win_areas: Array.from(winAreas).sort(),
    county_by_role: countyByRole,
  };
}

// --- DRIVING-distance variants (prescreen + ORS matrix + fallback) ---------

// Shared distance_mode labels surfaced in the response (single strings, NO
// PII: they identify only WHICH metric gated the result).
const MODE_DRIVING = 'driving';
const MODE_STRAIGHT_LINE = 'straight_line';

/**
 * Extract the subset of dataset records that pass the cheap haversine PRESCREEN
 * (straight-line distance <= clamped radius). Because driving distance is
 * ALWAYS >= straight-line distance, this prescreen is a guaranteed SUPERSET of
 * the driving-distance set -- no buffer is needed and there are no false
 * negatives. Returns parallel arrays so a later driving pass can map ORS
 * results back to the original records.
 *
 * `includeCounty` (Tier 1 By-County list): when supplied, a record whose
 * normalized home_county matches is ALWAYS retained regardless of distance, so
 * the By-County volunteer list stays in sync with the Tier 1 summary cards
 * (which count by home_county, NOT by a centroid radius). Such a record's
 * haversineMiles entry may exceed `radius`; downstream callers must not re-cut
 * those rows on distance (see findContextRowsDriving's in-county skip).
 *
 * @returns {{records:Object[], coords:Array<{lat:number,lon:number}>,
 *            haversineMiles:number[], radius:number}}
 */
function prescreenByHaversine(animalLat, animalLon, radiusMi, coordsDataset, includeCounty, filterWinArea) {
  const radius = clampRadius(radiusMi);
  const includeNorm = normalizeCounty(includeCounty);
  const areaNorm = normalizeWinArea(filterWinArea);
  const records = [];
  const coords = [];
  const haversineMiles = [];
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
    const nLat = Number(lat);
    const nLon = Number(lon);
    let d;
    try {
      d = haversineMi(animalLat, animalLon, nLat, nLon);
    } catch (e) {
      continue;
    }
    // Tier 1 By-County WIN-area scope: when filterWinArea is set, ONLY records in
    // that WIN area survive (this is the authoritative membership, matching the
    // by-area summary cards) and they survive REGARDLESS of distance.
    if (areaNorm !== '') {
      if (normalizeWinArea(rec.win_area) !== areaNorm || !Number.isFinite(d)) {
        continue;
      }
      records.push(rec);
      coords.push({ lat: nLat, lon: nLon });
      haversineMiles.push(d);
      continue;
    }
    const inCounty =
      includeNorm !== '' && normalizeCounty(rec.home_county) === includeNorm;
    if (!Number.isFinite(d) || (d > radius && !inCounty)) {
      continue;
    }
    records.push(rec);
    coords.push({ lat: nLat, lon: nLon });
    haversineMiles.push(d);
  }
  return { records: records, coords: coords, haversineMiles: haversineMiles, radius: radius };
}

/**
 * Aggregate the PRESCREENED survivor records into the SAME PII-free shape as
 * findVolunteersInRadius. `keep` is a boolean array parallel to `records`
 * (true => the record is inside the FINAL radius after the chosen metric).
 */
function aggregateRecords(records, keep) {
  const roleCounts = {};
  const roleAvailable = {};
  const countyByRole = {};
  for (const role of QUALIFYING_ROLES) {
    roleCounts[role] = 0;
    roleAvailable[role] = 0;
    countyByRole[role] = {};
  }
  const winAreas = new Set();
  let total = 0;
  let totalAvailable = 0;

  for (let i = 0; i < records.length; i += 1) {
    if (!keep[i]) continue;
    const rec = records[i];
    total += 1;
    const available = isAvailableRecord(rec);
    if (available) {
      totalAvailable += 1;
    }
    const recCounty =
      rec.home_county !== null && rec.home_county !== undefined && String(rec.home_county).trim() !== ''
        ? String(rec.home_county).trim() : '';
    for (const role of rolesOf(rec)) {
      roleCounts[role] += 1;
      if (available) {
        roleAvailable[role] += 1;
      }
      if (recCounty) {
        countyByRole[role][recCounty] = (countyByRole[role][recCounty] || 0) + 1;
      }
    }
    const area = rec.win_area;
    if (area !== null && area !== undefined && String(area).trim() !== '') {
      winAreas.add(String(area).trim());
    }
  }

  return {
    total_in_range: total,
    role_counts: roleCounts,
    role_available: roleAvailable,
    total_available: totalAvailable,
    win_areas: Array.from(winAreas).sort(),
    county_by_role: countyByRole,
  };
}

/**
 * DRIVING-distance volunteer aggregate.
 *
 * ALGORITHM:
 *   1. PRESCREEN by haversine (<= radius) -- a guaranteed superset.
 *   2. Call `drivingFn(origin, coords, ...)` on the prescreened subset to get
 *      driving miles (the injected helper CHUNKS large subsets + handles ORS).
 *   3. FINAL FILTER on DRIVING miles (<= radius); aggregate the survivors.
 *   4. FALLBACK: if the driving call returns {ok:false} (no key / error /
 *      timeout / malformed), aggregate the PRESCREEN set instead (pure
 *      haversine = current behavior). Never throws.
 *
 * `drivingFn` signature: (origin, coords, apiKey, fetchFn, opts) ->
 *   Promise<{ok:boolean, milesByIndex?:number[]}>  (see distance.drivingDistancesMiles).
 *
 * @returns {Promise<{aggregate:Object, distance_mode:'driving'|'straight_line'}>}
 *   aggregate is the SAME shape findVolunteersInRadius returns.
 */
async function findVolunteersInRadiusDriving(
  animalLat, animalLon, radiusMi, coordsDataset, drivingFn, apiKey, fetchFn, opts
) {
  const pre = prescreenByHaversine(animalLat, animalLon, radiusMi, coordsDataset);
  const origin = { lat: Number(animalLat), lon: Number(animalLon) };

  let drive = { ok: false };
  if (typeof drivingFn === 'function' && pre.coords.length > 0 &&
      Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) {
    try {
      drive = await drivingFn(origin, pre.coords, apiKey, fetchFn, opts);
    } catch (e) {
      drive = { ok: false };
    }
  }

  if (drive && drive.ok && Array.isArray(drive.milesByIndex)) {
    const keep = pre.records.map(function (_, i) {
      const m = drive.milesByIndex[i];
      return Number.isFinite(m) && m <= pre.radius;
    });
    return { aggregate: aggregateRecords(pre.records, keep), distance_mode: MODE_DRIVING };
  }

  // FALLBACK: keep the whole prescreen set (pure haversine = current behavior).
  const keepAll = pre.records.map(function () { return true; });
  return { aggregate: aggregateRecords(pre.records, keepAll), distance_mode: MODE_STRAIGHT_LINE };
}

/**
 * Builds the PII-safe out-of-county Tier-2 rows. MEMBERSHIP (who is "in range")
 * is decided by STRAIGHT-LINE (haversine) distance ONLY, and distance_mi is that
 * straight-line metric. Driving distance/time is then fetched from ORS for ONLY
 * the surviving (in-range + qualified) set and attached as a DISPLAY-ONLY
 * annotation (driving_miles + duration_min). Driving values NEVER add/remove a
 * row and NEVER change distance_mode (always 'straight_line'); an ORS failure
 * simply omits the tags. PII: only bare {lat,lon} of survivors reach ORS.
 *
 * @returns {Promise<{rows:Array, distance_mode:'straight_line'}>}
 */
async function findContextRowsDriving(
  animalLat, animalLon, radiusMi, coordsDataset, excludeCounty, drivingFn, apiKey, fetchFn, opts, qualifyRoles, includeCounty, filterWinArea
) {
  const pre = prescreenByHaversine(animalLat, animalLon, radiusMi, coordsDataset, includeCounty, filterWinArea);
  const origin = { lat: Number(animalLat), lon: Number(animalLon) };
  const excludeNorm = normalizeCounty(excludeCounty);
  const includeNorm = normalizeCounty(includeCounty);
  const areaNorm = normalizeWinArea(filterWinArea);
  const qualifyKeys = parseQualifyRoles(qualifyRoles);

  // PHASE 1 -- MEMBERSHIP: STRAIGHT-LINE (haversine) ONLY. Who is "in range" is
  // decided here and never depends on driving distance. distance_mi is the
  // straight-line radius metric. `surviveCoords` stays parallel to `rows` so the
  // phase-2 ORS matrix maps cell j -> rows[j].
  const rows = [];
  const surviveCoords = [];
  for (let i = 0; i < pre.records.length; i += 1) {
    const rec = pre.records[i];
    const miles = pre.haversineMiles[i];
    // Tier 1 By-County WIN-area scope: when areaNorm is set the prescreen already
    // restricted survivors to that WIN area (the authoritative membership,
    // matching the by-area summary cards), so members survive regardless of
    // distance and the radius re-cut is skipped here.
    const inArea = areaNorm !== '';
    // In-county membership (Tier 1 By-County, no win_area): a volunteer whose
    // home_county matches includeCounty is ALWAYS in the list regardless of
    // distance, so the list stays in sync with the by-county summary cards
    // (which count by home_county, not by a centroid radius). All others stay
    // radius-gated.
    const inCounty =
      includeNorm !== '' && normalizeCounty(rec.home_county) === includeNorm;
    if (!Number.isFinite(miles) || (miles > pre.radius && !inCounty && !inArea)) {
      continue;
    }
    // Out-of-county filter (Tier 1 already covers the in-county set).
    if (excludeNorm !== '' && normalizeCounty(rec.home_county) === excludeNorm) {
      continue;
    }
    const matchedRoles = Array.from(rolesOf(rec));
    if (matchedRoles.length === 0) {
      continue;
    }
    // QUALIFIED-ONLY filter (Tier 2 address list): drop rows whose roles do not
    // intersect the animal's qualifying-role set BEFORE the nearest-N overflow
    // cap downstream, so the cap operates on the qualified set only and farther
    // qualified volunteers are never dropped in favor of nearer unqualified
    // ones. No-op when qualifyKeys is null (county mode / backward compat).
    if (!rowQualifies(matchedRoles, qualifyKeys)) {
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
      distance_mi: round1(miles),
      win_area: winArea,
      county: county,
      name: (rec.name !== null && rec.name !== undefined) ? String(rec.name) : null,
      availability_note: (rec.availability_note !== null && rec.availability_note !== undefined)
        ? String(rec.availability_note) : '',
      available: isAvailableRecord(rec),
      connecteam_user: normalizeConnecteamUser(rec.connecteam_user),
    });
    surviveCoords.push(pre.coords[i]);
  }

  // PHASE 2 -- DISPLAY-ONLY DRIVING ANNOTATION. For ONLY the surviving set,
  // fetch real ORS driving distance + time and attach driving_miles +
  // duration_min per row. Membership is already fixed above, so any ORS
  // failure/timeout simply omits the tags -- it never changes who is in range
  // and never changes distance_mode (stays straight_line). PII: only bare
  // {lat,lon} of survivors are sent to ORS (per the 2026-06-09 amendment).
  if (typeof drivingFn === 'function' && rows.length > 0 &&
      Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) {
    let drive = { ok: false };
    try {
      drive = await drivingFn(origin, surviveCoords, apiKey, fetchFn, opts);
    } catch (e) {
      drive = { ok: false };
    }
    if (drive && drive.ok && Array.isArray(drive.milesByIndex)) {
      for (let j = 0; j < rows.length; j += 1) {
        const dMi = drive.milesByIndex[j];
        if (Number.isFinite(dMi)) {
          rows[j].driving_miles = round1(dMi);
        }
        const dMin = drive.minutesByIndex ? drive.minutesByIndex[j] : null;
        if (Number.isFinite(dMin)) {
          rows[j].duration_min = dMin;
        }
      }
    }
  }

  rows.sort((a, b) => a.distance_mi - b.distance_mi);
  return { rows: rows, distance_mode: MODE_STRAIGHT_LINE };
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
 * Normalize a WIN-area value for equality comparison. WIN areas arrive as
 * strings or numbers ("12", 12); normalize to a trimmed string so the Tier 1
 * By-County WIN-area scope filter compares apples to apples. Empty / null ->
 * '' (treated as "no filter" by callers).
 */
function normalizeWinArea(area) {
  if (area === null || area === undefined) {
    return '';
  }
  return String(area).trim();
}

/**
 * Build a normalized Set of QUALIFYING role keys from a caller-supplied role
 * spec, or return null when no spec is given (=> no qualification filtering,
 * preserving the historical behavior for backward compat / county mode).
 *
 * The frontend derives the qualifying role labels from decision.js's
 * qualifyingRoles() (the SINGLE source of truth) and sends them as a
 * comma-separated `qualify_roles` param (e.g. "C&T,RVS C&T"). This NEVER
 * re-derives the RVS/issue rules here; it only normalizes the labels into the
 * same comparison space rolesOf() uses so a row's matched roles can be tested
 * for intersection. Empty / whitespace-only input -> null (no filtering).
 *
 * @param {string|string[]|null} spec  comma-separated labels or array
 * @returns {Set<string>|null}
 */
function parseQualifyRoles(spec) {
  if (spec === null || spec === undefined) {
    return null;
  }
  let parts;
  if (Array.isArray(spec)) {
    parts = spec;
  } else {
    const s = String(spec).trim();
    if (s === '') {
      return null;
    }
    parts = s.split(',');
  }
  const keys = new Set();
  for (const p of parts) {
    const k = normalizeRole(p);
    if (k !== '') {
      keys.add(k);
    }
  }
  return keys.size > 0 ? keys : null;
}

/**
 * True when a row's matched roles intersect the qualifying-role key set.
 * `qualifyKeys` is the normalized Set from parseQualifyRoles (or null => no
 * filter, everything qualifies). `matchedRoles` is the array rolesOf() emits.
 */
function rowQualifies(matchedRoles, qualifyKeys) {
  if (!qualifyKeys) {
    return true;
  }
  for (const r of matchedRoles) {
    if (qualifyKeys.has(normalizeRole(r))) {
      return true;
    }
  }
  return false;
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
function findContextRows(animalLat, animalLon, radiusMi, coordsDataset, excludeCounty, distanceFn, qualifyRoles, includeCounty, filterWinArea) {
  const dist = distanceFn || haversineMi;
  const radius = clampRadius(radiusMi);
  const excludeNorm = normalizeCounty(excludeCounty);
  const includeNorm = normalizeCounty(includeCounty);
  const areaNorm = normalizeWinArea(filterWinArea);
  const qualifyKeys = parseQualifyRoles(qualifyRoles);

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
    // Tier 1 By-County WIN-area scope: when filterWinArea is set, ONLY records
    // whose win_area matches survive (the authoritative membership, matching the
    // by-area summary cards) and they survive REGARDLESS of distance.
    if (areaNorm !== '') {
      if (normalizeWinArea(rec.win_area) !== areaNorm || !Number.isFinite(d)) {
        continue;
      }
    } else {
      // In-county membership (Tier 1 By-County list): a volunteer whose
      // home_county matches includeCounty is ALWAYS retained regardless of
      // distance so the list matches the by-county summary cards. All others
      // stay radius-gated.
      const inCounty =
        includeNorm !== '' && normalizeCounty(rec.home_county) === includeNorm;
      if (!Number.isFinite(d) || (d > radius && !inCounty)) {
        continue;
      }
    }

    // Out-of-county filter: skip records whose home_county matches excludeCounty.
    if (excludeNorm !== '' && normalizeCounty(rec.home_county) === excludeNorm) {
      continue;
    }

    const matchedRoles = Array.from(rolesOf(rec));
    if (matchedRoles.length === 0) {
      continue;
    }
    // QUALIFIED-ONLY filter (see findContextRowsDriving). No-op when qualifyKeys
    // is null (county mode / backward compat).
    if (!rowQualifies(matchedRoles, qualifyKeys)) {
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
      name: (rec.name !== null && rec.name !== undefined) ? String(rec.name) : null,
      availability_note: (rec.availability_note !== null && rec.availability_note !== undefined)
        ? String(rec.availability_note) : '',
      available: isAvailableRecord(rec),
      connecteam_user: normalizeConnecteamUser(rec.connecteam_user),
    });
  }

  rows.sort((a, b) => a.distance_mi - b.distance_mi);
  return rows;
}

/**
 * LEGACY aggregate serialization seam. Re-whitelists the aggregate object down
 * to the THREE historical top-level keys { total_in_range, role_counts,
 * win_areas } so the non-context (Tier 1 / address-only) response stays
 * byte-identical to what callers have always received. The availability fields
 * (role_available / total_available) that findVolunteersInRadius now also
 * computes are INTENTIONALLY dropped here -- they surface only via the Tier 2
 * response below. This keeps existing callers unaffected (backward compatible).
 *
 * @param {{total_in_range:number, role_counts:Object, win_areas:string[]}} aggregate
 * @param {string} [distanceMode]  'driving' | 'straight_line' -- which metric
 *        gated this result (single string, NO PII). When provided it is added
 *        as a top-level `distance_mode` field; when omitted the response keeps
 *        the historical three-key shape (full backward compatibility).
 * @returns {Object} PII-safe legacy aggregate response object
 */
function buildAggregateResponse(aggregate, distanceMode) {
  const agg = aggregate || {};
  const roleCounts = {};
  for (const role of QUALIFYING_ROLES) {
    roleCounts[role] =
      agg.role_counts && Number.isFinite(Number(agg.role_counts[role]))
        ? Number(agg.role_counts[role])
        : 0;
  }
  const out = {
    total_in_range: Number.isFinite(Number(agg.total_in_range)) ? Number(agg.total_in_range) : 0,
    role_counts: roleCounts,
    win_areas: Array.isArray(agg.win_areas) ? agg.win_areas.slice() : [],
  };
  if (distanceMode === MODE_DRIVING || distanceMode === MODE_STRAIGHT_LINE) {
    out.distance_mode = distanceMode;
  }
  return out;
}

/**
 * SINGLE serialization seam for the Tier 2 response. This is the ONLY place the
 * Tier 2 JSON object is constructed; it explicitly WHITELISTS keys:
 *   top-level: { total_in_range, role_counts, role_available, total_available,
 *                marginal_threshold, win_areas, out_of_county,
 *                out_of_county_truncated, radius_too_broad }
 *   per row:   { roles, distance_mi, win_area, county, duration_min? }
 *              (duration_min is the whole-minute driving time, present ONLY in
 *              driving mode; omitted on the straight_line fallback)
 *
 * It receives ALREADY-projected rows from findContextRows (which never copies
 * lat/lon/_addr_sig/etc.), so raw KV objects are never passed here.
 *
 * AVAILABILITY (mirrors Tier 1): role_available[role] / total_available are
 * COUNTS of currently-available in-radius volunteers (never identities), and
 * marginal_threshold is the global Tier 1 default. The frontend renders an
 * avail/total ratio per role + a "Marginal" badge when available <= threshold,
 * exactly like the Tier 1 county cards. PII boundary unchanged -- only counts.
 *
 * Overflow rule (user-locked): if contextRows.length > 15, emit ONLY the
 * nearest 5 (rows are pre-sorted ascending) and set radius_too_broad = true +
 * out_of_county_truncated = true; otherwise emit all rows, radius_too_broad =
 * false.
 *
 * @param {{total_in_range:number, role_counts:Object, role_available:Object,
 *          total_available:number, win_areas:string[]}} aggregate
 * @param {Array} contextRows  rows from findContextRows (already projected/sorted)
 * @param {string} [distanceMode]  'driving' | 'straight_line' -- which metric
 *        gated this result. A single string (NO PII). Defaults to
 *        'straight_line' (current behavior) when omitted/invalid.
 * @returns {Object} PII-safe Tier 2 response object
 */
function buildTier2Response(aggregate, contextRows, distanceMode) {
  const agg = aggregate || {};

  // Re-whitelist the aggregate block (never spread unknown keys through).
  const roleCounts = {};
  const roleAvailable = {};
  for (const role of QUALIFYING_ROLES) {
    roleCounts[role] =
      agg.role_counts && Number.isFinite(Number(agg.role_counts[role]))
        ? Number(agg.role_counts[role])
        : 0;
    // available count per role, clamped to [0, total] so a malformed dataset
    // can never report more available than present in range.
    let avail =
      agg.role_available && Number.isFinite(Number(agg.role_available[role]))
        ? Number(agg.role_available[role])
        : 0;
    if (avail < 0) avail = 0;
    if (avail > roleCounts[role]) avail = roleCounts[role];
    roleAvailable[role] = avail;
  }
  const winAreas = Array.isArray(agg.win_areas) ? agg.win_areas.slice() : [];

  const totalInRange =
    Number.isFinite(Number(agg.total_in_range)) ? Number(agg.total_in_range) : 0;
  let totalAvailable =
    Number.isFinite(Number(agg.total_available)) ? Number(agg.total_available) : 0;
  if (totalAvailable < 0) totalAvailable = 0;
  if (totalAvailable > totalInRange) totalAvailable = totalInRange;

  const allRows = Array.isArray(contextRows) ? contextRows : [];
  const overflow = allRows.length > OVERFLOW_THRESHOLD;
  const selected = overflow ? allRows.slice(0, OVERFLOW_NEAREST) : allRows;

  // Per-row whitelist: copy ONLY {roles, distance_mi, win_area, county} plus the
  // optional DISPLAY-ONLY driving annotation (driving_miles + duration_min) when
  // present. distance_mi is always the STRAIGHT-LINE membership metric;
  // driving_miles/duration_min are surfaced only when ORS succeeded for the
  // surviving set (see findContextRowsDriving) and omitted otherwise so the
  // frontend never shows a fabricated value.
  const outOfCounty = selected.map((r) => {
    const o = {
      roles: Array.isArray(r.roles) ? r.roles.slice() : [],
      distance_mi: r.distance_mi,
      win_area: r.win_area === undefined ? null : r.win_area,
      county: r.county === undefined ? null : r.county,
      name: (r.name !== null && r.name !== undefined) ? r.name : null,
      availability_note: (r.availability_note !== null && r.availability_note !== undefined)
        ? r.availability_note : '',
      available: r.available !== false,
      connecteam_user: normalizeConnecteamUser(r.connecteam_user),
    };
    if (Number.isFinite(r.driving_miles)) {
      o.driving_miles = r.driving_miles;
    }
    if (Number.isFinite(r.duration_min)) {
      o.duration_min = r.duration_min;
    }
    return o;
  });

  // county_by_role: whitelist each role's county-count map from the aggregate.
  // This lets the frontend show a county breakdown for ALL volunteers per role,
  // not just the qualified subset returned in out_of_county.
  const countyByRole = {};
  for (const role of QUALIFYING_ROLES) {
    const src = agg.county_by_role && agg.county_by_role[role];
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      const whitelisted = {};
      for (const county of Object.keys(src)) {
        const n = Number(src[county]);
        if (Number.isFinite(n) && n > 0) {
          whitelisted[county] = n;
        }
      }
      countyByRole[role] = whitelisted;
    } else {
      countyByRole[role] = {};
    }
  }

  return {
    total_in_range: totalInRange,
    role_counts: roleCounts,
    role_available: roleAvailable,
    total_available: totalAvailable,
    marginal_threshold: DEFAULT_MARGINAL_THRESHOLD,
    win_areas: winAreas,
    county_by_role: countyByRole,
    out_of_county: outOfCounty,
    out_of_county_truncated: overflow,
    radius_too_broad: overflow,
    distance_mode: distanceMode === MODE_DRIVING ? MODE_DRIVING : MODE_STRAIGHT_LINE,
  };
}

module.exports = {
  DEFAULT_RADIUS_MI,
  MAX_RADIUS_MI,
  EARTH_RADIUS_MI,
  DEFAULT_MARGINAL_THRESHOLD,
  QUALIFYING_ROLES,
  OVERFLOW_THRESHOLD,
  OVERFLOW_NEAREST,
  MODE_DRIVING,
  MODE_STRAIGHT_LINE,
  clampRadius,
  haversineMi,
  normalizeRole,
  normalizeCounty,
  parseQualifyRoles,
  rowQualifies,
  round1,
  rolesOf,
  isAvailableRecord,
  prescreenByHaversine,
  aggregateRecords,
  findVolunteersInRadius,
  findVolunteersInRadiusDriving,
  findContextRows,
  findContextRowsDriving,
  buildAggregateResponse,
  buildTier2Response,
};

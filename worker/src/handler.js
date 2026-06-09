'use strict';
/**
 * Core request handler for the Dispatcher aggregate Worker.
 *
 * Written as a pure CommonJS function so it is fully unit-testable on any Node
 * (incl. Node 12) with mocked deps -- NO live network, NO real KV. The thin
 * Cloudflare ESM entry (index.mjs) wraps this and supplies the real env/fetch.
 *
 * Endpoint behaviour:
 *   GET/POST with EITHER (animal_lat & animal_lon) OR (address), plus optional
 *   radius_mi (default 20, clamped to max 100). Reads the PRIVATE volunteer
 *   coords from the KV binding and returns the PII-free AggregateResult plus
 *   the dispatcher-entered ANIMAL coordinate (safe -- it is the animal location,
 *   not volunteer PII) so the browser can rank rehabbers by distance:
 *       { total_in_range, role_counts, win_areas, animal_lat, animal_lon }
 *
 * Hardening:
 *   - validates inputs, clamps radius, returns 400 on bad input
 *   - NEVER echoes coordinates or any volunteer datum into an error message
 *   - CORS via a configurable ALLOWED_ORIGIN (see index.mjs / wrangler.toml)
 */

const {
  findVolunteersInRadiusDriving,
  findContextRowsDriving,
  buildAggregateResponse,
  buildTier2Response,
} = require('./aggregate');
const { geocodeAddress } = require('./census');
const { countyToArea } = require('./county_win');
const { autocompleteAddress, photonGeocode } = require('./autocomplete');
const { rehabberDistances, drivingDistancesMiles } = require('./distance');

// KV key under which the Phase F refresh job stores the coords array (JSON).
const KV_COORDS_KEY = 'volunteer_coords';

// Fallback CORS origin if env.ALLOWED_ORIGIN is unset. TODO(deploy): set this
// to the project's GitHub Pages origin in wrangler.toml [vars].
const DEFAULT_ALLOWED_ORIGIN = 'https://example.github.io';

function corsHeaders(allowedOrigin) {
  return {
    'Access-Control-Allow-Origin': allowedOrigin || DEFAULT_ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(ResponseCtor, status, obj, allowedOrigin) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    corsHeaders(allowedOrigin)
  );
  return new ResponseCtor(JSON.stringify(obj), { status, headers });
}

/**
 * Parse the request params from query string and/or JSON/form body.
 * Returns a plain object of string|null values. Never throws.
 */
async function readParams(request) {
  const params = {
    animal_lat: null,
    animal_lon: null,
    address: null,
    radius_mi: null,
    autocomplete: null,
    limit: null,
    exclude_county: null,
    context: null,
    qualify_roles: null,
  };

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    url = null;
  }
  if (url) {
    for (const k of Object.keys(params)) {
      const v = url.searchParams.get(k);
      if (v !== null) {
        params[k] = v;
      }
    }
  }

  const method = (request.method || 'GET').toUpperCase();
  if (method === 'POST') {
    let body = null;
    try {
      body = await request.json();
    } catch (e) {
      body = null;
    }
    if (body && typeof body === 'object') {
      for (const k of Object.keys(params)) {
        if (body[k] !== null && body[k] !== undefined && params[k] === null) {
          params[k] = body[k];
        }
      }
    }
  }
  return params;
}

function parseFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the `mode` discriminator from the URL query string ONLY (never the
 * body). The rehabber-distance route detects itself this way so it can read
 * the JSON body exactly once afterwards. Returns the trimmed string or ''.
 */
function urlMode(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return '';
  }
  const m = url.searchParams.get('mode');
  return m === null || m === undefined ? '' : String(m).trim();
}

/**
 * Truthy-flag parse for the opt-in `context` param. Treats '1'/'true'/'yes'/
 * 'on' (case-insensitive) and the number 1 / boolean true as ON; everything
 * else (incl. null/undefined/''/'0'/'false') is OFF. When OFF, the response is
 * byte-identical to today's aggregate (full backward compatibility).
 */
function isContextOn(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (value === true) {
    return true;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  const s = String(value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Resolve the animal coordinate from params. Prefers explicit lat/lon; falls
 * back to geocoding the address (server-side, no CORS) via the (injectable)
 * fetchFn. Returns a discriminated result so the caller can choose the right
 * status code:
 *   { status: 'ok',          coord: {lat, lon}, county: 'Allegheny'|null }
 *   { status: 'bad_latlon' }                       -- lat/lon present but invalid
 *   { status: 'address_not_found' }                -- geocoder reachable, no match
 *   { status: 'geocoder_unavailable' }             -- geocoder network/HTTP error
 *   { status: 'missing' }                          -- neither location supplied
 *
 * `county` is the ANIMAL's own county (from the geocoder) or null when only
 * explicit lat/lon were supplied or the geocoder did not return a county.
 */
async function resolveAnimalCoord(params, fetchFn) {
  const lat = parseFiniteNumber(params.animal_lat);
  const lon = parseFiniteNumber(params.animal_lon);
  if (lat !== null && lon !== null) {
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { status: 'bad_latlon' };
    }
    // Explicit coordinates carry no county; the UI falls back to in-range areas.
    return { status: 'ok', coord: { lat, lon }, county: null };
  }

  const address = params.address !== null && params.address !== undefined
    ? String(params.address).trim()
    : '';
  if (address) {
    const geo = await geocodeAddress(address, fetchFn);
    if (geo && geo.status === 'ok') {
      return { status: 'ok', coord: geo.coord, county: geo.county || null };
    }
    if (geo && geo.status === 'unavailable') {
      return { status: 'geocoder_unavailable' };
    }
    // Census reached but found NO exact match (weak on rural PA). Rather than
    // dead-ending, fall back to a Photon geocode of the SAME string — the same
    // provider that already powers the typeahead. Photon carries no county
    // layer, so county stays null (the UI degrades to the in-range areas). Only
    // when BOTH fail do we return the not-found contract.
    const photon = await photonGeocode(address, fetchFn);
    if (photon && photon.status === 'ok') {
      return { status: 'ok', coord: photon.coord, county: null };
    }
    return { status: 'address_not_found' };
  }
  return { status: 'missing' };
}

/**
 * Read + parse the private coords dataset from KV. Returns an array (possibly
 * empty). Never throws; a malformed/empty KV value degrades to [].
 *
 * @param {Object} kv  KV binding with async get(key) -> string|null
 */
async function readCoordsFromKV(kv) {
  if (!kv || typeof kv.get !== 'function') {
    return [];
  }
  let raw;
  try {
    raw = await kv.get(KV_COORDS_KEY);
  } catch (e) {
    return [];
  }
  if (!raw) {
    return [];
  }
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Handle one request. Dependency-injected so tests pass mocks:
 *   deps = { ResponseCtor, kv, fetchFn, allowedOrigin, orsApiKey }
 */
async function handleRequest(request, deps) {
  const ResponseCtor = deps.ResponseCtor;
  const allowedOrigin = deps.allowedOrigin;

  const method = (request.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    return new ResponseCtor(null, {
      status: 204,
      headers: corsHeaders(allowedOrigin),
    });
  }
  if (method !== 'GET' && method !== 'POST') {
    return jsonResponse(ResponseCtor, 405, { error: 'method_not_allowed' }, allowedOrigin);
  }

  // ── Rehabber DRIVING-distance route ─────────────────────────────────
  // POST ?mode=rehabber_distances with JSON body { origin:{lat,lon},
  // destinations:[{lat,lon}, ...] }. Rehabber coords are PUBLIC, so this path
  // is PII-safe. Returns driving distance + duration parallel to the
  // destinations, with automatic haversine fallback when ORS is unavailable.
  // SCOPE: rehabbers only — it never reads the private volunteer KV.
  // Detected from the URL query BEFORE readParams so the body is consumed once.
  if (urlMode(request) === 'rehabber_distances') {
    let rbody = {};
    if (method === 'POST') {
      try {
        rbody = await request.json();
      } catch (e) {
        rbody = {};
      }
    }
    if (!rbody || typeof rbody !== 'object') rbody = {};
    const origin = rbody.origin;
    const destinations = Array.isArray(rbody.destinations) ? rbody.destinations : [];
    let result;
    try {
      result = await rehabberDistances(origin, destinations, deps.orsApiKey, deps.fetchFn);
    } catch (e) {
      // Never break the panel: degrade to nulls of the right length.
      result = {
        source: 'haversine',
        distances: destinations.map(function () {
          return { distance_mi: null, duration_min: null };
        }),
      };
    }
    return jsonResponse(ResponseCtor, 200, result, allowedOrigin);
  }

  const params = await readParams(request);

  // ── Address AUTOCOMPLETE route ──────────────────────────────────────
  // ?autocomplete=<partial>&limit=<n>. Proxies a GENERIC public address
  // provider (Photon) server-side, returns a small normalized suggestion
  // array. NEVER touches the private KV. Short query / provider error ->
  // graceful empty array (200), never a 500 that breaks the page.
  if (
    params.autocomplete !== null &&
    params.autocomplete !== undefined &&
    String(params.autocomplete).trim() !== ''
  ) {
    let suggestions;
    try {
      suggestions = await autocompleteAddress(
        String(params.autocomplete),
        params.limit,
        deps.fetchFn
      );
    } catch (e) {
      suggestions = [];
    }
    if (!Array.isArray(suggestions)) suggestions = [];
    return jsonResponse(ResponseCtor, 200, { suggestions: suggestions }, allowedOrigin);
  }

  // Radius: clamp happens inside findVolunteersInRadius, but reject a value
  // that is present yet non-numeric as bad input (defensive 400).
  if (
    params.radius_mi !== null &&
    params.radius_mi !== undefined &&
    params.radius_mi !== '' &&
    !Number.isFinite(Number(params.radius_mi))
  ) {
    return jsonResponse(ResponseCtor, 400, { error: 'invalid_radius' }, allowedOrigin);
  }

  const hasLatLon =
    params.animal_lat !== null && params.animal_lat !== undefined && params.animal_lat !== '' &&
    params.animal_lon !== null && params.animal_lon !== undefined && params.animal_lon !== '';
  const hasAddress =
    params.address !== null && params.address !== undefined && String(params.address).trim() !== '';
  if (!hasLatLon && !hasAddress) {
    return jsonResponse(
      ResponseCtor,
      400,
      { error: 'missing_location', detail: 'provide animal_lat+animal_lon or address' },
      allowedOrigin
    );
  }

  let resolved;
  try {
    resolved = await resolveAnimalCoord(params, deps.fetchFn);
  } catch (e) {
    resolved = { status: 'geocoder_unavailable' };
  }
  if (!resolved || resolved.status !== 'ok') {
    const status = resolved ? resolved.status : 'unresolvable_location';
    // Map the resolution failure to a precise status code so the UI can show
    // a specific message (distinct from a generic network failure). Never echo
    // any input coordinate or the raw address back in the error.
    if (status === 'address_not_found') {
      return jsonResponse(ResponseCtor, 422, { error: 'address_not_found' }, allowedOrigin);
    }
    if (status === 'geocoder_unavailable') {
      return jsonResponse(ResponseCtor, 502, { error: 'geocoder_unavailable' }, allowedOrigin);
    }
    // bad_latlon / missing / anything else -> existing generic 400 contract.
    return jsonResponse(ResponseCtor, 400, { error: 'unresolvable_location' }, allowedOrigin);
  }
  const coord = resolved.coord;

  // ANIMAL's own county + WIN area (from the geocoder, via county->area map).
  // Both are null when only explicit lat/lon were supplied or the geocoder did
  // not return a county. These describe the ANIMAL location (already echoed as
  // animal_lat/animal_lon) and are NOT volunteer PII. The UI uses animal_area as
  // the single governing area in address mode; when null it falls back to the
  // in-range win_areas spread without an animal-area header.
  const animalCounty = resolved.county || null;
  const animalArea = animalCounty ? countyToArea(animalCounty) : null;

  const coords = await readCoordsFromKV(deps.kv);

  // VOLUNTEER radius filter now uses DRIVING distance (ORS Matrix driving-car)
  // with the standard haversine PRESCREEN + graceful straight-line fallback.
  //   1. prescreen volunteers by haversine <= radius (guaranteed superset)
  //   2. ORS Matrix (animal -> prescreened coords, CHUNKED) for driving miles
  //   3. final filter on driving miles <= radius
  //   4. fallback to the prescreen (pure haversine) if the key is empty or any
  //      ORS call errors/times out -> distance_mode reflects which metric ran.
  // PII: only BARE [lon,lat] coords ever reach ORS (no names/addresses); the
  // response stays AGGREGATE-only. distance_mode is a single non-PII string.
  const volDriving = await findVolunteersInRadiusDriving(
    coord.lat,
    coord.lon,
    params.radius_mi,
    coords,
    drivingDistancesMiles,
    deps.orsApiKey,
    deps.fetchFn
  );
  const aggregate = volDriving.aggregate;
  const distanceMode = volDriving.distance_mode;

  // Tier 2 "widen" branch (opt-in): when context is truthy, ADD a PII-safe
  // out-of-county context list alongside the unchanged aggregate. The aggregate
  // itself is still computed across ALL in-radius volunteers (in + out of
  // county) above -- the context list is purely additive. It uses the SAME
  // driving prescreen + ORS + fallback flow so its distance_mi + radius gate
  // match the aggregate's metric.
  if (isContextOn(params.context)) {
    const ctx = await findContextRowsDriving(
      coord.lat,
      coord.lon,
      params.radius_mi,
      coords,
      params.exclude_county,
      drivingDistancesMiles,
      deps.orsApiKey,
      deps.fetchFn,
      undefined,
      params.qualify_roles
    );
    // Single serialization seam: only buildTier2Response constructs the JSON,
    // whitelisting keys so no raw KV datum can leak. distance_mode (a single
    // non-PII string) is surfaced so the UI/diagnostics know which metric ran.
    const tier2 = buildTier2Response(aggregate, ctx.rows, ctx.distance_mode);
    // The animal coordinate is the dispatcher-entered ANIMAL location (NOT
    // volunteer PII), so it is safe to echo back. The browser uses it to rank
    // rehabbers by distance. Distinct key names (animal_lat/animal_lon) keep it
    // clear this is the animal, not a volunteer coordinate.
    tier2.animal_lat = coord.lat;
    tier2.animal_lon = coord.lon;
    // ANIMAL's own county + WIN area (non-PII; null when geocoder gave no county
    // or only lat/lon were supplied). Lets the UI bind the governing area.
    tier2.animal_county = animalCounty;
    tier2.animal_area = animalArea;
    return jsonResponse(ResponseCtor, 200, tier2, allowedOrigin);
  }

  // PII boundary: return ONLY the legacy aggregate shape (plus distance_mode).
  // findVolunteersInRadiusDriving computes availability counts too, so we route
  // through buildAggregateResponse to re-whitelist down to the historical
  // three keys -- the availability fields surface ONLY via the Tier 2 response.
  const aggregateResponse = buildAggregateResponse(aggregate, distanceMode);
  // Echo the dispatcher-entered ANIMAL coordinate (safe, not volunteer PII) so
  // the browser can rank rehabbers by distance. animal_lat/animal_lon are
  // distinct from the forbidden lat/lon volunteer keys.
  aggregateResponse.animal_lat = coord.lat;
  aggregateResponse.animal_lon = coord.lon;
  // ANIMAL's own county + WIN area (non-PII; null when geocoder gave no county
  // or only lat/lon were supplied). Lets the UI bind the governing area.
  aggregateResponse.animal_county = animalCounty;
  aggregateResponse.animal_area = animalArea;
  return jsonResponse(ResponseCtor, 200, aggregateResponse, allowedOrigin);
}

module.exports = {
  KV_COORDS_KEY,
  DEFAULT_ALLOWED_ORIGIN,
  corsHeaders,
  readParams,
  urlMode,
  isContextOn,
  resolveAnimalCoord,
  readCoordsFromKV,
  handleRequest,
};

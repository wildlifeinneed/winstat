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
 *   coords from the KV binding and returns ONLY the PII-free AggregateResult:
 *       { total_in_range, role_counts, win_areas }
 *
 * Hardening:
 *   - validates inputs, clamps radius, returns 400 on bad input
 *   - NEVER echoes coordinates or any volunteer datum into an error message
 *   - CORS via a configurable ALLOWED_ORIGIN (see index.mjs / wrangler.toml)
 */

const { findVolunteersInRadius } = require('./aggregate');
const { geocodeAddress } = require('./census');

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
 * Resolve the animal coordinate from params. Prefers explicit lat/lon; falls
 * back to geocoding the address (server-side, no CORS) via the (injectable)
 * fetchFn. Returns a discriminated result so the caller can choose the right
 * status code:
 *   { status: 'ok',          coord: {lat, lon} }
 *   { status: 'bad_latlon' }                       -- lat/lon present but invalid
 *   { status: 'address_not_found' }                -- geocoder reachable, no match
 *   { status: 'geocoder_unavailable' }             -- geocoder network/HTTP error
 *   { status: 'missing' }                          -- neither location supplied
 */
async function resolveAnimalCoord(params, fetchFn) {
  const lat = parseFiniteNumber(params.animal_lat);
  const lon = parseFiniteNumber(params.animal_lon);
  if (lat !== null && lon !== null) {
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { status: 'bad_latlon' };
    }
    return { status: 'ok', coord: { lat, lon } };
  }

  const address = params.address !== null && params.address !== undefined
    ? String(params.address).trim()
    : '';
  if (address) {
    const geo = await geocodeAddress(address, fetchFn);
    if (geo && geo.status === 'ok') {
      return { status: 'ok', coord: geo.coord };
    }
    if (geo && geo.status === 'unavailable') {
      return { status: 'geocoder_unavailable' };
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
 *   deps = { ResponseCtor, kv, fetchFn, allowedOrigin }
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

  const params = await readParams(request);

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

  const coords = await readCoordsFromKV(deps.kv);

  const aggregate = findVolunteersInRadius(
    coord.lat,
    coord.lon,
    params.radius_mi,
    coords
  );

  // PII boundary: return ONLY the aggregate shape.
  return jsonResponse(ResponseCtor, 200, aggregate, allowedOrigin);
}

module.exports = {
  KV_COORDS_KEY,
  DEFAULT_ALLOWED_ORIGIN,
  corsHeaders,
  readParams,
  resolveAnimalCoord,
  readCoordsFromKV,
  handleRequest,
};

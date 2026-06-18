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
const { autocompleteAddress, photonGeocode, looksLikeFullAddress, looksLikeIntersection, hasHouseNumberMatch, censusAutocompleteFallback } = require('./autocomplete');
const { rehabberDistances, drivingDistancesMiles } = require('./distance');
const { countyForPoint } = require('./pip');
const { countyToArea } = require('./county_win');
// Single source of truth for county polygons: the SAME committed GeoJSON the
// frontend fetches for the WIN-area map (docs/data/pa_counties.json). Imported
// (not forked) so the worker and browser never diverge on boundaries. esbuild
// inlines this JSON into the Worker bundle; Node resolves it natively for tests.
const PA_COUNTIES_GEOJSON = require('../../docs/data/pa_counties.json');

// KV key under which the Phase F refresh job stores the coords array (JSON).
const KV_COORDS_KEY = 'volunteer_coords';

// Fallback CORS origin if env.ALLOWED_ORIGIN is unset. TODO(deploy): set this
// to the project's GitHub Pages origin in wrangler.toml [vars].
const DEFAULT_ALLOWED_ORIGIN = 'https://example.github.io';

// resolveAllowedOrigin(): pick the single Access-Control-Allow-Origin value.
//
// `configured` is the ALLOWED_ORIGIN wrangler var, which may be a SINGLE origin
// (legacy: "https://wildlifeinneed.github.io") or a COMMA-SEPARATED allowlist
// where entries may be exact origins OR a "*.pages.dev" wildcard pattern. When
// the incoming request carries an Origin that matches any allowlist entry, we
// echo that exact origin back (ACAO can only name one origin). Otherwise we
// fall back to the FIRST configured entry so behaviour with no Origin header
// (and the existing worker tests) is unchanged.
function resolveAllowedOrigin(configured, requestOrigin) {
  const list = String(configured || DEFAULT_ALLOWED_ORIGIN)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fallback = list[0] || DEFAULT_ALLOWED_ORIGIN;
  const origin = String(requestOrigin || '').trim();
  if (!origin) return fallback;
  for (const entry of list) {
    if (entry === origin) return origin;
    // Wildcard subdomain pattern, e.g. "https://*.pages.dev".
    const star = entry.indexOf('*');
    if (star !== -1) {
      const prefix = entry.slice(0, star);
      const suffix = entry.slice(star + 1);
      if (
        origin.startsWith(prefix) &&
        origin.endsWith(suffix) &&
        origin.length >= prefix.length + suffix.length &&
        // the wildcard must not span a '/' (stay within the host portion)
        origin.slice(prefix.length, origin.length - suffix.length).indexOf('/') === -1
      ) {
        return origin;
      }
    }
  }
  return fallback;
}

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
    animal_county: null,
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
      // Census HTTP/network error — attempt the Photon fallback before giving
      // up. This matters most for INTERSECTION addresses (e.g. "Elliott St &
      // Verona Rd, Penn Hills Township, PA") where the Census `geographies`
      // endpoint returns HTTP 4xx (it does not handle the "&" format), causing
      // the old code to short-circuit directly to geocoder_unavailable and show
      // "temporarily unavailable" without ever trying Photon. With this change:
      //   • Photon resolves an approximate coordinate → 200 ok (best case).
      //   • Photon also fails AND the address is an intersection → 422
      //     address_not_found (the format is unsupported, not the service down).
      //   • Photon also fails AND non-intersection → 502 geocoder_unavailable
      //     (service is genuinely unreachable — preserve the existing signal).
      const photonOnUnavail = await photonGeocode(address, fetchFn);
      if (photonOnUnavail && photonOnUnavail.status === 'ok') {
        return { status: 'ok', coord: photonOnUnavail.coord, county: null };
      }
      if (looksLikeIntersection(address)) {
        return { status: 'address_not_found' };
      }
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
  // Resolve the single ACAO value from the configured allowlist + the incoming
  // Origin header. Echoes a matching prod or *.pages.dev preview origin; falls
  // back to the first configured entry when there is no/unknown Origin.
  const requestOrigin =
    request && request.headers && typeof request.headers.get === 'function'
      ? request.headers.get('Origin')
      : null;
  const allowedOrigin = resolveAllowedOrigin(deps.allowedOrigin, requestOrigin);

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
    // CENSUS FALLBACK: Photon (OSM) lacks many rural PA house numbers (e.g.
    // 738 Neola Rd) AND for some real pasted addresses (e.g. "564 E Maiden St,
    // Washington, PA"; "321 2nd St, Port Carbon, PA") it returns a NON-EMPTY but
    // STREET-LEVEL list with the house number DROPPED. So a zero-length check
    // misses the exact cases the fallback was built for. Fire it when the query
    // looksLikeFullAddress() AND no Photon candidate resolves the pasted house
    // number (hasHouseNumberMatch === false). One exact-match Census call for
    // the SAME string; on a match the exact-house candidate is PREPENDED to the
    // top of the list (above the imprecise Photon street-level entries, which
    // stay below it), de-duped if its label equals a Photon label. Gated so it
    // never fires per-keystroke — only on a complete pasted-style address.
    var q = String(params.autocomplete);
    if (looksLikeFullAddress(q) && !hasHouseNumberMatch(q, suggestions)) {
      let censusCands;
      try {
        censusCands = await censusAutocompleteFallback(q, deps.fetchFn);
      } catch (e) {
        censusCands = [];
      }
      if (Array.isArray(censusCands) && censusCands.length) {
        var seen = {};
        for (var si = 0; si < suggestions.length; si++) {
          if (suggestions[si] && suggestions[si].label != null) {
            seen[String(suggestions[si].label)] = true;
          }
        }
        var prepend = [];
        for (var ci = 0; ci < censusCands.length; ci++) {
          var cand = censusCands[ci];
          var clabel = cand && cand.label != null ? String(cand.label) : '';
          if (!seen[clabel]) {
            prepend.push(cand);
            seen[clabel] = true;
          }
        }
        // Census exact-house candidate(s) FIRST, then the Photon entries.
        suggestions = prepend.concat(suggestions);
      }
    }
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

  // ANIMAL's own county + WIN area + geoid, derived by POINT-IN-POLYGON from the
  // FINAL resolved coordinate (coord) — uniformly for EVERY resolution path
  // (explicit picked lat/lon, Photon fallback, Census geographies string). The
  // committed county polygons are the single source of truth, so a county is
  // always available whenever the coordinate falls inside PA. All three are null
  // (clean "county not determined") when the coordinate is outside every PA
  // county polygon — the UI then degrades to the in-range win_areas without an
  // animal-area header and never shows a stale value.
  const pip = countyForPoint(coord.lon, coord.lat, PA_COUNTIES_GEOJSON);
  let animalCounty = pip ? pip.county : null;
  let animalArea = pip ? pip.win_area : null;
  let animalGeoid = pip ? pip.geoid : null;

  // TIER-1 FALLBACK: when PIP returns null (coordinate outside every PA polygon
  // or a coord-free path) and the dispatcher supplied an explicit county via the
  // Tier-1 By-County panel (animal_county param), use that county + its WIN area
  // as the governing area so the ACTIONS section can still show a coordinator and
  // in-area volunteer distinction. Mark the source so the UI can flag it.
  let countySource = null;
  if (!animalCounty && params.animal_county) {
    const t1County = String(params.animal_county).trim();
    const t1Area = countyToArea(t1County);
    if (t1County && t1Area !== null) {
      animalCounty = t1County;
      animalArea = t1Area;
      // geoid stays null — we have no polygon match for an out-of-PA coord.
      countySource = 'tier1_fallback';
    }
  }

  const coords = await readCoordsFromKV(deps.kv);

  // VOLUNTEER radius membership uses STRAIGHT-LINE (haversine) distance.
  //
  // We intentionally DO NOT gate the in-range set on ORS driving distance here.
  // Driving distance is always >= straight-line, so gating on it SHRINKS the
  // in-range set and changes "who's in range" -- e.g. DuBois @ 44 mi collapsed
  // from the correct 7 straight-line volunteers to ~0 because the nearest
  // clusters sit ~45-55 driving miles out. Per docs/DISTANCE_PROVIDER_SCOPING.md
  // (PII rule B2/B3 + "don't change who's-in-range; only annotate driving
  // time"), the volunteer radius gate stays straight-line and volunteer PII
  // coords are NOT sent to the 3rd-party ORS router. Passing an empty key makes
  // findVolunteersInRadiusDriving fall back to the pure-haversine prescreen set
  // (distance_mode = 'straight_line'). The PUBLIC rehabber route above still
  // uses deps.orsApiKey for driving distances on non-PII rehabber coords.
  const VOLUNTEER_RADIUS_ORS_KEY = '';
  const volDriving = await findVolunteersInRadiusDriving(
    coord.lat,
    coord.lon,
    params.radius_mi,
    coords,
    drivingDistancesMiles,
    VOLUNTEER_RADIUS_ORS_KEY,
    deps.fetchFn
  );
  const aggregate = volDriving.aggregate;
  const distanceMode = volDriving.distance_mode;

  // Tier 2 "widen" branch (opt-in): when context is truthy, ADD a PII-safe
  // out-of-county context list alongside the unchanged aggregate. The aggregate
  // itself is still computed across ALL in-radius volunteers (in + out of
  // county) above -- the context list is purely additive. MEMBERSHIP (who is in
  // range) is STRAIGHT-LINE haversine, identical to the aggregate. The REAL ORS
  // key is passed here ONLY so findContextRowsDriving can attach a DISPLAY-ONLY
  // driving distance/time annotation to the surviving qualified rows (computed
  // AFTER membership); it never gates membership. Approved per the 2026-06-09
  // PII amendment: only bare {lat,lon} of the small surviving set reach ORS.
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
    tier2.animal_geoid = animalGeoid;
    if (countySource) tier2.county_source = countySource;
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
  aggregateResponse.animal_geoid = animalGeoid;
  if (countySource) aggregateResponse.county_source = countySource;
  return jsonResponse(ResponseCtor, 200, aggregateResponse, allowedOrigin);
}

module.exports = {
  KV_COORDS_KEY,
  DEFAULT_ALLOWED_ORIGIN,
  resolveAllowedOrigin,
  corsHeaders,
  readParams,
  urlMode,
  isContextOn,
  resolveAnimalCoord,
  readCoordsFromKV,
  handleRequest,
};

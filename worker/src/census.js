'use strict';
/**
 * Census geocode helper for the Worker.
 *
 * Mirrors the endpoint + response parsing of geocoder.py:geocode_address but
 * accepts an injectable `fetchFn` so tests MOCK it and no live network is hit
 * locally. A live Census call only happens at runtime AFTER deploy, using the
 * Worker runtime's global fetch.
 *
 * Returns a discriminated result so the caller can surface a precise error:
 *   { status: 'ok',          coord: {lat, lon}, county: 'Allegheny'|null }
 *                                                    -- a usable match
 *   { status: 'not_found' }                          -- geocoder reachable, 0 matches
 *   { status: 'unavailable' }                        -- network / HTTP / parse error
 * Never throws. Note the Census API returns coordinates as {x: lon, y: lat}.
 *
 * We call the `geographies/onelineaddress` endpoint (not `locations/...`) so the
 * SAME response carries both the match coordinate AND the Census "Counties"
 * geography layer for the animal's own location. That county (e.g. "Allegheny")
 * is the basis for the animal's WIN area in the handler. `county` is the bare
 * county BASENAME with no "County" suffix; it is NULL when the geography layer
 * is absent (older benchmark / partial match) — the caller then falls back to
 * coordinate-only behaviour and never invents a county.
 *
 * county/area describe the ANIMAL's reported location, which is NOT volunteer
 * PII — the animal coordinate is already echoed back to the client.
 *
 * NOTE: the raw address is used only to build the outbound request URL. It is
 * NEVER logged or persisted here (preserve the "No address is stored" promise).
 */

const CENSUS_GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
const CENSUS_BENCHMARK = 'Public_AR_Current';
// Vintage is REQUIRED by the geographies endpoint; it selects the geography
// year matched against the benchmark. Current_Current pairs with the Current
// benchmark above.
const CENSUS_VINTAGE = 'Current_Current';
// Census geography layer key that carries the county name.
const CENSUS_COUNTY_LAYER = 'Counties';

/**
 * Geocode a one-line address string via the Census API (server-side).
 *
 * @param {string} address      one-line address
 * @param {Function} fetchFn    fetch-compatible (url, init) -> Promise<Response>
 * @returns {Promise<{status:'ok',coord:{lat:number,lon:number}}
 *                   |{status:'not_found'}
 *                   |{status:'unavailable'}>}
 */
async function geocodeAddress(address, fetchFn) {
  const addr = String(address || '').trim();
  if (!addr) {
    return { status: 'not_found' };
  }
  const doFetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) {
    return { status: 'unavailable' };
  }

  const url = new URL(CENSUS_GEOCODER_URL);
  url.searchParams.set('address', addr);
  url.searchParams.set('benchmark', CENSUS_BENCHMARK);
  url.searchParams.set('vintage', CENSUS_VINTAGE);
  url.searchParams.set('format', 'json');

  let resp;
  try {
    resp = await doFetch(url.toString(), { method: 'GET' });
  } catch (e) {
    return { status: 'unavailable' };
  }
  if (!resp || (typeof resp.status === 'number' && resp.status >= 400)) {
    return { status: 'unavailable' };
  }

  let body;
  try {
    body = await resp.json();
  } catch (e) {
    return { status: 'unavailable' };
  }

  const result = (body && body.result) || {};
  const matches = result.addressMatches || [];
  if (!Array.isArray(matches) || matches.length === 0) {
    return { status: 'not_found' };
  }
  const coords = (matches[0] && matches[0].coordinates) || {};
  const lat = coords.y;
  const lon = coords.x;
  if (lat === null || lat === undefined || lon === null || lon === undefined) {
    return { status: 'not_found' };
  }
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return { status: 'not_found' };
  }
  return { status: 'ok', coord: { lat: latNum, lon: lonNum }, county: extractCounty(matches[0]) };
}

/**
 * Pull the bare county name (e.g. "Allegheny") from a Census geographies match.
 * Returns null when the Counties geography layer is absent or empty — callers
 * must treat null as "county unknown" and never substitute a guess.
 */
function extractCounty(match) {
  const geos = match && match.geographies;
  if (!geos || typeof geos !== 'object') return null;
  const counties = geos[CENSUS_COUNTY_LAYER];
  if (!Array.isArray(counties) || counties.length === 0) return null;
  const c = counties[0] || {};
  // BASENAME is the bare name ("Allegheny"); NAME may carry a " County" suffix.
  let name = c.BASENAME || c.NAME || null;
  if (name === null || name === undefined) return null;
  name = String(name).trim().replace(/\s+County$/i, '');
  return name || null;
}

module.exports = { CENSUS_GEOCODER_URL, CENSUS_BENCHMARK, CENSUS_VINTAGE, geocodeAddress };

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
 *   { status: 'ok',          coord: {lat, lon} }   -- a usable match
 *   { status: 'not_found' }                          -- geocoder reachable, 0 matches
 *   { status: 'unavailable' }                        -- network / HTTP / parse error
 * Never throws. Note the Census API returns coordinates as {x: lon, y: lat}.
 *
 * NOTE: the raw address is used only to build the outbound request URL. It is
 * NEVER logged or persisted here (preserve the "No address is stored" promise).
 */

const CENSUS_GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const CENSUS_BENCHMARK = 'Public_AR_Current';

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
  return { status: 'ok', coord: { lat: latNum, lon: lonNum } };
}

module.exports = { CENSUS_GEOCODER_URL, CENSUS_BENCHMARK, geocodeAddress };

'use strict';
/**
 * Census geocode helper for the Worker.
 *
 * Mirrors the endpoint + response parsing of geocoder.py:geocode_address but
 * accepts an injectable `fetchFn` so tests MOCK it and no live network is hit
 * locally. A live Census call only happens at runtime AFTER deploy, using the
 * Worker runtime's global fetch.
 *
 * Same contract as the Python side: returns {lat, lon} on success or null
 * (never throws) on no-match / malformed response / network error. Note the
 * Census API returns coordinates as {x: lon, y: lat}.
 */

const CENSUS_GEOCODER_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const CENSUS_BENCHMARK = 'Public_AR_Current';

/**
 * Geocode a one-line address string to {lat, lon} via the Census API.
 *
 * @param {string} address      one-line address
 * @param {Function} fetchFn    fetch-compatible (url, init) -> Promise<Response>
 * @returns {Promise<{lat:number, lon:number}|null>}
 */
async function geocodeAddress(address, fetchFn) {
  const addr = String(address || '').trim();
  if (!addr) {
    return null;
  }
  const doFetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) {
    return null;
  }

  const url = new URL(CENSUS_GEOCODER_URL);
  url.searchParams.set('address', addr);
  url.searchParams.set('benchmark', CENSUS_BENCHMARK);
  url.searchParams.set('format', 'json');

  let resp;
  try {
    resp = await doFetch(url.toString(), { method: 'GET' });
  } catch (e) {
    return null;
  }
  if (!resp || (typeof resp.status === 'number' && resp.status >= 400)) {
    return null;
  }

  let body;
  try {
    body = await resp.json();
  } catch (e) {
    return null;
  }

  const result = (body && body.result) || {};
  const matches = result.addressMatches || [];
  if (!Array.isArray(matches) || matches.length === 0) {
    return null;
  }
  const coords = (matches[0] && matches[0].coordinates) || {};
  const lat = coords.y;
  const lon = coords.x;
  if (lat === null || lat === undefined || lon === null || lon === undefined) {
    return null;
  }
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return null;
  }
  return { lat: latNum, lon: lonNum };
}

module.exports = { CENSUS_GEOCODER_URL, CENSUS_BENCHMARK, geocodeAddress };

'use strict';
/**
 * Rehabber DRIVING-distance helper for the Worker.
 *
 * SCOPE: rehabbers ONLY. Rehabber coordinates are PUBLIC (docs/data/
 * rehabbers.json, already loaded in-browser), so it is PII-safe to send them
 * through the Worker. The volunteer radius filter is explicitly NOT touched
 * here (it is PII-pinned and deferred per docs/DISTANCE_PROVIDER_SCOPING.md).
 *
 * WHY WORKER-SIDE: the OpenRouteService (ORS) API key must NOT be exposed in
 * the browser. The browser POSTs { origin, destinations } here; the Worker
 * calls the ORS Matrix API with the env key and returns driving distance +
 * duration parallel to the destinations array.
 *
 * GRACEFUL DEGRADATION: if the ORS key is missing/empty, or the ORS call
 * errors / times out / returns a malformed body, this returns HAVERSINE
 * straight-line distances with duration_min: null. The panel must never break.
 *
 * Contract (per destination, parallel to the input array):
 *   { distance_mi: number, duration_min: number|null }
 * plus a top-level `source`: 'ors' | 'haversine' so the caller/tests can tell
 * which path produced the numbers.
 *
 * This module is a pure CommonJS function with an injectable fetchFn so it is
 * fully unit-testable with NO live network.
 */

const { haversineMi } = require('./aggregate');

// ORS Matrix endpoint for the driving-car profile.
const ORS_MATRIX_URL = 'https://api.openrouteservice.org/v2/matrix/driving-car';

// Conversions for the ORS response (metres / seconds) -> the panel's units.
const METERS_PER_MILE = 1609.344;
const SECONDS_PER_MINUTE = 60;

// Default abort timeout for the ORS call (ms). Kept short so a slow provider
// degrades to haversine quickly rather than hanging the panel.
const DEFAULT_TIMEOUT_MS = 6000;

// ORS rejects very large matrices; the panel only ever asks for the top few
// rehabbers, but cap defensively so a runaway request can't be built.
const MAX_DESTINATIONS = 50;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function isFiniteNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Validate a {lat, lon} point. Returns a clean numeric point or null.
 */
function cleanPoint(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * Build the straight-line fallback result: haversine miles, no driving time.
 */
function haversineFallback(origin, destinations) {
  const distances = destinations.map(function (d) {
    if (!d) return { distance_mi: null, duration_min: null };
    return {
      distance_mi: round1(haversineMi(origin.lat, origin.lon, d.lat, d.lon)),
      duration_min: null,
    };
  });
  return { source: 'haversine', distances: distances };
}

/**
 * Compute driving distance + duration for each destination from an origin.
 *
 * @param {{lat:number,lon:number}} originRaw   the ranking origin
 * @param {Array<{lat:number,lon:number}>} destinationsRaw  rehabber coords
 * @param {string} apiKey   ORS_API_KEY (may be empty/undefined -> fallback)
 * @param {Function} fetchFn  fetch-compatible (url, init) -> Promise<Response>
 * @param {Object} [opts]    { timeoutMs }
 * @returns {Promise<{source:'ors'|'haversine',
 *                     distances:Array<{distance_mi:number|null,
 *                                      duration_min:number|null}>}>}
 *
 * Never throws. Always returns one entry per input destination, in order.
 */
async function rehabberDistances(originRaw, destinationsRaw, apiKey, fetchFn, opts) {
  const origin = cleanPoint(originRaw);
  const destinations = Array.isArray(destinationsRaw)
    ? destinationsRaw.map(cleanPoint)
    : [];

  // No usable origin -> nothing we can measure; return nulls of the right length.
  if (!origin) {
    return {
      source: 'haversine',
      distances: destinations.map(function () {
        return { distance_mi: null, duration_min: null };
      }),
    };
  }

  // No driving key, no usable fetch, or too many destinations -> haversine.
  const key = (apiKey === null || apiKey === undefined) ? '' : String(apiKey).trim();
  const doFetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!key || !doFetch || destinations.length === 0 || destinations.length > MAX_DESTINATIONS) {
    return haversineFallback(origin, destinations);
  }

  // ORS expects [lon, lat] tuples. Locations are origin first, then all the
  // destinations; sources=[0], destinations=[1..N].
  const locations = [[origin.lon, origin.lat]];
  const destIndex = [];
  for (let i = 0; i < destinations.length; i += 1) {
    const d = destinations[i];
    if (d) {
      destIndex.push(locations.length);
      locations.push([d.lon, d.lat]);
    } else {
      destIndex.push(null);
    }
  }
  // Every destination was invalid -> nothing for ORS to do.
  if (locations.length === 1) {
    return haversineFallback(origin, destinations);
  }

  const payload = {
    locations: locations,
    sources: [0],
    destinations: destIndex.filter(function (x) { return x !== null; }),
    metrics: ['distance', 'duration'],
    units: 'm',
  };

  const timeoutMs = (opts && isFiniteNum(opts.timeoutMs)) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  let controller = null;
  let timer = null;
  if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
    timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, timeoutMs);
  }

  let resp;
  try {
    resp = await doFetch(ORS_MATRIX_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: key,
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
  } catch (e) {
    return haversineFallback(origin, destinations);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!resp || (typeof resp.status === 'number' && resp.status >= 400)) {
    return haversineFallback(origin, destinations);
  }

  let body;
  try {
    body = await resp.json();
  } catch (e) {
    return haversineFallback(origin, destinations);
  }

  // ORS returns distances[srcIdx][destIdx] (metres) + durations[][] (seconds).
  const distMatrix = body && Array.isArray(body.distances) ? body.distances[0] : null;
  const durMatrix = body && Array.isArray(body.durations) ? body.durations[0] : null;
  if (!Array.isArray(distMatrix)) {
    return haversineFallback(origin, destinations);
  }

  // Map the ORS rows (one per non-null destination) back to the original
  // destination order. A null/invalid cell falls back to haversine for that
  // single row so a partial ORS answer still yields a complete list.
  let cursor = 0;
  const distances = destinations.map(function (d, i) {
    if (!d) return { distance_mi: null, duration_min: null };
    const orsDist = distMatrix[cursor];
    const orsDur = durMatrix ? durMatrix[cursor] : null;
    cursor += 1;
    if (isFiniteNum(orsDist)) {
      return {
        distance_mi: round1(orsDist / METERS_PER_MILE),
        duration_min: isFiniteNum(orsDur) ? Math.round(orsDur / SECONDS_PER_MINUTE) : null,
      };
    }
    // ORS could not route this single pair -> straight-line for this row only.
    return {
      distance_mi: round1(haversineMi(origin.lat, origin.lon, d.lat, d.lon)),
      duration_min: null,
    };
  });

  return { source: 'ors', distances: distances };
}

module.exports = {
  ORS_MATRIX_URL,
  METERS_PER_MILE,
  DEFAULT_TIMEOUT_MS,
  MAX_DESTINATIONS,
  cleanPoint,
  haversineFallback,
  rehabberDistances,
};

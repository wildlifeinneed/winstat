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

// Safe per-request destination count for an ORS Matrix call. ORS limits the
// number of locations per matrix request (free-tier driving-car is small);
// 1 origin + up to this many destinations stays comfortably under the cap.
// The volunteer driving path CHUNKS the prescreened subset into batches of
// this size so a large in-radius set still works (and never blows the limit).
const MAX_MATRIX_DESTINATIONS = 50;

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
 * LOW-LEVEL ORS Matrix call for a SINGLE batch (1 origin -> N destinations).
 *
 * Shared by rehabberDistances() (public rehabber path) and the volunteer
 * driving-distance path. Sends BARE [lon,lat] coordinate tuples only -- never
 * names/addresses/any other field -- via the env ORS_API_KEY, with an
 * AbortController timeout. NEVER throws.
 *
 * @param {{lat:number,lon:number}} origin   already-cleaned origin point
 * @param {Array<{lat:number,lon:number}>} cleanDests  already-cleaned points
 *        (NO nulls -- caller filters first)
 * @param {string} key     non-empty ORS API key
 * @param {Function} doFetch  fetch-compatible (url, init) -> Promise<Response>
 * @param {Object} [opts]  { timeoutMs, metrics }
 * @returns {Promise<{distances:number[]|null, durations:number[]|null}>}
 *        distances/durations are parallel to cleanDests (metres / seconds), or
 *        null on any error/timeout/malformed body.
 */
async function orsMatrixBatch(origin, cleanDests, key, doFetch, opts) {
  if (!origin || !Array.isArray(cleanDests) || cleanDests.length === 0) {
    return { distances: null, durations: null };
  }

  // ORS expects [lon, lat] tuples: origin first, destinations after.
  const locations = [[origin.lon, origin.lat]];
  const destIdx = [];
  for (let i = 0; i < cleanDests.length; i += 1) {
    destIdx.push(locations.length);
    locations.push([cleanDests[i].lon, cleanDests[i].lat]);
  }

  const metrics =
    opts && Array.isArray(opts.metrics) ? opts.metrics : ['distance', 'duration'];
  const payload = {
    locations: locations,
    sources: [0],
    destinations: destIdx,
    metrics: metrics,
    units: 'm',
  };

  const timeoutMs =
    opts && isFiniteNum(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  let controller = null;
  let timer = null;
  if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
    timer = setTimeout(function () {
      try { controller.abort(); } catch (e) {}
    }, timeoutMs);
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
    return { distances: null, durations: null };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!resp || (typeof resp.status === 'number' && resp.status >= 400)) {
    return { distances: null, durations: null };
  }

  let body;
  try {
    body = await resp.json();
  } catch (e) {
    return { distances: null, durations: null };
  }

  const distMatrix = body && Array.isArray(body.distances) ? body.distances[0] : null;
  const durMatrix = body && Array.isArray(body.durations) ? body.durations[0] : null;
  if (!Array.isArray(distMatrix)) {
    return { distances: null, durations: null };
  }
  return { distances: distMatrix, durations: durMatrix || null };
}

/**
 * DRIVING distances (miles) for the VOLUNTEER radius path.
 *
 * Given an origin (animal) and an array of already-cleaned destination points
 * (prescreened volunteer coords), call ORS Matrix driving-car in CHUNKS of at
 * most MAX_MATRIX_DESTINATIONS and return the driving distance in MILES per
 * destination, parallel to the input array.
 *
 * PII: only BARE [lon,lat] tuples are sent to ORS (no names/addresses) -- the
 * caller is responsible for passing coords only. This helper returns ONLY an
 * array of numbers (or nulls); it never echoes any volunteer datum.
 *
 * Failure semantics (whole-call, NOT per-row): if the key is empty, fetch is
 * unusable, or ANY chunk errors/times out/returns a malformed body, this
 * returns { ok: false } so the caller can fall back to the haversine prescreen
 * for the ENTIRE set (deterministic distance_mode). On success it returns
 * { ok: true, milesByIndex: number[] } where each entry is driving miles for
 * the corresponding destination (a single unroutable cell falls back to that
 * destination's straight-line distance so the array is always complete).
 *
 * Never throws.
 *
 * @param {{lat:number,lon:number}} origin    cleaned origin (animal) point
 * @param {Array<{lat:number,lon:number}>} cleanDests  cleaned dest points
 * @param {string} apiKey   ORS_API_KEY (empty/undefined -> ok:false)
 * @param {Function} fetchFn  fetch-compatible (url, init) -> Promise<Response>
 * @param {Object} [opts]   { timeoutMs, chunkSize }
 * @returns {Promise<{ok:boolean, milesByIndex?:Array<number>}>}
 */
async function drivingDistancesMiles(origin, cleanDests, apiKey, fetchFn, opts) {
  const key = apiKey === null || apiKey === undefined ? '' : String(apiKey).trim();
  const doFetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  const dests = Array.isArray(cleanDests) ? cleanDests : [];

  if (!origin || !key || !doFetch || dests.length === 0) {
    return { ok: false };
  }

  let chunkSize =
    opts && isFiniteNum(opts.chunkSize) && opts.chunkSize > 0
      ? Math.floor(opts.chunkSize)
      : MAX_MATRIX_DESTINATIONS;
  if (chunkSize > MAX_MATRIX_DESTINATIONS) chunkSize = MAX_MATRIX_DESTINATIONS;

  const milesByIndex = new Array(dests.length).fill(null);
  for (let start = 0; start < dests.length; start += chunkSize) {
    const batch = dests.slice(start, start + chunkSize);
    const res = await orsMatrixBatch(origin, batch, key, doFetch, opts);
    if (!res || !Array.isArray(res.distances)) {
      // Any chunk failure aborts the whole driving attempt -> caller falls
      // back to the prescreen haversine set for a consistent distance_mode.
      return { ok: false };
    }
    for (let i = 0; i < batch.length; i += 1) {
      const m = res.distances[i];
      if (isFiniteNum(m)) {
        milesByIndex[start + i] = m / METERS_PER_MILE;
      } else {
        // ORS could not route this single pair -> straight-line for it only.
        milesByIndex[start + i] = haversineMi(
          origin.lat, origin.lon, batch[i].lat, batch[i].lon
        );
      }
    }
  }
  return { ok: true, milesByIndex: milesByIndex };
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
  MAX_MATRIX_DESTINATIONS,
  cleanPoint,
  haversineFallback,
  orsMatrixBatch,
  drivingDistancesMiles,
  rehabberDistances,
};

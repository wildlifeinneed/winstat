'use strict';
/**
 * Local unit tests for the Dispatcher Worker -- PLAIN Node, NO install, NO live
 * network, NO real KV. Runnable on the repo's Node (incl. Node 12) via:
 *
 *     node worker/test/run.test.js
 *
 * Why not vitest/@cloudflare/vitest-pool-workers/miniflare?  The local
 * toolchain is Node v12, and those runners require Node 18+. Per the task's
 * fallback clause we therefore exercise the EXTRACTED pure logic + the pure
 * request handler with mocked KV / Census / Response. This validates the exact
 * same code that index.mjs ships to Cloudflare.
 *
 * Coverage:
 *   (a) correct aggregate for a known synthetic coord set
 *   (b) radius clamp (>100 -> 100; default 20; negative -> 0)
 *   (c) 400 on bad input (missing location; invalid radius; unresolvable addr)
 *   (d) success response contains {total_in_range, role_counts, win_areas}
 *       plus the dispatcher-entered animal_lat/animal_lon (safe, not volunteer
 *       PII) -- assert NO name/lat/lon/address/home_county keys leak
 *   (e) CORS header present on success, error and preflight responses
 *   + address geocode path uses MOCKED Census (no live call)
 */

const assert = require('assert');

const {
  clampRadius,
  haversineMi,
  findVolunteersInRadius,
  findVolunteersInRadiusDriving,
  findContextRows,
  findContextRowsDriving,
  buildAggregateResponse,
  buildTier2Response,
  isAvailableRecord,
  rolesOf,
  normalizeRole,
  parseQualifyRoles,
  rowQualifies,
  DEFAULT_RADIUS_MI,
  MAX_RADIUS_MI,
  DEFAULT_MARGINAL_THRESHOLD,
} = require('../src/aggregate');
const { geocodeAddress } = require('../src/census');
const { autocompleteAddress, photonGeocode, looksLikeFullAddress, looksLikeIntersection, hasHouseNumberMatch, censusAutocompleteFallback } = require('../src/autocomplete');
const { rehabberDistances, drivingDistancesMiles, MAX_MATRIX_DESTINATIONS } = require('../src/distance');
const { handleRequest } = require('../src/handler');

// --- tiny test framework ---------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log('  PASS  ' + name);
    })
    .catch((err) => {
      failed += 1;
      failures.push({ name, err });
      console.log('  FAIL  ' + name + ' -> ' + (err && err.message));
    });
}

// --- mocks -----------------------------------------------------------------

// Minimal Response stand-in that records what the handler produced.
class MockResponse {
  constructor(body, init) {
    this.body = body;
    init = init || {};
    this.status = init.status === undefined ? 200 : init.status;
    this.headers = new Map(Object.entries(init.headers || {}));
  }
  async json() {
    return JSON.parse(this.body);
  }
  header(name) {
    return this.headers.get(name);
  }
}

// Minimal request stand-in (query string + optional JSON body).
function mockRequest(method, query, jsonBody) {
  const qs = query
    ? '?' +
      Object.keys(query)
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
        .join('&')
    : '';
  return {
    method,
    url: 'https://worker.example/' + qs,
    json: async () => {
      if (jsonBody === undefined) throw new Error('no body');
      return jsonBody;
    },
  };
}

// Mock KV binding backed by an in-memory JSON string.
function mockKV(coordsArray) {
  return {
    get: async (key) => {
      if (key !== 'volunteer_coords') return null;
      return JSON.stringify(coordsArray);
    },
  };
}

// Mock Census fetch -> deterministic match (x=lon, y=lat), no network.
function mockCensusFetch(lat, lon) {
  return async (url) => ({
    status: 200,
    json: async () => ({
      result: {
        addressMatches: [{ coordinates: { x: lon, y: lat } }],
      },
    }),
  });
}

// Mock Census GEOGRAPHIES fetch -> match WITH a Counties layer so the handler
// can derive animal_county + animal_area. Mirrors the real geographies endpoint
// shape: addressMatches[].geographies.Counties[].BASENAME.
function mockCensusFetchWithCounty(lat, lon, countyBasename) {
  return async (url) => ({
    status: 200,
    json: async () => ({
      result: {
        addressMatches: [{
          coordinates: { x: lon, y: lat },
          geographies: { Counties: [{ BASENAME: countyBasename }] },
        }],
      },
    }),
  });
}

// Mock Census fetch that returns NO match (reachable, zero matches).
const mockCensusNoMatch = async () => ({
  status: 200,
  json: async () => ({ result: { addressMatches: [] } }),
});

// Mock Census fetch that errors at the network layer (geocoder unavailable).
const mockCensusNetworkError = async () => {
  throw new Error('network down');
};

// Mock Photon autocomplete fetch -> two US features + one non-US (filtered).
function mockPhotonFetch() {
  return async (url) => ({
    status: 200,
    json: async () => ({
      features: [
        {
          geometry: { type: 'Point', coordinates: [-79.9569, 40.4443] },
          properties: {
            housenumber: '4400', street: 'Forbes Avenue', city: 'Pittsburgh',
            state: 'Pennsylvania', postcode: '15213', countrycode: 'US',
            country: 'United States',
          },
        },
        {
          geometry: { type: 'Point', coordinates: [-79.95, 40.44] },
          properties: {
            name: 'Forbes Field', city: 'Pittsburgh', state: 'Pennsylvania',
            countrycode: 'US', country: 'United States',
          },
        },
        {
          // Non-US — MUST be filtered out.
          geometry: { type: 'Point', coordinates: [-0.12, 51.5] },
          properties: { street: 'Forbes Street', city: 'London', countrycode: 'GB', country: 'United Kingdom' },
        },
      ],
    }),
  });
}

// Mock Photon fetch that errors at the network layer.
const mockPhotonNetworkError = async () => { throw new Error('photon down'); };

// Mock Photon fetch that returns an HTTP error.
const mockPhotonHttpError = async () => ({ status: 503, json: async () => ({}) });

// --- ORS Matrix mocks (rehabber DRIVING distance) --------------------------
// Captures the request so a test can assert the Worker sent [lon,lat] tuples
// and the Authorization key. Returns metres/seconds matrices ORS-style.
function mockOrsFetch(distancesM, durationsS, captured) {
  return async (url, init) => {
    if (captured) {
      captured.url = url;
      captured.init = init;
      try { captured.body = JSON.parse(init.body); } catch (e) { captured.body = null; }
    }
    return {
      status: 200,
      json: async () => ({ distances: [distancesM], durations: [durationsS] }),
    };
  };
}

// Mock ORS fetch that errors at the network layer (provider down/timeout).
const mockOrsNetworkError = async () => { throw new Error('ors down'); };

// Mock ORS fetch that returns an HTTP error status.
const mockOrsHttpError = async () => ({ status: 500, json: async () => ({}) });


// --- synthetic PRIVATE coords dataset --------------------------------------
// Animal anchor for distance tests: Harrisburg PA approx.
const ANIMAL = { lat: 40.2732, lon: -76.8867 };

// Known set: 3 within ~20mi, 1 far away (~80mi+), 1 invalid (no coords).
const COORDS = [
  // ~0 mi, roles C&T + COURIER, area WIN-1
  { lat: 40.2732, lon: -76.8867, roles: ['C&T', 'COURIER'], home_county: 'Dauphin', win_area: 'WIN-1' },
  // ~8 mi NE, role rvs c&t (lowercase -> normalizes), area WIN-2
  { lat: 40.36, lon: -76.78, roles: ['rvs c&t'], home_county: 'Lebanon', win_area: 'WIN-2' },
  // ~12 mi, role COURIER, area WIN-1 (dup area)
  { lat: 40.10, lon: -76.75, roles: ['Courier'], home_county: 'Lancaster', win_area: 'WIN-1' },
  // ~50 mi west (out at 20mi, in at 100mi), role C&T, area WIN-9
  { lat: 40.33, lon: -77.95, roles: ['C&T'], home_county: 'Huntingdon', win_area: 'WIN-9' },
  // invalid record -> skipped
  { lat: null, lon: null, roles: ['C&T'], home_county: 'Nowhere', win_area: 'WIN-X' },
];

const PII_FORBIDDEN_KEYS = [
  'name', 'rehab_name', 'lat', 'lon', 'latitude', 'longitude',
  'address', 'home_county', 'roles', '_addr_sig', 'coords', 'coordinates',
];

async function main() {
  console.log('Dispatcher Worker local tests (Node ' + process.version + ')\n');

  // (a) correct aggregate for a known set --------------------------------
  await test('(a) aggregate counts/areas correct within 20mi', () => {
    const agg = findVolunteersInRadius(ANIMAL.lat, ANIMAL.lon, 20, COORDS);
    assert.strictEqual(agg.total_in_range, 3, 'expected 3 in range');
    assert.strictEqual(agg.role_counts['C&T'], 1, 'C&T count');
    assert.strictEqual(agg.role_counts['RVS C&T'], 1, 'RVS C&T count');
    assert.strictEqual(agg.role_counts['COURIER'], 2, 'COURIER count');
    assert.deepStrictEqual(agg.win_areas, ['WIN-1', 'WIN-2'], 'sorted distinct areas');
    // Records here carry NO `available` field -> default-available (mirrors
    // DEFAULT_AVAILABLE_WHEN_BLANK=True), so available == counts.
    assert.strictEqual(agg.total_available, 3, 'all default-available');
    assert.strictEqual(agg.role_available['C&T'], 1);
    assert.strictEqual(agg.role_available['RVS C&T'], 1);
    assert.strictEqual(agg.role_available['COURIER'], 2);
  });

  await test('(a2) larger radius pulls in the far volunteer', () => {
    const agg = findVolunteersInRadius(ANIMAL.lat, ANIMAL.lon, 100, COORDS);
    assert.strictEqual(agg.total_in_range, 4, 'expected 4 in range at 100mi');
    assert.strictEqual(agg.role_counts['C&T'], 2, 'C&T now includes far one');
    assert.deepStrictEqual(agg.win_areas, ['WIN-1', 'WIN-2', 'WIN-9']);
  });

  // (b) radius clamp -----------------------------------------------------
  await test('(b) clampRadius: >max -> 100, missing -> default 20, neg -> 0', () => {
    assert.strictEqual(clampRadius(500), MAX_RADIUS_MI);
    assert.strictEqual(clampRadius(null), DEFAULT_RADIUS_MI);
    assert.strictEqual(clampRadius(undefined), DEFAULT_RADIUS_MI);
    assert.strictEqual(clampRadius('abc'), DEFAULT_RADIUS_MI);
    assert.strictEqual(clampRadius(-5), 0);
    assert.strictEqual(clampRadius(33), 33);
  });

  await test('(b2) radius clamp applied end-to-end (5000 -> 100mi behavior)', () => {
    const agg = findVolunteersInRadius(ANIMAL.lat, ANIMAL.lon, 5000, COORDS);
    // clamped to 100mi -> still 4 (far volunteer ~ within 100mi straight-line)
    assert.strictEqual(agg.total_in_range, 4);
  });

  await test('(b3) haversine ~ matches known Harrisburg->Pittsburgh distance', () => {
    const d = haversineMi(40.2732, -76.8867, 40.4406, -79.9959);
    assert.ok(d > 150 && d < 175, 'expected ~163mi straight-line, got ' + d);
  });

  // (c) 400 on bad input -------------------------------------------------
  await test('(c1) 400 when no location params', async () => {
    const res = await handleRequest(mockRequest('GET', {}), {
      ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example',
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error, 'missing_location');
  });

  await test('(c2) 400 on invalid radius', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: 40.27, animal_lon: -76.88, radius_mi: 'NaNnope' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, 'invalid_radius');
  });

  await test('(c3) 422 address_not_found on unresolvable address (mocked no-match)', async () => {
    const res = await handleRequest(
      mockRequest('GET', { address: '123 Nowhere Rd' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: mockCensusNoMatch, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 422);
    const body = await res.json();
    assert.strictEqual(body.error, 'address_not_found');
    // Geocode failed -> no animal coords are present (frontend handles absence).
    assert.strictEqual(body.animal_lat, undefined, 'no animal_lat on geocode failure');
    assert.strictEqual(body.animal_lon, undefined, 'no animal_lon on geocode failure');
  });

  await test('(c3b) 502 geocoder_unavailable on Census network error', async () => {
    const res = await handleRequest(
      mockRequest('GET', { address: '4400 Forbes Ave, Pittsburgh, PA 15213' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: mockCensusNetworkError, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 502);
    const body = await res.json();
    assert.strictEqual(body.error, 'geocoder_unavailable');
    assert.strictEqual(body.animal_lat, undefined, 'no animal_lat when geocoder unavailable');
    assert.strictEqual(body.animal_lon, undefined, 'no animal_lon when geocoder unavailable');
  });

  await test('(c3c) Census not_found -> Photon fallback resolves -> 200 with animal coords', async () => {
    // Shared fetchFn routed by host: Census returns ZERO matches, but the
    // server-side Photon fallback resolves the SAME string to a coordinate.
    const fallbackFetch = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        return { status: 200, json: async () => ({ result: { addressMatches: [] } }) };
      }
      // Photon host: return one US candidate with coords.
      return {
        status: 200,
        json: async () => ({
          features: [{
            geometry: { type: 'Point', coordinates: [-77.8, 40.9] },
            properties: {
              street: 'Rural Route 1', city: 'Coudersport', state: 'Pennsylvania',
              countrycode: 'US', country: 'United States',
            },
          }],
        }),
      };
    };
    const res = await handleRequest(
      mockRequest('GET', { address: 'Rural Route 1, Coudersport, PA' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: fallbackFetch, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200, 'Photon fallback yields a usable location');
    const body = await res.json();
    assert.strictEqual(body.animal_lat, 40.9, 'animal_lat from Photon fallback');
    assert.strictEqual(body.animal_lon, -77.8, 'animal_lon from Photon fallback');
    // Photon carries no county layer, but POINT-IN-POLYGON now derives the
    // county/area/geoid from the FINAL coord -> never null on the Photon path.
    assert.strictEqual(body.animal_county, 'Centre', 'PIP fills county on the Photon fallback path');
    assert.strictEqual(body.animal_area, '7', 'PIP fills WIN area on the Photon fallback path');
    assert.strictEqual(body.animal_geoid, '42027', 'PIP fills geoid on the Photon fallback path');
  });

  await test('(c3d) 422 address_not_found only when BOTH Census and Photon fail', async () => {
    // Census no-match AND Photon returns zero features -> dead-end 422.
    const bothFail = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        return { status: 200, json: async () => ({ result: { addressMatches: [] } }) };
      }
      return { status: 200, json: async () => ({ features: [] }) };
    };
    const res = await handleRequest(
      mockRequest('GET', { address: '123 Nowhere Rd' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: bothFail, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 422);
    assert.strictEqual((await res.json()).error, 'address_not_found');
  });

  // (c3e-f) INTERSECTION SUBMIT path: Census `geographies` returns HTTP 4xx
  // for "&"-style intersection input. The old code short-circuited directly to
  // geocoder_unavailable (502) without trying Photon. The fix tries Photon first
  // and, when both fail, returns address_not_found (422) instead of 502 so the
  // UI never shows "Address lookup service is temporarily unavailable" for a
  // known-unsupported input format.
  await test('(c3e) intersection submit: Census HTTP 4xx -> Photon fallback resolves -> 200', async () => {
    const fetch4xx = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        return { status: 400, json: async () => ({}) };
      }
      // Photon returns a PA street-level candidate near the intersection.
      return {
        status: 200,
        json: async () => ({
          features: [{
            geometry: { type: 'Point', coordinates: [-79.8375, 40.4989] },
            properties: {
              street: 'Elliott Street', city: 'Penn Hills', state: 'Pennsylvania',
              countrycode: 'US', country: 'United States',
            },
          }],
        }),
      };
    };
    const res = await handleRequest(
      mockRequest('GET', { address: 'Elliott St & Verona Rd, Penn Hills Township, PA' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: fetch4xx, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200, 'Photon fallback yields usable location when Census 4xx');
    const body = await res.json();
    assert.ok(Math.abs(body.animal_lat - 40.4989) < 1e-6, 'animal_lat from Photon');
    assert.ok(Math.abs(body.animal_lon - (-79.8375)) < 1e-6, 'animal_lon from Photon');
  });

  await test('(c3f) intersection submit: Census HTTP 4xx + Photon fails -> 422 not 502', async () => {
    // Census returns HTTP 400 AND Photon returns empty. The fix must return
    // address_not_found (422) NOT geocoder_unavailable (502) for intersections.
    const bothFail4xx = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        return { status: 400, json: async () => ({}) };
      }
      return { status: 200, json: async () => ({ features: [] }) };
    };
    const res = await handleRequest(
      mockRequest('GET', { address: 'Elliott St & Verona Rd, Penn Hills Township, PA' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: bothFail4xx, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 422, 'intersection with both failing -> address_not_found not geocoder_unavailable');
    assert.strictEqual((await res.json()).error, 'address_not_found');
  });

  await test('(c4) 400 on out-of-range lat/lon', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: 999, animal_lon: -76.88 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 400);
  });

  // (d) PII-free key set on success --------------------------------------
  await test('(d) success body has {total_in_range, role_counts, win_areas} + animal coords', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const keys = Object.keys(body).sort();
    assert.deepStrictEqual(keys, ['animal_area', 'animal_county', 'animal_geoid', 'animal_lat', 'animal_lon', 'distance_mode', 'role_counts', 'total_in_range', 'win_areas'],
      'exact top-level key set, got: ' + JSON.stringify(keys));
    // No ORS key supplied in deps -> driving falls back to straight_line.
    assert.strictEqual(body.distance_mode, 'straight_line', 'fallback mode without ORS key');
    // The dispatcher-entered animal coord is echoed back (safe, not PII).
    assert.strictEqual(body.animal_lat, ANIMAL.lat, 'animal_lat echoed');
    assert.strictEqual(body.animal_lon, ANIMAL.lon, 'animal_lon echoed');
    assert.strictEqual(typeof body.animal_lat, 'number');
    assert.strictEqual(typeof body.animal_lon, 'number');
    // Deep scan: no forbidden PII key anywhere in the serialized response.
    const serialized = JSON.stringify(body);
    for (const k of PII_FORBIDDEN_KEYS) {
      assert.ok(serialized.indexOf('"' + k + '"') === -1,
        'PII key leaked: ' + k + ' in ' + serialized);
    }
    // role_counts inner keys are only the 3 canonical roles.
    assert.deepStrictEqual(Object.keys(body.role_counts).sort(), ['C&T', 'COURIER', 'RVS C&T']);
  });

  await test('(d2) address path returns aggregate + geocoded animal coords (mocked Census)', async () => {
    const res = await handleRequest(
      mockRequest('GET', { address: '1 Capitol, Harrisburg PA', radius_mi: 20 }),
      {
        ResponseCtor: MockResponse,
        kv: mockKV(COORDS),
        fetchFn: mockCensusFetch(ANIMAL.lat, ANIMAL.lon),
        allowedOrigin: 'https://pages.example',
      }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(Object.keys(body).sort(),
      ['animal_area', 'animal_county', 'animal_geoid', 'animal_lat', 'animal_lon', 'distance_mode', 'role_counts', 'total_in_range', 'win_areas']);
    assert.strictEqual(body.total_in_range, 3);
    // animal coords come from the geocoder on the address path.
    assert.strictEqual(body.animal_lat, ANIMAL.lat, 'geocoded animal_lat present');
    assert.strictEqual(body.animal_lon, ANIMAL.lon, 'geocoded animal_lon present');
    // Census mock has no Counties layer, but POINT-IN-POLYGON derives county/
    // area/geoid from the FINAL coord (Harrisburg -> Dauphin) -> never null.
    assert.strictEqual(body.animal_county, 'Dauphin', 'PIP fills county even when geocoder omits Counties layer');
    assert.strictEqual(body.animal_area, '13', 'PIP fills WIN area from the coord');
    assert.strictEqual(body.animal_geoid, '42043', 'PIP fills geoid from the coord');
  });

  await test('(d4) address path WITH Census county -> animal_county + animal_area mapped', async () => {
    const res = await handleRequest(
      mockRequest('GET', { address: '436 Grant St, Pittsburgh PA', radius_mi: 20 }),
      {
        ResponseCtor: MockResponse,
        kv: mockKV(COORDS),
        // Census geographies mock returns a real Pittsburgh coord + Allegheny.
        // POINT-IN-POLYGON resolves the SAME county/area/geoid from that coord.
        fetchFn: mockCensusFetchWithCounty(40.4443, -79.9569, 'Allegheny'),
        allowedOrigin: 'https://pages.example',
      }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.animal_county, 'Allegheny', 'county resolved from the final coord');
    assert.strictEqual(body.animal_area, '10', 'Allegheny -> WIN Area 10');
    assert.strictEqual(body.animal_geoid, '42003', 'Allegheny geoid from PIP');
    assert.strictEqual(body.animal_lat, 40.4443, 'animal coords still echoed');
    assert.strictEqual(body.animal_lon, -79.9569);
    // Still PII-free: county/area describe the ANIMAL, not any volunteer.
    const ser = JSON.stringify(body);
    for (const k of PII_FORBIDDEN_KEYS) {
      assert.strictEqual(ser.indexOf('"' + k + '"'), -1, 'PII key leaked: ' + k);
    }
  });

  await test('(d3) POST body path works and carries animal coords', async () => {
    const res = await handleRequest(
      mockRequest('POST', {}, { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(await res.json()).sort(),
      ['animal_area', 'animal_county', 'animal_geoid', 'animal_lat', 'animal_lon', 'distance_mode', 'role_counts', 'total_in_range', 'win_areas']);
  });

  // (e) CORS header present ----------------------------------------------
  await test('(e1) CORS header present on success', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.header('Access-Control-Allow-Origin'), 'https://pages.example');
  });

  await test('(e2) CORS header present on 400 error', async () => {
    const res = await handleRequest(mockRequest('GET', {}), {
      ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.header('Access-Control-Allow-Origin'), 'https://pages.example');
  });

  await test('(e3) OPTIONS preflight returns 204 + CORS', async () => {
    const res = await handleRequest(mockRequest('OPTIONS', {}), {
      ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example',
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.header('Access-Control-Allow-Origin'), 'https://pages.example');
    assert.strictEqual(res.header('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  });

  // census helper direct unit ------------------------------------------
  await test('(f) geocodeAddress parses {x:lon,y:lat} from mocked Census', async () => {
    const c = await geocodeAddress('1 Capitol, Harrisburg PA', mockCensusFetch(40.2732, -76.8867));
    assert.deepStrictEqual(c, { status: 'ok', coord: { lat: 40.2732, lon: -76.8867 }, county: null });
    // With a Counties geography layer, the bare county name is extracted.
    const withCty = await geocodeAddress('436 Grant St, Pittsburgh PA',
      mockCensusFetchWithCounty(40.4406, -79.9959, 'Allegheny'));
    assert.deepStrictEqual(withCty,
      { status: 'ok', coord: { lat: 40.4406, lon: -79.9959 }, county: 'Allegheny' });
    const none = await geocodeAddress('nowhere', mockCensusNoMatch);
    assert.deepStrictEqual(none, { status: 'not_found' });
    const down = await geocodeAddress('1 Capitol', mockCensusNetworkError);
    assert.deepStrictEqual(down, { status: 'unavailable' });
  });

  await test('(f2) photonGeocode returns first coord candidate / not_found on miss', async () => {
    const ok = await photonGeocode('4400 Forbes Ave, Pittsburgh PA', mockPhotonFetch());
    assert.deepStrictEqual(ok, { status: 'ok', coord: { lat: 40.4443, lon: -79.9569 } });
    // No features -> not_found.
    const none = await photonGeocode('nowhere',
      async () => ({ status: 200, json: async () => ({ features: [] }) }));
    assert.deepStrictEqual(none, { status: 'not_found' });
    // Provider network error degrades to not_found (never throws/unavailable).
    const down = await photonGeocode('anything', mockPhotonNetworkError);
    assert.deepStrictEqual(down, { status: 'not_found' });
  });

  // empty / malformed KV degrades gracefully -----------------------------
  await test('(g) empty KV -> zero aggregate, still PII-free shape', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon }),
      { ResponseCtor: MockResponse, kv: { get: async () => null }, allowedOrigin: 'https://pages.example' }
    );
    const body = await res.json();
    assert.strictEqual(body.total_in_range, 0);
    assert.deepStrictEqual(body.win_areas, []);
    assert.deepStrictEqual(Object.keys(body).sort(),
      ['animal_area', 'animal_county', 'animal_geoid', 'animal_lat', 'animal_lon', 'distance_mode', 'role_counts', 'total_in_range', 'win_areas']);
    // Even with an empty KV, the geocoded animal coord is still echoed back.
    assert.strictEqual(body.animal_lat, ANIMAL.lat);
    assert.strictEqual(body.animal_lon, ANIMAL.lon);
  });

  // (h) AUTOCOMPLETE route --------------------------------------------
  await test('(h1) autocomplete partial query -> normalized US suggestions', async () => {
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: '4400 Forbes', limit: 5 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: mockPhotonFetch(), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.suggestions), 'suggestions is an array');
    // Non-US (London) feature filtered out -> 2 US results.
    assert.strictEqual(body.suggestions.length, 2, 'two US suggestions');
    assert.strictEqual(body.suggestions[0].label, '4400 Forbes Avenue, Pittsburgh, Pennsylvania 15213');
    assert.strictEqual(typeof body.suggestions[0].lat, 'number');
    assert.strictEqual(typeof body.suggestions[0].lon, 'number');
    // No London / GB leakage.
    assert.strictEqual(JSON.stringify(body.suggestions).indexOf('London'), -1, 'no non-US result');
  });

  await test('(h2) autocomplete <3 chars short-circuits to empty (no provider call)', async () => {
    let called = false;
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: 'ab' }),
      {
        ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example',
        fetchFn: async () => { called = true; return { status: 200, json: async () => ({ features: [] }) }; },
      }
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).suggestions, []);
    assert.strictEqual(called, false, 'provider must NOT be called for <3 chars');
  });

  await test('(h3) autocomplete provider network error -> graceful empty 200', async () => {
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: 'Harrisburg' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: mockPhotonNetworkError, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200, 'never 500-crashes the page');
    assert.deepStrictEqual((await res.json()).suggestions, []);
  });

  await test('(h4) autocomplete provider HTTP error -> graceful empty 200', async () => {
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: 'Harrisburg' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: mockPhotonHttpError, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).suggestions, []);
  });

  await test('(h5) autocomplete response carries CORS + never leaks PII keys', async () => {
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: '4400 Forbes' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: mockPhotonFetch(), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.header('Access-Control-Allow-Origin'), 'https://pages.example');
    const serialized = JSON.stringify(await res.json());
    ['home_county', 'roles', 'win_area'].forEach(function (k) {
      assert.strictEqual(serialized.indexOf('"' + k + '"'), -1, 'no PII key: ' + k);
    });
  });

  await test('(h6) autocompleteAddress unit: <3 chars -> [], honors limit', async () => {
    const none = await autocompleteAddress('ab', 5, mockPhotonFetch());
    assert.deepStrictEqual(none, [], 'short query empty');
    const capped = await autocompleteAddress('4400 Forbes', 1, mockPhotonFetch());
    assert.strictEqual(capped.length, 1, 'limit=1 respected');
  });

  await test('(h7) autocompleteAddress PA-only: drops non-PA, keeps PA + no-state-in-bbox', async () => {
    // Mixed provider response: a NJ result, a PA result, and a PA-area result
    // with NO state field but coords inside the PA bbox (assume-PA).
    const mixed = async () => ({
      status: 200,
      json: async () => ({
        features: [
          { // New Jersey -> MUST be dropped.
            geometry: { type: 'Point', coordinates: [-74.2, 40.7] },
            properties: { street: 'Main St', city: 'Newark', state: 'New Jersey',
              countrycode: 'US', country: 'United States' },
          },
          { // Pennsylvania -> kept.
            geometry: { type: 'Point', coordinates: [-76.886, 40.273] },
            properties: { street: 'Main St', city: 'Lewisburg', state: 'Pennsylvania',
              postcode: '17837', countrycode: 'US', country: 'United States' },
          },
          { // No state, coords INSIDE the PA bbox -> kept (assume-PA).
            geometry: { type: 'Point', coordinates: [-77.8, 40.9] },
            properties: { name: 'Some Place', city: 'Coudersport',
              countrycode: 'US', country: 'United States' },
          },
          { // No state, coords OUTSIDE the PA bbox (Ohio-ish) -> dropped.
            geometry: { type: 'Point', coordinates: [-82.0, 40.0] },
            properties: { name: 'Elsewhere', countrycode: 'US', country: 'United States' },
          },
        ],
      }),
    });
    const items = await autocompleteAddress('Main St', 10, mixed);
    assert.strictEqual(items.length, 2, 'only the 2 PA candidates survive (got ' + items.length + ')');
    assert.ok(items.every((it) => it.label.indexOf('New Jersey') === -1),
      'no New Jersey candidate in the list');
    assert.ok(items.some((it) => it.label.indexOf('Lewisburg') !== -1),
      'PA address (Lewisburg) is present');
    assert.ok(items.some((it) => Math.abs(it.lat - 40.9) < 1e-6 && Math.abs(it.lon - (-77.8)) < 1e-6),
      'no-state but in-PA-bbox candidate is kept');
  });

  await test('(h8) autocompleteAddress sends PA bbox to Photon', async () => {
    let seenUrl = '';
    const capture = async (url) => {
      seenUrl = String(url);
      return { status: 200, json: async () => ({ features: [] }) };
    };
    await autocompleteAddress('123 Main St, Lewisburg, PA', 5, capture);
    assert.ok(/[?&]bbox=-80\.519891%2C39\.719799%2C-74\.689516%2C42\.26986/.test(seenUrl) ||
      seenUrl.indexOf('bbox=-80.519891,39.719799,-74.689516,42.26986') !== -1,
      'Photon query carries the PA bbox (url: ' + seenUrl + ')');
  });

  // (h9) CENSUS FALLBACK: Photon EMPTY + full pasted address -> Census match
  // appears as a selectable candidate with correct lat/lon.
  await test('(h9) autocomplete Census fallback surfaces Photon-missing house number', async () => {
    // Shared fetchFn routed by host: Photon returns ZERO features for the Neola
    // Rd house number; Census returns the exact 738 match (x=lon, y=lat).
    let censusCalled = false;
    const routed = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        censusCalled = true;
        return {
          status: 200,
          json: async () => ({
            result: {
              addressMatches: [{
                matchedAddress: '738 NEOLA RD, STROUDSBURG, PA, 18360',
                coordinates: { x: -75.339752, y: 40.957690 },
              }],
            },
          }),
        };
      }
      // Photon host: empty.
      return { status: 200, json: async () => ({ features: [] }) };
    };
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: '738 Neola Rd, Stroudsburg, PA 18360', limit: 5 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: routed, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(censusCalled, true, 'Census fallback was invoked (Photon empty + full address)');
    assert.strictEqual(body.suggestions.length, 1, 'one Census candidate appended');
    assert.strictEqual(body.suggestions[0].label, '738 NEOLA RD, STROUDSBURG, PA, 18360');
    assert.ok(Math.abs(body.suggestions[0].lat - 40.957690) < 1e-9, 'lat from Census y');
    assert.ok(Math.abs(body.suggestions[0].lon - (-75.339752)) < 1e-9, 'lon from Census x');
  });

  // (h10) HEURISTIC GATE: a typed partial (no ZIP/state) must NOT trigger the
  // Census call even when Photon is empty.
  await test('(h10) autocomplete Census NOT called for typed partial (no zip/state)', async () => {
    let censusCalled = false;
    const routed = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        censusCalled = true;
        return { status: 200, json: async () => ({ result: { addressMatches: [] } }) };
      }
      return { status: 200, json: async () => ({ features: [] }) };
    };
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: '738 Neo' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: routed, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).suggestions, []);
    assert.strictEqual(censusCalled, false, 'Census must NOT be called for a partial without ZIP/state');
  });

  // (h11) NORMALIZATION: the abbreviated "Rd" is expanded to "Road" in the
  // Photon query string (helps Photon's form-sensitive index).
  await test('(h11) autocompleteAddress expands Rd->Road in the Photon query', async () => {
    let seenUrl = '';
    const capture = async (url) => {
      seenUrl = String(url);
      return { status: 200, json: async () => ({ features: [] }) };
    };
    await autocompleteAddress('738 Neola Rd, Stroudsburg, PA', 5, capture);
    // The q= param Photon receives carries "Road", not "Rd".
    assert.ok(/[?&]q=[^&]*Road/.test(seenUrl), 'Photon q= contains expanded "Road" (url: ' + seenUrl + ')');
    assert.ok(!/[?&]q=[^&]*Neola\+Rd(?:%2C|&|$)/.test(seenUrl) && seenUrl.indexOf('Neola+Rd%2C') === -1,
      'Photon q= no longer carries the abbreviated "Rd," (url: ' + seenUrl + ')');
  });

  // (h12) Census fallback unit: heuristic helpers + PA-only drop.
  await test('(h12) looksLikeFullAddress heuristic + Census PA-only fallback', async () => {
    assert.strictEqual(looksLikeFullAddress('738 Neola Rd, Stroudsburg, PA 18360'), true, 'house# + zip + state');
    assert.strictEqual(looksLikeFullAddress('738 Neola Rd, PA'), true, 'house# + state token');
    assert.strictEqual(looksLikeFullAddress('738 Neo'), false, 'no zip/state token');
    assert.strictEqual(looksLikeFullAddress('Neola Road'), false, 'no house-number digit');
    // PA-by-bbox match kept.
    const inPa = async () => ({
      status: 200,
      json: async () => ({ result: { addressMatches: [{ matchedAddress: 'X', coordinates: { x: -75.34, y: 40.96 } }] } }),
    });
    const kept = await censusAutocompleteFallback('738 Neola Rd, Stroudsburg, PA 18360', inPa);
    assert.strictEqual(kept.length, 1, 'PA-bbox Census match is kept');
    // Out-of-PA match dropped (Ohio-ish lon).
    const outPa = async () => ({
      status: 200,
      json: async () => ({ result: { addressMatches: [{ matchedAddress: 'Y', coordinates: { x: -82.0, y: 40.0 } }] } }),
    });
    const dropped = await censusAutocompleteFallback('1 Main St, Columbus, OH 43004', outPa);
    assert.deepStrictEqual(dropped, [], 'non-PA Census match is dropped');
  });

  // (h13) hasHouseNumberMatch unit: a Photon label carrying the pasted house
  // number -> true; STREET-LEVEL-only labels (house # dropped) -> false; a query
  // with no leading house number -> true (nothing to require).
  await test('(h13) hasHouseNumberMatch heuristic (house# in a label vs street-only)', () => {
    // House # present in a Photon label -> true (Photon already resolved it).
    assert.strictEqual(
      hasHouseNumberMatch('564 E Maiden St, Washington, PA 15301', [
        { label: '564 E Maiden St, Washington, Pennsylvania 15301', lat: 40.16, lon: -80.23 },
      ]),
      true,
      'matching house number in a suggestion label -> true'
    );
    // Only STREET-LEVEL labels (house # dropped) -> false.
    assert.strictEqual(
      hasHouseNumberMatch('564 E Maiden St, Washington, PA 15301', [
        { label: 'E Maiden St, Washington, Pennsylvania', lat: 40.16, lon: -80.23 },
        { label: 'Washington, Pennsylvania 15301', lat: 40.17, lon: -80.24 },
      ]),
      false,
      'street/town-only labels (no house number) -> false'
    );
    // Empty list with a leading house number -> false (none match).
    assert.strictEqual(
      hasHouseNumberMatch('321 2nd St, Port Carbon, PA 17965', []),
      false,
      'empty suggestion list -> false'
    );
    // No leading house number -> true (nothing to require).
    assert.strictEqual(
      hasHouseNumberMatch('Maiden St, Washington, PA', [
        { label: 'E Maiden St, Washington, Pennsylvania' },
      ]),
      true,
      'query without a leading house number -> true'
    );
    // Word-boundary: "738" must NOT match inside a ZIP like "17380".
    assert.strictEqual(
      hasHouseNumberMatch('738 Neola Rd, PA 17380', [
        { label: 'Neola Rd, Somewhere, Pennsylvania 17380' },
      ]),
      false,
      'house number must not match a substring of an unrelated ZIP'
    );
  });

  // (h14) REAL ADDRESS #1 — "564 E Maiden St, Washington, PA 15301": Photon
  // returns STREET-LEVEL only (no 564); Census returns the exact 564 match.
  // The Census exact-house candidate must be PRESENT and FIRST in suggestions.
  await test('(h14) "564 E Maiden St": Photon street-only -> Census 564 candidate is FIRST', async () => {
    let censusCalled = false;
    const routed = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        censusCalled = true;
        return {
          status: 200,
          json: async () => ({
            result: {
              addressMatches: [{
                matchedAddress: '564 E MAIDEN ST, WASHINGTON, PA, 15301',
                coordinates: { x: -80.231145, y: 40.164749 },
              }],
            },
          }),
        };
      }
      // Photon host: STREET-LEVEL only — no house number 564 anywhere.
      return {
        status: 200,
        json: async () => ({
          features: [{
            geometry: { type: 'Point', coordinates: [-80.230, 40.165] },
            properties: {
              street: 'E Maiden St', city: 'Washington', state: 'Pennsylvania',
              postcode: '15301', countrycode: 'US', country: 'United States',
            },
          }],
        }),
      };
    };
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: '564 E Maiden St, Washington, PA 15301', limit: 5 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: routed, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(censusCalled, true, 'Census fired despite a NON-EMPTY street-level Photon list');
    // The Census exact-house candidate is PRESENT...
    const census = body.suggestions.find((s) => /\b564\b/.test(s.label));
    assert.ok(census, 'Census 564 exact-house candidate is present');
    assert.strictEqual(census.label, '564 E MAIDEN ST, WASHINGTON, PA, 15301');
    assert.ok(Math.abs(census.lat - 40.164749) < 1e-9, 'lat from Census y');
    assert.ok(Math.abs(census.lon - (-80.231145)) < 1e-9, 'lon from Census x');
    // ...and it is FIRST, above the imprecise Photon street-level entry.
    assert.strictEqual(body.suggestions[0].label, '564 E MAIDEN ST, WASHINGTON, PA, 15301',
      'Census exact-house candidate is prepended to the TOP');
    // The Photon street-level entry is kept (not discarded), below the Census one.
    assert.ok(body.suggestions.length >= 2, 'Photon street-level entry is retained below');
  });

  // (h15) REAL ADDRESS #2 — "321 2nd St, Port Carbon, PA 17965": same shape.
  await test('(h15) "321 2nd St": Photon street-only -> Census 321 candidate is FIRST', async () => {
    let censusCalled = false;
    const routed = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        censusCalled = true;
        return {
          status: 200,
          json: async () => ({
            result: {
              addressMatches: [{
                matchedAddress: '321 2ND ST, PORT CARBON, PA, 17965',
                coordinates: { x: -76.166956, y: 40.698163 },
              }],
            },
          }),
        };
      }
      // Photon: only the town/street, house number 321 dropped.
      return {
        status: 200,
        json: async () => ({
          features: [{
            geometry: { type: 'Point', coordinates: [-76.167, 40.698] },
            properties: {
              street: '2nd St', city: 'Port Carbon', state: 'Pennsylvania',
              postcode: '17965', countrycode: 'US', country: 'United States',
            },
          }],
        }),
      };
    };
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: '321 2nd St, Port Carbon, PA 17965', limit: 5 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: routed, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(censusCalled, true, 'Census fired on street-level Photon list');
    const census = body.suggestions.find((s) => /\b321\b/.test(s.label));
    assert.ok(census, 'Census 321 exact-house candidate is present');
    assert.strictEqual(body.suggestions[0].label, '321 2ND ST, PORT CARBON, PA, 17965',
      'Census exact-house candidate is FIRST');
    assert.ok(Math.abs(body.suggestions[0].lat - 40.698163) < 1e-9, 'lat from Census y');
    assert.ok(Math.abs(body.suggestions[0].lon - (-76.166956)) < 1e-9, 'lon from Census x');
  });

  // (h16) NEGATIVE: when a Photon result DOES contain the house number, the
  // Census fallback must NOT be called (Photon already resolved it).
  await test('(h16) Photon label contains the house number -> Census NOT called', async () => {
    let censusCalled = false;
    const routed = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        censusCalled = true;
        return { status: 200, json: async () => ({ result: { addressMatches: [] } }) };
      }
      // Photon host: a candidate whose label carries the pasted 564.
      return {
        status: 200,
        json: async () => ({
          features: [{
            geometry: { type: 'Point', coordinates: [-80.231145, 40.164749] },
            properties: {
              housenumber: '564', street: 'E Maiden St', city: 'Washington',
              state: 'Pennsylvania', postcode: '15301', countrycode: 'US',
              country: 'United States',
            },
          }],
        }),
      };
    };
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: '564 E Maiden St, Washington, PA 15301', limit: 5 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: routed, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(censusCalled, false, 'Census must NOT fire when Photon already has the house number');
    assert.strictEqual(body.suggestions.length, 1, 'only the Photon candidate is present');
    assert.ok(/\b564\b/.test(body.suggestions[0].label), 'Photon house-number candidate retained');
  });

  // (h-int1) INTERSECTION GATE: looksLikeIntersection + looksLikeFullAddress ---
  await test('(h-int1) looksLikeIntersection detects suffix-bearing intersection queries', () => {
    // True cases: street suffix on both sides.
    assert.strictEqual(looksLikeIntersection('Elliott St & Verona Rd, Penn Hills Township, PA'), true, '& with St+Rd');
    assert.strictEqual(looksLikeIntersection('Main Ave and Oak St, Pittsburgh, PA'), true, 'and with Ave+St');
    assert.strictEqual(looksLikeIntersection('Route 30 Blvd & Forbes Dr'), true, 'Blvd+Dr');
    // False cases: no street suffix, or only one side has a suffix, or no connector.
    assert.strictEqual(looksLikeIntersection('Washington and Jefferson'), false, 'no street suffixes');
    assert.strictEqual(looksLikeIntersection('Oak and Elm, Pittsburgh, PA'), false, 'no suffix on either side');
    assert.strictEqual(looksLikeIntersection('Main St, Pittsburgh, PA'), false, 'no & or and connector');
    assert.strictEqual(looksLikeIntersection('Washington'), false, 'single word');
    assert.strictEqual(looksLikeIntersection(''), false, 'empty string');
  });

  await test('(h-int2) looksLikeFullAddress: intersection gate (requires city/state context)', () => {
    // (a) from task: must return true.
    assert.strictEqual(looksLikeFullAddress('Elliott St & Verona Rd, Penn Hills Township, PA'), true,
      '(a) Elliott St & Verona Rd -> true');
    // (b) from task: must return true.
    assert.strictEqual(looksLikeFullAddress('Main Ave and Oak St, Pittsburgh, PA'), true,
      '(b) Main Ave and Oak St -> true');
    // (c) from task: single word -> false (existing behavior).
    assert.strictEqual(looksLikeFullAddress('Washington'), false,
      '(c) "Washington" -> false');
    // (d) from task: existing digit-gate still works.
    assert.strictEqual(looksLikeFullAddress('564 E Maiden St, Washington, PA'), true,
      '(d) house-number address -> true');
    // Intersection WITHOUT city/state context -> false (no-fire mid-type).
    assert.strictEqual(looksLikeFullAddress('Elliott St & Verona Rd'), false,
      'intersection missing city/state -> false (conservative)');
    // Existing negative cases preserved.
    assert.strictEqual(looksLikeFullAddress('738 Neo'), false, 'partial no zip/state -> false');
    assert.strictEqual(looksLikeFullAddress('Neola Road'), false, 'no digit, no intersection -> false');
    // College name with state -> no suffix on both sides -> looksLikeIntersection=false
    // -> falls to digit check -> no digit -> false.
    assert.strictEqual(looksLikeFullAddress('Washington and Jefferson, PA'), false,
      'college name: no street suffixes -> false');
  });

  await test('(h-int3) hasHouseNumberMatch returns false for intersections (forces Census)', () => {
    // Intersection query -> hasHouseNumberMatch must return false so Census fires.
    assert.strictEqual(
      hasHouseNumberMatch('Elliott St & Verona Rd, Penn Hills Township, PA', []),
      false,
      'intersection with empty Photon list -> false (Census should fire)'
    );
    assert.strictEqual(
      hasHouseNumberMatch('Main Ave and Oak St, Pittsburgh, PA', [
        { label: 'Main Avenue, Pittsburgh, Pennsylvania' },
      ]),
      false,
      'intersection with street-level Photon list -> false'
    );
    // Non-intersection, no leading digit -> true (existing behavior unchanged).
    assert.strictEqual(
      hasHouseNumberMatch('Maiden St, Washington, PA', [{ label: 'E Maiden St, Washington, Pennsylvania' }]),
      true,
      'plain street query (no digit, no intersection) -> true'
    );
  });

  // (h17) INTEGRATION: intersection query -> Census is called and returns corner coords.
  await test('(h17) "Elliott St & Verona Rd, Penn Hills Township, PA" -> Census fires, corner coords returned', async () => {
    let censusCalled = false;
    const routed = async (url) => {
      const u = String(url);
      if (u.indexOf('census.gov') !== -1) {
        censusCalled = true;
        return {
          status: 200,
          json: async () => ({
            result: {
              addressMatches: [{
                matchedAddress: 'ELLIOTT ST & VERONA RD, PENN HILLS, PA, 15235',
                coordinates: { x: -79.837476, y: 40.498948 },
              }],
            },
          }),
        };
      }
      // Photon: returns empty for an intersection (as expected in the real world).
      return { status: 200, json: async () => ({ features: [] }) };
    };
    const res = await handleRequest(
      mockRequest('GET', { autocomplete: 'Elliott St & Verona Rd, Penn Hills Township, PA', limit: 5 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: routed, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(censusCalled, true, 'Census fired for intersection query');
    assert.strictEqual(body.suggestions.length, 1, 'Census corner candidate returned');
    assert.strictEqual(body.suggestions[0].label, 'ELLIOTT ST & VERONA RD, PENN HILLS, PA, 15235');
    assert.ok(Math.abs(body.suggestions[0].lat - 40.498948) < 1e-9, 'lat from Census y');
    assert.ok(Math.abs(body.suggestions[0].lon - (-79.837476)) < 1e-9, 'lon from Census x');
  });

  // (i) TIER 2 -- out-of-county context list (PII-safe) ----------------
  // Forbidden keys that must NEVER appear at any depth of a Tier 2 response.
  const TIER2_FORBIDDEN_KEYS = [
    'lat', 'lon', 'latitude', 'longitude', '_addr_sig', 'name', 'rehab_name',
    'phone', 'email', 'address', 'street', 'city', 'zip', 'home_county',
    'monday_item_id', 'coords', 'coordinates',
  ];
  const TIER2_ROW_KEYS = ['county', 'distance_mi', 'roles', 'win_area'];

  // Deep-walk every key in an object/array tree, collecting key names.
  function collectKeys(node, out) {
    if (Array.isArray(node)) {
      for (const v of node) collectKeys(v, out);
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        out.push(k);
        collectKeys(node[k], out);
      }
    }
    return out;
  }

  // KV set with rich PII-like fields to prove the deep-walk filters them out.
  // Dauphin is the animal's home county (exclude_county in Tier 2).
  const COORDS_PII = [
    // ~0 mi, IN-county (Dauphin) -> excluded from out_of_county, counted in aggregate.
    {
      lat: 40.2732, lon: -76.8867, roles: ['C&T', 'COURIER'], home_county: 'Dauphin',
      win_area: 'WIN-1', _addr_sig: 'sig-aaa', name: 'Alice', phone: '717-000-0001',
      email: 'a@x.org', address: '1 Main St', monday_item_id: 111,
    },
    // ~8 mi, OUT-of-county (Lebanon), RVS C&T.
    {
      lat: 40.36, lon: -76.78, roles: ['rvs c&t'], home_county: 'Lebanon',
      win_area: 'WIN-2', _addr_sig: 'sig-bbb', name: 'Bob', phone: '717-000-0002',
      email: 'b@x.org', address: '2 Oak Ave', monday_item_id: 222,
    },
    // ~12 mi, OUT-of-county (Lancaster), COURIER.
    {
      lat: 40.10, lon: -76.75, roles: ['Courier'], home_county: 'Lancaster',
      win_area: 'WIN-1', _addr_sig: 'sig-ccc', name: 'Carol', phone: '717-000-0003',
      email: 'c@x.org', address: '3 Pine Rd', monday_item_id: 333,
    },
    // ~50 mi west, OUT-of-county (Huntingdon), C&T -> only in at 100mi.
    {
      lat: 40.33, lon: -77.95, roles: ['C&T'], home_county: 'Huntingdon',
      win_area: 'WIN-9', _addr_sig: 'sig-ddd', name: 'Dave', phone: '717-000-0004',
      email: 'd@x.org', address: '4 Elm Ct', monday_item_id: 444,
    },
    // invalid record -> skipped everywhere.
    { lat: null, lon: null, roles: ['C&T'], home_county: 'Nowhere', win_area: 'WIN-X' },
  ];

  await test('(i1) findContextRows: out-of-county filter + one row per volunteer + sorted', () => {
    const rows = findContextRows(ANIMAL.lat, ANIMAL.lon, 20, COORDS_PII, 'Dauphin');
    // Dauphin (in-county) excluded; Huntingdon out at 20mi; invalid skipped.
    assert.strictEqual(rows.length, 2, 'two out-of-county within 20mi');
    // Sorted ascending by distance.
    assert.ok(rows[0].distance_mi <= rows[1].distance_mi, 'ascending distance');
    // Lebanon (RVS C&T) is nearest (~8mi), Lancaster (COURIER) next (~12mi).
    assert.deepStrictEqual(rows[0].roles, ['RVS C&T']);
    assert.strictEqual(rows[0].county, 'Lebanon');
    assert.deepStrictEqual(rows[1].roles, ['COURIER']);
    assert.strictEqual(rows[1].county, 'Lancaster');
    // Each row carries ONLY the whitelisted keys.
    for (const r of rows) {
      assert.deepStrictEqual(Object.keys(r).sort(), TIER2_ROW_KEYS,
        'row keys whitelisted, got: ' + JSON.stringify(Object.keys(r)));
    }
  });

  await test('(i2) one row per volunteer carries a roles[] array (multi-role)', () => {
    // Animal in a county that excludes nobody here; the ~0mi vol has 2 roles.
    const rows = findContextRows(ANIMAL.lat, ANIMAL.lon, 20, COORDS_PII, 'Lebanon');
    // Now Lebanon excluded; Dauphin (multi-role) + Lancaster remain in 20mi.
    const dauphin = rows.find((r) => r.county === 'Dauphin');
    assert.ok(dauphin, 'Dauphin row present');
    assert.deepStrictEqual(dauphin.roles.slice().sort(), ['C&T', 'COURIER'],
      'single row carries both qualifying roles (NOT one row per role)');
  });

  await test('(i3) overflow: >15 matches -> exactly 5 rows + radius_too_broad + truncated', () => {
    // Build 20 distinct out-of-county volunteers at increasing distances.
    const big = [];
    for (let i = 0; i < 20; i += 1) {
      big.push({
        lat: ANIMAL.lat + 0.01 * (i + 1), lon: ANIMAL.lon,
        roles: ['C&T'], home_county: 'County' + i, win_area: 'WIN-' + i,
        _addr_sig: 'sig-' + i, name: 'V' + i, phone: 'p' + i,
      });
    }
    const rows = findContextRows(ANIMAL.lat, ANIMAL.lon, 100, big, 'Dauphin');
    assert.strictEqual(rows.length, 20, 'all 20 matched before overflow trim');
    const resp = buildTier2Response(
      { total_in_range: 20, role_counts: { 'C&T': 20, 'RVS C&T': 0, 'COURIER': 0 }, win_areas: [] },
      rows
    );
    assert.strictEqual(resp.out_of_county.length, 5, 'only nearest 5 returned');
    assert.strictEqual(resp.radius_too_broad, true);
    assert.strictEqual(resp.out_of_county_truncated, true);
    // The 5 returned are the nearest 5 (ascending).
    for (let i = 1; i < resp.out_of_county.length; i += 1) {
      assert.ok(resp.out_of_county[i - 1].distance_mi <= resp.out_of_county[i].distance_mi);
    }
  });

  await test('(i4) no overflow: <=15 matches -> all rows + radius_too_broad false', () => {
    const big = [];
    for (let i = 0; i < 15; i += 1) {
      big.push({
        lat: ANIMAL.lat + 0.01 * (i + 1), lon: ANIMAL.lon,
        roles: ['C&T'], home_county: 'County' + i, win_area: 'WIN-' + i,
      });
    }
    const rows = findContextRows(ANIMAL.lat, ANIMAL.lon, 100, big, 'Dauphin');
    const resp = buildTier2Response(
      { total_in_range: 15, role_counts: { 'C&T': 15, 'RVS C&T': 0, 'COURIER': 0 }, win_areas: [] },
      rows
    );
    assert.strictEqual(resp.out_of_county.length, 15, 'all 15 returned (boundary)');
    assert.strictEqual(resp.radius_too_broad, false);
    assert.strictEqual(resp.out_of_county_truncated, false);
  });

  await test('(i5) handler context=1: PII deep-walk finds NO forbidden key', async () => {
    const res = await handleRequest(
      mockRequest('GET', {
        animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20,
        exclude_county: 'Dauphin', context: '1',
      }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS_PII), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    // Top-level whitelist (now includes availability fields + animal coords + distance_mode).
    assert.deepStrictEqual(Object.keys(body).sort(),
      ['animal_area', 'animal_county', 'animal_geoid', 'animal_lat', 'animal_lon', 'distance_mode', 'marginal_threshold', 'out_of_county',
       'out_of_county_truncated', 'radius_too_broad', 'role_available',
       'role_counts', 'total_available', 'total_in_range', 'win_areas']);
    // No ORS key in deps -> straight_line fallback.
    assert.strictEqual(body.distance_mode, 'straight_line');
    // animal coords echoed on the Tier 2 path too.
    assert.strictEqual(body.animal_lat, ANIMAL.lat);
    assert.strictEqual(body.animal_lon, ANIMAL.lon);
    // Deep-walk every key name; none may be forbidden.
    const allKeys = collectKeys(body, []);
    for (const k of TIER2_FORBIDDEN_KEYS) {
      assert.strictEqual(allKeys.indexOf(k), -1, 'PII key leaked at some depth: ' + k);
    }
    // Aggregate still spans ALL in-radius (in + out of county) = 3.
    assert.strictEqual(body.total_in_range, 3, 'aggregate unchanged by context');
    // out_of_county rows: each has ONLY the 4 whitelisted keys, none in-county.
    assert.strictEqual(body.out_of_county.length, 2);
    for (const r of body.out_of_county) {
      assert.deepStrictEqual(Object.keys(r).sort(), TIER2_ROW_KEYS);
      assert.notStrictEqual(String(r.county).toLowerCase(), 'dauphin');
    }
  });

  await test('(i6) backward compat: NO context -> byte-identical to today aggregate', async () => {
    const query = { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20 };
    // Today's path (no context param at all).
    const resPlain = await handleRequest(mockRequest('GET', query),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS_PII), allowedOrigin: 'https://pages.example' });
    // Same request but with exclude_county present and context explicitly OFF.
    const resOff = await handleRequest(
      mockRequest('GET', Object.assign({}, query, { exclude_county: 'Dauphin', context: '0' })),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS_PII), allowedOrigin: 'https://pages.example' });
    // Byte-for-byte equal bodies; legacy keys + animal coords; no out_of_county.
    assert.strictEqual(resPlain.body, resOff.body, 'context off is byte-identical');
    assert.deepStrictEqual(Object.keys(await resPlain.json()).sort(),
      ['animal_area', 'animal_county', 'animal_geoid', 'animal_lat', 'animal_lon', 'distance_mode', 'role_counts', 'total_in_range', 'win_areas']);
  });

  await test('(i7) handler context=1 carries CORS header', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, exclude_county: 'Dauphin', context: '1' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS_PII), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.header('Access-Control-Allow-Origin'), 'https://pages.example');
  });

  await test('(i8) findContextRows: context WITHOUT exclude_county -> ALL in-range (incl. in-county)', () => {
    // Standalone Address lookup path: no county is excluded, so the in-county
    // (Dauphin, ~0mi) volunteer is INCLUDED alongside the out-of-county ones.
    const rows = findContextRows(ANIMAL.lat, ANIMAL.lon, 20, COORDS_PII /* no excludeCounty */);
    assert.strictEqual(rows.length, 3, 'all three in-range volunteers returned (Dauphin + Lebanon + Lancaster)');
    // Sorted ascending; Dauphin (~0mi) is nearest and is NOT filtered out.
    assert.strictEqual(rows[0].county, 'Dauphin', 'in-county volunteer IS included when no county is excluded');
    const counties = rows.map((r) => r.county).sort();
    assert.deepStrictEqual(counties, ['Dauphin', 'Lancaster', 'Lebanon']);
    // Still PII-safe: every row carries ONLY the whitelisted keys.
    for (const r of rows) {
      assert.deepStrictEqual(Object.keys(r).sort(), TIER2_ROW_KEYS,
        'row keys whitelisted, got: ' + JSON.stringify(Object.keys(r)));
    }
  });

  await test('(i9) handler context=1 WITHOUT exclude_county returns in-range rows (incl. in-county)', async () => {
    const res = await handleRequest(
      mockRequest('GET', {
        animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20,
        context: '1', // NO exclude_county
      }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS_PII), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    // Aggregate still spans ALL in-radius = 3 (unchanged).
    assert.strictEqual(body.total_in_range, 3, 'aggregate spans all in-range');
    // out_of_county now carries ALL THREE in-range rows (no county excluded),
    // INCLUDING the in-county Dauphin volunteer.
    assert.strictEqual(body.out_of_county.length, 3, 'context list returns all 3 in-range rows');
    const counties = body.out_of_county.map((r) => r.county).sort();
    assert.deepStrictEqual(counties, ['Dauphin', 'Lancaster', 'Lebanon'],
      'in-county Dauphin is included when no exclude_county is sent');
    // Each row keeps the 4-key whitelist; PII deep-walk finds nothing forbidden.
    for (const r of body.out_of_county) {
      assert.deepStrictEqual(Object.keys(r).sort(), TIER2_ROW_KEYS);
    }
    const allKeys = collectKeys(body, []);
    for (const k of TIER2_FORBIDDEN_KEYS) {
      assert.strictEqual(allKeys.indexOf(k), -1, 'PII key leaked at some depth: ' + k);
    }
  });

  // (q) QUALIFY_ROLES filter -- qualified-only context list before the cap ---
  await test('(q1) parseQualifyRoles normalizes labels; blank/absent -> null', () => {
    assert.strictEqual(parseQualifyRoles(null), null, 'null -> null (no filter)');
    assert.strictEqual(parseQualifyRoles(undefined), null, 'undefined -> null');
    assert.strictEqual(parseQualifyRoles(''), null, 'empty string -> null');
    assert.strictEqual(parseQualifyRoles('   '), null, 'whitespace -> null');
    const a = parseQualifyRoles('C&T,RVS C&T');
    assert.ok(a instanceof Set && a.size === 2, 'two normalized keys');
    assert.ok(a.has(normalizeRole('C&T')) && a.has(normalizeRole('RVS C&T')));
    const b = parseQualifyRoles(['  rvs c&t  ']);
    assert.ok(b instanceof Set && b.has(normalizeRole('RVS C&T')) && b.size === 1, 'array form normalized');
  });

  await test('(q2) rowQualifies: null set -> always true; else intersection', () => {
    assert.strictEqual(rowQualifies(['COURIER'], null), true, 'null set never filters');
    const cap = parseQualifyRoles('C&T,RVS C&T');
    assert.strictEqual(rowQualifies(['RVS C&T'], cap), true, 'RVS C&T intersects');
    assert.strictEqual(rowQualifies(['C&T'], cap), true, 'C&T intersects');
    assert.strictEqual(rowQualifies(['COURIER'], cap), false, 'COURIER does not intersect a capture set');
    const rvsOnly = parseQualifyRoles('RVS C&T');
    assert.strictEqual(rowQualifies(['C&T'], rvsOnly), false, 'plain C&T excluded from an RVS-only set');
  });

  await test('(q3) findContextRows: qualify_roles drops non-matching rows (counts unaffected)', () => {
    // COORDS_PII within 20mi out-of-county: Lebanon (RVS C&T) + Lancaster (COURIER).
    // No-RVS capture set "C&T,RVS C&T" keeps the RVS C&T row, drops the COURIER.
    const captureRows = findContextRows(ANIMAL.lat, ANIMAL.lon, 20, COORDS_PII, 'Dauphin', null, 'C&T,RVS C&T');
    assert.strictEqual(captureRows.length, 1, 'only the RVS C&T row survives a capture filter');
    assert.deepStrictEqual(captureRows[0].roles, ['RVS C&T']);
    assert.strictEqual(captureRows[0].county, 'Lebanon');

    // RVS-only set drops the COURIER too AND would drop a plain C&T (none here).
    const rvsRows = findContextRows(ANIMAL.lat, ANIMAL.lon, 20, COORDS_PII, 'Dauphin', null, 'RVS C&T');
    assert.strictEqual(rvsRows.length, 1, 'RVS-only set keeps the RVS C&T row');
    assert.deepStrictEqual(rvsRows[0].roles, ['RVS C&T']);

    // No qualify_roles -> historical behavior (both rows).
    const allRows = findContextRows(ANIMAL.lat, ANIMAL.lon, 20, COORDS_PII, 'Dauphin');
    assert.strictEqual(allRows.length, 2, 'absent qualify_roles preserves both rows');
  });

  await test('(q4) qualify_roles filter applies BEFORE the nearest-N cap', () => {
    // 4 qualified (C&T) volunteers FAR out + 16 couriers NEAR. With NO filter the
    // cap keeps the 5 nearest (all couriers) and drops the 4 C&T -> divergence.
    // With the capture filter the cap operates on the 4 qualified only: NOT
    // truncated, and all 4 survive.
    const mixed = [];
    // 16 NEAR couriers (distance grows slowly, all closer than the C&T block).
    for (let i = 0; i < 16; i += 1) {
      mixed.push({
        lat: ANIMAL.lat + 0.005 * (i + 1), lon: ANIMAL.lon,
        roles: ['COURIER'], home_county: 'Courier' + i, win_area: 'WIN-c' + i,
      });
    }
    // 4 FAR C&T-capable (1 plain C&T + 3 RVS C&T), all farther than the couriers.
    mixed.push({ lat: ANIMAL.lat + 0.20, lon: ANIMAL.lon, roles: ['C&T'], home_county: 'CtA', win_area: 'WIN-a' });
    mixed.push({ lat: ANIMAL.lat + 0.22, lon: ANIMAL.lon, roles: ['rvs c&t'], home_county: 'CtB', win_area: 'WIN-b' });
    mixed.push({ lat: ANIMAL.lat + 0.24, lon: ANIMAL.lon, roles: ['rvs c&t'], home_county: 'CtC', win_area: 'WIN-c' });
    mixed.push({ lat: ANIMAL.lat + 0.26, lon: ANIMAL.lon, roles: ['rvs c&t'], home_county: 'CtD', win_area: 'WIN-d' });

    // No filter: 20 rows pre-cap, then buildTier2Response trims to nearest 5
    // (all couriers) and flags truncated -> the qualified C&T are lost.
    const unfiltered = findContextRows(ANIMAL.lat, ANIMAL.lon, 100, mixed, 'Dauphin');
    assert.strictEqual(unfiltered.length, 20, 'unfiltered: all 20 pre-cap');
    const respUnfiltered = buildTier2Response(
      { total_in_range: 20, role_counts: { 'C&T': 1, 'RVS C&T': 3, 'COURIER': 16 }, win_areas: [] },
      unfiltered
    );
    assert.strictEqual(respUnfiltered.out_of_county.length, 5, 'unfiltered cap keeps 5');
    assert.strictEqual(respUnfiltered.radius_too_broad, true, 'unfiltered triggers overflow on the full set');
    assert.ok(respUnfiltered.out_of_county.every((r) => r.roles.indexOf('COURIER') !== -1),
      'unfiltered nearest-5 are all couriers (the divergence bug)');

    // Capture filter applied BEFORE the cap: 4 qualified rows, NOT truncated.
    const filtered = findContextRows(ANIMAL.lat, ANIMAL.lon, 100, mixed, 'Dauphin', null, 'C&T,RVS C&T');
    assert.strictEqual(filtered.length, 4, 'filtered: only the 4 qualified survive the pre-cap filter');
    const respFiltered = buildTier2Response(
      // role_counts UNCHANGED -- still the FULL in-range tally incl. couriers.
      { total_in_range: 20, role_counts: { 'C&T': 1, 'RVS C&T': 3, 'COURIER': 16 }, win_areas: [] },
      filtered
    );
    assert.strictEqual(respFiltered.out_of_county.length, 4, 'all 4 qualified rows survive the cap');
    assert.strictEqual(respFiltered.radius_too_broad, false, 'cap does NOT trigger on a 4-row qualified set');
    assert.strictEqual(respFiltered.out_of_county_truncated, false, 'qualified set < cap -> not truncated');
    // role_counts surfaced UNCHANGED (full set, incl. the 16 couriers).
    assert.strictEqual(respFiltered.role_counts['COURIER'], 16, 'role_counts unchanged (16 couriers still counted)');
    assert.strictEqual(respFiltered.role_counts['RVS C&T'], 3, 'RVS C&T count unchanged');
    assert.strictEqual(respFiltered.role_counts['C&T'], 1, 'C&T count unchanged');
  });

  await test('(q5) cap STILL triggers when the QUALIFIED set itself exceeds 15', () => {
    // 20 qualified C&T volunteers -> even after the filter the cap fires.
    const big = [];
    for (let i = 0; i < 20; i += 1) {
      big.push({
        lat: ANIMAL.lat + 0.01 * (i + 1), lon: ANIMAL.lon,
        roles: ['C&T'], home_county: 'County' + i, win_area: 'WIN-' + i,
      });
    }
    const rows = findContextRows(ANIMAL.lat, ANIMAL.lon, 100, big, 'Dauphin', null, 'C&T,RVS C&T');
    assert.strictEqual(rows.length, 20, 'all 20 qualified pre-cap');
    const resp = buildTier2Response(
      { total_in_range: 20, role_counts: { 'C&T': 20, 'RVS C&T': 0, 'COURIER': 0 }, win_areas: [] },
      rows
    );
    assert.strictEqual(resp.out_of_county.length, 5, 'qualified-set overflow still trims to nearest 5');
    assert.strictEqual(resp.radius_too_broad, true, 'overflow notice fires on the qualified-set size');
    assert.strictEqual(resp.out_of_county_truncated, true);
  });

  await test('(q6) handler: qualify_roles param threads through to a qualified-only list', async () => {
    const res = await handleRequest(
      mockRequest('GET', {
        animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20,
        context: '1', qualify_roles: 'C&T,RVS C&T', // NO exclude_county (standalone)
      }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS_PII), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    // Aggregate counts UNCHANGED -- full in-range set (Dauphin C&T+COURIER,
    // Lebanon RVS C&T, Lancaster COURIER) = 3 volunteers.
    assert.strictEqual(body.total_in_range, 3, 'aggregate spans all in-range (unchanged by the list filter)');
    // List is qualified-only for a no-RVS capture: Dauphin (C&T) + Lebanon
    // (RVS C&T) qualify; Lancaster (COURIER-only) is dropped.
    const counties = body.out_of_county.map((r) => r.county).sort();
    assert.deepStrictEqual(counties, ['Dauphin', 'Lebanon'],
      'COURIER-only Lancaster dropped; C&T-capable rows kept');
    // PII deep-walk still clean.
    const allKeys = collectKeys(body, []);
    for (const k of TIER2_FORBIDDEN_KEYS) {
      assert.strictEqual(allKeys.indexOf(k), -1, 'PII key leaked at some depth: ' + k);
    }
  });

  // (j) AVAILABILITY TALLY -- Tier 2 mirrors Tier 1 available/total -------
  // Coords carrying explicit `available` booleans. Animal anchor = Harrisburg.
  // Within 20mi: 4 volunteers spanning all 3 buckets, mixed availability.
  const COORDS_AVAIL = [
    // ~0 mi, C&T + COURIER, AVAILABLE.
    { lat: 40.2732, lon: -76.8867, roles: ['C&T', 'COURIER'], home_county: 'Dauphin', win_area: 'WIN-1', available: true },
    // ~8 mi, RVS C&T, NOT available.
    { lat: 40.36, lon: -76.78, roles: ['rvs c&t'], home_county: 'Lebanon', win_area: 'WIN-2', available: false },
    // ~12 mi, COURIER, AVAILABLE.
    { lat: 40.10, lon: -76.75, roles: ['Courier'], home_county: 'Lancaster', win_area: 'WIN-1', available: true },
    // ~14 mi, C&T, NOT available.
    { lat: 40.15, lon: -77.05, roles: ['C&T'], home_county: 'Perry', win_area: 'WIN-3', available: false },
    // invalid -> skipped.
    { lat: null, lon: null, roles: ['C&T'], home_county: 'Nowhere', win_area: 'WIN-X', available: true },
  ];

  await test('(j1) isAvailableRecord: blank/missing -> available, explicit false -> not', () => {
    assert.strictEqual(isAvailableRecord({}), true, 'missing field => available');
    assert.strictEqual(isAvailableRecord({ available: true }), true);
    assert.strictEqual(isAvailableRecord({ available: false }), false);
    assert.strictEqual(isAvailableRecord(null), false, 'null record not available');
  });

  await test('(j2) findVolunteersInRadius tallies role_available/total_available', () => {
    const agg = findVolunteersInRadius(ANIMAL.lat, ANIMAL.lon, 20, COORDS_AVAIL);
    // Presence: C&T=2 (Dauphin + Perry), RVS=1 (Lebanon), COURIER=2 (Dauphin+Lancaster).
    assert.strictEqual(agg.role_counts['C&T'], 2);
    assert.strictEqual(agg.role_counts['RVS C&T'], 1);
    assert.strictEqual(agg.role_counts['COURIER'], 2);
    assert.strictEqual(agg.total_in_range, 4);
    // Availability: Dauphin(avail) + Lancaster(avail) available; Lebanon + Perry not.
    assert.strictEqual(agg.total_available, 2, 'two distinct available volunteers');
    assert.strictEqual(agg.role_available['C&T'], 1, 'only Dauphin C&T available (Perry not)');
    assert.strictEqual(agg.role_available['RVS C&T'], 0, 'Lebanon RVS not available');
    assert.strictEqual(agg.role_available['COURIER'], 2, 'both couriers available');
  });

  await test('(j3) buildTier2Response whitelists role_available/total_available/marginal_threshold', () => {
    const agg = findVolunteersInRadius(ANIMAL.lat, ANIMAL.lon, 20, COORDS_AVAIL);
    const rows = findContextRows(ANIMAL.lat, ANIMAL.lon, 20, COORDS_AVAIL, 'Dauphin');
    const resp = buildTier2Response(agg, rows);
    assert.strictEqual(resp.role_available['C&T'], 1);
    assert.strictEqual(resp.role_available['RVS C&T'], 0);
    assert.strictEqual(resp.role_available['COURIER'], 2);
    assert.strictEqual(resp.total_available, 2);
    assert.strictEqual(resp.marginal_threshold, DEFAULT_MARGINAL_THRESHOLD);
    // available can never exceed the in-range count for any bucket.
    for (const role of ['C&T', 'RVS C&T', 'COURIER']) {
      assert.ok(resp.role_available[role] <= resp.role_counts[role], role + ' avail <= total');
    }
  });

  await test('(j4) buildTier2Response clamps malformed available counts to [0,total]', () => {
    const resp = buildTier2Response(
      {
        total_in_range: 2,
        role_counts: { 'C&T': 2, 'RVS C&T': 0, 'COURIER': 0 },
        role_available: { 'C&T': 99, 'RVS C&T': -5, 'COURIER': 0 },
        total_available: 99,
      },
      []
    );
    assert.strictEqual(resp.role_available['C&T'], 2, 'clamped down to total');
    assert.strictEqual(resp.role_available['RVS C&T'], 0, 'negative clamped to 0');
    assert.strictEqual(resp.total_available, 2, 'total_available clamped to total_in_range');
  });

  await test('(j5) handler context=1 surfaces availability fields end-to-end (PII-safe)', async () => {
    const res = await handleRequest(
      mockRequest('GET', {
        animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20,
        exclude_county: 'Dauphin', context: '1',
      }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS_AVAIL), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.total_available, 2);
    assert.strictEqual(body.role_available['COURIER'], 2);
    assert.strictEqual(body.role_available['RVS C&T'], 0);
    assert.strictEqual(typeof body.marginal_threshold, 'number');
    // PII still clean: deep-walk finds no forbidden key (available is a count, not identity).
    const allKeys = collectKeys(body, []);
    for (const k of TIER2_FORBIDDEN_KEYS) {
      assert.strictEqual(allKeys.indexOf(k), -1, 'PII key leaked: ' + k);
    }
  });

  await test('(j6) plain (non-context) path STILL omits availability fields (backward compat)', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS_AVAIL), allowedOrigin: 'https://pages.example' }
    );
    const body = await res.json();
    assert.deepStrictEqual(Object.keys(body).sort(),
      ['animal_area', 'animal_county', 'animal_geoid', 'animal_lat', 'animal_lon', 'distance_mode', 'role_counts', 'total_in_range', 'win_areas'],
      'legacy aggregate shape + animal coords + animal county/area + distance_mode, no availability fields');
    assert.strictEqual(body.role_available, undefined, 'no availability leak on plain path');
    assert.strictEqual(body.marginal_threshold, undefined);
    // explicit lat/lon (picked-coordinate path) now carries county/area/geoid
    // via POINT-IN-POLYGON from the final coord (Harrisburg -> Dauphin).
    assert.strictEqual(body.animal_county, 'Dauphin', 'PIP fills county on the picked-coordinate path');
    assert.strictEqual(body.animal_area, '13', 'PIP fills area on the picked-coordinate path');
    assert.strictEqual(body.animal_geoid, '42043', 'PIP fills geoid on the picked-coordinate path');
  });

  await test('(j7) buildAggregateResponse re-whitelists down to legacy 3 keys', () => {
    const agg = findVolunteersInRadius(ANIMAL.lat, ANIMAL.lon, 20, COORDS_AVAIL);
    const legacy = buildAggregateResponse(agg);
    assert.deepStrictEqual(Object.keys(legacy).sort(),
      ['role_counts', 'total_in_range', 'win_areas']);
    assert.strictEqual(legacy.total_in_range, 4);
  });

  // (k) REHABBER DRIVING-DISTANCE route (ORS Matrix + haversine fallback) ----
  // Rehabber coords are PUBLIC, so this route is PII-safe. ORS key from env;
  // when missing/empty or the call fails, it degrades to haversine (no time).
  const ORIGIN = { lat: 40.4443, lon: -79.9569 };       // Pittsburgh-ish
  const DESTS = [
    { lat: 40.45, lon: -79.99 },   // ~2 mi
    { lat: 41.00, lon: -79.80 },   // ~40 mi
  ];

  await test('(k1) rehabberDistances ORS path: metres/seconds -> miles/min, key sent', async () => {
    const captured = {};
    // 8046.72 m = 5.0 mi; 64373.76 m = 40.0 mi. 1500s = 25 min; 3000s = 50 min.
    const fetchFn = mockOrsFetch([8046.72, 64373.76], [1500, 3000], captured);
    const out = await rehabberDistances(ORIGIN, DESTS, 'secret-key', fetchFn);
    assert.strictEqual(out.source, 'ors', 'used the ORS path');
    assert.strictEqual(out.distances.length, 2, 'one entry per destination');
    assert.strictEqual(out.distances[0].distance_mi, 5.0, 'metres -> miles, 1dp');
    assert.strictEqual(out.distances[0].duration_min, 25, 'seconds -> whole minutes');
    assert.strictEqual(out.distances[1].distance_mi, 40.0);
    assert.strictEqual(out.distances[1].duration_min, 50);
    // Auth header carries the key; payload uses [lon,lat] with origin first.
    assert.strictEqual(captured.init.headers.Authorization, 'secret-key');
    assert.deepStrictEqual(captured.body.locations[0], [ORIGIN.lon, ORIGIN.lat],
      'origin is [lon,lat] and first');
    assert.deepStrictEqual(captured.body.sources, [0]);
  });

  await test('(k2) rehabberDistances FALLBACK when ORS key missing/empty', async () => {
    let called = false;
    const fetchFn = async () => { called = true; return { status: 200, json: async () => ({}) }; };
    const out = await rehabberDistances(ORIGIN, DESTS, '', fetchFn);
    assert.strictEqual(out.source, 'haversine', 'no key -> haversine');
    assert.strictEqual(called, false, 'ORS NOT called without a key');
    assert.strictEqual(out.distances.length, 2);
    out.distances.forEach((d) => {
      assert.strictEqual(typeof d.distance_mi, 'number', 'straight-line miles present');
      assert.strictEqual(d.duration_min, null, 'no driving time on fallback');
    });
    // Sanity: dest[0] (~2mi) is clearly closer than dest[1] (~40mi).
    assert.ok(out.distances[0].distance_mi < out.distances[1].distance_mi);
  });

  await test('(k3) rehabberDistances FALLBACK on ORS network error', async () => {
    const out = await rehabberDistances(ORIGIN, DESTS, 'secret-key', mockOrsNetworkError);
    assert.strictEqual(out.source, 'haversine', 'network error -> haversine');
    assert.strictEqual(out.distances.length, 2);
    out.distances.forEach((d) => assert.strictEqual(d.duration_min, null));
  });

  await test('(k4) rehabberDistances FALLBACK on ORS HTTP error', async () => {
    const out = await rehabberDistances(ORIGIN, DESTS, 'secret-key', mockOrsHttpError);
    assert.strictEqual(out.source, 'haversine', 'HTTP 500 -> haversine');
    out.distances.forEach((d) => assert.strictEqual(d.duration_min, null));
  });

  await test('(k5) handler route ?mode=rehabber_distances ORS path (env key) + CORS', async () => {
    const captured = {};
    const fetchFn = mockOrsFetch([8046.72, 64373.76], [1500, 3000], captured);
    const res = await handleRequest(
      mockRequest('POST', { mode: 'rehabber_distances' }, { origin: ORIGIN, destinations: DESTS }),
      {
        ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: fetchFn,
        allowedOrigin: 'https://pages.example', orsApiKey: 'env-key-123',
      }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.source, 'ors');
    assert.strictEqual(body.distances[0].distance_mi, 5.0);
    assert.strictEqual(body.distances[0].duration_min, 25);
    assert.strictEqual(captured.init.headers.Authorization, 'env-key-123', 'env key forwarded');
    assert.strictEqual(res.header('Access-Control-Allow-Origin'), 'https://pages.example');
  });

  await test('(k6) handler route degrades to haversine when env key empty (NOT counted as agg)', async () => {
    let called = false;
    const fetchFn = async () => { called = true; return { status: 200, json: async () => ({}) }; };
    const res = await handleRequest(
      mockRequest('POST', { mode: 'rehabber_distances' }, { origin: ORIGIN, destinations: DESTS }),
      {
        ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: fetchFn,
        allowedOrigin: 'https://pages.example', orsApiKey: '',
      }
    );
    assert.strictEqual(res.status, 200, 'never breaks the panel');
    const body = await res.json();
    assert.strictEqual(body.source, 'haversine');
    assert.strictEqual(called, false, 'no ORS call without a key');
    assert.strictEqual(body.distances.length, 2);
  });

  await test('(k7) handler route never reads the volunteer KV (PII-safe)', async () => {
    let kvRead = false;
    const res = await handleRequest(
      mockRequest('POST', { mode: 'rehabber_distances' }, { origin: ORIGIN, destinations: DESTS }),
      {
        ResponseCtor: MockResponse,
        kv: { get: async () => { kvRead = true; return null; } },
        allowedOrigin: 'https://pages.example', orsApiKey: '',
      }
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(kvRead, false, 'rehabber-distance route must NOT touch volunteer KV');
    // Response carries only the distance contract -> no PII keys.
    const serialized = JSON.stringify(await res.json());
    ['home_county', 'roles', 'name', 'address'].forEach((k) => {
      assert.strictEqual(serialized.indexOf('"' + k + '"'), -1, 'no PII key: ' + k);
    });
  });

  // (l) VOLUNTEER DRIVING-distance radius filter (prescreen + ORS + fallback) -
  // The volunteer path is PII-pinned: only BARE [lon,lat] tuples may reach ORS,
  // and the response stays AGGREGATE-only. These tests cover: prescreen is a
  // superset, the driving filter SHRINKS the set, CHUNKING for large subsets,
  // graceful straight_line fallback on no-key/error, distance_mode field, and
  // PII-safety (no coords/names in the aggregate output or in what ORS sees).

  // Build an ORS mock whose driving metres per destination are a deterministic
  // function of the destination coord, regardless of batch ordering. `metresOf`
  // maps a {lon,lat} -> metres. Captures every batch's locations for chunk
  // assertions + a PII scan of the outbound payload.
  function mockOrsByCoord(metresOf, captured) {
    return async (url, init) => {
      let body = null;
      try { body = JSON.parse(init.body); } catch (e) { body = null; }
      if (captured) {
        captured.calls = (captured.calls || 0) + 1;
        captured.batches = captured.batches || [];
        captured.batches.push(body);
        captured.lastBody = body;
      }
      const locs = (body && body.locations) || [];
      // destinations are indices 1..N (origin is index 0).
      const destIdxs = (body && body.destinations) || [];
      const row = destIdxs.map((idx) => {
        const loc = locs[idx];          // [lon, lat]
        return metresOf({ lon: loc[0], lat: loc[1] });
      });
      return {
        status: 200,
        json: async () => ({ distances: [row], durations: [row.map(() => 600)] }),
      };
    };
  }

  // A volunteer set anchored at Harrisburg: 3 within ~14mi straight-line, 1 far.
  const VOL = [
    { lat: 40.2732, lon: -76.8867, roles: ['C&T', 'COURIER'], home_county: 'Dauphin', win_area: 'WIN-1', name: 'Alice', address: '1 Main' }, // ~0mi
    { lat: 40.36, lon: -76.78, roles: ['rvs c&t'], home_county: 'Lebanon', win_area: 'WIN-2', name: 'Bob', address: '2 Oak' },                // ~8mi
    { lat: 40.10, lon: -76.75, roles: ['Courier'], home_county: 'Lancaster', win_area: 'WIN-1', name: 'Carol', address: '3 Pine' },           // ~12mi
    { lat: 40.33, lon: -77.95, roles: ['C&T'], home_county: 'Huntingdon', win_area: 'WIN-9', name: 'Dave', address: '4 Elm' },                // ~50mi
    { lat: null, lon: null, roles: ['C&T'], home_county: 'Nowhere', win_area: 'WIN-X' },                                                       // invalid
  ];

  await test('(l1) drivingDistancesMiles: ORS metres -> miles, [lon,lat] tuples, no PII', async () => {
    const captured = {};
    // 8046.72 m -> 5.0 mi for every destination.
    const fetchFn = mockOrsByCoord(() => 8046.72, captured);
    const coords = [{ lat: 40.36, lon: -76.78 }, { lat: 40.10, lon: -76.75 }];
    const out = await drivingDistancesMiles(ANIMAL, coords, 'secret-key', fetchFn);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.milesByIndex.length, 2);
    assert.ok(Math.abs(out.milesByIndex[0] - 5.0) < 1e-6, 'metres -> miles');
    // DURATION is surfaced parallel to miles (mockOrsByCoord -> 600s = 10 min).
    assert.strictEqual(out.minutesByIndex.length, 2);
    assert.strictEqual(out.minutesByIndex[0], 10, 'seconds -> whole minutes');
    // Outbound payload uses [lon,lat] with origin first; carries ONLY coords.
    const body = captured.lastBody;
    assert.deepStrictEqual(body.locations[0], [ANIMAL.lon, ANIMAL.lat], 'origin [lon,lat] first');
    assert.deepStrictEqual(body.sources, [0]);
    const ser = JSON.stringify(body);
    ['name', 'address', 'home_county', 'roles', 'win_area'].forEach((k) => {
      assert.strictEqual(ser.indexOf('"' + k + '"'), -1, 'no PII key sent to ORS: ' + k);
    });
  });

  await test('(l2) drivingDistancesMiles: ok:false (fallback) when key empty', async () => {
    let called = false;
    const fetchFn = async () => { called = true; return { status: 200, json: async () => ({}) }; };
    const out = await drivingDistancesMiles(ANIMAL, [{ lat: 40.36, lon: -76.78 }], '', fetchFn);
    assert.strictEqual(out.ok, false, 'no key -> fallback signal');
    assert.strictEqual(called, false, 'ORS NOT called without a key');
  });

  await test('(l3) drivingDistancesMiles: ok:false on ORS network error / HTTP error', async () => {
    const c = [{ lat: 40.36, lon: -76.78 }];
    const errNet = await drivingDistancesMiles(ANIMAL, c, 'k', async () => { throw new Error('down'); });
    assert.strictEqual(errNet.ok, false, 'network error -> fallback');
    const errHttp = await drivingDistancesMiles(ANIMAL, c, 'k', async () => ({ status: 500, json: async () => ({}) }));
    assert.strictEqual(errHttp.ok, false, 'HTTP 500 -> fallback');
  });

  await test('(l4) drivingDistancesMiles: CHUNKS when subset exceeds per-request cap', async () => {
    const captured = {};
    const fetchFn = mockOrsByCoord(() => 1609.344, captured);  // 1.0 mi each
    // Build 1 origin + (2 * cap + 3) destinations so we get 3 chunks.
    const n = MAX_MATRIX_DESTINATIONS * 2 + 3;
    const coords = [];
    for (let i = 0; i < n; i += 1) coords.push({ lat: 40.27 + i * 0.0001, lon: -76.88 });
    const out = await drivingDistancesMiles(ANIMAL, coords, 'k', fetchFn);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.milesByIndex.length, n, 'one mile value per destination');
    assert.strictEqual(captured.calls, 3, 'three ORS Matrix calls (chunked)');
    // No batch exceeds the per-request destination cap.
    for (const b of captured.batches) {
      assert.ok(b.destinations.length <= MAX_MATRIX_DESTINATIONS, 'batch within cap');
    }
    out.milesByIndex.forEach((m) => assert.ok(Math.abs(m - 1.0) < 1e-6));
  });

  await test('(l5) drivingDistancesMiles: ANY chunk failure -> whole-call ok:false', async () => {
    let n = 0;
    // Succeed on the first chunk, fail (HTTP 500) on the second.
    const fetchFn = async (url, init) => {
      n += 1;
      if (n === 1) {
        const body = JSON.parse(init.body);
        const row = body.destinations.map(() => 1609.344);
        return { status: 200, json: async () => ({ distances: [row] }) };
      }
      return { status: 500, json: async () => ({}) };
    };
    const coords = [];
    for (let i = 0; i < MAX_MATRIX_DESTINATIONS + 5; i += 1) coords.push({ lat: 40.27 + i * 0.0001, lon: -76.88 });
    const out = await drivingDistancesMiles(ANIMAL, coords, 'k', fetchFn);
    assert.strictEqual(out.ok, false, 'a failed chunk aborts the whole driving attempt');
  });

  await test('(l6) findVolunteersInRadiusDriving: prescreen superset; driving filter SHRINKS set', async () => {
    // Straight-line: 3 volunteers within 20mi (Dauphin ~0, Lebanon ~8, Lancaster ~12).
    const pre = findVolunteersInRadius(ANIMAL.lat, ANIMAL.lon, 20, VOL);
    assert.strictEqual(pre.total_in_range, 3, 'haversine baseline = 3 in 20mi');

    // Driving mock: Lancaster (lat 40.10) is "far by road" (60mi) -> dropped;
    // the other two stay under 20 driving miles.
    const driveFn = mockOrsByCoord((c) => {
      if (Math.abs(c.lat - 40.10) < 1e-6) return 60 * 1609.344;  // 60 driving mi
      return 5 * 1609.344;                                       // 5 driving mi
    });
    const out = await findVolunteersInRadiusDriving(
      ANIMAL.lat, ANIMAL.lon, 20, VOL, drivingDistancesMiles, 'secret-key', driveFn
    );
    assert.strictEqual(out.distance_mode, 'driving', 'driving metric used');
    assert.strictEqual(out.aggregate.total_in_range, 2, 'driving filter shrank 3 -> 2');
    assert.strictEqual(out.aggregate.role_counts['COURIER'], 1, 'Lancaster courier dropped, Dauphin courier kept');
    assert.strictEqual(out.aggregate.role_counts['RVS C&T'], 1, 'Lebanon kept');
    // Output is AGGREGATE-only: NO coords / names anywhere.
    const ser = JSON.stringify(out.aggregate);
    ['lat', 'lon', 'name', 'address', 'home_county'].forEach((k) => {
      assert.strictEqual(ser.indexOf('"' + k + '"'), -1, 'no PII key in aggregate: ' + k);
    });
  });

  await test('(l7) findVolunteersInRadiusDriving: FALLBACK to straight_line on no key', async () => {
    let called = false;
    const driveFn = async () => { called = true; return { ok: false }; };
    const out = await findVolunteersInRadiusDriving(
      ANIMAL.lat, ANIMAL.lon, 20, VOL, drivingDistancesMiles, '', driveFn
    );
    // drivingDistancesMiles short-circuits on empty key, so driveFn-as-fetch is moot;
    // pass the REAL helper with empty key + a fetch that records being called.
    assert.strictEqual(out.distance_mode, 'straight_line', 'fallback mode');
    assert.strictEqual(out.aggregate.total_in_range, 3, 'fallback == haversine baseline');
  });

  await test('(l8) findVolunteersInRadiusDriving: FALLBACK on ORS error keeps prescreen set', async () => {
    const out = await findVolunteersInRadiusDriving(
      ANIMAL.lat, ANIMAL.lon, 20, VOL, drivingDistancesMiles, 'secret-key',
      async () => { throw new Error('ors down'); }
    );
    assert.strictEqual(out.distance_mode, 'straight_line');
    assert.strictEqual(out.aggregate.total_in_range, 3, 'never fewer than prescreen on fallback');
  });

  await test('(l9) findContextRowsDriving: driving distance_mi + gate + sorted; fallback', async () => {
    // Driving: Lancaster (40.10) far (60mi) -> excluded; Lebanon stays (~5mi driving).
    const driveFn = mockOrsByCoord((c) => {
      if (Math.abs(c.lat - 40.10) < 1e-6) return 60 * 1609.344;
      return 5 * 1609.344;
    });
    const ctx = await findContextRowsDriving(
      ANIMAL.lat, ANIMAL.lon, 20, VOL, 'Dauphin', drivingDistancesMiles, 'secret-key', driveFn
    );
    assert.strictEqual(ctx.distance_mode, 'driving');
    // Out-of-county within 20 DRIVING mi: Lebanon only (Lancaster dropped, Dauphin excluded).
    assert.strictEqual(ctx.rows.length, 1, 'driving gate dropped Lancaster');
    assert.strictEqual(ctx.rows[0].county, 'Lebanon');
    assert.strictEqual(ctx.rows[0].distance_mi, 5.0, 'distance_mi is DRIVING miles');
    // DRIVING mode also carries per-volunteer driving minutes (mockOrsByCoord
    // returns 600s = 10 min for every cell). Row whitelist now includes it.
    assert.strictEqual(ctx.rows[0].duration_min, 10, 'driving row carries duration_min (minutes)');
    assert.deepStrictEqual(Object.keys(ctx.rows[0]).sort(),
      ['county', 'distance_mi', 'duration_min', 'roles', 'win_area']);

    // Fallback path (no key) -> straight_line, both out-of-county rows present.
    const fb = await findContextRowsDriving(
      ANIMAL.lat, ANIMAL.lon, 20, VOL, 'Dauphin', drivingDistancesMiles, '', driveFn
    );
    assert.strictEqual(fb.distance_mode, 'straight_line');
    assert.strictEqual(fb.rows.length, 2, 'haversine keeps Lebanon + Lancaster');
    // STRAIGHT-LINE fallback: NO driving time fabricated -> duration_min absent.
    fb.rows.forEach((r) => {
      assert.ok(!('duration_min' in r), 'straight_line row has NO duration_min');
    });
    assert.deepStrictEqual(Object.keys(fb.rows[0]).sort(),
      ['county', 'distance_mi', 'roles', 'win_area']);
  });

  await test('(l10) handler end-to-end: driving mode, ORS sees only coords, PII-safe', async () => {
    const captured = {};
    const driveFn = mockOrsByCoord((c) => {
      if (Math.abs(c.lat - 40.10) < 1e-6) return 60 * 1609.344;
      return 5 * 1609.344;
    }, captured);
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20 }),
      {
        ResponseCtor: MockResponse, kv: mockKV(VOL), fetchFn: driveFn,
        allowedOrigin: 'https://pages.example', orsApiKey: 'env-key',
      }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.distance_mode, 'driving', 'driving mode end-to-end');
    assert.strictEqual(body.total_in_range, 2, 'driving filter shrank the set');
    // Top-level key set still PII-free + animal coords + distance_mode.
    assert.deepStrictEqual(Object.keys(body).sort(),
      ['animal_area', 'animal_county', 'animal_geoid', 'animal_lat', 'animal_lon', 'distance_mode', 'role_counts', 'total_in_range', 'win_areas']);
    const ser = JSON.stringify(body);
    for (const k of PII_FORBIDDEN_KEYS) {
      assert.strictEqual(ser.indexOf('"' + k + '"'), -1, 'PII key leaked: ' + k);
    }
    // What the Worker sent to ORS carried ONLY [lon,lat] coords (no PII).
    const sentSer = JSON.stringify(captured.lastBody);
    ['name', 'address', 'home_county', 'roles'].forEach((k) => {
      assert.strictEqual(sentSer.indexOf('"' + k + '"'), -1, 'no PII sent to ORS: ' + k);
    });
    assert.strictEqual(res.header('Access-Control-Allow-Origin'), 'https://pages.example');
  });

  await test('(l11) handler end-to-end: empty ORS key -> straight_line, full count', async () => {
    let called = false;
    const fetchFn = async () => { called = true; return { status: 200, json: async () => ({}) }; };
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20 }),
      {
        ResponseCtor: MockResponse, kv: mockKV(VOL), fetchFn: fetchFn,
        allowedOrigin: 'https://pages.example', orsApiKey: '',
      }
    );
    const body = await res.json();
    assert.strictEqual(body.distance_mode, 'straight_line');
    assert.strictEqual(body.total_in_range, 3, 'haversine baseline preserved');
    assert.strictEqual(called, false, 'no ORS call without a key');
  });

  await test('(l12) handler context=1 driving end-to-end carries distance_mode (PII-safe)', async () => {
    const driveFn = mockOrsByCoord((c) => {
      if (Math.abs(c.lat - 40.10) < 1e-6) return 60 * 1609.344;
      return 5 * 1609.344;
    });
    const res = await handleRequest(
      mockRequest('GET', {
        animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20,
        exclude_county: 'Dauphin', context: '1',
      }),
      {
        ResponseCtor: MockResponse, kv: mockKV(VOL), fetchFn: driveFn,
        allowedOrigin: 'https://pages.example', orsApiKey: 'env-key',
      }
    );
    const body = await res.json();
    assert.strictEqual(body.distance_mode, 'driving');
    // Out-of-county within DRIVING radius: Lebanon only.
    assert.strictEqual(body.out_of_county.length, 1);
    assert.strictEqual(body.out_of_county[0].county, 'Lebanon');
    // Deep-walk: no forbidden key.
    const allKeys = collectKeys(body, []);
    for (const k of TIER2_FORBIDDEN_KEYS) {
      assert.strictEqual(allKeys.indexOf(k), -1, 'PII key leaked: ' + k);
    }
  });

  // (rvsct) Separate-token RVS C&T synthesis (Tier-1 parity bug fix) --------
  // The data pipeline stores SEPARATE role tokens {C&T, RVS, Courier}; the
  // DERIVED 'RVS C&T' bucket means BOTH C&T AND RVS. rolesOf() must synthesize
  // it (mirroring refresh_monday.volunteer_buckets ct_no_rvs vs ct_rvs).
  await test('(rvsct-1) rolesOf synthesizes RVS C&T from separate [C&T, RVS]', () => {
    const matched = Array.from(rolesOf({ roles: ['C&T', 'RVS'] }));
    assert.ok(matched.indexOf('RVS C&T') !== -1, 'expected RVS C&T synthesized');
    // Exclusive like Tier 1's ct_rvs: NOT also counted as plain C&T.
    assert.ok(matched.indexOf('C&T') === -1, 'must not double-count as plain C&T');
  });

  await test('(rvsct-2) rolesOf for [C&T]-only does NOT emit RVS C&T', () => {
    const matched = Array.from(rolesOf({ roles: ['C&T'] }));
    assert.ok(matched.indexOf('C&T') !== -1, 'expected plain C&T');
    assert.ok(matched.indexOf('RVS C&T') === -1, 'C&T-only must not be RVS C&T');
  });

  await test('(rvsct-2b) literal combined token + courier passthrough unchanged', () => {
    assert.deepStrictEqual(Array.from(rolesOf({ roles: ['rvs c&t'] })).sort(), ['RVS C&T']);
    assert.deepStrictEqual(Array.from(rolesOf({ roles: ['Courier'] })).sort(), ['COURIER']);
    assert.deepStrictEqual(
      Array.from(rolesOf({ roles: ['C&T', 'RVS', 'COURIER'] })).sort(),
      ['COURIER', 'RVS C&T']
    );
  });

  // (rvsct-3) ADDRESS-tier qualifying: a separate-token RVS volunteer now
  // appears in the out-of-county context list and qualifies for Capture+RVS.
  await test('(rvsct-3) address tier surfaces [C&T, RVS] vol tagged RVS C&T + qualifies', () => {
    const DS = [
      // ~8mi NE, OUT-of-county (Lebanon), declares SEPARATE C&T + RVS tokens.
      { lat: 40.36, lon: -76.78, roles: ['C&T', 'RVS'], home_county: 'Lebanon', win_area: 'WIN-2' },
    ];
    const rows = findContextRows(ANIMAL.lat, ANIMAL.lon, 20, DS, 'Dauphin');
    assert.strictEqual(rows.length, 1, 'expected the RVS C&T volunteer in range');
    assert.deepStrictEqual(rows[0].roles, ['RVS C&T'], 'row tagged RVS C&T');
    // decision.js qualifiesForAnimal parity: Capture + RVS animal needs hasRvs.
    const declared = {};
    rows[0].roles.forEach((r) => { declared[String(r).replace(/\s+/g, '').toLowerCase()] = true; });
    const hasRvs = !!declared['rvsc&t'];
    assert.ok(hasRvs, 'qualifiesForAnimal hasRvs would now be true');
  });

  // (rvsct-4) role_counts parity: address-mode aggregate must match the COUNTY
  // (Tier 1) bucket semantics for the SAME dataset. ct_rvs = has_ct && has_rvs;
  // ct_no_rvs = has_ct && !has_rvs (exclusive); courier independent.
  await test('(rvsct-4) address-mode role_counts == county-tier bucket counts', () => {
    const DS = [
      { lat: 40.2732, lon: -76.8867, roles: ['C&T', 'COURIER'], home_county: 'Dauphin', win_area: 'WIN-1' }, // C&T only + courier
      { lat: 40.30, lon: -76.85, roles: ['C&T', 'RVS'], home_county: 'Lebanon', win_area: 'WIN-2' },          // ct_rvs
      { lat: 40.31, lon: -76.84, roles: ['rvs c&t'], home_county: 'Lancaster', win_area: 'WIN-3' },           // ct_rvs (literal)
      { lat: 40.10, lon: -76.75, roles: ['Courier'], home_county: 'York', win_area: 'WIN-4' },                // courier only
      { lat: 40.28, lon: -76.90, roles: ['C&T'], home_county: 'Perry', win_area: 'WIN-5' },                   // ct_no_rvs
    ];
    const agg = findVolunteersInRadius(ANIMAL.lat, ANIMAL.lon, 20, DS);

    // Independently compute county-tier buckets (refresh_monday.volunteer_buckets).
    const NORM = (r) => String(r).replace(/\s+/g, '').toLowerCase();
    const county = { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 0 };
    for (const rec of DS) {
      const keys = new Set((rec.roles || []).map(NORM));
      const hasCt = keys.has('c&t');
      const hasRvs = keys.has('rvs');
      const hasRvsCt = keys.has('rvsc&t') || (hasCt && hasRvs);
      const hasCourier = keys.has('courier');
      if (hasRvsCt) county['RVS C&T'] += 1;          // ct_rvs
      else if (hasCt) county['C&T'] += 1;            // ct_no_rvs (exclusive)
      if (hasCourier) county['COURIER'] += 1;        // courier (independent)
    }

    assert.strictEqual(agg.role_counts['C&T'], county['C&T'], 'C&T parity');
    assert.strictEqual(agg.role_counts['RVS C&T'], county['RVS C&T'], 'RVS C&T parity');
    assert.strictEqual(agg.role_counts['COURIER'], county['COURIER'], 'COURIER parity');
    // Sanity on the expected concrete values for this dataset.
    assert.strictEqual(county['RVS C&T'], 2, 'two ct_rvs volunteers');
    assert.strictEqual(county['C&T'], 2, 'two ct_no_rvs volunteers (Dauphin C&T+courier, Perry C&T)');
    assert.strictEqual(county['COURIER'], 2, 'two couriers');
  });

  // (pip) POINT-IN-POLYGON foundation over docs/data/pa_counties.json --------
  // The SAME committed GeoJSON the frontend uses; the worker imports it (not a
  // fork) and ray-casts to derive county/WIN-area/geoid from a coordinate.
  const { countyForPoint } = require('../src/pip');
  const PA_COUNTIES = require('../../docs/data/pa_counties.json');

  await test('(pip1) PIP: Allegheny intersection coord -> Allegheny / 10 / 42003', () => {
    // The diagnosis-spike coordinate that sits inside Allegheny.
    const hit = countyForPoint(-79.837476, 40.498948, PA_COUNTIES);
    assert.deepStrictEqual(hit, { county: 'Allegheny', win_area: '10', geoid: '42003' });
  });

  await test('(pip2) PIP: MultiPolygon feature (Chester) resolves via MP handling', () => {
    const chester = PA_COUNTIES.features.find((f) => f.properties.county === 'Chester');
    assert.strictEqual(chester.geometry.type, 'MultiPolygon', 'Chester is the MultiPolygon feature');
    // West Chester sits inside a MultiPolygon part -> proves MP iteration.
    const hit = countyForPoint(-75.6055, 39.9607, PA_COUNTIES);
    assert.deepStrictEqual(hit, { county: 'Chester', win_area: '16', geoid: '42029' });
  });

  await test('(pip3) PIP: coordinate outside every PA polygon -> null (no guess)', () => {
    assert.strictEqual(countyForPoint(-74.0, 39.0, PA_COUNTIES), null, 'Atlantic Ocean -> null');
    assert.strictEqual(countyForPoint(NaN, 40, PA_COUNTIES), null, 'NaN -> null');
  });

  await test('(pip4) picked-coord path: 564 E Maiden St, Washington PA -> Washington / 10', async () => {
    // Frontend "pick a candidate" flow sends the resolved coord as animal_lat/lon.
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: 40.1740, animal_lon: -80.2462, radius_mi: 20 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    const body = await res.json();
    assert.strictEqual(body.animal_county, 'Washington', 'picked-coord county is Washington');
    assert.strictEqual(body.animal_area, '10', 'Washington WIN area');
    assert.strictEqual(body.animal_geoid, '42125', 'Washington geoid');
  });

  await test('(pip5) picked-coord path: 321 2nd St, Port Carbon PA -> Schuylkill / 14 (NOT Monroe/9)', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: 40.6968, animal_lon: -76.1664, radius_mi: 20 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    const body = await res.json();
    assert.strictEqual(body.animal_county, 'Schuylkill', 'Port Carbon resolves to Schuylkill');
    assert.strictEqual(body.animal_area, '14', 'Schuylkill WIN area 14');
    assert.notStrictEqual(body.animal_county, 'Monroe', 'must NOT be Monroe (stale Tier-1 county)');
    assert.notStrictEqual(body.animal_area, '9', 'must NOT be WIN area 9');
  });

  // (pip6) Tier-1 fallback: coord OUTSIDE PA + animal_county supplied -> county
  // and area are derived from the county_win map; county_source flags the path.
  await test('(pip6) Tier-1 fallback: out-of-PA coord + animal_county=Washington -> county=Washington area=10 source=tier1_fallback', async () => {
    // -74.0, 39.0 is in the Atlantic Ocean — PIP returns null.
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: 39.0, animal_lon: -74.0, radius_mi: 20, animal_county: 'Washington' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.animal_county, 'Washington', 'county falls back to Tier-1 selection');
    assert.strictEqual(body.animal_area, '10', 'Washington WIN area is 10');
    assert.strictEqual(body.county_source, 'tier1_fallback', 'county_source flags the fallback path');
    assert.strictEqual(body.animal_geoid, null, 'geoid stays null — no polygon match for out-of-PA coord');
  });

  // (pip7) No fallback when both PIP and animal_county are absent.
  await test('(pip7) No Tier-1 county supplied + out-of-PA coord -> county=null area=null county_source absent', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: 39.0, animal_lon: -74.0, radius_mi: 20 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.animal_county, null, 'county is null when no fallback available');
    assert.strictEqual(body.animal_area, null, 'area is null when no fallback available');
    assert.ok(!Object.prototype.hasOwnProperty.call(body, 'county_source'), 'county_source absent when no fallback');
  });

  console.log('\n----------------------------------------');
  console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
  if (failed > 0) {
    for (const f of failures) {
      console.log('\nFAILURE: ' + f.name);
      console.log(f.err && f.err.stack ? f.err.stack : f.err);
    }
    process.exit(1);
  }
  console.log('ALL TESTS PASSED');
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});

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
 *   (d) success response contains ONLY {total_in_range, role_counts, win_areas}
 *       -- assert NO name/lat/lon/address/home_county keys leak
 *   (e) CORS header present on success, error and preflight responses
 *   + address geocode path uses MOCKED Census (no live call)
 */

const assert = require('assert');

const {
  clampRadius,
  haversineMi,
  findVolunteersInRadius,
  findContextRows,
  buildTier2Response,
  DEFAULT_RADIUS_MI,
  MAX_RADIUS_MI,
} = require('../src/aggregate');
const { geocodeAddress } = require('../src/census');
const { autocompleteAddress } = require('../src/autocomplete');
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
    assert.strictEqual((await res.json()).error, 'address_not_found');
  });

  await test('(c3b) 502 geocoder_unavailable on Census network error', async () => {
    const res = await handleRequest(
      mockRequest('GET', { address: '4400 Forbes Ave, Pittsburgh, PA 15213' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), fetchFn: mockCensusNetworkError, allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).error, 'geocoder_unavailable');
  });

  await test('(c4) 400 on out-of-range lat/lon', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: 999, animal_lon: -76.88 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 400);
  });

  // (d) PII-free key set on success --------------------------------------
  await test('(d) success body has ONLY {total_in_range, role_counts, win_areas}', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const keys = Object.keys(body).sort();
    assert.deepStrictEqual(keys, ['role_counts', 'total_in_range', 'win_areas'],
      'exact top-level key set, got: ' + JSON.stringify(keys));
    // Deep scan: no forbidden PII key anywhere in the serialized response.
    const serialized = JSON.stringify(body);
    for (const k of PII_FORBIDDEN_KEYS) {
      assert.ok(serialized.indexOf('"' + k + '"') === -1,
        'PII key leaked: ' + k + ' in ' + serialized);
    }
    // role_counts inner keys are only the 3 canonical roles.
    assert.deepStrictEqual(Object.keys(body.role_counts).sort(), ['C&T', 'COURIER', 'RVS C&T']);
  });

  await test('(d2) address path returns same PII-free aggregate (mocked Census)', async () => {
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
    assert.deepStrictEqual(Object.keys(body).sort(), ['role_counts', 'total_in_range', 'win_areas']);
    assert.strictEqual(body.total_in_range, 3);
  });

  await test('(d3) POST body path works and stays PII-free', async () => {
    const res = await handleRequest(
      mockRequest('POST', {}, { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, radius_mi: 20 }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(Object.keys(await res.json()).sort(),
      ['role_counts', 'total_in_range', 'win_areas']);
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
    assert.deepStrictEqual(c, { status: 'ok', coord: { lat: 40.2732, lon: -76.8867 } });
    const none = await geocodeAddress('nowhere', mockCensusNoMatch);
    assert.deepStrictEqual(none, { status: 'not_found' });
    const down = await geocodeAddress('1 Capitol', mockCensusNetworkError);
    assert.deepStrictEqual(down, { status: 'unavailable' });
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
    assert.deepStrictEqual(Object.keys(body).sort(), ['role_counts', 'total_in_range', 'win_areas']);
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
    // Top-level whitelist.
    assert.deepStrictEqual(Object.keys(body).sort(),
      ['out_of_county', 'out_of_county_truncated', 'radius_too_broad',
       'role_counts', 'total_in_range', 'win_areas']);
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
    // Byte-for-byte equal bodies; only the 3 legacy keys; no out_of_county.
    assert.strictEqual(resPlain.body, resOff.body, 'context off is byte-identical');
    assert.deepStrictEqual(Object.keys(await resPlain.json()).sort(),
      ['role_counts', 'total_in_range', 'win_areas']);
  });

  await test('(i7) handler context=1 carries CORS header', async () => {
    const res = await handleRequest(
      mockRequest('GET', { animal_lat: ANIMAL.lat, animal_lon: ANIMAL.lon, exclude_county: 'Dauphin', context: '1' }),
      { ResponseCtor: MockResponse, kv: mockKV(COORDS_PII), allowedOrigin: 'https://pages.example' }
    );
    assert.strictEqual(res.header('Access-Control-Allow-Origin'), 'https://pages.example');
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

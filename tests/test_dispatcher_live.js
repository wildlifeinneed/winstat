/* tests/test_dispatcher_live.js — Phase G live-Worker + coordinator-source harness.
 *
 * Run: node tests/test_dispatcher_live.js
 *
 * Covers:
 *   1. LIVE aggregate Worker — the 40.44 / -79.99 / 50mi example must return
 *      total 32, C&T 12, RVS C&T 0, COURIER 20, win areas {5,10,11}, and the
 *      UI's renderAggregate must still produce the recommended-action lines.
 *   2. County mode still enumerates all 67 PA counties.
 *   3. Coordinator source reconciliation: loadCoordinators() PREFERS the
 *      board-sourced data/coordinators.json and FALLS BACK to the xlsx-derived
 *      data/win_area_coordinators.json only when coordinators.json is
 *      empty/missing. Verified against the REAL functions extracted from
 *      docs/assets/dispatcher.js (no reimplementation).
 *
 * No external deps. The coordinator-fallback tests use a mocked fetch; the
 * live Worker test makes ONE real GET (skipped with WORKER_OFFLINE=1).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'docs', 'assets', 'dispatcher.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ok  - ' + msg); }
  else { failed++; console.error('  FAIL- ' + msg); }
}
function assertEqual(actual, expected, msg) {
  assert(actual === expected, msg + ' (expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual) + ')');
}

// ── Extract a named top-level function body from the IIFE source ──────────
// We grab the EXACT source text of the function so the harness exercises the
// committed implementation rather than a copy. Matches `function NAME(...) {`
// through its matching closing brace via a simple brace counter.
function extractFunction(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let i = SRC.indexOf('{', start);
  let depth = 0;
  for (; i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return SRC.slice(start, i);
}

// Build a sandbox exposing the REAL fetchCoordMap, loadCoordinators and
// coordinatorsForAreas, backed by an injectable fetch + state object.
function buildCoordSandbox(routes) {
  const state = { coordinators: {} };
  const sandbox = {
    state: state,
    Object: Object,
    Array: Array,
    String: String,
    Promise: Promise,
    console: console,
    fetch: function (url) {
      const body = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : undefined;
      if (body === undefined) {
        return Promise.resolve({ ok: false, json: function () { return Promise.resolve(null); } });
      }
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } });
    }
  };
  vm.createContext(sandbox);
  const code =
    extractFunction('fetchCoordMap') + '\n' +
    extractFunction('loadCoordinators') + '\n' +
    extractFunction('coordinatorsForAreas') + '\n' +
    'this.__loadCoordinators = loadCoordinators;\n' +
    'this.__coordinatorsForAreas = coordinatorsForAreas;\n';
  vm.runInContext(code, sandbox);
  return { sandbox: sandbox, state: state };
}

const BOARD = { '5': 'Board Five', '10': 'Board Ten', '11': 'Board Eleven' };
const XLSX = { '5': 'Sue DeArment', '10': 'Julia Meredith', '11': 'Janice Chippendale' };

async function testCoordPreferBoard() {
  console.log('\n[coord] prefers board-sourced coordinators.json when populated');
  const { sandbox, state } = buildCoordSandbox({
    'data/coordinators.json': BOARD,
    'data/win_area_coordinators.json': XLSX
  });
  await sandbox.__loadCoordinators();
  assertEqual(state.coordinators['10'], 'Board Ten', 'area 10 resolves from board map');
  const names = sandbox.__coordinatorsForAreas(['5', '10', '11']);
  assertEqual(names.join(','), 'Board Eleven,Board Five,Board Ten',
    'coordinatorsForAreas uses board names (sorted, NAME only)');
}

async function testCoordFallbackEmpty() {
  console.log('\n[coord] falls back to win_area_coordinators.json when board EMPTY ({})');
  const { sandbox, state } = buildCoordSandbox({
    'data/coordinators.json': {},
    'data/win_area_coordinators.json': XLSX
  });
  await sandbox.__loadCoordinators();
  assertEqual(state.coordinators['10'], 'Julia Meredith', 'area 10 resolves from xlsx fallback');
  const names = sandbox.__coordinatorsForAreas(['5', '10', '11']);
  assertEqual(names.join(','), 'Janice Chippendale,Julia Meredith,Sue DeArment',
    'fallback names render (sorted)');
}

async function testCoordFallbackMissing() {
  console.log('\n[coord] falls back when board MISSING (404)');
  const { sandbox, state } = buildCoordSandbox({
    // coordinators.json route absent -> fetch returns ok:false
    'data/win_area_coordinators.json': XLSX
  });
  await sandbox.__loadCoordinators();
  assertEqual(state.coordinators['5'], 'Sue DeArment', 'missing board -> xlsx used');
}

async function testCoordBothEmpty() {
  console.log('\n[coord] both empty -> empty map, no crash');
  const { sandbox, state } = buildCoordSandbox({
    'data/coordinators.json': {},
    'data/win_area_coordinators.json': {}
  });
  await sandbox.__loadCoordinators();
  assertEqual(Object.keys(state.coordinators).length, 0, 'no coordinators when both empty');
  assertEqual(sandbox.__coordinatorsForAreas(['5']).length, 0, 'no names rendered');
}

// Build a sandbox exposing the REAL nearestRehabbers / haversineMiles /
// geoCentroidLatLon, backed by an injectable state.rehabbers. Exercises the
// committed top-3 ranking + county-centroid logic (no reimplementation).
function buildRehabSandbox(rehabbers) {
  const state = { rehabbers: rehabbers || [] };
  const sandbox = {
    state: state,
    Math: Math,
    Number: Number,
    String: String,
    Array: Array,
    Object: Object,
    console: console
  };
  vm.createContext(sandbox);
  const code =
    extractFunction('haversineMiles') + '\n' +
    extractFunction('nearestRehabbers') + '\n' +
    extractFunction('eachRing') + '\n' +
    extractFunction('geoCentroidLatLon') + '\n' +
    'this.__haversineMiles = haversineMiles;\n' +
    'this.__nearestRehabbers = nearestRehabbers;\n' +
    'this.__geoCentroidLatLon = geoCentroidLatLon;\n';
  vm.runInContext(code, sandbox);
  return { sandbox: sandbox, state: state };
}

// Realistic small fixture: 5 rehabbers around western PA. Distances increase
// roughly from the Pittsburgh-ish origin used below. open/closed is omitted —
// the panel no longer surfaces it; phone + county are what the rows show.
const REHAB_FIXTURE = [
  { rehab_name: 'Alpha (closest, has site)', county: 'Allegheny', lat: 40.44, lon: -79.99,
    phone: '(412) 555-0101', availability: 'Songbirds only\nM,P,R RVS', website: 'https://alpha.example' },
  { rehab_name: 'Bravo (2nd, no phone, no site)', county: 'Allegheny', lat: 40.50, lon: -80.10,
    phone: '', availability: 'Mammals', website: '' },
  { rehab_name: 'Charlie (3rd, no site)', county: 'Butler', lat: 40.86, lon: -79.90,
    phone: '724-555-0103', availability: 'Raptors', website: '' },
  { rehab_name: 'Delta (4th)', county: 'Westmoreland', lat: 40.30, lon: -79.50,
    phone: '724-555-0104', availability: '', website: 'https://delta.example' },
  { rehab_name: 'Echo (far)', county: 'Erie', lat: 42.13, lon: -80.08,
    phone: '814-555-0105', availability: 'All', website: 'https://echo.example' }
];

function testRehabTop3Ranking() {
  console.log('\n[rehab] nearestRehabbers returns top-3 sorted ascending by distance');
  const { sandbox } = buildRehabSandbox(REHAB_FIXTURE);
  const rows = sandbox.__nearestRehabbers(40.44, -79.99, 3);
  assertEqual(rows.length, 3, 'returns exactly 3 rows');
  assertEqual(rows[0].rehab_name, 'Alpha (closest, has site)', 'rank 1 is the closest');
  assert(rows[0].distance_mi <= rows[1].distance_mi, 'row0 <= row1 distance');
  assert(rows[1].distance_mi <= rows[2].distance_mi, 'row1 <= row2 distance');
  assert(rows[0].distance_mi < 0.001, 'closest distance ~0 mi for coincident origin');
  const names = rows.map(function (r) { return r.rehab_name; });
  assert(names.indexOf('Echo (far)') < 0, 'far rehabber excluded from top-3');
}

function testRehabDistanceFormatting() {
  console.log('\n[rehab] distance formats to one decimal place (X.X mi)');
  const { sandbox } = buildRehabSandbox(REHAB_FIXTURE);
  const rows = sandbox.__nearestRehabbers(40.44, -79.99, 3);
  rows.forEach(function (r) {
    const txt = r.distance_mi.toFixed(1);
    assert(/^\d+\.\d$/.test(txt), 'distance ' + txt + ' has exactly one decimal');
  });
  assert(rows[1].distance_mi > 0, 'second row has a positive distance');
}

function testRehabWebsiteFlag() {
  console.log('\n[rehab] empty website normalized to "" (link omitted by renderer); no open/closed surfaced');
  const { sandbox } = buildRehabSandbox(REHAB_FIXTURE);
  const rows = sandbox.__nearestRehabbers(40.44, -79.99, 3);
  const alpha = rows.find(function (r) { return r.rehab_name.indexOf('Alpha') === 0; });
  const bravo = rows.find(function (r) { return r.rehab_name.indexOf('Bravo') === 0; });
  assertEqual(alpha.website, 'https://alpha.example', 'non-empty website preserved');
  assertEqual(bravo.website, '', 'empty website stays empty (renderer omits link)');
  // open/closed status is intentionally NOT carried on the row objects anymore.
  assertEqual(alpha.open_closed, undefined, 'no open_closed field on row');
  assertEqual(alpha.is_open, undefined, 'no is_open field on row');
  assertEqual(alpha.is_closed, undefined, 'no is_closed field on row');
}

function testRehabPhoneAndCounty() {
  console.log('\n[rehab] rows carry phone (verbatim) + county; empty phone stays ""');
  const { sandbox } = buildRehabSandbox(REHAB_FIXTURE);
  const rows = sandbox.__nearestRehabbers(40.44, -79.99, 3);
  const alpha = rows.find(function (r) { return r.rehab_name.indexOf('Alpha') === 0; });
  const bravo = rows.find(function (r) { return r.rehab_name.indexOf('Bravo') === 0; });
  assertEqual(alpha.phone, '(412) 555-0101', 'verbatim formatted phone preserved');
  assertEqual(alpha.county, 'Allegheny', 'county carried on the row');
  assertEqual(bravo.phone, '', 'empty phone stays "" (renderer shows placeholder)');
}

function testRehabFewerThan3() {
  console.log('\n[rehab] fewer than 3 -> returns what exists; skips missing coords');
  const { sandbox } = buildRehabSandbox([
    REHAB_FIXTURE[0],
    { rehab_name: 'NoCoords', phone: '', availability: 'x', website: '' }
  ]);
  const rows = sandbox.__nearestRehabbers(40.44, -79.99, 3);
  assertEqual(rows.length, 1, 'only the one rehabber with numeric coords is ranked');
  assertEqual(rows[0].rehab_name, 'Alpha (closest, has site)', 'coord-bearing row kept');
}

function testCountyCentroidFromGeojson() {
  console.log('\n[rehab] county centroid from pa_counties.geojson is inside PA');
  const { sandbox } = buildRehabSandbox([]);
  const geo = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'data', 'pa_counties.geojson'), 'utf8'));
  const alleg = geo.features.find(function (f) {
    return f.properties && f.properties.county === 'Allegheny';
  });
  assert(!!alleg, 'Allegheny feature present in geojson');
  const c = sandbox.__geoCentroidLatLon(alleg.geometry);
  assert(!!c, 'centroid computed');
  assert(c.lat > 40.2 && c.lat < 40.8, 'centroid lat in Allegheny range (got ' + c.lat + ')');
  assert(c.lon > -80.4 && c.lon < -79.7, 'centroid lon in Allegheny range (got ' + c.lon + ')');
  let allInPa = true;
  geo.features.forEach(function (f) {
    const ctr = sandbox.__geoCentroidLatLon(f.geometry);
    if (!ctr || ctr.lat < 39.5 || ctr.lat > 42.6 || ctr.lon < -80.7 || ctr.lon > -74.5) {
      allInPa = false;
    }
  });
  assert(allInPa, 'all 67 county centroids fall within PA bounding box');
}

function testCountyCount() {
  console.log('\n[county] PA_COUNTIES still enumerates 67 counties');
  const m = SRC.match(/var PA_COUNTIES = \[([\s\S]*?)\];/);
  assert(!!m, 'PA_COUNTIES array present');
  const arr = m[1].split(',').map(function (s) {
    return s.trim().replace(/^'/, '').replace(/'$/, '');
  }).filter(Boolean);
  assertEqual(arr.length, 67, 'county count');
}

const WORKER_URL = 'https://pa-wildlife-dispatcher.winstat.workers.dev';

async function testLiveWorker() {
  console.log('\n[live] aggregate Worker — 40.44 / -79.99 / 50mi');
  if (process.env.WORKER_OFFLINE === '1' || typeof fetch !== 'function') {
    console.log('  skip - WORKER_OFFLINE=1 or no global fetch');
    return;
  }
  const url = WORKER_URL + '?animal_lat=40.44&animal_lon=-79.99&radius_mi=50';
  const resp = await fetch(url, { cache: 'no-store' });
  assert(resp.ok, 'worker responded 2xx');
  const agg = await resp.json();
  assertEqual(agg.total_in_range, 32, 'total_in_range');
  assertEqual(agg.role_counts['C&T'], 12, 'C&T count');
  assertEqual(agg.role_counts['RVS C&T'], 0, 'RVS C&T count');
  assertEqual(agg.role_counts['COURIER'], 20, 'COURIER count');
  const areas = (agg.win_areas || []).slice().sort();
  assertEqual(areas.join(','), '10,11,5', 'win areas {5,10,11}');

  // Recommended-action lines: exercise the REAL coordinatorsForAreas against
  // the xlsx map for these areas (board would override at runtime) and confirm
  // qualifying-role + coordinator action text is produced.
  const { sandbox } = buildCoordSandbox({ 'data/win_area_coordinators.json': XLSX });
  await sandbox.__loadCoordinators();
  const coordNames = sandbox.__coordinatorsForAreas(agg.win_areas);
  assert(coordNames.length > 0, 'coordinator action line has names for live areas');
  const hasQualified = ['C&T', 'RVS C&T', 'COURIER'].some(function (r) {
    return (agg.role_counts[r] || 0) > 0;
  });
  assert(hasQualified, 'qualified volunteers present -> no PGC escalation forced');
}

(async function main() {
  console.log('== Phase G live-Worker + coordinator-source harness ==');
  testCountyCount();
  testRehabTop3Ranking();
  testRehabDistanceFormatting();
  testRehabWebsiteFlag();
  testRehabPhoneAndCounty();
  testRehabFewerThan3();
  testCountyCentroidFromGeojson();
  await testCoordPreferBoard();
  await testCoordFallbackEmpty();
  await testCoordFallbackMissing();
  await testCoordBothEmpty();
  await testLiveWorker();

  console.log('\n----------------------------------------');
  console.log('passed: ' + passed + '   failed: ' + failed);
  if (failed > 0) process.exit(1);
})().catch(function (err) {
  console.error('harness crashed:', err);
  process.exit(2);
});

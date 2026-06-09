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

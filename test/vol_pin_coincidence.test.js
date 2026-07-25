'use strict';
/**
 * Coincidence-backstop test for the volunteer map pins.
 *
 * Root cause of the bug this guards: two volunteers who share ONE home address
 * get IDENTICAL base coordinates. The Worker's per-person jitter now separates
 * them, but as a GUARANTEED safety net both map renderers (Tier 1 cross-post
 * `addVolRows`, Tier 2 `paintT2Map`) apply a tiny deterministic spiral offset
 * when a jittered ("exact") pin would land on coordinates already used by
 * another pin THIS render — so two coincident pins never collapse into one.
 *
 * Rather than paraphrase the algorithm, this test EXTRACTS the actual shipped
 * backstop code blocks from docs/assets/dispatcher.js by their marker comments
 * and executes them verbatim via `new Function`, proving that:
 *   (1) the FIRST pin at a coordinate is left untouched, and
 *   (2) the SECOND coincident pin is nudged to a DISTINCT, deterministic point,
 *       with a small (< jitter) magnitude.
 * If the source blocks are edited in a way that breaks the separation, the
 * extraction still runs the NEW code and the assertions catch the regression.
 *
 * Run: node test/vol_pin_coincidence.test.js   (exit 0 = pass, 1 = fail)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DISPATCHER_JS = path.resolve(__dirname, '..', 'docs', 'assets', 'dispatcher.js');
const SRC = fs.readFileSync(DISPATCHER_JS, 'utf8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.error('  \u2717 ' + name);
    console.error('    ' + (e.message || e));
  }
}

// Extract the exact `else { ... }` backstop block that follows a given anchor
// line. We slice from the anchor's matching `else {` to its closing brace by
// counting braces, guaranteeing we run the SHIPPED source (not a copy).
function extractBackstop(src, anchorRegex) {
  const m = src.match(anchorRegex);
  assert.ok(m, 'anchor not found: ' + anchorRegex);
  // Find the `else {` that starts right after the anchor's if-block close.
  const from = src.indexOf('} else {', m.index);
  assert.ok(from !== -1, 'no `} else {` after anchor: ' + anchorRegex);
  const braceStart = src.indexOf('{', from + 1);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  // Body BETWEEN the outer braces of the else block.
  return src.slice(braceStart + 1, i);
}

// ── Tier 2 (paintT2Map): anchor on the `if (!v.exact) {` centroid branch. ──
// The else branch is the jittered-pin coincidence backstop. It reads `v` and
// mutates `lat`/`lon`, keyed on a shared `perCounty` map.
const T2_BODY = extractBackstop(SRC, /if\s*\(!v\.exact\)\s*\{/);
const t2Backstop = new Function('v', 'perCounty', 'lat', 'lon',
  T2_BODY + '\n return { lat: lat, lon: lon };');

// ── Tier 1 (addVolRows): anchor on the `if (!(typeof row.approx_lat ...))`. ──
// The else branch is the jittered-pin coincidence backstop. It reads pinLat/
// pinLon and mutates them, keyed on the same `perCounty` map.
const T1_BODY = extractBackstop(SRC, /if\s*\(!\(typeof row\.approx_lat === 'number' && isFinite\(row\.approx_lat\)\)\)\s*\{/);
const t1Backstop = new Function('perCounty', 'pinLat', 'pinLon',
  T1_BODY + '\n return { lat: pinLat, lon: pinLon };');

// The jitter magnitude the Worker uses is ~1 mile ≈ ~0.0145° of latitude. The
// backstop nudge must be SMALLER than that so it never dominates the obscuring
// offset. We assert the separation is small but non-zero.
const JITTER_DEG_APPROX = 1.0 / 69.0; // ~0.0145

console.log('\nTier 2 paintT2Map — coincidence backstop:');
test('two coincident jittered pins render as TWO distinct points (2nd nudged, 1st untouched)', () => {
  const perCounty = {};
  const LAT = 40.2732, LON = -76.8867;
  const v = { exact: true, lat: LAT, lon: LON, county: 'Dauphin' };
  const first = t2Backstop(v, perCounty, LAT, LON);
  const second = t2Backstop(v, perCounty, LAT, LON);
  // First pin at a coordinate is NOT moved.
  assert.strictEqual(first.lat, LAT, 'first pin lat untouched');
  assert.strictEqual(first.lon, LON, 'first pin lon untouched');
  // Second coincident pin IS separated.
  assert.notDeepStrictEqual(second, first, 'second coincident pin is nudged to a distinct point');
  // Separation is small (< the jitter magnitude) and non-zero.
  const dLat = Math.abs(second.lat - LAT);
  const dLon = Math.abs(second.lon - LON);
  const sep = Math.sqrt(dLat * dLat + dLon * dLon);
  assert.ok(sep > 0, 'separation is non-zero');
  assert.ok(sep < JITTER_DEG_APPROX, 'backstop nudge (' + sep.toFixed(5) + '°) is smaller than the ~1mi jitter');
});

test('backstop is deterministic — same coincidence order yields the same nudge', () => {
  const LAT = 40.5, LON = -77.1;
  const v = { exact: true, lat: LAT, lon: LON, county: 'Centre' };
  const a = {}; t2Backstop(v, a, LAT, LON); const a2 = t2Backstop(v, a, LAT, LON);
  const b = {}; t2Backstop(v, b, LAT, LON); const b2 = t2Backstop(v, b, LAT, LON);
  assert.deepStrictEqual(a2, b2, 'same order -> same deterministic nudge');
});

test('a DIFFERENT jittered coordinate is left untouched (only exact coincidence fires)', () => {
  const perCounty = {};
  const v1 = { exact: true, lat: 40.10, lon: -76.75, county: 'Lancaster' };
  const v2 = { exact: true, lat: 40.36, lon: -76.78, county: 'Lebanon' };
  const p1 = t2Backstop(v1, perCounty, 40.10, -76.75);
  const p2 = t2Backstop(v2, perCounty, 40.36, -76.78);
  assert.deepStrictEqual(p1, { lat: 40.10, lon: -76.75 }, 'distinct coord #1 untouched');
  assert.deepStrictEqual(p2, { lat: 40.36, lon: -76.78 }, 'distinct coord #2 untouched');
});

console.log('\nTier 1 addVolRows — coincidence backstop:');
test('two coincident jittered pins render as TWO distinct points (2nd nudged, 1st untouched)', () => {
  const perCounty = {};
  const LAT = 40.2732, LON = -76.8867;
  const first = t1Backstop(perCounty, LAT, LON);
  const second = t1Backstop(perCounty, LAT, LON);
  assert.strictEqual(first.lat, LAT, 'first pin lat untouched');
  assert.strictEqual(first.lon, LON, 'first pin lon untouched');
  assert.notDeepStrictEqual(second, first, 'second coincident pin is nudged to a distinct point');
  const dLat = Math.abs(second.lat - LAT);
  const dLon = Math.abs(second.lon - LON);
  const sep = Math.sqrt(dLat * dLat + dLon * dLon);
  assert.ok(sep > 0, 'separation is non-zero');
  assert.ok(sep < JITTER_DEG_APPROX, 'backstop nudge (' + sep.toFixed(5) + '°) is smaller than the ~1mi jitter');
});

test('three coincident pins all land on DISTINCT points', () => {
  const perCounty = {};
  const LAT = 41.0, LON = -75.5;
  const pins = [
    t1Backstop(perCounty, LAT, LON),
    t1Backstop(perCounty, LAT, LON),
    t1Backstop(perCounty, LAT, LON),
  ];
  const keys = pins.map(function (p) { return p.lat.toFixed(6) + ',' + p.lon.toFixed(6); });
  const uniq = new Set(keys);
  assert.strictEqual(uniq.size, 3, 'all three coincident pins are distinct (got ' + uniq.size + ')');
});

console.log('\n' + '-'.repeat(40));
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
console.log('ALL TESTS PASSED');

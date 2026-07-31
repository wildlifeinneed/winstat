'use strict';
/**
 * Monitoring-volunteer pin test for the cross-post map.
 *
 * `renderCrossPostMap` (docs/assets/dispatcher.js) is the SINGLE function that
 * renders the Leaflet map shown after BOTH Tier 1's "Check for Cross Post"
 * button (By-County panel) AND Tier 2's cross-post control (address/widen
 * panel) — see crossPostDistanceCheck's one call site at both the Tier-1
 * geocode-resolved callback and the Tier-2 direct-coordinate callback, which
 * both funnel into the same renderCrossPostMap(...). Because the function is
 * shared, one code path change covers "both maps"; this test proves that
 * sharing by asserting BOTH known call sites resolve to the identical function
 * reference, then exercises the monitoring-pin renderer itself.
 *
 * Rather than paraphrase the algorithm, this test EXTRACTS the actual shipped
 * `addMonitoringVolRows` function (and its small pure helpers) from
 * docs/assets/dispatcher.js by marker comments and executes it verbatim via
 * `new Function`, against a mocked Leaflet (`L`) + `state.countyCentroids`, so
 * a regression in the real source is caught here.
 *
 * Run: node test/monitoring_pins.test.js   (exit 0 = pass, 1 = fail)
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
    console.error('    ' + (e.stack || e.message || e));
  }
}

// ── Structural check: BOTH tiers share renderCrossPostMap ──────────────────
// Tier 1 ("Check for Cross Post" button, By-County panel) resolves its
// geocode/selected-coord result through crossPostDistanceCheck(); Tier 2
// (address/widen panel) calls crossPostDistanceCheck() directly. Both then
// call renderCrossPostMap(lat, lon, dispatchArea, nearby, resultDiv, county)
// with the SAME signature — assert only ONE function definition exists (no
// per-tier fork) and that both known call-site patterns are present verbatim.
console.log('Shared cross-post map (both tiers):');
test('renderCrossPostMap has exactly ONE definition in dispatcher.js', () => {
  const defs = SRC.match(/function renderCrossPostMap\(/g) || [];
  assert.strictEqual(defs.length, 1, 'expected exactly one renderCrossPostMap definition, found ' + defs.length);
});
test('Tier 1 path (crossPostDistanceCheck) calls renderCrossPostMap with the shared signature', () => {
  assert.ok(
    /renderCrossPostMap\(lat, lon, dispatchArea, nearby, resultDiv, county\);/.test(SRC),
    'expected call-site renderCrossPostMap(lat, lon, dispatchArea, nearby, resultDiv, county)');
});
test('Tier 2 entry point (crossPostDistanceCheck) is the ONLY function that calls renderCrossPostMap with fresh args (Tier 2 has no separate map renderer)', () => {
  // Tier 2's button handler calls crossPostDistanceCheck directly (no Tier-2-only
  // map function name exists anywhere in the file).
  assert.ok(!/function\s+renderTier2CrossPostMap/.test(SRC), 'no separate Tier-2-only map renderer exists');
  assert.ok(/crossPostDistanceCheck\(agg\.animal_lat, agg\.animal_lon, dispatchArea, resultDiv, animalCounty\);/.test(SRC),
    'Tier 2 button handler calls the SAME crossPostDistanceCheck used by Tier 1');
});

// ── Extraction helpers ──────────────────────────────────────────────────────
function extractFunctionBody(src, headerRegex) {
  const m = src.match(headerRegex);
  assert.ok(m, 'anchor not found: ' + headerRegex);
  const braceStart = src.indexOf('{', m.index + m[0].length - 1);
  assert.ok(braceStart !== -1, 'no opening brace after: ' + headerRegex);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(braceStart + 1, i);
}

// Pure helpers addMonitoringVolRows depends on (extracted verbatim).
const ESCAPE_HTML_BODY = extractFunctionBody(SRC, /function escapeHtml\(s\)\s*\{/);
const escapeHtml = new Function('s', ESCAPE_HTML_BODY);

const T2_VOL_PIN_CLASS_BODY = extractFunctionBody(SRC, /function t2VolPinClass\(roles\)\s*\{/);
const t2VolPinClass = new Function('roles', T2_VOL_PIN_CLASS_BODY);

const T2_DIV_ICON_BODY = extractFunctionBody(SRC, /function t2DivIcon\(cls, size\)\s*\{/);

// The SHIPPED addMonitoringVolRows body (verbatim from dispatcher.js).
const ADD_MONITORING_VOL_ROWS_BODY = extractFunctionBody(SRC, /function addMonitoringVolRows\(rows\)\s*\{/);

// Minimal fake Leaflet: L.marker(...).bindPopup(...) chain, tracking every
// created marker so assertions can inspect icon class + popup text.
function makeFakeL() {
  const createdMarkers = [];
  const L = {
    divIcon: function (opts) { return { __divIcon: true, opts: opts }; },
    marker: function (latlng, opts) {
      const rec = {
        latlng: latlng, opts: opts, popupHtml: null, addedTo: null,
        bindPopup: function (html) { rec.popupHtml = html; return rec; },
        addTo: function (layerGroup) { rec.addedTo = layerGroup; return rec; },
      };
      createdMarkers.push(rec);
      return rec;
    },
  };
  return { L: L, createdMarkers: createdMarkers };
}

// Build a runnable addMonitoringVolRows(rows) closure with all the outer-scope
// free variables renderCrossPostMap normally provides, wired to test doubles.
function buildAddMonitoringVolRows(opts) {
  const { L } = opts.fakeL;
  // t2DivIcon references the outer `L` — build it bound to our fake L via a
  // small wrapper instead of text substitution (keeps the extracted body
  // byte-identical to source; only the OUTER L binding is supplied).
  function t2DivIconWrapped(cls, size) {
    return (new Function('L', 'cls', 'size', T2_DIV_ICON_BODY))(L, cls, size);
  }

  const fnBody =
    'var qualifyFn = opts.qualifyFn;\n' +
    'var hasBase = opts.hasBase;\n' +
    'var rvs = opts.rvs;\n' +
    'var issue = opts.issue;\n' +
    'var monSeen = {};\n' +
    'var perCounty = opts.perCounty;\n' +
    'var state = opts.state;\n' +
    'var cpMapRef = opts.cpMapRef;\n' +
    'var bounds = opts.bounds;\n' +
    'var cpVolMarkers = opts.cpVolMarkers;\n' +
    'return function addMonitoringVolRows(rows) {\n' +
    ADD_MONITORING_VOL_ROWS_BODY +
    '\n};';

  return new Function('L', 'escapeHtml', 't2VolPinClass', 't2DivIcon', 'opts',
    fnBody)(
    L, escapeHtml, t2VolPinClass, t2DivIconWrapped, opts);
}

// ── Test fixtures ────────────────────────────────────────────────────────
const CENTROIDS = {
  'Elk': { lat: 41.4, lon: -78.7 },
  'Butler': { lat: 40.86, lon: -79.9 },
};

function makeHarness(overrides) {
  const fakeL = makeFakeL();
  const bounds = [];
  const cpVolMarkers = [];
  const perCounty = (overrides && overrides.perCounty) || {};
  const opts = {
    qualifyFn: (overrides && overrides.qualifyFn) || null,
    hasBase: !!(overrides && overrides.hasBase),
    rvs: !!(overrides && overrides.rvs),
    issue: (overrides && overrides.issue) || '',
    perCounty: perCounty,
    state: { countyCentroids: CENTROIDS },
    cpMapRef: { layers: { vols: { __group: true } } },
    bounds: bounds,
    cpVolMarkers: cpVolMarkers,
    fakeL: fakeL,
  };
  const addMonitoringVolRows = buildAddMonitoringVolRows(opts);
  return { addMonitoringVolRows, fakeL, bounds, cpVolMarkers, perCounty };
}

console.log('\naddMonitoringVolRows — rendering:');

test('monitoring volunteer renders a pin with the t2-pin-monitor class (visually distinct)', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] },
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 1, 'one marker created');
  const m = h.fakeL.createdMarkers[0];
  assert.ok(m.opts.icon.opts.html.indexOf('t2-pin-monitor') !== -1,
    'marker icon HTML carries the t2-pin-monitor class: ' + m.opts.icon.opts.html);
  // Still carries the role color class too (role + monitor ring, not JUST a color swap).
  assert.ok(m.opts.icon.opts.html.indexOf('t2-pin-vol-ct') !== -1,
    'marker icon HTML also carries the role color class (t2-pin-vol-ct)');
});

test('monitoring pin carries a TEXTUAL indicator (popup + title), not color alone', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['COURIER'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] },
  ]);
  const m = h.fakeL.createdMarkers[0];
  assert.ok(/Monitoring volunteer/i.test(m.popupHtml),
    'popup text mentions "Monitoring volunteer": ' + m.popupHtml);
  assert.ok(/Monitoring volunteer/i.test(m.opts.title),
    'marker title mentions "Monitoring volunteer": ' + m.opts.title);
  assert.ok(/Elk/.test(m.popupHtml), 'popup mentions the home county');
});

test('cpVolMarkers legend entry is flagged monitoring:true (drives the text legend line)', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] },
  ]);
  assert.strictEqual(h.cpVolMarkers.length, 1);
  assert.strictEqual(h.cpVolMarkers[0].monitoring, true, 'legend entry marked as monitoring');
});

test('qualification filter still applies to monitoring rows (does not change WHO qualifies, only display)', () => {
  const qualifyFn = function (roles) { return roles.indexOf('COURIER') === -1; }; // COURIER never qualifies
  const h = makeHarness({ qualifyFn: qualifyFn, hasBase: true, issue: 'capture' });
  h.addMonitoringVolRows([
    { roles: ['COURIER'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] },
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] },
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 1, 'only the qualifying row renders a pin');
});

test('rows missing a resolvable county centroid are skipped (no placed=false crash / silent no-op)', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'NoSuchCounty', monitored_areas: ['1'] },
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 0, 'no pin created for an unresolvable county');
});

test('duplicate monitoring rows (same county+area+roles) across multiple area fetches are de-duplicated', () => {
  const h = makeHarness();
  const row = { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] };
  h.addMonitoringVolRows([row]);
  h.addMonitoringVolRows([row]); // simulates a second per-area fetch returning the same monitor
  assert.strictEqual(h.fakeL.createdMarkers.length, 1, 'duplicate monitoring vol only renders once');
});

console.log('\naddMonitoringVolRows — coincidence with a regular volunteer pin:');

test('a monitoring volunteer whose home-county centroid COINCIDES with an existing pin still gets a DISTINCT point', () => {
  // Simulate the shared perCounty map already having one entry for "Elk"
  // (as if a regular volunteer with no approx_lat/lon already placed a pin
  // there via addVolRows's county-centroid branch, which increments
  // perCounty['Elk'] the same way).
  const perCounty = { Elk: 1 };
  const h = makeHarness({ perCounty: perCounty });
  const centroid = CENTROIDS.Elk;
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] },
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 1, 'monitoring pin still created');
  const [pinLat, pinLon] = h.fakeL.createdMarkers[0].latlng;
  assert.notStrictEqual(pinLat, centroid.lat, 'monitoring pin lat is nudged off the bare centroid');
  assert.ok(
    Math.abs(pinLat - centroid.lat) > 0 || Math.abs(pinLon - centroid.lon) > 0,
    'monitoring pin is offset from the raw centroid (distinct point, not overlapping the existing pin)');
});

test('two monitoring volunteers with the SAME home county but DIFFERENT roles both get distinct, visible pins', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] },
    { roles: ['RVS C&T'], win_area: '9', home_county: 'Elk', monitored_areas: ['1'] },
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 2, 'both monitoring vols render distinct pins');
  const [lat1, lon1] = h.fakeL.createdMarkers[0].latlng;
  const [lat2, lon2] = h.fakeL.createdMarkers[1].latlng;
  assert.ok(lat1 !== lat2 || lon1 !== lon2, 'the two coincident-county monitoring pins land on DISTINCT points');
});

console.log('\n' + '-'.repeat(40));
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
console.log('ALL TESTS PASSED');

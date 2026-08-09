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
 * OWNER'S DEFINITIVE INCLUSION RULE (overrides the earlier "wider scope is by
 * design" conclusion): for a cross-post map whose TARGET/dispatch area is T,
 * include a monitoring volunteer pin IFF (1) their home win_area != T, AND
 * (2) T is present in their monitored_areas. Monitors of a SUGGESTED area
 * (not T itself) must NOT get a pin just because that area is also shown on
 * the map. This is enforced by gating the per-area fetch loop in
 * renderCrossPostMap so addMonitoringVolRows is only ever invoked for the
 * areaKey === normDispatch (target) fetch — never for suggested-area fetches.
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

// ── Structural check: monitoring vols are scoped to the TARGET area only ───
console.log('\nInclusion-rule gating (owner directive — no union across suggested areas):');
test('addMonitoringVolRows is only invoked when areaKey === normDispatch (the target/dispatch area)', () => {
  const m = SRC.match(/allAreaKeys\.forEach\(function \(areaKey\) \{[\s\S]*?\n  \}\);/);
  assert.ok(m, 'per-area fetch loop (allAreaKeys.forEach) found');
  const loopBody = m[0];
  assert.ok(
    /if\s*\(areaKey === normDispatch\)\s*\{\s*addMonitoringVolRows\(/.test(loopBody),
    'addMonitoringVolRows call is gated by "areaKey === normDispatch": ' + loopBody
  );
});
test('addVolRows (regular qualified volunteers) is still called for EVERY area, not gated (only monitoring pins are restricted)', () => {
  const m = SRC.match(/allAreaKeys\.forEach\(function \(areaKey\) \{[\s\S]*?\n  \}\);/);
  const loopBody = m[0];
  assert.ok(/addVolRows\(rows, areaKey\);/.test(loopBody),
    'addVolRows(rows, areaKey) still runs unconditionally per area (unaffected by the monitoring-vol scope fix)');
});

// ── Regression: renderCrossPostMap reads rvs/issue via the SHARED helper ───
// BUG (found while investigating a courier wrongly appearing on the map for a
// non-RVS capture): renderCrossPostMap used to read the animal inputs with
// `document.getElementById('rvs-yes')` / `document.getElementById('issue')`.
// Neither id exists in dispatcher.html -- rvs/issue are a RADIO GROUP
// (input[name="rvs"], input[name="issue"]), so the `#issue` lookup always
// returned null, `issue` was always '', and `hasBase` was always false. That
// silently skipped qualifyFn entirely for BOTH addVolRows and
// addMonitoringVolRows, letting a COURIER-only volunteer's pin through on a
// capture-only map. The fix reuses readAnimalBaseInfo() -- the SAME helper
// every other qualifyFn call site (renderTier1Volunteers, renderContextList,
// the Tier 1 monitoring-count summary) already relies on.
console.log('\nRegression -- renderCrossPostMap qualification wiring (courier-on-capture-map bug):');
test('renderCrossPostMap reads rvs/issue via the shared readAnimalBaseInfo() helper, not a dead-end getElementById("issue")/("rvs-yes") lookup', () => {
  const fnStart = SRC.indexOf('function renderCrossPostMap(');
  assert.ok(fnStart !== -1, 'renderCrossPostMap found');
  const braceStart = SRC.indexOf('{', fnStart);
  let depth = 0, i = braceStart;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const body = SRC.slice(braceStart + 1, i);
  assert.ok(/var base = readAnimalBaseInfo\(\);/.test(body),
    'renderCrossPostMap calls the shared readAnimalBaseInfo() to source rvs/issue/animalType');
  assert.strictEqual(/getElementById\(\s*['"]issue['"]\s*\)/.test(body), false,
    'no dead-end getElementById("issue") lookup remains (that id does not exist in dispatcher.html)');
  assert.strictEqual(/getElementById\(\s*['"]rvs-yes['"]\s*\)/.test(body), false,
    'no dead-end getElementById("rvs-yes") lookup remains (that id does not exist in dispatcher.html)');
});
test('dispatcher.html has NO element with id="issue" or id="rvs-yes" (confirms the OLD lookup was always a no-op)', () => {
  const htmlPath = path.resolve(__dirname, '..', 'docs', 'dispatcher.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  assert.strictEqual(/id=["']issue["']/.test(html), false, 'no id="issue" element exists');
  assert.strictEqual(/id=["']rvs-yes["']/.test(html), false, 'no id="rvs-yes" element exists');
  assert.ok(/name=["']issue["']/.test(html), 'issue IS a radio group (name="issue")');
  assert.ok(/name=["']rvs["']/.test(html), 'rvs IS a radio group (name="rvs")');
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

// volIdentityKey (shared between addVolRows and addMonitoringVolRows for the
// ONE-VOLUNTEER-ONE-PIN merge) -- extracted verbatim so a regression in the
// real identity-key logic is caught here too.
const VOL_IDENTITY_KEY_BODY = extractFunctionBody(SRC, /function volIdentityKey\(row\)\s*\{/);
const volIdentityKey = new Function('row', VOL_IDENTITY_KEY_BODY);

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
    'var placedVolByIdentity = opts.placedVolByIdentity;\n' +
    'return function addMonitoringVolRows(rows) {\n' +
    ADD_MONITORING_VOL_ROWS_BODY +
    '\n};';

  return new Function('L', 'escapeHtml', 't2VolPinClass', 't2DivIcon', 'volIdentityKey', 'opts',
    fnBody)(
    L, escapeHtml, t2VolPinClass, t2DivIconWrapped, volIdentityKey, opts);
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
  const placedVolByIdentity = (overrides && overrides.placedVolByIdentity) || {};
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
    placedVolByIdentity: placedVolByIdentity,
    fakeL: fakeL,
  };
  const addMonitoringVolRows = buildAddMonitoringVolRows(opts);
  return { addMonitoringVolRows, fakeL, bounds, cpVolMarkers, perCounty, placedVolByIdentity };
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
});

test('monitoring pin does NOT carry a role-color class — it gets its own solid distinct color, not role-inherited', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['RVS C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] },
  ]);
  const m = h.fakeL.createdMarkers[0];
  assert.strictEqual(m.opts.icon.opts.html.indexOf('t2-pin-vol-rvsct'), -1,
    'marker icon HTML must NOT carry a role class (t2-pin-vol-rvsct/ct/courier): ' + m.opts.icon.opts.html);
  assert.strictEqual(m.opts.icon.opts.html.indexOf('t2-pin-vol-ct'), -1,
    'marker icon HTML must NOT carry the C&T role class either: ' + m.opts.icon.opts.html);
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

console.log('\naddMonitoringVolRows — approx_lat/lon coordinate + centroid fallback signal (cross-post-pin-diagnosis fix):');

test('a monitoring row WITH approx_lat/approx_lon renders at that jittered coordinate, NOT the county centroid', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'],
      approx_lat: 41.55, approx_lon: -78.61 },
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 1);
  const [pinLat, pinLon] = h.fakeL.createdMarkers[0].latlng;
  assert.strictEqual(pinLat, 41.55, 'pin uses the jittered approx_lat, not the Elk centroid (41.4)');
  assert.strictEqual(pinLon, -78.61, 'pin uses the jittered approx_lon, not the Elk centroid (-78.7)');
  const m = h.fakeL.createdMarkers[0];
  assert.strictEqual(/approximate/i.test(m.popupHtml), false,
    'a real jittered coordinate must NOT carry the "approximate" fallback disclaimer');
  assert.strictEqual(m.opts.icon.opts.html.indexOf('t2-pin-approx'), -1,
    'a real jittered coordinate must NOT carry the approx-fallback CSS class');
});

test('a monitoring row with NO approx_lat/lon still falls back to the county centroid, but VISIBLY marked as approximate', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] }, // no approx_lat/lon
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 1, 'centroid fallback still renders a pin');
  const m = h.fakeL.createdMarkers[0];
  assert.ok(/approximate/i.test(m.popupHtml),
    'popup explicitly states the position is approximate: ' + m.popupHtml);
  assert.ok(/approximate/i.test(m.opts.title),
    'marker title explicitly states the position is approximate: ' + m.opts.title);
  assert.ok(m.opts.icon.opts.html.indexOf('t2-pin-approx') !== -1,
    'marker icon carries the t2-pin-approx CSS class (visibly distinct ring): ' + m.opts.icon.opts.html);
});

console.log('\naddMonitoringVolRows — ONE VOLUNTEER = ONE PIN merge with an existing ordinary pin:');

test('a monitoring row whose identity matches an already-placed ordinary pin MERGES into it (no second marker)', () => {
  // Simulate addVolRows having already placed Julie's ordinary (jittered)
  // pin before addMonitoringVolRows runs (mirrors the real call order in
  // renderCrossPostMap: addVolRows(rows, areaKey) then addMonitoringVolRows).
  const ordinaryLines = ['<strong>Julie</strong>', 'RVS C&T', 'County: Blair'];
  const ordinaryMarker = {
    popupHtml: null,
    bindPopup: function (html) { this.popupHtml = html; return this; },
  };
  ordinaryMarker.bindPopup(ordinaryLines.join('<br>'));
  const identityKey = 'Blair|RVS C&T|1|julie';
  const placedVolByIdentity = {};
  placedVolByIdentity[identityKey] = { marker: ordinaryMarker, lines: ordinaryLines };

  const h = makeHarness({ placedVolByIdentity: placedVolByIdentity });
  h.addMonitoringVolRows([
    { roles: ['RVS C&T'], win_area: '7', home_county: 'Blair', monitored_areas: ['1'], first_name: 'Julie',
      approx_lat: 40.81, approx_lon: -78.39 },
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 0,
    'NO second marker is created for a person who already has an ordinary pin');
  assert.ok(/Opted in to monitor this area from outside it/.test(ordinaryMarker.popupHtml),
    'the EXISTING ordinary pin popup is updated to carry the monitoring opt-in text: ' + ordinaryMarker.popupHtml);
  assert.ok(/Home area: 7/.test(ordinaryMarker.popupHtml),
    'the existing pin popup also carries the home-area monitoring detail: ' + ordinaryMarker.popupHtml);
  assert.ok(/Julie/.test(ordinaryMarker.popupHtml), 'original ordinary-pin content (name) is preserved');
});

test('a monitoring row whose identity does NOT match any placed ordinary pin still renders its own pin', () => {
  const h = makeHarness({ placedVolByIdentity: {} });
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'], first_name: 'Someone',
      approx_lat: 41.41, approx_lon: -78.69 },
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 1,
    'a monitoring-only volunteer (no ordinary pin on the map) still gets exactly one pin');
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

console.log('\naddMonitoringVolRows — first name in popup (Bug 3):');

test('popup and marker title show the volunteer first name when the Worker payload carries first_name', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'], first_name: 'Alice' },
  ]);
  const m = h.fakeL.createdMarkers[0];
  assert.ok(/Alice/.test(m.popupHtml), 'popup includes the first name: ' + m.popupHtml);
  assert.ok(/Alice/.test(m.opts.title), 'marker title includes the first name: ' + m.opts.title);
  assert.ok(/Monitoring volunteer/i.test(m.popupHtml), 'popup still labels the pin type');
});

test('popup falls back gracefully (no "undefined"/crash) when first_name is absent (flag OFF upstream)', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'] }, // no first_name key
  ]);
  const m = h.fakeL.createdMarkers[0];
  assert.ok(/Monitoring volunteer/i.test(m.popupHtml), 'popup still renders the base label');
  assert.strictEqual(/undefined/i.test(m.popupHtml), false, 'no literal "undefined" leaks into the popup');
});

test('only the FIRST token of a multi-word first_name is ever shown (defense in depth against a bad upstream value)', () => {
  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'], first_name: 'Alice Wonderland' },
  ]);
  const m = h.fakeL.createdMarkers[0];
  assert.ok(/Alice/.test(m.popupHtml), 'first token shown');
  assert.strictEqual(/Wonderland/.test(m.popupHtml), false, 'second token (surname-shaped) never shown');
});

console.log('\nLegend swatch vs. rendered marker color match (Bug 2 — owner reversal):');

test('legend .mlp-vol-monitor swatch has a SOLID amber background (matches the marker, no longer transparent/dashed-only)', () => {
  const htmlPath = path.resolve(__dirname, '..', 'docs', 'dispatcher.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const legendRuleMatch = html.match(/\.map-legend-panel \.mlp-vol-monitor\s*\{([^}]*)\}/);
  assert.ok(legendRuleMatch, 'legend .mlp-vol-monitor CSS rule found');
  const legendRule = legendRuleMatch[1];
  assert.ok(/background:\s*var\(--amber\)/.test(legendRule),
    'legend swatch background is the solid --amber color (matches the marker): ' + legendRule);
  assert.strictEqual(/border-style:\s*dashed/.test(legendRule), false,
    'legend swatch must NOT keep the dashed ring style (reverted per owner directive): ' + legendRule);
});

test('marker .t2-pin-monitor CSS rule declares its OWN solid amber background (no longer role-inherited, no dashed ring)', () => {
  const htmlPath = path.resolve(__dirname, '..', 'docs', 'dispatcher.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const markerRuleMatch = html.match(/\.t2-pin-monitor\s*\{([^}]*)\}/);
  assert.ok(markerRuleMatch, '.t2-pin-monitor CSS rule found');
  const markerRule = markerRuleMatch[1];
  assert.ok(/background:\s*var\(--amber\)/.test(markerRule),
    '.t2-pin-monitor declares its own solid var(--amber) background: ' + markerRule);
  assert.strictEqual(/border-style:\s*dashed/.test(markerRule), false,
    '.t2-pin-monitor must NOT keep the dashed ring (dropped per owner directive — solid color now carries the meaning): ' + markerRule);
});

test('marker .t2-pin-monitor and legend .mlp-vol-monitor resolve to the IDENTICAL color token (var(--amber))', () => {
  const htmlPath = path.resolve(__dirname, '..', 'docs', 'dispatcher.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const markerRule = html.match(/\.t2-pin-monitor\s*\{([^}]*)\}/)[1];
  const legendRule = html.match(/\.map-legend-panel \.mlp-vol-monitor\s*\{([^}]*)\}/)[1];
  const markerColor = markerRule.match(/background:\s*([^;]+);/)[1].trim();
  const legendColor = legendRule.match(/background:\s*([^;]+);/)[1].trim();
  assert.strictEqual(markerColor, legendColor,
    'marker background (' + markerColor + ') and legend swatch background (' + legendColor + ') must be the same token');
});

test('--amber is defined once and is distinct from every other pin/area color already in use', () => {
  const htmlPath = path.resolve(__dirname, '..', 'docs', 'dispatcher.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const amberMatch = html.match(/--amber:\s*(#[0-9a-fA-F]{3,6});/);
  assert.ok(amberMatch, '--amber custom property defined');
  const amber = amberMatch[1].toLowerCase();
  const otherColors = ['#c0392b', '#7b3fbf', '#1f7a33', '#5bbf5b', '#76b7b2', '#e41a1c', '#f781bf'];
  otherColors.forEach(function (c) {
    assert.notStrictEqual(amber, c.toLowerCase(), '--amber (' + amber + ') must not collide with existing color ' + c);
  });
});

// ── Regression: dedupe key collision when the Worker NORMALIZES roles ──────
// BUG: the dedupe key was homeCounty|homeArea|roles.join(','). The Worker's
// rolesOf() (worker/src/aggregate.js) synthesizes a single combined
// 'RVS C&T' token whenever a record declares BOTH separate 'C&T' and 'RVS',
// and drops non-qualifying roles like 'Dispatch' entirely. So two DIFFERENT
// volunteers who share a home county + home area and both hold C&T+RVS
// produce an IDENTICAL roles array from the Worker's perspective, even though
// their DECLARED roles differ (one may also be 'Dispatch', the other not).
// The old key silently dropped the second person's pin as a "duplicate".
console.log('\nRegression -- dedupe key does not collide when the WORKER normalizes two different people to the same roles array:');

const { rolesOf } = require(path.resolve(__dirname, '..', 'worker', 'src', 'aggregate.js'));

test('two DIFFERENT volunteers whose DECLARED roles differ (one also has Dispatch) but WORKER-NORMALIZE to the identical roles array both get pins', () => {
  // Mirrors the real Worker pipeline: handler.js emits roles: Array.from(rolesOf(rec)).
  const susanRaw = { roles: ['Dispatch', 'C&T', 'RVS'] };
  const ashleyRaw = { roles: ['C&T', 'RVS'] };
  const susanRoles = Array.from(rolesOf(susanRaw));
  const ashleyRoles = Array.from(rolesOf(ashleyRaw));
  assert.deepStrictEqual(susanRoles, ashleyRoles,
    'sanity check: the Worker really does normalize these two different declared-role sets to the same array');

  const h = makeHarness();
  h.addMonitoringVolRows([
    { roles: susanRoles, win_area: '10', home_county: 'Elk', monitored_areas: ['11', '05', '10'], first_name: 'Susan' },
    { roles: ashleyRoles, win_area: '10', home_county: 'Elk', monitored_areas: ['06', '10', '11'], first_name: 'Ashley' },
  ]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 2,
    'BOTH Susan and Ashley get a pin (not silently deduped as "the same monitor")');
  const popups = h.fakeL.createdMarkers.map(function (m) { return m.popupHtml; });
  assert.ok(popups.some(function (p) { return /Susan/.test(p); }), 'Susan pin present');
  assert.ok(popups.some(function (p) { return /Ashley/.test(p); }), 'Ashley pin present');
  const [lat1, lon1] = h.fakeL.createdMarkers[0].latlng;
  const [lat2, lon2] = h.fakeL.createdMarkers[1].latlng;
  assert.ok(lat1 !== lat2 || lon1 !== lon2, 'the two pins land on distinct, individually clickable points');
});

test('a TRUE duplicate row (identical county+area+roles+monitored_areas+first_name) from repeated per-area fetches is still deduplicated to ONE pin', () => {
  const h = makeHarness();
  const row = { roles: ['C&T'], win_area: '5', home_county: 'Elk', monitored_areas: ['1'], first_name: 'Pat' };
  h.addMonitoringVolRows([row]);
  h.addMonitoringVolRows([row]);
  assert.strictEqual(h.fakeL.createdMarkers.length, 1, 'true duplicate (same fetch replayed) still renders once');
});

// ── Ground-truth end-to-end scenario: Bedford / Area 11 / non-RVS capture ──
// Exact repro supplied by the owner from the Connecteam board (see commit
// message / issue for the source table). Exercises the REAL Worker role
// normalization (rolesOf) + the REAL addMonitoringVolRows body together, the
// same way production data flows, rather than hand-authored already-qualified
// fixture rows.
console.log('\nGround truth -- Bedford County / Area 11 / NON-RVS capture (owner Connecteam board):');

function buildBedfordWorkerRows() {
  const raw = [
    { first_name: 'Leigh', roles: ['Dispatch', 'C&T', 'RVS'], win_area: '5', home_county: 'Butler', monitored_areas: ['11', '10', '06', '02'] },
    { first_name: 'Sarah', roles: ['COURIER'], win_area: '6', home_county: 'Indiana', monitored_areas: ['05', '06', '11'] },
    { first_name: 'Susan', roles: ['Dispatch', 'C&T', 'RVS'], win_area: '10', home_county: 'Allegheny', monitored_areas: ['11', '05', '10'] },
    { first_name: 'Ashley', roles: ['C&T', 'RVS'], win_area: '10', home_county: 'Allegheny', monitored_areas: ['06', '10', '11'] },
  ];
  return raw.map(function (r) {
    return {
      first_name: r.first_name,
      roles: Array.from(rolesOf(r)),
      win_area: r.win_area,
      home_county: r.home_county,
      monitored_areas: r.monitored_areas,
    };
  });
}

const WildlifeDecision = require(path.resolve(__dirname, '..', 'docs', 'assets', 'decision.js'));

test('non-RVS capture: EXACTLY Leigh, Susan, Ashley render (3 pins); Sarah (courier) is excluded', () => {
  const centroids = {
    Butler: { lat: 40.86, lon: -79.9 },
    Allegheny: { lat: 40.44, lon: -79.99 },
    Indiana: { lat: 40.62, lon: -79.15 },
  };
  const fakeL = makeFakeL();
  const opts = {
    qualifyFn: WildlifeDecision.qualifiesForAnimal,
    hasBase: true,
    rvs: false,
    issue: 'capture',
    perCounty: {},
    state: { countyCentroids: centroids },
    cpMapRef: { layers: { vols: { __group: true } } },
    bounds: [],
    cpVolMarkers: [],
    placedVolByIdentity: {},
    fakeL: fakeL,
  };
  const fn = buildAddMonitoringVolRows(opts);

  fn(buildBedfordWorkerRows());
  assert.strictEqual(fakeL.createdMarkers.length, 3, 'exactly 3 pins render');
  const names = fakeL.createdMarkers.map(function (m) {
    const match = m.popupHtml.match(/Monitoring volunteer: (\w+)/);
    return match ? match[1] : null;
  });
  assert.deepStrictEqual(names.sort(), ['Ashley', 'Leigh', 'Susan'].sort(),
    'the 3 rendered pins are EXACTLY Leigh, Susan, Ashley: got ' + JSON.stringify(names));
  assert.ok(names.indexOf('Sarah') === -1, 'Sarah (courier) is excluded from a capture task');

  // All three must be individually clickable at DISTINCT coordinates.
  const coordKeys = fakeL.createdMarkers.map(function (m) {
    return m.latlng[0].toFixed(6) + ',' + m.latlng[1].toFixed(6);
  });
  assert.strictEqual(new Set(coordKeys).size, 3, 'all 3 pins occupy distinct, hit-testable coordinates');
});

test('RVS capture: same 3 (Leigh/Susan/Ashley) still qualify -- all hold RVS C&T -- Sarah (courier) still excluded (no overcorrection)', () => {
  const centroids = {
    Butler: { lat: 40.86, lon: -79.9 },
    Allegheny: { lat: 40.44, lon: -79.99 },
    Indiana: { lat: 40.62, lon: -79.15 },
  };
  const fakeL = makeFakeL();
  const opts = {
    qualifyFn: WildlifeDecision.qualifiesForAnimal,
    hasBase: true,
    rvs: true,
    issue: 'capture',
    perCounty: {},
    state: { countyCentroids: centroids },
    cpMapRef: { layers: { vols: { __group: true } } },
    bounds: [],
    cpVolMarkers: [],
    placedVolByIdentity: {},
    fakeL: fakeL,
  };
  const fn = buildAddMonitoringVolRows(opts);
  fn(buildBedfordWorkerRows());
  assert.strictEqual(fakeL.createdMarkers.length, 3, 'RVS run: still exactly 3 (Leigh/Susan/Ashley are RVS C&T-capable)');
  const names = fakeL.createdMarkers.map(function (m) {
    const match = m.popupHtml.match(/Monitoring volunteer: (\w+)/);
    return match ? match[1] : null;
  });
  assert.ok(names.indexOf('Sarah') === -1, 'courier Sarah still excluded on an RVS capture too');
});

test('transport issue: courier Sarah IS included (proves the filter is issue-aware, not a blanket courier ban)', () => {
  const centroids = {
    Butler: { lat: 40.86, lon: -79.9 },
    Allegheny: { lat: 40.44, lon: -79.99 },
    Indiana: { lat: 40.62, lon: -79.15 },
  };
  const fakeL = makeFakeL();
  const opts = {
    qualifyFn: WildlifeDecision.qualifiesForAnimal,
    hasBase: true,
    rvs: false,
    issue: 'transport',
    perCounty: {},
    state: { countyCentroids: centroids },
    cpMapRef: { layers: { vols: { __group: true } } },
    bounds: [],
    cpVolMarkers: [],
    placedVolByIdentity: {},
    fakeL: fakeL,
  };
  const fn = buildAddMonitoringVolRows(opts);
  fn(buildBedfordWorkerRows());
  assert.strictEqual(fakeL.createdMarkers.length, 4, 'transport run: all 4 qualify (couriers are transport-eligible)');
});

console.log('\n' + '-'.repeat(40));
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
console.log('ALL TESTS PASSED');

'use strict';
/**
 * Regression test for the Tier-2 Leaflet map's search-radius reference circle.
 *
 * OWNER REQUEST: "a circle showing the search extent on the Tier 2 map" --
 * requested repeatedly and never built until now.
 *
 * REQUIREMENTS LOCKED BY THIS TEST:
 *   1. The circle is centred on the animal location marker with radius =
 *      the ACTUAL live search radius used for the query (ctx.radius, via
 *      payload.radiusMi) -- never a hardcoded 20/25 constant.
 *   2. It uses L.circle with radius in METRES (miles * 1609.344), NOT
 *      L.circleMarker (a fixed pixel radius that would only be correct at
 *      one zoom level).
 *   3. It is non-interactive: no tooltip/popup/click handler.
 *   4. Its layer is created BELOW every marker layer (z-order), so it can
 *      never intercept a click intended for a pin.
 *   5. It is present on the Tier-2 map (ensureT2Map/paintT2Map), not the
 *      cross-post map.
 *
 * Rather than paraphrase the algorithm, this test EXTRACTS the actual
 * shipped `drawSearchRadiusCircle` function (and the layer-order wiring in
 * `ensureT2Map`) from docs/assets/dispatcher.js by marker text and executes
 * it verbatim via `new Function` against a mocked Leaflet (`L`), so a
 * regression in the real source is caught here.
 *
 * Run: node test/tier2_search_radius_circle.test.js   (exit 0 = pass, 1 = fail)
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

// ── Structural checks on the real source ───────────────────────────────────
console.log('Structural -- search-radius circle wiring in the real source:');

test('MI_TO_METERS constant exists and equals the real miles->metres conversion factor (1609.344)', () => {
  const m = SRC.match(/var MI_TO_METERS = ([\d.]+);/);
  assert.ok(m, 'MI_TO_METERS constant found');
  assert.strictEqual(Number(m[1]), 1609.344, 'MI_TO_METERS must be the real conversion factor, not an approximation');
});

test('drawSearchRadiusCircle uses L.circle, never L.circleMarker', () => {
  const body = extractFunctionBody(SRC, /function drawSearchRadiusCircle\(lat, lon, radiusMi\)\s*\{/);
  assert.ok(/L\.circle\(/.test(body), 'must call L.circle(...)');
  assert.strictEqual(/L\.circleMarker\(/.test(body), false,
    'must NOT use L.circleMarker -- fixed pixel radius is wrong at every zoom level but one');
});

test('drawSearchRadiusCircle computes radius in METRES via radiusMi * MI_TO_METERS (not a hardcoded number)', () => {
  const body = extractFunctionBody(SRC, /function drawSearchRadiusCircle\(lat, lon, radiusMi\)\s*\{/);
  assert.ok(/radius:\s*mi\s*\*\s*MI_TO_METERS/.test(body),
    'circle radius option must be computed from the live mi value times MI_TO_METERS: ' + body);
  assert.strictEqual(/radius:\s*(20|25)\d*[,\s]/.test(body), false,
    'must not hardcode 20 or 25 as the circle radius');
});

test('drawSearchRadiusCircle reads radiusMi as a live parameter, not a module-level constant fallback for the actual radius value', () => {
  const body = extractFunctionBody(SRC, /function drawSearchRadiusCircle\(lat, lon, radiusMi\)\s*\{/);
  assert.ok(/var mi = Number\(radiusMi\);/.test(body), 'radius comes from the radiusMi parameter');
  assert.strictEqual(/RADIUS_DEFAULT/.test(body), false,
    'drawSearchRadiusCircle must not fall back to RADIUS_DEFAULT -- a missing/invalid radius must draw nothing, not a fake 20mi circle');
});

test('the circle is non-interactive: no bindTooltip/bindPopup/on(\'click\' in drawSearchRadiusCircle, and interactive:false is set', () => {
  const body = extractFunctionBody(SRC, /function drawSearchRadiusCircle\(lat, lon, radiusMi\)\s*\{/);
  assert.ok(/interactive:\s*false/.test(body), 'circle options must set interactive: false');
  assert.strictEqual(/bindTooltip|bindPopup|\.on\(\s*['"]click['"]/.test(body), false,
    'no tooltip/popup/click handler may be attached to the search-radius circle');
});

test('styling is unobtrusive: no fill (fill: false), thin weight, and not opaque', () => {
  const body = extractFunctionBody(SRC, /function drawSearchRadiusCircle\(lat, lon, radiusMi\)\s*\{/);
  assert.ok(/fill:\s*false/.test(body), 'circle must have no fill (reference line only): ' + body);
  const weightMatch = body.match(/weight:\s*([\d.]+)/);
  assert.ok(weightMatch, 'weight option present');
  assert.ok(Number(weightMatch[1]) <= 2, 'border weight must be thin (<=2px), got ' + weightMatch[1]);
});

test('ensureT2Map creates the radius layer group BEFORE (under) every marker layer group in z-order', () => {
  const body = extractFunctionBody(SRC, /function ensureT2Map\(\)\s*\{/);
  const radiusIdx = body.indexOf('radius: L.layerGroup()');
  const animalIdx = body.indexOf('animal: L.layerGroup()');
  const rehabIdx = body.indexOf('rehab: L.layerGroup()');
  const volIdx = body.indexOf('volunteer: L.layerGroup()');
  assert.ok(radiusIdx !== -1, 't2map.layers.radius layer group created in ensureT2Map');
  assert.ok(radiusIdx < animalIdx, 'radius layer must be added to the map BEFORE the animal marker layer (so it paints/z-orders underneath)');
  assert.ok(radiusIdx < rehabIdx, 'radius layer must be added before the rehab marker layer');
  assert.ok(radiusIdx < volIdx, 'radius layer must be added before the volunteer marker layer');
});

test('paintT2Map calls drawSearchRadiusCircle with the animal coordinates and payload.radiusMi', () => {
  const body = extractFunctionBody(SRC, /function paintT2Map\(payload\)\s*\{/);
  assert.ok(/drawSearchRadiusCircle\(payload\.animal\.lat, payload\.animal\.lon, payload\.radiusMi\)/.test(body),
    'paintT2Map must invoke drawSearchRadiusCircle with the animal lat/lon + the live radiusMi: ' + body);
});

test('renderTier2Map sources payload.radiusMi from ctx.radius (the live search radius), not a constant', () => {
  const body = extractFunctionBody(SRC, /function renderTier2Map\(agg, origin, ctx\)\s*\{/);
  assert.ok(/radiusMi:\s*\(ctx && ctx\.radius\)\s*\?\s*Number\(ctx\.radius\)\s*:\s*null/.test(body),
    'payload.radiusMi must be derived from ctx.radius: ' + body);
});

test('the search-radius circle is deliberately excluded from fitBounds (paintT2Map does not push the circle bounds into `bounds`)', () => {
  const body = extractFunctionBody(SRC, /function paintT2Map\(payload\)\s*\{/);
  // The drawSearchRadiusCircle call site must not be followed by a
  // bounds.push/concat that references the circle's own bounds/getBounds.
  const callIdx = body.indexOf('drawSearchRadiusCircle(');
  assert.ok(callIdx !== -1, 'call site found');
  const nearby = body.slice(callIdx, callIdx + 400);
  assert.strictEqual(/circle.*getBounds|getBounds.*circle/i.test(nearby), false,
    'the circle must not be included in fitBounds (its extent is much larger than the qualified-results view)');
});

// ── Behavioral checks: run the extracted function against a mocked Leaflet ─
console.log('\nBehavioral -- drawSearchRadiusCircle executed against a mocked Leaflet:');

function makeFakeLeaflet() {
  const createdCircles = [];
  const layerGroups = {};
  function makeLayerGroup(name) {
    const layers = [];
    const grp = {
      __name: name,
      __layers: layers,
      addTo: function () { return grp; },
      clearLayers: function () { layers.length = 0; },
      hasLayer: function (l) { return layers.indexOf(l) !== -1; },
      removeLayer: function (l) { const i = layers.indexOf(l); if (i !== -1) layers.splice(i, 1); },
    };
    layerGroups[name] = grp;
    return grp;
  }
  const L = {
    layerGroup: function () {
      // ensureT2Map calls L.layerGroup() once per named layer, in object-
      // literal property order; capture calls in order and name them
      // afterward by call index via a counter closure.
      const grp = makeLayerGroup('layer' + Object.keys(layerGroups).length);
      return grp;
    },
    circle: function (latlng, opts) {
      const c = { latlng: latlng, opts: opts, addTo: function (grp) { c.__addedTo = grp; if (grp && grp.__layers) grp.__layers.push(c); return c; } };
      createdCircles.push(c);
      return c;
    },
  };
  return { L: L, createdCircles: createdCircles, layerGroups: layerGroups };
}

// Build a runnable drawSearchRadiusCircle bound to a fake t2map + L.
function buildDrawSearchRadiusCircle(fakeL, radiusLayerGroup) {
  const body = extractFunctionBody(SRC, /function drawSearchRadiusCircle\(lat, lon, radiusMi\)\s*\{/);
  const MI_TO_METERS_MATCH = SRC.match(/var MI_TO_METERS = ([\d.]+);/);
  const MI_TO_METERS = Number(MI_TO_METERS_MATCH[1]);
  const fnBody =
    'var L = opts.L;\n' +
    'var MI_TO_METERS = opts.MI_TO_METERS;\n' +
    'var t2map = opts.t2map;\n' +
    'return function drawSearchRadiusCircle(lat, lon, radiusMi) {\n' +
    body +
    '\n};';
  const t2map = { instance: {}, layers: { radius: radiusLayerGroup } };
  const runner = new Function('opts', fnBody);
  return runner({ L: fakeL.L, MI_TO_METERS: MI_TO_METERS, t2map: t2map });
}

test('circle radius in metres equals miles * 1609.344 exactly, for a live (non-default) radius value like 37', () => {
  const fake = makeFakeLeaflet();
  const radiusLayer = { __layers: [], addTo: function () { return this; }, clearLayers: function () { this.__layers.length = 0; } };
  const fn = buildDrawSearchRadiusCircle(fake, radiusLayer);
  fn(41.0, -78.5, 37);
  assert.strictEqual(fake.createdCircles.length, 1, 'exactly one circle created');
  const c = fake.createdCircles[0];
  assert.strictEqual(c.opts.radius, 37 * 1609.344, 'radius in metres must be EXACTLY miles * 1609.344');
  assert.deepStrictEqual(c.latlng, [41.0, -78.5], 'circle centred on the animal marker coordinates');
});

test('a different live radius value (60mi, matching a real widened Tier-2 query) produces a proportionally different metre radius -- not a fixed constant', () => {
  const fake = makeFakeLeaflet();
  const radiusLayer = { __layers: [], addTo: function () { return this; }, clearLayers: function () { this.__layers.length = 0; } };
  const fn = buildDrawSearchRadiusCircle(fake, radiusLayer);
  fn(40.9, -78.9, 60);
  const c = fake.createdCircles[0];
  assert.strictEqual(c.opts.radius, 60 * 1609.344);
  assert.notStrictEqual(c.opts.radius, 20 * 1609.344, 'must not silently use the RADIUS_DEFAULT (20mi) when a real 60mi radius is live');
});

test('circle options carry interactive:false and no fill (matches the non-interactive, unobtrusive requirement end-to-end)', () => {
  const fake = makeFakeLeaflet();
  const radiusLayer = { __layers: [], addTo: function () { return this; }, clearLayers: function () { this.__layers.length = 0; } };
  const fn = buildDrawSearchRadiusCircle(fake, radiusLayer);
  fn(41.0, -78.5, 20);
  const c = fake.createdCircles[0];
  assert.strictEqual(c.opts.interactive, false);
  assert.strictEqual(c.opts.fill, false);
});

test('invalid/missing radius (0, negative, NaN) draws no circle', () => {
  const fake = makeFakeLeaflet();
  const radiusLayer = { __layers: [], addTo: function () { return this; }, clearLayers: function () { this.__layers.length = 0; } };
  const fn = buildDrawSearchRadiusCircle(fake, radiusLayer);
  fn(41.0, -78.5, 0);
  fn(41.0, -78.5, -5);
  fn(41.0, -78.5, NaN);
  assert.strictEqual(fake.createdCircles.length, 0, 'no circle for radius <= 0 or NaN');
});

test('missing/non-finite animal coordinates draw no circle (no crash)', () => {
  const fake = makeFakeLeaflet();
  const radiusLayer = { __layers: [], addTo: function () { return this; }, clearLayers: function () { this.__layers.length = 0; } };
  const fn = buildDrawSearchRadiusCircle(fake, radiusLayer);
  fn(NaN, -78.5, 20);
  fn(41.0, undefined, 20);
  assert.strictEqual(fake.createdCircles.length, 0);
});

test('re-painting (re-invoking) clears the previous circle before drawing the new one (no stale duplicate circles)', () => {
  const fake = makeFakeLeaflet();
  const radiusLayer = { __layers: [], addTo: function () { return this; }, clearLayers: function () { this.__layers.length = 0; } };
  const fn = buildDrawSearchRadiusCircle(fake, radiusLayer);
  fn(41.0, -78.5, 20);
  fn(41.0, -78.5, 40);
  assert.strictEqual(radiusLayer.__layers.length, 1, 'only the latest circle remains in the radius layer group');
});

console.log('\n' + '-'.repeat(40));
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
console.log('ALL TESTS PASSED');

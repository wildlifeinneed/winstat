'use strict';
/**
 * Regression test for the selectable base-layer control (Standard / Terrain /
 * Roads-Labels) on the Tier-2 and cross-post Leaflet maps.
 *
 * OWNER REQUEST: "can the maps have toggles for various layers like terrain,
 * driving, etc. sometimes it is hard to find towns and roads."
 *
 * REQUIREMENTS LOCKED BY THIS TEST:
 *   1. Base layers are registered via L.control.layers (createBaseLayers +
 *      setupBaseLayers in dispatcher.js).
 *   2. The DEFAULT active layer is the pre-existing OpenStreetMap tile set
 *      ("Standard") -- unchanged behavior for anyone who never touches the
 *      control.
 *   3. All three tile providers are free/no-key/no-signup (hard constraint
 *      for this static GitHub Pages site with no secret storage) and each
 *      carries a required attribution string.
 *   4. The user's chosen layer is remembered (localStorage) and re-applied
 *      after a map rebuild (t2map/cpMap are destroyed and recreated between
 *      renders), so it does not reset every lookup.
 *   5. setupBaseLayers is wired into BOTH map creation sites (Tier-2's
 *      ensureT2Map and the cross-post map's renderCrossPostMap).
 *
 * Structural checks parse the real dispatcher.js source; behavioral checks
 * execute the actual extracted functions against a mocked Leaflet + a fake
 * localStorage, per the repo's real-source-execution test convention.
 *
 * Run: node test/tier2_base_layers.test.js   (exit 0 = pass, 1 = fail)
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
console.log('Structural -- base layer control wiring in the real source:');

test('createBaseLayers registers exactly 3 base layers via L.tileLayer', () => {
  const body = extractFunctionBody(SRC, /function createBaseLayers\(\)\s*\{/);
  const matches = body.match(/L\.tileLayer\(/g) || [];
  assert.strictEqual(matches.length, 3, 'expected exactly 3 L.tileLayer(...) calls, got ' + matches.length);
});

test('the Standard (OpenStreetMap) layer is created FIRST -- it is the default active layer', () => {
  const body = extractFunctionBody(SRC, /function createBaseLayers\(\)\s*\{/);
  const osmIdx = body.indexOf('tile.openstreetmap.org');
  const topoIdx = body.indexOf('opentopomap.org');
  const hotIdx = body.indexOf('tile.openstreetmap.fr/hot');
  assert.ok(osmIdx !== -1 && topoIdx !== -1 && hotIdx !== -1, 'all three tile URLs present');
  assert.ok(osmIdx < topoIdx && osmIdx < hotIdx, 'standard OSM tiles must be registered first (Object.keys(layers)[0] = default)');
});

test('every tile layer carries a required, non-empty attribution string (licensing obligation)', () => {
  const body = extractFunctionBody(SRC, /function createBaseLayers\(\)\s*\{/);
  const attrs = body.match(/attribution:\s*'[^']+'/g) || [];
  assert.strictEqual(attrs.length, 3, 'expected 3 attribution strings, got ' + attrs.length);
  attrs.forEach((a) => {
    assert.ok(a.length > 'attribution: \'\''.length, 'attribution must not be empty: ' + a);
  });
});

test('no tile URL contains an API key / token / signup-only query parameter (hard no-key constraint)', () => {
  const body = extractFunctionBody(SRC, /function createBaseLayers\(\)\s*\{/);
  const urls = body.match(/'https:\/\/[^']+'/g) || [];
  assert.ok(urls.length >= 3, 'at least 3 tile URLs found');
  urls.forEach((u) => {
    assert.strictEqual(/[?&](api_?key|token|access_?token|key)=/i.test(u), false,
      'tile URL must not require an API key/token: ' + u);
  });
});

test('setupBaseLayers activates the FIRST layer (Standard/OSM) by default when nothing is remembered', () => {
  const body = extractFunctionBody(SRC, /function setupBaseLayers\(map\)\s*\{/);
  assert.ok(/var activeName = \(remembered && layers\[remembered\]\) \? remembered : names\[0\];/.test(body),
    'default must fall back to names[0] (the first-registered, Standard/OSM layer) when nothing is remembered: ' + body);
});

test('setupBaseLayers persists the user selection via a baselayerchange listener', () => {
  const body = extractFunctionBody(SRC, /function setupBaseLayers\(map\)\s*\{/);
  assert.ok(/map\.on\(\s*['"]baselayerchange['"]/.test(body), 'must listen for baselayerchange to persist the choice');
  assert.ok(/rememberBaseLayerName\(e\.name\)/.test(body), 'must call rememberBaseLayerName with the newly selected layer name');
});

test('setupBaseLayers registers the control via L.control.layers (a real Leaflet layer-control primitive)', () => {
  const body = extractFunctionBody(SRC, /function setupBaseLayers\(map\)\s*\{/);
  assert.ok(/L\.control\.layers\(/.test(body), 'must call L.control.layers(...)');
});

test('the layer control is positioned to avoid the fullscreen button (topleft, not the default topright)', () => {
  const body = extractFunctionBody(SRC, /function setupBaseLayers\(map\)\s*\{/);
  assert.ok(/position:\s*'topleft'/.test(body),
    'layer control must be moved off Leaflet\'s default topright corner, which the .map-fs-btn fullscreen button occupies: ' + body);
});

test('getRememberedBaseLayerName / rememberBaseLayerName use localStorage under a dedicated key, and fail silently if unavailable', () => {
  const getBody = extractFunctionBody(SRC, /function getRememberedBaseLayerName\(\)\s*\{/);
  const setBody = extractFunctionBody(SRC, /function rememberBaseLayerName\(name\)\s*\{/);
  assert.ok(/window\.localStorage/.test(getBody) && /try\s*\{/.test(getBody), 'read must guard localStorage access in try/catch');
  assert.ok(/window\.localStorage/.test(setBody) && /try\s*\{/.test(setBody), 'write must guard localStorage access in try/catch');
});

test('ensureT2Map (Tier-2 map) calls setupBaseLayers instead of adding a bare, non-selectable tile layer', () => {
  const body = extractFunctionBody(SRC, /function ensureT2Map\(\)\s*\{/);
  assert.ok(/setupBaseLayers\(map\)/.test(body), 'ensureT2Map must call setupBaseLayers(map)');
  assert.strictEqual(/L\.tileLayer\(/.test(body), false,
    'ensureT2Map must not directly create a tile layer anymore -- that now lives in createBaseLayers, called via setupBaseLayers');
});

test('the cross-post map creation site also calls setupBaseLayers (covers both maps per the task requirement)', () => {
  // The cross-post map is built inline (no separate ensureCpMap function); search
  // for the setView call that initializes it and confirm setupBaseLayers follows
  // in the same region rather than a bare L.tileLayer call.
  const cpMapCreationIdx = SRC.indexOf("attributionControl: true })\n      .setView([lat, lon], 9);");
  assert.ok(cpMapCreationIdx !== -1, 'cross-post map creation site (L.map(...).setView([lat, lon], 9)) found');
  const nearby = SRC.slice(cpMapCreationIdx, cpMapCreationIdx + 200);
  assert.ok(/setupBaseLayers\(map\)/.test(nearby), 'cross-post map creation must call setupBaseLayers(map): ' + nearby);
});

test('messages.js provides display names for the base layers (mapBaseLayers), not hardcoded strings in dispatcher.js', () => {
  const body = extractFunctionBody(SRC, /function createBaseLayers\(\)\s*\{/);
  assert.ok(/MSG\.mapBaseLayers/.test(body), 'createBaseLayers must read names from MSG.mapBaseLayers');
});

// ── Behavioral checks: run the extracted functions against a mocked Leaflet ─
console.log('\nBehavioral -- setupBaseLayers executed against a mocked Leaflet + fake localStorage:');

function makeFakeLeaflet() {
  const created = { tileLayers: [], controls: [] };
  function makeTileLayer(url, opts) {
    const layer = { __url: url, __opts: opts, __addedToMaps: [] };
    layer.addTo = function (map) { layer.__addedToMaps.push(map); return layer; };
    created.tileLayers.push(layer);
    return layer;
  }
  const L = {
    tileLayer: function (url, opts) { return makeTileLayer(url, opts); },
    control: {
      layers: function (baseLayers, overlays, opts) {
        const ctrl = { __baseLayers: baseLayers, __opts: opts, __addedToMaps: [] };
        ctrl.addTo = function (map) { ctrl.__addedToMaps.push(map); return ctrl; };
        created.controls.push(ctrl);
        return ctrl;
      }
    }
  };
  return { L: L, created: created };
}

function makeFakeMap() {
  const listeners = {};
  return {
    on: function (evt, fn) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(fn);
      return this;
    },
    __fire: function (evt, payload) {
      (listeners[evt] || []).forEach((fn) => fn(payload));
    }
  };
}

function makeFakeLocalStorage(initial) {
  const store = Object.assign({}, initial || {});
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    __store: store
  };
}

// Build a runnable createBaseLayers/setupBaseLayers/getRememberedBaseLayerName/
// rememberBaseLayerName bound to a fake L + fake window.localStorage + fake MSG.
function buildBaseLayerFns(fakeL, fakeLocalStorage) {
  const createBody = extractFunctionBody(SRC, /function createBaseLayers\(\)\s*\{/);
  const setupBody = extractFunctionBody(SRC, /function setupBaseLayers\(map\)\s*\{/);
  const getRememberedBody = extractFunctionBody(SRC, /function getRememberedBaseLayerName\(\)\s*\{/);
  const rememberBody = extractFunctionBody(SRC, /function rememberBaseLayerName\(name\)\s*\{/);
  const keyMatch = SRC.match(/var BASE_LAYER_STORAGE_KEY = '([^']+)';/);
  assert.ok(keyMatch, 'BASE_LAYER_STORAGE_KEY constant found');

  const fnBody =
    'var L = opts.L;\n' +
    'var window = opts.window;\n' +
    'var MSG = opts.MSG;\n' +
    'var BASE_LAYER_STORAGE_KEY = ' + JSON.stringify(keyMatch[1]) + ';\n' +
    'function createBaseLayers() {\n' + createBody + '\n}\n' +
    'function getRememberedBaseLayerName() {\n' + getRememberedBody + '\n}\n' +
    'function rememberBaseLayerName(name) {\n' + rememberBody + '\n}\n' +
    'function setupBaseLayers(map) {\n' + setupBody + '\n}\n' +
    'return { createBaseLayers: createBaseLayers, setupBaseLayers: setupBaseLayers, getRememberedBaseLayerName: getRememberedBaseLayerName, rememberBaseLayerName: rememberBaseLayerName };';

  const runner = new Function('opts', fnBody);
  return runner({
    L: fakeL.L,
    window: { localStorage: fakeLocalStorage },
    MSG: { mapBaseLayers: { standard: 'Standard', terrain: 'Terrain', roads: 'Roads / Labels' } }
  });
}

test('with nothing remembered, setupBaseLayers activates Standard (OSM) by default', () => {
  const fake = makeFakeLeaflet();
  const ls = makeFakeLocalStorage();
  const fns = buildBaseLayerFns(fake, ls);
  const map = makeFakeMap();
  fns.setupBaseLayers(map);
  // The Standard/OSM tile layer (first created, url contains tile.openstreetmap.org)
  // must be the one that got .addTo(map) called on it.
  const osmLayer = fake.created.tileLayers.find((l) => /tile\.openstreetmap\.org/.test(l.__url));
  assert.ok(osmLayer, 'OSM layer created');
  assert.deepStrictEqual(osmLayer.__addedToMaps, [map], 'OSM (Standard) layer must be added to the map by default');
  const topoLayer = fake.created.tileLayers.find((l) => /opentopomap/.test(l.__url));
  assert.deepStrictEqual(topoLayer.__addedToMaps, [], 'Terrain layer must NOT be auto-added when Standard is default');
});

test('with "Terrain" remembered in localStorage, setupBaseLayers activates Terrain instead of Standard', () => {
  const fake = makeFakeLeaflet();
  const ls = makeFakeLocalStorage({ dispatcherMapBaseLayer: 'Terrain' });
  const fns = buildBaseLayerFns(fake, ls);
  const map = makeFakeMap();
  fns.setupBaseLayers(map);
  const topoLayer = fake.created.tileLayers.find((l) => /opentopomap/.test(l.__url));
  const osmLayer = fake.created.tileLayers.find((l) => /tile\.openstreetmap\.org/.test(l.__url));
  assert.deepStrictEqual(topoLayer.__addedToMaps, [map], 'remembered Terrain choice must be activated');
  assert.deepStrictEqual(osmLayer.__addedToMaps, [], 'Standard must not be auto-added when Terrain is remembered');
});

test('selecting a layer fires baselayerchange -> the choice is written to localStorage', () => {
  const fake = makeFakeLeaflet();
  const ls = makeFakeLocalStorage();
  const fns = buildBaseLayerFns(fake, ls);
  const map = makeFakeMap();
  fns.setupBaseLayers(map);
  map.__fire('baselayerchange', { name: 'Roads / Labels' });
  assert.strictEqual(ls.__store.dispatcherMapBaseLayer, 'Roads / Labels');
});

test('a remembered choice persists across a simulated map rebuild (new fake map instance re-applies it)', () => {
  const fake = makeFakeLeaflet();
  const ls = makeFakeLocalStorage();
  const fns = buildBaseLayerFns(fake, ls);

  // First "lookup": user picks Roads / Labels.
  const map1 = makeFakeMap();
  fns.setupBaseLayers(map1);
  map1.__fire('baselayerchange', { name: 'Roads / Labels' });

  // Map is destroyed and rebuilt for the next lookup (matches
  // ensureT2Map/renderCrossPostMap tearing down and recreating the map).
  const fake2 = makeFakeLeaflet();
  const fns2 = buildBaseLayerFns(fake2, ls); // same `ls` -- localStorage persists across rebuilds
  const map2 = makeFakeMap();
  fns2.setupBaseLayers(map2);

  const hotLayer2 = fake2.created.tileLayers.find((l) => /tile\.openstreetmap\.fr\/hot/.test(l.__url));
  assert.deepStrictEqual(hotLayer2.__addedToMaps, [map2],
    'the remembered Roads/Labels choice must be re-applied on the rebuilt map, not reset to Standard');
});

test('setupBaseLayers tolerates a missing/broken localStorage (private browsing) without throwing, falling back to default', () => {
  const fake = makeFakeLeaflet();
  const brokenLocalStorage = {
    getItem: function () { throw new Error('SecurityError: storage disabled'); },
    setItem: function () { throw new Error('SecurityError: storage disabled'); }
  };
  const fns = buildBaseLayerFns(fake, brokenLocalStorage);
  const map = makeFakeMap();
  assert.doesNotThrow(() => fns.setupBaseLayers(map));
  const osmLayer = fake.created.tileLayers.find((l) => /tile\.openstreetmap\.org/.test(l.__url));
  assert.deepStrictEqual(osmLayer.__addedToMaps, [map], 'falls back to Standard/OSM default when localStorage throws');
});

console.log('\n' + '-'.repeat(40));
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
console.log('ALL TESTS PASSED');

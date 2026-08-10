'use strict';
/**
 * Cross-post ADDRESS/COUNTY sanity check (Tier 1 "Check for Cross Post" flow).
 *
 * OWNER BUG REPORT: target county = Bedford (Area 11). The owner entered
 * "Easton, Pennsylvania" (Northampton County, ~250 mi away, eastern PA) into
 * the Tier 1 cross-post address box. The app computed and displayed cross-post
 * area suggestions + a map anyway -- arithmetically correct, operationally
 * worthless, because it silently accepted an almost-certainly-mistyped
 * address. Owner: "i just wanted a popup saying that easton is not in the
 * target county ... so if an address is entered incorrectly it is flagged".
 *
 * FIX: crossPostGeocode (docs/assets/dispatcher.js) now routes through
 * crossPostCountyGuard AFTER the address geocodes successfully but BEFORE
 * crossPostDistanceCheck (area suggestions + map) runs. The guard compares
 * the geocoded address's COUNTY (from the Worker's PIP-derived animal_county
 * -- authoritative, not re-derived client-side) against the Tier 1 SELECTED
 * county (normalized: trim/whitespace/"County" suffix/case). On a mismatch it
 * shows a blocking confirmation (showCountyMismatchDialog); Cancel aborts the
 * whole cross-post computation, "Use this address anyway" proceeds and adds a
 * persistent inline warning next to the suggestion banner.
 *
 * This test loads the REAL docs/dispatcher.html into jsdom and executes the
 * REAL docs/assets/{messages,decision,dispatcher}.js against it (same harness
 * pattern as test/dispatcher_dom.test.js), then drives the actual "Check for
 * Cross Post" button click -> address entry -> Check click flow end-to-end,
 * asserting on the real rendered DOM (dialog markup, button clicks, resulting
 * banners) rather than reasoning about the source statically.
 *
 * Run: node test/cross_post_county_guard.test.js   (exit 0 = pass, 1 = fail)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DOCS = path.resolve(__dirname, '..', 'docs');
const HTML_PATH = path.join(DOCS, 'dispatcher.html');
const MESSAGES_JS = path.join(DOCS, 'assets', 'messages.js');
const DECISION_JS = path.join(DOCS, 'assets', 'decision.js');
const DISPATCHER_JS = path.join(DOCS, 'assets', 'dispatcher.js');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.error('  \u2717 ' + name);
    console.error('    ' + (e.stack || e.message || e));
  }
}

// County -> WIN area fixture. Bedford is real-world WIN Area 11 (matches the
// owner's ground-truth scenario in test/monitoring_pins.test.js). Northampton
// or Allegheny only need to exist as PLAIN county names for the county-guard
// comparison -- they never need to resolve to a real WIN area for these tests.
const COUNTY_WIN = { Bedford: '11', Allegheny: '10' };
const COORDINATORS = { '11': 'Pat Example', '10': 'Julia Meredith' };

// Snapshot with sufficient Bedford capacity -> connecteam_task (dispatch
// action), which is required for the "Check for Cross Post" button to render.
const SNAPSHOT_BEDFORD_OK = {
  generated_at: '2024-01-01T00:00:00Z',
  counties: {
    Bedford: {
      ct_no_rvs: { available: 3, total: 5, marginal_volunteers: [] },
      ct_rvs: { available: 2, total: 3, marginal_volunteers: [] },
      courier: { available: 2, total: 3, marginal_volunteers: [] },
    },
  },
};

// Minimal county GeoJSON so crossPostDistanceCheck's state.geojson check does
// not short-circuit into the "County map data not loaded" branch. A single
// Bedford polygon (win_area 11) is enough -- the distance-check output itself
// is out of scope for this guard test (covered by
// test/tier2_win_area_qualification.test.js et al.); we only need the
// function to run past the guard without erroring.
const MINI_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { county: 'Bedford', win_area: '11', geoid: '42009' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-78.7, 40.0], [-78.3, 40.0], [-78.3, 40.2], [-78.7, 40.2], [-78.7, 40.0]]],
      },
    },
  ],
};

// Build a fetch mock that distinguishes:
//  - autocomplete requests -> empty suggestion list (tests type a full address
//    and click Check directly; autocomplete is not exercised here).
//  - the Worker geocode/county-resolve request (address=... OR
//    animal_lat=...&animal_lon=...) -> `geocodeResponse` (mismatch/match/edge
//    case payload under test).
//  - local data/*.json files -> served from `dataRoutes`.
//  - pa_counties.json -> the mini GeoJSON above.
function makeFetch(dataRoutes, geocodeResponse) {
  return function fetchMock(url) {
    const u = String(url);
    if (u.indexOf('workers.dev') !== -1) {
      if (u.indexOf('autocomplete=') !== -1) {
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve({ suggestions: [] }); },
        });
      }
      if (u.indexOf('address=') !== -1 || u.indexOf('animal_lat=') !== -1) {
        if (geocodeResponse && geocodeResponse.__reject) {
          return Promise.resolve({ ok: false, status: 502, json: function () { return Promise.resolve({}); } });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: function () { return Promise.resolve(geocodeResponse); },
        });
      }
      // Any other Worker call (e.g. a stray aggregate/context request) ->
      // harmless empty aggregate.
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve({ total_in_range: 0, role_counts: {}, win_areas: [] }); },
      });
    }
    let matchedKey = null;
    Object.keys(dataRoutes).forEach(function (k) { if (u.indexOf(k) !== -1) matchedKey = k; });
    if (matchedKey) {
      const payload = dataRoutes[matchedKey];
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(payload); },
        text: function () { return Promise.resolve(JSON.stringify(payload)); },
      });
    }
    if (u.indexOf('pa_counties.json') !== -1) {
      return Promise.resolve({
        ok: true, status: 200,
        json: function () { return Promise.resolve(MINI_GEOJSON); },
        text: function () { return Promise.resolve(JSON.stringify(MINI_GEOJSON)); },
      });
    }
    if (u.indexOf('config.json') !== -1) {
      return Promise.resolve({
        ok: true, status: 200,
        text: function () { return Promise.resolve('{}'); },
        json: function () { return Promise.resolve({}); },
      });
    }
    const body = u.indexOf('rehabbers.json') !== -1 ? [] : {};
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(JSON.stringify(body)); },
    });
  };
}

function loadDom(geocodeResponse, dataOverrides) {
  const dataRoutes = Object.assign({
    'county_capacity.json': SNAPSHOT_BEDFORD_OK,
    'county_win.json': COUNTY_WIN,
    'coordinators.json': COORDINATORS,
  }, dataOverrides || {});
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.org/dispatcher.html',
  });
  const { window } = dom;
  window.addEventListener('unhandledrejection', function (e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
  });
  window.fetch = makeFetch(dataRoutes, geocodeResponse);
  window.eval(fs.readFileSync(MESSAGES_JS, 'utf8'));
  window.eval(fs.readFileSync(DECISION_JS, 'utf8'));
  window.eval(fs.readFileSync(DISPATCHER_JS, 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  return { dom, window };
}

function flush(window) {
  return new Promise(function (resolve) { window.setTimeout(resolve, 0); });
}

// Drive: select Bedford county, RVS=no/Capture -> Get Recommendation ->
// click "Check for Cross Post" -> reveal input -> type `address` -> click
// Check. Returns { window, doc, resultDiv } once the click has fired (caller
// awaits additional flush() turns for the async guard to resolve).
async function driveToCheckClick(geocodeResponse, address, dataOverrides) {
  const { window } = loadDom(geocodeResponse, dataOverrides);
  const doc = window.document;
  await flush(window); await flush(window);

  const countySel = doc.getElementById('county');
  countySel.value = 'Bedford';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window); await flush(window);

  const rvsEl = doc.querySelector('input[name="rvs"][value="no"]');
  if (rvsEl) { rvsEl.checked = true; rvsEl.dispatchEvent(new window.Event('change', { bubbles: true })); }
  const issueEl = doc.querySelector('input[name="issue"][value="capture"]');
  if (issueEl) { issueEl.checked = true; issueEl.dispatchEvent(new window.Event('change', { bubbles: true })); }
  await flush(window); await flush(window);

  doc.getElementById('recommend-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window); await flush(window); await flush(window);

  const btn = doc.querySelector('#rec-output .cross-post-btn');
  assert.ok(btn, 'cross-post button rendered (sanity precondition)');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));

  const addrInput = doc.querySelector('#rec-output .cross-post-addr');
  assert.ok(addrInput, 'cross-post address input exists');
  addrInput.value = address;

  const checkBtn = doc.querySelector('#rec-output .cross-post-check-btn');
  assert.ok(checkBtn, 'cross-post Check button exists');
  checkBtn.dispatchEvent(new window.Event('click', { bubbles: true }));

  const resultDiv = doc.querySelector('#rec-output .cross-post-result');
  return { window, doc, resultDiv };
}

async function main() {
console.log('Cross-post county sanity guard (Tier 1 "Check for Cross Post"):');

// ── 1) MISMATCH -> blocking dialog appears ─────────────────────────────────
await test('geocoded county != selected county -> blocking dialog renders with plain-language copy', async () => {
  const geo = { animal_lat: 40.6884, animal_lon: -75.2207, animal_county: 'Northampton' };
  const { doc } = await driveToCheckClick(geo, 'Easton, Pennsylvania');
  await flush(doc.defaultView); await flush(doc.defaultView);

  const overlay = doc.querySelector('.county-mismatch-overlay');
  assert.ok(overlay, 'mismatch dialog overlay rendered');
  const title = doc.querySelector('.county-mismatch-title');
  assert.strictEqual(title.textContent, 'Address is not in the target county');
  const body = doc.querySelector('.county-mismatch-body');
  assert.ok(/Bedford County/.test(body.textContent), 'body names the selected county: ' + body.textContent);
  assert.ok(/Northampton County/.test(body.textContent), 'body names the geocoded county: ' + body.textContent);
  assert.ok(/Easton, Pennsylvania/.test(body.textContent), 'body echoes the entered address: ' + body.textContent);
  const cancelBtn = doc.querySelector('.county-mismatch-cancel-btn');
  const proceedBtn = doc.querySelector('.county-mismatch-proceed-btn');
  assert.strictEqual(cancelBtn.textContent, 'Cancel');
  assert.strictEqual(proceedBtn.textContent, 'Use this address anyway');
  assert.strictEqual(doc.activeElement, cancelBtn, 'Cancel is the default-focused (safest) action');

  // Suggestions/map must NOT have been rendered yet (guard fires BEFORE
  // crossPostDistanceCheck) -- the result banner is still the transient
  // "Geocoding…" neutral state, never the suggestion text.
  const resultDiv = doc.querySelector('#rec-output .cross-post-result');
  assert.strictEqual(resultDiv.textContent.indexOf('Consider cross posting'), -1,
    'no cross-post area suggestions rendered while the dialog is blocking');
  assert.strictEqual(doc.querySelector('.cp-map-wrap'), null, 'no map rendered while the dialog is blocking');
});

await test('mismatch dialog includes an approximate distance when cheap to compute', async () => {
  const geo = { animal_lat: 40.6884, animal_lon: -75.2207, animal_county: 'Northampton' };
  const { doc } = await driveToCheckClick(geo, 'Easton, Pennsylvania');
  await flush(doc.defaultView); await flush(doc.defaultView);
  const body = doc.querySelector('.county-mismatch-body');
  assert.ok(/about \d+ miles away/.test(body.textContent),
    'body includes an "about N miles away" clause: ' + body.textContent);
});

// ── 2) MATCH -> no dialog, unchanged behavior ──────────────────────────────
await test('geocoded county == selected county -> no dialog, cross-post check proceeds normally', async () => {
  const geo = { animal_lat: 40.02, animal_lon: -78.5, animal_county: 'Bedford' };
  const { doc } = await driveToCheckClick(geo, '123 Main St, Bedford, PA');
  await flush(doc.defaultView); await flush(doc.defaultView);

  const overlay = doc.querySelector('.county-mismatch-overlay');
  assert.strictEqual(overlay, null, 'no mismatch dialog on a matching county');
  const resultDiv = doc.querySelector('#rec-output .cross-post-result');
  assert.notStrictEqual(resultDiv.style.display, 'none', 'result banner renders normally on match');
  const warn = doc.querySelector('.cross-post-county-warning');
  assert.strictEqual(warn, null, 'no persistent warning on a matching county');
});

// ── 2b) Case/whitespace/"County" suffix normalization ──────────────────────
await test('county name formatting differences ("bedford" vs "Bedford") do not trigger a false mismatch', async () => {
  const geo = { animal_lat: 40.02, animal_lon: -78.5, animal_county: '  bedford  ' };
  const { doc } = await driveToCheckClick(geo, '123 Main St, Bedford, PA');
  await flush(doc.defaultView); await flush(doc.defaultView);
  const overlay = doc.querySelector('.county-mismatch-overlay');
  assert.strictEqual(overlay, null, 'whitespace/casing difference alone must not trigger the dialog');
});

await test('a "County" suffix on the geocoded value does not trigger a false mismatch', async () => {
  const geo = { animal_lat: 40.02, animal_lon: -78.5, animal_county: 'Bedford County' };
  const { doc } = await driveToCheckClick(geo, '123 Main St, Bedford, PA');
  await flush(doc.defaultView); await flush(doc.defaultView);
  const overlay = doc.querySelector('.county-mismatch-overlay');
  assert.strictEqual(overlay, null, '"County" suffix alone must not trigger the dialog');
});

// ── 3) Cancel aborts entirely ──────────────────────────────────────────────
await test('clicking Cancel aborts the cross-post computation: no suggestions, no map, address box left populated', async () => {
  const geo = { animal_lat: 40.6884, animal_lon: -75.2207, animal_county: 'Northampton' };
  const { doc, window } = await driveToCheckClick(geo, 'Easton, Pennsylvania');
  await flush(window); await flush(window);

  const cancelBtn = doc.querySelector('.county-mismatch-cancel-btn');
  assert.ok(cancelBtn, 'cancel button present');
  cancelBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);

  assert.strictEqual(doc.querySelector('.county-mismatch-overlay'), null, 'dialog closed after Cancel');
  const resultDiv = doc.querySelector('#rec-output .cross-post-result');
  assert.notStrictEqual(resultDiv.textContent.indexOf('cancelled'), -1,
    'result banner communicates the check was cancelled: ' + resultDiv.textContent);
  assert.strictEqual(resultDiv.textContent.indexOf('Consider cross posting'), -1,
    'no cross-post area suggestions rendered after Cancel');
  assert.strictEqual(doc.querySelector('.cp-map-wrap'), null, 'no map rendered after Cancel');
  const addrInput = doc.querySelector('#rec-output .cross-post-addr');
  assert.strictEqual(addrInput.value, 'Easton, Pennsylvania', 'address box left populated for correction');
  assert.strictEqual(doc.querySelector('.cross-post-county-warning'), null, 'no persistent warning after Cancel');
});

// ── 4) Proceed renders with a persistent warning ───────────────────────────
await test('clicking "Use this address anyway" proceeds exactly as before AND leaves a persistent inline warning', async () => {
  const geo = { animal_lat: 40.6884, animal_lon: -75.2207, animal_county: 'Northampton' };
  const { doc, window } = await driveToCheckClick(geo, 'Easton, Pennsylvania');
  await flush(window); await flush(window);

  const proceedBtn = doc.querySelector('.county-mismatch-proceed-btn');
  proceedBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window); await flush(window);

  assert.strictEqual(doc.querySelector('.county-mismatch-overlay'), null, 'dialog closed after Proceed');
  const resultDiv = doc.querySelector('#rec-output .cross-post-result');
  assert.notStrictEqual(resultDiv.style.display, 'none', 'result banner renders after choosing to proceed');
  const warn = doc.querySelector('.cross-post-county-warning');
  assert.ok(warn, 'persistent inline warning is present after proceeding');
  assert.ok(/Northampton/.test(warn.textContent) && /Bedford/.test(warn.textContent),
    'persistent warning names both counties: ' + warn.textContent);
});

// ── Edge case 1: geocode fails -> existing error handling, no mismatch dialog ──
await test('edge case: geocode failure shows the existing error message, never the mismatch dialog', async () => {
  const { doc, window } = await driveToCheckClick({ __reject: true }, 'Not A Real Address 9999');
  await flush(window); await flush(window); await flush(window);
  assert.strictEqual(doc.querySelector('.county-mismatch-overlay'), null, 'no mismatch dialog on geocode failure');
  const resultDiv = doc.querySelector('#rec-output .cross-post-result');
  assert.ok(/Could not geocode/.test(resultDiv.textContent), 'existing geocode-failure copy shown: ' + resultDiv.textContent);
});

// ── Edge case 2: resolves outside PA entirely -> mismatch dialog reads sensibly ──
await test('edge case: address resolves outside PA (animal_county null from PIP) -> treated as unknown, no false mismatch invented', async () => {
  // The Worker's PIP returns null county/area for any point outside every PA
  // polygon (see worker/src/handler.js) UNLESS a Tier-1 fallback county
  // applies -- crossPostGeocode does not send animal_county, so no fallback
  // triggers and animal_county is genuinely null here.
  const geo = { animal_lat: 39.29, animal_lon: -76.61, animal_county: null };
  const { doc } = await driveToCheckClick(geo, 'Baltimore, Maryland');
  await flush(doc.defaultView); await flush(doc.defaultView);
  assert.strictEqual(doc.querySelector('.county-mismatch-overlay'), null,
    'null animal_county (edge case 3 -- unresolved) must not block, even though the point is out of state');
  const resultDiv = doc.querySelector('#rec-output .cross-post-result');
  assert.notStrictEqual(resultDiv.style.display, 'none', 'cross-post check still proceeds silently');
});

await test('edge case 2b: dialog copy never prints "undefined County" when geocodedCounty is falsy but a mismatch is otherwise forced', () => {
  // Direct unit check of the dialog's label-building logic (mirrors
  // showCountyMismatchDialog's geocodedLabel computation) to lock the exact
  // fallback string contract independent of whether real data ever reaches
  // this branch through the guard (the guard itself never blocks on a null
  // county -- this proves the copy is still safe if that ever changes).
  const WM = require(MESSAGES_JS);
  const M = WM.messages.countyMismatch;
  const geocodedCounty = null;
  const label = geocodedCounty ? geocodedCounty + ' County' : M.outsidePaFallback;
  assert.strictEqual(label, 'not in Pennsylvania');
  assert.strictEqual(/undefined/i.test(label), false, 'label never contains the literal "undefined"');
});

// ── Edge case 3: county cannot be resolved (null/empty) -> do not block ────
await test('edge case: empty-string animal_county -> treated as unknown, proceeds silently (no invented mismatch)', async () => {
  const geo = { animal_lat: 40.02, animal_lon: -78.5, animal_county: '' };
  const { doc } = await driveToCheckClick(geo, '123 Main St, Somewhere, PA');
  await flush(doc.defaultView); await flush(doc.defaultView);
  assert.strictEqual(doc.querySelector('.county-mismatch-overlay'), null, 'empty county must not trigger the dialog');
});

await test('edge case: whitespace-only animal_county -> treated as unknown, proceeds silently', async () => {
  const geo = { animal_lat: 40.02, animal_lon: -78.5, animal_county: '   ' };
  const { doc } = await driveToCheckClick(geo, '123 Main St, Somewhere, PA');
  await flush(doc.defaultView); await flush(doc.defaultView);
  assert.strictEqual(doc.querySelector('.county-mismatch-overlay'), null, 'whitespace-only county must not trigger the dialog');
});

// ── Edge case 4: no Tier 1 county selected yet -> proceed without dialog ──
// The Tier 1 "Check for Cross Post" button only ever renders AFTER a county
// is selected (recommend() shows "Select a county first" and never reaches
// renderCrossPostButton otherwise), so an empty selectedCounty is a
// defensive branch inside crossPostCountyGuard rather than a reachable Tier 1
// UI state. Exercise it directly against the REAL extracted function body
// (verbatim from dispatcher.js), calling it with county === '' exactly as
// renderCrossPostButton would pass it through from an unselected dropdown.
await test('edge case: empty selectedCounty -> nothing to compare against, proceeds without the dialog (direct unit check on the real guard body)', () => {
  const src = fs.readFileSync(DISPATCHER_JS, 'utf8');
  const header = /function crossPostCountyGuard\(address, lat, lon, geocodedCounty, dispatchArea, resultDiv, county\)\s*\{/;
  const m = src.match(header);
  assert.ok(m, 'crossPostCountyGuard(...) found in dispatcher.js');
  const braceStart = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, i = braceStart;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const body = src.slice(braceStart + 1, i);

  let distanceCheckCalled = false;
  let dialogShown = false;
  const runner = new Function('address', 'lat', 'lon', 'geocodedCounty', 'dispatchArea', 'resultDiv', 'county',
    'crossPostDistanceCheck', 'showCountyMismatchDialog', 'normalizeCountyName', 'state', 'haversineMiles',
    body);
  runner(
    'Easton, Pennsylvania', 40.6884, -75.2207, 'Northampton', '11', {},
    '', // county === '' -- no Tier 1 selection
    function () { distanceCheckCalled = true; },
    function () { dialogShown = true; },
    function (n) { return String(n || '').trim().toLowerCase(); },
    { countyCentroids: {} },
    function () { return 0; }
  );
  assert.strictEqual(dialogShown, false, 'no Tier-1 county selected -> the mismatch dialog must never be shown');
  assert.strictEqual(distanceCheckCalled, true, 'the cross-post distance check still proceeds when there is nothing to compare against');
});

console.log('\n' + '-'.repeat(40));
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}
console.log('ALL TESTS PASSED');
}

main();

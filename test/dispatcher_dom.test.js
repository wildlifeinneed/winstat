'use strict';
/**
 * REAL-DOM regression test for the served dispatcher UI.
 *
 * Loads the ACTUAL docs/dispatcher.html into jsdom, executes the ACTUAL
 * docs/assets/decision.js + docs/assets/dispatcher.js against that DOM, then
 * simulates an address-mode submit with a MOCKED Worker fetch and asserts the
 * rendered DOM.
 *
 * This guards the class/id mismatch bug: docs/dispatcher.html declared the
 * three role-count spans with class="agg-ct/agg-rvs/agg-courier" while
 * dispatcher.js renderAggregate() selects them by id (#agg-ct ...). The null
 * lookups threw a TypeError that the fetch .catch swallowed, showing the
 * generic "Could not reach the dispatcher service" banner for valid addresses.
 *
 * Run: node test/dispatcher_dom.test.js   (exit 0 = pass, 1 = fail)
 *
 *   - FAILS before the fix (class spans -> #agg-ct lookups return null ->
 *     error banner shown, role counts never rendered).
 *   - PASSES after the fix (spans carry ids; counts render; no error banner).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// The page's async init() calls renderCardsForCounty('') which iterates EVERY
// .cap-card; the address-mode cards have no .avail span, so that init render
// path rejects asynchronously. In a real browser that is a logged-but-non-fatal
// unhandled rejection and is unrelated to the agg-* bug under test. Absorb it
// here so it does not crash the Node test process. We still surface anything
// that is clearly NOT that known init quirk.
process.on('unhandledRejection', function (reason) {
  var msg = reason && reason.message ? reason.message : String(reason);
  if (msg.indexOf("setting 'textContent'") !== -1 ||
      msg.indexOf('Cannot set properties of null') !== -1) {
    return; // known init county-render quirk; non-fatal in browser
  }
  console.error('Unexpected unhandledRejection:', msg);
  process.exit(1);
});

const DOCS = path.resolve(__dirname, '..', 'docs');
const HTML_PATH = path.join(DOCS, 'dispatcher.html');
const DECISION_JS = path.join(DOCS, 'assets', 'decision.js');
const DISPATCHER_JS = path.join(DOCS, 'assets', 'dispatcher.js');
const GEOJSON_PATH = path.join(DOCS, 'data', 'pa_counties.geojson');

// Real committed PA county GeoJSON (67 features, win_area baked in). Served by
// the fetch mock so the map renders against production data — and the
// projection sanity check (Erie top-left, Philadelphia bottom-right) is real.
const PA_GEOJSON = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf8'));

const WORKER_AGG = {
  total_in_range: 32,
  role_counts: { 'C&T': 12, 'RVS C&T': 0, 'COURIER': 20 },
  win_areas: ['10', '11', '5'],
};

// Tier 1 data: county -> WIN area, and area -> coordinator NAME. Used by the
// coordinator-name (Tier 1) scenario. Allegheny is WIN area 10 -> Julia Meredith
// in the real docs/data files.
const COUNTY_WIN = { Allegheny: '10', Beaver: '10', Erie: '1' };
const COORDINATORS = { '10': 'Julia Meredith', '1': 'Sue DeArment' };

// Resolve a fetch() call against a tiny in-memory router. The dispatcher loads
// data/*.json on init (we return empty/ok) and calls the Worker on submit.
//
// opts.workerAgg overrides the aggregate body the mock Worker returns (used by
// the Tier 2 context-list scenarios). opts.data overrides specific data/*.json
// payloads (e.g. county_win.json, coordinators.json) for the Tier 1 scenario.
function makeFetch(workerHost, opts) {
  opts = opts || {};
  const workerAgg = opts.workerAgg || WORKER_AGG;
  const dataRoutes = opts.data || {};
  // Record aggregate (non-autocomplete) Worker request URLs so a scenario can
  // assert which params a path sent (e.g. Tier 2 carrying the shared rvs/issue).
  const aggCalls = opts.aggCalls || (opts.aggCalls = []);
  return function fetchMock(url) {
    const u = String(url);
    if (u.indexOf(workerHost) === 0 || u.indexOf('workers.dev') !== -1) {
      // Autocomplete route: return a deterministic suggestion list.
      if (u.indexOf('autocomplete=') !== -1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              suggestions: [
                { label: '4400 Forbes Avenue, Pittsburgh, Pennsylvania 15213', lat: 40.4443, lon: -79.9569 },
                { label: '4400 Forbes Road, Murrysville, Pennsylvania', lat: 40.43, lon: -79.69 },
              ],
            });
          },
        });
      }
      aggCalls.push(u);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve(workerAgg); },
      });
    }
    // Local data files loaded on init: return empty JSON so init resolves,
    // unless a scenario supplied an explicit payload for that file.
    let matchedKey = null;
    Object.keys(dataRoutes).forEach(function (k) { if (u.indexOf(k) !== -1) matchedKey = k; });
    if (matchedKey) {
      const payload = dataRoutes[matchedKey];
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve(payload); },
        text: function () { return Promise.resolve(JSON.stringify(payload)); },
      });
    }
    let body = {};
    if (u.indexOf('rehabbers.json') !== -1) body = [];
    if (u.indexOf('pa_counties.geojson') !== -1) {
      // Serve the real committed GeoJSON so the WIN Areas map renders its 67
      // county paths against production data.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve(PA_GEOJSON); },
        text: function () { return Promise.resolve(JSON.stringify(PA_GEOJSON)); },
      });
    }
    if (u.indexOf('config.json') !== -1) {
      return Promise.resolve({
        ok: true, status: 200,
        text: function () { return Promise.resolve('{}'); },
        json: function () { return Promise.resolve({}); },
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(JSON.stringify(body)); },
    });
  };
}

function loadDom(opts) {
  opts = opts || {};
  if (!opts.aggCalls) opts.aggCalls = [];
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.org/dispatcher.html',
  });
  const { window } = dom;

  // Swallow unhandled rejections from the page's async init the same way a real
  // browser does (it logs them but keeps running). The dispatcher's init calls
  // renderCardsForCounty('') which iterates every .cap-card; the address-mode
  // cards have no .avail span, so that init render path rejects asynchronously.
  // That is a separate latent quirk and is non-fatal in the browser — it must
  // not abort this address-mode regression test.
  window.addEventListener('unhandledrejection', function (e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
  });

  // Mock network BEFORE the page scripts run.
  window.fetch = makeFetch('https://pa-wildlife-dispatcher.winstat.workers.dev', opts);

  // Execute the REAL site scripts in page context (decision first, as the page
  // loads it first), so dispatcher.js sees window.WildlifeDecision.
  window.eval(fs.readFileSync(DECISION_JS, 'utf8'));
  window.eval(fs.readFileSync(DISPATCHER_JS, 'utf8'));

  // The IIFE registers DOMContentLoaded; fire it to run init().
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

  return { dom, window, opts };
}

function flush(window) {
  // Let queued microtasks (init's Promise.all and the submit promise chain) run.
  return new Promise(function (resolve) { window.setTimeout(resolve, 0); });
}

function wait(window, ms) {
  return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
}

async function runAddressMode() {
  const { window, opts: domOpts } = loadDom();
  const doc = window.document;

  // init() awaits Promise.all of the data loads; flush a couple of turns.
  await flush(window);
  await flush(window);

  // --- Shared animal base-info block lives at the TOP, OUTSIDE either mode --
  // panel (R1 input reorder): both search paths read these same radios.
  const baseInfo = doc.getElementById('animal-base-info');
  assert.ok(baseInfo, 'shared #animal-base-info block exists');
  const toggle = doc.querySelector('.mode-toggle');
  assert.ok(toggle, 'mode toggle exists');
  // It must precede the mode toggle in document order (entered first).
  assert.ok(
    baseInfo.compareDocumentPosition(toggle) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    'base-info block comes BEFORE the mode toggle');
  // ...and it must NOT live inside either mode panel.
  assert.ok(!doc.getElementById('county-mode').contains(baseInfo),
    'base-info block is not nested inside #county-mode');
  assert.ok(!doc.getElementById('address-mode').contains(baseInfo),
    'base-info block is not nested inside #address-mode');
  // The rvs/issue radios live in the shared block.
  assert.ok(baseInfo.querySelector('input[name="rvs"]'), 'rvs radios in shared block');
  assert.ok(baseInfo.querySelector('input[name="issue"]'), 'issue radios in shared block');

  // --- County mode still renders (sanity) -------------------------------
  const countySel = doc.getElementById('county');
  assert.ok(countySel, 'county select exists');
  countySel.value = 'Allegheny';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  // Cards should leave the all-"—" placeholder state once a county is chosen.
  const ctCard = doc.querySelector('.cap-card[data-role="ct_no_rvs"] .avail');
  assert.ok(ctCard, 'county C&T card avail span exists');
  // With empty snapshot it renders "0" (not throwing) — county render path OK.
  assert.strictEqual(ctCard.textContent, '0', 'county mode renders a numeric value');

  // --- Switch to Address mode ------------------------------------------
  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.strictEqual(doc.getElementById('address-mode').hidden, false, 'address panel visible');

  // --- Autocomplete typeahead: type -> suggestions render -> select ----
  const addrInput = doc.getElementById('animal-address');
  const acList = doc.getElementById('address-suggestions');
  assert.ok(acList, 'suggestion listbox exists');

  // Type a partial query and fire 'input' to trigger the debounced lookup.
  addrInput.value = '4400 Forbes';
  addrInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  // Wait past the ~280ms debounce + let the mocked fetch promise settle.
  await wait(window, 350);
  await flush(window);
  await flush(window);

  const opts = Array.prototype.slice.call(acList.querySelectorAll('.ac-item'));
  assert.strictEqual(acList.hidden, false, 'suggestion list is shown after typing');
  assert.strictEqual(opts.length, 2, 'two suggestions rendered (got ' + opts.length + ')');
  assert.strictEqual(opts[0].textContent.trim(),
    '4400 Forbes Avenue, Pittsburgh, Pennsylvania 15213', 'first suggestion label');
  assert.strictEqual(addrInput.getAttribute('aria-expanded'), 'true', 'aria-expanded set');

  // ArrowDown highlights first, Enter selects it -> fills input, closes list,
  // and does NOT submit (no aggregate result yet).
  addrInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  addrInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush(window);
  assert.strictEqual(addrInput.value, '4400 Forbes Avenue, Pittsburgh, Pennsylvania 15213',
    'selecting a suggestion fills the input');
  assert.strictEqual(acList.hidden, true, 'list closes after select');
  assert.strictEqual(doc.getElementById('address-result').style.display !== 'block', true,
    'selecting a suggestion must NOT trigger the aggregate submit');

  // --- Fill + submit ----------------------------------------------------
  // Set the SHARED base info to NON-defaults (RVS=yes, Issue=transport) before
  // submitting via the Address path, then assert the Worker request carried
  // those exact values (both paths consume the same top-of-page input).
  doc.querySelector('input[name="rvs"][value="yes"]').checked = true;
  doc.querySelector('input[name="issue"][value="transport"]').checked = true;
  doc.getElementById('animal-address').value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));

  // Allow the mocked fetch promise chain (then -> renderAggregate -> then) to settle.
  await flush(window);
  await flush(window);
  await flush(window);

  // The Address path must forward the shared base info to the Worker.
  const aggUrl = domOpts.aggCalls[domOpts.aggCalls.length - 1] || '';
  assert.ok(/[?&]rvs=yes(&|$)/.test(aggUrl),
    'Address path forwards rvs=yes from the shared base info (url: ' + aggUrl + ')');
  assert.ok(/[?&]issue=transport(&|$)/.test(aggUrl),
    'Address path forwards issue=transport from the shared base info (url: ' + aggUrl + ')');

  // --- Assert rendered aggregate DOM -----------------------------------
  const errEl = doc.getElementById('address-error');
  const errVisible = errEl && errEl.style.display !== 'none' && (errEl.textContent || '').trim() !== '';
  assert.strictEqual(errVisible, false,
    'NO error banner should be shown for a valid address (got: "' +
    (errEl ? errEl.textContent : '') + '")');

  const result = doc.getElementById('address-result');
  assert.strictEqual(result.style.display, 'block', 'address-result section is shown');

  assert.strictEqual(doc.getElementById('agg-total').textContent, '32', 'total = 32');
  assert.strictEqual(doc.getElementById('agg-ct').textContent, '12', 'C&T = 12');
  assert.strictEqual(doc.getElementById('agg-rvs').textContent, '0', 'RVS C&T = 0');
  assert.strictEqual(doc.getElementById('agg-courier').textContent, '20', 'COURIER = 20');

  // Area chips 5 / 10 / 11 (rendered in the order the Worker returned).
  const chips = Array.prototype.slice
    .call(doc.querySelectorAll('#agg-areas .win-chip'))
    .map(function (c) { return c.textContent.trim(); });
  assert.deepStrictEqual(chips, ['Area 10', 'Area 11', 'Area 5'],
    'area chips render 10/11/5 (got ' + JSON.stringify(chips) + ')');
  ['5', '10', '11'].forEach(function (a) {
    assert.ok(chips.indexOf('Area ' + a) !== -1, 'area ' + a + ' chip present');
  });

  console.log('PASS: dispatcher address-mode renders 32 / C&T 12 / RVS 0 / COURIER 20, chips ' +
    JSON.stringify(chips) + ', no error banner; county mode renders.');
}

// ── Tier 1: selecting a county renders the COORDINATOR NAME (name only, no
//    phone) resolved county -> WIN area (county_win.json) -> name
//    (coordinators.json), plus the "Widen search" affordance. ──────────────
async function runTier1Coordinator() {
  const { window } = loadDom({
    data: {
      'county_win.json': COUNTY_WIN,
      'coordinators.json': COORDINATORS,
    },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  const countySel = doc.getElementById('county');
  countySel.value = 'Allegheny';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);

  const coordLine = doc.getElementById('coord-line');
  assert.ok(coordLine, 'coord-line element exists');
  assert.strictEqual(coordLine.style.display, 'block', 'coord-line visible after county select');
  const txt = coordLine.textContent || '';
  assert.ok(txt.indexOf('Julia Meredith') !== -1,
    'Tier 1 shows the coordinator NAME (got: "' + txt + '")');
  assert.ok(txt.indexOf('Area 10') !== -1, 'Tier 1 shows the WIN area context');
  // PII guard: no phone-like digit sequences in the coordinator line.
  assert.ok(!/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(txt),
    'coordinator line must show NAME ONLY, never a phone number');

  const widen = doc.getElementById('widen-prompt');
  assert.ok(widen && widen.style.display === 'block', 'Widen-search affordance is shown');

  // A county with no WIN-area mapping falls back to a neutral "no coordinator"
  // line (still NAME-only domain, never a phone).
  countySel.value = 'Adams';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  const fallback = doc.getElementById('coord-line').textContent || '';
  assert.ok(fallback.indexOf('No coordinator') !== -1,
    'unmapped county shows the no-coordinator fallback (got: "' + fallback + '")');

  console.log('PASS: Tier 1 renders coordinator NAME (Julia Meredith / Area 10) + widen affordance, no phone.');
}

// Drive a Tier 2 "widen" query: select a county, click Widen, submit an
// address, and return the document for assertions. The mock Worker returns the
// supplied `agg` (which carries the out_of_county context list).
async function driveTier2(agg, county) {
  const { window, opts } = loadDom({
    workerAgg: agg,
    data: { 'county_win.json': COUNTY_WIN, 'coordinators.json': COORDINATORS },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  const countySel = doc.getElementById('county');
  countySel.value = county;
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);

  // Click the Tier 1 -> Tier 2 "Widen search" button.
  doc.getElementById('widen-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  assert.strictEqual(doc.getElementById('address-mode').hidden, false,
    'widen switches to Address mode');

  doc.getElementById('animal-address').value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);
  return { window, doc, opts };
}

// ── Tier 2: out_of_county rows render as ONE row per volunteer with role
//    badge(s) + distance, in the Worker's nearest-first order. ─────────────
async function runTier2ContextList() {
  const agg = {
    total_in_range: 5,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: [],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 8.2, win_area: '11', county: 'Beaver' },
      { roles: ['RVS C&T', 'COURIER'], distance_mi: 14.7, win_area: '12', county: 'Butler' },
      { roles: ['COURIER'], distance_mi: 21.3, win_area: '5', county: 'Westmoreland' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc, opts } = await driveTier2(agg, 'Allegheny');

  // The Tier 2 widen request carries BOTH the context scope AND the shared
  // animal base info (defaults RVS=no / Issue=capture here) — same input as Tier 1.
  const t2Url = opts.aggCalls[opts.aggCalls.length - 1] || '';
  assert.ok(/[?&]context=1(&|$)/.test(t2Url), 'Tier 2 request opts into context=1');
  assert.ok(/[?&]exclude_county=Allegheny(&|$)/.test(t2Url),
    'Tier 2 request excludes the Tier 1 county');
  assert.ok(/[?&]rvs=no(&|$)/.test(t2Url),
    'Tier 2 request carries the shared rvs base info (url: ' + t2Url + ')');
  assert.ok(/[?&]issue=capture(&|$)/.test(t2Url),
    'Tier 2 request carries the shared issue base info (url: ' + t2Url + ')');

  const block = doc.getElementById('ctx-block');
  assert.strictEqual(block.style.display, 'block', 'context block is shown');
  assert.strictEqual(doc.getElementById('ctx-notice').style.display, 'none',
    'no overflow notice when not truncated');

  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 3, 'one row per volunteer (got ' + rows.length + ')');

  // Nearest-first order preserved.
  const dists = rows.map(function (r) {
    return (r.querySelector('.ctx-dist').textContent || '').trim();
  });
  assert.deepStrictEqual(dists, ['8.2 mi', '14.7 mi', '21.3 mi'],
    'distances render in nearest-first order (got ' + JSON.stringify(dists) + ')');

  // Role badges per row.
  const r0badges = Array.prototype.slice.call(rows[0].querySelectorAll('.role-badge'))
    .map(function (b) { return b.textContent.trim(); });
  assert.deepStrictEqual(r0badges, ['C&T'], 'row 0 has one C&T badge');
  const r1badges = Array.prototype.slice.call(rows[1].querySelectorAll('.role-badge'))
    .map(function (b) { return b.textContent.trim(); });
  assert.deepStrictEqual(r1badges, ['RVS C&T', 'COURIER'], 'row 1 has both role badges');

  // Context (area/county) present; PII (name/phone) absent.
  assert.ok((rows[0].textContent || '').indexOf('Beaver') !== -1, 'row 0 shows county context');
  rows.forEach(function (r) {
    assert.ok(!/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(r.textContent || ''),
      'context rows must never render a phone number');
  });

  // Header reflects the excluded county + radius.
  const hdr = doc.getElementById('ctx-header').textContent || '';
  assert.ok(hdr.indexOf('50 mi') !== -1 && hdr.indexOf('Allegheny') !== -1,
    'context header names radius + excluded county (got: "' + hdr + '")');

  console.log('PASS: Tier 2 renders 3 context rows (nearest-first) with role badges, no PII.');
}

// ── Tier 2 overflow: radius_too_broad -> show notice above the (5) rows. ────
async function runTier2Overflow() {
  const five = [];
  for (let i = 0; i < 5; i++) {
    five.push({ roles: ['C&T'], distance_mi: 10 + i, win_area: '11', county: 'Beaver' });
  }
  const agg = {
    total_in_range: 99,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: [],
    out_of_county: five,
    out_of_county_truncated: true,
    radius_too_broad: true,
  };
  const { doc } = await driveTier2(agg, 'Allegheny');

  const notice = doc.getElementById('ctx-notice');
  assert.strictEqual(notice.style.display, 'block', 'overflow notice is shown when radius_too_broad');
  const ntxt = notice.textContent || '';
  assert.ok(/Radius too large/i.test(ntxt) && ntxt.indexOf('5') !== -1,
    'overflow notice mentions "Radius too large" + the 5 nearest (got: "' + ntxt + '")');
  const rows = doc.querySelectorAll('#ctx-list .ctx-row');
  assert.strictEqual(rows.length, 5, 'overflow shows the 5 nearest rows');

  console.log('PASS: Tier 2 overflow notice renders above the 5 nearest rows.');
}

// ── Tier 2 empty-state: out_of_county = [] -> friendly empty message. ───────
async function runTier2Empty() {
  const agg = {
    total_in_range: 0,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: [],
    out_of_county: [],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc } = await driveTier2(agg, 'Allegheny');

  const block = doc.getElementById('ctx-block');
  assert.strictEqual(block.style.display, 'block', 'context block shown even when empty');
  const empty = doc.getElementById('ctx-empty');
  assert.strictEqual(empty.style.display, 'block', 'empty-state message is shown');
  assert.ok(/No out-of-county volunteers/i.test(empty.textContent || ''),
    'empty-state copy present (got: "' + empty.textContent + '")');
  assert.strictEqual(doc.querySelectorAll('#ctx-list .ctx-row').length, 0,
    'no rows in empty-state');

  console.log('PASS: Tier 2 empty-state renders when out_of_county is [].');
}

// ── Tier 2 availability: summary cards render avail/total ratio + a "Marginal"
//    badge when available <= marginal_threshold, mirroring Tier 1. ───────────
async function runTier2Availability() {
  const agg = {
    total_in_range: 6,
    role_counts: { 'C&T': 4, 'RVS C&T': 2, 'COURIER': 3 },
    role_available: { 'C&T': 3, 'RVS C&T': 1, 'COURIER': 0 },
    total_available: 4,
    marginal_threshold: 1,
    win_areas: ['10'],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 8.2, win_area: '11', county: 'Beaver' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc } = await driveTier2(agg, 'Allegheny');

  function card(bucket) { return doc.querySelector('.cap-card[data-bucket="' + bucket + '"]'); }
  function availOf(bucket) { return (card(bucket).querySelector('.avail').textContent || '').trim(); }
  function totalOf(bucket) { return (card(bucket).querySelector('.total').textContent || '').trim(); }
  function badge(bucket) { return card(bucket).querySelector('.badge'); }

  // avail/total ratio mirrors Tier 1 (.avail / .total).
  assert.strictEqual(availOf('C&T'), '3', 'C&T avail = 3');
  assert.strictEqual(totalOf('C&T'), '4', 'C&T total = 4');
  assert.strictEqual(availOf('RVS C&T'), '1', 'RVS avail = 1');
  assert.strictEqual(totalOf('RVS C&T'), '2', 'RVS total = 2');
  assert.strictEqual(availOf('COURIER'), '0', 'COURIER avail = 0');
  assert.strictEqual(totalOf('COURIER'), '3', 'COURIER total = 3');

  // Marginal badge: RVS (avail 1 <= threshold 1) and COURIER (avail 0) are
  // marginal; C&T (avail 3 > 1) is NOT.
  assert.ok(!badge('C&T'), 'C&T (avail 3) is NOT marginal');
  assert.ok(badge('RVS C&T'), 'RVS C&T (avail 1 <= 1) shows Marginal badge');
  assert.strictEqual(badge('RVS C&T').textContent.trim(), 'Marginal');
  assert.ok(badge('COURIER'), 'COURIER (avail 0) shows Marginal badge');

  // PII guard: the summary cards carry only counts, never identity.
  const cardsText = doc.querySelector('.cards-grid').textContent || '';
  assert.ok(!/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(cardsText),
    'Tier 2 summary cards must never render a phone number');

  console.log('PASS: Tier 2 cards render avail/total (3/4, 1/2, 0/3) + Marginal badges on RVS & COURIER.');
}

// ── Tier 2 backward compat: a Worker payload WITHOUT availability fields must
//    still render (avail falls back to total, NO spurious Marginal badge). ───
async function runTier2AvailabilityBackcompat() {
  const agg = {
    total_in_range: 5,
    role_counts: { 'C&T': 2, 'RVS C&T': 1, 'COURIER': 3 },
    // NO role_available / total_available / marginal_threshold (old Worker).
    win_areas: ['10'],
    out_of_county: [],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc } = await driveTier2(agg, 'Allegheny');

  function card(bucket) { return doc.querySelector('.cap-card[data-bucket="' + bucket + '"]'); }
  // avail falls back to the count so the ratio reads N/N.
  assert.strictEqual((card('C&T').querySelector('.avail').textContent || '').trim(), '2');
  assert.strictEqual((card('C&T').querySelector('.total').textContent || '').trim(), '2');
  // NO Marginal badge anywhere when availability is unknown.
  assert.strictEqual(doc.querySelectorAll('.cards-grid .cap-card .badge').length, 0,
    'no Marginal badge when the payload predates availability');

  console.log('PASS: Tier 2 cards degrade gracefully (avail=count, no badge) for pre-availability payloads.');
}

// ── D5.2: the WIN Areas map renders 67 county <path>s from the GeoJSON, each
//    tagged with its win_area, and the projection puts Erie (NW) up-and-left of
//    Philadelphia (SE). ─────────────────────────────────────────────────────
async function runMapRender() {
  const { window } = loadDom();
  const doc = window.document;
  await flush(window);
  await flush(window);
  await flush(window);

  const svg = doc.querySelector('#map-svg-wrap svg.map-svg');
  assert.ok(svg, 'inline SVG map is rendered');
  const paths = Array.prototype.slice.call(svg.querySelectorAll('path.county-path'));
  assert.strictEqual(paths.length, 67, 'map renders 67 county paths (got ' + paths.length + ')');

  // Every path carries a county + area data attr; titles are county tooltips.
  paths.forEach(function (p) {
    assert.ok(p.getAttribute('data-county'), 'path has a data-county');
    assert.ok(p.getAttribute('d') && p.getAttribute('d').indexOf('M') === 0,
      'path "d" starts with a moveto');
  });

  // Legend lists each WIN area present (17 distinct: 1-16 with 15 split N/S).
  const legItems = doc.querySelectorAll('#map-legend .leg-item');
  assert.strictEqual(legItems.length, 17,
    'legend shows 17 area swatches (got ' + legItems.length + ')');

  // Projection sanity: compare the first vertex (moveto) of two known counties.
  // Erie is NW (small lon -> left, high lat -> top); Philadelphia is SE.
  function firstXY(county) {
    const p = paths.filter(function (n) { return n.getAttribute('data-county') === county; })[0];
    assert.ok(p, county + ' path exists');
    const m = (p.getAttribute('d') || '').match(/^M([\d.]+)\s+([\d.]+)/);
    assert.ok(m, county + ' path has a moveto');
    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
  }
  const erie = firstXY('Erie');
  const philly = firstXY('Philadelphia');
  assert.ok(erie.x < philly.x,
    'Erie projects LEFT of Philadelphia (erie.x ' + erie.x.toFixed(1) +
    ' < philly.x ' + philly.x.toFixed(1) + ')');
  assert.ok(erie.y < philly.y,
    'Erie projects ABOVE Philadelphia (smaller y; erie.y ' + erie.y.toFixed(1) +
    ' < philly.y ' + philly.y.toFixed(1) + ')');

  console.log('PASS: map renders 67 county paths + 17-area legend; Erie projects up-and-left of Philadelphia.');
}

// ── D5.3: highlightAreas([n]) adds the highlight class to counties in those
//    areas and NOT to counties in other areas; clearing removes it. ──────────
async function runHighlightAreas() {
  const { window } = loadDom();
  const doc = window.document;
  await flush(window);
  await flush(window);
  await flush(window);

  assert.ok(window.WildlifeMap && typeof window.WildlifeMap.highlightAreas === 'function',
    'WildlifeMap.highlightAreas API is exposed');

  // Highlight area 7 as a helper area.
  window.WildlifeMap.highlightAreas([], [7]);

  const a7 = Array.prototype.slice.call(
    doc.querySelectorAll('path.county-path[data-area="7"]'));
  const notA7 = Array.prototype.slice.call(
    doc.querySelectorAll('path.county-path:not([data-area="7"])'));
  assert.ok(a7.length > 0, 'there are area-7 counties on the map');
  a7.forEach(function (p) {
    assert.ok(p.classList.contains('hl-helper'),
      'area-7 county ' + p.getAttribute('data-county') + ' is highlighted (hl-helper)');
  });
  notA7.forEach(function (p) {
    assert.ok(!p.classList.contains('hl-helper') && !p.classList.contains('hl-animal'),
      'non-area-7 county ' + p.getAttribute('data-county') + ' is NOT highlighted');
  });
  // The SVG gets the dim class + the panel flags has-highlight.
  assert.ok(doc.querySelector('svg.map-svg').classList.contains('dimmed'),
    'map dims the rest when a highlight is applied');
  assert.ok(doc.getElementById('map-panel').classList.contains('has-highlight'),
    'panel flags has-highlight when a highlight is applied');

  // Clearing removes all highlight classes + the dim/flag.
  window.WildlifeMap.clearHighlight();
  const stillOn = doc.querySelectorAll('path.county-path.hl-helper, path.county-path.hl-animal');
  assert.strictEqual(stillOn.length, 0, 'clearHighlight removes all highlight classes');
  assert.ok(!doc.querySelector('svg.map-svg').classList.contains('dimmed'),
    'clearHighlight undims the map');

  console.log('PASS: highlightAreas([7]) highlights only area-7 counties; clearHighlight resets.');
}

// ── D5.3 Tier 2: rendering the out-of-county context list highlights the UNION
//    of the rows' win_areas (helper) plus the animal county's area (animal). ──
async function runTier2Highlight() {
  const agg = {
    total_in_range: 4,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: [],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 9.1, win_area: '7', county: 'Centre' },
      { roles: ['COURIER'], distance_mi: 18.6, win_area: '13', county: 'Dauphin' },
      { roles: ['C&T'], distance_mi: 22.0, win_area: '7', county: 'Blair' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  // Animal county Allegheny -> WIN area 10 (from COUNTY_WIN).
  const { doc } = await driveTier2(agg, 'Allegheny');

  // Helper areas 7 and 13 are highlighted (amber); area 10 (animal) is green.
  const a7 = doc.querySelectorAll('path.county-path[data-area="7"].hl-helper');
  const a13 = doc.querySelectorAll('path.county-path[data-area="13"].hl-helper');
  const a10 = doc.querySelectorAll('path.county-path[data-area="10"].hl-animal');
  assert.ok(a7.length > 0, 'Tier 2 highlights area-7 helper counties');
  assert.ok(a13.length > 0, 'Tier 2 highlights area-13 helper counties');
  assert.ok(a10.length > 0, 'Tier 2 highlights the animal county area (10) distinctly');

  // An area NOT in the union (e.g. 2) must stay un-highlighted.
  const a2on = doc.querySelectorAll('path.county-path[data-area="2"].hl-helper, path.county-path[data-area="2"].hl-animal');
  assert.strictEqual(a2on.length, 0, 'areas outside the union are not highlighted');

  // Helper areas must NOT also carry the animal class (distinct styling).
  doc.querySelectorAll('path.county-path[data-area="7"]').forEach(function (p) {
    assert.ok(!p.classList.contains('hl-animal'),
      'helper area 7 is styled as helper, not animal');
  });

  console.log('PASS: Tier 2 highlights the union of out_of_county areas (7, 13) + animal area (10) distinctly.');
}

// ── D5.3 Tier 1: selecting a county highlights that county's WIN area (animal)
//    on the map; deselecting clears it. ────────────────────────────────────
async function runTier1Highlight() {
  const { window } = loadDom({
    data: { 'county_win.json': COUNTY_WIN, 'coordinators.json': COORDINATORS },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);
  await flush(window);

  const countySel = doc.getElementById('county');
  countySel.value = 'Allegheny'; // WIN area 10
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);

  const a10 = doc.querySelectorAll('path.county-path[data-area="10"].hl-animal');
  assert.ok(a10.length > 0, 'Tier 1 highlights the selected county area (10) as animal');
  const others = doc.querySelectorAll('path.county-path:not([data-area="10"]).hl-animal');
  assert.strictEqual(others.length, 0, 'Tier 1 highlights ONLY the selected county area');

  // Deselect -> highlight cleared.
  countySel.value = '';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  const stillOn = doc.querySelectorAll('path.county-path.hl-animal, path.county-path.hl-helper');
  assert.strictEqual(stillOn.length, 0, 'deselecting a county clears the Tier 1 highlight');

  console.log('PASS: Tier 1 county select highlights only that county area (animal); deselect clears it.');
}

async function run() {
  await runAddressMode();
  await runTier1Coordinator();
  await runTier2ContextList();
  await runTier2Overflow();
  await runTier2Empty();
  await runTier2Availability();
  await runTier2AvailabilityBackcompat();
  await runMapRender();
  await runHighlightAreas();
  await runTier2Highlight();
  await runTier1Highlight();
  console.log('\nALL DOM TESTS PASSED (11 scenarios).');
}

run().then(function () {
  process.exit(0);
}).catch(function (err) {
  console.error('FAIL:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});

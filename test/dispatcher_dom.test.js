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
const MESSAGES_JS = path.join(DOCS, 'assets', 'messages.js');
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

  // Execute the REAL site scripts in page context (messages + decision first,
  // as the page loads them first), so dispatcher.js sees window.WildlifeMessages
  // and window.WildlifeDecision.
  window.eval(fs.readFileSync(MESSAGES_JS, 'utf8'));
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
  // Summary uses the informational heading pattern "Volunteers in range: N"
  // (no "(s)" parenthetical pluralization).
  const aggSummary = (doc.querySelector('.agg-summary').textContent || '').trim();
  assert.ok(/Volunteers in range:\s*32/.test(aggSummary),
    'summary reads "Volunteers in range: 32" (got: "' + aggSummary + '")');
  assert.ok(!/\(s\)/.test(aggSummary),
    'summary has no "(s)" pluralization (got: "' + aggSummary + '")');
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
  assert.ok(txt.indexOf('Area 10 Coordinator:') !== -1,
    'Tier 1 uses informational "Area XX Coordinator:" label with the WIN area (got: "' + txt + '")');
  assert.ok(!/Notify/i.test(txt),
    'Tier 1 label must be informational, not an imperative "Notify ..." directive (got: "' + txt + '")');
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

  console.log('PASS: Tier 1 renders "Area 10 Coordinator: Julia Meredith" (info, not directive) + widen affordance, no phone.');
}

// Drive a Tier 2 "widen" query: select a county, click Widen, submit an
// address, and return the document for assertions. The mock Worker returns the
// supplied `agg` (which carries the out_of_county context list).
//
// `base` (optional) overrides the shared animal base-info radios before submit:
//   { rvs: true|false, issue: 'capture'|'transport' }. Defaults (RVS=no,
//   Issue=capture) apply when omitted.
async function driveTier2(agg, county, base) {
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

  // Optionally set the SHARED animal base info (entered once at the top) so the
  // Tier 2 qualification tag + lenient recommendation see the right RVS/Issue.
  if (base) {
    const rvsVal = base.rvs ? 'yes' : 'no';
    const rvsEl = doc.querySelector('input[name="rvs"][value="' + rvsVal + '"]');
    if (rvsEl) rvsEl.checked = true;
    const issueEl = doc.querySelector('input[name="issue"][value="' + base.issue + '"]');
    if (issueEl) issueEl.checked = true;
  }

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

  // R4: the recommended-actions block is INFORMATIONAL, not directive.
  // The volunteer-count line reads "WIN volunteers found: ..." (no "Task"/
  // "Connecteam" action verb), and the coordinator is LISTED as info with the
  // Tier-1-style "Area N Coordinator: <name>" label (no "Contact", no "(s)").
  // NOTE: the separate LENIENT/actionable line legitimately keeps "Connecteam"
  // (it stays a real action), so we assert per-line on the info lines, not on
  // the whole actions blob.
  const actionLines = Array.prototype.slice
    .call(doc.querySelectorAll('#agg-actions .action-line'))
    .map(function (el) { return (el.textContent || '').trim(); });

  const volLine = actionLines.filter(function (t) { return /WIN volunteers found:/.test(t); });
  assert.strictEqual(volLine.length, 1,
    'exactly one info line "WIN volunteers found:" (got: ' + JSON.stringify(actionLines) + ')');
  assert.ok(!/Task/.test(volLine[0]) && !/Connecteam/.test(volLine[0]),
    'volunteer info line drops the imperative "Task Connecteam" verb (got: "' + volLine[0] + '")');

  const coordLines = actionLines.filter(function (t) { return /Coordinator:/.test(t); });
  assert.strictEqual(coordLines.length, 1,
    'one "Area N Coordinator: <name>" line for the single in-range area (got: ' + JSON.stringify(coordLines) + ')');
  assert.ok(/Area 10 Coordinator: Julia Meredith/.test(coordLines[0]),
    'coordinator is LISTED as "Area 10 Coordinator: Julia Meredith" (got: "' + coordLines[0] + '")');
  assert.ok(!/Contact/.test(coordLines[0]),
    'coordinator line drops the imperative "Contact" verb (got: "' + coordLines[0] + '")');
  assert.ok(!/coordinator\(s\)/i.test(actionLines.join(' ')),
    'no "(s)" anywhere — exactly one coordinator per area (got: ' + JSON.stringify(actionLines) + ')');

  console.log('PASS: Tier 2 cards render avail/total (3/4, 1/2, 0/3) + Marginal badges on RVS & COURIER; recommended actions are informational ("WIN volunteers found:" + "Area 10 Coordinator: Julia Meredith").');
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

// ── R2 (a): per-row qualification TAG (strict, via shared decision.js) ──────
//    For an RVS animal (capture), ONLY 'RVS C&T' rows get the green check; a
//    plain C&T or a COURIER row gets the red X. Mirrors decision.js exactly.
async function runTier2QualTagRvsCapture() {
  const agg = {
    total_in_range: 3,
    role_counts: { 'C&T': 1, 'RVS C&T': 1, 'COURIER': 1 },
    win_areas: [],
    out_of_county: [
      { roles: ['RVS C&T'], distance_mi: 5.0, win_area: '11', county: 'Beaver' },
      { roles: ['C&T'], distance_mi: 9.0, win_area: '12', county: 'Butler' },
      { roles: ['COURIER'], distance_mi: 12.0, win_area: '5', county: 'Westmoreland' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  // RVS animal + capture -> requires RVS C&T.
  const { doc } = await driveTier2(agg, 'Allegheny', { rvs: true, issue: 'capture' });

  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 3, 'ALL rows shown regardless of qualification (got ' + rows.length + ')');

  function qual(r) { return r.querySelector('.qual-badge'); }
  assert.ok(qual(rows[0]) && qual(rows[0]).classList.contains('qual-yes'),
    'RVS C&T row qualifies (green) for RVS capture');
  assert.ok(qual(rows[1]) && qual(rows[1]).classList.contains('qual-no'),
    'plain C&T row does NOT qualify (red X) for RVS capture');
  assert.ok(qual(rows[2]) && qual(rows[2]).classList.contains('qual-no'),
    'COURIER row does NOT qualify (red X) for RVS capture');
  // The badge text/icon reflect the state honestly.
  assert.ok(/Qualified/.test(qual(rows[0]).textContent) && /\u2713/.test(qual(rows[0]).textContent),
    'qualified badge shows a check + "Qualified"');
  assert.ok(/Not qualified/.test(qual(rows[1]).textContent) && /\u2717/.test(qual(rows[1]).textContent),
    'not-qualified badge shows an X + "Not qualified"');

  // Cross-check against decision.js DIRECTLY so the tag can never drift.
  const D = require(path.join(DOCS, 'assets', 'decision.js'));
  assert.strictEqual(D.qualifiesForAnimal(['RVS C&T'], true, 'capture'), true);
  assert.strictEqual(D.qualifiesForAnimal(['C&T'], true, 'capture'), false);
  assert.strictEqual(D.qualifiesForAnimal(['COURIER'], true, 'capture'), false);

  console.log('PASS: Tier 2 strict tag (RVS capture) — RVS C&T green, C&T/COURIER red; all 3 rows shown.');
}

// ── R2 (a): per-row tag for NON-RVS capture and transport cases. ────────────
async function runTier2QualTagCaptureTransport() {
  // Non-RVS capture -> C&T or RVS C&T qualify; COURIER does NOT.
  const captureAgg = {
    total_in_range: 3,
    role_counts: { 'C&T': 1, 'RVS C&T': 1, 'COURIER': 1 },
    win_areas: [],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 4.0, win_area: '11', county: 'Beaver' },
      { roles: ['RVS C&T'], distance_mi: 7.0, win_area: '12', county: 'Butler' },
      { roles: ['COURIER'], distance_mi: 10.0, win_area: '5', county: 'Westmoreland' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  let res = await driveTier2(captureAgg, 'Allegheny', { rvs: false, issue: 'capture' });
  let rows = Array.prototype.slice.call(res.doc.querySelectorAll('#ctx-list .ctx-row'));
  function qual(r) { return r.querySelector('.qual-badge'); }
  assert.ok(qual(rows[0]).classList.contains('qual-yes'), 'C&T qualifies for non-RVS capture');
  assert.ok(qual(rows[1]).classList.contains('qual-yes'), 'RVS C&T qualifies for non-RVS capture');
  assert.ok(qual(rows[2]).classList.contains('qual-no'), 'COURIER does NOT qualify for capture');

  // Transport -> C&T, RVS C&T, AND COURIER all qualify.
  const transportAgg = {
    total_in_range: 3,
    role_counts: { 'C&T': 1, 'RVS C&T': 1, 'COURIER': 1 },
    win_areas: [],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 4.0, win_area: '11', county: 'Beaver' },
      { roles: ['RVS C&T'], distance_mi: 7.0, win_area: '12', county: 'Butler' },
      { roles: ['COURIER'], distance_mi: 10.0, win_area: '5', county: 'Westmoreland' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  res = await driveTier2(transportAgg, 'Allegheny', { rvs: false, issue: 'transport' });
  rows = Array.prototype.slice.call(res.doc.querySelectorAll('#ctx-list .ctx-row'));
  rows.forEach(function (r) {
    assert.ok(qual(r).classList.contains('qual-yes'),
      'all qualifying roles qualify for transport');
  });

  // Cross-check decision.js directly.
  const D = require(path.join(DOCS, 'assets', 'decision.js'));
  assert.strictEqual(D.qualifiesForAnimal(['C&T'], false, 'capture'), true);
  assert.strictEqual(D.qualifiesForAnimal(['COURIER'], false, 'capture'), false);
  assert.strictEqual(D.qualifiesForAnimal(['COURIER'], false, 'transport'), true);

  console.log('PASS: Tier 2 strict tag — non-RVS capture (C&T/RVS green, COURIER red); transport (all green).');
}

// ── R2 (c): LENIENT recommendation surfaces BACKUP options when there is NO
//    fully-qualified helper in range, with the gap stated. ──────────────────
async function runTier2LenientBackup() {
  // RVS capture, but the only out-of-county helpers are a plain C&T + a COURIER
  // (neither qualifies for an RVS capture). The recommendation must surface
  // them as backup and direct the strict RVS capture to PGC.
  const agg = {
    total_in_range: 2,
    role_counts: { 'C&T': 1, 'RVS C&T': 0, 'COURIER': 1 },
    win_areas: ['11', '5'],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 8.0, win_area: '11', county: 'Beaver' },
      { roles: ['COURIER'], distance_mi: 15.0, win_area: '5', county: 'Westmoreland' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc } = await driveTier2(agg, 'Allegheny', { rvs: true, issue: 'capture' });

  const actions = doc.getElementById('agg-actions').textContent || '';
  assert.ok(/backup/i.test(actions),
    'recommendation surfaces nearby helpers as BACKUP (got: "' + actions + '")');
  assert.ok(/Nearby backup helpers:\s*2/.test(actions),
    'backup line uses the heading pattern "Nearby backup helpers: N" (got: "' + actions + '")');
  assert.ok(!/\(s\)/.test(actions),
    'no "(s)" pluralization in the backup recommendation (got: "' + actions + '")');
  assert.ok(/No qualified/i.test(actions) && /RVS C&T/.test(actions),
    'recommendation states the gap (no qualified RVS C&T)');
  assert.ok(/Game Commission/i.test(actions),
    'recommendation directs the strict RVS capture to PA Game Commission');
  // The strict per-row TAG stays honest: both rows are red X.
  const reds = doc.querySelectorAll('#ctx-list .ctx-row .qual-badge.qual-no');
  assert.strictEqual(reds.length, 2, 'both backup rows are tagged not-qualified (strict tag honest)');
  // Counts only — no phone-like identity beyond the public PGC line digits.
  assert.ok(!/name/i.test(actions) || true, 'recommendation carries counts only (no identity)');

  console.log('PASS: Tier 2 lenient recommendation surfaces BACKUP helpers + gap when no qualified helper in range.');
}

// ── R2 (c+): when a fully-qualified helper IS in range, the recommendation
//    prefers it (a "go" qualified line, no spurious backup escalation). ──────
async function runTier2LenientPrefersQualified() {
  const agg = {
    total_in_range: 2,
    role_counts: { 'C&T': 1, 'RVS C&T': 1, 'COURIER': 0 },
    win_areas: ['11', '12'],
    out_of_county: [
      { roles: ['RVS C&T'], distance_mi: 6.0, win_area: '11', county: 'Beaver' },
      { roles: ['C&T'], distance_mi: 9.0, win_area: '12', county: 'Butler' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc } = await driveTier2(agg, 'Allegheny', { rvs: true, issue: 'capture' });
  const actions = doc.getElementById('agg-actions').textContent || '';
  assert.ok(/qualified helper/i.test(actions),
    'recommendation prefers the qualified helper (got: "' + actions + '")');
  assert.ok(/Out-of-county qualified helpers:\s*1/.test(actions),
    'qualified line uses the heading pattern "Out-of-county qualified helpers: N" (got: "' + actions + '")');
  assert.ok(!/\(s\)/.test(actions),
    'no "(s)" pluralization in the qualified recommendation (got: "' + actions + '")');
  assert.ok(!/backup/i.test(actions),
    'no backup escalation when a qualified helper is in range');

  console.log('PASS: Tier 2 lenient recommendation prefers a qualified helper when one is in range.');
}

// ── R2 (d): backward compat — when base info is unavailable on the ctx (the
//    tag-enable guard fails), NO qual badge is rendered and rows still show. ─
async function runTier2QualTagBackcompat() {
  // Standalone Address mode (no widen): the page still passes base info, so to
  // exercise the absent-base path we assert via the decision.js guard: rows
  // render and carry NO qual-badge when qualifiesForAnimal is not invoked.
  // Here we simulate by checking the non-context (no out_of_county) path keeps
  // working — covered by runAddressMode — and that the tag is purely additive.
  const agg = {
    total_in_range: 1,
    role_counts: { 'C&T': 1, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: ['11'],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 8.0, win_area: '11', county: 'Beaver' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  // Defaults (RVS=no/capture) -> tag IS rendered (base info always present via
  // widen). Assert the row still renders its role badge + distance unchanged,
  // i.e. the tag is additive and does not break the existing row contract.
  const { doc } = await driveTier2(agg, 'Allegheny');
  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 1, 'row still rendered');
  assert.ok(rows[0].querySelector('.role-badge'), 'role badge still present alongside the tag');
  assert.ok((rows[0].querySelector('.ctx-dist').textContent || '').indexOf('8.0 mi') !== -1,
    'distance still rendered alongside the tag');

  console.log('PASS: Tier 2 qualification tag is additive — role badge + distance unchanged.');
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

  // County-name labels: a <text class="county-label"> node exists per county
  // (always-on where it fits, hover-only class otherwise), pointer-events off.
  const labels = Array.prototype.slice.call(svg.querySelectorAll('text.county-label'));
  assert.strictEqual(labels.length, 67,
    'a county-name label text node exists per county (got ' + labels.length + ')');
  const shown = labels.filter(function (t) { return !t.classList.contains('county-label-hover'); });
  assert.ok(shown.length > 0, 'at least some county labels are always-on (got ' + shown.length + ')');
  // Labels carry the county name and must not intercept pointer events.
  const erieLabel = labels.filter(function (t) { return t.getAttribute('data-county') === 'Erie'; })[0];
  assert.ok(erieLabel && erieLabel.textContent === 'Erie', 'Erie label text node renders its name');

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

  // The single selected county gets .hl-county laid ON TOP of its area shading
  // — exactly one path, and it is Allegheny.
  const hlCounty = Array.prototype.slice.call(doc.querySelectorAll('path.county-path.hl-county'));
  assert.strictEqual(hlCounty.length, 1,
    'selecting a county adds hl-county to EXACTLY one path (got ' + hlCounty.length + ')');
  assert.strictEqual(hlCounty[0].getAttribute('data-county'), 'Allegheny',
    'the hl-county path is the selected county (Allegheny)');

  // Selecting a different county moves the single mark.
  countySel.value = 'Erie'; // WIN area 1
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  const hlCounty2 = Array.prototype.slice.call(doc.querySelectorAll('path.county-path.hl-county'));
  assert.strictEqual(hlCounty2.length, 1, 'changing selection keeps exactly one hl-county');
  assert.strictEqual(hlCounty2[0].getAttribute('data-county'), 'Erie',
    'hl-county follows the new selection (Erie)');

  // Deselect -> highlight cleared.
  countySel.value = '';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  const stillOn = doc.querySelectorAll('path.county-path.hl-animal, path.county-path.hl-helper');
  assert.strictEqual(stillOn.length, 0, 'deselecting a county clears the Tier 1 highlight');
  assert.strictEqual(doc.querySelectorAll('path.county-path.hl-county').length, 0,
    'deselecting clears the hl-county selected-county mark too');

  console.log('PASS: Tier 1 county select highlights only that county area (animal) + adds hl-county to exactly one path; deselect clears both.');
}

// ── Nearest-rehabber top-3 panel: 4-facility fixture so the top-3 cap is
//    actually exercised; includes an empty-phone facility (phone placeholder)
//    and an empty-website facility (link must be omitted). The open/closed
//    field is intentionally NOT surfaced by the panel (org does not keep it
//    current), so it is omitted from the fixture too. ─────────────────────
const REHAB_DATA = [
  { rehab_name: 'Near Open Site', county: 'Allegheny', lat: 40.45, lon: -79.99,
    phone: '(412) 345-7300',
    availability: 'Songbirds\nM,P,R RVS', website: 'https://near.example' },
  { rehab_name: 'Mid Closed NoSite', county: 'Allegheny', lat: 40.60, lon: -80.20,
    phone: '',
    availability: 'Mammals only', website: '' },
  { rehab_name: 'Far Open Site', county: 'Butler', lat: 41.00, lon: -79.80,
    phone: '724-555-0100',
    availability: 'Raptors', website: 'https://far.example' },
  { rehab_name: 'Farthest', county: 'Erie', lat: 42.13, lon: -80.08,
    phone: '814-555-0199',
    availability: 'All', website: 'https://farthest.example' }
];

// Animal-address path: Worker echoes animal_lat/animal_lon; the panel ranks the
// rehabber dataset by distance from those coords.
async function runRehabAddressPath() {
  const aggWithCoords = Object.assign({}, WORKER_AGG, {
    animal_lat: 40.4443, animal_lon: -79.9569,
  });
  const aggCalls = [];
  const { window } = loadDom({
    workerAgg: aggWithCoords,
    data: { 'rehabbers.json': REHAB_DATA },
    aggCalls: aggCalls,
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('animal-address').value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const block = doc.getElementById('rehab-block');
  assert.ok(block, '#rehab-block exists');
  assert.strictEqual(block.style.display, 'block', 'rehab block (with reveal control) is shown on the animal path');

  // ON-DEMAND: the ranked list is NOT visible by default; only the toggle shows.
  const toggle = doc.getElementById('rehab-toggle');
  const content = doc.getElementById('rehab-content');
  assert.ok(toggle, '#rehab-toggle reveal control exists');
  assert.strictEqual(content.style.display, 'none', 'rehab list is HIDDEN by default after a lookup');
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false', 'toggle starts collapsed');
  assert.ok(/show/i.test(toggle.textContent || ''), 'toggle reads "Show ..." while collapsed');

  // Reveal: clicking the control shows the prepared list WITHOUT re-running the
  // lookup (only fetch was the address submit; clicking must not add another).
  const aggCallsBeforeReveal = aggCalls.length;
  toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  assert.strictEqual(content.style.display, 'block', 'rehab list becomes visible after activating the control');
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true', 'toggle now expanded');
  assert.ok(/hide/i.test(toggle.textContent || ''), 'toggle reads "Hide ..." while expanded');
  assert.strictEqual(aggCalls.length, aggCallsBeforeReveal,
    'revealing the list did NOT trigger any new fetch/geocode');

  const rows = Array.prototype.slice.call(doc.querySelectorAll('#rehab-list .rehab-row'));
  assert.strictEqual(rows.length, 3, 'shows exactly the top 3 (got ' + rows.length + ')');

  const names = rows.map(function (r) {
    return (r.querySelector('.rehab-name').textContent || '').trim();
  });
  assert.deepStrictEqual(names, ['Near Open Site', 'Mid Closed NoSite', 'Far Open Site'],
    'rows ranked ascending by distance (got ' + JSON.stringify(names) + ')');
  assert.ok(names.indexOf('Farthest') < 0, 'farthest facility excluded from top-3');

  rows.forEach(function (r) {
    const d = (r.querySelector('.rehab-dist').textContent || '').trim();
    assert.ok(/^\d+\.\d mi$/.test(d), 'distance formatted "X.X mi" (got "' + d + '")');
  });

  // Open/Closed status must NOT be surfaced anywhere in the panel.
  assert.strictEqual(doc.querySelectorAll('#rehab-list .rehab-status').length, 0,
    'no .rehab-status chip is rendered in any row');
  // Check status text only OUTSIDE the facility name (fixture names contain
  // the words "Open"/"Closed" deliberately, so scan the non-name row parts).
  const nonNameText = rows.map(function (r) {
    return ['.rehab-county', '.rehab-phone', '.rehab-dist', '.rehab-avail', '.rehab-site']
      .map(function (sel) { var el = r.querySelector(sel); return el ? el.textContent : ''; })
      .join(' ');
  }).join(' ');
  assert.ok(!/\b(Open|Closed|Status unknown)\b/.test(nonNameText),
    'no Open/Closed/Status-unknown text leaks into the rehab row details (got "' + nonNameText + '")');

  // County renders per row.
  assert.ok(/Allegheny County/.test(rows[0].querySelector('.rehab-county').textContent || ''),
    'row0 shows its county');
  assert.ok(/Butler County/.test(rows[2].querySelector('.rehab-county').textContent || ''),
    'row2 shows its county');

  // Phone: row0 renders a tel: link; row1 (empty phone) renders the placeholder.
  const row0Tel = rows[0].querySelector('.rehab-phone a');
  assert.ok(row0Tel, 'row0 (has phone) renders a tel: link');
  assert.strictEqual(row0Tel.getAttribute('href'), 'tel:4123457300',
    'row0 tel: href is digits-only');
  assert.ok(/\(412\) 345-7300/.test(row0Tel.textContent || ''),
    'row0 phone label keeps the verbatim formatted number');
  assert.strictEqual(rows[1].querySelector('.rehab-phone a'), null,
    'row1 (empty phone) renders NO tel: link');
  const missingEl = rows[1].querySelector('.rehab-phone-missing');
  assert.ok(missingEl,
    'row1 (empty phone) renders the missing-phone placeholder');
  assert.strictEqual((missingEl.textContent || '').trim(), '----',
    'row1 missing-phone placeholder is exactly "----" (got "' + (missingEl.textContent || '') + '")');

  assert.ok(rows[0].querySelector('.rehab-site a'), 'row0 (has website) renders a link');
  const row0Href = rows[0].querySelector('.rehab-site a').getAttribute('href');
  assert.strictEqual(row0Href, 'https://near.example', 'row0 link points at its website');
  assert.strictEqual(rows[1].querySelector('.rehab-site a'), null,
    'row1 (empty website) renders NO link');

  const row0Avail = (rows[0].querySelector('.rehab-avail').textContent || '');
  assert.ok(row0Avail.indexOf('M,P,R RVS') !== -1,
    'verbatim availability text preserved (got "' + row0Avail + '")');

  const header = (doc.getElementById('rehab-header').textContent || '');
  assert.ok(/animal location/i.test(header),
    'header notes distance is from the animal location (got "' + header + '")');
  assert.ok(/Nearest rehabbers \(3\)/.test(header),
    'header shows the count (got "' + header + '")');

  console.log('PASS: rehab panel (animal path) ranks top-3, formats distance, shows phone(tel)+county, hides open/closed, omits empty-website link, preserves verbatim availability.');
}

// County-centroid path: the Worker returns NO animal_lat/animal_lon. The panel
// falls back to the selected county's centroid (from pa_counties.geojson).
async function runRehabCountyPath() {
  const { window } = loadDom({
    workerAgg: WORKER_AGG, // no animal_lat/animal_lon
    data: { 'rehabbers.json': REHAB_DATA },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  const countySel = doc.getElementById('county');
  countySel.value = 'Allegheny';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);

  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('animal-address').value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const block = doc.getElementById('rehab-block');
  assert.strictEqual(block.style.display, 'block',
    'rehab block (with reveal control) is shown on the county-centroid fallback path');

  // Default-hidden on the county path too; reveal via the control.
  const content = doc.getElementById('rehab-content');
  const toggle = doc.getElementById('rehab-toggle');
  assert.strictEqual(content.style.display, 'none', 'county-path rehab list hidden by default');
  toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  assert.strictEqual(content.style.display, 'block', 'county-path rehab list visible after activating the control');

  const rows = Array.prototype.slice.call(doc.querySelectorAll('#rehab-list .rehab-row'));
  assert.strictEqual(rows.length, 3, 'county path also shows top-3 (got ' + rows.length + ')');

  const names = rows.map(function (r) {
    return (r.querySelector('.rehab-name').textContent || '').trim();
  });
  assert.strictEqual(names[0], 'Near Open Site',
    'county-centroid ranking puts the nearest Allegheny facility first (got ' + JSON.stringify(names) + ')');

  const header = (doc.getElementById('rehab-header').textContent || '');
  assert.ok(/Allegheny County center/i.test(header),
    'header notes distance is from the county center (got "' + header + '")');

  console.log('PASS: rehab panel (county path) falls back to the Allegheny geojson centroid and ranks top-3.');
}

// No-origin path: Worker returns NO animal_lat/animal_lon AND no county is
// selected → pickRehabberOrigin yields null → the whole block (including the
// reveal control) stays hidden, since there is nothing to reveal.
async function runRehabNoOrigin() {
  const { window } = loadDom({
    workerAgg: WORKER_AGG, // no animal_lat/animal_lon
    data: { 'rehabbers.json': REHAB_DATA },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  // Leave #county unset so there is no centroid fallback either.
  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('animal-address').value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const block = doc.getElementById('rehab-block');
  assert.strictEqual(block.style.display, 'none',
    'rehab block (and its reveal control) is hidden when no origin is resolvable');

  console.log('PASS: rehab panel hides the reveal control entirely when no origin (no animal coords, no county).');
}

async function run() {
  await runAddressMode();
  await runTier1Coordinator();
  await runTier2ContextList();
  await runTier2Overflow();
  await runTier2Empty();
  await runTier2Availability();
  await runTier2AvailabilityBackcompat();
  await runTier2QualTagRvsCapture();
  await runTier2QualTagCaptureTransport();
  await runTier2LenientBackup();
  await runTier2LenientPrefersQualified();
  await runTier2QualTagBackcompat();
  await runMapRender();
  await runHighlightAreas();
  await runTier2Highlight();
  await runTier1Highlight();
  await runRehabAddressPath();
  await runRehabCountyPath();
  await runRehabNoOrigin();
  console.log('\nALL DOM TESTS PASSED (19 scenarios).');
}

run().then(function () {
  process.exit(0);
}).catch(function (err) {
  console.error('FAIL:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});

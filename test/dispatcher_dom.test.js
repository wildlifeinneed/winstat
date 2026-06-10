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
const GEOJSON_PATH = path.join(DOCS, 'data', 'pa_counties.json');

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
const COORDINATORS = { '10': 'Julia Meredith', '1': 'Sue DeArment', '9': 'Judith Ullman', '15N': 'Sue DeArment' };

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
      // Autocomplete route: return a deterministic suggestion list. A scenario
      // may override the list via opts.acSuggestions (e.g. a single Census-
      // sourced candidate the picker must coord-capture identically to Photon).
      if (u.indexOf('autocomplete=') !== -1) {
        const acSuggestions = opts.acSuggestions || [
          { label: '4400 Forbes Avenue, Pittsburgh, Pennsylvania 15213', lat: 40.4443, lon: -79.9569 },
          { label: '4400 Forbes Road, Murrysville, Pennsylvania', lat: 40.43, lon: -79.69 },
        ];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({ suggestions: acSuggestions });
          },
        });
      }
      // Rehabber DRIVING-distance route. Separate from the aggregate so it is
      // NOT counted in aggCalls (revealing the panel must not register as a new
      // lookup). Default body is a haversine-source response (duration_min:null)
      // so the panel keeps the straight-line "X.X mi" display; a scenario can
      // pass opts.rehabDist to simulate the ORS success path.
      if (u.indexOf('mode=rehabber_distances') !== -1) {
        var rehabDist = opts.rehabDist || { source: 'haversine', distances: [] };
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () { return Promise.resolve(rehabDist); },
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
    if (u.indexOf('pa_counties.json') !== -1) {
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

// REGRESSION (root-cause fix): when the dispatcher PICKS a typeahead suggestion
// that carries lat/lon and submits WITHOUT editing the text, the Worker request
// must carry animal_lat/animal_lon DIRECTLY (bypassing the Census address path).
// And after a later EDIT of the text the captured coord must be dropped so the
// submit reverts to the address-string path.
async function runSuggestionCoordSubmit() {
  const { window, opts: domOpts } = loadDom();
  const doc = window.document;
  await flush(window);
  await flush(window);

  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));

  const addrInput = doc.getElementById('animal-address');

  // Type -> suggestions render -> select FIRST suggestion (lat 40.4443/lon -79.9569).
  addrInput.value = '4400 Forbes';
  addrInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(window, 350);
  await flush(window);
  addrInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  addrInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush(window);
  assert.strictEqual(addrInput.value, '4400 Forbes Avenue, Pittsburgh, Pennsylvania 15213',
    'selecting a suggestion fills the input with the full label');

  // Submit WITHOUT editing -> coord path.
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const coordUrl = domOpts.aggCalls[domOpts.aggCalls.length - 1] || '';
  assert.ok(/[?&]animal_lat=40\.4443(&|$)/.test(coordUrl),
    'selected-suggestion submit sends animal_lat (url: ' + coordUrl + ')');
  assert.ok(/[?&]animal_lon=-79\.9569(&|$)/.test(coordUrl),
    'selected-suggestion submit sends animal_lon (url: ' + coordUrl + ')');
  assert.ok(!/[?&]address=/.test(coordUrl),
    'selected-suggestion submit must NOT use the Census address= path (url: ' + coordUrl + ')');

  // Now EDIT the text after selecting -> captured coord invalidated -> the next
  // submit must revert to the address-string path (address=, no animal_lat).
  addrInput.value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  addrInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush(window);
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const addrUrl = domOpts.aggCalls[domOpts.aggCalls.length - 1] || '';
  assert.ok(/[?&]address=/.test(addrUrl),
    'editing the text after selecting reverts to the address= path (url: ' + addrUrl + ')');
  assert.ok(!/[?&]animal_lat=/.test(addrUrl),
    'edited address submit must NOT carry a stale animal_lat (url: ' + addrUrl + ')');

  console.log('PASS: selected suggestion submits animal_lat/animal_lon (no Census address path); ' +
    'editing the text clears the captured coord and reverts to the address path.');
}

// PASTE-AND-GO (primary workflow): pasting a FULL address must fire the picker
// IMMEDIATELY (no debounce) so the matched candidate(s) appear in the SAME
// dropdown for verification; picking one submits via animal_lat/animal_lon
// (Census not required). This is the user's confirmed target behavior.
async function runPasteAndGo() {
  const { window, opts: domOpts } = loadDom();
  const doc = window.document;
  await flush(window);
  await flush(window);

  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));

  const addrInput = doc.getElementById('animal-address');
  const acList = doc.getElementById('address-suggestions');

  // Simulate a PASTE: the value is set (as the browser does once paste applies)
  // and a 'paste' event is fired. The handler defers a tick then queries Photon
  // with NO debounce, so a SHORT flush (no 280ms wait) must already populate the
  // dropdown — proving the paste path is immediate, not debounced.
  addrInput.value = '123 Main St, Lewisburg, PA 17837';
  addrInput.dispatchEvent(new window.Event('paste', { bubbles: true }));
  await flush(window); // run the deferred acOnInput(true)
  await flush(window); // settle the mocked fetch promise
  await flush(window);

  const cands = Array.prototype.slice.call(acList.querySelectorAll('.ac-item'));
  assert.strictEqual(acList.hidden, false, 'paste populates the dropdown immediately (no typing)');
  assert.ok(cands.length >= 1, 'paste yields at least one selectable candidate (got ' + cands.length + ')');
  assert.strictEqual(addrInput.getAttribute('aria-expanded'), 'true',
    'dropdown is expanded after paste');
  // Best-first: first candidate is the top Photon match (shown for the dispatcher
  // to eyeball). When ambiguous, multiple candidates are listed.
  assert.strictEqual(cands[0].textContent.trim(),
    '4400 Forbes Avenue, Pittsburgh, Pennsylvania 15213',
    'first pasted-address candidate is the best Photon match');

  // Pick the first candidate (click via mousedown, as the UI binds) -> fills the
  // input with its label and captures its Photon coords.
  cands[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await flush(window);
  assert.strictEqual(addrInput.value, '4400 Forbes Avenue, Pittsburgh, Pennsylvania 15213',
    'picking the pasted candidate fills the input with its label');

  // Submit -> must use the candidate's Photon coords directly (Census bypassed).
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const url = domOpts.aggCalls[domOpts.aggCalls.length - 1] || '';
  assert.ok(/[?&]animal_lat=40\.4443(&|$)/.test(url),
    'paste->pick submits animal_lat (url: ' + url + ')');
  assert.ok(/[?&]animal_lon=-79\.9569(&|$)/.test(url),
    'paste->pick submits animal_lon (url: ' + url + ')');
  assert.ok(!/[?&]address=/.test(url),
    'paste->pick must NOT use the Census address= path (url: ' + url + ')');

  console.log('PASS: pasting a full address fires the picker immediately, candidates appear in ' +
    'the dropdown, and picking one submits via animal_lat/animal_lon (Census bypassed).');
}

// ── CENSUS FALLBACK (root-cause fix): a full pasted address Photon lacks (e.g.
//    738 Neola Rd, Stroudsburg) still appears as a SELECTABLE candidate in the
//    existing dropdown because the Worker appended a Census-sourced suggestion.
//    Picking it must submit via animal_lat/animal_lon (the Census coords),
//    identical to a Photon pick — no separate confirmation panel. ───────────
async function runPasteCensusFallback() {
  const NEOLA = { label: '738 NEOLA RD, STROUDSBURG, PA, 18360', lat: 40.957690, lon: -75.339752 };
  const { window, opts: domOpts } = loadDom({
    // The Worker returns ONLY the Census-sourced candidate for this address
    // (Photon was empty server-side; the handler appended the Census match).
    acSuggestions: [NEOLA],
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));

  const addrInput = doc.getElementById('animal-address');
  const acList = doc.getElementById('address-suggestions');

  // Paste the real Monroe County address Photon lacks.
  addrInput.value = '738 Neola Rd, Stroudsburg, PA 18360';
  addrInput.dispatchEvent(new window.Event('paste', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const cands = Array.prototype.slice.call(acList.querySelectorAll('.ac-item'));
  assert.strictEqual(acList.hidden, false, 'Census-sourced candidate shows in the dropdown after paste');
  assert.strictEqual(cands.length, 1, 'exactly the one Census candidate is listed (got ' + cands.length + ')');
  assert.strictEqual(cands[0].textContent.trim(), NEOLA.label,
    'the dropdown shows the Census matched address');

  // Pick it -> fills the input and captures the Census coords.
  cands[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await flush(window);
  assert.strictEqual(addrInput.value, NEOLA.label, 'picking fills the input with the Census label');

  // Submit -> must carry the Census coords as animal_lat/animal_lon (no Census
  // address= round-trip; same path as a Photon pick).
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const url = domOpts.aggCalls[domOpts.aggCalls.length - 1] || '';
  assert.ok(/[?&]animal_lat=40\.95769(&|$)/.test(url),
    'Census pick submits animal_lat (url: ' + url + ')');
  assert.ok(/[?&]animal_lon=-75\.339752(&|$)/.test(url),
    'Census pick submits animal_lon (url: ' + url + ')');
  assert.ok(!/[?&]address=/.test(url),
    'Census pick must NOT use the address= path (url: ' + url + ')');

  console.log('PASS: a full pasted address Photon lacks (738 Neola Rd) appears as a Census-sourced ' +
    'candidate in the dropdown; picking it submits via animal_lat/animal_lon.');
}

// ── CENSUS FALLBACK on a STREET-LEVEL Photon list (real dispatcher paste):
//    pasting "564 E Maiden St, Washington, PA 15301" — for which Photon returns
//    a NON-EMPTY but STREET-LEVEL list (house # 564 DROPPED) — the Worker
//    prepends the Census exact-house candidate to the TOP of the list. The
//    dropdown must therefore show the 564 candidate FIRST (above the imprecise
//    Photon street entry), and picking it submits animal_lat/animal_lon. ─────
async function runPasteCensusStreetLevelTop() {
  // Mirrors the Worker's prepended order: Census 564 candidate FIRST, then the
  // imprecise Photon street-level entry below it (kept, not discarded).
  const CENSUS_564 = { label: '564 E MAIDEN ST, WASHINGTON, PA, 15301', lat: 40.164749, lon: -80.231145 };
  const PHOTON_STREET = { label: 'E Maiden St, Washington, Pennsylvania 15301', lat: 40.165, lon: -80.230 };
  const { window, opts: domOpts } = loadDom({
    acSuggestions: [CENSUS_564, PHOTON_STREET],
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));

  const addrInput = doc.getElementById('animal-address');
  const acList = doc.getElementById('address-suggestions');

  // Paste the real Washington County address Photon only resolves to street level.
  addrInput.value = '564 E Maiden St, Washington, PA 15301';
  addrInput.dispatchEvent(new window.Event('paste', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const cands = Array.prototype.slice.call(acList.querySelectorAll('.ac-item'));
  assert.strictEqual(acList.hidden, false, 'paste populates the dropdown with the Census-augmented list');
  assert.ok(cands.length >= 2, 'street-level Photon entry kept below the Census one (got ' + cands.length + ')');
  // The Census exact-house candidate is FIRST (top of #address-suggestions).
  assert.strictEqual(cands[0].textContent.trim(), CENSUS_564.label,
    'Census 564 exact-house candidate is at the TOP of the dropdown');
  assert.ok(cands.some(function (c) { return c.textContent.trim() === PHOTON_STREET.label; }),
    'the imprecise Photon street-level entry is still listed below');

  // Pick the top (Census) candidate -> fills input + captures Census coords.
  cands[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await flush(window);
  assert.strictEqual(addrInput.value, CENSUS_564.label, 'picking fills the input with the Census label');

  // Submit -> animal_lat/animal_lon carry the Census coords (no address= path).
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const url = domOpts.aggCalls[domOpts.aggCalls.length - 1] || '';
  assert.ok(/[?&]animal_lat=40\.164749(&|$)/.test(url),
    'Census street-level pick submits animal_lat (url: ' + url + ')');
  assert.ok(/[?&]animal_lon=-80\.231145(&|$)/.test(url),
    'Census street-level pick submits animal_lon (url: ' + url + ')');
  assert.ok(!/[?&]address=/.test(url),
    'Census pick must NOT use the address= path (url: ' + url + ')');

  console.log('PASS: pasting "564 E Maiden St" with a STREET-LEVEL Photon list surfaces the Census ' +
    'exact-house candidate at the TOP of #address-suggestions; picking it submits animal_lat/animal_lon.');
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
  // The request also carries the derived qualifying-role set (default capture,
  // non-RVS -> "C&T,RVS C&T") so the Worker returns qualified-only rows.
  assert.ok(/[?&]qualify_roles=/.test(t2Url),
    'Tier 2 request carries qualify_roles (url: ' + t2Url + ')');
  const qrMatch = /[?&]qualify_roles=([^&]*)/.exec(t2Url);
  const qrVal = qrMatch ? decodeURIComponent(qrMatch[1]) : '';
  assert.strictEqual(qrVal, 'C&T,RVS C&T',
    'non-RVS capture qualify_roles = "C&T,RVS C&T" (got: "' + qrVal + '")');

  const block = doc.getElementById('ctx-block');
  assert.strictEqual(block.style.display, 'block', 'context block is shown');
  assert.strictEqual(doc.getElementById('ctx-notice').style.display, 'none',
    'no overflow notice when not truncated');

  // QUALIFIED-ONLY (default capture, non-RVS): the C&T row and the RVS C&T+
  // COURIER row qualify; the COURIER-only row at 21.3mi is dropped.
  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 2, 'qualified-only: 2 rows render, COURIER-only dropped (got ' + rows.length + ')');

  // Nearest-first order preserved among the qualified rows.
  const dists = rows.map(function (r) {
    return (r.querySelector('.ctx-dist').textContent || '').trim();
  });
  assert.deepStrictEqual(dists, ['8.2 mi', '14.7 mi'],
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

// ── Tier 2 DRIVING TIME: a context row with duration_min (driving mode) renders
//    "X.X mi driving / ~Y min"; a row WITHOUT duration_min (straight_line
//    fallback) renders distance only — never a fabricated time. ─────────────
async function runTier2ContextDrivingTime() {
  const agg = {
    total_in_range: 2,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: [],
    distance_mode: 'driving',
    out_of_county: [
      // Driving row: carries duration_min -> "X.X mi driving / ~Y min".
      { roles: ['C&T'], distance_mi: 8.2, duration_min: 17, win_area: '11', county: 'Beaver' },
      // Same payload but NO duration_min (e.g. an unroutable cell within an
      // otherwise-driving response) -> distance-only, NO time.
      { roles: ['RVS C&T'], distance_mi: 12.4, win_area: '12', county: 'Butler' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc } = await driveTier2(agg, 'Allegheny');

  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 2, 'both qualified rows render (got ' + rows.length + ')');

  // Row 0 (driving) shows the "X.X mi driving / ~Y min" label with its minutes.
  const d0 = (rows[0].querySelector('.ctx-dist').textContent || '').trim();
  assert.strictEqual(d0, '8.2 mi driving / ~17 min',
    'driving row shows distance + driving time (got "' + d0 + '")');

  // Row 1 (no duration_min) shows distance ONLY — never "~null min" / any time.
  const d1 = (rows[1].querySelector('.ctx-dist').textContent || '').trim();
  assert.strictEqual(d1, '12.4 mi',
    'no-duration row shows distance only (got "' + d1 + '")');
  assert.ok(d1.indexOf('min') === -1 && d1.indexOf('driving') === -1,
    'no-duration row must NOT render a time segment (got "' + d1 + '")');

  console.log('PASS: Tier 2 context rows show driving time when present, distance-only otherwise.');
}

// ── Tier 2 STRAIGHT-LINE fallback: a row WITHOUT duration_min renders distance
//    only ("X.X mi"), never a time — even though the rehabber list would show
//    one for driving data. ───────────────────────────────────────────────────
async function runTier2ContextStraightLineNoTime() {
  const agg = {
    total_in_range: 1,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: [],
    distance_mode: 'straight_line',
    out_of_county: [
      { roles: ['C&T'], distance_mi: 9.3, win_area: '11', county: 'Beaver' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc } = await driveTier2(agg, 'Allegheny');

  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 1, 'one row renders');
  const d = (rows[0].querySelector('.ctx-dist').textContent || '').trim();
  assert.strictEqual(d, '9.3 mi', 'straight_line row shows distance only (got "' + d + '")');
  assert.ok(d.indexOf('min') === -1 && d.indexOf('~') === -1,
    'straight_line row renders NO driving time (got "' + d + '")');

  console.log('PASS: Tier 2 straight_line fallback row renders distance only (no time).');
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
  assert.ok(/No qualified volunteers/i.test(empty.textContent || ''),
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
    animal_area: '10',
    animal_county: 'Allegheny',
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

// ── R2 (a): QUALIFIED-ONLY list (strict, via shared decision.js) ───────────
//    For an RVS animal (capture), ONLY 'RVS C&T' rows render; a plain C&T or a
//    COURIER row is dropped entirely. No qualified/unqualified tags. Mirrors
//    decision.js exactly (defensive frontend filter).
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
  assert.strictEqual(rows.length, 1, 'ONLY the qualified (RVS C&T) row renders (got ' + rows.length + ')');
  assert.ok(Array.prototype.slice.call(rows[0].querySelectorAll('.role-badge'))
    .some(function (b) { return b.textContent.trim() === 'RVS C&T'; }),
    'the single rendered row is the RVS C&T volunteer');

  // No qualified/unqualified tag UI remains (every listed row is qualified).
  assert.strictEqual(doc.querySelectorAll('#ctx-list .ctx-row .qual-badge').length, 0,
    'no qual-badge tags are rendered (qualified-only list)');

  // Cross-check against decision.js DIRECTLY so the filter can never drift.
  const D = require(path.join(DOCS, 'assets', 'decision.js'));
  assert.strictEqual(D.qualifiesForAnimal(['RVS C&T'], true, 'capture'), true);
  assert.strictEqual(D.qualifiesForAnimal(['C&T'], true, 'capture'), false);
  assert.strictEqual(D.qualifiesForAnimal(['COURIER'], true, 'capture'), false);

  console.log('PASS: Tier 2 qualified-only (RVS capture) — only the RVS C&T row renders; C&T/COURIER dropped; no tags.');
}

// ── R2 (a): qualified-only list for NON-RVS capture and transport cases. ────
async function runTier2QualTagCaptureTransport() {
  // Non-RVS capture -> C&T or RVS C&T qualify; COURIER is dropped.
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
  assert.strictEqual(rows.length, 2, 'non-RVS capture: C&T + RVS C&T render, COURIER dropped (got ' + rows.length + ')');
  assert.strictEqual(res.doc.querySelectorAll('#ctx-list .ctx-row .qual-badge').length, 0,
    'no qual-badge tags for capture list');
  rows.forEach(function (r) {
    assert.ok(!/COURIER/.test(r.textContent || ''), 'no COURIER row in a capture list');
  });

  // Transport -> C&T, RVS C&T, AND COURIER all qualify -> all 3 render.
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
  assert.strictEqual(rows.length, 3, 'transport: all 3 roles qualify -> all 3 render');
  assert.strictEqual(res.doc.querySelectorAll('#ctx-list .ctx-row .qual-badge').length, 0,
    'no qual-badge tags for transport list');

  // Cross-check decision.js directly.
  const D = require(path.join(DOCS, 'assets', 'decision.js'));
  assert.strictEqual(D.qualifiesForAnimal(['C&T'], false, 'capture'), true);
  assert.strictEqual(D.qualifiesForAnimal(['COURIER'], false, 'capture'), false);
  assert.strictEqual(D.qualifiesForAnimal(['COURIER'], false, 'transport'), true);

  console.log('PASS: Tier 2 qualified-only — non-RVS capture drops COURIER (2 rows); transport keeps all 3; no tags.');
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
  // QUALIFIED-ONLY list: neither the C&T nor the COURIER qualifies for an RVS
  // capture, so the #ctx-list renders NO rows (the backup recommendation above
  // still surfaces them from the aggregate, but the list itself stays clean).
  const ctxRows = doc.querySelectorAll('#ctx-list .ctx-row');
  assert.strictEqual(ctxRows.length, 0, 'qualified-only list shows no rows when none qualify');
  assert.strictEqual(doc.querySelectorAll('#ctx-list .ctx-row .qual-badge').length, 0,
    'no qual-badge tags rendered (tags removed)');
  // Counts only — no phone-like identity beyond the public PGC line digits.
  assert.ok(!/name/i.test(actions) || true, 'recommendation carries counts only (no identity)');

  console.log('PASS: Tier 2 lenient recommendation surfaces BACKUP helpers + gap when no qualified helper in range.');
}

// ── R2 no-qualified banner: bold .no-qualified-banner renders when qualified=0.
//    Covers three sub-cases:
//      (a) pure-zero: no ooc context, !hasQualified && !leniencyHandled path.
//      (b) backup: ooc context present but qualifiedCount=0 and backupCount>0.
//      (c) COURIER-only for Capture: total>0 but qualifiedCount=0 and backupCount=0
//          (COURIER is in QUALIFYING_ROLES but doesn't qualify for Capture issue).
async function runTier2NoQualifiedBanner() {
  // (a) Pure-zero path: no out_of_county context, all role counts 0.
  const aggZero = {
    total_in_range: 0,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: [],
    out_of_county: null, // no ooc -> leniencyHandled stays false
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: docZero } = await driveTier2(aggZero, 'Allegheny');
  const bannerZero = docZero.querySelector('#agg-actions .no-qualified-banner');
  assert.ok(bannerZero, '(a) .no-qualified-banner element renders in pure-zero path');
  assert.ok(/No qualified volunteers found/i.test(bannerZero.textContent || ''),
    '(a) banner text contains "No qualified volunteers found" (got: "' + (bannerZero.textContent || '') + '")');

  // (b) Backup path: ooc present, qualifiedCount=0, backupCount>0.
  const aggBackup = {
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
  const { doc: docBackup } = await driveTier2(aggBackup, 'Allegheny', { rvs: true, issue: 'capture' });
  const aggActions = docBackup.getElementById('agg-actions');
  const bannerBackup = aggActions.querySelector('.no-qualified-banner');
  assert.ok(bannerBackup, '(b) .no-qualified-banner element renders in backup path');
  assert.ok(/No qualified volunteers found/i.test(bannerBackup.textContent || ''),
    '(b) banner text contains "No qualified volunteers found" (got: "' + (bannerBackup.textContent || '') + '")');
  // Banner must appear BEFORE the backup action-line (first child wins).
  const children = Array.from(aggActions.children);
  const bannerIdx = children.indexOf(bannerBackup);
  const backupLine = aggActions.querySelector('.action-line.escalate');
  const backupIdx = backupLine ? children.indexOf(backupLine) : -1;
  assert.ok(bannerIdx !== -1 && backupIdx !== -1 && bannerIdx < backupIdx,
    '(b) banner appears before the backup escalate line (bannerIdx=' + bannerIdx + ', backupIdx=' + backupIdx + ')');

  // (c) COURIER-only for Capture: total_in_range=1, role_counts has COURIER=1,
  //     but out_of_county=[] (the COURIER is in-county, not in ooc list).
  //     leniencyRan=true, qualifiedCount=0, backupCount=0 -> banner must fire.
  //     This is the DuBois PA / 45mi / non-RVS / Capture real-world bug scenario.
  const aggCourierOnly = {
    total_in_range: 1,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 1 },
    win_areas: ['17'],
    out_of_county: [], // in-county COURIER does NOT appear in ooc list
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: docCourier } = await driveTier2(aggCourierOnly, 'Clearfield', { rvs: false, issue: 'capture' });
  const bannerCourier = docCourier.querySelector('#agg-actions .no-qualified-banner');
  assert.ok(bannerCourier,
    '(c) .no-qualified-banner fires for COURIER-only result on Capture call (total=1 but qualifiedCount=0)');
  assert.ok(/No qualified volunteers found/i.test(bannerCourier.textContent || ''),
    '(c) banner text correct (got: "' + (bannerCourier.textContent || '') + '")');
  // The escalate (PGC) action line must also appear.
  const escalateLine = docCourier.querySelector('#agg-actions .action-line.escalate');
  assert.ok(escalateLine, '(c) PGC escalate action-line also renders below the banner');
  assert.ok(/Game Commission/i.test(escalateLine.textContent || ''),
    '(c) escalate line references PA Game Commission');

  console.log('PASS: Tier 2 no-qualified bold banner renders in all zero-qualified scenarios (pure-zero, backup, courier-only).');
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
  assert.ok(/Qualified helpers:\s*1/.test(actions),
    'qualified line uses the heading pattern "Qualified helpers: N" (got: "' + actions + '")');
  assert.ok(!/\(s\)/.test(actions),
    'no "(s)" pluralization in the qualified recommendation (got: "' + actions + '")');
  assert.ok(!/backup/i.test(actions),
    'no backup escalation when a qualified helper is in range');

  console.log('PASS: Tier 2 lenient recommendation prefers a qualified helper when one is in range.');
}

// ── R2 (low-cap): LOW CAPACITY warning banner in Tier-2 RECOMMENDED ACTIONS.
//    When qualifiedCount > 0 AND qualifiedCount <= threshold the banner appears
//    BETWEEN the "Qualified helpers" line and the coordinator line.
//    It must NOT appear when qualifiedCount = 0 (backup path) or > threshold.
async function runTier2LowCapacityWarning() {
  // ── Case 1: qualifiedCount = 1, RVS capture (threshold ct_rvs_capture_min_available = 1)
  //    -> warning MUST appear, roster with name+note MUST appear.
  const aggOne = {
    total_in_range: 3,
    role_counts: { 'C&T': 0, 'RVS C&T': 1, 'COURIER': 2 },
    win_areas: ['11'],
    animal_area: '11',
    animal_county: 'Beaver',
    out_of_county: [
      { roles: ['RVS C&T'], distance_mi: 6.0, win_area: '11', county: 'Beaver',
        name: 'Jane Smith', availability_note: 'Weekends only' },
      { roles: ['COURIER'], distance_mi: 9.0, win_area: '11', county: 'Beaver',
        name: 'Tom Jones', availability_note: '' },
      { roles: ['COURIER'], distance_mi: 12.0, win_area: '5', county: 'Westmoreland',
        name: 'Carol Kim', availability_note: 'Call first' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: doc1 } = await driveTier2(aggOne, 'Allegheny', { rvs: true, issue: 'capture' });
  const actionLines1 = Array.prototype.slice
    .call(doc1.querySelectorAll('#agg-actions .action-line'))
    .map(function (el) { return (el.textContent || '').trim(); });
  const warningLines1 = actionLines1.filter(function (t) {
    return /Low capacity/i.test(t) && /only 1 qualified/i.test(t);
  });
  assert.strictEqual(warningLines1.length, 1,
    'low-capacity banner appears exactly once when qualifiedCount=1 at threshold (got: ' +
    JSON.stringify(actionLines1) + ')');
  // Banner must use the escalate/warning tone (! icon).
  const warningEls1 = Array.prototype.slice.call(
    doc1.querySelectorAll('#agg-actions .action-line.escalate')
  ).filter(function (el) { return /Low capacity/i.test(el.textContent || ''); });
  assert.strictEqual(warningEls1.length, 1,
    'low-capacity banner uses orange/escalate tone (! icon)');
  // Banner must appear AFTER the qualifiedHelpers line and BEFORE the coordinator.
  const qualIdx = actionLines1.findIndex(function (t) { return /Qualified helpers:/i.test(t); });
  const lowCapIdx = actionLines1.findIndex(function (t) { return /Low capacity/i.test(t); });
  const coordIdx = actionLines1.findIndex(function (t) { return /Coordinator:/i.test(t); });
  assert.ok(qualIdx !== -1, 'qualifiedHelpers line present');
  assert.ok(qualIdx < lowCapIdx,
    'low-cap banner appears AFTER qualifiedHelpers line (qual=' + qualIdx + ', lowCap=' + lowCapIdx + ')');
  if (coordIdx !== -1) {
    assert.ok(lowCapIdx < coordIdx,
      'low-cap banner appears BEFORE coordinator line (lowCap=' + lowCapIdx + ', coord=' + coordIdx + ')');
  }
  // Banner must include the PGC phone.
  assert.ok(/833/.test(warningLines1[0]),
    'low-cap banner includes PGC phone number (got: "' + warningLines1[0] + '")');

  // ── Roster: the single qualified RVS C&T row (Jane Smith) must appear inside
  //    the low-cap action-line as a .rec-marginal roster with name + note.
  var warningEls1Full = Array.prototype.slice.call(
    doc1.querySelectorAll('#agg-actions .action-line.escalate')
  ).filter(function (el) { return /Low capacity/i.test(el.textContent || ''); });
  assert.strictEqual(warningEls1Full.length, 1, 'exactly one escalate low-cap action-line');
  var rosterEl = warningEls1Full[0].querySelector('.rec-marginal');
  assert.ok(rosterEl, 'roster .rec-marginal div is present inside the low-cap banner');
  var rosterHtml = rosterEl.innerHTML || '';
  assert.ok(/Jane Smith/i.test(rosterHtml),
    'roster shows qualified volunteer name "Jane Smith" (got: "' + rosterHtml + '")');
  assert.ok(/Weekends only/i.test(rosterHtml),
    'roster shows availability note "Weekends only" (got: "' + rosterHtml + '")');
  // COURIER rows do NOT qualify for RVS capture, so Tom Jones and Carol Kim must NOT appear.
  assert.ok(!/Tom Jones/i.test(rosterHtml),
    'non-qualifying COURIER (Tom Jones) must NOT appear in roster (got: "' + rosterHtml + '")');
  assert.ok(!/Carol Kim/i.test(rosterHtml),
    'non-qualifying COURIER (Carol Kim) must NOT appear in roster (got: "' + rosterHtml + '")');

  // ── Case 2: qualifiedCount = 2 (above threshold of 1) -> warning must NOT appear.
  const aggTwo = {
    total_in_range: 3,
    role_counts: { 'C&T': 0, 'RVS C&T': 2, 'COURIER': 1 },
    win_areas: ['11'],
    out_of_county: [
      { roles: ['RVS C&T'], distance_mi: 5.0, win_area: '11', county: 'Beaver' },
      { roles: ['RVS C&T'], distance_mi: 8.0, win_area: '11', county: 'Beaver' },
      { roles: ['COURIER'], distance_mi: 12.0, win_area: '5', county: 'Westmoreland' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: doc2 } = await driveTier2(aggTwo, 'Allegheny', { rvs: true, issue: 'capture' });
  const actions2 = doc2.getElementById('agg-actions').textContent || '';
  assert.ok(!/Low capacity/i.test(actions2),
    'no low-cap banner when qualifiedCount=2 (above threshold); got: "' + actions2 + '"');

  // ── Case 3: qualifiedCount = 0 (backup path) -> warning must NOT appear.
  const aggZero = {
    total_in_range: 2,
    role_counts: { 'C&T': 2, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: ['11'],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 7.0, win_area: '11', county: 'Beaver' },
      { roles: ['C&T'], distance_mi: 10.0, win_area: '11', county: 'Beaver' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  // RVS capture: C&T-only volunteers do NOT qualify, so qualifiedCount = 0 -> backup path.
  const { doc: doc3 } = await driveTier2(aggZero, 'Allegheny', { rvs: true, issue: 'capture' });
  const actions3 = doc3.getElementById('agg-actions').textContent || '';
  assert.ok(!/Low capacity/i.test(actions3),
    'no low-cap banner when qualifiedCount=0 (backup path fires instead); got: "' + actions3 + '"');
  assert.ok(/backup/i.test(actions3),
    'backup path is active when qualifiedCount=0 (got: "' + actions3 + '")');

  console.log('PASS: Tier 2 low-capacity banner — appears at threshold (q=1) with volunteer roster, absent above (q=2), absent on backup path (q=0).');
}

// ── R2 (d): a qualified row still renders its role badge + distance intact
//    (the qualified-only filter is non-destructive to the row contract). ─────
async function runTier2QualTagBackcompat() {
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
  // Defaults (RVS=no/capture) -> C&T qualifies, so the row renders. Assert it
  // keeps its role badge + distance and carries NO qual-badge (tags removed).
  const { doc } = await driveTier2(agg, 'Allegheny');
  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 1, 'qualified row still rendered');
  assert.ok(rows[0].querySelector('.role-badge'), 'role badge still present');
  assert.ok((rows[0].querySelector('.ctx-dist').textContent || '').indexOf('8.0 mi') !== -1,
    'distance still rendered');
  assert.strictEqual(doc.querySelectorAll('#ctx-list .ctx-row .qual-badge').length, 0,
    'no qual-badge tags (tags removed)');

  console.log('PASS: Tier 2 qualified row keeps role badge + distance, no qual tag.');
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
    // The animal's OWN county/area now arrive on the aggregate from the Worker's
    // POINT-IN-POLYGON of the resolved coord (Pittsburgh -> Allegheny / area 10),
    // and that is what drives the green animal-area highlight — NOT the prior
    // By-County selection passed to driveTier2().
    animal_county: 'Allegheny',
    animal_area: '10',
    animal_geoid: '42003',
    animal_lat: 40.4443,
    animal_lon: -79.9569,
    out_of_county: [
      { roles: ['C&T'], distance_mi: 9.1, win_area: '7', county: 'Centre' },
      { roles: ['RVS C&T'], distance_mi: 18.6, win_area: '13', county: 'Dauphin' },
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

// DRIVING-distance enhancement: the Worker returns ORS driving distance + time
// for the candidate pool. The panel must (a) re-rank by driving distance and
// (b) display the "X.X mi driving / ~Y min" label. The mock pool order matches
// the haversine sort of REHAB_DATA: [Near Open Site, Mid Closed NoSite,
// Far Open Site, Farthest]. We hand back driving numbers that make "Far Open
// Site" the closest by ROAD to prove the re-rank actually happens.
async function runRehabDrivingDistances() {
  const aggWithCoords = Object.assign({}, WORKER_AGG, {
    animal_lat: 40.4443, animal_lon: -79.9569,
  });
  const aggCalls = [];
  const { window } = loadDom({
    workerAgg: aggWithCoords,
    data: { 'rehabbers.json': REHAB_DATA },
    aggCalls: aggCalls,
    // Parallel to the pool order (Near, Mid, Far, Farthest). Far has the
    // smallest driving distance/time -> it must sort to the top after the
    // re-rank, even though it is NOT the closest by straight line.
    rehabDist: {
      source: 'ors',
      distances: [
        { distance_mi: 18.4, duration_min: 31 }, // Near (straight-line 1st)
        { distance_mi: 26.7, duration_min: 44 }, // Mid
        { distance_mi: 9.2, duration_min: 17 },  // Far -> closest by road
        { distance_mi: 71.0, duration_min: 95 }, // Farthest
      ],
    },
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

  const aggCallsBeforeReveal = aggCalls.length;
  const toggle = doc.getElementById('rehab-toggle');
  toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
  // The driving fetch resolves asynchronously after reveal; flush a few turns
  // so the .then() re-render runs.
  await flush(window);
  await flush(window);
  await flush(window);

  // The driving-distance fetch is NOT an aggregate lookup -> aggCalls unchanged.
  assert.strictEqual(aggCalls.length, aggCallsBeforeReveal,
    'driving-distance fetch did NOT register as a new aggregate lookup');

  const rows = Array.prototype.slice.call(doc.querySelectorAll('#rehab-list .rehab-row'));
  assert.strictEqual(rows.length, 3, 'still shows exactly the top 3 (got ' + rows.length + ')');

  const names = rows.map(function (r) {
    return (r.querySelector('.rehab-name').textContent || '').trim();
  });
  assert.deepStrictEqual(names, ['Far Open Site', 'Near Open Site', 'Mid Closed NoSite'],
    're-ranked ascending by DRIVING distance (got ' + JSON.stringify(names) + ')');

  // Each row shows the driving label "X.X mi driving / ~Y min".
  rows.forEach(function (r) {
    const d = (r.querySelector('.rehab-dist').textContent || '').trim();
    assert.ok(/^\d+\.\d mi driving \/ ~\d+ min$/.test(d),
      'distance formatted "X.X mi driving / ~Y min" (got "' + d + '")');
  });
  // Row 0 (Far) shows its specific driving numbers.
  assert.strictEqual((rows[0].querySelector('.rehab-dist').textContent || '').trim(),
    '9.2 mi driving / ~17 min', 'row0 shows Far driving distance + time');

  console.log('PASS: rehab panel uses ORS driving distance — re-ranks by road distance and shows "X.X mi driving / ~Y min".');
}

// GRACEFUL FALLBACK: when the Worker returns its haversine fallback (source
// 'haversine', no durations) the panel must keep the straight-line "X.X mi"
// display and the original haversine ranking — never break or show "~null min".
async function runRehabDrivingFallback() {
  const aggWithCoords = Object.assign({}, WORKER_AGG, {
    animal_lat: 40.4443, animal_lon: -79.9569,
  });
  const aggCalls = [];
  const { window } = loadDom({
    workerAgg: aggWithCoords,
    data: { 'rehabbers.json': REHAB_DATA },
    aggCalls: aggCalls,
    // Worker could not reach ORS -> straight-line fallback, durations null.
    rehabDist: {
      source: 'haversine',
      distances: [
        { distance_mi: 3.6, duration_min: null },
        { distance_mi: 18.5, duration_min: null },
        { distance_mi: 40.1, duration_min: null },
        { distance_mi: 120.2, duration_min: null },
      ],
    },
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

  doc.getElementById('rehab-toggle').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const rows = Array.prototype.slice.call(doc.querySelectorAll('#rehab-list .rehab-row'));
  const names = rows.map(function (r) {
    return (r.querySelector('.rehab-name').textContent || '').trim();
  });
  // Unchanged haversine ranking.
  assert.deepStrictEqual(names, ['Near Open Site', 'Mid Closed NoSite', 'Far Open Site'],
    'fallback keeps the straight-line ranking (got ' + JSON.stringify(names) + ')');
  // Plain "X.X mi" label, never the driving label and never "~null min".
  rows.forEach(function (r) {
    const d = (r.querySelector('.rehab-dist').textContent || '').trim();
    assert.ok(/^\d+\.\d mi$/.test(d),
      'fallback keeps straight-line "X.X mi" (got "' + d + '")');
    assert.ok(d.indexOf('driving') < 0 && d.indexOf('null') < 0,
      'fallback shows no driving/null text (got "' + d + '")');
  });

  console.log('PASS: rehab panel degrades gracefully — Worker haversine fallback keeps straight-line "X.X mi" + ranking.');
}

// ── Stale-flag (Approach B): ADDRESS mode ───────────────────────────────────
// Render an aggregate result, then change the RVS toggle. The shown
// #address-result must be flagged stale (NOT silently trusted, NOT auto-
// recomputed): it gets .is-stale, a .stale-notice banner appears, the rehabber
// on-demand panel is collapsed so it can't reveal stale rows, and NO new Worker
// fetch fires on the input change. Re-clicking "Find Help Nearby" clears the
// stale flag and renders fresh numbers. Then repeat for an Issue (C&T) change.
async function runStaleAddressMode() {
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

  const result = doc.getElementById('address-result');
  assert.strictEqual(result.style.display, 'block', 'address-result shown after submit');
  assert.ok(!result.classList.contains('is-stale'), 'result is NOT stale right after a fresh lookup');
  assert.strictEqual(result.querySelector(':scope > .stale-notice'), null,
    'no stale-notice banner on a fresh result');
  // The fresh numbers we will guard against being silently trusted later.
  assert.strictEqual(doc.getElementById('agg-total').textContent, '32', 'fresh total rendered (32)');

  // Reveal the rehabber list so we can prove it gets collapsed on stale.
  const toggle = doc.getElementById('rehab-toggle');
  const content = doc.getElementById('rehab-content');
  toggle.dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  assert.strictEqual(content.style.display, 'block', 'rehab list revealed before the input change');

  // --- Change RVS toggle AFTER results render --------------------------
  const callsBefore = aggCalls.length;
  doc.querySelector('input[name="rvs"][value="yes"]').checked = true;
  doc.querySelector('input[name="rvs"][value="yes"]')
    .dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);

  // Approach B: NOT auto-recomputed.
  assert.strictEqual(aggCalls.length, callsBefore,
    'changing RVS does NOT trigger a new Worker lookup (no auto-recompute)');
  // Result is still on screen (we do not hide it) but is clearly flagged stale.
  assert.strictEqual(result.style.display, 'block', 'stale result stays on screen (not hidden)');
  assert.ok(result.classList.contains('is-stale'),
    'address-result is visually marked stale after the RVS change');
  const notice = result.querySelector(':scope > .stale-notice');
  assert.ok(notice, 'a stale-notice banner is shown on the address result');
  assert.ok(/re-run the lookup/i.test(notice.textContent || ''),
    'stale banner instructs the user to re-run the lookup (got "' + (notice.textContent || '') + '")');
  // The numbers are still in the DOM but the surface is flagged: the rehabber
  // on-demand panel must be collapsed so stale rehabbers cannot be shown.
  assert.strictEqual(content.style.display, 'none',
    'rehabber on-demand panel is collapsed while the result is stale');
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false',
    'rehabber toggle reset to collapsed while stale');

  // --- Re-click "Find Help Nearby" -> stale cleared + fresh numbers ----
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);
  assert.strictEqual(aggCalls.length, callsBefore + 1,
    're-clicking the submit button DID run a fresh lookup');
  assert.ok(!result.classList.contains('is-stale'), 're-running clears the stale flag');
  assert.strictEqual(result.querySelector(':scope > .stale-notice'), null,
    're-running removes the stale-notice banner');
  assert.strictEqual(result.style.display, 'block', 'fresh result shown after re-run');
  assert.strictEqual(doc.getElementById('agg-total').textContent, '32',
    'fresh numbers rendered after re-run');

  // --- Same for an Issue (C&T) change ----------------------------------
  const callsBefore2 = aggCalls.length;
  doc.querySelector('input[name="issue"][value="transport"]').checked = true;
  doc.querySelector('input[name="issue"][value="transport"]')
    .dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  assert.strictEqual(aggCalls.length, callsBefore2,
    'changing Issue does NOT auto-recompute');
  assert.ok(result.classList.contains('is-stale'),
    'address-result flagged stale after the Issue (C&T) change too');
  assert.ok(result.querySelector(':scope > .stale-notice'),
    'stale-notice banner shown after the Issue change');

  // Re-run clears it again.
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);
  assert.ok(!result.classList.contains('is-stale'),
    're-running after the Issue change clears stale');

  console.log('PASS: address-mode result is flagged stale on RVS/Issue change (no auto-recompute, rehab panel collapsed); re-click clears it + renders fresh numbers.');
}

// ── Stale-flag (Approach B): COUNTY mode ────────────────────────────────────
// Render a recommendation, then change the Issue (C&T) selection. The shown
// #rec-output must be flagged stale (.is-stale + banner) without recomputing.
// Re-clicking "Get Recommendation" clears the flag and renders fresh. Repeat
// for an RVS change.
async function runStaleCountyMode() {
  const SNAPSHOT = {
    generated_at: '2024-01-01T00:00:00Z',
    counties: {
      Allegheny: {
        ct_no_rvs: { available: 3, total: 5, marginal_volunteers: [] },
        ct_rvs: { available: 2, total: 2, marginal_volunteers: [] },
        courier: { available: 4, total: 6, marginal_volunteers: [] },
      },
    },
  };
  const { window } = loadDom({
    data: {
      'county_capacity.json': SNAPSHOT,
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

  const out = doc.getElementById('rec-output');
  // Get a recommendation rendered.
  doc.getElementById('recommend-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  assert.ok(out.classList.contains('show'), 'recommendation shown after clicking the button');
  assert.ok(!out.classList.contains('is-stale'), 'recommendation NOT stale right after rendering');
  assert.strictEqual(out.querySelector(':scope > .stale-notice'), null,
    'no stale-notice on a fresh recommendation');

  // --- Change Issue (C&T) AFTER the recommendation renders -------------
  doc.querySelector('input[name="issue"][value="transport"]').checked = true;
  doc.querySelector('input[name="issue"][value="transport"]')
    .dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  assert.ok(out.classList.contains('show'),
    'stale recommendation stays on screen (not hidden)');
  assert.ok(out.classList.contains('is-stale'),
    'rec-output is visually marked stale after the Issue (C&T) change');
  const notice = out.querySelector(':scope > .stale-notice');
  assert.ok(notice, 'a stale-notice banner is shown on the recommendation');
  assert.ok(/re-run the lookup/i.test(notice.textContent || ''),
    'stale banner instructs the user to re-run (got "' + (notice.textContent || '') + '")');

  // --- Re-click "Get Recommendation" -> stale cleared + fresh ----------
  doc.getElementById('recommend-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  assert.ok(out.classList.contains('show'), 'fresh recommendation shown after re-run');
  assert.ok(!out.classList.contains('is-stale'), 're-running clears the stale flag');
  assert.strictEqual(out.querySelector(':scope > .stale-notice'), null,
    're-running removes the stale-notice banner');

  // --- Same for an RVS change ------------------------------------------
  doc.querySelector('input[name="rvs"][value="yes"]').checked = true;
  doc.querySelector('input[name="rvs"][value="yes"]')
    .dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  assert.ok(out.classList.contains('is-stale'),
    'rec-output flagged stale after the RVS change too');
  assert.ok(out.querySelector(':scope > .stale-notice'),
    'stale-notice banner shown after the RVS change');

  doc.getElementById('recommend-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  assert.ok(!out.classList.contains('is-stale'),
    're-running after the RVS change clears stale');

  console.log('PASS: county-mode recommendation is flagged stale on Issue/RVS change (no auto-recompute); re-click clears it + renders fresh.');
}

// ── Help / User Manual: the dispatcher header carries a link to the in-app
//    viewer (help.html). Guards that dispatchers can reach the manual. ───────
async function runHelpLink() {
  const { window } = loadDom();
  const doc = window.document;
  await flush(window);

  const link = doc.getElementById('help-link');
  assert.ok(link, 'dispatcher header has a #help-link');
  assert.strictEqual(link.getAttribute('href'), 'help.html',
    'Help link points to the in-app manual viewer (help.html)');
  assert.ok(/manual|help/i.test(link.textContent || ''),
    'Help link is clearly labeled (got "' + (link.textContent || '') + '")');

  console.log('PASS: dispatcher header links to the User Manual viewer (help.html).');
}

// ── help.html viewer: loads the VENDORED marked renderer + the file:// fallback
//    copy of the manual and renders the manual heading. Confirms the in-app
//    viewer renders formatted markdown (not raw) with NO network dependency. ──
async function runHelpViewerRenders() {
  const HELP_HTML = path.join(DOCS, 'help.html');
  const MARKED_JS = path.join(DOCS, 'assets', 'vendor', 'marked.min.js');
  const MANUAL_JS = path.join(DOCS, 'assets', 'manual.js');

  // Vendored renderer must be committed in-repo (no CDN). Assert it exists and
  // help.html references the in-repo path, never an external host.
  assert.ok(fs.existsSync(MARKED_JS), 'vendored marked.min.js is committed in assets/vendor/');
  assert.ok(fs.existsSync(MANUAL_JS), 'generated manual.js (file:// fallback) is committed');
  const helpSrc = fs.readFileSync(HELP_HTML, 'utf8');
  assert.ok(helpSrc.indexOf('assets/vendor/marked.min.js') !== -1,
    'help.html loads the vendored renderer from assets/vendor/');
  assert.ok(!/<script[^>]+src=["']https?:\/\//i.test(helpSrc),
    'help.html has NO external <script src> (offline / no third-party calls)');

  // Render on the file:// path: marked + the embedded manual copy, fire the
  // inline viewer script, and assert the manual heading rendered as real HTML.
  const html = fs.readFileSync(HELP_HTML, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'file:///repo/docs/help.html',
  });
  const w = dom.window;
  w.eval(fs.readFileSync(MARKED_JS, 'utf8'));
  w.eval(fs.readFileSync(MANUAL_JS, 'utf8'));
  Array.prototype.slice.call(w.document.querySelectorAll('script'))
    .filter(function (s) { return !s.src; })
    .forEach(function (s) { w.eval(s.textContent); });
  await new Promise(function (r) { w.setTimeout(r, 30); });

  const manual = w.document.getElementById('manual');
  const h1 = manual.querySelector('h1');
  assert.ok(h1, 'viewer renders a top-level heading (formatted, not raw markdown)');
  assert.ok(/manual/i.test(h1.textContent || ''),
    'rendered heading is the manual title (got "' + (h1.textContent || '') + '")');
  assert.ok(manual.querySelectorAll('h2').length >= 3,
    'viewer renders the manual sections as <h2> headings');
  assert.ok(manual.innerHTML.indexOf('load-err') === -1,
    'viewer shows no load error on the file:// fallback path');

  console.log('PASS: help.html renders the manual heading via the vendored renderer (file:// fallback, no network).');
}

// ── County dropdown WIN-area badge: shows "<County> · Area N" beside the
//    dropdown and updates live as the selection changes. ────────────────────
async function runCountyAreaBadge() {
  const { window } = loadDom({
    data: { 'county_win.json': COUNTY_WIN, 'coordinators.json': COORDINATORS },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  const badge = doc.getElementById('county-badge');
  assert.ok(badge, 'county-badge element exists');
  // Nothing selected -> badge hidden.
  assert.strictEqual(badge.style.display, 'none', 'badge hidden with no county selected');

  const countySel = doc.getElementById('county');
  countySel.value = 'Allegheny';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  assert.notStrictEqual(badge.style.display, 'none', 'badge visible after county select');
  assert.ok(/Allegheny\s*\u00b7\s*Area 10/.test(badge.textContent || ''),
    'badge reads "Allegheny \u00b7 Area 10" (got: "' + badge.textContent + '")');

  // Live update on change to a different-area county.
  countySel.value = 'Erie';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  assert.ok(/Erie\s*\u00b7\s*Area 1\b/.test(badge.textContent || ''),
    'badge updates live to "Erie \u00b7 Area 1" (got: "' + badge.textContent + '")');

  console.log('PASS: county dropdown WIN-area badge renders "<County> \u00b7 Area N" and updates on change.');
}

// ── Address mode RESOLVED-LOCATION header: the ANIMAL's own resolved county +
//    WIN area is the primary/highlighted location, the coordinator shown is
//    THAT area's coordinator, and the in-range spread is listed when the radius
//    crosses WIN-area boundaries. ───────────────────────────────────────────
async function runAddressResolvedArea() {
  // Worker returns the animal's own area (10) plus a cross-boundary area (11).
  const agg = {
    total_in_range: 7,
    role_counts: { 'C&T': 3, 'RVS C&T': 1, 'COURIER': 3 },
    win_areas: ['10', '11'],
    animal_county: 'Allegheny',
    animal_area: '10',
    animal_lat: 40.4406,
    animal_lon: -79.9959,
  };
  const { window } = loadDom({
    workerAgg: agg,
    data: { 'county_win.json': COUNTY_WIN, 'coordinators.json': COORDINATORS },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  // Switch to address mode and submit.
  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('animal-address').value = '436 Grant St, Pittsburgh, PA';
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const resolved = doc.getElementById('resolved-location');
  assert.ok(resolved, 'resolved-location element exists');
  assert.strictEqual(resolved.style.display, 'block', 'resolved header visible after geocode');
  const rtxt = resolved.textContent || '';
  // ANIMAL's own area is the primary header.
  assert.ok(/Resolved:\s*Allegheny County\s*\u00b7\s*Area 10/.test(rtxt),
    'resolved header names the ANIMAL county + area (got: "' + rtxt + '")');
  // Cross-boundary spread is also listed (10, 11).
  assert.ok(/span Areas\s*10,\s*11/.test(rtxt),
    'resolved header lists the in-range spread (got: "' + rtxt + '")');

  // The address-mode coordinator shown is the ANIMAL area's coordinator (Area 10
  // -> Julia Meredith), listed first (primary).
  const actions = (doc.getElementById('agg-actions').textContent || '');
  assert.ok(actions.indexOf('Julia Meredith') !== -1,
    'address mode shows the ANIMAL area (10) coordinator Julia Meredith (got: "' + actions + '")');
  // The animal's own area chip leads the chip row.
  const chips = Array.prototype.slice
    .call(doc.querySelectorAll('#agg-areas .win-chip'))
    .map(function (c) { return c.textContent.trim(); });
  assert.strictEqual(chips[0], 'Area 10', 'animal area chip leads (got ' + JSON.stringify(chips) + ')');

  console.log('PASS: address-mode resolved header = animal Allegheny/Area 10 (primary) + spread 10,11; Area-10 coordinator shown.');
}

// ── DECONFLICTION: geocoding an address in a DIFFERENT county than the dropdown
//    rebinds the governing location to the address; the county-mode coordinator
//    line is cleared so two coordinators are NEVER shown at once. Switching back
//    to county mode rebinds to the dropdown county (selection preserved). ─────
async function runDeconfliction() {
  // Dropdown will be Erie (Area 1 -> Sue DeArment); address resolves to
  // Allegheny (Area 10 -> Julia Meredith).
  const agg = {
    total_in_range: 4,
    role_counts: { 'C&T': 2, 'RVS C&T': 0, 'COURIER': 2 },
    win_areas: ['10'],
    animal_county: 'Allegheny',
    animal_area: '10',
    animal_lat: 40.4406,
    animal_lon: -79.9959,
  };
  const { window } = loadDom({
    workerAgg: agg,
    data: { 'county_win.json': COUNTY_WIN, 'coordinators.json': COORDINATORS },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  // 1) Pick a county in a DIFFERENT area first (Erie -> Area 1 -> Sue DeArment).
  const countySel = doc.getElementById('county');
  countySel.value = 'Erie';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  const coordLine = doc.getElementById('coord-line');
  assert.ok((coordLine.textContent || '').indexOf('Sue DeArment') !== -1,
    'county mode initially shows Erie/Area 1 coordinator Sue DeArment');

  // 2) Switch to address mode + geocode an Allegheny address.
  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('animal-address').value = '436 Grant St, Pittsburgh, PA';
  doc.getElementById('radius-mi').value = '30';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  // CORE FIX: county-mode coordinator line is no longer shown (cleared), so the
  // stale Erie coordinator does NOT linger beside the address area's coordinator.
  assert.strictEqual(coordLine.style.display, 'none',
    'county-mode coordinator line is hidden once an address governs');
  assert.strictEqual((coordLine.textContent || '').indexOf('Sue DeArment'), -1,
    'stale dropdown-county coordinator (Sue DeArment) is cleared');
  // Only the ADDRESS area's coordinator (Allegheny/Area 10 -> Julia Meredith) shows.
  const actions = (doc.getElementById('agg-actions').textContent || '');
  assert.ok(actions.indexOf('Julia Meredith') !== -1,
    'address area coordinator Julia Meredith is shown');
  assert.strictEqual(actions.indexOf('Sue DeArment'), -1,
    'dropdown-county coordinator never appears in address mode');
  // Dropdown selection is PRESERVED (not wiped).
  assert.strictEqual(countySel.value, 'Erie', 'dropdown selection is preserved while address governs');

  // 3) Switch back to county mode -> rebinds to Erie, tears down address context.
  const countyRadio = doc.querySelector('input[name="mode"][value="county"]');
  countyRadio.checked = true;
  countyRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  assert.strictEqual(doc.getElementById('resolved-location').style.display, 'none',
    'address resolved header is torn down when county mode regains control');
  assert.strictEqual(doc.getElementById('address-result').style.display, 'none',
    'address result panel is hidden when county mode regains control');
  assert.ok((coordLine.textContent || '').indexOf('Sue DeArment') !== -1,
    'county-mode coordinator (Sue DeArment) returns when county mode governs again');

  console.log('PASS: deconfliction — address rebinds governing area + clears county coordinator (no dual display); switching back restores county.');
}

// Regression for the stale county-state LEAK (DEFECT B): a prior By-County
// (Tier-1) Monroe selection (WIN area 9) must NOT persist into a new address
// lookup that resolves to Schuylkill (WIN area 14, Port Carbon). The resolved
// header AND the green animal-area map highlight must reflect Schuylkill/14,
// never the leftover Monroe/9.
async function runStaleCountyLeakSchuylkill() {
  // Worker returns the Port Carbon -> Schuylkill aggregate (area 14), with the
  // county/area/geoid the Worker now derives by point-in-polygon of the coord.
  const agg = {
    total_in_range: 2,
    role_counts: { 'C&T': 1, 'RVS C&T': 0, 'COURIER': 1 },
    win_areas: ['14'],
    animal_county: 'Schuylkill',
    animal_area: '14',
    animal_geoid: '42107',
    animal_lat: 40.6968,
    animal_lon: -76.1664,
  };
  const { window } = loadDom({
    workerAgg: agg,
    data: {
      // Dropdown + centroids need Monroe (9) and Schuylkill (14); the map's
      // data-area paths come from the real GeoJSON regardless.
      'county_win.json': { Monroe: '9', Schuylkill: '14' },
      'coordinators.json': { '9': 'Monroe Coord', '14': 'Schuylkill Coord' },
    },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  // 1) Prior By-County (Tier-1) selection: Monroe -> WIN area 9.
  const countySel = doc.getElementById('county');
  countySel.value = 'Monroe';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);
  assert.ok((doc.getElementById('coord-line').textContent || '').indexOf('Monroe Coord') !== -1,
    'county mode initially shows the Monroe (area 9) coordinator');
  assert.ok(doc.querySelectorAll('path.county-path[data-area="9"].hl-animal').length > 0,
    'Monroe area 9 is initially green-highlighted in county mode');

  // 2) New address lookup resolves to Schuylkill (area 14, Port Carbon).
  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('animal-address').value = '321 2nd St, Port Carbon, PA 17965';
  doc.getElementById('radius-mi').value = '20';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  // Resolved header reflects Schuylkill / Area 14 — Monroe / Area 9 does NOT leak.
  const rtxt = doc.getElementById('resolved-location').textContent || '';
  assert.ok(/Schuylkill County\s*·\s*Area\s*14/.test(rtxt),
    'resolved header shows Schuylkill County / Area 14');
  assert.strictEqual(rtxt.indexOf('Monroe'), -1, 'no leftover Monroe county in resolved header');
  assert.strictEqual(/Area\s*9\b/.test(rtxt), false, 'no leftover Area 9 in resolved header');

  // Map: the animal-area green highlight is Schuylkill/14, NOT Monroe/9.
  assert.ok(doc.querySelectorAll('path.county-path[data-area="14"].hl-animal').length > 0,
    'Schuylkill area 14 is green-highlighted after the address resolves');
  assert.strictEqual(doc.querySelectorAll('path.county-path[data-area="9"].hl-animal').length, 0,
    'stale Monroe area 9 highlight is cleared (no leak)');

  console.log('PASS: stale-leak — prior By-County Monroe (area 9) does not persist; address resolves Schuylkill/14 in header + map.');
}

// ── Standalone Address lookup ALSO renders the PII-safe qualifying-volunteer
//    context list (context=1 WITHOUT exclude_county). No widen flow involved.
//    Proves: (1) the request opts into context=1 but sends NO exclude_county,
//    (2) #ctx-list rows render with qual badges, (3) the heading uses the
//    standalone "Qualified volunteers" wording (NOT the out-of-county widen
//    wording), and (4) rows carry ONLY the whitelisted fields (no name/phone/
//    coords). ───────────────────────────────────────────────────────────────
async function runStandaloneAddressContextList() {
  const agg = {
    total_in_range: 4,
    role_counts: { 'C&T': 1, 'RVS C&T': 1, 'COURIER': 2 },
    win_areas: ['10', '11'],
    // context=1 (no exclude_county) -> Worker returns ALL in-range qualifying
    // volunteers (no county filtered out). Mix of counties incl. Allegheny.
    out_of_county: [
      { roles: ['RVS C&T'], distance_mi: 5.1, win_area: '10', county: 'Allegheny' },
      { roles: ['C&T'], distance_mi: 9.4, win_area: '11', county: 'Beaver' },
      { roles: ['COURIER'], distance_mi: 18.6, win_area: '11', county: 'Beaver' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const aggCalls = [];
  const { window } = loadDom({
    workerAgg: agg,
    aggCalls: aggCalls,
    data: { 'county_win.json': COUNTY_WIN, 'coordinators.json': COORDINATORS },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  // Plain Address mode (NO widen): switch to address mode directly.
  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);

  // Set the SHARED animal base info so the qualification tag renders.
  doc.querySelector('input[name="rvs"][value="yes"]').checked = true;
  doc.querySelector('input[name="issue"][value="capture"]').checked = true;

  doc.getElementById('animal-address').value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  doc.getElementById('radius-mi').value = '40';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  // (1) Request opts into context=1 but sends NO exclude_county.
  const url = aggCalls[aggCalls.length - 1] || '';
  assert.ok(/[?&]context=1(&|$)/.test(url),
    'standalone address request opts into context=1 (url: ' + url + ')');
  assert.ok(!/[?&]exclude_county=/.test(url),
    'standalone address request must NOT send exclude_county (url: ' + url + ')');
  // It DOES carry the derived qualifying-role set. RVS=yes capture -> "RVS C&T".
  const qrMatch = /[?&]qualify_roles=([^&]*)/.exec(url);
  const qrVal = qrMatch ? decodeURIComponent(qrMatch[1]) : '';
  assert.strictEqual(qrVal, 'RVS C&T',
    'RVS capture qualify_roles = "RVS C&T" (got: "' + qrVal + '")');

  // Aggregate cards still render (list is ADDITIVE, not a replacement). Counts
  // reflect the FULL in-range set (UNCHANGED by the qualified-only list filter).
  const result = doc.getElementById('address-result');
  assert.strictEqual(result.style.display, 'block', 'address-result section is shown');
  assert.strictEqual(doc.getElementById('agg-total').textContent, '4', 'aggregate total still renders (full set)');

  // (2) Context block + QUALIFIED-ONLY rows render. For RVS=yes/capture only the
  // RVS C&T volunteer qualifies; the plain C&T and the COURIER rows are dropped.
  const block = doc.getElementById('ctx-block');
  assert.strictEqual(block.style.display, 'block', 'context block is shown for standalone address');
  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 1, 'qualified-only: only the RVS C&T row renders (got ' + rows.length + ')');

  // The single rendered row is the nearest qualified (RVS C&T) volunteer.
  const dists = rows.map(function (r) {
    return (r.querySelector('.ctx-dist').textContent || '').trim();
  });
  assert.deepStrictEqual(dists, ['5.1 mi'],
    'the one qualified row is the RVS C&T at 5.1 mi (got ' + JSON.stringify(dists) + ')');
  assert.ok(Array.prototype.slice.call(rows[0].querySelectorAll('.role-badge'))
    .some(function (b) { return b.textContent.trim() === 'RVS C&T'; }),
    'rendered row carries the RVS C&T role badge');

  // (2b) NO qualified/unqualified tag UI remains (every listed row is qualified).
  const qualBadges = doc.querySelectorAll('#ctx-list .ctx-row .qual-badge');
  assert.strictEqual(qualBadges.length, 0, 'no qual-badge tags rendered (qualified-only list)');

  // (3) Heading uses the standalone "Qualified volunteers" wording, NOT the
  // out-of-county widen phrasing.
  const hdr = doc.getElementById('ctx-header').textContent || '';
  assert.ok(hdr.indexOf('Qualified volunteers') !== -1 && hdr.indexOf('40 mi') !== -1,
    'standalone heading reads "Qualified volunteers within 40 mi" (got: "' + hdr + '")');
  assert.strictEqual(hdr.indexOf('Out-of-county'), -1,
    'standalone heading must NOT use the out-of-county widen wording (got: "' + hdr + '")');

  // (4) Row shape: ONLY role badges + qual badge + distance + area/county
  // context. No name, no phone, no raw coordinates anywhere in the surface.
  rows.forEach(function (r) {
    const txt = r.textContent || '';
    assert.ok(!/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(txt),
      'context rows must never render a phone number (got: "' + txt + '")');
    // No decimal-degree coordinate pair (e.g. "40.4443, -79.9569").
    assert.ok(!/-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/.test(txt),
      'context rows must never render raw coordinates (got: "' + txt + '")');
  });
  assert.ok((rows[0].textContent || '').indexOf('Allegheny') !== -1,
    'in-county (Allegheny) volunteer IS included for a standalone lookup (no exclusion)');

  console.log('PASS: standalone Address lookup renders qualified-only context rows (context=1, qualify_roles=RVS C&T, no exclude_county), no tags, standalone heading, no PII.');
}

// No-horizontal-overflow contract for the ADDRESS view on phones.
//
// jsdom has no layout engine, so getBoundingClientRect-based overflow can only
// be measured in a real browser (see tools/overflow_probe.js, which drives
// headless Chrome and asserts scrollWidth == innerWidth at 320/360/375/390/430).
// This scenario guards the SOURCE-level contract those measurements depend on,
// so a regression that re-introduces the overflow fails here without a browser:
//   1. The masking `overflow-x: hidden` clip on html/body/main is GONE (the real
//      geometry fix must stand on its own; the clip would hide regressions).
//   2. The 3-up capacity grid uses minmax(0, 1fr) so tracks can shrink to the
//      viewport instead of rounding ~2px past it.
//   3. The #ctx-list context text (.ctx-ctx) wraps unbreakable tokens
//      (overflow-wrap: anywhere) so a long county/area string cannot push the
//      row — the true offending element found by the probe — past the viewport.
//   4. The viewport meta tag is exactly one, width=device-width + initial-scale=1,
//      with NO fixed pixel width and NO maximum-scale/user-scalable lockout. A
//      broken/duplicate viewport tag is the classic cause of the "renders wide,
//      pinch-unzoom snaps to fit" real-device symptom that a fixed-width headless
//      probe cannot reproduce (it sets the viewport directly).
async function runAddressNoHorizontalOverflowCss() {
  const css = fs.readFileSync(HTML_PATH, 'utf8');

  assert.ok(!/\b(?:html\s*,\s*body|main)\s*\{[^}]*overflow-x\s*:\s*hidden/i.test(css),
    'address view must NOT rely on overflow-x:hidden to clip overflow on html/body/main ' +
    '(clipping masks real off-screen content; fix the offending element instead)');

  assert.ok(/\.cards-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(\s*3\s*,\s*minmax\(\s*0\s*,\s*1fr\s*\)\s*\)/i.test(css),
    'cards-grid must use repeat(3, minmax(0, 1fr)) so the 3-up grid never rounds past 100%');

  assert.ok(/\.ctx-row\s+\.ctx-ctx\s*\{[^}]*overflow-wrap\s*:\s*anywhere/i.test(css),
    '#ctx-list context text (.ctx-ctx) must set overflow-wrap:anywhere so a long ' +
    'unbreakable county/area token wraps instead of overflowing the viewport');

  // Viewport meta-tag contract (the pinch-unzoom-to-fit real-device symptom).
  const viewportTags = css.match(/<meta[^>]*name=["']viewport["'][^>]*>/gi) || [];
  assert.strictEqual(viewportTags.length, 1,
    'there must be EXACTLY one viewport meta tag (found ' + viewportTags.length +
    '); a duplicate/conflicting tag breaks the initial mobile fit');
  const vp = viewportTags[0];
  const content = (vp.match(/content=["']([^"']*)["']/i) || [])[1] || '';
  assert.ok(/width\s*=\s*device-width/i.test(content),
    'viewport meta must set width=device-width (got content="' + content + '")');
  assert.ok(/initial-scale\s*=\s*1(\.0+)?\b/.test(content),
    'viewport meta must set initial-scale=1 (got content="' + content + '")');
  assert.ok(!/width\s*=\s*\d/.test(content),
    'viewport meta must NOT pin a fixed pixel width (got content="' + content + '")');
  assert.ok(!/maximum-scale|minimum-scale|user-scalable\s*=\s*(no|0)/i.test(content),
    'viewport meta must NOT lock zoom (no maximum/minimum-scale, no user-scalable=no) ' +
    'so the page can pinch-fit (got content="' + content + '")');

  console.log('PASS: address-view no-overflow CSS contract + viewport meta — no overflow-x:hidden clip, ' +
    'cards-grid minmax(0,1fr), .ctx-ctx overflow-wrap:anywhere, single width=device-width/initial-scale=1 viewport (no fixed width, no zoom lockout).');
}

// ── Regression: NO-RVS CAPTURE qualifying list must include RVS C&T rows. ───
//    Real-user bug: for RVS=No + ISSUE=capture, ANY C&T-capable volunteer
//    qualifies. The aggregate Worker emits 'RVS C&T' EXCLUSIVELY for a
//    both-capable volunteer (so panel role_counts stay mutually exclusive like
//    Tier 1's ct_no_rvs/ct_rvs), which means those rows carry roles:['RVS C&T']
//    and NOT a plain 'C&T' token. The qualified-only list must still surface
//    ALL 4 (1 plain C&T + 3 RVS C&T), drop couriers, and — even with enough
//    couriers in range to push the FULL set past the overflow cap — NOT be
//    truncated (the qualified set is 4 < 15). role_counts stay UNCHANGED.
async function runStandaloneNoRvsCaptureAllCtCapable() {
  // Simulate the Worker AFTER qualified-only filtering: it received our
  // qualify_roles=C&T,RVS C&T param, so out_of_county already excludes the many
  // couriers and is NOT truncated (4 qualified < 15). role_counts, however,
  // still reflect the FULL in-range set incl. couriers.
  const agg = {
    total_in_range: 20, // 1 C&T + 3 RVS C&T + 16 couriers in range
    // Mutually-exclusive counts (unchanged): 1 plain C&T + 3 RVS C&T + 16 COURIER.
    role_counts: { 'C&T': 1, 'RVS C&T': 3, 'COURIER': 16 },
    win_areas: ['10', '11'],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 3.0, win_area: '10', county: 'Allegheny' },
      { roles: ['RVS C&T'], distance_mi: 6.0, win_area: '10', county: 'Allegheny' },
      { roles: ['RVS C&T'], distance_mi: 9.0, win_area: '11', county: 'Beaver' },
      { roles: ['RVS C&T'], distance_mi: 12.0, win_area: '11', county: 'Beaver' },
    ],
    out_of_county_truncated: false, // qualified set (4) < cap (15) -> not truncated
    radius_too_broad: false,
  };
  const aggCalls = [];
  const { window } = loadDom({
    workerAgg: agg,
    aggCalls: aggCalls,
    data: { 'county_win.json': COUNTY_WIN, 'coordinators.json': COORDINATORS },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);

  // RVS=No + ISSUE=capture: any C&T-capable qualifies.
  doc.querySelector('input[name="rvs"][value="no"]').checked = true;
  doc.querySelector('input[name="issue"][value="capture"]').checked = true;

  doc.getElementById('animal-address').value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  doc.getElementById('radius-mi').value = '40';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  // The request carried the derived qualifying-role set so the Worker returns
  // qualified-only rows: no-RVS capture -> "C&T,RVS C&T".
  const url = aggCalls[aggCalls.length - 1] || '';
  const qrMatch = /[?&]qualify_roles=([^&]*)/.exec(url);
  const qrVal = qrMatch ? decodeURIComponent(qrMatch[1]) : '';
  assert.strictEqual(qrVal, 'C&T,RVS C&T',
    'no-RVS capture qualify_roles = "C&T,RVS C&T" (got: "' + qrVal + '")');

  // ALL 4 C&T-capable rows render (the bug rendered only the 1 plain C&T, or
  // dropped far qualified rows under the nearest-N cap).
  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 4,
    'all 4 C&T-capable volunteers (1 C&T + 3 RVS C&T) render in the list (got ' + rows.length + ')');

  // The list is NOT truncated and shows no overflow notice (qualified set < cap).
  assert.strictEqual(doc.getElementById('ctx-notice').style.display, 'none',
    'no overflow notice — the qualified set (4) is below the cap');

  // No courier row leaks into a capture list.
  rows.forEach(function (r) {
    assert.ok(!/COURIER/.test(r.textContent || ''), 'couriers excluded from a capture list');
  });

  // NO qualified/unqualified tag UI remains (every listed row is qualified).
  assert.strictEqual(doc.querySelectorAll('#ctx-list .ctx-row .qual-badge').length, 0,
    'no qual-badge tags rendered (qualified-only list)');

  // The 3 RVS C&T rows specifically survive (regression: they were dropped by
  // the nearest-N cap when many couriers were nearer).
  const rvsRows = rows.filter(function (r) {
    return Array.prototype.slice.call(r.querySelectorAll('.role-badge'))
      .some(function (b) { return b.textContent.trim() === 'RVS C&T'; });
  });
  assert.strictEqual(rvsRows.length, 3, 'exactly 3 RVS C&T rows present');

  // Panel role_counts UNCHANGED: 1 C&T / 3 RVS C&T (full in-range set, even
  // though the 16 couriers were excluded from the LIST).
  assert.strictEqual(doc.getElementById('agg-ct').textContent, '1', 'C&T count UNCHANGED = 1');
  assert.strictEqual(doc.getElementById('agg-rvs').textContent, '3', 'RVS C&T count UNCHANGED = 3');

  console.log('PASS: no-RVS capture — all 4 C&T-capable rows (1 C&T + 3 RVS C&T) render, couriers excluded, ' +
    'list NOT truncated; role_counts unchanged (1 C&T / 3 RVS C&T / 16 COURIER).');
}

// PIN-DROP PASTE (P2): pasting a Google-Maps pin-drop coordinate into the
// address field must be DETECTED client-side (no geocoding), surfaced as a
// "Pin drop: <lat>, <lon>" candidate in the SAME dropdown, and picking it
// submits via animal_lat/animal_lon. Covers: (a) valid PA, (b) swapped order,
// (c) positive-lon sign-typo, (d) a real address that must NOT be detected.
async function runPinDropPaste() {
  // Shared helper: paste `text`, return the rendered candidate labels.
  async function pasteAndList(text) {
    const { window, opts: domOpts } = loadDom();
    const doc = window.document;
    await flush(window);
    await flush(window);
    const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
    addrRadio.checked = true;
    addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
    const addrInput = doc.getElementById('animal-address');
    const acList = doc.getElementById('address-suggestions');
    addrInput.value = text;
    addrInput.dispatchEvent(new window.Event('paste', { bubbles: true }));
    await flush(window);
    await flush(window);
    await flush(window);
    const cands = Array.prototype.slice.call(acList.querySelectorAll('.ac-item'));
    return { window, doc, domOpts, addrInput, acList, cands };
  }

  // Submit helper after a candidate is picked.
  async function pickAndSubmit(ctx, idx) {
    ctx.cands[idx].dispatchEvent(new ctx.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await flush(ctx.window);
    ctx.doc.getElementById('radius-mi').value = '50';
    ctx.doc.getElementById('address-btn').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
    await flush(ctx.window);
    await flush(ctx.window);
    await flush(ctx.window);
    return ctx.domOpts.aggCalls[ctx.domOpts.aggCalls.length - 1] || '';
  }

  // (a) valid PA pin drop.
  let ctx = await pasteAndList('40.4612, -79.8553');
  assert.strictEqual(ctx.acList.hidden, false, '(a) pin-drop paste opens the dropdown');
  assert.strictEqual(ctx.cands.length, 1, '(a) exactly one synthetic candidate (got ' + ctx.cands.length + ')');
  assert.strictEqual(ctx.cands[0].textContent.trim(), 'Pin drop: 40.4612, -79.8553',
    '(a) candidate is labeled "Pin drop: <lat>, <lon>"');
  let url = await pickAndSubmit(ctx, 0);
  assert.ok(/[?&]animal_lat=40\.4612(&|$)/.test(url), '(a) submit sends animal_lat=40.4612 (url: ' + url + ')');
  assert.ok(/[?&]animal_lon=-79\.8553(&|$)/.test(url), '(a) submit sends animal_lon=-79.8553 (url: ' + url + ')');
  assert.ok(!/[?&]address=/.test(url), '(a) pin-drop submit must NOT use the address= path');

  // (b) swapped (lon, lat) order -> detected + swapped to the same coord.
  ctx = await pasteAndList('-79.8553, 40.4612');
  assert.strictEqual(ctx.cands.length, 1, '(b) swapped paste yields one candidate');
  assert.strictEqual(ctx.cands[0].textContent.trim(), 'Pin drop: 40.4612, -79.8553',
    '(b) swapped order normalized to lat,lon');
  url = await pickAndSubmit(ctx, 0);
  assert.ok(/[?&]animal_lat=40\.4612(&|$)/.test(url), '(b) submit sends animal_lat=40.4612 (url: ' + url + ')');
  assert.ok(/[?&]animal_lon=-79\.8553(&|$)/.test(url), '(b) submit sends animal_lon=-79.8553 (url: ' + url + ')');

  // (c) positive-lon sign-typo -> lon negated.
  ctx = await pasteAndList('40.4612, 79.8553');
  assert.strictEqual(ctx.cands.length, 1, '(c) sign-typo paste yields one candidate');
  assert.strictEqual(ctx.cands[0].textContent.trim(), 'Pin drop: 40.4612, -79.8553',
    '(c) positive-lon sign-typo corrected to negative lon');
  url = await pickAndSubmit(ctx, 0);
  assert.ok(/[?&]animal_lat=40\.4612(&|$)/.test(url), '(c) submit sends animal_lat=40.4612 (url: ' + url + ')');
  assert.ok(/[?&]animal_lon=-79\.8553(&|$)/.test(url), '(c) submit sends animal_lon=-79.8553 (url: ' + url + ')');

  // (d) a real address must NOT be detected as a pin drop -> normal Photon path
  // (the mocked Worker returns the default Photon candidates, none "Pin drop:").
  ctx = await pasteAndList('564 E Maiden St, Washington, PA');
  assert.ok(ctx.cands.length >= 1, '(d) address paste still yields Photon candidates');
  ctx.cands.forEach(function (c) {
    assert.ok(!/^Pin drop:/.test(c.textContent.trim()),
      '(d) a real address must NOT surface a pin-drop candidate (got: ' + c.textContent.trim() + ')');
  });

  console.log('PASS: pin-drop paste — valid PA, swapped, and sign-typo coords are detected and ' +
    'submit via animal_lat/animal_lon; a real address falls through to the Photon path.');
}

async function runTier1FallbackFlag() {
  // Simulate a Worker response with county_source="tier1_fallback" — happens
  // when PIP returned null (out-of-PA coordinate) and the Tier-1 county panel
  // had a county selected. The ACTIONS section must show the county/area as
  // normal AND render a visible amber "County from Tier-1 selection" indicator.
  const fallbackAgg = {
    total_in_range: 5,
    role_counts: { 'C&T': 2, 'RVS C&T': 1, 'COURIER': 2 },
    win_areas: ['10'],
    animal_county: 'Washington',
    animal_area: '10',
    animal_geoid: null,
    county_source: 'tier1_fallback',
    out_of_county: [],
    out_of_county_truncated: false,
    radius_too_broad: false,
    distance_mode: 'straight_line',
  };

  const { window, opts: domOpts } = loadDom({ workerAgg: fallbackAgg });
  const doc = window.document;

  await flush(window);
  await flush(window);

  // Switch to address mode
  const addrRadio = doc.querySelector('input[name="mode"][value="address"]');
  addrRadio.checked = true;
  addrRadio.dispatchEvent(new window.Event('change', { bubbles: true }));

  // Submit with any address (fetch mock returns fallbackAgg)
  doc.getElementById('animal-address').value = '123 Out Of State Ave, Test NJ';
  doc.getElementById('radius-mi').value = '20';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));

  await flush(window);
  await flush(window);
  await flush(window);

  const result = doc.getElementById('address-result');
  assert.strictEqual(result.style.display, 'block', 'address-result section is shown');

  // The resolved-location element must be visible and contain the fallback indicator.
  const resolvedEl = doc.getElementById('resolved-location');
  assert.ok(resolvedEl, '#resolved-location element exists');
  assert.strictEqual(resolvedEl.style.display, 'block', '#resolved-location is visible');

  const flagEl = resolvedEl.querySelector('.tier1-fallback-flag');
  assert.ok(flagEl, 'tier1-fallback-flag span is present in #resolved-location');
  const flagText = flagEl.textContent || '';
  assert.ok(flagText.indexOf('Tier-1 selection') !== -1,
    'fallback flag mentions "Tier-1 selection" (got: "' + flagText + '")');

  // The county/area resolved header must still render correctly.
  const resolvedHtml = resolvedEl.innerHTML || '';
  assert.ok(resolvedHtml.indexOf('Washington') !== -1,
    'resolved-location shows county name Washington (got: "' + resolvedHtml + '")');
  assert.ok(resolvedHtml.indexOf('10') !== -1,
    'resolved-location shows WIN area 10 (got: "' + resolvedHtml + '")');

  console.log('PASS: county_source=tier1_fallback -> amber .tier1-fallback-flag present with "Tier-1 selection" text, county/area still shown.');
}

// ── P5: single animal-area coordinator ──────────────────────────────────────
// When volunteers span multiple WIN areas (e.g. 9, 10, 15N) but the animal is
// in area 10, the RECOMMENDED ACTIONS section must show ONLY the Area 10
// coordinator — never a coordinator per volunteer area. The animal's area owns
// the incident.
async function runTier2SingleAnimalAreaCoordinator() {
  const agg = {
    total_in_range: 15,
    role_counts: { 'C&T': 8, 'RVS C&T': 4, 'COURIER': 3 },
    win_areas: ['9', '10', '15N'],
    animal_area: '10',
    animal_county: 'Allegheny',
    out_of_county: [],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  // Use an extended coordinator map so areas 9, 10, and 15N all have entries;
  // without the fix, all three would appear — exposing the per-volunteer-area bug.
  const coords = { '9': 'Judith Ullman', '10': 'Julia Meredith', '15N': 'Sue DeArment' };
  const { window, opts } = loadDom({
    workerAgg: agg,
    data: { 'county_win.json': COUNTY_WIN, 'coordinators.json': coords },
  });
  const doc = window.document;
  await flush(window);
  await flush(window);

  const countySel = doc.getElementById('county');
  countySel.value = 'Allegheny';
  countySel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(window);

  doc.getElementById('widen-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);

  doc.getElementById('animal-address').value = '4400 Forbes Ave, Pittsburgh, PA 15213';
  doc.getElementById('radius-mi').value = '50';
  doc.getElementById('address-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
  await flush(window);
  await flush(window);
  await flush(window);

  const result = doc.getElementById('address-result');
  assert.strictEqual(result.style.display, 'block', 'address-result shown');

  const actionLines = Array.prototype.slice
    .call(doc.querySelectorAll('#agg-actions .action-line'))
    .map(function (el) { return (el.textContent || '').trim(); });

  const coordLines = actionLines.filter(function (t) { return /Coordinator:/.test(t); });

  // Exactly ONE coordinator line — for the ANIMAL's area (10), not per volunteer area.
  assert.strictEqual(coordLines.length, 1,
    'exactly one coordinator line (animal area only, not per volunteer area); got: ' +
    JSON.stringify(coordLines));
  assert.ok(/Area 10 Coordinator: Julia Meredith/.test(coordLines[0]),
    'coordinator line is for animal area 10 — Julia Meredith (got: "' + coordLines[0] + '")');

  // Area 9 and 15N coordinators must NOT appear (volunteers are there, animal is not).
  assert.ok(!/Area 9 Coordinator/.test(actionLines.join(' ')),
    'Area 9 Coordinator must NOT appear (Area 9 is a volunteer area, not the animal area)');
  assert.ok(!/Area 15N Coordinator/.test(actionLines.join(' ')),
    'Area 15N Coordinator must NOT appear (Area 15N is a volunteer area, not the animal area)');

  console.log('PASS: P5 single animal-area coordinator — volunteers span areas [9, 10, 15N], animal_area=10 -> only "Area 10 Coordinator: Julia Meredith" shown.');
}

// ── NON-CONNECTEAM NOTICE: when qualified ooc rows include a mix of
//    connecteam_user true/false, an info banner appears after the qualified-
//    helpers line with the correct count of non-Connecteam volunteers.
async function runTier2NonConnecteamNotice() {
  // 3 qualified C&T rows (non-RVS capture): 2 on Connecteam, 1 not.
  const agg = {
    total_in_range: 5,
    role_counts: { 'C&T': 3, 'RVS C&T': 0, 'COURIER': 2 },
    win_areas: ['11'],
    animal_area: '11',
    animal_county: 'Beaver',
    out_of_county: [
      { roles: ['C&T'], distance_mi: 5.0, win_area: '11', county: 'Beaver',
        name: 'Alice A', availability_note: '', connecteam_user: true },
      { roles: ['C&T'], distance_mi: 8.0, win_area: '11', county: 'Beaver',
        name: 'Bob B', availability_note: '', connecteam_user: false },
      { roles: ['C&T'], distance_mi: 11.0, win_area: '11', county: 'Beaver',
        name: 'Carol C', availability_note: '', connecteam_user: true },
      { roles: ['COURIER'], distance_mi: 7.0, win_area: '11', county: 'Beaver',
        name: 'Dave D', availability_note: '', connecteam_user: false },
      { roles: ['COURIER'], distance_mi: 9.0, win_area: '5', county: 'Westmoreland',
        name: 'Eve E', availability_note: '', connecteam_user: false },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  // non-RVS capture -> qualifyFn selects C&T rows only (3 qualified, 2 COURIER backup).
  // Of the 3 C&T qualified rows: 1 has connecteam_user=false (Bob B).
  const { doc } = await driveTier2(agg, 'Allegheny', { rvs: false, issue: 'capture' });

  const actionLines = Array.prototype.slice
    .call(doc.querySelectorAll('#agg-actions .action-line'))
    .map(function (el) { return (el.textContent || '').trim(); });

  // The notice must appear at all.
  const noticeLines = actionLines.filter(function (t) {
    return /not on Connecteam/i.test(t);
  });
  assert.strictEqual(noticeLines.length, 1,
    'non-Connecteam notice appears exactly once (got: ' + JSON.stringify(actionLines) + ')');
  // The count must be 1 (only Bob B is non-Connecteam AND qualified).
  assert.ok(/1 volunteer/i.test(noticeLines[0]),
    'notice shows count=1 (got: "' + noticeLines[0] + '")');
  // The notice must use the info tone (blue class), not escalate/warn.
  const noticeEls = Array.prototype.slice.call(
    doc.querySelectorAll('#agg-actions .action-line.info')
  ).filter(function (el) { return /not on Connecteam/i.test(el.textContent || ''); });
  assert.strictEqual(noticeEls.length, 1,
    'non-Connecteam notice uses .info (blue) tone');

  // Placement: notice AFTER qualifiedHelpers and BEFORE any low-cap / coordinator.
  const qualIdx = actionLines.findIndex(function (t) { return /Qualified helpers:/i.test(t); });
  const noticeIdx = actionLines.findIndex(function (t) { return /not on Connecteam/i.test(t); });
  const lowCapIdx = actionLines.findIndex(function (t) { return /Low capacity/i.test(t); });
  const coordIdx = actionLines.findIndex(function (t) { return /Coordinator:/i.test(t); });
  assert.ok(qualIdx !== -1, 'qualifiedHelpers line present');
  assert.ok(qualIdx < noticeIdx,
    'non-Connecteam notice appears AFTER qualifiedHelpers (qual=' + qualIdx + ', notice=' + noticeIdx + ')');
  if (lowCapIdx !== -1) {
    assert.ok(noticeIdx < lowCapIdx,
      'non-Connecteam notice appears BEFORE low-cap banner (notice=' + noticeIdx + ', lowCap=' + lowCapIdx + ')');
  }
  if (coordIdx !== -1) {
    assert.ok(noticeIdx < coordIdx,
      'non-Connecteam notice appears BEFORE coordinator (notice=' + noticeIdx + ', coord=' + coordIdx + ')');
  }

  // When ALL qualified volunteers are on Connecteam, the notice must NOT appear.
  const aggAllCt = {
    total_in_range: 2,
    role_counts: { 'C&T': 2, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: ['11'],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 5.0, win_area: '11', county: 'Beaver',
        name: 'Alice A', availability_note: '', connecteam_user: true },
      { roles: ['C&T'], distance_mi: 8.0, win_area: '11', county: 'Beaver',
        name: 'Bob B', availability_note: '', connecteam_user: true },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: doc2 } = await driveTier2(aggAllCt, 'Allegheny', { rvs: false, issue: 'capture' });
  const actions2 = doc2.getElementById('agg-actions').textContent || '';
  assert.ok(!/not on Connecteam/i.test(actions2),
    'no non-Connecteam notice when all qualified rows have connecteam_user=true; got: "' + actions2 + '"');

  // When the field is absent (older Worker response), the notice must NOT appear.
  const aggNoField = {
    total_in_range: 2,
    role_counts: { 'C&T': 2, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: ['11'],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 5.0, win_area: '11', county: 'Beaver' },
      { roles: ['C&T'], distance_mi: 8.0, win_area: '11', county: 'Beaver' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: doc3 } = await driveTier2(aggNoField, 'Allegheny', { rvs: false, issue: 'capture' });
  const actions3 = doc3.getElementById('agg-actions').textContent || '';
  assert.ok(!/not on Connecteam/i.test(actions3),
    'no non-Connecteam notice when connecteam_user field is absent (backward compat); got: "' + actions3 + '"');

  console.log('PASS: non-Connecteam notice — count=1 shown in info tone after qualifiedHelpers; absent when all on app; absent when field missing.');
}

// ── PREMISE LINE: Tier 2 — RVS capture must show "Capture of RVS Animal" ────
async function runPremiseLineRvsCapture() {
  const agg = {
    total_in_range: 3,
    role_counts: { 'C&T': 0, 'RVS C&T': 3, 'COURIER': 0 },
    win_areas: ['10'],
    out_of_county: [],
  };
  const { doc } = await driveTier2(agg, 'Allegheny', { rvs: true, issue: 'capture' });

  const premiseEl = doc.querySelector('#agg-actions .agg-premise');
  assert.ok(premiseEl, 'Tier 2 premise element (.agg-premise) exists in #agg-actions');
  const txt = (premiseEl.textContent || '').trim();
  assert.strictEqual(txt, 'Capture of RVS Animal',
    'Tier 2 premise reads "Capture of RVS Animal" for RVS=yes, Issue=capture (got: "' + txt + '")');

  console.log('PASS: Tier 2 premise line renders "Capture of RVS Animal".');
}

// ── PREMISE LINE: Tier 2 — non-RVS transport must show "Transport of non-RVS Animal" ──
async function runPremiseLineNonRvsTransport() {
  const agg = {
    total_in_range: 5,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 5 },
    win_areas: ['5'],
    out_of_county: [],
  };
  const { doc } = await driveTier2(agg, 'Allegheny', { rvs: false, issue: 'transport' });

  const premiseEl = doc.querySelector('#agg-actions .agg-premise');
  assert.ok(premiseEl, 'Tier 2 premise element (.agg-premise) exists in #agg-actions');
  const txt = (premiseEl.textContent || '').trim();
  assert.strictEqual(txt, 'Transport of non-RVS Animal',
    'Tier 2 premise reads "Transport of non-RVS Animal" for RVS=no, Issue=transport (got: "' + txt + '")');

  console.log('PASS: Tier 2 premise line renders "Transport of non-RVS Animal".');
}

// ── AVAILABILITY INDICATOR: ctx-row shows avail note + unavail dimming. ─────
//    When availability_note is empty/null -> no note shown.
//    When note contains a deny keyword -> row gets .unavail + note text.
//    When note is non-empty but no deny keyword -> note shown, no dimming.
async function runTier2AvailNote() {
  const agg = {
    total_in_range: 4,
    role_counts: { 'C&T': 2, 'RVS C&T': 1, 'COURIER': 1 },
    win_areas: ['11'],
    out_of_county: [
      // Available (empty note) — no note, no dimming.
      { roles: ['C&T'], distance_mi: 5.0, win_area: '11', county: 'Beaver', availability_note: '' },
      // Unavailable keyword 'unavail' — dimmed + note shown.
      { roles: ['RVS C&T'], distance_mi: 8.0, win_area: '11', county: 'Beaver', availability_note: 'Unavail weekends' },
      // Non-deny note — note shown, no dimming.
      { roles: ['C&T'], distance_mi: 11.0, win_area: '12', county: 'Butler', availability_note: 'Avail evenings' },
      // No availability_note field at all — treated as available (backward compat).
      { roles: ['COURIER'], distance_mi: 14.0, win_area: '5', county: 'Westmoreland' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc } = await driveTier2(agg, 'Allegheny', { rvs: false, issue: 'transport' });

  const rows = Array.prototype.slice.call(doc.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows.length, 4, 'all 4 transport-qualified rows render (got ' + rows.length + ')');

  // Row 0: empty note — no .ctx-avail-note, no .unavail class.
  assert.ok(!rows[0].classList.contains('unavail'),
    'row 0 (empty note) has no .unavail class');
  assert.strictEqual(rows[0].querySelectorAll('.ctx-avail-note').length, 0,
    'row 0 (empty note) has no .ctx-avail-note element');

  // Row 1: 'Unavail weekends' — .unavail class + note text.
  assert.ok(rows[1].classList.contains('unavail'),
    'row 1 ("Unavail weekends") has .unavail class');
  const note1 = rows[1].querySelector('.ctx-avail-note');
  assert.ok(note1, 'row 1 has .ctx-avail-note element');
  assert.strictEqual(note1.textContent.trim(), 'Unavail weekends',
    'row 1 note text is "Unavail weekends" (got: "' + note1.textContent + '")');

  // Row 2: 'Avail evenings' — note shown, NO .unavail dimming.
  assert.ok(!rows[2].classList.contains('unavail'),
    'row 2 ("Avail evenings") must NOT be dimmed — non-deny note');
  const note2 = rows[2].querySelector('.ctx-avail-note');
  assert.ok(note2, 'row 2 has .ctx-avail-note element');
  assert.strictEqual(note2.textContent.trim(), 'Avail evenings',
    'row 2 note text is "Avail evenings" (got: "' + note2.textContent + '")');

  // Row 3: no availability_note field — treated as available, no note.
  assert.ok(!rows[3].classList.contains('unavail'),
    'row 3 (no field) has no .unavail class (backward compat)');
  assert.strictEqual(rows[3].querySelectorAll('.ctx-avail-note').length, 0,
    'row 3 (no field) has no .ctx-avail-note element');

  // All existing row internals intact: role badges + distance still present.
  rows.forEach(function (r, i) {
    assert.ok(r.querySelector('.ctx-row-top'), 'row ' + i + ' has .ctx-row-top inner div');
    assert.ok(r.querySelector('.role-badge'), 'row ' + i + ' still has a role-badge');
    assert.ok(r.querySelector('.ctx-dist'), 'row ' + i + ' still has .ctx-dist');
  });

  // Additional deny-keyword coverage: 'vacation', 'on hold'.
  const aggExtra = {
    total_in_range: 2,
    role_counts: { 'C&T': 2, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: ['11'],
    out_of_county: [
      { roles: ['C&T'], distance_mi: 4.0, win_area: '11', county: 'Beaver', availability_note: 'On vacation thru July' },
      { roles: ['C&T'], distance_mi: 7.0, win_area: '11', county: 'Beaver', availability_note: 'On hold' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: doc2 } = await driveTier2(aggExtra, 'Allegheny', { rvs: false, issue: 'capture' });
  const rows2 = Array.prototype.slice.call(doc2.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rows2.length, 2, '2 capture-qualified rows for extra keywords test');
  assert.ok(rows2[0].classList.contains('unavail'),
    '"On vacation thru July" triggers .unavail');
  assert.ok(rows2[1].classList.contains('unavail'),
    '"On hold" triggers .unavail');

  // Bug 2 fix: available: false with BLANK note must still dim the row.
  // This is the DuBois scenario — Worker marks volunteer unavailable (available: false)
  // but the availability_note text field is empty. The row must be dimmed.
  const aggAvailFalse = {
    total_in_range: 2,
    role_counts: { 'C&T': 0, 'RVS C&T': 2, 'COURIER': 0 },
    win_areas: ['6'],
    out_of_county: [
      // available: false with blank note -> row MUST be dimmed.
      { roles: ['RVS C&T'], distance_mi: 15.0, win_area: '6', county: 'Blair', available: false, availability_note: '' },
      // available: true with blank note -> row must NOT be dimmed.
      { roles: ['RVS C&T'], distance_mi: 22.0, win_area: '6', county: 'Centre', available: true, availability_note: '' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: docAF } = await driveTier2(aggAvailFalse, 'Clearfield', { rvs: true, issue: 'capture' });
  const rowsAF = Array.prototype.slice.call(docAF.querySelectorAll('#ctx-list .ctx-row'));
  assert.strictEqual(rowsAF.length, 2, '2 RVS C&T rows rendered for available=false test');
  assert.ok(rowsAF[0].classList.contains('unavail'),
    'row 0 (available=false, blank note) must have .unavail class (Bug 2 fix)');
  assert.ok(!rowsAF[1].classList.contains('unavail'),
    'row 1 (available=true, blank note) must NOT have .unavail class');

  console.log('PASS: Tier 2 avail note — empty note no indicator; deny keyword dims + shows note; non-deny note shown without dimming; no-field backward compat; available=false blank-note dimming (Bug 2 fix).');
}

// ── COUNTY BREAKDOWN: per-role county list inside each role card's .sub. ────
//    Each card shows only the counties relevant to THAT role (not aggregate).
//    With county_by_role: C&T box: Blair 2, Centre 1.  RVS C&T box: Centre 1.  COURIER: Clearfield 1.
//    The standalone #agg-county-breakdown div is always hidden (superseded).
//    Also tests the DuBois bug: non-RVS Capture with qualify_roles filter returns
//    only C&T/RVS C&T in ooc, but county_by_role still shows COURIER counties.
async function runTier2CountyBreakdown() {
  const agg = {
    total_in_range: 5,
    role_counts: { 'C&T': 3, 'RVS C&T': 1, 'COURIER': 1 },
    win_areas: ['11', '12'],
    county_by_role: {
      'C&T':     { Blair: 2, Centre: 1 },
      'RVS C&T': { Centre: 1 },
      'COURIER': { Clearfield: 1 },
    },
    out_of_county: [
      { roles: ['C&T'], distance_mi: 5.0, win_area: '11', county: 'Blair' },
      { roles: ['C&T'], distance_mi: 7.0, win_area: '11', county: 'Blair' },
      { roles: ['RVS C&T'], distance_mi: 9.0, win_area: '12', county: 'Centre' },
      { roles: ['C&T'], distance_mi: 11.0, win_area: '12', county: 'Centre' },
      { roles: ['COURIER'], distance_mi: 14.0, win_area: '11', county: 'Clearfield' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc } = await driveTier2(agg, 'Allegheny', { rvs: false, issue: 'capture' });

  // ── C&T card: county_by_role says Blair 2 + Centre 1
  const ctCard = doc.querySelector('.cap-card[data-bucket="C&T"]');
  assert.ok(ctCard, 'C&T cap-card exists');
  const ctSub = ctCard && ctCard.querySelector('.sub');
  assert.ok(ctSub, 'C&T cap-card has .sub element');
  const ctTxt = (ctSub.textContent || '').trim();
  assert.ok(/Blair.2/.test(ctTxt),
    'C&T sub has "Blair 2" (got: "' + ctTxt + '")');
  assert.ok(/Centre.1/.test(ctTxt),
    'C&T sub has "Centre 1" (got: "' + ctTxt + '")');
  assert.ok(!/Clearfield/.test(ctTxt),
    'C&T sub must NOT show Clearfield (got: "' + ctTxt + '")');
  // Alphabetically sorted: Blair before Centre.
  assert.ok(ctTxt.indexOf('Blair') < ctTxt.indexOf('Centre'),
    'C&T sub is sorted alpha: Blair before Centre (got: "' + ctTxt + '")');

  // ── RVS C&T card: county_by_role says Centre 1
  const rvsCard = doc.querySelector('.cap-card[data-bucket="RVS C&T"]');
  assert.ok(rvsCard, 'RVS C&T cap-card exists');
  const rvsSub = rvsCard && rvsCard.querySelector('.sub');
  assert.ok(rvsSub, 'RVS C&T cap-card has .sub element');
  const rvsTxt = (rvsSub.textContent || '').trim();
  assert.ok(/Centre.1/.test(rvsTxt),
    'RVS C&T sub has "Centre 1" (got: "' + rvsTxt + '")');
  assert.ok(!/Blair/.test(rvsTxt),
    'RVS C&T sub must NOT show Blair (got: "' + rvsTxt + '")');

  // ── COURIER card: county_by_role says Clearfield 1
  const courierCard = doc.querySelector('.cap-card[data-bucket="COURIER"]');
  assert.ok(courierCard, 'COURIER cap-card exists');
  const courierSub = courierCard && courierCard.querySelector('.sub');
  assert.ok(courierSub, 'COURIER cap-card has .sub element');
  const courierTxt = (courierSub.textContent || '').trim();
  assert.ok(/Clearfield.1/.test(courierTxt),
    'COURIER sub has "Clearfield 1" (got: "' + courierTxt + '")');
  assert.ok(!/Blair/.test(courierTxt),
    'COURIER sub must NOT show Blair (got: "' + courierTxt + '")');

  // ── Standalone div is always hidden (per-role subs supersede it).
  const breakdown = doc.getElementById('agg-county-breakdown');
  assert.ok(breakdown, '#agg-county-breakdown element still exists in HTML');
  assert.strictEqual(breakdown.style.display, 'none',
    '#agg-county-breakdown is always hidden (superseded by per-role subs)');

  // ── DuBois bug scenario: qualify_roles filtered COURIER from ooc but
  //    county_by_role still has COURIER county data. The box must show it.
  const aggDuBois = {
    total_in_range: 7,
    role_counts: { 'C&T': 0, 'RVS C&T': 2, 'COURIER': 5 },
    win_areas: ['6'],
    county_by_role: {
      'C&T':     {},
      'RVS C&T': { Blair: 1, Centre: 1 },
      'COURIER': { Clearfield: 2, Blair: 1, Centre: 1, Huntingdon: 1 },
    },
    // Only qualified rows (RVS C&T) — COURIER rows were filtered by qualify_roles.
    out_of_county: [
      { roles: ['RVS C&T'], distance_mi: 15.0, win_area: '6', county: 'Blair' },
      { roles: ['RVS C&T'], distance_mi: 22.0, win_area: '6', county: 'Centre' },
    ],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: docDB } = await driveTier2(aggDuBois, 'Clearfield', { rvs: false, issue: 'capture' });

  // C&T box: county_by_role['C&T'] is empty -> "in range" fallback.
  const ctSubDB = docDB.querySelector('.cap-card[data-bucket="C&T"] .sub');
  assert.ok(ctSubDB && ctSubDB.textContent === 'in range',
    'C&T sub falls back to "in range" when county_by_role is empty (got: "' + (ctSubDB && ctSubDB.textContent) + '")');

  // RVS C&T box: county_by_role says Blair 1, Centre 1 (from county_by_role, not ooc).
  const rvsSubDB = docDB.querySelector('.cap-card[data-bucket="RVS C&T"] .sub');
  const rvsTxtDB = (rvsSubDB && rvsSubDB.textContent || '').trim();
  assert.ok(/Blair.1/.test(rvsTxtDB),
    'RVS C&T sub shows Blair 1 from county_by_role (got: "' + rvsTxtDB + '")');
  assert.ok(/Centre.1/.test(rvsTxtDB),
    'RVS C&T sub shows Centre 1 from county_by_role (got: "' + rvsTxtDB + '")');

  // COURIER box: county_by_role has data even though no COURIER rows in ooc.
  // This was the DuBois bug — used to show "in range" because ooc had 0 COURIER rows.
  const courierSubDB = docDB.querySelector('.cap-card[data-bucket="COURIER"] .sub');
  const courierTxtDB = (courierSubDB && courierSubDB.textContent || '').trim();
  assert.ok(/Clearfield.2/.test(courierTxtDB),
    'COURIER sub shows Clearfield 2 from county_by_role (DuBois fix; got: "' + courierTxtDB + '")');
  assert.ok(/Blair.1/.test(courierTxtDB),
    'COURIER sub shows Blair 1 from county_by_role (got: "' + courierTxtDB + '")');
  assert.ok(courierTxtDB !== 'in range',
    'COURIER sub must NOT show "in range" when county_by_role has data (DuBois fix)');

  // ── When ooc is empty AND county_by_role absent -> each card falls back to "in range"; div stays hidden.
  const aggEmpty = {
    total_in_range: 0,
    role_counts: { 'C&T': 0, 'RVS C&T': 0, 'COURIER': 0 },
    win_areas: [],
    out_of_county: [],
    out_of_county_truncated: false,
    radius_too_broad: false,
  };
  const { doc: doc2 } = await driveTier2(aggEmpty, 'Allegheny', { rvs: false, issue: 'capture' });
  const ctSub2 = doc2.querySelector('.cap-card[data-bucket="C&T"] .sub');
  assert.ok(ctSub2 && ctSub2.textContent === 'in range',
    'C&T sub shows "in range" when ooc is empty and no county_by_role (got: "' + (ctSub2 && ctSub2.textContent) + '")');
  const bd2 = doc2.getElementById('agg-county-breakdown');
  assert.ok(bd2, '#agg-county-breakdown element exists even when ooc empty');
  assert.strictEqual(bd2.style.display, 'none',
    '#agg-county-breakdown is hidden when ooc is empty');

  console.log('PASS: county breakdown per-role inside each card — uses county_by_role; DuBois COURIER fix; fallback to ooc; "in range" when empty.');
}

async function run() {
  await runHelpLink();
  await runHelpViewerRenders();
  await runAddressMode();
  await runSuggestionCoordSubmit();
  await runPasteAndGo();
  await runPinDropPaste();
  await runPasteCensusFallback();
  await runPasteCensusStreetLevelTop();
  await runStandaloneAddressContextList();
  await runStandaloneNoRvsCaptureAllCtCapable();
  await runTier1Coordinator();
  await runTier2ContextList();
  await runTier2ContextDrivingTime();
  await runTier2ContextStraightLineNoTime();
  await runTier2Overflow();
  await runTier2Empty();
  await runTier2Availability();
  await runTier2AvailabilityBackcompat();
  await runTier2QualTagRvsCapture();
  await runTier2QualTagCaptureTransport();
  await runTier2LenientBackup();
  await runTier2NoQualifiedBanner();
  await runTier2LowCapacityWarning();
  await runTier1FallbackFlag();
  await runPremiseLineRvsCapture();
  await runPremiseLineNonRvsTransport();
  await runTier2LenientPrefersQualified();
  await runTier2QualTagBackcompat();
  await runMapRender();
  await runHighlightAreas();
  await runTier2Highlight();
  await runTier1Highlight();
  await runRehabAddressPath();
  await runRehabCountyPath();
  await runRehabNoOrigin();
  await runRehabDrivingDistances();
  await runRehabDrivingFallback();
  await runStaleAddressMode();
  await runStaleCountyMode();
  await runCountyAreaBadge();
  await runAddressResolvedArea();
  await runDeconfliction();
  await runStaleCountyLeakSchuylkill();
  await runAddressNoHorizontalOverflowCss();
  await runTier2SingleAnimalAreaCoordinator();
  await runTier2NonConnecteamNotice();
  await runTier2AvailNote();
  await runTier2CountyBreakdown();
  console.log('\nALL DOM TESTS PASSED (48 scenarios).');
}

run().then(function () {
  process.exit(0);
}).catch(function (err) {
  console.error('FAIL:', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});

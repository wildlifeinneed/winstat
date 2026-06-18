'use strict';
/**
 * REAL-DOM regression test for the PAGE-LEVEL maintenance flag system.
 *
 * Loads the ACTUAL docs/assets/flags.js (via require — it exports its API under
 * module.exports in a CommonJS context) and exercises:
 *
 *   1. resolveEnv(hostname)   — prod vs *.pages.dev hostname resolution.
 *   2. resolveState(key, env) — page + sub-panel state lookup + fail-open.
 *   3. applyPanelFlags()      — PAGE-LEVEL primary path against a synthetic
 *      jsdom document carrying a data-panel-key="page-…" wrapper:
 *        - 'live'        -> page wrapper untouched (no class, no banner).
 *        - 'maintenance' -> wrapper gets .is-under-maintenance + ONE injected
 *                           banner with EXACT copy
 *                           "Down for Maintenance, check back later.".
 *        - 'hidden'      -> wrapper display:none.
 *   4. SUB-PANEL fallback — when NO page-level key is present, the per-panel
 *      loop still applies SUB_PANELS states (dormant override mode).
 *   5. Default-live guarantee — every page key (and every sub-panel key)
 *      resolves to 'live' in BOTH envs (committing this is a prod no-op).
 *   6. Wiring check — every page declares its page-level wrapper in the real
 *      docs/*.html, and every page loads flags.js.
 *
 * Run: node test/flags_dom.test.js   (exit 0 = pass, 1 = fail)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DOCS = path.resolve(__dirname, '..', 'docs');
const FLAGS_JS = path.join(DOCS, 'assets', 'flags.js');

const flags = require(FLAGS_JS);

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log('  ✓ ' + label);
}

const BANNER_COPY = 'Down for Maintenance, check back later.';

console.log('flags.js — env + state resolution');

// ── 1. resolveEnv ──────────────────────────────────────────────────────────
ok("resolveEnv('wildlifeinneed.github.io') === 'prod'",
  flags.resolveEnv('wildlifeinneed.github.io') === 'prod');
ok("resolveEnv('winstat.pages.dev') === 'dev'",
  flags.resolveEnv('winstat.pages.dev') === 'dev');
ok("resolveEnv('abc123.winstat.pages.dev') === 'dev' (nested preview)",
  flags.resolveEnv('abc123.winstat.pages.dev') === 'dev');
ok("resolveEnv('pages.dev') === 'dev'",
  flags.resolveEnv('pages.dev') === 'dev');
ok("resolveEnv('example.com') === 'prod' (unknown -> prod)",
  flags.resolveEnv('example.com') === 'prod');
ok("resolveEnv('') === 'prod' (file:// / empty -> prod)",
  flags.resolveEnv('') === 'prod');
ok("resolveEnv('evil-pages.dev.attacker.com') === 'prod' (suffix spoof blocked)",
  flags.resolveEnv('evil-pages.dev.attacker.com') === 'prod');

// ── 2. resolveState fail-open + table selection ─────────────────────────────
ok("resolveState('does-not-exist','prod') === 'live' (unknown -> live)",
  flags.resolveState('does-not-exist', 'prod') === 'live');
ok("flags.pages has exactly 5 page-level keys",
  Object.keys(flags.pages).length === 5);
ok("flags.pages keys are the 5 expected page keys",
  ['page-index', 'page-dispatcher', 'page-facilities', 'page-equipment', 'page-help']
    .every(function (k) { return !!flags.pages[k]; }));

// ── 3. applyPanelFlags — PAGE-LEVEL primary path ─────────────────────────────
console.log('flags.js — applyPanelFlags PAGE-LEVEL application');

// Build a page-level doc: <body data-panel-key="page-X"> with several inner
// panels. The whole page should get the page state applied to the wrapper.
function makePageDoc(pageKey, innerKeys) {
  const dom = new JSDOM('<!doctype html><html><body data-panel-key="' + pageKey + '"></body></html>');
  const doc = dom.window.document;
  (innerKeys || []).forEach(function (k) {
    const el = doc.createElement('section');
    el.setAttribute('data-panel-key', k);
    const child = doc.createElement('p');
    child.textContent = 'content of ' + k;
    el.appendChild(child);
    doc.body.appendChild(el);
  });
  return { dom: dom, doc: doc };
}

(function () {
  const cfg = flags.pages;
  const KEY = 'page-dispatcher';
  const saved = Object.assign({}, cfg[KEY]);

  // maintenance on prod, live on dev.
  cfg[KEY] = { prod: 'maintenance', dev: 'live' };

  // PROD: page wrapper dimmed + ONE banner; inner sub-panel keys NOT touched.
  const built = makePageDoc(KEY, ['dispatcher-county-mode', 'dispatcher-map-panel']);
  const doc = built.doc;
  const applied = flags.applyPanelFlags({ hostname: 'wildlifeinneed.github.io', doc: doc });
  const pageEl = doc.querySelector('[data-panel-key="' + KEY + '"]');

  ok("page-level: applied map reports only the page key",
    applied[KEY] === 'maintenance' && Object.keys(applied).length === 1);
  ok("page-level maintenance: wrapper has .is-under-maintenance",
    pageEl.classList.contains('is-under-maintenance'));
  const banner = pageEl.querySelector('[data-maint-banner]');
  ok("page-level maintenance: banner injected", !!banner);
  ok("page-level maintenance: ONE banner only",
    pageEl.querySelectorAll('[data-maint-banner]').length === 1);
  ok("page-level maintenance: banner uses .status-strip.construction palette",
    banner.classList.contains('status-strip') && banner.classList.contains('construction'));
  ok("page-level maintenance: banner copy is EXACT",
    banner.textContent.indexOf(BANNER_COPY) !== -1);
  ok("page-level maintenance: banner is FIRST child (top of page)",
    pageEl.firstChild === banner);
  ok("page-level maintenance: inner sub-panels NOT individually flagged",
    !doc.querySelector('[data-panel-key="dispatcher-county-mode"]').classList.contains('is-under-maintenance') &&
    !doc.querySelector('[data-panel-key="dispatcher-county-mode"]').querySelector('[data-maint-banner]'));

  // idempotency: running twice does not inject a second banner.
  flags.applyPanelFlags({ hostname: 'wildlifeinneed.github.io', doc: doc });
  ok("page-level maintenance: idempotent (single banner after 2 runs)",
    pageEl.querySelectorAll('[data-maint-banner]').length === 1);

  // DEV env: same page resolves to 'live' -> wrapper untouched.
  const built2 = makePageDoc(KEY, []);
  const doc2 = built2.doc;
  flags.applyPanelFlags({ hostname: 'winstat.pages.dev', doc: doc2 });
  const pageEl2 = doc2.querySelector('[data-panel-key="' + KEY + '"]');
  ok("page-level dev: resolves live (no class, no banner, visible)",
    !pageEl2.classList.contains('is-under-maintenance') &&
    !pageEl2.querySelector('[data-maint-banner]') &&
    pageEl2.style.display !== 'none');

  // hidden state on the page wrapper.
  cfg[KEY] = { prod: 'hidden', dev: 'live' };
  const built3 = makePageDoc(KEY, []);
  const doc3 = built3.doc;
  flags.applyPanelFlags({ hostname: 'wildlifeinneed.github.io', doc: doc3 });
  ok("page-level hidden: wrapper display:none",
    doc3.querySelector('[data-panel-key="' + KEY + '"]').style.display === 'none');

  // live state on the page wrapper -> no-op.
  cfg[KEY] = { prod: 'live', dev: 'live' };
  const built4 = makePageDoc(KEY, []);
  const doc4 = built4.doc;
  flags.applyPanelFlags({ hostname: 'wildlifeinneed.github.io', doc: doc4 });
  const pageEl4 = doc4.querySelector('[data-panel-key="' + KEY + '"]');
  ok("page-level live: wrapper untouched (no class, no banner, visible)",
    !pageEl4.classList.contains('is-under-maintenance') &&
    !pageEl4.querySelector('[data-maint-banner]') &&
    pageEl4.style.display !== 'none');

  cfg[KEY] = saved; // restore
})();

// ── 4. SUB-PANEL fallback (dormant override mode) ────────────────────────────
console.log('flags.js — SUB-PANEL fallback when no page-level key present');
(function () {
  const cfg = flags.subPanels;
  const KEY_LIVE = 'help-manual';
  const KEY_MAINT = 'facilities-grid';
  const KEY_HIDDEN = 'equipment-table';
  const saved = {
    live: Object.assign({}, cfg[KEY_LIVE]),
    maint: Object.assign({}, cfg[KEY_MAINT]),
    hidden: Object.assign({}, cfg[KEY_HIDDEN]),
  };
  cfg[KEY_LIVE] = { prod: 'live', dev: 'live' };
  cfg[KEY_MAINT] = { prod: 'maintenance', dev: 'live' };
  cfg[KEY_HIDDEN] = { prod: 'hidden', dev: 'live' };

  // NOTE: NO page-level key on this body -> fallback to per-panel loop.
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  [KEY_LIVE, KEY_MAINT, KEY_HIDDEN].forEach(function (key) {
    const el = doc.createElement('div');
    el.setAttribute('data-panel-key', key);
    el.appendChild(doc.createElement('p'));
    doc.body.appendChild(el);
  });

  const applied = flags.applyPanelFlags({ hostname: 'wildlifeinneed.github.io', doc: doc });

  ok("sub-panel fallback: applied map reports live/maintenance/hidden",
    applied[KEY_LIVE] === 'live' &&
    applied[KEY_MAINT] === 'maintenance' &&
    applied[KEY_HIDDEN] === 'hidden');

  const liveEl = doc.querySelector('[data-panel-key="' + KEY_LIVE + '"]');
  const maintEl = doc.querySelector('[data-panel-key="' + KEY_MAINT + '"]');
  const hiddenEl = doc.querySelector('[data-panel-key="' + KEY_HIDDEN + '"]');

  ok("sub-panel fallback: live panel untouched",
    !liveEl.classList.contains('is-under-maintenance') &&
    !liveEl.querySelector('[data-maint-banner]') &&
    liveEl.style.display !== 'none');
  ok("sub-panel fallback: maintenance panel dimmed + banner",
    maintEl.classList.contains('is-under-maintenance') &&
    maintEl.querySelector('[data-maint-banner]') &&
    maintEl.querySelector('[data-maint-banner]').textContent.indexOf(BANNER_COPY) !== -1);
  ok("sub-panel fallback: hidden panel display:none",
    hiddenEl.style.display === 'none');

  cfg[KEY_LIVE] = saved.live;
  cfg[KEY_MAINT] = saved.maint;
  cfg[KEY_HIDDEN] = saved.hidden;
})();

// ── 4b. applyCardSync — index.html tool cards mirror target-page state ───────
console.log('flags.js — applyCardSync reflects target-page state onto home cards');
(function () {
  const cfg = flags.pages;
  const KEY = 'page-dispatcher';
  const saved = Object.assign({}, cfg[KEY]);

  // Build a synthetic index.html tool card linking to dispatcher.html, mirroring
  // the real markup (data-card-target + an <a href> derived target).
  function makeCardDoc() {
    const dom = new JSDOM(
      '<!doctype html><html><body data-panel-key="page-index">' +
      '<div class="tools-grid">' +
      '<a class="tool-card" href="dispatcher.html" ' +
      'data-panel-key="index-tool-dispatcher" ' +
      'data-card-target="index-tool-dispatcher">' +
      '<span class="status-badge beta">Beta Testing</span>' +
      '<h3>Dispatch Helper</h3><p>desc</p>' +
      '</a></div></body></html>'
    );
    return dom.window.document;
  }

  // hrefToPageKey is exposed and correct.
  ok("hrefToPageKey('dispatcher.html') === 'page-dispatcher'",
    flags.hrefToPageKey('dispatcher.html') === 'page-dispatcher');
  ok("hrefToPageKey('equipment-transfers.html') === 'page-equipment'",
    flags.hrefToPageKey('equipment-transfers.html') === 'page-equipment');
  ok("hrefToPageKey('facilities.html') === 'page-facilities'",
    flags.hrefToPageKey('facilities.html') === 'page-facilities');
  ok("hrefToPageKey('./dispatcher.html?x=1#frag') strips query/hash/dir",
    flags.hrefToPageKey('./dispatcher.html?x=1#frag') === 'page-dispatcher');
  ok("hrefToPageKey('unknown.html') === null",
    flags.hrefToPageKey('unknown.html') === null);

  // targetPages binding is exported and correct.
  ok("flags.targetPages binds dispatcher card -> page-dispatcher",
    flags.targetPages['index-tool-dispatcher'] === 'page-dispatcher' &&
    flags.targetPages['index-tool-equipment'] === 'page-equipment' &&
    flags.targetPages['index-tool-facilities'] === 'page-facilities');

  // MAINTENANCE on prod -> card inactive + compact badge.
  cfg[KEY] = { prod: 'maintenance', dev: 'live' };
  const docM = makeCardDoc();
  const appliedM = flags.applyCardSync({ hostname: 'wildlifeinneed.github.io', doc: docM });
  const cardM = docM.querySelector('[data-card-target="index-tool-dispatcher"]');
  ok("card-sync maintenance: applied map reports the card state",
    appliedM['index-tool-dispatcher'] === 'maintenance');
  ok("card-sync maintenance: card has .is-inactive",
    cardM.classList.contains('is-inactive'));
  ok("card-sync maintenance: compact badge injected",
    !!cardM.querySelector('[data-maint-card-badge]'));
  ok("card-sync maintenance: ONE badge only (idempotent within a run)",
    cardM.querySelectorAll('[data-maint-card-badge]').length === 1);
  ok("card-sync maintenance: badge uses .status-badge.construction palette",
    cardM.querySelector('[data-maint-card-badge]').classList.contains('status-badge') &&
    cardM.querySelector('[data-maint-card-badge]').classList.contains('construction'));
  ok("card-sync maintenance: card NOT display:none",
    cardM.style.display !== 'none');

  // idempotency across two runs -> still ONE badge, still inactive.
  flags.applyCardSync({ hostname: 'wildlifeinneed.github.io', doc: docM });
  ok("card-sync maintenance: idempotent (single badge after 2 runs)",
    cardM.querySelectorAll('[data-maint-card-badge]').length === 1 &&
    cardM.classList.contains('is-inactive'));

  // DEV env: dispatcher resolves to 'live' here -> card normal.
  const docDev = makeCardDoc();
  flags.applyCardSync({ hostname: 'winstat.pages.dev', doc: docDev });
  const cardDev = docDev.querySelector('[data-card-target="index-tool-dispatcher"]');
  ok("card-sync dev: live target -> card normal (no inactive, no badge, visible)",
    !cardDev.classList.contains('is-inactive') &&
    !cardDev.querySelector('[data-maint-card-badge]') &&
    cardDev.style.display !== 'none');

  // HIDDEN on prod -> card display:none.
  cfg[KEY] = { prod: 'hidden', dev: 'live' };
  const docH = makeCardDoc();
  const appliedH = flags.applyCardSync({ hostname: 'wildlifeinneed.github.io', doc: docH });
  const cardH = docH.querySelector('[data-card-target="index-tool-dispatcher"]');
  ok("card-sync hidden: applied map reports hidden",
    appliedH['index-tool-dispatcher'] === 'hidden');
  ok("card-sync hidden: card display:none",
    cardH.style.display === 'none');

  // LIVE on prod -> clean state (no class, no badge, visible) even if previously dimmed.
  cfg[KEY] = { prod: 'live', dev: 'live' };
  const docL = makeCardDoc();
  // Pre-dirty the card to prove 'live' RESETS it.
  const cardL = docL.querySelector('[data-card-target="index-tool-dispatcher"]');
  cardL.classList.add('is-inactive');
  cardL.appendChild(docL.createElement('span')).setAttribute('data-maint-card-badge', '');
  flags.applyCardSync({ hostname: 'wildlifeinneed.github.io', doc: docL });
  ok("card-sync live: resets card to normal (no inactive, no badge, visible)",
    !cardL.classList.contains('is-inactive') &&
    !cardL.querySelector('[data-maint-card-badge]') &&
    cardL.style.display !== 'none');

  cfg[KEY] = saved; // restore
})();

// ── 5. Default-live guarantee (shipped config) ───────────────────────────────
console.log('flags.js — shipped config defaults to live everywhere');
(function () {
  let allLive = true;
  let offender = null;
  // Check both tables explicitly.
  [flags.pages, flags.subPanels].forEach(function (table) {
    Object.keys(table).forEach(function (key) {
      ['prod', 'dev'].forEach(function (env) {
        const s = flags.resolveState(key, env);
        if (s !== 'live') { allLive = false; offender = key + '/' + env + '=' + s; }
      });
    });
  });
  ok("every shipped page + sub-panel resolves to 'live' in prod AND dev" +
    (offender ? ' (offender: ' + offender + ')' : ''), allLive);
})();

// ── 6. Wiring check: page wrappers + flags.js present in real docs/*.html ─────
console.log('flags.js — page-level wrappers are wired into the real docs/*.html');
(function () {
  const PAGE_FILE = {
    'page-index':      'index.html',
    'page-dispatcher': 'dispatcher.html',
    'page-facilities': 'facilities.html',
    'page-equipment':  'equipment-transfers.html',
    'page-help':       'help.html',
  };
  const html = {};
  Object.keys(PAGE_FILE).forEach(function (k) {
    html[PAGE_FILE[k]] = fs.readFileSync(path.join(DOCS, PAGE_FILE[k]), 'utf8');
  });

  // Every page-level key has a matching data-panel-key wrapper in its page.
  let allWired = true;
  const missing = [];
  Object.keys(PAGE_FILE).forEach(function (key) {
    const src = html[PAGE_FILE[key]];
    if (src.indexOf('data-panel-key="' + key + '"') === -1) {
      allWired = false;
      missing.push(key + ' -> ' + PAGE_FILE[key]);
    }
  });
  ok("every page-level key has a wrapper in its page" +
    (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''), allWired);

  // Every page loads flags.js.
  Object.keys(PAGE_FILE).forEach(function (key) {
    ok(PAGE_FILE[key] + ' includes assets/flags.js',
      html[PAGE_FILE[key]].indexOf('assets/flags.js') !== -1);
  });

  // index.html wires data-card-target onto each of the 3 tool cards.
  const indexSrc = html['index.html'];
  ['index-tool-dispatcher', 'index-tool-equipment', 'index-tool-facilities']
    .forEach(function (cardKey) {
      ok('index.html wires data-card-target="' + cardKey + '"',
        indexSrc.indexOf('data-card-target="' + cardKey + '"') !== -1);
    });
})();

console.log('\nflags_dom.test.js: ' + passed + ' assertions passed.');
process.exit(0);

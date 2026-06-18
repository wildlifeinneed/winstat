'use strict';
/**
 * REAL-DOM regression test for the per-panel maintenance flag system.
 *
 * Loads the ACTUAL docs/assets/flags.js (via require — it exports its API under
 * module.exports in a CommonJS context) and exercises:
 *
 *   1. resolveEnv(hostname)   — prod vs *.pages.dev hostname resolution.
 *   2. resolveState(key, env) — per-panel/per-env state lookup + fail-open.
 *   3. applyPanelFlags()      — against a synthetic jsdom document:
 *        - 'live'        -> untouched (no class, no banner, visible).
 *        - 'maintenance' -> .is-under-maintenance + injected banner with EXACT
 *                           copy "Down for Maintenance, check back later.".
 *        - 'hidden'      -> display:none.
 *   4. Default-live guarantee — every panel in the shipped config resolves to
 *      'live' in BOTH envs (committing this is a production visual no-op).
 *   5. Wiring check — every panel key in the config that belongs to a page is
 *      actually present (data-panel-key or id) in the real docs/*.html.
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

// Build a small jsdom document with one panel per state so applyPanelFlags can
// run against a known, controlled config (we override states via a temp config
// by re-tagging known keys). We reuse REAL config keys to keep it honest.
function makeDoc(overrides) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const doc = dom.window.document;
  // Map each requested key->element so applyPanelFlags(findPanel) locates them.
  Object.keys(overrides).forEach(function (key) {
    const el = doc.createElement('div');
    el.setAttribute('data-panel-key', key);
    const child = doc.createElement('p');
    child.textContent = 'content of ' + key;
    el.appendChild(child);
    doc.body.appendChild(el);
  });
  return { dom: dom, doc: doc };
}

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

// ── 2. resolveState fail-open ───────────────────────────────────────────────
ok("resolveState('does-not-exist','prod') === 'live' (unknown -> live)",
  flags.resolveState('does-not-exist', 'prod') === 'live');

// ── 3. applyPanelFlags state application ─────────────────────────────────────
console.log('flags.js — applyPanelFlags state application');
(function () {
  // Temporarily force three real keys into the three states.
  const cfg = flags.panels;
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

  const built = makeDoc({});
  const doc = built.doc;
  [KEY_LIVE, KEY_MAINT, KEY_HIDDEN].forEach(function (key) {
    const el = doc.createElement('div');
    el.setAttribute('data-panel-key', key);
    const child = doc.createElement('p');
    child.textContent = 'content of ' + key;
    el.appendChild(child);
    doc.body.appendChild(el);
  });

  // PROD env: live untouched, maint dimmed+banner, hidden display:none.
  const applied = flags.applyPanelFlags({ hostname: 'wildlifeinneed.github.io', doc: doc });

  const liveEl = doc.querySelector('[data-panel-key="' + KEY_LIVE + '"]');
  const maintEl = doc.querySelector('[data-panel-key="' + KEY_MAINT + '"]');
  const hiddenEl = doc.querySelector('[data-panel-key="' + KEY_HIDDEN + '"]');

  ok("applied map reports live/maintenance/hidden correctly",
    applied[KEY_LIVE] === 'live' &&
    applied[KEY_MAINT] === 'maintenance' &&
    applied[KEY_HIDDEN] === 'hidden');

  // live
  ok("live panel: no .is-under-maintenance class",
    !liveEl.classList.contains('is-under-maintenance'));
  ok("live panel: no injected banner",
    !liveEl.querySelector('[data-maint-banner]'));
  ok("live panel: not display:none",
    liveEl.style.display !== 'none');

  // maintenance
  ok("maintenance panel: has .is-under-maintenance class",
    maintEl.classList.contains('is-under-maintenance'));
  const banner = maintEl.querySelector('[data-maint-banner]');
  ok("maintenance panel: banner injected", !!banner);
  ok("maintenance panel: banner uses .status-strip.construction palette",
    banner.classList.contains('status-strip') &&
    banner.classList.contains('construction'));
  ok("maintenance panel: banner copy is EXACT",
    banner.textContent.indexOf('Down for Maintenance, check back later.') !== -1);
  ok("maintenance panel: banner is FIRST child (top of panel)",
    maintEl.firstChild === banner);
  ok("maintenance panel: still visible (not display:none)",
    maintEl.style.display !== 'none');

  // hidden
  ok("hidden panel: display:none",
    hiddenEl.style.display === 'none');

  // idempotency: running twice does not inject a second banner.
  flags.applyPanelFlags({ hostname: 'wildlifeinneed.github.io', doc: doc });
  ok("maintenance panel: idempotent (single banner after 2 runs)",
    maintEl.querySelectorAll('[data-maint-banner]').length === 1);

  // DEV env: all three forced to 'live' -> the previously-hidden panel would
  // still be display:none from the prior run, so use a FRESH doc to prove dev
  // resolution independently.
  const built2 = makeDoc({});
  const doc2 = built2.doc;
  [KEY_MAINT, KEY_HIDDEN].forEach(function (key) {
    const el = doc2.createElement('div');
    el.setAttribute('data-panel-key', key);
    el.appendChild(doc2.createElement('p'));
    doc2.body.appendChild(el);
  });
  flags.applyPanelFlags({ hostname: 'winstat.pages.dev', doc: doc2 });
  ok("dev env: maint key resolves live (no class) per per-env config",
    !doc2.querySelector('[data-panel-key="' + KEY_MAINT + '"]').classList.contains('is-under-maintenance'));
  ok("dev env: hidden key resolves live (visible) per per-env config",
    doc2.querySelector('[data-panel-key="' + KEY_HIDDEN + '"]').style.display !== 'none');

  // restore config
  cfg[KEY_LIVE] = saved.live;
  cfg[KEY_MAINT] = saved.maint;
  cfg[KEY_HIDDEN] = saved.hidden;
})();

// ── 4. Default-live guarantee (shipped config) ───────────────────────────────
console.log('flags.js — shipped config defaults to live everywhere');
(function () {
  let allLive = true;
  let offender = null;
  Object.keys(flags.panels).forEach(function (key) {
    ['prod', 'dev'].forEach(function (env) {
      const s = flags.resolveState(key, env);
      if (s !== 'live') { allLive = false; offender = key + '/' + env + '=' + s; }
    });
  });
  ok("every shipped panel resolves to 'live' in prod AND dev" +
    (offender ? ' (offender: ' + offender + ')' : ''), allLive);
})();

// ── 5. Wiring check: config keys exist in the real docs pages ────────────────
console.log('flags.js — panel keys are wired into the real docs/*.html');
(function () {
  const PAGE_PREFIX = {
    'index.html': 'index-',
    'dispatcher.html': 'dispatcher-',
    'facilities.html': 'facilities-',
    'equipment-transfers.html': 'equipment-',
    'help.html': 'help-',
  };
  const html = {};
  Object.keys(PAGE_PREFIX).forEach(function (f) {
    html[f] = fs.readFileSync(path.join(DOCS, f), 'utf8');
  });

  let allWired = true;
  const missing = [];
  Object.keys(flags.panels).forEach(function (key) {
    // find the page whose prefix this key starts with
    const page = Object.keys(PAGE_PREFIX).find(function (f) {
      return key.indexOf(PAGE_PREFIX[f]) === 0;
    });
    if (!page) { allWired = false; missing.push(key + ' (no page prefix)'); return; }
    const src = html[page];
    const present =
      src.indexOf('data-panel-key="' + key + '"') !== -1 ||
      src.indexOf('id="' + key + '"') !== -1;
    if (!present) { allWired = false; missing.push(key + ' -> ' + page); }
  });
  ok("every config panel key is present in its page" +
    (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''), allWired);

  // Every page that includes a flaggable panel must load flags.js.
  Object.keys(PAGE_PREFIX).forEach(function (f) {
    ok(f + ' includes assets/flags.js',
      html[f].indexOf('assets/flags.js') !== -1);
  });
})();

console.log('\nflags_dom.test.js: ' + passed + ' assertions passed.');
process.exit(0);

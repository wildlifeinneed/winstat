/* flags.js — SINGLE SOURCE OF TRUTH for maintenance flags (PAGE-LEVEL).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 *
 *  Each of the 5 docs/ pages has ONE stable PAGE KEY and a per-ENVIRONMENT
 *  state. The runtime (applyPanelFlags) reads the hostname on
 *  DOMContentLoaded, finds the page-level wrapper (the element carrying
 *  data-panel-key="page-…"), resolves its state for THIS env, and applies one
 *  of three states to the WHOLE page at once:
 *
 *    'live'        — no-op (normal render).
 *    'maintenance' — the page wrapper stays in the layout but is dimmed/
 *                    de-saturated (class .is-under-maintenance) AND a SINGLE
 *                    "under construction" banner is injected at the top.
 *    'hidden'      — the page wrapper is removed from view (display:none).
 *
 *  ONE identical file serves BOTH branches: each page declares
 *  { prod: <state>, dev: <state> } so a page can be e.g. 'maintenance' on
 *  production while 'live' on the dev preview.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ENVIRONMENT DETECTION (hostname-based)
 *
 *    *.pages.dev               -> 'dev'   (Cloudflare Pages preview)
 *    wildlifeinneed.github.io  -> 'prod'  (production GitHub Pages)
 *    anything else             -> 'prod'  (safe default; e.g. file://, custom
 *                                          domain — production wording wins)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO TAKE A PAGE DOWN
 *
 *  Change ONLY the 'prod' / 'dev' value for the page you want. Committing this
 *  file with everything 'live' is a visual no-op on production. To put the
 *  dispatcher page under maintenance on production only:
 *
 *      'page-dispatcher': { prod: 'maintenance', dev: 'live' }
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SUB-PANEL OVERRIDE (optional / dormant by default)
 *
 *  The PAGE keys above are the PRIMARY control. For finer-grained control you
 *  may instead flag individual panels within a page. The per-panel keys live
 *  in SUB_PANELS (see below) and are DORMANT by default: applyPanelFlags only
 *  falls back to the per-panel loop when NO page-level key is found for the
 *  current page (i.e. the page wrapper has no data-panel-key="page-…", or the
 *  page key is not present in PAGES). As long as a page declares a page-level
 *  key, that single key wins and the sub-panel entries are ignored.
 *
 *  To use sub-panel mode for a page: remove that page's data-panel-key="page-…"
 *  attribute from its wrapper (or delete its entry from PAGES) and tag the
 *  individual panels with their SUB_PANELS keys. This keeps the fine-grained
 *  option available without cluttering the default config.
 *
 *  Loaded as a plain <script> (browser) and via eval/require (Node tests) —
 *  no fetch, so it works on file:// with no CORS concerns. Mirrors the
 *  window.WildlifeMessages / messages.js pattern.
 * ─────────────────────────────────────────────────────────────────────────
 */
(function (root) {
  'use strict';

  // Banner copy shown when a page/panel is in the 'maintenance' state. EXACT.
  var MAINT_BANNER_TEXT = 'Down for Maintenance, check back later.';

  // ── PAGE-LEVEL config (PRIMARY control) ───────────────────────────────────
  // Exactly 5 keys — one per page. Markup tags each page's top-level wrapper
  // with a matching data-panel-key (e.g. <body data-panel-key="page-dispatcher">).
  // DEFAULT for every page in every env is 'live' (commit = visual no-op).
  var PAGES = {
    'page-index':      { prod: 'live', dev: 'live' },
    'page-dispatcher': { prod: 'live', dev: 'live' },
    'page-facilities': { prod: 'live', dev: 'live' },
    'page-equipment':  { prod: 'live', dev: 'live' },
    'page-help':       { prod: 'live', dev: 'live' }
  };

  // ── SUB-PANEL config (SECONDARY / dormant) ────────────────────────────────
  // Fine-grained per-panel keys. ONLY consulted when a page has no page-level
  // key (see SUB-PANEL OVERRIDE note above). Defaults to 'live' everywhere.
  var SUB_PANELS = {
    // ── index.html ─────────────────────────────────────────────────────────
    'index-tool-equipment':       { prod: 'live', dev: 'live' },
    'index-tool-dispatcher':      { prod: 'live', dev: 'live' },
    'index-tool-facilities':      { prod: 'live', dev: 'live' },
    'index-about':                { prod: 'live', dev: 'live' },
    'index-contact':              { prod: 'live', dev: 'live' },

    // ── dispatcher.html ──────────────────────────────────────────────────────
    'dispatcher-animal-base-info': { prod: 'live', dev: 'live' },
    'dispatcher-county-mode':      { prod: 'live', dev: 'live' },
    'dispatcher-address-mode':     { prod: 'live', dev: 'live' },
    'dispatcher-rehab-block':      { prod: 'live', dev: 'live' },
    'dispatcher-t2map-block':      { prod: 'live', dev: 'live' },
    'dispatcher-map-panel':        { prod: 'live', dev: 'live' },

    // ── facilities.html ──────────────────────────────────────────────────────
    'facilities-disclaimer':   { prod: 'live', dev: 'live' },
    'facilities-controls':     { prod: 'live', dev: 'live' },
    'facilities-grid':         { prod: 'live', dev: 'live' },
    'facilities-submit-form':  { prod: 'live', dev: 'live' },

    // ── equipment-transfers.html ─────────────────────────────────────────────
    'equipment-controls':  { prod: 'live', dev: 'live' },
    'equipment-table':     { prod: 'live', dev: 'live' },

    // ── help.html ────────────────────────────────────────────────────────────
    'help-manual': { prod: 'live', dev: 'live' }
  };

  // Backwards-compatible alias: PANELS is the union (page + sub) so existing
  // tooling that iterates "every key" keeps working. PAGES wins on conflicts.
  var PANELS = {};
  Object.keys(SUB_PANELS).forEach(function (k) { PANELS[k] = SUB_PANELS[k]; });
  Object.keys(PAGES).forEach(function (k) { PANELS[k] = PAGES[k]; });

  var VALID_STATES = { live: true, maintenance: true, hidden: true };

  // ── resolveEnv(): hostname -> 'dev' | 'prod' ──────────────────────────────
  // Pass a hostname explicitly (tests) or omit to read the live location.
  function resolveEnv(hostname) {
    var h = hostname;
    if (h == null && typeof location !== 'undefined' && location) {
      h = location.hostname;
    }
    h = String(h || '').toLowerCase();
    // Cloudflare Pages preview deployments are *.pages.dev.
    if (h === 'pages.dev' || h.slice(-10) === '.pages.dev') return 'dev';
    // Everything else (production github.io, custom domain, file://) -> prod.
    return 'prod';
  }

  // ── resolveState(): key -> resolved state for the given env ────────────────
  // Looks up PAGES first (page-level keys win), then SUB_PANELS. Unknown keys
  // and malformed config default to 'live' (fail-open: never accidentally hide
  // content because of a typo). Pass opts.source = 'page' | 'sub' to restrict
  // the lookup to a single table (used by applyPanelFlags' two phases).
  function resolveState(key, env, opts) {
    opts = opts || {};
    var cfg;
    if (opts.source === 'page') cfg = PAGES[key];
    else if (opts.source === 'sub') cfg = SUB_PANELS[key];
    else cfg = PAGES[key] || SUB_PANELS[key];
    if (!cfg) return 'live';
    var state = cfg[env];
    if (!state && env !== 'prod') state = cfg.prod; // fall back to prod entry
    if (!VALID_STATES[state]) return 'live';
    return state;
  }

  // ── buildBanner(): construct the maintenance banner element ───────────────
  // Reuses the existing .status-strip.construction palette. The banner carries
  // a data-maint-banner attribute so applyPanelFlags is idempotent (it will
  // not inject a second banner if run twice).
  function buildBanner(doc) {
    var el = doc.createElement('div');
    el.className = 'status-strip construction';
    el.setAttribute('role', 'status');
    el.setAttribute('data-maint-banner', '');
    var strong = doc.createElement('strong');
    strong.textContent = 'Maintenance';
    el.appendChild(strong);
    var span = doc.createElement('span');
    span.className = 'sub';
    span.textContent = MAINT_BANNER_TEXT;
    el.appendChild(span);
    return el;
  }

  // ── applyToPanel(): apply a resolved state to a single element ─────────────
  function applyToPanel(el, state, doc) {
    if (!el) return;
    if (state === 'hidden') {
      el.style.display = 'none';
      el.setAttribute('data-panel-hidden', '');
      return;
    }
    if (state === 'maintenance') {
      el.classList.add('is-under-maintenance');
      // Inject the banner at the top of the panel (idempotent).
      if (!el.querySelector(':scope > [data-maint-banner]')) {
        el.insertBefore(buildBanner(doc), el.firstChild);
      }
      return;
    }
    // 'live' -> no-op.
  }

  // ── findPanel(): locate a panel/page element by key ────────────────────────
  // Matches EITHER [data-panel-key="key"] OR an element whose id === key.
  function findPanel(doc, key) {
    var el = doc.querySelector('[data-panel-key="' + key + '"]');
    if (el) return el;
    return doc.getElementById(key);
  }

  // ── findPageWrapper(): locate THIS page's page-level wrapper ───────────────
  // Returns { key, el } for the first element carrying a data-panel-key that is
  // a known PAGES key, or null if this page declares no page-level key.
  function findPageWrapper(doc) {
    var keys = Object.keys(PAGES);
    for (var i = 0; i < keys.length; i++) {
      var el = findPanel(doc, keys[i]);
      if (el) return { key: keys[i], el: el };
    }
    return null;
  }

  // ── applyPanelFlags(): the runtime entry point ────────────────────────────
  // PAGE-LEVEL FIRST: if this document carries a page-level wrapper
  // (data-panel-key="page-…" matching a PAGES key), resolve + apply that ONE
  // state to the whole page and return. Only if NO page-level key is present do
  // we fall back to the per-panel SUB_PANELS loop (dormant override mode).
  //
  // opts.hostname overrides hostname detection (tests). opts.doc overrides the
  // document (tests). Returns a map of { key: appliedState } for assertions.
  function applyPanelFlags(opts) {
    opts = opts || {};
    var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return {};
    var env = resolveEnv(opts.hostname);
    var applied = {};

    // Phase 1 — PAGE-LEVEL (primary).
    var page = findPageWrapper(doc);
    if (page) {
      var pageState = resolveState(page.key, env, { source: 'page' });
      applyToPanel(page.el, pageState, doc);
      applied[page.key] = pageState;
      return applied;
    }

    // Phase 2 — SUB-PANEL fallback (dormant unless no page-level key present).
    Object.keys(SUB_PANELS).forEach(function (key) {
      var el = findPanel(doc, key);
      if (!el) return; // panel not on this page
      var state = resolveState(key, env, { source: 'sub' });
      applyToPanel(el, state, doc);
      applied[key] = state;
    });
    return applied;
  }

  // Auto-run on DOMContentLoaded in the browser. Tests call applyPanelFlags
  // directly with an explicit hostname/doc and skip this.
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', function () {
      applyPanelFlags();
    });
  }

  var api = {
    pages: PAGES,
    subPanels: SUB_PANELS,
    panels: PANELS,
    bannerText: MAINT_BANNER_TEXT,
    resolveEnv: resolveEnv,
    resolveState: resolveState,
    applyPanelFlags: applyPanelFlags
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WildlifeFlags = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

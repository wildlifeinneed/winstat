/* flags.js — SINGLE SOURCE OF TRUTH for per-panel maintenance flags.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS
 *
 *  Every distinct panel/section across the 5 docs/ pages has a stable PANEL
 *  KEY and a per-ENVIRONMENT state. The runtime (applyPanelFlags) reads the
 *  hostname on DOMContentLoaded, resolves each panel's state for THIS env, and
 *  applies one of three states:
 *
 *    'live'        — no-op (normal render).
 *    'maintenance' — panel stays in the layout but is dimmed/de-saturated
 *                    (class .is-under-maintenance) AND an "under construction"
 *                    banner is injected at the top of the panel.
 *    'hidden'      — panel is removed from view (display:none).
 *
 *  ONE identical file serves BOTH branches: each panel declares
 *  { prod: <state>, dev: <state> } so a panel can be e.g. 'maintenance' on
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
 * HOW TO FLIP A PANEL
 *
 *  Change ONLY the 'prod' / 'dev' value for the panel you want. Committing
 *  this file with everything 'live' is a visual no-op on production. To put a
 *  panel under maintenance on production only:
 *
 *      'facilities-grid': { prod: 'maintenance', dev: 'live' }
 *
 *  Loaded as a plain <script> (browser) and via eval/require (Node tests) —
 *  no fetch, so it works on file:// with no CORS concerns. Mirrors the
 *  window.WildlifeMessages / messages.js pattern.
 * ─────────────────────────────────────────────────────────────────────────
 */
(function (root) {
  'use strict';

  // Banner copy shown inside any panel in the 'maintenance' state. EXACT text.
  var MAINT_BANNER_TEXT = 'Down for Maintenance, check back later.';

  // ── Per-panel, per-environment state config ───────────────────────────────
  // Keys are STABLE panel keys; markup tags each panel with a matching
  // data-panel-key (or, where an id already exists, the same id value).
  // DEFAULT for every panel in every env is 'live' (commit = visual no-op).
  var PANELS = {
    // ── index.html (tool cards + about/contact bands) ──────────────────────
    'index-tool-equipment':       { prod: 'live', dev: 'live' },
    'index-tool-dispatcher':      { prod: 'live', dev: 'live' },
    'index-tool-facilities':      { prod: 'live', dev: 'live' },
    'index-about':                { prod: 'live', dev: 'live' },
    'index-contact':              { prod: 'live', dev: 'live' },

    // ── dispatcher.html ────────────────────────────────────────────────────
    'dispatcher-animal-base-info': { prod: 'live', dev: 'live' },
    'dispatcher-county-mode':      { prod: 'live', dev: 'live' },
    'dispatcher-address-mode':     { prod: 'live', dev: 'live' },
    'dispatcher-rehab-block':      { prod: 'live', dev: 'live' },
    'dispatcher-t2map-block':      { prod: 'live', dev: 'live' },
    'dispatcher-map-panel':        { prod: 'live', dev: 'live' },

    // ── facilities.html ────────────────────────────────────────────────────
    'facilities-disclaimer':   { prod: 'live', dev: 'live' },
    'facilities-controls':     { prod: 'live', dev: 'live' },
    'facilities-grid':         { prod: 'live', dev: 'live' },
    'facilities-submit-form':  { prod: 'live', dev: 'live' },

    // ── equipment-transfers.html ───────────────────────────────────────────
    'equipment-controls':  { prod: 'live', dev: 'live' },
    'equipment-table':     { prod: 'live', dev: 'live' },

    // ── help.html ──────────────────────────────────────────────────────────
    'help-manual': { prod: 'live', dev: 'live' }
  };

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

  // ── resolveState(): panel key -> resolved state for the given env ─────────
  // Unknown panels and malformed config default to 'live' (fail-open: never
  // accidentally hide content because of a typo).
  function resolveState(panelKey, env) {
    var cfg = PANELS[panelKey];
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

  // ── findPanel(): locate a panel element by key ────────────────────────────
  // Matches EITHER [data-panel-key="key"] OR an element whose id === key.
  function findPanel(doc, key) {
    var el = doc.querySelector('[data-panel-key="' + key + '"]');
    if (el) return el;
    return doc.getElementById(key);
  }

  // ── applyPanelFlags(): the runtime entry point ────────────────────────────
  // For every known panel present in THIS document, resolve + apply its state.
  // opts.hostname overrides hostname detection (tests). opts.doc overrides the
  // document (tests). Returns a map of { key: appliedState } for assertions.
  function applyPanelFlags(opts) {
    opts = opts || {};
    var doc = opts.doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return {};
    var env = resolveEnv(opts.hostname);
    var applied = {};
    Object.keys(PANELS).forEach(function (key) {
      var el = findPanel(doc, key);
      if (!el) return; // panel not on this page
      var state = resolveState(key, env);
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

/* dispatcher.js — Phase 2 UI scaffold for Wildlife In Need dispatcher.
 * Reads docs/data/county_capacity.json (snapshot from refresh_monday.py).
 * No frameworks, no build step.
 */
(function () {
  'use strict';

  // ── Wording + thresholds come from messages.js (single source of truth) ───
  // Browser: window.WildlifeMessages (loaded via <script> before this file).
  // Node tests: window.eval(messages.js) runs first, else require the sibling.
  var WM = (typeof window !== 'undefined' && window.WildlifeMessages)
    ? window.WildlifeMessages
    : ((typeof require !== 'undefined') ? require('./messages.js') : null);
  var MSG = WM.messages;
  var fmt = WM.fmt;

  var PA_COUNTIES = [
    'Adams','Allegheny','Armstrong','Beaver','Bedford','Berks','Blair','Bradford',
    'Bucks','Butler','Cambria','Cameron','Carbon','Centre','Chester','Clarion',
    'Clearfield','Clinton','Columbia','Crawford','Cumberland','Dauphin','Delaware',
    'Elk','Erie','Fayette','Forest','Franklin','Fulton','Greene','Huntingdon',
    'Indiana','Jefferson','Juniata','Lackawanna','Lancaster','Lawrence','Lebanon',
    'Lehigh','Luzerne','Lycoming','McKean','Mercer','Mifflin','Monroe','Montgomery',
    'Montour','Northampton','Northumberland','Perry','Philadelphia','Pike','Potter',
    'Schuylkill','Snyder','Somerset','Sullivan','Susquehanna','Tioga','Union',
    'Venango','Warren','Washington','Wayne','Westmoreland','Wyoming','York'
  ];

  var ROLES = [
    { key: 'ct_no_rvs', label: 'C&T' },
    { key: 'ct_rvs',    label: 'RVS C&T' },
    { key: 'courier',   label: 'Courier' }
  ];

  // ─── WIN Areas map (D5.2-5.3) ──────────────────────────────────────
  // Stable per-area color map. 18 buckets (areas 1-16 + 15N/15S). These are
  // documented, readable-on-light-bg swatches; defined here (not raw inline
  // hex scattered through markup) so the legend, paths, and any future reuse
  // share one source of truth.
  var AREA_COLORS = {
    '1':   '#4e79a7',
    '2':   '#59a14f',
    '3':   '#e15759',
    '4':   '#f28e2b',
    '5':   '#76b7b2',
    '6':   '#edc948',
    '7':   '#b07aa1',
    '8':   '#ff9da7',
    '9':   '#9c755f',
    '10':  '#86bcb6',
    '11':  '#d37295',
    '12':  '#8cd17d',
    '13':  '#bab0ac',
    '14':  '#499894',
    '15N': '#d4a6c8',
    '15S': '#b6992d',
    '16':  '#79706e'
  };
  var AREA_FALLBACK = '#c9c4bd';
  // Path to the committed PA county GeoJSON (relative to dispatcher.html, which
  // lives in docs/ alongside data/). Properties: {county, win_area, geoid}.
  var GEOJSON_PATH = 'data/pa_counties.json';
  var MAP_PANEL_KEY = 'win_map_panel_open'; // localStorage collapse persistence

  // Threshold values relocated to messages.js (MSG.thresholds) so the numeric
  // tuning knobs live in one editable place. Behavior is unchanged: these are
  // still the FALLBACK defaults when data/config.json omits a value.
  var DEFAULT_CONFIG = {
    marginal_threshold: MSG.thresholds.marginal_threshold,
    escalate_to_game_commission: {
      ct_rvs_capture_min_available: MSG.thresholds.ct_rvs_capture_min_available,
      ct_any_capture_min_available: MSG.thresholds.ct_any_capture_min_available,
      courier_transport_min_available: MSG.thresholds.courier_transport_min_available
    },
    county_overrides: {}
  };

  var state = {
    snapshot: null,   // parsed county_capacity.json or null
    loadError: false,
    config: null,           // parsed config.json (or null = use defaults)
    configError: false,     // true when config.json was present but malformed
    coordinators: {},       // area-string -> coordinator NAME (public-safe, no phone)
    countyWin: {},          // county name -> WIN area (PII-free, from county_win.json)
    rehabbers: [],          // public rehabber dataset (may be empty)
    addressBusy: false,     // guard against concurrent address lookups
    widenCounty: null,      // Tier 1 county carried into Tier 2 as exclude_county
    mapBuilt: false,        // true once the SVG choropleth is drawn
    mapAreas: {},           // area-string -> array of county-path <path> nodes
    mapCounties: {},        // county name -> its county-path <path> node
    countyCentroids: {},    // county name -> { lat, lon } area-weighted centroid (from geojson)
    currentCounty: null,    // county name currently distinctly highlighted (hl-county)
    // Coordinate captured when the dispatcher PICKS a typeahead suggestion that
    // carries lat/lon (Photon already resolved it). Shape: {lat, lon, label}.
    // onAddressSubmit submits these coords DIRECTLY (animal_lat/animal_lon),
    // bypassing the weak Census exact-match geocode that drops rural PA hits.
    // Cleared the moment the input text diverges from `label` (editing/pasting)
    // so a stale coord can never be submitted for a different typed address.
    selectedAnimalCoord: null,
    // DECONFLICTION: the single governing "active location". Whichever input was
    // used LAST wins: 'county' = dropdown drives results; 'address' = a geocoded
    // address drives them. Entering an address rebinds to 'address' and clears
    // the county-mode coordinator so two coordinators are NEVER shown at once;
    // switching back to county mode rebinds to 'county'. The dropdown VALUE is
    // preserved either way (we never wipe the selection).
    activeLocation: 'county'
  };

  // ─── Address-mode (Phase G) configuration ──────────────────────────
  // Live aggregate Worker. The Worker geocodes the address SERVER-SIDE (no
  // browser CORS) and returns the PII-free aggregate. Query params:
  //   ?address=<urlenc>&radius_mi=<r>   (or animal_lat/animal_lon&radius_mi)
  // The browser NEVER calls the US Census geocoder directly — doing so was the
  // original cross-origin (CORS) failure that broke By-Animal-Address mode.
  var WORKER_URL = 'https://pa-wildlife-dispatcher.winstat.workers.dev';
  var RADIUS_DEFAULT = 20;
  var RADIUS_MAX = 100;
  // Address autocomplete (typeahead) tuning. The Worker proxies a GENERIC
  // public address provider (Photon) server-side via ?autocomplete=&limit= and
  // returns { suggestions: [{label, lat?, lon?}] }. NO PII ever reaches here.
  var AC_MIN_CHARS = 3;
  var AC_DEBOUNCE_MS = 280;
  var AC_LIMIT = 5;
  // PA Game Commission dispatch lines — single source of truth in messages.js
  // (also injected into the page footer note so both sites read ONE value).
  var PGC_PHONE = MSG.pgcPhone;
  // Roles that count as "qualified to respond" for the call-PGC decision.
  var QUALIFYING_ROLES = ['C&T', 'RVS C&T', 'COURIER'];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // Guarded text setter: a missing target element must NOT throw (a thrown
  // TypeError here used to fall into the fetch .catch and masquerade as a
  // network failure — see renderAggregate / onAddressSubmit).
  function setText(sel, value) {
    var el = $(sel);
    if (el) { el.textContent = value; return true; }
    console.warn('dispatcher: missing element ' + sel);
    return false;
  }

  function populateCounties() {
    var sel = $('#county');
    PA_COUNTIES.forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  }

  function formatTimestamp(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch (e) { return iso; }
  }

  function renderBanner() {
    var banner = $('#refresh-banner');
    if (state.loadError || !state.snapshot) {
      banner.classList.add('warn');
      banner.textContent = MSG.tier2Aggregate.snapshotUnavailable;
      return;
    }
    banner.classList.remove('warn');
    var ts = formatTimestamp(state.snapshot.generated_at);
    banner.textContent = fmt(MSG.tier2Aggregate.lastRefreshed, { ts: (ts || MSG.tier2Aggregate.refreshedUnknown) });
  }

  function resolveForCounty(config, countyName) {
    // Mirror Python's resolve_marginal_threshold: deep-merge per-county
    // override (if any) over global, falling back to DEFAULT_CONFIG.
    var cfg = config || {};
    var esc = cfg.escalate_to_game_commission || {};
    var defEsc = DEFAULT_CONFIG.escalate_to_game_commission;
    var resolved = {
      marginal_threshold: (typeof cfg.marginal_threshold === 'number')
        ? cfg.marginal_threshold : DEFAULT_CONFIG.marginal_threshold,
      ct_rvs_capture_min_available: (typeof esc.ct_rvs_capture_min_available === 'number')
        ? esc.ct_rvs_capture_min_available : defEsc.ct_rvs_capture_min_available,
      ct_any_capture_min_available: (typeof esc.ct_any_capture_min_available === 'number')
        ? esc.ct_any_capture_min_available : defEsc.ct_any_capture_min_available,
      courier_transport_min_available: (typeof esc.courier_transport_min_available === 'number')
        ? esc.courier_transport_min_available : defEsc.courier_transport_min_available
    };
    var overrides = (cfg.county_overrides || {})[countyName];
    if (overrides && typeof overrides === 'object') {
      if (typeof overrides.marginal_threshold === 'number') {
        resolved.marginal_threshold = overrides.marginal_threshold;
      }
      var oEsc = overrides.escalate_to_game_commission || {};
      if (typeof oEsc.ct_rvs_capture_min_available === 'number') {
        resolved.ct_rvs_capture_min_available = oEsc.ct_rvs_capture_min_available;
      }
      if (typeof oEsc.ct_any_capture_min_available === 'number') {
        resolved.ct_any_capture_min_available = oEsc.ct_any_capture_min_available;
      }
      if (typeof oEsc.courier_transport_min_available === 'number') {
        resolved.courier_transport_min_available = oEsc.courier_transport_min_available;
      }
    }
    return resolved;
  }

  function renderConfigError() {
    var existing = document.getElementById('config-error-banner');
    if (!state.configError) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var b = document.createElement('div');
    b.id = 'config-error-banner';
    b.className = 'refresh-banner warn';
    b.style.marginTop = '6px';
    b.textContent = MSG.tier2Aggregate.configMalformed;
    var refresh = document.getElementById('refresh-banner');
    if (refresh && refresh.parentNode) {
      refresh.parentNode.insertBefore(b, refresh.nextSibling);
    }
  }

  // ─── WIN-area helpers (Tier 1 By-County expansion) ─────────────────
  // Return all county names sharing the same WIN area as `countyName`.  Uses
  // state.countyWin (loaded from county_win.json) by inverting the map at call
  // time — no extra fetch, no schema change.  Falls back to [countyName] when
  // the area is unknown or state.countyWin is not yet loaded.
  function getWinAreaCounties(countyName) {
    if (!countyName || !state.countyWin) return [countyName];
    var area = state.countyWin[countyName];
    if (area === undefined || area === null) return [countyName];
    var norm = String(area).trim().toLowerCase();
    var result = [];
    var cw = state.countyWin;
    Object.keys(cw).forEach(function (c) {
      if (String(cw[c]).trim().toLowerCase() === norm) {
        result.push(c);
      }
    });
    return result.length > 0 ? result : [countyName];
  }

  // Build a merged capacity object (same shape as a county_capacity.json county
  // entry) by summing available / total across the given capacity objects and
  // concatenating marginal_volunteers.  Used by onRecommendClick so the
  // recommendation decision also covers the full WIN-area pool.
  function mergeCapacity(capacities) {
    var merged = {};
    ROLES.forEach(function (role) {
      var avail = 0, total = 0, marginals = [];
      capacities.forEach(function (cap) {
        if (!cap) return;
        var bucket = cap[role.key] || {};
        avail += (bucket.available || 0);
        total += (bucket.total || 0);
        var mv = bucket.marginal_volunteers;
        if (Array.isArray(mv)) {
          mv.forEach(function (v) { marginals.push(v); });
        }
      });
      merged[role.key] = { available: avail, total: total, marginal_volunteers: marginals };
    });
    return merged;
  }

  // County WIN-area badge beside the dropdown: "<County> · Area N". Uses the
  // SAME county -> area map (state.countyWin) that drives the coordinator line.
  // Hidden when no county is selected. Updates live on every dropdown change.
  function renderCountyBadge(countyName) {
    var badge = $('#county-badge');
    if (!badge) return;
    if (!countyName) {
      badge.style.display = 'none';
      badge.textContent = '';
      return;
    }
    var area = (state.countyWin && state.countyWin[countyName] !== undefined)
      ? String(state.countyWin[countyName]).trim() : '';
    badge.textContent = area
      ? fmt(MSG.coordinator.countyAreaBadge, { county: countyName, area: area })
      : fmt(MSG.coordinator.countyAreaBadgeUnknown, { county: countyName });
    badge.style.display = 'inline-block';
  }

  function renderCardsForCounty(countyName) {
    var emptyMsg = $('#empty-msg');
    var cards = $$('.cap-card');

    // WIN-area badge tracks the dropdown regardless of capacity data.
    renderCountyBadge(countyName);

    if (!countyName) {
      cards.forEach(function (card) {
        card.classList.add('empty');
        // Address-mode cap-cards have no .avail/.total/.sub spans; guard so the
        // reset loop never throws on them (that thrown TypeError previously
        // aborted this branch before the coord-line/map highlight was cleared).
        var availEl = $('.avail', card); if (availEl) availEl.textContent = '—';
        var totalEl = $('.total', card); if (totalEl) totalEl.textContent = '—';
        var subEl = $('.sub', card); if (subEl) subEl.textContent = '';
        var badge = $('.badge', card);
        if (badge) badge.remove();
      });
      emptyMsg.style.display = 'none';
      emptyMsg.textContent = '';
      renderCoordLine('');
      return;
    }

    var counties = (state.snapshot && state.snapshot.counties) || {};
    var hasAny = false;
    var resolved = resolveForCounty(state.config, countyName);

    // WIN-area expansion: aggregate volunteers across all counties in the same
    // WIN area (not just the exact selected county).
    var winArea = (state.countyWin && state.countyWin[countyName] !== undefined)
      ? String(state.countyWin[countyName]).trim() : null;
    var siblingCounties = getWinAreaCounties(countyName);

    ROLES.forEach(function (role) {
      var card = document.querySelector('.cap-card[data-role="' + role.key + '"]');

      // Sum available + total across all WIN-area counties; track per-county breakdown.
      var areaAvail = 0, areaTotal = 0;
      var byCounty = [];
      siblingCounties.forEach(function (c) {
        var cData = counties[c];
        var cRole = (cData && cData[role.key]) || { available: 0, total: 0 };
        var cTotal = cRole.total || 0;
        var cAvail = cRole.available || 0;
        areaAvail += cAvail;
        areaTotal += cTotal;
        if (cTotal > 0) {
          byCounty.push({ name: c, total: cTotal });
        }
      });
      if (areaTotal > 0) hasAny = true;

      card.classList.remove('empty');
      $('.avail', card).textContent = String(areaAvail);
      $('.total', card).textContent = String(areaTotal);

      // Sub-line: "Area 14 — Schuylkill 3, Carbon 2"
      var subEl = $('.sub', card);
      if (subEl) {
        if (winArea && byCounty.length > 0) {
          var parts = byCounty.map(function (e) { return e.name + '\u00a0' + e.total; });
          subEl.textContent = fmt(MSG.coordinator.winAreaSub, {
            area: winArea,
            breakdown: parts.join(', ')
          });
        } else {
          subEl.textContent = '';
        }
      }

      var existing = $('.badge', card);
      if (existing) existing.remove();

      if (areaAvail <= resolved.marginal_threshold && areaTotal > 0) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = MSG.coordinator.marginalBadge;
        card.appendChild(badge);
      }
    });

    if (!hasAny) {
      emptyMsg.style.display = 'block';
      emptyMsg.textContent = fmt(MSG.coordinator.noVolunteersInCounty, { county: countyName });
    } else {
      emptyMsg.style.display = 'none';
      emptyMsg.textContent = '';
    }

    renderCoordLine(countyName);
  }

  var TARGET_LABELS = MSG.recommendation.targetLabels;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function renderRecommendation(rec, base) {
    var actionMeta = (window.WildlifeDecision &&
                      window.WildlifeDecision.ACTIONS &&
                      window.WildlifeDecision.ACTIONS[rec.action]) || null;
    var label = actionMeta ? actionMeta.label : rec.action;
    var tone  = actionMeta ? actionMeta.tone  : 'unknown';
    var html = '';
    var REC = MSG.recommendation;
    html += '<button type="button" class="rec-dismiss" id="rec-dismiss" aria-label="' + REC.dismiss + '">' + REC.dismiss + '</button>';
    if (base) {
      var ISSUE_LABELS = { capture: 'Capture', transport: 'Transport' };
      var issueLabel = ISSUE_LABELS[base.issue] || base.issue;
      var rvsLabel = base.rvs ? 'RVS' : 'non-RVS';
      html += '<div class="rec-premise">' + escapeHtml(fmt(REC.premiseLine, { issue: issueLabel, rvsLabel: rvsLabel })) + '</div>';
    }
    html += '<div class="rec-action ' + tone + '">' + escapeHtml(label) + '</div>';
    if (rec.target) {
      var targetLabel = TARGET_LABELS[rec.target] || rec.target;
      html += '<div class="rec-target">' + fmt(REC.targetRole, { label: escapeHtml(targetLabel) }) + '</div>';
    }

    if (rec.marginal && rec.marginal_volunteers && rec.marginal_volunteers.length) {
      html += '<div class="rec-marginal">';
      html += '<div class="rec-marginal-header">' + REC.lowCapacityHeader + '</div>';
      html += '<ul>';
      rec.marginal_volunteers.forEach(function (v) {
        var note = v && v.availability_note ? String(v.availability_note) : '';
        if (note) {
          html += '<li><em>' + escapeHtml(note) + '</em></li>';
        } else {
          html += '<li><em>' + REC.noAvailabilityInfo + '</em></li>';
        }
      });
      html += '</ul></div>';
    } else if (rec.marginal) {
      html += '<div class="rec-marginal"><div class="rec-marginal-header">' + REC.lowCapacityHeader + '</div>' +
              '<p style="font-size:13px;">' + REC.noRosterRecorded + '</p></div>';
    }

    if (rec.reasoning && rec.reasoning.length) {
      html += '<div class="rec-reasoning"><div class="rec-reasoning-header">' + REC.reasoningHeader + '</div><ol>';
      rec.reasoning.forEach(function (r) { html += '<li>' + escapeHtml(r) + '</li>'; });
      html += '</ol></div>';
    }

    var out = $('#rec-output');
    out.innerHTML = html;
    out.className = 'rec-output show tone-' + tone;

    var dismiss = document.getElementById('rec-dismiss');
    if (dismiss) {
      dismiss.addEventListener('click', function () {
        out.classList.remove('show');
        out.innerHTML = '';
      });
    }
  }

  // Shared animal base info, entered ONCE at the top of the console and read by
  // BOTH search paths (Tier 1 county recommend + Tier 2 widen/address). Returns
  // { rvs: bool, issue: 'capture'|'transport' } with the page defaults
  // (RVS=No, Issue=Capture) when the radios are missing.
  function readAnimalBaseInfo() {
    var rvsRadio = document.querySelector('input[name="rvs"]:checked');
    var issueRadio = document.querySelector('input[name="issue"]:checked');
    return {
      rvs: rvsRadio ? (rvsRadio.value === 'yes') : false,
      issue: issueRadio ? issueRadio.value : 'capture'
    };
  }

  // ─── Stale-results flag (Approach B) ───────────────────────────────
  // The RVS toggle and the Issue (C&T) selection feed BOTH result surfaces
  // via readAnimalBaseInfo() but are wired to no render handler — so changing
  // one after results render used to silently leave misleading stale numbers
  // on screen. Per the user's decision (approach B, NOT auto-recompute) we
  // instead FLAG the displayed result as stale and require a re-click of the
  // existing lookup/submit button to recompute.
  //
  // Each result surface (#rec-output for county mode, #address-result for
  // address mode — the latter wraps the nearest-rehabber panel, so flagging
  // the container covers it too) gets a `.is-stale` class plus a `.stale-notice`
  // banner. The banner wording is routed through messages.js. The rehabber
  // on-demand panel is additionally collapsed so it cannot reveal stale rows.
  function staleNoticeEl(container, hintKey) {
    var notice = container.querySelector(':scope > .stale-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'stale-notice';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      // Banner sits at the TOP of the surface, above the (dimmed) content.
      container.insertBefore(notice, container.firstChild);
    }
    var S = MSG.stale;
    notice.innerHTML = escapeHtml(S.notice) +
      '<span class="stale-hint">' + escapeHtml(S[hintKey] || '') + '</span>';
    return notice;
  }

  // Mark a single surface stale only when it is currently SHOWING a result.
  // #rec-output shows via the `.show` class; #address-result via display:block.
  function markRecOutputStale() {
    var out = document.getElementById('rec-output');
    if (!out || !out.classList.contains('show')) return;
    out.classList.add('is-stale');
    staleNoticeEl(out, 'rerunRecommend');
  }

  function markAddressResultStale() {
    var res = document.getElementById('address-result');
    if (!res || res.style.display !== 'block') return;
    res.classList.add('is-stale');
    staleNoticeEl(res, 'rerunAddress');
    // Collapse the on-demand rehabber list so stale rehabbers can't be revealed
    // while the surface is flagged. Re-running the lookup re-prepares + resets it.
    var content = document.getElementById('rehab-content');
    var toggle = document.getElementById('rehab-toggle');
    if (content) content.style.display = 'none';
    if (toggle) setRehabToggleLabel(toggle, false);
  }

  // Called on every relevant input change (RVS / Issue). Flags whichever
  // surface is currently showing results. Never recomputes (approach B).
  function markResultsStale() {
    markRecOutputStale();
    markAddressResultStale();
  }

  // Re-running a lookup clears the stale flag for that surface. Called at the
  // top of the render paths the lookup buttons drive.
  function clearStale(container) {
    if (!container) return;
    container.classList.remove('is-stale');
    var notice = container.querySelector(':scope > .stale-notice');
    if (notice) notice.parentNode.removeChild(notice);
  }

  function onRecommendClick() {
    var out = $('#rec-output');
    // Re-running the lookup clears any stale flag on this surface.
    clearStale(out);
    var county = $('#county').value;
    if (!county) {
      out.className = 'rec-output show tone-unknown';
      out.innerHTML = '<button type="button" class="rec-dismiss" id="rec-dismiss">' + MSG.recommendation.dismiss + '</button>' +
                      '<div class="rec-action unknown">' + MSG.recommendation.selectCountyFirst + '</div>';
      var d = document.getElementById('rec-dismiss');
      if (d) d.addEventListener('click', function () {
        out.classList.remove('show'); out.innerHTML = '';
      });
      return;
    }

    if (typeof window.WildlifeDecision === 'undefined' ||
        typeof window.WildlifeDecision.recommend !== 'function') {
      console.error('decision.js not loaded');
      return;
    }

    var counties = (state.snapshot && state.snapshot.counties) || {};
    // WIN-area expansion: build a merged capacity across all counties in the
    // same WIN area so the recommendation reflects the full volunteer pool.
    var siblingCounties = getWinAreaCounties(county);
    var capacity = siblingCounties.length > 1
      ? mergeCapacity(siblingCounties.map(function (c) { return counties[c] || null; }))
      : (counties[county] || null);
    var base = readAnimalBaseInfo();

    var resolved = resolveForCounty(state.config, county);
    var rec = window.WildlifeDecision.recommend(capacity, base.rvs, base.issue, resolved);
    renderRecommendation(rec, base);
  }

  // ─── Address-mode: geocode → Worker → render aggregate ─────────────

  function haversineMiles(lat1, lon1, lat2, lon2) {
    var R = 3958.7613; // mean Earth radius in miles
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function clampRadius(raw) {
    var n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return RADIUS_DEFAULT;
    if (n > RADIUS_MAX) return RADIUS_MAX;
    return n;
  }

  // Call the live aggregate Worker with the typed address. The Worker geocodes
  // SERVER-SIDE (no browser CORS) and returns the PII-free AggregateResult.
  // Resolves to the parsed aggregate, or throws an Error whose message is a
  // stable code for the UI to surface a precise message.
  function fetchAggregateByAddress(address, radiusMi, opts) {
    var url = WORKER_URL +
      '?address=' + encodeURIComponent(address) +
      '&radius_mi=' + encodeURIComponent(radiusMi);
    // Context list (context=1): ask the Worker for the PII-safe per-volunteer
    // qualifying-context list alongside the unchanged aggregate. Two callers:
    //   - Standalone Address lookup: context=1 with NO exclude_county -> the
    //     Worker returns ALL in-range qualifying volunteers (no county filter).
    //   - Tier 2 "widen": context=1 + exclude_county scopes the list to EXCLUDE
    //     the Tier 1 county. Either way out_of_county is purely additive.
    if (opts && opts.context) {
      url += '&context=1';
      if (opts.excludeCounty) {
        url += '&exclude_county=' + encodeURIComponent(opts.excludeCounty);
      }
    }
    if (opts && opts.tier1County) {
      url += '&animal_county=' + encodeURIComponent(opts.tier1County);
    }
    // Carry the SHARED animal base info (entered once at the top) into the Tier 2
    // request so both search paths consume the same input. From rvs+issue we
    // also derive the QUALIFYING ROLE SET via decision.js (the SINGLE source of
    // truth — qualifyingRoles probes the SAME qualifiesForAnimal predicate) and
    // send it as `qualify_roles` so the Worker returns ONLY taskable volunteers
    // for THIS animal. Filtering to qualified BEFORE the Worker's nearest-N cap
    // is what keeps far qualified volunteers (e.g. RVS C&T) from being dropped.
    url = appendAggregateOpts(url, opts);
    return fetchAggregate(url);
  }

  // Submit the animal location as EXPLICIT coordinates (animal_lat/animal_lon).
  // Used when the dispatcher picked a typeahead suggestion that Photon already
  // resolved: the Worker's resolveAnimalCoord accepts these directly and SKIPS
  // the Census geocode entirely, which is the core fix for "no match" on
  // addresses Photon had already found. Same context/base params + status
  // mapping as the address path so both feed renderAggregate identically.
  function fetchAggregateByCoord(lat, lon, radiusMi, opts) {
    var url = WORKER_URL +
      '?animal_lat=' + encodeURIComponent(lat) +
      '&animal_lon=' + encodeURIComponent(lon) +
      '&radius_mi=' + encodeURIComponent(radiusMi);
    if (opts && opts.context) {
      url += '&context=1';
      if (opts.excludeCounty) {
        url += '&exclude_county=' + encodeURIComponent(opts.excludeCounty);
      }
    }
    if (opts && opts.tier1County) {
      url += '&animal_county=' + encodeURIComponent(opts.tier1County);
    }
    url = appendAggregateOpts(url, opts);
    return fetchAggregate(url);
  }

  // Append the shared rvs/issue + derived qualify_roles params (see
  // fetchAggregateByAddress for the rationale). Pure string builder.
  function appendAggregateOpts(url, opts) {
    if (opts && opts.base) {
      url += '&rvs=' + encodeURIComponent(opts.base.rvs ? 'yes' : 'no') +
             '&issue=' + encodeURIComponent(opts.base.issue);
      var qfn = (window.WildlifeDecision &&
                 typeof window.WildlifeDecision.qualifyingRoles === 'function')
        ? window.WildlifeDecision.qualifyingRoles : null;
      if (qfn) {
        var qroles = qfn(opts.base.rvs, opts.base.issue);
        if (qroles && qroles.length) {
          url += '&qualify_roles=' + encodeURIComponent(qroles.join(','));
        }
      }
    }
    return url;
  }

  // Shared fetch + HTTP-status -> error-code mapping for both address and coord
  // aggregate lookups. Keeps onAddressSubmit's .catch() code mapping unchanged.
  function fetchAggregate(url) {
    return fetch(url, { cache: 'no-store' })
      .then(function (resp) {
        if (resp.status === 422) throw new Error('address_not_found');
        if (resp.status === 502) throw new Error('geocoder_unavailable');
        if (resp.status === 400) throw new Error('worker_400');
        if (!resp.ok) throw new Error('worker_http_' + resp.status);
        return resp.json();
      });
  }

  // Closest PUBLIC rehabber by straight-line distance. Open/closed is NOT
  // used: the dispatcher org does not keep that Monday field current (real-time
  // status lives in a separate beta app), so it is not in the dataset and is
  // not consulted here. Returns {rehab_name, distance_mi, website} or null.
  function findClosestRehabber(lat, lon) {
    var list = state.rehabbers || [];
    var bestAny = null, bestAnyD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (!rec || typeof rec.lat !== 'number' || typeof rec.lon !== 'number') continue;
      var d = haversineMiles(lat, lon, rec.lat, rec.lon);
      var cand = {
        rehab_name: String(rec.rehab_name || ''),
        distance_mi: d,
        website: String(rec.website || '')
      };
      if (d < bestAnyD) { bestAnyD = d; bestAny = cand; }
    }
    return bestAny;
  }

  // Rank the public rehabbers by straight-line (haversine) distance from an
  // origin point (animal coords OR a county centroid) and return the nearest
  // `n` as plain row objects. Rehabbers missing numeric coords are skipped.
  // Returns [{ rehab_name, county, phone, distance_mi, availability, website }],
  // sorted ascending by distance, length<=n. NOTE: open/closed is intentionally
  // NOT surfaced here — the dispatcher org does not keep that Monday field
  // current (real-time status lives in a separate beta app), so showing it
  // would be misleading. Phone + county are shown instead.
  function nearestRehabbers(lat, lon, n) {
    var limit = (typeof n === 'number' && n > 0) ? n : 3;
    var list = state.rehabbers || [];
    var scored = [];
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (!rec || typeof rec.lat !== 'number' || typeof rec.lon !== 'number') continue;
      scored.push({
        rehab_name: String(rec.rehab_name || ''),
        county: String(rec.county || ''),
        phone: String(rec.phone || '').trim(),
        lat: rec.lat,
        lon: rec.lon,
        distance_mi: haversineMiles(lat, lon, rec.lat, rec.lon),
        // Driving distance/time from the Worker (ORS); null until/unless the
        // Worker supplies them. duration_min stays null on the haversine path.
        drive_distance_mi: null,
        duration_min: null,
        availability: String(rec.availability || ''),
        website: String(rec.website || '').trim()
      });
    }
    // Stable ascending sort by distance (ties keep dataset order via index).
    scored.sort(function (a, b) { return a.distance_mi - b.distance_mi; });
    return scored.slice(0, limit);
  }

  // Tier 1 notify line: resolve a county to its WIN area + coordinator NAME
  // (name only, never phone). county -> area via state.countyWin (county_win.json),
  // area -> name via state.coordinators (coordinators.json). Returns
  // { area, name } with name possibly '' when unresolved.
  function coordinatorForCounty(countyName) {
    var area = (countyName && state.countyWin)
      ? state.countyWin[countyName] : null;
    if (area === null || area === undefined || String(area).trim() === '') {
      return { area: null, name: '' };
    }
    area = String(area).trim();
    var name = state.coordinators[area];
    return { area: area, name: (name && String(name).trim()) ? String(name).trim() : '' };
  }

  // Render the Tier 1 coordinator notify line + the "widen search" affordance.
  // Both live under the county cards. Hidden when no county is selected.
  //
  // DECONFLICTION: the county coordinator line only governs when the ACTIVE
  // location is 'county'. While an address governs ('address'), this line stays
  // cleared so the dropdown county's coordinator never shows alongside the
  // address area's coordinator. The dropdown VALUE is preserved regardless.
  function renderCoordLine(countyName) {
    var line = $('#coord-line');
    var prompt = $('#widen-prompt');
    if (!countyName || state.activeLocation === 'address') {
      if (line) { line.style.display = 'none'; line.innerHTML = ''; }
      if (prompt) prompt.style.display = (countyName ? prompt.style.display : 'none');
      if (!countyName) {
        // Tier 1 cleared: drop any animal-area highlight + selected-county mark.
        highlightAreas([], []);
        highlightCounty(null);
      }
      return;
    }
    var coord = coordinatorForCounty(countyName);
    if (line) {
      if (coord.name) {
        var label = coord.area
          ? fmt(MSG.coordinator.areaCoordinatorLabel, { area: escapeHtml(coord.area) })
          : MSG.coordinator.coordinatorLabel;
        line.innerHTML = fmt(MSG.coordinator.coordinatorLine, {
          label: label, name: escapeHtml(coord.name)
        });
      } else {
        line.innerHTML = fmt(MSG.coordinator.noCoordinatorOnFile, { county: escapeHtml(countyName) });
      }
      line.style.display = 'block';
    }
    if (prompt) prompt.style.display = 'block';
    // Tier 1 highlight: emphasize the selected county's WIN area on the map.
    highlightAreas(coord.area ? [coord.area] : [], []);
    // ...and distinctly mark the single selected county on top of its area.
    highlightCounty(countyName);
  }

  function coordinatorsForAreas(areas) {
    var names = {};
    (areas || []).forEach(function (a) {
      var name = state.coordinators[String(a)];
      if (name && String(name).trim()) names[String(name).trim()] = true;
    });
    return Object.keys(names).sort();
  }

  // Address-mode RESOLVED-LOCATION header. Names the ANIMAL's own resolved
  // county + WIN area (from the Worker: agg.animal_county / agg.animal_area) as
  // the single governing location, then — when the radius crosses WIN-area
  // boundaries — notes the in-range spread from agg.win_areas. When the Worker
  // could not resolve a county (animal_area null), we DO NOT invent one: we show
  // a county-unavailable note and fall back to the in-range areas only.
  // Returns the animal's own area string (or null) so renderAggregate can
  // highlight it as primary in the per-area coordinator list.
  function renderResolvedLocation(agg) {
    var el = $('#resolved-location');
    if (!el) return null;
    var T2 = MSG.tier2Aggregate;
    var animalCounty = (agg && typeof agg.animal_county === 'string' && agg.animal_county.trim())
      ? agg.animal_county.trim() : null;
    var animalArea = (agg && agg.animal_area !== null && agg.animal_area !== undefined &&
                      String(agg.animal_area).trim() !== '') ? String(agg.animal_area).trim() : null;
    var areas = (agg && Array.isArray(agg.win_areas)) ? agg.win_areas.map(String) : [];

    var html;
    if (animalCounty && animalArea) {
      html = fmt(T2.resolvedLocation, {
        county: escapeHtml(animalCounty), area: escapeHtml(animalArea)
      });
      // Tier-1 fallback flag: if the county came from the Tier-1 panel (not
      // geocoded from the address/coord), prepend an amber informational note
      // so the dispatcher knows the area derivation is approximate.
      if (agg && agg.county_source === 'tier1_fallback') {
        html = '<span class="tier1-fallback-flag">' +
               escapeHtml(T2.resolvedLocationTier1Fallback) +
               '</span>' + html;
      }
      // In-range spread: only when volunteers span MORE than the animal's area.
      var others = areas.filter(function (a) { return a !== animalArea; });
      if (others.length) {
        var spreadAreas = [animalArea].concat(others);
        html += '<span class="resolved-spread">' + fmt(T2.resolvedSpread, {
          areaWord: (spreadAreas.length > 1 ? 'Areas' : 'Area'),
          areas: spreadAreas.map(escapeHtml).join(', ')
        }) + '</span>';
      }
    } else {
      // Geocoder gave no county/area — never invent one.
      html = T2.resolvedLocationUnknown;
      if (areas.length) {
        html += '<span class="resolved-spread">' + fmt(T2.resolvedSpread, {
          areaWord: (areas.length > 1 ? 'Areas' : 'Area'),
          areas: areas.map(escapeHtml).join(', ')
        }) + '</span>';
      }
    }
    el.innerHTML = html;
    el.style.display = 'block';
    return animalArea;
  }

  // Reset the ANIMAL's resolved-location header (county + WIN area) AND the map
  // area highlight to a neutral, empty state. Called at the START of every
  // address-mode lookup so a prior By-County (Tier-1) selection — its county,
  // WIN area, or green animal-area highlight — can NEVER persist and render
  // against a fresh address result (or against a lookup that errors out before
  // an aggregate arrives). The correct values are re-rendered from the new
  // aggregate's POINT-IN-POLYGON animal_county/animal_area once it resolves.
  function clearResolvedLocation() {
    var el = $('#resolved-location');
    if (el) { el.innerHTML = ''; el.style.display = 'none'; }
    if (typeof highlightAreas === 'function') highlightAreas([], []);
  }

  function setAddressStatus(msg) {
    var el = $('#address-status');
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = msg;
  }

  function setAddressError(msg) {
    var el = $('#address-error');
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = msg;
  }

  function actionLine(tone, iconLabel, html) {
    return '<div class="action-line ' + tone + '">' +
           '<span class="a-icon">' + escapeHtml(iconLabel) + '</span>' +
           '<div>' + html + '</div></div>';
  }

  // Map a canonical role label to the CSS modifier for its badge color.
  function roleBadgeClass(role) {
    var r = String(role).replace(/\s+/g, '').toUpperCase();
    if (r === 'RVSC&T') return 'rvs';
    if (r === 'COURIER') return 'courier';
    return ''; // C&T (default green)
  }

  // Tier 2: render the PII-safe out-of-county context list. Each row = role
  // badges + distance (mi) + coarse area/county context. Rows are already
  // sorted nearest-first by the Worker; preserve that order. Renders the
  // overflow notice when the Worker flags radius_too_broad/out_of_county_truncated,
  // and an empty-state when there are no out-of-county rows.
  //
  // The page renders ONLY fields present in the Worker payload
  // ({roles, distance_mi, win_area, county}) — never name/phone/coords.
  function renderContextList(agg, ctx) {
    var block = $('#ctx-block');
    var listEl = $('#ctx-list');
    var noticeEl = $('#ctx-notice');
    var emptyEl = $('#ctx-empty');
    var headerEl = $('#ctx-header');
    if (!block) return;

    // Only show the context block when the response actually carries the Tier 2
    // out_of_county field (i.e. a context=1 widen query). Otherwise hide it so
    // standalone Address mode is unchanged.
    if (!agg || !Array.isArray(agg.out_of_county)) {
      block.style.display = 'none';
      if (listEl) listEl.innerHTML = '';
      if (noticeEl) noticeEl.style.display = 'none';
      if (emptyEl) emptyEl.style.display = 'none';
      return;
    }

    var radius = (ctx && ctx.radius) ? ctx.radius : '';
    var county = (ctx && ctx.excludeCounty) ? ctx.excludeCounty : '';
    var T2 = MSG.tier2Aggregate;
    if (headerEl) {
      headerEl.textContent = county
        ? fmt(T2.ctxHeaderBeyond, { radius: radius, county: county })
        : fmt(T2.ctxHeader, { radius: radius });
    }

    // QUALIFIED-ONLY list (product decision 2026-06-09): the Tier 2 address
    // list shows ONLY taskable volunteers for THIS animal. The Worker already
    // returns qualified-only rows (it filtered by the qualify_roles param we
    // sent), but apply a DEFENSIVE frontend filter via the SHARED decision.js
    // predicate (qualifiesForAnimal — the SAME rule, no re-derivation here) so
    // an unqualified row can never render even if an older/cached Worker omits
    // the filter. When base info is absent (backward compat) no filtering runs.
    var qualifyFn = (window.WildlifeDecision &&
                     typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
      ? window.WildlifeDecision.qualifiesForAnimal : null;
    var hasBase = ctx && typeof ctx.issue === 'string' && ctx.issue !== '';
    var rows = agg.out_of_county;
    if (qualifyFn && hasBase) {
      rows = rows.filter(function (row) {
        var roleList = Array.isArray(row.roles) ? row.roles : [];
        return qualifyFn(roleList, !!ctx.rvs, ctx.issue);
      });
    }
    // Truncation reflects the QUALIFIED set: the Worker flags overflow only when
    // the qualified set itself exceeds the cap (it filtered before capping).
    var truncated = !!(agg.radius_too_broad || agg.out_of_county_truncated);

    if (noticeEl) {
      if (truncated) {
        noticeEl.textContent = fmt(T2.ctxOverflowNotice, { count: rows.length });
        noticeEl.style.display = 'block';
      } else {
        noticeEl.style.display = 'none';
        noticeEl.textContent = '';
      }
    }

    if (!rows.length) {
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) {
        emptyEl.textContent = fmt(T2.ctxEmpty, { radius: radius });
        emptyEl.style.display = 'block';
      }
      block.style.display = 'block';
      highlightFromContext(rows, agg.animal_area);
      return;
    }
    if (emptyEl) { emptyEl.style.display = 'none'; emptyEl.textContent = ''; }

    // Every listed row is qualified by definition now, so no qualified/
    // unqualified tag is rendered — just role badges + distance + area/county.
    var radiusNum = Number(radius);
    var html = rows.map(function (row) {
      var roleList = Array.isArray(row.roles) ? row.roles : [];
      var badges = roleList.map(function (r) {
        var cls = roleBadgeClass(r);
        return '<span class="role-badge' + (cls ? ' ' + cls : '') + '">' +
               escapeHtml(r) + '</span>';
      }).join('');

      var dist = (typeof row.distance_mi === 'number') ? row.distance_mi : Number(row.distance_mi);
      var distTxt;
      // DRIVING label ("X.X mi driving / ~Y min") when the Worker supplied a
      // per-volunteer driving duration (driving mode); otherwise the
      // straight-line label ("X.X mi"). Never show a time on the straight_line
      // fallback (duration_min absent) — mirrors the rehabber list wording.
      if (Number.isFinite(dist) && typeof row.duration_min === 'number') {
        distTxt = fmt(T2.ctxDistanceDriving, {
          dist: dist.toFixed(1),
          mins: String(row.duration_min)
        });
      } else {
        distTxt = fmt(T2.ctxDistance, { dist: Number.isFinite(dist) ? dist.toFixed(1) : '?' });
      }

      var ctxBits = [];
      if (row.win_area) ctxBits.push(fmt(T2.areaChip, { area: escapeHtml(String(row.win_area)) }));
      if (row.county) ctxBits.push(escapeHtml(String(row.county)));
      var ctxTxt = ctxBits.length ? ' <span class="ctx-ctx">· ' + ctxBits.join(' · ') + '</span>' : '';

      var edge = (Number.isFinite(dist) && Number.isFinite(radiusNum) && radiusNum > 0 &&
                  dist >= 0.85 * radiusNum)
        ? '<span class="ctx-edge">' + T2.ctxEdge + '</span>' : '';

      return '<li class="ctx-row">' +
             '<span class="role-badges">' + badges + '</span>' +
             '<span class="ctx-dist">' + distTxt + '</span>' +
             ctxTxt + edge +
             '</li>';
    }).join('');

    if (listEl) listEl.innerHTML = html;
    block.style.display = 'block';
    highlightFromContext(rows, agg.animal_area);
  }

  // Tier 2 highlight: emphasize the ANIMAL's OWN resolved WIN area (green) PLUS
  // the union of WIN areas present in the out_of_county rows (amber helper
  // areas), so the dispatcher sees where helpers cluster relative to the animal.
  // The primary area is the animal's POINT-IN-POLYGON area (agg.animal_area) —
  // NOT a carried-over By-County (Tier-1) selection — so a stale county can
  // never green-highlight the wrong area. Null when the coordinate is outside PA.
  function highlightFromContext(rows, animalArea) {
    var primary = (animalArea !== null && animalArea !== undefined &&
                   String(animalArea).trim() !== '') ? String(animalArea).trim() : null;
    var helperSet = {};
    (rows || []).forEach(function (row) {
      if (row && row.win_area !== null && row.win_area !== undefined) {
        var a = String(row.win_area).trim();
        if (a !== '') helperSet[a] = true;
      }
    });
    highlightAreas(primary ? [primary] : [], Object.keys(helperSet));
  }

  // Render one Tier 2 summary card the SAME way Tier 1 (renderCardsForCounty)
  // does: an avail/total ratio plus a "Marginal" badge when available is at or
  // below the marginal threshold. `total` is the in-range presence count;
  // `avail` is the available count. Backward compatible: when the Worker payload
  // predates availability (avail undefined), we fall back to total so the ratio
  // reads N/N and no spurious Marginal badge appears.
  function renderAggCard(bucket, total, avail, marginalThreshold) {
    var card = document.querySelector('.cap-card[data-bucket="' + bucket + '"]');
    if (!card) return;
    var hasAvail = (typeof avail === 'number');
    var availVal = hasAvail ? avail : total;

    var availEl = $('.avail', card);
    var totalEl = $('.total', card);
    if (availEl) availEl.textContent = String(availVal);
    if (totalEl) totalEl.textContent = String(total);

    var existing = $('.badge', card);
    if (existing) existing.remove();

    if (hasAvail && total > 0 && availVal <= marginalThreshold) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = MSG.coordinator.marginalBadge;
      card.appendChild(badge);
    }
  }

  // Render the "Nearest rehabbers" top-3 panel. `origin` is the point distances
  // are measured from:
  //   { lat, lon, source:'animal' }            — animal-address geocode
  //   { lat, lon, source:'county', county:'X' } — county-centroid fallback
  // Falsy origin (no animal coords AND no county centroid) hides the panel.
  // Each row shows: name, distance, open/closed status, the verbatim
  // availability text (line breaks preserved via CSS white-space:pre-line), and
  // a website link ONLY when a non-empty website exists.
  //
  // ON-DEMAND reveal: the ranked content is COMPUTED here (no network/geocode —
  // nearestRehabbers reads the already-loaded state.rehabbers) but kept HIDDEN
  // (#rehab-content display:none) behind a toggle button. The dispatcher clicks
  // "Show nearest rehabbers" to reveal the prepared list; the click only flips
  // visibility and never re-runs the lookup.
  function setRehabToggleLabel(btn, expanded) {
    var T2 = MSG.tier2Aggregate;
    if (!btn) return;
    btn.textContent = expanded ? T2.rehabHideBtn : T2.rehabShowBtn;
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }

  // Ask the Worker for ORS DRIVING distance + time for a pool of rehabber
  // candidates, then re-rank by driving distance and re-render the top `top`
  // rows via `rerender`. PII-safe: rehabber coords are PUBLIC. This is a pure
  // enhancement — on ANY failure (no ORS key, network/timeout, the Worker's
  // haversine fallback, or missing durations) it leaves the already-rendered
  // straight-line list untouched and never throws.
  function enhanceRehabDrivingDistances(origin, pool, top, rerender) {
    try {
      var url = WORKER_URL + '/?mode=rehabber_distances';
      var body = {
        origin: { lat: origin.lat, lon: origin.lon },
        destinations: pool.map(function (r) { return { lat: r.lat, lon: r.lon }; })
      };
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (resp) {
        if (!resp || !resp.ok) return null;
        return resp.json();
      }).then(function (data) {
        if (!data || !Array.isArray(data.distances)) return;
        // Only upgrade the display when the Worker actually returned DRIVING
        // numbers (source 'ors' AND at least one usable duration). Otherwise the
        // straight-line render is already correct — leave it.
        if (data.source !== 'ors') return;
        var anyDriving = false;
        for (var i = 0; i < pool.length && i < data.distances.length; i++) {
          var d = data.distances[i];
          if (!d) continue;
          if (typeof d.distance_mi === 'number') pool[i].drive_distance_mi = d.distance_mi;
          if (typeof d.duration_min === 'number') {
            pool[i].duration_min = d.duration_min;
            anyDriving = true;
          }
        }
        if (!anyDriving) return;
        // Re-rank by driving distance when present, else fall back to the
        // straight-line distance so every row still has a sensible key.
        var ranked = pool.slice().sort(function (a, b) {
          var ka = (typeof a.drive_distance_mi === 'number') ? a.drive_distance_mi : a.distance_mi;
          var kb = (typeof b.drive_distance_mi === 'number') ? b.drive_distance_mi : b.distance_mi;
          return ka - kb;
        });
        rerender(ranked.slice(0, top));
      }).catch(function () { /* graceful: keep straight-line render */ });
    } catch (e) {
      /* graceful: keep straight-line render */
    }
  }

  function renderNearestRehabbers(origin) {
    var T2 = MSG.tier2Aggregate;
    var block = $('#rehab-block');
    var contentEl = $('#rehab-content');
    var toggleEl = $('#rehab-toggle');
    var headerEl = $('#rehab-header');
    var listEl = $('#rehab-list');
    var emptyEl = $('#rehab-empty');
    if (!block) return;

    // No usable origin → keep the panel (and its reveal control) hidden entirely
    // (caller fell back; there is nothing to reveal).
    if (!origin || typeof origin.lat !== 'number' || typeof origin.lon !== 'number') {
      block.style.display = 'none';
      if (contentEl) contentEl.style.display = 'none';
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) { emptyEl.style.display = 'none'; emptyEl.textContent = ''; }
      return;
    }

    // Rank a WIDER candidate pool by straight-line distance. We render the top
    // 3 immediately (the always-available fallback) but keep a few extra
    // candidates so an optional DRIVING-distance re-rank can reorder sensibly.
    var REHAB_TOP = 3;
    var REHAB_CANDIDATES = 8;
    var pool = nearestRehabbers(origin.lat, origin.lon, REHAB_CANDIDATES);
    var rows = pool.slice(0, REHAB_TOP);
    var originNote = (origin.source === 'county' && origin.county)
      ? fmt(T2.rehabOriginCounty, { county: escapeHtml(origin.county) })
      : T2.rehabOriginAnimal;

    function renderRehabHeader(count) {
      if (headerEl) {
        headerEl.innerHTML = fmt(T2.rehabHeader, { count: count }) +
          ' <span style="font-weight:400;font-size:12.5px;color:var(--text-muted);">· ' +
          originNote + '</span>';
      }
    }
    renderRehabHeader(rows.length);

    // Build one <li> for a ranked rehabber row. Uses the DRIVING label
    // ("X.X mi driving / ~Y min") when both a driving distance and duration are
    // present; otherwise the straight-line label ("X.X mi"). Open/closed is
    // never surfaced (see nearestRehabbers note).
    function rehabRowHtml(r) {
      var distTxt;
      if (typeof r.drive_distance_mi === 'number' && typeof r.duration_min === 'number') {
        distTxt = fmt(T2.rehabDistanceDriving, {
          dist: r.drive_distance_mi.toFixed(1),
          mins: String(r.duration_min)
        });
      } else {
        distTxt = fmt(T2.rehabDistance, { dist: r.distance_mi.toFixed(1) });
      }

      var countyHtml = r.county
        ? '<div class="rehab-county">' +
          escapeHtml(fmt(T2.rehabCounty, { county: r.county })) + '</div>'
        : '';

      var phoneHtml;
      if (r.phone) {
        // tel: href uses digits/+ only; the visible label keeps the verbatim
        // formatted phone string from the dataset.
        var telHref = r.phone.replace(/[^0-9+]/g, '');
        phoneHtml = '<div class="rehab-phone"><a href="tel:' + escapeHtml(telHref) +
          '">' + escapeHtml(fmt(T2.rehabPhoneLabel, { phone: r.phone })) + '</a></div>';
      } else {
        phoneHtml = '<div class="rehab-phone rehab-phone-missing">' +
          escapeHtml(T2.rehabPhoneMissing) + '</div>';
      }

      var avail = r.availability && r.availability.trim()
        ? '<div class="rehab-avail">' + escapeHtml(r.availability) + '</div>'
        : '';
      var site = r.website
        ? '<div class="rehab-site"><a href="' + escapeHtml(r.website) +
          '" target="_blank" rel="noopener">' + escapeHtml(T2.rehabWebsiteLabel) + '</a></div>'
        : '';

      return '<li class="rehab-row">' +
             '<div class="rehab-top">' +
             '<span class="rehab-name">' + escapeHtml(r.rehab_name) + '</span>' +
             '<span class="rehab-dist">' + escapeHtml(distTxt) + '</span>' +
             '</div>' +
             countyHtml + phoneHtml + avail + site +
             '</li>';
    }

    function renderRehabRows(rowList) {
      renderRehabHeader(rowList.length);
      if (!rowList.length) {
        if (listEl) listEl.innerHTML = '';
        if (emptyEl) { emptyEl.textContent = T2.rehabNone; emptyEl.style.display = 'block'; }
        return;
      }
      if (emptyEl) { emptyEl.style.display = 'none'; emptyEl.textContent = ''; }
      if (listEl) {
        listEl.innerHTML = rowList.map(rehabRowHtml).join('');
      }
    }

    renderRehabRows(rows);

    // ── On-demand DRIVING distance enhancement (rehabbers only) ──────────
    // Ask the Worker for ORS driving distance + time for the candidate pool.
    // Rehabber coords are PUBLIC, so this is PII-safe. On success we re-rank by
    // driving distance and re-render with the "X.X mi driving / ~Y min" label.
    // On ANY failure (no key, network/timeout, haversine fallback from the
    // Worker, missing durations) the already-rendered straight-line list stays
    // exactly as-is — the panel must never break.
    if (pool.length) {
      enhanceRehabDrivingDistances(origin, pool, REHAB_TOP, renderRehabRows);
    }


    // The block (with its toggle button) is shown, but the prepared content is
    // collapsed by default. Each lookup resets it to the collapsed state.
    if (contentEl) contentEl.style.display = 'none';
    if (toggleEl) {
      setRehabToggleLabel(toggleEl, false);
      // Wire the reveal toggle exactly once. The handler only flips visibility;
      // the ranking is already computed above, so no re-fetch/geocode occurs.
      if (!toggleEl.dataset.bound) {
        toggleEl.dataset.bound = '1';
        toggleEl.addEventListener('click', function () {
          var c = $('#rehab-content');
          if (!c) return;
          var open = c.style.display !== 'none';
          c.style.display = open ? 'none' : 'block';
          setRehabToggleLabel(toggleEl, !open);
        });
      }
    }
    block.style.display = 'block';
  }

  // Pick the rehabber-ranking origin for a finished aggregate lookup:
  //   1. ANIMAL ADDRESS path — the Worker echoes top-level animal_lat/animal_lon
  //      on a successful geocode; use them as the origin.
  //   2. COUNTY path — no geocode coords; fall back to the county CENTROID
  //      (derived from pa_counties.geojson in buildMap → state.countyCentroids).
  //      The county is the Tier-1 carry-over (ctx.excludeCounty) or, failing
  //      that, the county currently selected in the form.
  // Returns an origin object or null when neither path yields coordinates.
  function pickRehabberOrigin(agg, ctx) {
    if (agg && typeof agg.animal_lat === 'number' && typeof agg.animal_lon === 'number') {
      return { lat: agg.animal_lat, lon: agg.animal_lon, source: 'animal' };
    }
    var county = (ctx && ctx.excludeCounty) ? ctx.excludeCounty : null;
    if (!county) {
      var sel = $('#county');
      if (sel && sel.value) county = sel.value;
    }
    if (county && state.countyCentroids && state.countyCentroids[county]) {
      var c = state.countyCentroids[county];
      return { lat: c.lat, lon: c.lon, source: 'county', county: county };
    }
    return null;
  }

  function renderAggregate(agg, ctx) {
    // DECONFLICTION: a geocoded address now governs. Rebind the active location
    // to 'address' and clear the county-mode coordinator line so the dropdown
    // county's coordinator is NEVER shown alongside the address area's. The
    // dropdown selection VALUE is preserved (only its influence is suspended).
    state.activeLocation = 'address';
    var countySel = $('#county');
    renderCoordLine(countySel ? countySel.value : null);

    var roles = (agg && agg.role_counts) || {};
    var avail = (agg && agg.role_available) || null;
    var ct = roles['C&T'] || 0;
    var rvs = roles['RVS C&T'] || 0;
    var courier = roles['COURIER'] || 0;
    var total = (typeof agg.total_in_range === 'number') ? agg.total_in_range : 0;
    var areas = (agg && Array.isArray(agg.win_areas)) ? agg.win_areas.slice() : [];

    // RESOLVED-LOCATION header: the ANIMAL's own county + WIN area is the single
    // governing/primary location. Returns the animal's own area (or null).
    var animalArea = renderResolvedLocation(agg);
    // Order the in-range areas so the animal's OWN area leads (primary), with
    // the remaining cross-boundary areas following — the coordinator list and
    // chip row then reflect "the address's area first".
    if (animalArea && areas.indexOf(String(animalArea)) !== -1) {
      areas = [String(animalArea)].concat(areas.filter(function (a) {
        return String(a) !== String(animalArea);
      }));
    }

    // Map: green-highlight the ANIMAL's OWN resolved WIN area (derived from the
    // final coordinate by the Worker's point-in-polygon). This is the single
    // authoritative animal-area highlight in plain Address mode and REPLACES any
    // stale By-County (Tier-1) highlight. The Tier-2 context flow re-highlights
    // with helper areas below; a null area leaves the map with no animal
    // highlight (coordinate outside PA).
    highlightAreas(animalArea ? [String(animalArea)] : [], []);

    // Marginal threshold mirrors Tier 1: prefer the Worker-supplied value
    // (global default), else fall back to the frontend config default.
    var marginalThreshold = (typeof agg.marginal_threshold === 'number')
      ? agg.marginal_threshold
      : ((state.config && typeof state.config.marginal_threshold === 'number')
          ? state.config.marginal_threshold : 1);

    setText('#agg-total', String(total));
    renderAggCard('C&T', ct, avail ? (avail['C&T'] || 0) : undefined, marginalThreshold);
    renderAggCard('RVS C&T', rvs, avail ? (avail['RVS C&T'] || 0) : undefined, marginalThreshold);
    renderAggCard('COURIER', courier, avail ? (avail['COURIER'] || 0) : undefined, marginalThreshold);

    var T2 = MSG.tier2Aggregate;
    var areasEl = $('#agg-areas');
    if (areas.length) {
      areasEl.innerHTML = areas.map(function (a) {
        return '<span class="win-chip">' + fmt(T2.areaChip, { area: escapeHtml(a) }) + '</span>';
      }).join('');
    } else {
      areasEl.innerHTML = '<span style="font-size:13px;color:var(--text-muted);">' + T2.areasNone + '</span>';
    }

    // ── Recommended actions (mirror dispatch_core.build_recommendation) ──
    var hasQualified = QUALIFYING_ROLES.some(function (r) { return (roles[r] || 0) > 0; });
    var actions = [];

    // INFORMATIONAL (not a directive): how many WIN volunteers are in range and
    // which areas they cover. The "WIN areas covered" chip row above is separate.
    if (total > 0 && areas.length) {
      actions.push(actionLine('go', '→', fmt(T2.winVolunteersFound, {
        count: total,
        areaWord: (areas.length > 1 ? 'areas' : 'area'),
        areas: areas.map(escapeHtml).join(', ')
      })));
    }

    // ── R2 LENIENT recommendation (Tier 2 widen / out-of-county) ─────────
    // When the shared animal base info (rvs/issue) is present AND the response
    // carries the out-of-county context list, recommend using the SAME strict
    // qualification rule as the per-row tag (decision.js qualifiesForAnimal),
    // but be FORGIVING: prefer fully-qualified helpers; when there are none in
    // range, SURFACE the close-but-not-qualified helpers as BACKUP options with
    // the gap stated ("find another way to get help"). The per-row TAG stays
    // honest/strict; this text is where the flexibility lives.
    var qualifyFn = (window.WildlifeDecision &&
                     typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
      ? window.WildlifeDecision.qualifiesForAnimal : null;
    var ooc = (agg && Array.isArray(agg.out_of_county)) ? agg.out_of_county : null;
    var leniencyHandled = false;
    // leniencyRan: true when the qualifyFn block actually executed (ooc + issue present).
    // leniencyQualifiedCount: qualifiedCount captured after the block for the outer banner check.
    var leniencyRan = false;
    var leniencyQualifiedCount = 0;

    if (qualifyFn && ooc && ctx && typeof ctx.issue === 'string' && ctx.issue !== '') {
      leniencyRan = true;
      var qualifiedAreas = {};
      var backupAreas = {};
      var qualifiedCount = 0;
      var backupCount = 0;
      var qualifiedRows = [];
      ooc.forEach(function (row) {
        var roleList = Array.isArray(row.roles) ? row.roles : [];
        var area = (row.win_area !== null && row.win_area !== undefined &&
                    String(row.win_area).trim() !== '') ? String(row.win_area).trim() : null;
        if (qualifyFn(roleList, !!ctx.rvs, ctx.issue)) {
          qualifiedCount += 1;
          qualifiedRows.push(row);
          if (area) qualifiedAreas[area] = true;
        } else {
          // Close-but-not-qualified: in range with a qualifying role, just not
          // the right one for THIS animal's RVS+Issue (e.g. a plain C&T for an
          // RVS capture, or a COURIER for a capture).
          backupCount += 1;
          if (area) backupAreas[area] = true;
        }
      });

      leniencyQualifiedCount = qualifiedCount;
      var qAreaList = Object.keys(qualifiedAreas).sort();
      var bAreaList = Object.keys(backupAreas).sort();
      var needRvs = (ctx.rvs === true);
      var needLabel = needRvs ? T2.needLabelRvs
        : (ctx.issue === 'transport' ? T2.needLabelTransport : T2.needLabelCapture);

      if (qualifiedCount > 0) {
        var qAreaTxt = qAreaList.length
          ? fmt(T2.areaClause, { areas: qAreaList.map(escapeHtml).join(', ') })
          : '';
        actions.push(actionLine('go', '→', fmt(T2.qualifiedHelpers, {
          count: qualifiedCount, areaClause: qAreaTxt, radius: ctx.radius
        })));
        // LOW CAPACITY WARNING: qualified helpers exist but count is at or below
        // the issue-specific minimum threshold. Nudge the dispatcher to consider
        // calling PA Game Commission as a backup.
        var t2ThreshKey = (ctx.issue === 'transport')
          ? 'courier_transport_min_available'
          : (ctx.rvs ? 'ct_rvs_capture_min_available' : 'ct_any_capture_min_available');
        var t2MinAvail = (state.config && typeof state.config[t2ThreshKey] === 'number')
          ? state.config[t2ThreshKey]
          : (MSG.thresholds[t2ThreshKey] || 1);
        if (qualifiedCount <= t2MinAvail) {
          var lowCapHtml = fmt(T2.lowCapacityWarning, {
            count: qualifiedCount, phone: escapeHtml(PGC_PHONE)
          });
          // Volunteer roster: show name + availability note for each qualified row,
          // matching Tier-1's .rec-marginal visual pattern.
          if (qualifiedRows.length > 0) {
            lowCapHtml += '<div class="rec-marginal t2-marginal-roster">';
            lowCapHtml += '<div class="rec-marginal-header">' + MSG.recommendation.lowCapacityHeader + '</div>';
            lowCapHtml += '<ul>';
            qualifiedRows.forEach(function (qRow) {
              var vName = (qRow && qRow.name) ? escapeHtml(String(qRow.name)) : '';
              var vNote = (qRow && qRow.availability_note) ? escapeHtml(String(qRow.availability_note)) : '';
              var entry = vName ? '<strong>' + vName + '</strong>' : '';
              if (vNote) { entry += (entry ? ' \u2014 ' : '') + '<em>' + vNote + '</em>'; }
              if (!entry) { entry = '<em>' + MSG.recommendation.noAvailabilityInfo + '</em>'; }
              lowCapHtml += '<li>' + entry + '</li>';
            });
            lowCapHtml += '</ul></div>';
          }
          actions.push(actionLine('escalate', '!', lowCapHtml));
        }
        leniencyHandled = true;
      } else if (backupCount > 0) {
        // No fully-qualified helper in range: lead with the bold no-qualified banner,
        // then surface the backups WITH the gap below it.
        actions.push('<div class="no-qualified-banner">' +
          escapeHtml(fmt(T2.noQualifiedBanner, { radius: ctx.radius })) + '</div>');
        var bAreaTxt = bAreaList.length
          ? fmt(T2.areaClause, { areas: bAreaList.map(escapeHtml).join(', ') })
          : '';
        actions.push(actionLine('escalate', '!', fmt(T2.backupHelpers, {
          role: escapeHtml(needLabel),
          radius: ctx.radius,
          count: backupCount,
          areaClause: bAreaTxt,
          gapClause: (needRvs ? T2.backupGapRvs : T2.backupGapOther),
          phone: escapeHtml(PGC_PHONE)
        })));
        leniencyHandled = true;
      }
    }

    // Show the no-qualified banner when:
    //   (a) leniency block ran and found qualifiedCount=0 with no backups either
    //       (leniencyHandled stays false — COURIER-only for Capture, etc.)
    //   (b) leniency block never ran (no ooc/issue context) and role_counts
    //       show no qualifying roles at all
    if ((leniencyRan && leniencyQualifiedCount === 0 && !leniencyHandled) ||
        (!leniencyRan && !hasQualified)) {
      actions.push('<div class="no-qualified-banner">' +
        escapeHtml(fmt(T2.noQualifiedBanner, { radius: ctx.radius })) + '</div>');
      actions.push(actionLine('escalate', '!', fmt(T2.noQualifiedEscalate, {
        radius: ctx.radius, phone: escapeHtml(PGC_PHONE)
      })));
    }

    // INFORMATIONAL: show the coordinator for the ANIMAL's OWN resolved WIN area
    // only. The animal's area owns the incident — exactly ONE coordinator line,
    // never one per volunteer area. agg.animal_area (PIP-resolved by the Worker,
    // surfaced via renderResolvedLocation → animalArea) drives this. If null
    // (outside PA or unresolved), omit the coordinator line entirely.
    if (animalArea) {
      var animalAreaCoordName = state.coordinators[String(animalArea)];
      if (animalAreaCoordName && String(animalAreaCoordName).trim()) {
        actions.push(actionLine('go', '→', fmt(T2.areaCoordinatorListed, {
          area: escapeHtml(animalArea),
          name: escapeHtml(String(animalAreaCoordName).trim())
        })));
      }
    }

    // Closest-rehabber suggestion needs the animal coordinate. The Worker
    // returns a PII-free aggregate ONLY (no coords), and the browser no longer
    // geocodes (that was the CORS bug), so this is shown only if a caller still
    // supplies lat/lon in ctx.
    if (ctx && typeof ctx.lat === 'number' && typeof ctx.lon === 'number') {
      var closest = findClosestRehabber(ctx.lat, ctx.lon);
      if (closest) {
        var dist = closest.distance_mi.toFixed(1);
        var site = closest.website
          ? ' (<a href="' + escapeHtml(closest.website) + '" target="_blank" rel="noopener">' + T2.rehabberWebsiteLabel + '</a>)'
          : '';
        actions.push(actionLine('neutral', '⌂', fmt(T2.closestRehabber, {
          name: escapeHtml(closest.rehab_name),
          dist: dist, site: site
        })));
      }
    }

    if (!actions.length) {
      actions.push(actionLine('escalate', '!', fmt(T2.noVolunteersNoData, {
        phone: escapeHtml(PGC_PHONE)
      })));
    }

    var premiseHtml = '';
    if (ctx && typeof ctx.issue === 'string') {
      var P_ISSUE_LABELS = { capture: 'Capture', transport: 'Transport' };
      var pIssueLabel = P_ISSUE_LABELS[ctx.issue] || ctx.issue;
      var pRvsLabel = ctx.rvs ? 'RVS' : 'non-RVS';
      premiseHtml = '<div class="agg-premise">' + escapeHtml(fmt(T2.premiseLine, { issue: pIssueLabel, rvsLabel: pRvsLabel })) + '</div>';
    }

    $('#agg-actions').innerHTML = premiseHtml + actions.join('');
    renderContextList(agg, ctx);
    renderNearestRehabbers(pickRehabberOrigin(agg, ctx));
    $('#address-result').style.display = 'block';
  }

  function onAddressSubmit() {
    if (state.addressBusy) return;
    setAddressError('');
    var addr = ($('#animal-address').value || '').trim();
    var radius = clampRadius($('#radius-mi').value);
    $('#radius-mi').value = String(radius);

    if (!addr) {
      setAddressError(MSG.geocodeErrors.enterAddress);
      return;
    }

    state.addressBusy = true;
    var btn = $('#address-btn');
    btn.disabled = true;
    // Re-running the lookup clears any stale flag on the result surface.
    clearStale($('#address-result'));
    $('#address-result').style.display = 'none';
    // Reset the animal's resolved county/area header + map highlight up front so
    // a prior By-County (Tier-1) selection can never leak into this address run.
    clearResolvedLocation();
    setAddressStatus(fmt(MSG.geocodeErrors.finding, { radius: radius }));

    // Always request the PII-safe context list (context=1). Two shapes:
    //   - Standalone Address lookup: no county to exclude -> the Worker returns
    //     ALL in-range qualifying volunteers (renderContextList uses the plain
    //     "in range" heading).
    //   - Tier 2 "widen": a county carried over from Tier 1 scopes the query to
    //     EXCLUDE it (out-of-county heading). ctx carries excludeCounty so
    //     renderContextList can label/empty-state correctly.
    var excludeCounty = state.widenCounty || null;
    var base = readAnimalBaseInfo();
    var ctx = { radius: radius, rvs: base.rvs, issue: base.issue };
    if (excludeCounty) ctx.excludeCounty = excludeCounty;
    // Pass the currently selected Tier-1 county to the Worker so it can fall
    // back to it for WIN-area derivation when PIP returns null (out-of-PA coord
    // or address that geocodes outside PA). The Worker marks the response with
    // county_source="tier1_fallback" so the UI can show an informational flag.
    var tier1County = ($('#county') && $('#county').value) || null;

    // Single origin: prefer the COORDINATE captured when the dispatcher picked a
    // typeahead suggestion (Photon already resolved it) — submit those coords
    // DIRECTLY so the Worker skips the weak Census exact-match geocode that
    // dead-ends on rural PA. Only valid when the captured coord still matches the
    // current input text (a later edit cleared it in acOnInput). Otherwise fall
    // back to the address STRING path (free-typed / pasted address -> Census,
    // with the Worker's Photon fallback behind it).
    var picked = state.selectedAnimalCoord;
    var useCoord = picked &&
      typeof picked.lat === 'number' && typeof picked.lon === 'number' &&
      picked.label === addr;
    var lookup = useCoord
      ? fetchAggregateByCoord(picked.lat, picked.lon, radius,
          { context: true, excludeCounty: excludeCounty, tier1County: tier1County, base: base })
      : fetchAggregateByAddress(addr, radius,
          { context: true, excludeCounty: excludeCounty, tier1County: tier1County, base: base });
    lookup
      .then(function (agg) {
        setAddressStatus('');
        // Render in its OWN try/catch so a rendering bug (e.g. a missing DOM
        // target) surfaces a DISTINCT message instead of being swallowed by the
        // network-error catch below and shown as "could not reach the service".
        try {
          renderAggregate(agg, ctx);
        } catch (renderErr) {
          if (window.console && console.error) console.error('renderAggregate failed', renderErr);
          setAddressError(MSG.geocodeErrors.renderFailed);
        }
      })
      .catch(function (err) {
        setAddressStatus('');
        var code = err && err.message ? err.message : '';
        if (code === 'address_not_found') {
          setAddressError(MSG.geocodeErrors.addressNotFound);
        } else if (code === 'geocoder_unavailable') {
          setAddressError(MSG.geocodeErrors.geocoderUnavailable);
        } else if (code === 'worker_400') {
          setAddressError(MSG.geocodeErrors.worker400);
        } else {
          setAddressError(MSG.geocodeErrors.networkError);
        }
      })
      .then(function () {
        state.addressBusy = false;
        btn.disabled = false;
      });
  }

  // ─── Address autocomplete (typeahead) ──────────────────────────────
  // Debounced lookup proxied THROUGH the Worker (single CORS surface, key/
  // rate-limit stay server-side). Keyboard + click select; on select we fill
  // the input and the existing geocode+radius submit flow runs unchanged.
  var ac = {
    items: [],        // current [{label, lat?, lon?}]
    active: -1,       // highlighted index, -1 = none
    timer: null,      // debounce timer
    seq: 0,           // request sequence guard (drop stale responses)
    lastQuery: ''     // query that produced the open list (suppress re-open)
  };

  // ─── Pin-drop coordinate detection (P2) ────────────────────────────
  // A caller sometimes reads a Google-Maps pin-drop ("40.4612, -79.8553")
  // instead of a street address. We detect that CLIENT-SIDE and surface it as
  // a synthetic suggestion (same {label,lat,lon} shape Photon/Census produce)
  // so acSelect submits animal_lat/animal_lon DIRECTLY — no geocoding. County +
  // WIN area are derived SERVER-SIDE by the Worker's PIP engine on that submit.
  //
  // PA_BBOX MUST match worker/src/autocomplete.js so a coordinate is accepted
  // only when it lands inside Pennsylvania.
  var PA_BBOX = { minLon: -80.519891, minLat: 39.719799, maxLon: -74.689516, maxLat: 42.269860 };
  var COORD_RE = /^\s*([-+]?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*([-+]?\d{1,3}(?:\.\d+)?)\s*$/;

  function inPaBounds(lat, lon) {
    return lat >= PA_BBOX.minLat && lat <= PA_BBOX.maxLat &&
           lon >= PA_BBOX.minLon && lon <= PA_BBOX.maxLon;
  }

  // Returns { lat, lon } inside PA when `raw` is a coordinate pair, else null
  // (caller then falls through to the normal Photon address path).
  function detectPinDrop(raw) {
    if (typeof raw !== 'string') return null;
    // Strip Google-Maps-style labels/parens (e.g. "(40.46, -79.85)",
    // "lat 40.46, lon -79.85") down to digits/signs/dot/comma/space.
    var s = raw.replace(/[^0-9.,+\-\s]/g, ' ').trim();
    var m = COORD_RE.exec(s);
    if (!m) return null;
    var a = parseFloat(m[1]);
    var b = parseFloat(m[2]);
    if (!isFinite(a) || !isFinite(b)) return null;
    // Parse as (lat, lon).
    if (inPaBounds(a, b)) return { lat: a, lon: b };
    // Swapped (lon, lat) order.
    if (inPaBounds(b, a)) return { lat: b, lon: a };
    // Positive-lon sign-typo: negate the lon if that lands in PA.
    if (b > 0 && inPaBounds(a, -b)) return { lat: a, lon: -b };
    if (a > 0 && inPaBounds(b, -a)) return { lat: b, lon: -a };
    return null;
  }

  function acEls() {
    return { input: $('#animal-address'), list: $('#address-suggestions') };
  }

  function acClose() {
    var els = acEls();
    if (els.list) { els.list.hidden = true; els.list.innerHTML = ''; }
    if (els.input) els.input.setAttribute('aria-expanded', 'false');
    if (els.input) els.input.removeAttribute('aria-activedescendant');
    ac.items = [];
    ac.active = -1;
  }

  function acRender() {
    var els = acEls();
    if (!els.list) return;
    if (!ac.items.length) { acClose(); return; }
    var html = '';
    for (var i = 0; i < ac.items.length; i++) {
      var sel = (i === ac.active);
      html += '<li id="ac-opt-' + i + '" class="ac-item' + (sel ? ' ac-active' : '') +
              '" role="option" data-idx="' + i + '"' +
              (sel ? ' aria-selected="true"' : '') + '>' +
              escapeHtml(ac.items[i].label) + '</li>';
    }
    els.list.innerHTML = html;
    els.list.hidden = false;
    if (els.input) {
      els.input.setAttribute('aria-expanded', 'true');
      if (ac.active >= 0) {
        els.input.setAttribute('aria-activedescendant', 'ac-opt-' + ac.active);
      } else {
        els.input.removeAttribute('aria-activedescendant');
      }
    }
  }

  function acSelect(idx) {
    if (idx < 0 || idx >= ac.items.length) return;
    var els = acEls();
    var item = ac.items[idx];
    var label = item.label;
    if (els.input) els.input.value = label;
    ac.lastQuery = label; // typing 'input' fires from value set? no — set manually
    // Photon ALREADY resolved this suggestion to a coordinate (autocomplete.js
    // populates lat/lon). Capture it so the submit can send animal_lat/animal_lon
    // DIRECTLY and skip the weak Census exact-match geocode. Keyed to the exact
    // label so acOnInput can detect a later edit and invalidate it.
    if (typeof item.lat === 'number' && typeof item.lon === 'number' &&
        isFinite(item.lat) && isFinite(item.lon)) {
      state.selectedAnimalCoord = { lat: item.lat, lon: item.lon, label: label };
    } else {
      state.selectedAnimalCoord = null;
    }
    acClose();
    if (els.input) els.input.focus();
  }

  function acFetch(query) {
    var mySeq = ++ac.seq;
    var url = WORKER_URL +
      '?autocomplete=' + encodeURIComponent(query) +
      '&limit=' + encodeURIComponent(AC_LIMIT);
    fetch(url, { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) return { suggestions: [] };
        return resp.json();
      })
      .then(function (data) {
        if (mySeq !== ac.seq) return; // stale response — a newer keystroke won
        var list = (data && Array.isArray(data.suggestions)) ? data.suggestions : [];
        ac.items = list.filter(function (it) {
          return it && typeof it.label === 'string' && it.label.trim() !== '';
        }).slice(0, AC_LIMIT);
        ac.active = -1;
        acRender();
      })
      .catch(function () {
        if (mySeq !== ac.seq) return;
        acClose();
      });
  }

  function acOnInput(immediate) {
    var els = acEls();
    var q = (els.input && els.input.value ? els.input.value : '').trim();
    if (ac.timer) { clearTimeout(ac.timer); ac.timer = null; }
    if (q === ac.lastQuery) { return; } // selection just filled the box
    ac.lastQuery = '';
    // The text diverged from the selected suggestion's label: any captured
    // coord is now stale (it belongs to a DIFFERENT address), so drop it. Submit
    // then reverts to the address-string path until a new suggestion is picked.
    state.selectedAnimalCoord = null;
    if (q.length < AC_MIN_CHARS) { acClose(); return; }
    // PIN-DROP: a pasted/typed coordinate pair short-circuits geocoding. Surface
    // it as a synthetic suggestion (same {label,lat,lon} shape) so the existing
    // acSelect path captures the coord and the submit sends animal_lat/animal_lon.
    var pin = detectPinDrop(q);
    if (pin) {
      ac.seq++; // invalidate any in-flight Photon fetch
      if (ac.timer) { clearTimeout(ac.timer); ac.timer = null; }
      ac.items = [{
        label: fmt(MSG.autocomplete.pinDrop, { lat: pin.lat, lon: pin.lon }),
        lat: pin.lat,
        lon: pin.lon
      }];
      ac.active = -1;
      acRender();
      return;
    }
    // PASTE-AND-GO: a paste delivers a full address in one shot, so query Photon
    // IMMEDIATELY (no debounce) — the matched candidate then appears in the same
    // dropdown for the dispatcher to eyeball and pick (which reuses its Photon
    // coords and bypasses Census). Typing still debounces.
    if (immediate === true) { acFetch(q); return; }
    ac.timer = setTimeout(function () { acFetch(q); }, AC_DEBOUNCE_MS);
  }

  // A paste fires BEFORE the input value is updated, so defer to the next tick
  // to read the settled value, then run the same query path with no debounce.
  function acOnPaste() {
    setTimeout(function () { acOnInput(true); }, 0);
  }

  function acOnKeydown(e) {
    var open = ac.items.length > 0;
    if (e.key === 'ArrowDown') {
      if (!open) return;
      e.preventDefault();
      ac.active = (ac.active + 1) % ac.items.length;
      acRender();
    } else if (e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      ac.active = (ac.active - 1 + ac.items.length) % ac.items.length;
      acRender();
    } else if (e.key === 'Enter') {
      if (open && ac.active >= 0) {
        e.preventDefault();
        acSelect(ac.active);
      } else {
        // No active suggestion — fall through to submit (handled separately).
      }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); acClose(); }
    }
  }

  function setupAutocomplete() {
    var els = acEls();
    if (!els.input || !els.list) return;
    els.input.addEventListener('input', function () { acOnInput(false); });
    els.input.addEventListener('paste', acOnPaste);
    els.input.addEventListener('keydown', acOnKeydown);
    // Click / tap select.
    els.list.addEventListener('mousedown', function (e) {
      // mousedown (not click) so it fires before the input blur closes the list.
      var li = e.target;
      while (li && li !== els.list && !li.getAttribute) li = li.parentNode;
      while (li && li !== els.list && li.getAttribute && li.getAttribute('data-idx') === null) {
        li = li.parentNode;
      }
      if (li && li.getAttribute && li.getAttribute('data-idx') !== null) {
        e.preventDefault();
        acSelect(Number(li.getAttribute('data-idx')));
      }
    });
    // Close when focus leaves the input (after click handlers run).
    els.input.addEventListener('blur', function () {
      setTimeout(acClose, 120);
    });
  }

  // ─── WIN Areas map: render + dynamic highlight (D5.2-5.3) ──────────
  // Self-drawn inline-SVG choropleth — NO runtime CDN dependency (no Leaflet/
  // Mapbox/D3). We fetch the committed GeoJSON and project lon/lat to an SVG
  // viewBox with a simple equirectangular transform fit to PA's bbox, applying
  // a cos(midLat) correction so the map is not horizontally stretched.

  var MAP_W = 800;   // SVG viewBox width (lon axis)
  var MAP_PAD = 8;   // inner padding (viewBox units)

  function areaColor(area) {
    return AREA_COLORS[String(area)] || AREA_FALLBACK;
  }

  // Compute the geographic bbox across all features (handles Polygon +
  // MultiPolygon). Returns {minLon,minLat,maxLon,maxLat}.
  function geoBbox(features) {
    var minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    function scanRing(ring) {
      for (var i = 0; i < ring.length; i++) {
        var lon = ring[i][0], lat = ring[i][1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    features.forEach(function (f) {
      eachRing(f.geometry, scanRing);
    });
    return { minLon: minLon, minLat: minLat, maxLon: maxLon, maxLat: maxLat };
  }

  // Invoke cb(ring) for every linear ring in a Polygon/MultiPolygon geometry.
  function eachRing(geom, cb) {
    if (!geom || !geom.coordinates) return;
    if (geom.type === 'Polygon') {
      geom.coordinates.forEach(cb);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach(function (poly) { poly.forEach(cb); });
    }
  }

  // Build a projector from geo bbox -> SVG units. lon increases left->right,
  // lat increases bottom->top so we flip Y. cos(midLat) keeps the aspect honest.
  function makeProjector(bbox) {
    var midLat = (bbox.minLat + bbox.maxLat) / 2;
    var lonScale = Math.cos(midLat * Math.PI / 180);
    var geoW = (bbox.maxLon - bbox.minLon) * lonScale;
    var geoH = (bbox.maxLat - bbox.minLat);
    var innerW = MAP_W - 2 * MAP_PAD;
    var scale = innerW / geoW;
    var innerH = geoH * scale;
    var height = innerH + 2 * MAP_PAD;
    function project(lon, lat) {
      var x = MAP_PAD + (lon - bbox.minLon) * lonScale * scale;
      var y = MAP_PAD + (bbox.maxLat - lat) * scale; // flip Y
      return [x, y];
    }
    return { project: project, width: MAP_W, height: height };
  }

  // Turn one geometry into an SVG path "d" string (sub-paths per ring).
  function geometryToPath(geom, proj) {
    var parts = [];
    eachRing(geom, function (ring) {
      var d = '';
      for (var i = 0; i < ring.length; i++) {
        var p = proj.project(ring[i][0], ring[i][1]);
        d += (i === 0 ? 'M' : 'L') + p[0].toFixed(2) + ' ' + p[1].toFixed(2);
      }
      if (d) d += 'Z';
      parts.push(d);
    });
    return parts.join(' ');
  }

  var SVGNS = 'http://www.w3.org/2000/svg';

  // Label tuning (viewBox units). LABEL_FONT is the always-on label size;
  // LABEL_FIT_FACTOR approximates glyph width as a fraction of font size so we
  // can decide whether a name fits inside its county without measuring text.
  var LABEL_FONT = 9;
  var LABEL_FIT_FACTOR = 0.52;

  // Signed area + centroid of a single projected ring (shoelace). Returns
  // { area, cx, cy } with area's sign indicating winding; |area| ranks rings.
  function ringCentroid(pts) {
    var n = pts.length, a = 0, cx = 0, cy = 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = pts[i][0], yi = pts[i][1];
      var xj = pts[j][0], yj = pts[j][1];
      var cross = xj * yi - xi * yj;
      a += cross;
      cx += (xi + xj) * cross;
      cy += (yi + yj) * cross;
    }
    a = a / 2;
    if (Math.abs(a) < 1e-9) {
      // Degenerate ring: fall back to the vertex mean so we still get a point.
      var sx = 0, sy = 0;
      for (var k = 0; k < n; k++) { sx += pts[k][0]; sy += pts[k][1]; }
      return { area: 0, cx: n ? sx / n : 0, cy: n ? sy / n : 0,
        w: 0, h: 0 };
    }
    cx = cx / (6 * a);
    cy = cy / (6 * a);
    return { area: Math.abs(a), cx: cx, cy: cy };
  }

  // Compute the label anchor for a geometry: project every ring, keep the one
  // with the largest area (the visual body of a MultiPolygon), and return its
  // centroid plus that ring's projected width/height for fit testing.
  function labelAnchor(geom, proj) {
    var best = null;
    eachRing(geom, function (ring) {
      var pts = [];
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (var i = 0; i < ring.length; i++) {
        var p = proj.project(ring[i][0], ring[i][1]);
        pts.push(p);
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      if (pts.length < 3) return;
      var c = ringCentroid(pts);
      c.w = maxX - minX;
      c.h = maxY - minY;
      if (!best || c.area > best.area) best = c;
    });
    return best;
  }

  // Area-weighted (shoelace) centroid of a geometry in RAW lon/lat degrees,
  // computed over the largest ring (the visual body of a Polygon/MultiPolygon)
  // so the result sits inside the county. Independent of the SVG projection —
  // this is the COUNTY-PATH origin used to rank rehabbers when the dispatcher
  // only picks a county (no animal address). Returns { lat, lon } or null.
  function geoCentroidLatLon(geom) {
    var best = null; // { area, lat, lon }
    eachRing(geom, function (ring) {
      var n = ring.length;
      if (n < 3) return;
      var a = 0, cx = 0, cy = 0;
      for (var i = 0, j = n - 1; i < n; j = i++) {
        var xi = ring[i][0], yi = ring[i][1];
        var xj = ring[j][0], yj = ring[j][1];
        var cross = xj * yi - xi * yj;
        a += cross;
        cx += (xi + xj) * cross;
        cy += (yi + yj) * cross;
      }
      a = a / 2;
      var lon, lat;
      if (Math.abs(a) < 1e-12) {
        var sx = 0, sy = 0;
        for (var k = 0; k < n; k++) { sx += ring[k][0]; sy += ring[k][1]; }
        lon = sx / n; lat = sy / n;
        a = 0;
      } else {
        lon = cx / (6 * a);
        lat = cy / (6 * a);
      }
      var absA = Math.abs(a);
      if (!best || absA > best.area) best = { area: absA, lat: lat, lon: lon };
    });
    return best ? { lat: best.lat, lon: best.lon } : null;
  }

  // Draw the choropleth: 67 county <path>s colored by win_area, into an inline
  // SVG. Builds state.mapAreas (area -> [<path>]) for fast highlight toggling.
  function buildMap(geojson) {
    var wrap = $('#map-svg-wrap');
    if (!wrap) return;
    var features = (geojson && Array.isArray(geojson.features)) ? geojson.features : [];
    if (!features.length) {
      wrap.innerHTML = '<div class="map-note">Map data unavailable.</div>';
      return;
    }
    var bbox = geoBbox(features);
    var proj = makeProjector(bbox);

    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + proj.width + ' ' + proj.height.toFixed(2));
    svg.setAttribute('class', 'map-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Pennsylvania counties colored by WIN area');

    state.mapAreas = {};
    state.mapCounties = {};
    state.countyCentroids = {};
    var labelInfos = [];
    features.forEach(function (f) {
      var props = f.properties || {};
      var county = String(props.county || '');
      var area = (props.win_area === null || props.win_area === undefined)
        ? '' : String(props.win_area);
      var path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', geometryToPath(f.geometry, proj));
      path.setAttribute('class', 'county-path');
      path.setAttribute('fill', areaColor(area));
      path.setAttribute('data-county', county);
      path.setAttribute('data-area', area);
      // County name tooltip (hover); on-map labels are added in a second pass.
      var title = document.createElementNS(SVGNS, 'title');
      title.textContent = area ? (county + ' — Area ' + area) : county;
      path.appendChild(title);
      svg.appendChild(path);
      if (!state.mapAreas[area]) state.mapAreas[area] = [];
      state.mapAreas[area].push(path);
      if (county) state.mapCounties[county] = path;
      if (county) {
        var ctr = geoCentroidLatLon(f.geometry);
        if (ctr) state.countyCentroids[county] = ctr;
      }
      var anchor = labelAnchor(f.geometry, proj);
      if (county && anchor) {
        labelInfos.push({ county: county, anchor: anchor });
      }
    });

    // Second pass: county-name labels, drawn on TOP of every fill so they read
    // over the area colors. Crowding rule — if the name's estimated width does
    // not fit inside the county's largest projected ring (with a small margin),
    // the label is hover-only (class county-label-hover) and otherwise hidden;
    // the always-on labels (class county-label) are the ones that fit.
    labelInfos.forEach(function (info) {
      var name = info.county;
      var a = info.anchor;
      var textW = name.length * LABEL_FONT * LABEL_FIT_FACTOR;
      var fits = textW <= (a.w - 2) && a.h >= LABEL_FONT;
      var label = document.createElementNS(SVGNS, 'text');
      label.setAttribute('x', a.cx.toFixed(2));
      label.setAttribute('y', a.cy.toFixed(2));
      label.setAttribute('class', fits ? 'county-label' : 'county-label county-label-hover');
      label.setAttribute('data-county', name);
      label.textContent = name;
      svg.appendChild(label);
    });

    wrap.innerHTML = '';
    wrap.appendChild(svg);
    state.mapBuilt = true;
    if (state.currentCounty) highlightCounty(state.currentCounty);
    buildLegend();
  }

  // Compact legend: one swatch per area present on the map, numeric-sorted.
  function buildLegend() {
    var legend = $('#map-legend');
    if (!legend) return;
    var areas = Object.keys(state.mapAreas).filter(function (a) { return a !== ''; });
    areas.sort(function (a, b) {
      var na = parseInt(a, 10), nb = parseInt(b, 10);
      if (na !== nb) return na - nb;
      return a < b ? -1 : (a > b ? 1 : 0); // 15N before 15S
    });
    legend.innerHTML = areas.map(function (a) {
      return '<span class="leg-item" data-leg-area="' + escapeHtml(a) + '">' +
        '<span class="leg-swatch" style="background:' + areaColor(a) + '"></span>' +
        'Area ' + escapeHtml(a) + '</span>';
    }).join('');
  }

  // ── Dynamic highlight API ──────────────────────────────────────────
  // highlightAreas(animalAreas, helperAreas): emphasize counties in the given
  // WIN areas and de-emphasize the rest. animalAreas get the strong green
  // "animal area" treatment; helperAreas get the amber "helper area" treatment.
  // Either argument may be a single value or an array; pass empty/none to clear.
  function normAreaList(v) {
    if (v === null || v === undefined) return [];
    var arr = Array.isArray(v) ? v : [v];
    var out = [];
    arr.forEach(function (a) {
      if (a === null || a === undefined) return;
      var s = String(a).trim();
      if (s !== '') out.push(s);
    });
    return out;
  }

  function highlightAreas(animalAreas, helperAreas) {
    var animal = normAreaList(animalAreas);
    var helper = normAreaList(helperAreas);
    var animalSet = {};
    animal.forEach(function (a) { animalSet[a] = true; });
    // A helper area that is ALSO the animal area stays "animal" (stronger).
    var helperSet = {};
    helper.forEach(function (a) { if (!animalSet[a]) helperSet[a] = true; });

    var svg = $('.map-svg');
    var panel = $('#map-panel');
    var any = animal.length > 0 || Object.keys(helperSet).length > 0;

    // Clear existing highlight classes on every path, then re-apply.
    Object.keys(state.mapAreas).forEach(function (area) {
      var cls = animalSet[area] ? 'hl-animal' : (helperSet[area] ? 'hl-helper' : '');
      state.mapAreas[area].forEach(function (p) {
        p.classList.remove('hl-animal', 'hl-helper');
        if (cls) p.classList.add(cls);
      });
    });

    if (svg) {
      if (any) svg.classList.add('dimmed');
      else svg.classList.remove('dimmed');
    }
    if (panel) {
      if (any) panel.classList.add('has-highlight');
      else panel.classList.remove('has-highlight');
    }

    // Reflect active areas in the legend (bold the ones in play).
    var legend = $('#map-legend');
    if (legend) {
      $$('.leg-item', legend).forEach(function (item) {
        var a = item.getAttribute('data-leg-area');
        if (a && (animalSet[a] || helperSet[a])) item.classList.add('leg-on');
        else item.classList.remove('leg-on');
      });
    }
  }

  function clearHighlight() { highlightAreas([], []); }

  // Distinctly mark the single selected/working county (county mode) ON TOP of
  // the existing WIN-area shading. Pass a county name to set it, or a falsy
  // value to clear. Only one path ever carries .hl-county at a time.
  function highlightCounty(countyName) {
    var name = (countyName === null || countyName === undefined) ? '' : String(countyName).trim();
    state.currentCounty = name || null;
    if (!state.mapBuilt) return; // re-applied by buildMap once the SVG exists
    // Clear any prior selection mark, then mark the new one (if present).
    Object.keys(state.mapCounties).forEach(function (c) {
      state.mapCounties[c].classList.remove('hl-county');
    });
    if (name && state.mapCounties[name]) {
      state.mapCounties[name].classList.add('hl-county');
    }
  }

  function clearCountyHighlight() { highlightCounty(null); }

  // Persist the panel open/closed state (localStorage; gracefully no-ops if
  // unavailable). Default collapsed: only OPEN when explicitly stored "1".
  function restoreMapPanelState() {
    var panel = $('#map-panel');
    if (!panel) return;
    try {
      if (window.localStorage && localStorage.getItem(MAP_PANEL_KEY) === '1') {
        panel.open = true;
      }
    } catch (e) { /* storage blocked — leave default collapsed */ }
    panel.addEventListener('toggle', function () {
      try {
        if (window.localStorage) localStorage.setItem(MAP_PANEL_KEY, panel.open ? '1' : '0');
      } catch (e) { /* ignore */ }
    });
  }

  function loadMap() {
    return fetch(GEOJSON_PATH, { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (json) { buildMap(json); })
      .catch(function () {
        var wrap = $('#map-svg-wrap');
        if (wrap) wrap.innerHTML = '<div class="map-note">Map could not be loaded.</div>';
      });
  }

  // Expose the highlight API for other flows / debugging / tests.
  window.WildlifeMap = {
    highlightAreas: highlightAreas,
    clearHighlight: clearHighlight,
    highlightCounty: highlightCounty,
    clearCountyHighlight: clearCountyHighlight,
    areaColor: areaColor
  };

  function setMode(mode) {
    var isAddress = (mode === 'address');
    $('#county-mode').hidden = isAddress;
    $('#address-mode').hidden = !isAddress;

    // DECONFLICTION: switching BACK to county mode rebinds the governing
    // location to the dropdown county and tears down the lingering address
    // context (resolved-location header + address result panel) so the inactive
    // mode never lingers on screen. The dropdown VALUE is preserved; we simply
    // re-assert it as the active location and re-render its coordinator line.
    if (!isAddress) {
      state.activeLocation = 'county';
      var resolved = $('#resolved-location');
      if (resolved) { resolved.style.display = 'none'; resolved.innerHTML = ''; }
      var addrResult = $('#address-result');
      if (addrResult) addrResult.style.display = 'none';
      var countySel = $('#county');
      var countyVal = countySel ? countySel.value : '';
      renderCountyBadge(countyVal);
      renderCoordLine(countyVal);
    }
  }

  // Tier 1 -> Tier 2 "widen" handoff: carry the selected county into Address
  // mode as exclude_county, switch the toggle to Address, and focus the address
  // input. The subsequent submit will request the out-of-county context list.
  function widenFromCounty() {
    var county = $('#county') ? $('#county').value : '';
    if (!county) return;
    var addrRadio = document.querySelector('input[name="mode"][value="address"]');
    if (addrRadio) {
      addrRadio.checked = true;
      addrRadio.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      setMode('address');
    }
    // Set AFTER the mode-change dispatch (the change handler clears widenCounty
    // so manual Address-mode toggles run a standalone aggregate query).
    state.widenCounty = county;
    var input = $('#animal-address');
    if (input) input.focus();
  }

  function loadCountyWin() {
    return fetch('data/county_win.json', { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) return {};
        return resp.json();
      })
      .then(function (json) {
        state.countyWin = (json && typeof json === 'object' && !Array.isArray(json)) ? json : {};
      })
      .catch(function () { state.countyWin = {}; });
  }

  // Coordinator NAMES are an area-string -> name map (NAME only, never phone).
  // Locked source-of-truth: the auto-refreshing Monday board writes
  // docs/data/coordinators.json. We PREFER that (board-sourced, fresh) and
  // FALL BACK to docs/data/win_area_coordinators.json (xlsx-derived, static)
  // only when coordinators.json is missing, unreadable, or empty.
  function fetchCoordMap(path) {
    return fetch(path, { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) return {};
        return resp.json();
      })
      .then(function (json) {
        return (json && typeof json === 'object' && !Array.isArray(json)) ? json : {};
      })
      .catch(function () { return {}; });
  }

  function loadCoordinators() {
    return fetchCoordMap('data/coordinators.json').then(function (board) {
      if (board && Object.keys(board).length) {
        state.coordinators = board;
        return;
      }
      // Board map empty/missing — fall back to the static xlsx-derived map.
      return fetchCoordMap('data/win_area_coordinators.json').then(function (xlsx) {
        state.coordinators = xlsx;
      });
    });
  }

  function loadRehabbers() {
    return fetch('data/rehabbers.json', { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) return [];
        return resp.json();
      })
      .then(function (json) { state.rehabbers = Array.isArray(json) ? json : []; })
      .catch(function () { state.rehabbers = []; });
  }

  function loadSnapshot() {
    return fetch('data/county_capacity.json', { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (json) { state.snapshot = json; })
      .catch(function () { state.loadError = true; state.snapshot = null; });
  }

  function loadConfig() {
    return fetch('data/config.json', { cache: 'no-store' })
      .then(function (resp) {
        if (resp.status === 404) { state.config = null; return null; }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text().then(function (txt) {
          try { return JSON.parse(txt); }
          catch (e) { state.configError = true; return null; }
        });
      })
      .then(function (json) { state.config = json; })
      .catch(function () {
        // Network/other error → treat as missing, use defaults silently.
        state.config = null;
      });
  }

  function init() {
    populateCounties();
    // Inject the finder-fallback footer note from the single message source so
    // the PA Game Commission phone lives in ONE place (messages.js). The markup
    // carries a static copy as a no-JS fallback; this overwrites it with the
    // identical config-built text.
    var fallbackNote = document.getElementById('finder-fallback-note');
    if (fallbackNote) {
      fallbackNote.textContent = fmt(MSG.staticUi.finderFallbackNote, { phone: PGC_PHONE });
    }
    $('#county').addEventListener('change', function (e) {
      // Selecting a county is a county-mode action: it re-asserts the dropdown
      // as the governing active location (the badge + coordinator follow).
      state.activeLocation = 'county';
      renderCardsForCounty(e.target.value);
    });
    $('#recommend-btn').addEventListener('click', onRecommendClick);

    // Approach B stale-flag wiring: the RVS toggle and the Issue (C&T) radios
    // feed BOTH result surfaces (readAnimalBaseInfo) but trigger no render. So
    // changing one after a result is shown would silently leave misleading
    // stale numbers. We do NOT auto-recompute — we flag the shown result(s) as
    // stale and require a re-click of the existing lookup/submit button.
    $$('input[name="rvs"], input[name="issue"]').forEach(function (radio) {
      radio.addEventListener('change', markResultsStale);
    });

    // Address-mode wiring (Phase G).
    $$('input[name="mode"]').forEach(function (radio) {
      radio.addEventListener('change', function (e) {
        if (e.target.checked) {
          // A manual toggle resets the Tier 2 widen scope so standalone Address
          // mode runs a plain aggregate (no exclude_county / context list).
          state.widenCounty = null;
          setMode(e.target.value);
        }
      });
    });
    var widenBtn = $('#widen-btn');
    if (widenBtn) widenBtn.addEventListener('click', widenFromCounty);
    var addrBtn = $('#address-btn');
    if (addrBtn) addrBtn.addEventListener('click', onAddressSubmit);
    setupAutocomplete();
    var addrInput = $('#animal-address');
    if (addrInput) {
      addrInput.addEventListener('keydown', function (e) {
        // Only submit on Enter when the suggestion list is NOT driving the key
        // (acOnKeydown selects a highlighted suggestion and preventDefaults).
        if (e.key === 'Enter' && !e.defaultPrevented) {
          e.preventDefault();
          onAddressSubmit();
        }
      });
    }
    var checkedMode = document.querySelector('input[name="mode"]:checked');
    setMode(checkedMode ? checkedMode.value : 'county');

    // WIN Areas map (D5.2-5.3): restore the collapse state and draw the
    // choropleth. Loaded alongside the other data; highlight wiring (Tier 1 in
    // renderCoordLine, Tier 2 in renderContextList) becomes active once paths
    // exist. Map fetch is independent so a failure here cannot block the rest.
    restoreMapPanelState();

    Promise.all([
      loadSnapshot(), loadConfig(), loadCoordinators(), loadRehabbers(), loadCountyWin(), loadMap()
    ]).then(function () {
      renderBanner();
      renderConfigError();
      renderCardsForCounty($('#county').value);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

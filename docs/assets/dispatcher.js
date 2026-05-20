/* dispatcher.js — Phase 2 UI scaffold for Wildlife In Need dispatcher.
 * Reads docs/data/county_capacity.json (snapshot from refresh_monday.py).
 * No frameworks, no build step.
 */
(function () {
  'use strict';

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
    { key: 'ct_no_rvs', label: 'C&T (no RVS)' },
    { key: 'ct_rvs',    label: 'C&T (with RVS)' },
    { key: 'courier',   label: 'Courier' }
  ];

  var DEFAULT_CONFIG = {
    marginal_threshold: 1,
    escalate_to_game_commission: {
      ct_rvs_capture_min_available: 1,
      ct_any_capture_min_available: 1,
      courier_transport_min_available: 1
    },
    county_overrides: {}
  };

  var state = {
    snapshot: null,   // parsed county_capacity.json or null
    loadError: false,
    config: null,           // parsed config.json (or null = use defaults)
    configError: false      // true when config.json was present but malformed
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

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
      banner.textContent = 'Snapshot not available — run refresh_monday.py';
      return;
    }
    banner.classList.remove('warn');
    var ts = formatTimestamp(state.snapshot.generated_at);
    banner.textContent = 'Last refreshed: ' + (ts || 'unknown');
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
    b.textContent = 'Config file is malformed; using defaults.';
    var refresh = document.getElementById('refresh-banner');
    if (refresh && refresh.parentNode) {
      refresh.parentNode.insertBefore(b, refresh.nextSibling);
    }
  }

  function renderCardsForCounty(countyName) {
    var emptyMsg = $('#empty-msg');
    var cards = $$('.cap-card');

    if (!countyName) {
      cards.forEach(function (card) {
        card.classList.add('empty');
        $('.avail', card).textContent = '—';
        $('.total', card).textContent = '—';
        $('.sub', card).textContent = '';
        var badge = $('.badge', card);
        if (badge) badge.remove();
      });
      emptyMsg.style.display = 'none';
      emptyMsg.textContent = '';
      return;
    }

    var counties = (state.snapshot && state.snapshot.counties) || {};
    var data = counties[countyName];
    var hasAny = false;
    var resolved = resolveForCounty(state.config, countyName);

    ROLES.forEach(function (role) {
      var card = document.querySelector('.cap-card[data-role="' + role.key + '"]');
      var roleData = (data && data[role.key]) || { available: 0, total: 0, marginal_volunteers: [] };
      var avail = roleData.available || 0;
      var total = roleData.total || 0;
      if (total > 0) hasAny = true;

      card.classList.remove('empty');
      $('.avail', card).textContent = String(avail);
      $('.total', card).textContent = String(total);
      $('.sub', card).textContent = '';

      var existing = $('.badge', card);
      if (existing) existing.remove();

      if (avail <= resolved.marginal_threshold && total > 0) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Marginal';
        card.appendChild(badge);
      }
    });

    if (!data || !hasAny) {
      emptyMsg.style.display = 'block';
      emptyMsg.textContent = 'No volunteers currently in ' + countyName + ' for these roles.';
    } else {
      emptyMsg.style.display = 'none';
      emptyMsg.textContent = '';
    }
  }

  var TARGET_LABELS = {
    ct_rvs:    'C&T (RVS)',
    ct_no_rvs: 'C&T (no RVS)',
    ct_any:    'C&T (any)',
    courier:   'Courier'
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function renderRecommendation(rec) {
    var actionMeta = (window.WildlifeDecision &&
                      window.WildlifeDecision.ACTIONS &&
                      window.WildlifeDecision.ACTIONS[rec.action]) || null;
    var label = actionMeta ? actionMeta.label : rec.action;
    var tone  = actionMeta ? actionMeta.tone  : 'unknown';
    var targetLabel = rec.target ? (TARGET_LABELS[rec.target] || rec.target) : 'n/a';

    var html = '';
    html += '<button type="button" class="rec-dismiss" id="rec-dismiss" aria-label="Dismiss">Dismiss</button>';
    html += '<div class="rec-action ' + tone + '">' + escapeHtml(label) + '</div>';
    html += '<div class="rec-target">Target role: <strong>' + escapeHtml(targetLabel) + '</strong></div>';

    if (rec.marginal && rec.marginal_volunteers && rec.marginal_volunteers.length) {
      html += '<div class="rec-marginal">';
      html += '<div class="rec-marginal-header">Low capacity</div>';
      html += '<ul>';
      rec.marginal_volunteers.forEach(function (v) {
        var note = v && v.availability_note ? String(v.availability_note) : '';
        if (note) {
          html += '<li><em>' + escapeHtml(note) + '</em></li>';
        } else {
          html += '<li><em>(no availability info)</em></li>';
        }
      });
      html += '</ul></div>';
    } else if (rec.marginal) {
      html += '<div class="rec-marginal"><div class="rec-marginal-header">Low capacity</div>' +
              '<p style="font-size:13px;">No marginal-volunteer roster recorded for this bucket.</p></div>';
    }

    if (rec.reasoning && rec.reasoning.length) {
      html += '<div class="rec-reasoning"><div class="rec-reasoning-header">Reasoning</div><ol>';
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

  function onRecommendClick() {
    var out = $('#rec-output');
    var county = $('#county').value;
    if (!county) {
      out.className = 'rec-output show tone-unknown';
      out.innerHTML = '<button type="button" class="rec-dismiss" id="rec-dismiss">Dismiss</button>' +
                      '<div class="rec-action unknown">Select a county first.</div>';
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
    var capacity = counties[county] || null;
    var rvsRadio = document.querySelector('input[name="rvs"]:checked');
    var issueRadio = document.querySelector('input[name="issue"]:checked');
    var animalRvs = rvsRadio ? (rvsRadio.value === 'yes') : false;
    var issue = issueRadio ? issueRadio.value : 'capture';

    var resolved = resolveForCounty(state.config, county);
    var rec = window.WildlifeDecision.recommend(capacity, animalRvs, issue, resolved);
    renderRecommendation(rec);
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
    $('#county').addEventListener('change', function (e) {
      renderCardsForCounty(e.target.value);
    });
    $('#recommend-btn').addEventListener('click', onRecommendClick);

    Promise.all([loadSnapshot(), loadConfig()]).then(function () {
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

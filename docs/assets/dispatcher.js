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
    { key: 'ct_no_rvs', label: 'C&T' },
    { key: 'ct_rvs',    label: 'RVS C&T' },
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
    configError: false,     // true when config.json was present but malformed
    coordinators: {},       // area-string -> coordinator NAME (public-safe, no phone)
    rehabbers: [],          // public rehabber dataset (may be empty)
    addressBusy: false      // guard against concurrent address lookups
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
  // PA Game Commission dispatch lines (already public on the page footer).
  var PGC_PHONE = '(833) 742-4868 or (833) 742-9453';
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
    ct_rvs:    'RVS C&T',
    ct_no_rvs: 'C&T',
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
    var html = '';
    html += '<button type="button" class="rec-dismiss" id="rec-dismiss" aria-label="Dismiss">Dismiss</button>';
    html += '<div class="rec-action ' + tone + '">' + escapeHtml(label) + '</div>';
    if (rec.target) {
      var targetLabel = TARGET_LABELS[rec.target] || rec.target;
      html += '<div class="rec-target">Target role: <strong>' + escapeHtml(targetLabel) + '</strong></div>';
    }

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
  function fetchAggregateByAddress(address, radiusMi) {
    var url = WORKER_URL +
      '?address=' + encodeURIComponent(address) +
      '&radius_mi=' + encodeURIComponent(radiusMi);
    return fetch(url, { cache: 'no-store' })
      .then(function (resp) {
        if (resp.status === 422) throw new Error('address_not_found');
        if (resp.status === 502) throw new Error('geocoder_unavailable');
        if (resp.status === 400) throw new Error('worker_400');
        if (!resp.ok) throw new Error('worker_http_' + resp.status);
        return resp.json();
      });
  }

  // Closest PUBLIC rehabber (prefers OPEN). Mirrors dispatch_core.find_closest_rehabber.
  // Returns {rehab_name, distance_mi, open_closed, website, is_closed} or null.
  function findClosestRehabber(lat, lon) {
    var list = state.rehabbers || [];
    var bestOpen = null, bestOpenD = Infinity;
    var bestAny = null, bestAnyD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (!rec || typeof rec.lat !== 'number' || typeof rec.lon !== 'number') continue;
      var d = haversineMiles(lat, lon, rec.lat, rec.lon);
      var oc = String(rec.open_closed || '');
      var isOpen = oc.trim().toLowerCase() === 'open';
      var cand = {
        rehab_name: String(rec.rehab_name || ''),
        distance_mi: d,
        open_closed: oc,
        website: String(rec.website || ''),
        is_closed: !isOpen
      };
      if (d < bestAnyD) { bestAnyD = d; bestAny = cand; }
      if (isOpen && d < bestOpenD) { bestOpenD = d; bestOpen = cand; }
    }
    return bestOpen || bestAny;
  }

  function coordinatorsForAreas(areas) {
    var names = {};
    (areas || []).forEach(function (a) {
      var name = state.coordinators[String(a)];
      if (name && String(name).trim()) names[String(name).trim()] = true;
    });
    return Object.keys(names).sort();
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

  function renderAggregate(agg, ctx) {
    var roles = (agg && agg.role_counts) || {};
    var ct = roles['C&T'] || 0;
    var rvs = roles['RVS C&T'] || 0;
    var courier = roles['COURIER'] || 0;
    var total = (typeof agg.total_in_range === 'number') ? agg.total_in_range : 0;
    var areas = (agg && Array.isArray(agg.win_areas)) ? agg.win_areas.slice() : [];

    setText('#agg-total', String(total));
    setText('#agg-ct', String(ct));
    setText('#agg-rvs', String(rvs));
    setText('#agg-courier', String(courier));

    var areasEl = $('#agg-areas');
    if (areas.length) {
      areasEl.innerHTML = areas.map(function (a) {
        return '<span class="win-chip">Area ' + escapeHtml(a) + '</span>';
      }).join('');
    } else {
      areasEl.innerHTML = '<span style="font-size:13px;color:var(--text-muted);">none</span>';
    }

    // ── Recommended actions (mirror dispatch_core.build_recommendation) ──
    var hasQualified = QUALIFYING_ROLES.some(function (r) { return (roles[r] || 0) > 0; });
    var coordinators = coordinatorsForAreas(areas);
    var actions = [];

    if (total > 0 && areas.length) {
      actions.push(actionLine('go', '→',
        'Task <strong>Connecteam</strong> volunteers in WIN area(s) ' +
        '<strong>' + areas.map(escapeHtml).join(', ') + '</strong> ' +
        '(' + total + ' in range).'));
    }

    if (coordinators.length) {
      actions.push(actionLine('go', '→',
        'Contact Area coordinator(s): <strong>' +
        coordinators.map(escapeHtml).join(', ') + '</strong>.'));
    }

    if (!hasQualified) {
      actions.push(actionLine('escalate', '!',
        'No qualified volunteers within ' + ctx.radius + ' mi — ' +
        'ask the finder to call <strong>PA Game Commission</strong>: ' +
        escapeHtml(PGC_PHONE) + '.'));
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
          ? ' (<a href="' + escapeHtml(closest.website) + '" target="_blank" rel="noopener">website</a>)'
          : '';
        var tone = closest.is_closed ? 'warn' : 'neutral';
        var closedNote = closest.is_closed
          ? ' <strong>Nearest is not marked OPEN — confirm before transport.</strong>'
          : '';
        actions.push(actionLine(tone, '⌂',
          'Transport to closest rehabber: <strong>' + escapeHtml(closest.rehab_name) +
          '</strong> (~' + dist + ' mi)' + site + '.' + closedNote));
      }
    }

    if (!actions.length) {
      actions.push(actionLine('escalate', '!',
        'No volunteers in range and no rehabber data available — ' +
        'ask the finder to call <strong>PA Game Commission</strong>: ' +
        escapeHtml(PGC_PHONE) + '.'));
    }

    $('#agg-actions').innerHTML = actions.join('');
    $('#address-result').style.display = 'block';
  }

  function onAddressSubmit() {
    if (state.addressBusy) return;
    setAddressError('');
    var addr = ($('#animal-address').value || '').trim();
    var radius = clampRadius($('#radius-mi').value);
    $('#radius-mi').value = String(radius);

    if (!addr) {
      setAddressError('Enter the animal address first.');
      return;
    }

    state.addressBusy = true;
    var btn = $('#address-btn');
    btn.disabled = true;
    $('#address-result').style.display = 'none';
    setAddressStatus('Finding volunteers within ' + radius + ' mi…');

    // Single origin: send the typed address to the Worker, which geocodes it
    // server-side (no browser CORS) and returns the PII-free aggregate.
    fetchAggregateByAddress(addr, radius)
      .then(function (agg) {
        setAddressStatus('');
        // Render in its OWN try/catch so a rendering bug (e.g. a missing DOM
        // target) surfaces a DISTINCT message instead of being swallowed by the
        // network-error catch below and shown as "could not reach the service".
        try {
          renderAggregate(agg, { radius: radius });
        } catch (renderErr) {
          if (window.console && console.error) console.error('renderAggregate failed', renderErr);
          setAddressError('Got a response but could not display it. Please report this to the site maintainer.');
        }
      })
      .catch(function (err) {
        setAddressStatus('');
        var code = err && err.message ? err.message : '';
        if (code === 'address_not_found') {
          setAddressError('No match for that address. Check spelling, or try ' +
            '"street, city, PA zip".');
        } else if (code === 'geocoder_unavailable') {
          setAddressError('Address lookup service is temporarily unavailable. Try again shortly.');
        } else if (code === 'worker_400') {
          setAddressError('Dispatcher service could not resolve that location. Try a more specific address.');
        } else {
          setAddressError('Could not reach the dispatcher service. Check your connection and try again.');
        }
      })
      .then(function () {
        state.addressBusy = false;
        btn.disabled = false;
      });
  }

  function setMode(mode) {
    var isAddress = (mode === 'address');
    $('#county-mode').hidden = isAddress;
    $('#address-mode').hidden = !isAddress;
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
    $('#county').addEventListener('change', function (e) {
      renderCardsForCounty(e.target.value);
    });
    $('#recommend-btn').addEventListener('click', onRecommendClick);

    // Address-mode wiring (Phase G).
    $$('input[name="mode"]').forEach(function (radio) {
      radio.addEventListener('change', function (e) {
        if (e.target.checked) setMode(e.target.value);
      });
    });
    var addrBtn = $('#address-btn');
    if (addrBtn) addrBtn.addEventListener('click', onAddressSubmit);
    var addrInput = $('#animal-address');
    if (addrInput) {
      addrInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); onAddressSubmit(); }
      });
    }
    var checkedMode = document.querySelector('input[name="mode"]:checked');
    setMode(checkedMode ? checkedMode.value : 'county');

    Promise.all([
      loadSnapshot(), loadConfig(), loadCoordinators(), loadRehabbers()
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

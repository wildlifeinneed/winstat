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
  // Stable per-area color map. 17 buckets (areas 1-16 + 15N/15S). High-contrast
  // qualitative palette (ColorBrewer-inspired) so adjacent WIN areas are easy to
  // tell apart at a glance. Saturated mid-tones — not pastels — with enough hue
  // separation that even neighboring polygons read as clearly distinct.
  // Keyed by area number so the color is stable across refreshes. Defined here
  // (not raw inline hex scattered through markup) so the legend, paths, and
  // any future reuse share one source of truth.
  var AREA_COLORS = {
    '1':   '#e41a1c', // red
    '2':   '#377eb8', // blue
    '3':   '#4daf4a', // green
    '4':   '#984ea3', // purple
    '5':   '#ff7f00', // orange
    '6':   '#a65628', // brown
    '7':   '#f781bf', // pink
    '8':   '#17becf', // cyan
    '9':   '#bcbd22', // olive-yellow
    '10':  '#e377c2', // magenta-pink
    '11':  '#7f7f7f', // grey
    '12':  '#1b9e77', // teal
    '13':  '#d95f02', // burnt orange
    '14':  '#7570b3', // slate-purple
    '15N': '#e6ab02', // gold
    '15S': '#66a61e', // lime-green
    '16':  '#a6761d'  // dark tan
  };
  var AREA_FALLBACK = '#cfd8dc';
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
    policy: null,           // parsed policy.json (per-county dispatch overlay) or null
    facilities: null,       // parsed facilities.json (source of truth for referral phones)
    facilityNameMap: null,  // parsed facility_name_map.json (alias -> canonical name)
    facilityPhoneIndex: null, // built lookup index { byName } for referral phone resolution
    coordinators: {},       // area-string -> coordinator NAME (public-safe, no phone)
    countyWin: {},          // county name -> WIN area (PII-free, from county_win.json)
    rehabbers: [],          // public rehabber dataset (may be empty)
    addressBusy: false,     // guard against concurrent address lookups
    widenCounty: null,      // Tier 1 county carried into Tier 2 as exclude_county
    mapBuilt: false,        // true once the SVG choropleth is drawn
    geojson: null,          // parsed pa_counties.json (cached for the Leaflet WIN-area overlay)
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
    activeLocation: 'county',
    // Tier 1 volunteer list: cache the LAST-FETCHED Worker context rows + the
    // {county, rvs, issue} render context so the two scope buttons (In-County /
    // WIN Area) can re-render WITHOUT re-fetching. The WIN-area fetch already
    // returns EVERY in-county volunteer (county ⊆ win_area, and the Worker
    // retains all win_area members regardless of distance), so the In-County
    // view is just a client-side filter (row.county === selected county) over
    // these SAME rows. `scope` tracks which button is currently OPEN (null =
    // collapsed). Reset by hideTier1Volunteers / a fresh fetch.
    t1VolRows: null,
    t1VolCtx: null,
    t1VolScope: null,
    // Tier 1 RECOMMENDATION: the In-County recommendation over the selected
    // county's capacity (with county-level policy applied). `t1RecCounty` is the
    // recommendation object, `t1RecBase` the {rvs, issue} premise, and
    // `t1RecCountyName` the selected county. Reset whenever a fresh
    // recommendation is rendered.
    t1RecCounty: null,
    t1RecBase: null,
    t1RecCountyName: null,
    // Cascade tier used for the current recommendation: 'county' (default),
    // 'area' (dispatch_warning), or 'monitor' (dispatcher_decides). Set by
    // onRecommendClick's cascade logic; read by recDispatchSummaryHtml.
    t1RecTier: 'county'
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
  // Mirrors Python is_available() deny-list: any of these substrings in
  // availability_note means the volunteer is currently unavailable.
  var DENY_WORDS = ['unavail', 'vacation', 'out', 'inactive', 'leave', 'away', 'on hold', 'extended', 'hiatus'];

  // Token used to ignore stale/out-of-order live DMA-check responses: each new
  // Tier-2 lookup (or result reset) bumps it so a slow earlier fetch can't
  // overwrite a newer result. Declared up here so clearResolvedLocation() can
  // bump it before checkDmaForLocation() is defined further below.
  var dmaCheckToken = 0;

  // Token used to ignore stale/out-of-order Tier-1 volunteer-list responses:
  // each new By-County recommendation (or county reset) bumps it so a slow
  // earlier county's fetch can't overwrite a newer county's rendered list.
  var t1VolToken = 0;

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
      // Drop any Tier 1 volunteer list (and ignore in-flight fetches) so stale
      // rows from a previously selected county never linger after deselect.
      t1VolToken += 1;
      hideTier1Volunteers();
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

  // Format a digit string as a US phone (833-742-9453) for display; non-10-digit
  // values fall back to the raw input. Mirrors the refer_out phone formatting.
  function formatPhoneDisplay(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var digits = s.replace(/[^0-9]/g, '');
    if (digits.length === 10) {
      return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
    }
    return s;
  }

  // ─── Rehabber animal-type matching ───────────────────────────────────────
  // rehabbers.json stores the animal types each facility accepts INSIDE its free
  // -text `availability` field, as the rehab-network's species shorthand
  // appended after the facility name, e.g.
  //   "Humane Animal Rescue Wildlife Center\nM,P,R, RA RVS, END".
  // The codes (authoritative legend: docs/USER_MANUAL.md "Animal codes"):
  //   M   = Mammals (non-bat)
  //   P   = Passerines (songbirds, waterfowl & woodpeckers) — the "Bird" AND
  //         "Waterfowl" dropdown categories both map here
  //   R   = Raptors (hawks, owls, falcons, eagles & vultures)
  //   RVS = Rabies-Vector Species (raccoons, skunks, BATS, groundhogs, coyotes
  //         & foxes) — a real animal-type signal, NOT just a capability
  //   END = Endangered / Threatened (a STATUS, not an animal-type category)
  //   RA  = Native Reptiles & Amphibians
  //
  // REHAB_SPECIES_CODES maps each Animal Type dropdown category to the set of
  // codes that mean "accepts this animal" (ANY one present -> accepts).
  // 'other'/unknown is intentionally absent -> PASS-THROUGH (we never filter
  // when the species is unknown).
  //   • Bat    -> RVS  (bats are rabies-vector species)
  //   • Mammal -> M OR RVS  (M = non-bat mammals; RVS covers raccoons/skunks/
  //                          groundhogs/coyotes/foxes, which a mammal caller wants)
  var REHAB_SPECIES_CODES = {
    bird: ['P'],
    waterfowl: ['P'],             // Passerines covers waterfowl
    raptor: ['R'],                // R = Raptors
    bat: ['RVS'],                 // bats are Rabies-Vector Species
    mammal: ['M', 'RVS'],         // non-bat mammals (M) + RVS mammals
    reptile_amphibian: ['RA']     // RA = Reptiles & Amphibians
  };

  // Does a rehabber's `availability` text indicate it accepts `animalType`
  // (a dropdown category)? 'other'/empty/unknown -> true (never restrict).
  // Tokenizes the availability on non-letter boundaries so a CODE like "RA" or
  // "RVS" matches as a whole token and is never confused with letters inside the
  // facility name (e.g. "AARK"). Bats additionally match the free-text word
  // "bat" so a "Bats only" facility still accepts the Bat category.
  function rehabberAcceptsAnimal(availability, animalType) {
    var cat = String(animalType == null ? '' : animalType).toLowerCase().trim();
    if (!cat || cat === 'other' || cat === 'unknown') return true;
    var codes = REHAB_SPECIES_CODES[cat];
    if (!codes) return true;            // unknown category -> don't restrict
    var text = String(availability == null ? '' : availability);
    // Bat specialists are flagged in free text ("Bats only").
    if (cat === 'bat' && /\bbats?\b/i.test(text)) return true;
    if (codes.length === 0) return false; // category with no code in the data
    var tokens = text.toUpperCase().split(/[^A-Z]+/);
    var present = {};
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i]) present[tokens[i]] = true;
    }
    for (var j = 0; j < codes.length; j++) {
      if (present[codes[j]]) return true;
    }
    return false;
  }

  // ─── Nearby rehabbers (shared) ───────────────────────────────────────────
  // Return the rehabbers in the selected county or its WIN area that ACCEPT the
  // selected `animalType` (see rehabberAcceptsAnimal), ordered with selected
  // -county rows FIRST then sibling-area rows (stable within each group). Used
  // by BOTH the dispatch summary AND the actionable transport-PGC block so the
  // two never disagree on who is "nearby" or which animals they take.
  function nearbyRehabbers(county, animalType) {
    if (!county) return [];
    var areaCounties = {};
    getWinAreaCounties(county).forEach(function (c) {
      if (c) areaCounties[String(c).trim().toLowerCase()] = true;
    });
    var rehabbers = Array.isArray(state.rehabbers) ? state.rehabbers : [];
    var nearby = rehabbers.filter(function (r) {
      var rc = (r && r.county) ? String(r.county).trim().toLowerCase() : '';
      if (!rc || !areaCounties[rc]) return false;
      return rehabberAcceptsAnimal(r.availability, animalType);
    });
    var inCty = [];
    var siblings = [];
    var selKey = String(county).trim().toLowerCase();
    nearby.forEach(function (r) {
      if (String(r.county).trim().toLowerCase() === selKey) inCty.push(r);
      else siblings.push(r);
    });
    return inCty.concat(siblings);
  }

  // ─── County adjacency (derived from the county GeoJSON) ──────────────────
  // Two counties are NEIGHBORS when their polygons share at least one boundary
  // vertex. Computed lazily from state.geojson (the SAME source the WIN-area map
  // uses) and cached in _countyAdjacency so the build runs at most once. Returns
  // {} when the GeoJSON has not loaded yet (callers degrade gracefully). Coords
  // are rounded to 3 decimals (~110 m) so shared borders match despite tiny
  // floating-point differences between adjacent polygon rings.
  var _countyAdjacency = null;
  function buildCountyAdjacency() {
    if (_countyAdjacency) return _countyAdjacency;
    var geo = state.geojson;
    var features = (geo && Array.isArray(geo.features)) ? geo.features : null;
    if (!features || !features.length) return {};
    // 1) Per-county set of rounded boundary vertices.
    var vsets = {};
    function collect(coords, set) {
      if (!coords) return;
      if (typeof coords[0] === 'number') {
        set[coords[0].toFixed(3) + ',' + coords[1].toFixed(3)] = true;
        return;
      }
      for (var i = 0; i < coords.length; i++) collect(coords[i], set);
    }
    features.forEach(function (f) {
      var props = (f && f.properties) || {};
      var county = String(props.county || '').trim();
      if (!county) return;
      var set = vsets[county] || (vsets[county] = {});
      if (f.geometry) collect(f.geometry.coordinates, set);
    });
    // 2) Invert the vertex sets into a vertex -> [counties] index, then mark
    //    every pair sharing a vertex as adjacent. This is O(total vertices)
    //    rather than O(counties^2 * vertices).
    var vertexOwners = {};
    Object.keys(vsets).forEach(function (county) {
      Object.keys(vsets[county]).forEach(function (v) {
        (vertexOwners[v] || (vertexOwners[v] = [])).push(county);
      });
    });
    var adj = {};
    Object.keys(vertexOwners).forEach(function (v) {
      var owners = vertexOwners[v];
      if (owners.length < 2) return;
      for (var i = 0; i < owners.length; i++) {
        for (var j = i + 1; j < owners.length; j++) {
          var a = owners[i], b = owners[j];
          if (a === b) continue;
          (adj[a] || (adj[a] = {}))[b] = true;
          (adj[b] || (adj[b] = {}))[a] = true;
        }
      }
    });
    _countyAdjacency = adj;
    return adj;
  }

  // Return the WIN areas that NEIGHBOR the selected county's area, in order of
  // likelihood (most adjacency contacts first, then numerically). An area is a
  // neighbor when ANY of its counties borders ANY county in the selected
  // county's own area. The selected county's own area is excluded. Each entry is
  // { area, counties } where `counties` are that neighboring area's counties
  // that actually touch the home area (the closest crossing points). Falls back
  // to [] when adjacency/area data is unavailable (caller degrades gracefully).
  function neighboringAreas(county) {
    if (!county || !state.countyWin) return [];
    var homeArea = state.countyWin[county];
    if (homeArea === undefined || homeArea === null) return [];
    var homeNorm = String(homeArea).trim().toLowerCase();
    var adj = buildCountyAdjacency();
    if (!adj || !Object.keys(adj).length) return [];
    // Counties in the selected county's own WIN area.
    var homeCounties = getWinAreaCounties(county);
    var cw = state.countyWin;
    // For each neighboring AREA, collect the bordering counties + a contact
    // count (how many home-area borders it touches) used to rank likelihood.
    var byArea = {};
    homeCounties.forEach(function (hc) {
      var neighbors = adj[hc];
      if (!neighbors) return;
      Object.keys(neighbors).forEach(function (nc) {
        var ncArea = cw[nc];
        if (ncArea === undefined || ncArea === null) return;
        var ncNorm = String(ncArea).trim().toLowerCase();
        if (ncNorm === homeNorm) return; // same area -> not a NEIGHBOR
        var areaKey = String(ncArea).trim();
        var bucket = byArea[areaKey] || (byArea[areaKey] = { area: areaKey, counties: {}, contacts: 0 });
        bucket.counties[nc] = true;
        bucket.contacts += 1;
      });
    });
    var areas = Object.keys(byArea).map(function (k) {
      var b = byArea[k];
      return { area: b.area, counties: Object.keys(b.counties).sort(), contacts: b.contacts };
    });
    // Rank: most border contacts first (likeliest direction), then numeric area.
    areas.sort(function (a, b) {
      if (b.contacts !== a.contacts) return b.contacts - a.contacts;
      var na = parseInt(a.area, 10), nb = parseInt(b.area, 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return String(a.area).localeCompare(String(b.area));
    });
    return areas;
  }

  // Rehabbers located in ANY county of the given WIN `area` that ACCEPT the
  // selected `animalType`. Used by the options panel to show, per neighboring
  // area, who can take the animal in that direction. Returns [] when the area
  // has no county map or no matching rehabber.
  function rehabbersInArea(area, animalType) {
    if (area === undefined || area === null || !state.countyWin) return [];
    var norm = String(area).trim().toLowerCase();
    var cw = state.countyWin;
    var areaCounties = {};
    Object.keys(cw).forEach(function (c) {
      if (String(cw[c]).trim().toLowerCase() === norm) {
        areaCounties[String(c).trim().toLowerCase()] = true;
      }
    });
    var rehabbers = Array.isArray(state.rehabbers) ? state.rehabbers : [];
    return rehabbers.filter(function (r) {
      var rc = (r && r.county) ? String(r.county).trim().toLowerCase() : '';
      if (!rc || !areaCounties[rc]) return false;
      return rehabberAcceptsAnimal(r.availability, animalType);
    });
  }

  // ─── Rehabber accepted-animal CODES (display) ────────────────────────────
  // Extract the standard species abbreviations a rehabber accepts from its free
  // -text `availability` field so the dispatch summary can SHOW them after the
  // name/phone (e.g. "… — M, P, R, RA, RVS"). Tokenizes on non-letter
  // boundaries (so "RA"/"RVS" match as whole tokens and letters inside the
  // facility name — e.g. "AARK" — are never mistaken for codes), keeps only the
  // recognized codes, de-dupes, and returns them in the canonical legend order.
  var REHAB_CODE_ORDER = ['M', 'P', 'R', 'RA', 'RVS', 'END'];
  function rehabberCodes(availability) {
    var text = String(availability == null ? '' : availability).toUpperCase();
    var tokens = text.split(/[^A-Z]+/);
    var present = {};
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i]) present[tokens[i]] = true;
    }
    var out = [];
    for (var j = 0; j < REHAB_CODE_ORDER.length; j++) {
      if (present[REHAB_CODE_ORDER[j]]) out.push(REHAB_CODE_ORDER[j]);
    }
    return out;
  }

  // Render one rehabber list <li> (name + formatted tel-linked phone + county),
  // reused by the summary and the transport-PGC block so the markup is identical.
  function rehabberRowHtml(r, liClass) {
    var REC = MSG.recommendation;
    var name = String(r.rehab_name || '').trim() || String(r.county || '');
    var rawPhone = String(r.phone || '').trim();
    var phoneTxt;
    if (rawPhone) {
      var shown = formatPhoneDisplay(rawPhone);
      var telHref = rawPhone.replace(/[^0-9+]/g, '');
      phoneTxt = '<a href="tel:' + escapeHtml(telHref) + '">' + escapeHtml(shown) + '</a>';
    } else {
      phoneTxt = escapeHtml(REC.summaryRehabNoPhone);
    }
    // Accepted-animal codes (M, P, R, RA, RVS, END) extracted from the
    // `availability` field. When the rehabber lists at least one recognized
    // code, append them after the county so the dispatcher sees what each
    // facility accepts at a glance; otherwise fall back to the bare row.
    var codes = rehabberCodes(r.availability);
    var rowTpl = codes.length ? REC.summaryRehabRowCodes : REC.summaryRehabRow;
    var fields = {
      name: escapeHtml(name),
      phone: phoneTxt,
      county: escapeHtml(String(r.county || ''))
    };
    if (codes.length) fields.codes = escapeHtml(codes.join(', '));
    return '<li class="' + liClass + '">' +
      fmt(rowTpl, fields) + '</li>';
  }

  // ─── Dispatch summary block (Tier-2-depth detail for Tier 1) ──────────────
  // Build scannable summary lines shown UNDER the action/target in the In-County
  // recommendation:
  //   1) Qualified-volunteer COUNTS (in-county + in-area), reusing the SAME
  //      qualified rows the In-County / WIN Area list buttons render
  //      (state.t1VolRows + state.t1VolCtx) so the numbers never disagree with
  //      the lists. The qualified filter is the SHARED decision.js predicate
  //      (qualifiesForAnimal) and the in-county narrowing is the SAME
  //      row.county === county filter renderT1VolList applies.
  //   2) Nearby REHABBERS in the selected county or its WIN area (from
  //      state.rehabbers) that ACCEPT the selected animal type, each as
  //      "Name (phone) — County". rehabbers.json encodes accepted animals in the
  //      `availability` field (species codes), so the list IS filtered by the
  //      selected Animal Type dropdown category (see rehabberAcceptsAnimal).
  // Returns an HTML string (possibly empty if there is nothing to show).
  function recDispatchSummaryHtml(county, animalType) {
    if (!county) return '';
    var REC = MSG.recommendation;
    var html = '';
    html += '<div class="rec-summary">';
    html += '<div class="rec-summary-header">' + escapeHtml(REC.summaryHeader) + '</div>';

    // 1) Qualified-volunteer counts from the cached Tier 1 rows. These are the
    //    SAME rows + ctx the In-County / WIN Area list buttons consume, loaded
    //    automatically on county selection.
    var rows = Array.isArray(state.t1VolRows) ? state.t1VolRows : null;
    var ctx = state.t1VolCtx || null;
    html += '<ul class="rec-summary-list">';
    if (rows && ctx) {
      var qualifyFn = (window.WildlifeDecision &&
                       typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
        ? window.WildlifeDecision.qualifiesForAnimal : null;
      var hasBase = typeof ctx.issue === 'string' && ctx.issue !== '';
      var areaList = rows;
      if (qualifyFn && hasBase) {
        areaList = rows.filter(function (row) {
          var roleList = Array.isArray(row.roles) ? row.roles : [];
          return qualifyFn(roleList, !!ctx.rvs, ctx.issue);
        });
      }
      var countyList = areaList.filter(function (row) {
        return row.county && String(row.county) === county;
      });
      html += '<li class="rec-summary-vol">' +
        fmt(REC.summaryVolCounty, { count: countyList.length, county: escapeHtml(county) }) + '</li>';
      var winArea = (state.countyWin && state.countyWin[county] !== undefined &&
                     state.countyWin[county] !== null)
        ? String(state.countyWin[county]).trim() : '';
      var areaLine = winArea
        ? fmt(REC.summaryVolArea, { count: areaList.length, area: escapeHtml(winArea) })
        : fmt(REC.summaryVolAreaUnknown, { count: areaList.length });
      html += '<li class="rec-summary-vol">' + areaLine + '</li>';
      // Cross-area monitoring volunteers count (already loaded from Tier 1 vol fetch).
      try {
        var monResult = volsMonitoringArea(winArea || '', ctx || {});
        if (monResult && REC.summaryVolMonitoring) {
          html += '<li class="rec-summary-vol">' +
            fmt(REC.summaryVolMonitoring, { count: monResult.count }) + '</li>';
        }
      } catch (_monErr) { /* monitoring count is supplementary — never break the summary */ }
      // Cascade tier indicator: when the recommendation used a non-county tier,
      // add a line so the dispatcher knows the dispatch scope.
      if (state.t1RecTier === 'area') {
        html += '<li class="rec-summary-vol rec-summary-tier">' +
          'Area dispatch \u2014 no in-county volunteers available</li>';
      } else if (state.t1RecTier === 'monitor') {
        html += '<li class="rec-summary-vol rec-summary-tier">' +
          'Dispatcher choice \u2014 monitoring tier (no in-county or in-area volunteers)</li>';
      }
    } else {
      // The list has not loaded yet (e.g. Worker slow/unavailable). Show a
      // transient pending line rather than a misleading "0".
      html += '<li class="rec-summary-vol rec-summary-pending">' +
        escapeHtml(REC.summaryVolPending) + '</li>';
    }
    html += '</ul>';

    // 2) Nearby rehabbers in the county or its WIN area that ACCEPT the selected
    //    animal type. rehabbers.json encodes accepted animals in `availability`
    //    (species codes), so nearbyRehabbers() filters by animalType. Uses the
    //    SHARED nearbyRehabbers() helper so the transport-PGC block lists the
    //    exact same facilities.
    var rehabWinArea = (state.countyWin && state.countyWin[county] !== undefined &&
                        state.countyWin[county] !== null)
      ? String(state.countyWin[county]).trim() : '';
    var rehabHeaderLabel = rehabWinArea
      ? fmt(REC.summaryRehabHeader, { area: escapeHtml(rehabWinArea) })
      : escapeHtml(REC.summaryRehabHeaderFallback || REC.summaryRehabHeader);
    html += '<div class="rec-summary-rehab-header">' + rehabHeaderLabel + '</div>';
    var ordered = nearbyRehabbers(county, animalType);
    if (ordered.length) {
      html += '<ul class="rec-summary-list rec-summary-rehab-list">';
      ordered.forEach(function (r) {
        html += rehabberRowHtml(r, 'rec-summary-rehab');
      });
      html += '</ul>';
    } else {
      html += '<p class="rec-summary-rehab-empty">' + escapeHtml(REC.summaryRehabEmpty) + '</p>';
    }

    html += '</div>';
    return html;
  }

  // Qualified-volunteer count for the selected county's WIN area, computed from
  // the SAME cached Tier 1 rows + qualify predicate the dispatch summary and the
  // In-County / WIN Area list buttons use, so the options panel never disagrees
  // with them. Returns null when the rows have not loaded yet (caller shows a
  // transient "loading" line instead of a misleading 0).
  function qualifiedWinAreaCount(ctx) {
    var rows = Array.isArray(state.t1VolRows) ? state.t1VolRows : null;
    if (!rows || !ctx) return null;
    var qualifyFn = (window.WildlifeDecision &&
                     typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
      ? window.WildlifeDecision.qualifiesForAnimal : null;
    var hasBase = typeof ctx.issue === 'string' && ctx.issue !== '';
    if (qualifyFn && hasBase) {
      return rows.filter(function (row) {
        var roleList = Array.isArray(row.roles) ? row.roles : [];
        return qualifyFn(roleList, !!ctx.rvs, ctx.issue);
      }).length;
    }
    return rows.length;
  }

  // Decide whether the OPTIONS panel should be shown for this recommendation.
  // TRIGGER: the recommendation would otherwise dead-end on "Call PGC":
  //   • call_pa_game_comm  -> ALWAYS (the classic no-volunteer escalation).
  //   • refer_out          -> only with THIN coverage, i.e. zero qualified
  //                           WIN-area volunteers. A refer_out backed by real
  //                           local volunteers is a deliberate policy routing,
  //                           not a coverage gap, so it keeps the basic card.
  // When the volunteer count has not loaded yet (null) we treat refer_out as
  // NOT-thin (no panel) to avoid flashing options for a county that may in fact
  // have coverage; call_pa_game_comm still always shows the panel.
  function shouldShowOptionsPanel(rec, ctx) {
    if (!rec) return false;
    if (rec.action === 'call_pa_game_comm') return true;
    // Cascade tier 3/4: area or monitoring dispatch — show the options panel
    // so the dispatcher can see who/where the volunteers are.
    if (rec.action === 'dispatch_warning' || rec.action === 'dispatcher_decides') return true;
    if (rec.action === 'refer_out') {
      var count = qualifiedWinAreaCount(ctx);
      return count === 0;
    }
    return false;
  }

  // ─── OPTIONS panel (thin/no local coverage — guide, don't dead-end) ───────
  // Hide the Advanced Search section (called on dismiss and county change).
  function hideAdvancedSearch() {
    var s = document.getElementById('advanced-search-section');
    if (s) s.style.display = 'none';
    var b = document.getElementById('advanced-search-body');
    if (b) { b.style.display = 'none'; b.innerHTML = ''; }
    var btn = document.getElementById('advanced-search-btn');
    if (btn) btn.classList.remove('open');
  }

  // Count qualified volunteers whose monitored_areas includes a given area
  // but whose HOME area is DIFFERENT. Vols living in the area already show up
  // in the normal qualified count — this only surfaces cross-area monitors.
  // Returns { count, homeAreas } where homeAreas lists the matching vols'
  // home WIN areas so the dispatcher knows where they're based.
  function volsMonitoringArea(areaNum, ctx) {
    // Use the Worker-computed cross-area monitors (monitoring_area_vols) which
    // scans the FULL KV dataset — not state.t1VolRows which only contains vols
    // from the current WIN area and would miss cross-area monitors entirely.
    var rows = Array.isArray(state.t1MonitoringVols) ? state.t1MonitoringVols : [];
    var norm = String(areaNum).trim();
    if (!norm) return { count: 0, homeAreas: [] };
    var qualifyFn = (window.WildlifeDecision &&
                     typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
      ? window.WildlifeDecision.qualifiesForAnimal : null;
    var hasBase = ctx && typeof ctx.issue === 'string' && ctx.issue !== '';
    var count = 0;
    var areaSet = {};
    for (var i = 0; i < rows.length; i++) {
      var roleList = Array.isArray(rows[i].roles) ? rows[i].roles : [];
      if (qualifyFn && hasBase && !qualifyFn(roleList, !!ctx.rvs, ctx.issue)) continue;
      count++;
      var homeArea = rows[i].win_area ? String(rows[i].win_area) : '';
      if (homeArea) areaSet[homeArea] = true;
    }
    var homeAreas = Object.keys(areaSet).sort(function (a, b) {
      return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
    });
    return { count: count, homeAreas: homeAreas };
  }

  // Populate the Monitoring Volunteers section after the async Tier 1 vol
  // fetch delivers monitoring_area_vols. Shows each qualified cross-area
  // monitor with their home area and roles.
  function updateMonitoringCount() {
    var section = document.getElementById('rec-monitor-section');
    var body = document.getElementById('rec-monitor-body');
    if (!section || !body) return;
    var county = state.t1RecCountyName || '';
    var area = (state.countyWin && state.countyWin[county] !== undefined &&
                state.countyWin[county] !== null)
      ? String(state.countyWin[county]).trim() : '';
    if (!area) { section.style.display = 'none'; return; }
    var ctx = state.t1VolCtx || null;
    var monResult = volsMonitoringArea(area, ctx);
    if (monResult.count === 0) { section.style.display = 'none'; return; }

    // Build the list: group by home area, show counties.
    var rows = Array.isArray(state.t1MonitoringVols) ? state.t1MonitoringVols : [];
    var qualifyFn = (window.WildlifeDecision &&
                     typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
      ? window.WildlifeDecision.qualifiesForAnimal : null;
    var hasBase = ctx && typeof ctx.issue === 'string' && ctx.issue !== '';
    var byArea = {};  // { areaNum: [county1, county2, ...] }
    for (var i = 0; i < rows.length; i++) {
      var roleList = Array.isArray(rows[i].roles) ? rows[i].roles : [];
      if (qualifyFn && hasBase && !qualifyFn(roleList, !!ctx.rvs, ctx.issue)) continue;
      var ha = rows[i].win_area ? String(rows[i].win_area) : '?';
      if (!byArea[ha]) byArea[ha] = [];
      var county = rows[i].home_county || '';
      byArea[ha].push(county);
    }

    var html = '<p class="rec-options-line">' +
      monResult.count + ' Monitoring volunteers ' + '</p>';
    var sortedAreas = Object.keys(byArea).sort(function (a, b) {
      return (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0);
    });
    for (var j = 0; j < sortedAreas.length; j++) {
      var aKey = sortedAreas[j];
      var counties = byArea[aKey];
      var count = counties.length;
      // Deduplicate and sort county names for display
      var seen = {};
      var uniqueCounties = [];
      for (var k = 0; k < counties.length; k++) {
        var c = counties[k];
        if (c && !seen[c]) { seen[c] = true; uniqueCounties.push(c); }
      }
      uniqueCounties.sort();
      var countyLabel = uniqueCounties.length
        ? ' (' + uniqueCounties.join(', ') + ')'
        : '';
      html += '<p class="rec-options-monitor-area">Area ' + escapeHtml(aKey) +
        ' \u2013 ' + count + ' volunteer' + (count !== 1 ? 's' : '') +
        escapeHtml(countyLabel) + '</p>';
    }
    body.innerHTML = html;
    section.style.display = '';
  }

  // Built UNDER a call_pa_game_comm (or thin refer_out) recommendation. Per the
  // design principle "don't close doors", it lays out EVERY option in order of
  // likelihood so the dispatcher + finder decide what's feasible:
  //   1) WIN-area volunteers (count + a button that opens the existing WIN Area
  //      volunteer list).
  //   2) Neighboring-area rehabbers — rehabbers in BORDERING WIN areas (all
  //      directions, never pre-filtered to one) that accept the selected animal
  //      type. An area with no matching rehabber is STILL listed (the dispatcher
  //      should know the direction exists), just flagged empty.
  //   3) Address search (Tier 2) for nearest-by-driving-distance; if transport,
  //      a "meet partway" hint.
  //   4) PGC fallback — the dispatch line, only if nothing else pans out.
  // `county` is the selected county; `animalType` the dropdown category; `ctx`
  // the cached {county, rvs, issue} render context for the volunteer count.
  function recOptionsPanelHtml(county, animalType, ctx) {
    if (!county) return '';
    var OPT = (MSG.recommendation && MSG.recommendation.options) || null;
    if (!OPT) return '';
    var pgc = MSG.pgcPhone || '';
    var animalLabels = (MSG.recommendation && MSG.recommendation.animalTypeLabels) || {};
    var animalKey = animalType ? String(animalType).toLowerCase().trim() : '';
    var animalLabel = animalLabels[animalKey] || OPT.neighborAnimalFallback;

    var html = '<div class="rec-options">';
    html += '<div class="rec-options-header">' + escapeHtml(OPT.header) + '</div>';
    html += '<p class="rec-options-intro">' + escapeHtml(OPT.intro) + '</p>';

    // 1) WIN-AREA VOLUNTEERS — count + a button that opens the existing WIN Area
    //    volunteer list (the same #t1-vol-toggle-area control).
    var area = (state.countyWin && state.countyWin[county] !== undefined &&
                state.countyWin[county] !== null)
      ? String(state.countyWin[county]).trim() : '';
    html += '<div class="rec-options-sec">';
    html += '<div class="rec-options-sec-header">' + escapeHtml(OPT.winVolHeader) + '</div>';
    var count = qualifiedWinAreaCount(ctx);
    if (count === null) {
      html += '<p class="rec-options-pending">' + escapeHtml(OPT.winVolPending) + '</p>';
    } else {
      var countLine = area
        ? fmt(OPT.winVolCount, { count: count, area: escapeHtml(area) })
        : fmt(OPT.winVolCountUnknown, { count: count });
      html += '<p class="rec-options-line">' + countLine + '</p>';
    }
    html += '<button type="button" class="rec-options-winvol-btn link-btn" id="rec-options-winvol">' +
      escapeHtml(OPT.winVolButton) + '</button>';
    html += '</div>';

    // 2) MONITORING VOLUNTEERS — vols from OTHER areas who opted in to monitor
    //    the target WIN area. Populated asynchronously after the Tier 1 vol
    //    fetch delivers monitoring_area_vols from the Worker.
    html += '<div class="rec-options-sec" id="rec-monitor-section" style="display:none">';
    html += '<div class="rec-options-sec-header">Monitoring Volunteers</div>';
    html += '<div id="rec-monitor-body"></div>';
    html += '</div>';

    // 3) NEIGHBORING-AREA REHABBERS — every bordering WIN area (all directions),
    //    each filtered to rehabbers that accept the selected animal type, but the
    //    area itself is never hidden (the dispatcher should know it's a direction).
    //    Also shows how many volunteers actively MONITOR each neighboring area
    //    (from the Monday.com WIN Area column) — even if those vols live elsewhere.
    html += '<div class="rec-options-sec">';
    html += '<div class="rec-options-sec-header">' + escapeHtml(OPT.neighborHeader) + '</div>';
    html += '<p class="rec-options-line">' + escapeHtml(OPT.neighborIntro) + '</p>';
    var areas = neighboringAreas(county);
    if (!areas.length) {
      html += '<p class="rec-options-pending">' + escapeHtml(OPT.neighborUnavailable) + '</p>';
    } else {
      html += '<ul class="rec-options-areas">';
      areas.forEach(function (a) {
        var counties = Array.isArray(a.counties) ? a.counties : [];
        var areaLabel = counties.length
          ? fmt(OPT.neighborAreaLabel, { area: escapeHtml(a.area), counties: escapeHtml(counties.join(', ')) })
          : fmt(OPT.neighborAreaLabelNoCounties, { area: escapeHtml(a.area) });
        html += '<li class="rec-options-area">';
        html += '<div class="rec-options-area-label">' + areaLabel + '</div>';
        var list = rehabbersInArea(a.area, animalType);
        if (list.length) {
          html += '<ul class="rec-summary-list rec-options-rehab-list">';
          list.forEach(function (r) {
            html += rehabberRowHtml(r, 'rec-options-rehab');
          });
          html += '</ul>';
        } else {
          html += '<p class="rec-options-area-empty">' +
            escapeHtml(fmt(OPT.neighborAreaEmpty, { animal: animalLabel })) + '</p>';
        }
        html += '</li>';
      });
      html += '</ul>';
    }
    html += '</div>';

    // 4) ADDRESS SEARCH — nearest-by-driving-distance (Tier 2); transport hint.
    html += '<div class="rec-options-sec">';
    html += '<div class="rec-options-sec-header">' + escapeHtml(OPT.addressHeader) + '</div>';
    html += '<p class="rec-options-line">' + escapeHtml(OPT.addressTip) + '</p>';
    if (ctx && ctx.issue === 'transport') {
      html += '<p class="rec-options-line">' + escapeHtml(OPT.addressTransportTip) + '</p>';
    }
    html += '<button type="button" class="rec-options-winvol-btn link-btn" id="rec-options-address">' +
      escapeHtml(OPT.addressButton) + '</button>';
    html += '</div>';

    // 5) PGC FALLBACK — only if nothing else pans out.
    html += '<div class="rec-options-sec rec-options-pgc">';
    html += '<div class="rec-options-sec-header">' + escapeHtml(OPT.pgcHeader) + '</div>';
    html += '<p class="rec-options-line">' + fmt(OPT.pgcFallback, { phone: escapeHtml(pgc) }) + '</p>';
    html += '</div>';

    html += '</div>';
    return html;
  }

  // Wire the "Show WIN Area Volunteers" button inside a freshly rendered options
  // panel to the EXISTING WIN Area volunteer list control (#t1-vol-toggle-area)
  // so the dispatcher does not have to hunt for it. Best-effort: a missing
  // button or target is a no-op. Called by renderRecommendation after the panel
  // markup lands in #rec-output.
  function wireOptionsPanel() {
    var btn = document.getElementById('rec-options-winvol');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var areaBtn = document.getElementById('t1-vol-toggle-area');
      if (!areaBtn) return;
      var blockEl = document.getElementById('t1-vol-block');
      // Only CLICK when the WIN Area scope is not already open, so this button
      // never accidentally COLLAPSES an already-open list (the toggle flips).
      var alreadyOpen = blockEl && blockEl.style.display !== 'none' &&
                        state.t1VolScope === 'area';
      if (!alreadyOpen) areaBtn.click();
      // Bring the now-visible list into view.
      var section = document.getElementById('t1-vol-section');
      if (section && typeof section.scrollIntoView === 'function') {
        try { section.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { section.scrollIntoView(); }
      }
    });

    // Wire the address-search link button to switch to Tier 2 address mode.
    var addrBtn = document.getElementById('rec-options-address');
    if (addrBtn) {
      addrBtn.addEventListener('click', function () {
        widenFromCounty();
      });
    }
  }

  // ─── Actionable PGC guidance (issue-aware "no volunteer available") ───────
  // Build the guidance block shown under a call_pa_game_comm headline. It tells
  // the dispatcher exactly what to TELL the finder:
  //   • transport -> the animal is contained, so list the nearest rehabbers
  //     (with tel-linked phones) for the finder to drive to. If NO in-scope
  //     rehabber is on file, fall back to the PGC dispatch line.
  //   • capture / rvs -> the animal is not contained, so PGC handles the
  //     capture; show the "ask the finder to call PGC" line + the PGC number.
  // `issue` is the normalized issue ('transport'/'capture'); `rehabbers` is the
  // already-ordered nearby-rehabber list (only used on the transport path).
  function recPgcGuidanceHtml(issue, rehabbers) {
    var REC = MSG.recommendation;
    var pgc = MSG.pgcPhone || '';
    var html = '<div class="rec-pgc">';
    if (issue === 'transport') {
      var list = Array.isArray(rehabbers) ? rehabbers : [];
      if (list.length) {
        html += '<p class="rec-pgc-tell">' + escapeHtml(REC.pgcTransportTell) + '</p>';
        html += '<ul class="rec-summary-list rec-pgc-rehab-list">';
        list.forEach(function (r) {
          html += rehabberRowHtml(r, 'rec-pgc-rehab');
        });
        html += '</ul>';
      } else {
        // No nearby rehabber on file -> PGC is the fallback for transport too.
        html += '<p class="rec-pgc-tell">' +
          escapeHtml(fmt(REC.pgcTransportNoRehab, { phone: pgc })) + '</p>';
      }
    } else {
      // capture / rvs (and any non-transport): PGC handles the capture.
      // The PGC phone is already in the explanatory "tell" line, so we do NOT
      // render a separate standalone phone line here (avoids duplication).
      html += '<p class="rec-pgc-tell">' +
        escapeHtml(fmt(REC.pgcCaptureTell, { phone: pgc })) + '</p>';
    }
    html += '</div>';
    return html;
  }

  // Build the action/target/low-capacity/reasoning body for a SINGLE
  // recommendation object. Extracted from the former renderRecommendation body
  // so both scopes (In-County / WIN Area) reuse the IDENTICAL markup; only the
  // rec that feeds it differs. Returns { html, tone } (the panel needs the tone
  // to set the #rec-output color class for the shown scope). `county` is the
  // selected county name, used only to list nearby rehabbers for the actionable
  // transport "no volunteer" path.
  function recBodyHtml(rec, showPolicyReferral, county, animalType) {
    var actionMeta = (window.WildlifeDecision &&
                      window.WildlifeDecision.ACTIONS &&
                      window.WildlifeDecision.ACTIONS[rec.action]) || null;
    var label = actionMeta ? actionMeta.label : rec.action;
    var tone  = actionMeta ? actionMeta.tone  : 'unknown';
    var REC = MSG.recommendation;

    // call_pa_game_comm is ISSUE-AWARE: the flat "Call PA Game Commission" is
    // replaced with the actionable next step for THIS issue.
    //   • TRANSPORT (animal already CONTAINED) -> have the finder DRIVE it to
    //     the nearest wildlife rehabber. Headline + a "tell the finder" line +
    //     the nearby-rehabber list (with phones) name a destination.
    //   • CAPTURE / RVS (animal NOT contained) -> PGC handles the CAPTURE.
    //     Headline says "Call PA Game Commission to capture" + shows the PGC line.
    // rec.issue is the normalized issue carried on the rec by decision.js.
    var isPgc = (rec.action === 'call_pa_game_comm');
    var pgcIssue = isPgc ? (typeof rec.issue === 'string' ? rec.issue : '') : '';
    var pgcRehabbers = (isPgc && pgcIssue === 'transport') ? nearbyRehabbers(county, animalType) : [];
    if (isPgc) {
      label = (pgcIssue === 'transport')
        ? REC.pgcTransportLabel
        : REC.pgcCaptureLabel;
    }

    // Append WIN area to dispatch-class actions (connecteam_task, dispatch_warning,
    // dispatcher_decides) so the banner reads e.g. "Dispatch via Connecteam - Area 05".
    if (rec.action === 'connecteam_task' || rec.action === 'dispatch_warning' || rec.action === 'dispatcher_decides') {
      var area = (state.countyWin && state.countyWin[county] !== undefined && state.countyWin[county] !== null)
        ? String(state.countyWin[county]).trim() : '';
      if (area) {
        // Normalize to zero-padded 2-digit (e.g. '5' -> '05').
        if (/^\d+$/.test(area) && area.length < 2) area = '0' + area;
        label += ' - Area ' + area;
      }
    }

    var html = '';
    html += '<div class="rec-action ' + tone + '">' + escapeHtml(label) + '</div>';
    if (rec.target) {
      var targetLabel = TARGET_LABELS[rec.target] || rec.target;
      html += '<div class="rec-target">' + fmt(REC.targetRole, { label: escapeHtml(targetLabel) }) + '</div>';
    }

    // Actionable PGC guidance block — what the dispatcher should TELL the finder.
    if (isPgc) {
      html += recPgcGuidanceHtml(pgcIssue, pgcRehabbers);
    }

    // dispatcher_decides (cascade tier 4): monitoring context + terse finder
    // instruction. No dual-action buttons — the banner IS the recommendation.
    if (rec.action === 'dispatcher_decides') {
      html += '<div class="dispatcher-instruction">' +
        escapeHtml(MSG.tier1Actions.monitorDispatchOption) + '</div>';
    }

    // refer_out (county-policy downgrade): show WHO to call — referral target
    // name + phone + per-target notes — plus any county-wide special
    // instructions. Set ONLY by applyCountyPolicy(); a non-refer_out rec skips
    // this block entirely so the existing dispatch/escalate markup is untouched.
    // This county-level referral guidance is shown ONLY for the In-County scope
    // (showPolicyReferral): the policy applies to the SPECIFIC county taking the
    // call, not the whole WIN area, so the WIN Area scope omits it.
    if (rec.action === 'refer_out' && showPolicyReferral) {
      var countyName = state.t1RecCountyName || '';
      html += '<div class="rec-referral">';
      html += '<div class="rec-referral-header">' + escapeHtml(REC.referralHeader) + '</div>';
      html += '<p class="rec-referral-intro">' +
        escapeHtml(fmt(REC.referralIntro, { county: countyName })) + '</p>';
      var targets = Array.isArray(rec.referral_targets) ? rec.referral_targets : [];
      if (targets.length) {
        html += '<ul class="rec-referral-list">';
        targets.forEach(function (t) {
          if (!t) return;
          html += '<li class="rec-referral-item">';
          html += '<div class="rec-referral-name">' +
            fmt(REC.referralTarget, { name: escapeHtml(t.name || '') }) + '</div>';
          // Phone: facilities.json is the SOURCE OF TRUTH. Resolve the target
          // name against the facilities index and prefer that phone over the
          // (spreadsheet-sourced) policy phone. If they differ, still SHOW the
          // facilities phone and FLAG the discrepancy inline. Targets with no
          // facilities match (e.g. PA Game Commission) keep the policy phone.
          var resolved = null;
          try {
            resolved = window.WildlifeDecision.resolveReferralPhone(t, state.facilityPhoneIndex);
          } catch (e) { resolved = null; }
          var shownRaw = (resolved && resolved.phone != null) ? String(resolved.phone) : (t.phone || '');
          if (shownRaw) {
            // Policy phones are digit-only strings (e.g. "8337429453"). Format
            // 10-digit US numbers as 833-742-9453 for display; keep the tel:
            // href as digits-only. Non-10-digit values fall back to verbatim.
            var rawPhone = String(shownRaw).trim();
            var digits = rawPhone.replace(/[^0-9]/g, '');
            var shownPhone = (digits.length === 10)
              ? (digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6))
              : rawPhone;
            var telHref = rawPhone.replace(/[^0-9+]/g, '');
            html += '<div class="rec-referral-phone">' +
              fmt(REC.referralPhone, {
                phone: '<a href="tel:' + escapeHtml(telHref) + '">' + escapeHtml(shownPhone) + '</a>'
              }) + '</div>';
            // Discrepancy flag: the policy phone disagreed with facilities.json.
            // We used facilities.json (source of truth) and note the difference.
            if (resolved && resolved.discrepancy) {
              var polDigits = String(resolved.policyPhone || '').replace(/[^0-9]/g, '');
              var polShown = (polDigits.length === 10)
                ? (polDigits.slice(0, 3) + '-' + polDigits.slice(3, 6) + '-' + polDigits.slice(6))
                : (resolved.policyPhone || '');
              html += '<div class="rec-referral-flag">' +
                escapeHtml(fmt(REC.referralPhoneDiscrepancy, { policyPhone: polShown })) + '</div>';
            }
          }
          if (t.notes) {
            html += '<div class="rec-referral-notes">' +
              escapeHtml(fmt(REC.referralNotes, { notes: t.notes })) + '</div>';
          }
          html += '</li>';
        });
        html += '</ul>';
      } else {
        html += '<p class="rec-referral-empty">' + escapeHtml(REC.referralNoTargets) + '</p>';
      }
      if (rec.special_notes) {
        html += '<div class="rec-referral-special">';
        html += '<div class="rec-referral-special-header">' + escapeHtml(REC.referralSpecialHeader) + '</div>';
        html += '<p>' + escapeHtml(fmt(REC.referralSpecialNotes, { notes: rec.special_notes })) + '</p>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Standalone policy note: shown for ANY action that carries special_notes
    // EXCEPT refer_out (which already renders them inside the referral block as
    // "Special instructions"). This lets policy makers inject county-level notes,
    // cautions, or closure info even when dispatch is fully enabled.
    if (rec.special_notes && rec.action !== 'refer_out') {
      html += '<div class="rec-policy-note">';
      html += '<div class="rec-policy-note-header">' + escapeHtml(REC.policyNoteHeader) + '</div>';
      html += '<p>' + escapeHtml(fmt(REC.policyNoteBody, { notes: rec.special_notes })) + '</p>';
      html += '</div>';
    }

    if (rec.marginal && rec.marginal_volunteers && rec.marginal_volunteers.length) {
      var marginalHeader = rec.marginalTier === 'county' ? REC.lowCapacityCounty
        : rec.marginalTier === 'area' ? REC.lowCapacityArea
        : rec.marginalTier === 'monitor' ? REC.lowCapacityMonitor
        : REC.lowCapacityHeader;
      html += '<div class="rec-marginal">';
      html += '<div class="rec-marginal-header">' + marginalHeader + '</div>';
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
    }

    // Cascade checks (terse mobile-friendly lines) replace the old reasoning
    // array for cascade-driven recommendations. Non-cascade recs (refer_out,
    // tbd_escalate, county-sufficient) fall back to the original reasoning list.
    if (rec.cascadeChecks && rec.cascadeChecks.length) {
      html += '<div class="rec-reasoning"><div class="rec-reasoning-header">' +
        REC.cascadeChecksHeader + '</div><ul class="cascade-checks">';
      rec.cascadeChecks.forEach(function (chk) {
        var icon = chk.pass ? '\u2705' : '\u274C';
        var key = 'cascadeCheck_' + chk.level;
        var line = fmt(REC[key] || '', { count: chk.count, min: chk.min, area: chk.area || '' });
        html += '<li class="cascade-check ' + (chk.pass ? 'pass' : 'fail') + '">' +
          icon + ' ' + escapeHtml(line) + '</li>';
      });
      html += '</ul></div>';
    } else if (rec.reasoning && rec.reasoning.length) {
      html += '<div class="rec-reasoning"><div class="rec-reasoning-header">' + REC.reasoningHeader + '</div><ol>';
      rec.reasoning.forEach(function (r) { html += '<li>' + escapeHtml(r) + '</li>'; });
      html += '</ol></div>';
    }
    return { html: html, tone: tone };
  }

  // Render the In-County recommendation: the count-based recommendation over the
  // selected county's capacity with the county-level policy applied. This is THE
  // recommendation — no scope toggle — shown directly with the premise line and
  // a header naming the county.
  function renderRecommendation(recCounty, base, county) {
    var REC = MSG.recommendation;
    state.t1RecCounty = recCounty;
    state.t1RecBase = base || null;
    state.t1RecCountyName = county || '';

    var html = '';
    html += '<button type="button" class="rec-dismiss" id="rec-dismiss" aria-label="' + REC.dismiss + '">' + REC.dismiss + '</button>';
    if (base) {
      var ISSUE_LABELS = { capture: 'Capture', transport: 'Transport' };
      var issueLabel = ISSUE_LABELS[base.issue] || base.issue;
      var rvsLabel = base.rvs ? 'RVS' : 'non-RVS';
      // Append the selected Animal Type in parentheses when a SPECIFIC type is
      // chosen (Other/Unknown or nothing -> append nothing). The short label
      // comes from the animalTypeLabels map keyed by the dropdown value.
      var animalLabels = REC.animalTypeLabels || {};
      var animalKey = base.animalType ? String(base.animalType).toLowerCase().trim() : '';
      var animalLabel = animalLabels[animalKey] || '';
      var premiseTxt = animalLabel
        ? fmt(REC.premiseLineWithAnimal, { issue: issueLabel, rvsLabel: rvsLabel, animal: animalLabel })
        : fmt(REC.premiseLine, { issue: issueLabel, rvsLabel: rvsLabel });
      html += '<div class="rec-premise">' + escapeHtml(premiseTxt) + '</div>';
    }

    // The recommendation body, with the county-level referral guidance shown
    // (this IS the In-County view, so policy referral always applies). The
    // selected animal type scopes the nearby-rehabber list.
    var animalType = base ? base.animalType : null;
    var built = recBodyHtml(recCounty, true, county, animalType);
    // Dispatch summary (Tier-2-depth detail): qualified-volunteer counts +
    // nearby rehabbers (filtered to facilities that accept the selected animal
    // type). Built from the SAME cached rows the volunteer-list buttons use, so
    // the counts never disagree with the lists.
    var summaryHtml = recDispatchSummaryHtml(county, animalType);
    var headerTxt = county
      ? fmt(REC.scopeHeaderCounty, { county: county })
      : REC.scopeHeaderCounty.replace('{county}', '').replace(/\s+$/, '');

    // OPTIONS panel: when local coverage is thin and the recommendation would
    // otherwise dead-end on "Call PGC", show every option in order of likelihood
    // instead of (or alongside) the basic recommendation — don't close doors.
    // Triggered for call_pa_game_comm always, and for refer_out only when there
    // is NO qualified WIN-area volunteer (thin coverage). The volunteer count is
    // read from the SAME cached Tier 1 rows/ctx the dispatch summary uses.
    var volCtx = state.t1VolCtx ||
      (base ? { county: county, rvs: !!base.rvs, issue: base.issue } : null);
    var optionsHtml = '';
    if (shouldShowOptionsPanel(recCounty, volCtx)) {
      optionsHtml = recOptionsPanelHtml(county, animalType, volCtx);
    }

    html += '<div id="rec-scope-body">' +
      '<div class="ctx-header" id="rec-scope-header">' + escapeHtml(headerTxt) + '</div>' +
      built.html + summaryHtml + '</div>';

    var out = $('#rec-output');
    out.innerHTML = html;
    out.className = 'rec-output show tone-' + built.tone;

    // Render options panel into the separate Advanced Search section (outside
    // the recommendation scroll area). Show the section when there is content;
    // hide it otherwise.
    var advSection = document.getElementById('advanced-search-section');
    var advBody = document.getElementById('advanced-search-body');
    var advBtn = document.getElementById('advanced-search-btn');
    if (advSection && advBody) {
      if (optionsHtml) {
        advBody.innerHTML = optionsHtml;
        advSection.style.display = '';
        advBody.style.display = 'none';
        if (advBtn) advBtn.classList.remove('open');
      } else {
        advBody.innerHTML = '';
        advSection.style.display = 'none';
      }
    }

    // Wire the options-panel "Show WIN Area Volunteers" button (no-op if absent).
    wireOptionsPanel();
    // Populate the monitoring-volunteers section if the async vol fetch has
    // already completed (it fires on county selection, before "Get Recommendation").
    updateMonitoringCount();

    var dismiss = document.getElementById('rec-dismiss');
    if (dismiss) {
      dismiss.addEventListener('click', function () {
        out.classList.remove('show');
        out.innerHTML = '';
        hideAdvancedSearch();
      });
    }

    // ── Cross-Post Check button (dispatch actions only) ──────────────────
    // Appended AFTER the recommendation body for connecteam_task,
    // dispatch_warning, and dispatcher_decides. Lets the dispatcher enter an
    // animal address, geocode it, and check if any other WIN area's nearest
    // county centroid is within cross_post_radius_mi.
    try {
      renderCrossPostButton(recCounty, county, out);
    } catch (e) { console.warn('cross-post button error:', e); }
  }

  // ── Cross-Post Check ─────────────────────────────────────────────────
  // Renders a "Check for Cross Post" button below the dispatch banner for
  // connecteam_task / dispatch_warning / dispatcher_decides. Clicking reveals
  // an inline address input; submitting geocodes via the Census API (server-
  // side through the Worker) and checks if any other WIN area's nearest county
  // centroid is within cross_post_radius_mi.

  function renderCrossPostButton(rec, county, container) {
    if (rec.action !== 'connecteam_task' && rec.action !== 'dispatch_warning' &&
        rec.action !== 'dispatcher_decides') return;

    // Remove any previous cross-post UI (re-render safe).
    var existing = container.querySelector('.cross-post-wrap');
    if (existing) existing.remove();

    var wrap = document.createElement('div');
    wrap.className = 'cross-post-wrap';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cross-post-btn';
    btn.textContent = 'Check for Cross Post';
    wrap.appendChild(btn);

    var inputWrap = document.createElement('div');
    inputWrap.className = 'cross-post-input';
    inputWrap.style.display = 'none';

    // Autocomplete wrapper: position:relative so the dropdown positions below
    // the input, matching the Animal Address autocomplete layout.
    var acWrap = document.createElement('div');
    acWrap.className = 'ac-wrap';
    acWrap.style.flex = '1';
    acWrap.style.minWidth = '0';

    var addrInput = document.createElement('input');
    addrInput.type = 'text';
    addrInput.placeholder = 'Animal address';
    addrInput.className = 'cross-post-addr';
    addrInput.setAttribute('autocomplete', 'off');
    addrInput.setAttribute('role', 'combobox');
    addrInput.setAttribute('aria-autocomplete', 'list');
    addrInput.setAttribute('aria-expanded', 'false');
    acWrap.appendChild(addrInput);

    // Autocomplete suggestion dropdown (same markup as #address-suggestions).
    var acList = document.createElement('ul');
    acList.className = 'ac-list';
    acList.setAttribute('role', 'listbox');
    acList.setAttribute('aria-label', 'Address suggestions');
    acList.hidden = true;
    acWrap.appendChild(acList);

    inputWrap.appendChild(acWrap);

    var checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'cross-post-check-btn';
    checkBtn.textContent = 'Check';
    inputWrap.appendChild(checkBtn);

    wrap.appendChild(inputWrap);

    var resultDiv = document.createElement('div');
    resultDiv.className = 'cross-post-result';
    resultDiv.style.display = 'none';
    wrap.appendChild(resultDiv);

    container.appendChild(wrap);

    // Track the autocomplete-selected coordinate for this cross-post instance.
    var selectedCoord = { lat: null, lon: null };

    // Wire up autocomplete on the cross-post address input (same API/dropdown
    // as the Animal Address input, via the reusable createAutocomplete factory).
    var cpAc = createAutocomplete({
      getEls: function () { return { input: addrInput, list: acList }; },
      idPrefix: 'cp-ac-opt',
      onInputChange: function () {
        // User edited the text after selecting — invalidate the cached coord.
        selectedCoord.lat = null;
        selectedCoord.lon = null;
      },
      onSelect: function (item) {
        if (typeof item.lat === 'number' && typeof item.lon === 'number' &&
            isFinite(item.lat) && isFinite(item.lon)) {
          selectedCoord.lat = item.lat;
          selectedCoord.lon = item.lon;
        } else {
          selectedCoord.lat = null;
          selectedCoord.lon = null;
        }
      }
    });
    cpAc.setup();

    btn.addEventListener('click', function () {
      var showing = inputWrap.style.display !== 'none';
      inputWrap.style.display = showing ? 'none' : '';
      if (!showing) addrInput.focus();
    });

    // Determine the dispatch area for this recommendation.
    var dispatchArea = (state.countyWin && state.countyWin[county] !== undefined &&
                        state.countyWin[county] !== null)
      ? String(state.countyWin[county]).trim() : '';

    checkBtn.addEventListener('click', function () {
      var addr = addrInput.value.trim();
      if (!addr) {
        resultDiv.style.display = '';
        resultDiv.className = 'cross-post-result cross-post-neutral';
        resultDiv.textContent = 'Enter an address to check.';
        return;
      }
      resultDiv.style.display = '';
      resultDiv.className = 'cross-post-result cross-post-neutral';
      resultDiv.textContent = 'Geocoding\u2026';
      crossPostGeocode(addr, dispatchArea, resultDiv, selectedCoord, county);
    });

    // Enter key on the input triggers the Check button (when no autocomplete
    // suggestion is actively highlighted — the factory's onKeydown handles that).
    addrInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.defaultPrevented) {
        e.preventDefault();
        checkBtn.click();
      }
    });
  }

  // Geocode an address via the Worker (same endpoint used for Tier 2 address
  // search — the Worker proxies the Census geocoder server-side, avoiding CORS).
  // On success, runs the cross-post distance check. When the autocomplete
  // already resolved a coordinate (selectedCoord), skip the geocode and use
  // those coords directly.
  function crossPostGeocode(address, dispatchArea, resultDiv, selectedCoord, county) {
    try {
      // If the autocomplete already resolved coordinates, use them directly
      // (same pattern as the Animal Address submit path).
      if (selectedCoord && typeof selectedCoord.lat === 'number' &&
          typeof selectedCoord.lon === 'number' &&
          isFinite(selectedCoord.lat) && isFinite(selectedCoord.lon)) {
        crossPostDistanceCheck(selectedCoord.lat, selectedCoord.lon, dispatchArea, resultDiv, county);
        return;
      }
      var url = WORKER_URL + '?address=' + encodeURIComponent(address) + '&radius_mi=1';
      fetch(url).then(function (resp) {
        if (!resp.ok) throw new Error('geocode_failed');
        return resp.json();
      }).then(function (data) {
        var lat = data && data.animal_lat;
        var lon = data && data.animal_lon;
        if (lat == null || lon == null) throw new Error('no_coords');
        crossPostDistanceCheck(lat, lon, dispatchArea, resultDiv, county);
      }).catch(function () {
        resultDiv.className = 'cross-post-result cross-post-neutral';
        resultDiv.textContent = 'Could not geocode that address. Try a full street + city + state + ZIP.';
        destroyCrossPostMap();
      });
    } catch (e) {
      resultDiv.className = 'cross-post-result cross-post-neutral';
      resultDiv.textContent = 'Cross-post check error.';
      destroyCrossPostMap();
    }
  }

  // Compute distance from the animal lat/lon to the NEAREST EDGE (polygon
  // boundary segment) of each county in OTHER WIN areas. Group by area — if
  // the nearest county edge in another area is within cross_post_radius_mi,
  // that area is a cross-post candidate.
  function crossPostDistanceCheck(lat, lon, dispatchArea, resultDiv, county) {
    try {
      var geo = state.geojson;
      if (!geo || !geo.features) {
        resultDiv.className = 'cross-post-result cross-post-neutral';
        resultDiv.textContent = 'County map data not loaded \u2014 cannot check cross post.';
        destroyCrossPostMap();
        return;
      }

      var radiusMi = MSG.thresholds.cross_post_radius_mi || 25;

      // For each feature, compute the minimum distance from the animal to any
      // boundary segment of the county polygon, then group by WIN area.
      var areaMinDist = {}; // area -> minimum distance (mi)
      geo.features.forEach(function (f) {
        var props = f.properties || {};
        var area = props.win_area != null ? String(props.win_area).trim() : '';
        if (!area || area === dispatchArea) return;

        var d = minDistToGeometry(lat, lon, f.geometry);
        if (d === null) return;
        if (areaMinDist[area] === undefined || d < areaMinDist[area]) {
          areaMinDist[area] = d;
        }
      });

      // Collect areas within the radius with their distances.
      var nearby = [];
      Object.keys(areaMinDist).forEach(function (area) {
        if (areaMinDist[area] <= radiusMi) {
          // Normalize area to zero-padded 2-digit for display.
          var displayArea = area;
          if (/^\d+$/.test(displayArea) && displayArea.length < 2) displayArea = '0' + displayArea;
          nearby.push({ area: displayArea, dist: areaMinDist[area] });
        }
      });

      // Sort by distance ascending (closest area first).
      nearby.sort(function (a, b) { return a.dist - b.dist; });

      if (nearby.length > 0) {
        resultDiv.className = 'cross-post-result cross-post-info';
        var labels = nearby.map(function (n) {
          return n.area + ' (' + Math.round(n.dist) + ' mi)';
        });
        resultDiv.textContent = 'Consider cross posting to Area' +
          (nearby.length > 1 ? 's ' : ' ') + labels.join(', ');
        // Render the cross-post map below the result text.
        renderCrossPostMap(lat, lon, dispatchArea, nearby, resultDiv, county);
      } else {
        resultDiv.className = 'cross-post-result cross-post-neutral';
        resultDiv.textContent = 'No other area within ' + radiusMi + ' mi \u2014 single area post';
        destroyCrossPostMap();
      }
    } catch (e) {
      resultDiv.className = 'cross-post-result cross-post-neutral';
      resultDiv.textContent = 'Cross-post check error.';
      destroyCrossPostMap();
      console.warn('cross-post distance check error:', e);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  CROSS-POST MAP (Leaflet) — inline below the cross-post result text.
  //  Shows: geocoded address pin, ALL WIN area polygons (suggested areas
  //  highlighted, others dimmed), qualified volunteers in suggested areas,
  //  qualified rehabbers in suggested areas, and a compact legend.
  //  Separate Leaflet instance from the Tier-2 address-mode map (t2map)
  //  because both can be visible simultaneously.
  // ════════════════════════════════════════════════════════════════════

  var cpMap = {
    instance: null,   // Leaflet map (created lazily)
    layers: null,     // { pin, areas, vols, rehabbers } layer groups
    wrap: null        // the .cp-map-wrap container element
  };

  function destroyCrossPostMap() {
    if (cpMap.wrap && cpMap.wrap.classList.contains('map-fullscreen')) {
      document.body.style.overflow = '';
    }
    if (cpMap.instance) {
      cpMap.instance.remove();
      cpMap.instance = null;
      cpMap.layers = null;
    }
    if (cpMap.wrap && cpMap.wrap.parentNode) {
      cpMap.wrap.parentNode.removeChild(cpMap.wrap);
      cpMap.wrap = null;
    }
  }

  // Build (or rebuild) the cross-post Leaflet map below `resultDiv`.
  // `lat`, `lon` = geocoded animal address. `dispatchArea` = the county's own
  // WIN area (shown at medium opacity). `nearby` = array of { area, dist }
  // objects for the suggested cross-post areas (highlighted).
  function renderCrossPostMap(lat, lon, dispatchArea, nearby, resultDiv, county) {
    if (typeof L === 'undefined' || !L.map) return; // Leaflet not loaded

    // Ensure GeoJSON is available (needed for area polygons).
    var geo = state.geojson;
    if (!geo || !geo.features) {
      // Try loading it; re-render when ready.
      loadMap().then(function () {
        if (state.geojson) renderCrossPostMap(lat, lon, dispatchArea, nearby, resultDiv, county);
      });
      return;
    }

    // Tear down any previous cross-post map.
    destroyCrossPostMap();

    // Build the suggested-area lookup set (normalized keys).
    var suggestedSet = {};
    (nearby || []).forEach(function (n) {
      var key = String(n.area).replace(/^0+/, '').trim();
      if (key) suggestedSet[key] = true;
    });

    // ── Container ──
    // Place the map OUTSIDE the scrollable #rec-output panel so it sits below
    // the scroll area as a fixed element (same pattern as the Tier-2 map which
    // lives outside the scrollable content). Walk up from resultDiv to find the
    // <section> that wraps #rec-output, then insert after it.
    var wrap = document.createElement('div');
    wrap.className = 'cp-map-wrap';
    var mapDiv = document.createElement('div');
    mapDiv.className = 'cp-map';
    wrap.appendChild(mapDiv);

    var recOutput = document.getElementById('rec-output');
    var sectionParent = recOutput ? recOutput.parentNode : null;
    if (sectionParent && sectionParent.parentNode) {
      // Insert after the <section> that contains #rec-output.
      if (sectionParent.nextSibling) {
        sectionParent.parentNode.insertBefore(wrap, sectionParent.nextSibling);
      } else {
        sectionParent.parentNode.appendChild(wrap);
      }
    }
    cpMap.wrap = wrap;

    // ── Leaflet instance ──
    var map = L.map(mapDiv, { scrollWheelZoom: true, attributionControl: true })
      .setView([lat, lon], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    cpMap.instance = map;
    cpMap.layers = {
      areas: L.layerGroup().addTo(map),
      pin: L.layerGroup().addTo(map),
      rehabbers: L.layerGroup().addTo(map),
      vols: L.layerGroup().addTo(map)
    };

    // Fullscreen toggle button (top-right of the cross-post map).
    addFullscreenBtn(mapDiv, wrap, map);

    var bounds = [[lat, lon]];

    // ── Draw ALL WIN area polygons ──
    // Group county features by win_area.
    var byArea = {};
    geo.features.forEach(function (f) {
      var props = f.properties || {};
      var area = (props.win_area === null || props.win_area === undefined)
        ? '' : String(props.win_area).trim();
      if (!area) return;
      if (!byArea[area]) byArea[area] = [];
      var multi = geojsonToLatLngs(f.geometry);
      multi.forEach(function (polyRings) {
        byArea[area].push(polyRings);
      });
    });

    Object.keys(byArea).forEach(function (area) {
      var color = areaColor(area);
      var normArea = area.replace(/^0+/, '').trim();
      var isSuggested = !!suggestedSet[normArea];
      var isDispatch = (normArea === String(dispatchArea).replace(/^0+/, '').trim());

      // Visual treatment: suggested = bright, dispatch = medium, other = dim.
      var fillOpacity, weight, borderOpacity;
      if (isSuggested) {
        fillOpacity = 0.40;
        weight = 3;
        borderOpacity = 1;
      } else if (isDispatch) {
        fillOpacity = 0.25;
        weight = 2;
        borderOpacity = 0.7;
      } else {
        fillOpacity = 0.10;
        weight = 1;
        borderOpacity = 0.3;
      }

      var poly = L.polygon(byArea[area], {
        color: darkenColor(color, 0.45),
        weight: weight,
        opacity: borderOpacity,
        fillColor: color,
        fillOpacity: fillOpacity,
        interactive: false
      }).addTo(cpMap.layers.areas);
      // Only label suggested and dispatch areas (not dimmed background areas).
      if (isSuggested || isDispatch) {
        poly.bindTooltip('Area ' + escapeHtml(area), {
          permanent: true,
          direction: 'center',
          className: 't2-area-label'
        });
      }

      // Include suggested + dispatch areas in bounds.
      if (isSuggested || isDispatch) {
        var b = poly.getBounds();
        if (b && b.isValid()) {
          bounds.push([b.getSouth(), b.getWest()]);
          bounds.push([b.getNorth(), b.getEast()]);
        }
      }
    });

    // ── Animal location pin ──
    L.marker([lat, lon], {
      icon: t2DivIcon('t2-pin-animal', 14),
      zIndexOffset: 1000,
      title: 'Animal location'
    }).bindPopup('<strong>Animal location</strong><br>Cross-post check address')
      .addTo(cpMap.layers.pin);

    // ── Read current animal inputs for qualification filtering ──
    var rvsEl = document.getElementById('rvs-yes') ||
                document.querySelector('input[name="rvs"][value="yes"]');
    var rvs = rvsEl ? rvsEl.checked : false;
    var issueEl = document.getElementById('issue') || $('#issue');
    var issue = issueEl ? issueEl.value : '';
    var animalTypeEl = document.getElementById('animal-type') || $('#animal-type');
    var animalType = animalTypeEl ? animalTypeEl.value : '';

    var qualifyFn = (window.WildlifeDecision &&
                     typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
      ? window.WildlifeDecision.qualifiesForAnimal : null;
    var hasBase = typeof issue === 'string' && issue !== '';

    // ── Qualified volunteers in dispatch + suggested cross-post areas ──
    // Use the SAME data pipeline as the Tier 2 map: fetch from the Worker using
    // the animal's ACTUAL coordinates (not county centroids or state.t1VolRows).
    // This ensures the cross-post map shows the SAME volunteers as the Tier 2
    // map for the dispatch area, and uses proper coordinate-based + win_area
    // filtering for suggested areas.
    var volAreaSet = {};
    Object.keys(suggestedSet).forEach(function (k) { volAreaSet[k] = true; });
    var normDispatch = String(dispatchArea).replace(/^0+/, '').trim();
    if (normDispatch) volAreaSet[normDispatch] = true;

    var perCounty = {};
    var cpVolMarkers = []; // {marker, available, roles} for legend counts + toggle

    // Helper: add volunteer rows from a Worker response to the map.
    function addVolRows(rows, filterAreaKey) {
      (rows || []).forEach(function (row) {
        if (!row) return;
        // When filterAreaKey is set, only show vols from that area.
        if (filterAreaKey) {
          var rowArea = row.win_area != null ? String(row.win_area).replace(/^0+/, '').trim() : '';
          if (rowArea !== filterAreaKey) return;
        }
        if (qualifyFn && hasBase) {
          var roleList = Array.isArray(row.roles) ? row.roles : [];
          if (!qualifyFn(roleList, rvs, issue)) return;
        }
        var vLat = NaN, vLon = NaN, placed = false;
        if (typeof row.approx_lat === 'number' && isFinite(row.approx_lat) &&
            typeof row.approx_lon === 'number' && isFinite(row.approx_lon)) {
          vLat = row.approx_lat;
          vLon = row.approx_lon;
          placed = true;
        } else if (row.county) {
          var c = state.countyCentroids && state.countyCentroids[row.county];
          if (c && isFinite(c.lat) && isFinite(c.lon)) {
            vLat = c.lat;
            vLon = c.lon;
            placed = true;
          }
        }
        if (!placed) return;
        var pinLat = vLat, pinLon = vLon;
        if (!(typeof row.approx_lat === 'number' && isFinite(row.approx_lat))) {
          var key = row.county || (vLat + ',' + vLon);
          var n = perCounty[key] || 0;
          perCounty[key] = n + 1;
          var ang = n * 2.399;
          var rad = n === 0 ? 0 : 0.012 + 0.006 * n;
          pinLat = vLat + rad * Math.cos(ang);
          pinLon = vLon + rad * Math.sin(ang);
        }
        var vNote = row.availability_note ? String(row.availability_note).trim() : '';
        var rowAvail = row.available !== false && !isUnavailNote(vNote);
        var lines = [];
        if (row.roles && row.roles.length) lines.push(escapeHtml(row.roles.join(', ')));
        if (row.county) lines.push('County: ' + escapeHtml(row.county));
        if (!rowAvail) lines.push('<em style="color:#999;">Unavailable</em>');
        var pinCls = t2VolPinClass(row.roles) + (rowAvail ? '' : ' t2-pin-unavail');
        var marker = L.marker([pinLat, pinLon], {
          icon: t2DivIcon(pinCls, 14),
          title: 'Volunteer' + (rowAvail ? '' : ' (unavailable)')
        }).bindPopup(lines.length ? lines.join('<br>') : '');
        marker.addTo(cpMapRef.layers.vols);
        cpVolMarkers.push({ marker: marker, available: rowAvail, roles: Array.isArray(row.roles) ? row.roles : [] });
        bounds.push([pinLat, pinLon]);
      });
    }

    // Fetch vols for each area (dispatch + suggested) from the Worker using the
    // animal's ACTUAL coordinates. The Worker's win_area param scopes results to
    // the target area; tier1County (animal_county) enables filterWinArea so the
    // Worker correctly filters by WIN area membership.
    var allAreaKeys = Object.keys(volAreaSet);
    var base = readAnimalBaseInfo();
    var cpMapRef = cpMap; // capture reference for async callbacks
    var cw = state.countyWin || {};
    allAreaKeys.forEach(function (areaKey) {
      // Resolve the raw WIN-area value for the Worker (preserve '15N', '15S' etc.).
      var workerArea = areaKey;
      Object.keys(cw).forEach(function (cty) {
        var raw = String(cw[cty]).trim();
        if (raw.replace(/^0+/, '').trim() === areaKey && /[A-Za-z]/.test(raw)) {
          workerArea = raw;
        }
      });

      fetchAggregateByCoord(lat, lon, RADIUS_DEFAULT,
        { context: true, base: base, tier1Area: workerArea, tier1County: county || null })
        .then(function (agg) {
          // Guard: if the map was destroyed while the fetch was in flight, bail.
          if (!cpMapRef.instance || !cpMapRef.layers) return;
          // Use out_of_county_all (the full, never-truncated set) — same source
          // the Tier 2 map uses — so volunteer counts are identical.
          var rows = (agg && Array.isArray(agg.out_of_county_all))
            ? agg.out_of_county_all
            : (agg && Array.isArray(agg.out_of_county) ? agg.out_of_county : []);
          addVolRows(rows, areaKey);
          // Re-render the cross-post legend with updated counts after async vols arrive.
          paintCpMapLegend(cpMapRef, wrap, cpVolMarkers, allRehabbers, suggestedSet, dispatchArea);
        })
        .catch(function () { /* best-effort: area vol fetch failed */ });
    });

    // ── Qualified rehabbers from dispatch + suggested cross-post areas ──
    // For the cross-post map, show rehabbers from BOTH the dispatch area AND
    // each suggested area. nearbyRehabbers() only covers the dispatch area;
    // rehabbersInArea() covers a specific area. Collect from all areas and
    // de-duplicate by rehab_name + county.
    var animalTypeEl2 = document.getElementById('animal-type') || $('#animal-type');
    var animalType2 = animalTypeEl2 ? animalTypeEl2.value : '';
    var allRehabbers = [];
    var rehabSeen = {};

    // Dispatch area rehabbers.
    var recCounty = state.t1RecCountyName || '';
    nearbyRehabbers(recCounty, animalType2).forEach(function (r) {
      var rKey = (r.rehab_name || '') + '|' + (r.county || '');
      if (!rehabSeen[rKey]) { rehabSeen[rKey] = true; allRehabbers.push(r); }
    });

    // Suggested cross-post area rehabbers.
    var suggestedAreas = Object.keys(suggestedSet);
    suggestedAreas.forEach(function (areaKey) {
      rehabbersInArea(areaKey, animalType2).forEach(function (r) {
        var rKey = (r.rehab_name || '') + '|' + (r.county || '');
        if (!rehabSeen[rKey]) { rehabSeen[rKey] = true; allRehabbers.push(r); }
      });
    });

    allRehabbers.forEach(function (r) {
      if (!r || typeof r.lat !== 'number' || typeof r.lon !== 'number') return;
      if (!isFinite(r.lat) || !isFinite(r.lon)) return;
      var phone = r.phone ? ('<br>' + escapeHtml(String(r.phone))) : '';
      var rCounty = String(r.county || '').trim();
      var countyLabel = rCounty ? ('<br>' + escapeHtml(rCounty) + ' County') : '';
      L.marker([r.lat, r.lon], {
        icon: t2DivIcon('t2-pin-rehab', 16),
        title: r.rehab_name || 'Rehabber'
      }).bindPopup('<strong>' + escapeHtml(String(r.rehab_name || 'Rehabber')) + '</strong>' +
          countyLabel + phone)
        .addTo(cpMap.layers.rehabbers);
      bounds.push([r.lat, r.lon]);
    });

    // ── Legend (dynamic, with counts + availability toggle) ──
    paintCpMapLegend(cpMap, wrap, cpVolMarkers, allRehabbers, suggestedSet, dispatchArea);

    // ── Fit bounds ──
    if (bounds.length === 1) {
      map.setView(bounds[0], 11);
    } else if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 12 });
    }
    map.invalidateSize();
  }

  // ── Dynamic legend for the cross-post map ─────────────────────────
  // Builds a compact legend panel showing pin types with per-role counts,
  // area highlighting colors, and an "Include unavailable" toggle.
  // Called once on initial render and again after each async suggested-area
  // volunteer fetch completes (to update counts).
  function paintCpMapLegend(cpMapRef, wrap, volMarkers, rehabbers, suggestedSet, dispatchArea) {
    // Remove any previous legend from this wrap.
    var prev = wrap.querySelector('.map-legend-panel');
    if (prev) prev.parentNode.removeChild(prev);

    var panel = document.createElement('div');
    panel.className = 'map-legend-panel';
    panel.setAttribute('aria-label', 'Cross-post map legend');

    // Count by role + availability
    var counts = { ct: 0, ctAvail: 0, rvsct: 0, rvsctAvail: 0, courier: 0, courierAvail: 0 };
    (volMarkers || []).forEach(function (entry) {
      var cls = t2VolPinClass(entry.roles);
      var avail = !!entry.available;
      if (cls === 't2-pin-vol-rvsct') { counts.rvsct++; if (avail) counts.rvsctAvail++; }
      else if (cls === 't2-pin-vol-ct') { counts.ct++; if (avail) counts.ctAvail++; }
      else { counts.courier++; if (avail) counts.courierAvail++; }
    });
    var rehabCount = (rehabbers || []).length;
    var hasSuggested = suggestedSet && Object.keys(suggestedSet).length > 0;

    var html = '<div class="mlp-title">Legend — showing qualified volunteers</div>';
    html += '<div class="mlp-items">';
    html += '<span class="mlp-item"><span class="mlp-dot mlp-animal"></span>Animal location</span>';
    if (rehabCount > 0) {
      html += '<span class="mlp-item"><span class="mlp-dot mlp-rehab"></span>Rehabbers <span class="mlp-count">(' + rehabCount + ')</span></span>';
    }
    if (counts.rvsct > 0) {
      html += '<span class="mlp-item"><span class="mlp-dot mlp-vol-rvsct"></span>RVS C&amp;T <span class="mlp-count">' +
        counts.rvsct + ' (' + counts.rvsctAvail + ' avail)</span></span>';
    }
    if (counts.ct > 0) {
      html += '<span class="mlp-item"><span class="mlp-dot mlp-vol-ct"></span>C&amp;T <span class="mlp-count">' +
        counts.ct + ' (' + counts.ctAvail + ' avail)</span></span>';
    }
    if (counts.courier > 0) {
      html += '<span class="mlp-item"><span class="mlp-dot mlp-vol-courier"></span>Courier <span class="mlp-count">' +
        counts.courier + ' (' + counts.courierAvail + ' avail)</span></span>';
    }
    // Area highlighting
    html += '<span class="mlp-item"><span class="mlp-dot mlp-area-dispatch"></span>Dispatch area</span>';
    if (hasSuggested) {
      html += '<span class="mlp-item"><span class="mlp-dot mlp-area-suggested"></span>Suggested areas</span>';
    }
    html += '</div>';

    // Availability toggle
    var hasUnavail = (volMarkers || []).some(function (e) { return !e.available; });
    if (hasUnavail) {
      html += '<hr class="mlp-sep">';
      html += '<label class="mlp-toggle"><input type="checkbox" class="cp-avail-toggle" checked> Include unavailable</label>';
    }

    panel.innerHTML = html;
    wrap.appendChild(panel);

    // Wire the toggle
    var toggle = panel.querySelector('.cp-avail-toggle');
    if (toggle && volMarkers && cpMapRef.layers) {
      toggle.addEventListener('change', function () {
        var show = toggle.checked;
        volMarkers.forEach(function (entry) {
          if (!entry.available) {
            if (show) {
              if (!cpMapRef.layers.vols.hasLayer(entry.marker)) {
                entry.marker.addTo(cpMapRef.layers.vols);
              }
            } else {
              cpMapRef.layers.vols.removeLayer(entry.marker);
            }
          }
        });
      });
    }
  }

  // Minimum Haversine distance (mi) from a point to any boundary segment of a
  // GeoJSON Polygon or MultiPolygon geometry.
  function minDistToGeometry(lat, lon, geometry) {
    if (!geometry) return null;
    var rings = [];
    if (geometry.type === 'Polygon' && geometry.coordinates) {
      rings = geometry.coordinates;
    } else if (geometry.type === 'MultiPolygon' && geometry.coordinates) {
      geometry.coordinates.forEach(function (poly) {
        poly.forEach(function (ring) { rings.push(ring); });
      });
    }
    if (rings.length === 0) return null;

    var minD = Infinity;
    rings.forEach(function (ring) {
      for (var i = 0; i < ring.length - 1; i++) {
        // GeoJSON coords are [lon, lat].
        var d = pointToSegmentDist(lat, lon,
          ring[i][1], ring[i][0], ring[i + 1][1], ring[i + 1][0]);
        if (d < minD) minD = d;
      }
    });
    return minD === Infinity ? null : minD;
  }

  // Haversine distance from a point (px, py) to the nearest point on the
  // line segment (ax, ay)–(bx, by), where all coordinates are lat/lon.
  // Projects onto the segment in Cartesian approximation, then measures the
  // actual Haversine distance to the projected point.
  function pointToSegmentDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var lenSq = dx * dx + dy * dy;
    var t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    var nx = ax + t * dx, ny = ay + t * dy;
    return haversineMiles(px, py, nx, ny);
  }

  // Shared animal base info, entered ONCE at the top of the console and read by
  // BOTH search paths (Tier 1 county recommend + Tier 2 widen/address). Returns
  // { rvs: bool, issue: 'capture'|'transport' } with the page defaults
  // (RVS=No, Issue=Capture) when the radios are missing.
  function readAnimalBaseInfo() {
    var rvsRadio = document.querySelector('input[name="rvs"]:checked');
    var issueRadio = document.querySelector('input[name="issue"]:checked');
    var animalTypeSel = document.getElementById('animal-type');
    return {
      rvs: rvsRadio ? (rvsRadio.value === 'yes') : false,
      issue: issueRadio ? issueRadio.value : 'capture',
      // Animal Type dropdown category drives county species_scope enforcement.
      // Defaults to 'other' (Other/Unknown), which never adds a restriction.
      animalType: animalTypeSel ? animalTypeSel.value : 'other'
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

  // Re-fetch + re-render the Tier 1 (By County) qualified-volunteer list so it
  // ALWAYS reflects the CURRENT county + CURRENT animal inputs (RVS toggle +
  // Issue/Transport radios). Unlike the recommendation cards (approach B: dim +
  // require a re-click), the volunteer list refreshes immediately on any change
  // that affects WHO qualifies — county selection AND the RVS/Issue inputs that
  // feed qualifyingRoles(). No county selected -> bump the stale-guard token and
  // hide the list so stale rows never linger. Best-effort: loadTier1Volunteers
  // never throws and leaves the rest of the UI untouched on failure.
  function refreshTier1Volunteers() {
    var countyEl = document.getElementById('county');
    var county = countyEl ? countyEl.value : '';
    if (!county) {
      t1VolToken += 1;
      hideTier1Volunteers();
      return;
    }
    loadTier1Volunteers(county, readAnimalBaseInfo());
  }

  // Called when the County dropdown changes. The new county governs the
  // recommendation cards (#rec-output) from the previous "Get Recommendation"
  // run, so flag THEM as stale — same approach-B treatment as an RVS/Issue
  // change. Never recomputes; re-clicking "Get Recommendation" clears the flag.
  // The Tier 1 volunteer list (#t1-vol-section) is NOT flagged here: it reloads
  // automatically on county change, so it is never stale relative to the county.
  function markCountyChangeStale() {
    markRecOutputStale();
    hideAdvancedSearch();
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
        hideAdvancedSearch();
      });
      return;
    }

    if (typeof window.WildlifeDecision === 'undefined' ||
        typeof window.WildlifeDecision.recommend !== 'function') {
      console.error('decision.js not loaded');
      return;
    }

    var counties = (state.snapshot && state.snapshot.counties) || {};
    // The recommendation runs over ONLY the selected county's capacity, with the
    // county-level policy applied.
    var countyCapacity = counties[county] || null;
    var base = readAnimalBaseInfo();

    var resolved = resolveForCounty(state.config, county);
    // County-level policy overlay applied AFTER the count-based recommendation.
    // The policy belongs to the SELECTED county taking the call: when the
    // county's policy forbids dispatch it becomes a refer_out with the named
    // referral targets.
    var countyPolicy = policyForCounty(county);
    var recCounty = window.WildlifeDecision.recommend(countyCapacity, base.rvs, base.issue, resolved, countyPolicy, base.animalType);

    // ── Cascade: county insufficient → check area → check monitoring ──────
    // When the county tier fails (cascade=true), probe the cached Worker data
    // for in-area and monitoring volunteers before falling through to PGC.
    // The cascade ONLY runs when (a) the rec says cascade, (b) the Worker data
    // is already cached (it fetches on county selection), and (c) the decision
    // module exposes the tier functions. If any prerequisite is missing, the
    // original call_pa_game_comm action stands (safe fallback).
    state.t1RecTier = 'county'; // default tier
    // Build cascade check metadata for the reasoning display.
    // County check is pushed only when countyCount is available (cascade paths).
    recCounty.cascadeChecks = [];
    if (recCounty.countyCount != null) {
      recCounty.cascadeChecks.push({
        level: 'county', count: recCounty.countyCount,
        min: recCounty.countyMin, pass: !recCounty.cascade
      });
    }
    if (recCounty.cascade === true && Array.isArray(state.t1VolRows) &&
        window.WildlifeDecision.recommendAreaTier &&
        window.WildlifeDecision.recommendMonitorTier) {
      var T1 = MSG.tier1Actions;
      var winArea = (state.countyWin && state.countyWin[county] !== undefined &&
                     state.countyWin[county] !== null)
        ? String(state.countyWin[county]).trim() : '';

      // Count qualified in-area vols from the cached Tier 1 rows (already
      // area-scoped by the Worker). Uses the SAME qualifiesForAnimal predicate.
      var qualifyFn = (window.WildlifeDecision &&
                       typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
        ? window.WildlifeDecision.qualifiesForAnimal : null;
      var hasBase = typeof base.issue === 'string' && base.issue !== '';
      var areaQualCount = state.t1VolRows.length;
      if (qualifyFn && hasBase) {
        areaQualCount = state.t1VolRows.filter(function (row) {
          var roleList = Array.isArray(row.roles) ? row.roles : [];
          return qualifyFn(roleList, !!base.rvs, base.issue);
        }).length;
      }

      var areaTier = window.WildlifeDecision.recommendAreaTier(
        areaQualCount, base.rvs, base.issue, resolved);
      recCounty.cascadeChecks.push({
        level: 'area', count: areaQualCount, min: areaTier.min,
        pass: areaTier.pass, area: winArea
      });
      if (areaTier.pass) {
        // Tier 3: area volunteers available — dispatch with warning
        recCounty.action = 'dispatch_warning';
        recCounty.cascade = false;
        state.t1RecTier = 'area';
        recCounty.reasoning.push(
          fmt(T1.areaVolsAvailable, { count: areaQualCount, area: winArea }));
        recCounty.reasoning.push(T1.areaDispatchWarning);
        // Low-capacity warning: area tier barely passes (count equals minimum)
        if (areaQualCount <= areaTier.min) {
          recCounty.marginal = true;
          recCounty.marginalTier = 'area';
        }
      } else {
        // Area tier failed — try monitoring tier
        recCounty.reasoning.push(
          fmt(T1.areaInsufficient, { count: areaQualCount, min: areaTier.min }));
        var monRows = Array.isArray(state.t1MonitoringVols) ? state.t1MonitoringVols : [];
        var monCount = 0;
        for (var mi = 0; mi < monRows.length; mi++) {
          var mRoles = Array.isArray(monRows[mi].roles) ? monRows[mi].roles : [];
          if (qualifyFn && hasBase) {
            if (qualifyFn(mRoles, !!base.rvs, base.issue)) { monCount++; }
          } else {
            monCount++;  // no filter available, count all
          }
        }
        var monTier = window.WildlifeDecision.recommendMonitorTier(
          monCount, base.rvs, base.issue, resolved);
        recCounty.cascadeChecks.push({
          level: 'monitor', count: monCount, min: monTier.min,
          pass: monTier.pass
        });
        if (monTier.pass) {
          // Tier 4: monitoring volunteers available — dispatcher decides
          recCounty.action = 'dispatcher_decides';
          recCounty.cascade = false;
          state.t1RecTier = 'monitor';
          recCounty.reasoning.push(
            fmt(T1.monitorVolsAvailable, { count: monCount }));
          // Low-capacity warning: monitor tier barely passes (count equals minimum)
          if (monCount <= monTier.min) {
            recCounty.marginal = true;
            recCounty.marginalTier = 'monitor';
          }
        } else {
          // All tiers failed — keep call_pa_game_comm
          recCounty.reasoning.push(
            fmt(T1.monitorInsufficient, { count: monCount, min: monTier.min }));
        }
      }
    }

    // Policy refer_out overrides cascade — clear cascade checks so the policy
    // reasoning renders instead (the refer_out block has its own display).
    if (recCounty.action === 'refer_out') {
      recCounty.cascadeChecks = [];
    }

    renderRecommendation(recCounty, base, county);

    // NOTE: the Tier 1 qualified-volunteer list is NO LONGER loaded here. It now
    // populates AUTOMATICALLY when a county is selected (see the #county change
    // handler) — independent of this "Get Recommendation" run.
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
    // Tier 1 WIN-area scope: confine the By-County list to the selected county's
    // WIN area (matches the summary cards' county_capacity scope). The Worker
    // filters out_of_county rows to this win_area. Only Tier 1 sends it.
    if (opts && opts.tier1Area) {
      url += '&win_area=' + encodeURIComponent(opts.tier1Area);
    }
    url = appendAggregateOpts(url, opts);
    return fetchAggregate(url);
  }

  // Append the shared rvs/issue + derived qualify_roles params (see
  // fetchAggregateByAddress for the rationale). Pure string builder.
  //
  // qualify_roles is ALWAYS sent (for both Tier 2 address/widen AND the Tier 1
  // By-County volunteer list) so the Worker returns ONLY the volunteers whose
  // roles qualify for the CURRENT scenario (derived from rvs/issue via
  // decision.js qualifyingRoles). Tier 1 = Tier 2 behavior: qualified-only,
  // with unavailable volunteers dimmed (not dropped) downstream.
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
    // Drop any DMA banner from a prior lookup, and bump the token so a slow
    // in-flight DMA fetch can't repopulate it after this reset.
    dmaCheckToken++;
    var dma = $('#dma-status');
    if (dma) { dma.innerHTML = ''; dma.style.display = 'none'; dma.className = 'dma-status'; }
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

  // Role-colored left-border modifier for a volunteer .ctx-row (mirrors the
  // role badge color). Derived from the row's FIRST role so the Tier 1 and
  // Tier 2 lists get the SAME accent. Returns 'role-rvs' / 'role-courier' /
  // 'role-ct' (default green). Used by both renderContextList and rowHtml.
  function roleRowClass(roleList) {
    var first = (Array.isArray(roleList) && roleList.length) ? roleList[0] : '';
    var cls = roleBadgeClass(first);
    return cls ? 'role-' + cls : 'role-ct';
  }

  // Returns true when `note` contains any DENY_WORDS substring (case-insensitive),
  // meaning this volunteer is currently unavailable. Mirrors Python is_available().
  function isUnavailNote(note) {
    if (!note) return false;
    var lower = String(note).toLowerCase();
    return DENY_WORDS.some(function (w) { return lower.indexOf(w) !== -1; });
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

    // A fresh Tier-2 lookup always starts collapsed: the block (with its toggle
    // button) may become visible below, but the list itself (#ctx-content) stays
    // hidden behind "Show qualified volunteers" until the dispatcher expands it.
    // Mirrors the Tier 1 reset in renderTier1Volunteers().
    var contentEl = $('#ctx-content');
    var toggleEl = $('#ctx-vol-toggle');
    if (contentEl) contentEl.style.display = 'none';
    if (toggleEl) {
      toggleEl.textContent = 'Show qualified volunteers';
      toggleEl.setAttribute('aria-expanded', 'false');
    }

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

    // Header count must reflect volunteers actually WITHIN the radius (matching
    // the "Volunteers in range" card), NOT the raw rows.length — the Worker can
    // include beyond-radius "edge" rows in out_of_county (e.g. an 80–145 mi
    // helper on a 20 mi radius). Counting those under "within {radius} mi" was
    // misleading (the bug). Split the qualified rows by the radius: {count} =
    // in-radius, with a "(+N beyond)" note appended only when extra farther rows
    // are listed. With no numeric radius (shouldn't happen here) fall back to the
    // full rows.length so the count is never understated.
    var radiusForCount = Number(radius);
    var inRangeCount = rows.length;
    var beyondCount = 0;
    if (Number.isFinite(radiusForCount) && radiusForCount > 0) {
      inRangeCount = 0;
      rows.forEach(function (row) {
        var d = (typeof row.distance_mi === 'number') ? row.distance_mi : Number(row.distance_mi);
        if (Number.isFinite(d) && d > radiusForCount) beyondCount++;
        else inRangeCount++;
      });
    }
    var beyondNote = beyondCount > 0
      ? fmt(T2.ctxHeaderBeyondNote, { beyondCount: beyondCount })
      : '';
    if (headerEl) {
      headerEl.textContent = county
        ? fmt(T2.ctxHeaderBeyond, { radius: radius, county: county, count: inRangeCount, beyond: beyondNote })
        : fmt(T2.ctxHeader, { radius: radius, count: inRangeCount, beyond: beyondNote });
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
      var driveMi = (typeof row.driving_miles === 'number') ? row.driving_miles : Number(row.driving_miles);
      var distTxt;
      // DRIVING label ("X.X mi driving / ~Y min") when the Worker supplied a
      // per-volunteer driving TIME (display-only annotation computed AFTER the
      // straight-line membership gate). The "mi driving" number is the real ORS
      // driving distance (row.driving_miles); it falls back to the straight-line
      // distance only if driving_miles was not surfaced. When no driving time is
      // present (ORS unavailable), show the plain straight-line label ("X.X mi")
      // — never a fabricated time. Membership/edge always use straight-line dist.
      if (Number.isFinite(dist) && typeof row.duration_min === 'number') {
        var shownMi = Number.isFinite(driveMi) ? driveMi : dist;
        distTxt = fmt(T2.ctxDistanceDriving, {
          dist: shownMi.toFixed(1),
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

      // Availability note: show as small italic subtitle; dim row if unavailable.
      // A row is unavailable when `available === false` (set by the Worker from
      // the KV `available` field) OR when the note text contains a deny keyword.
      // This handles the case where available=false but availability_note is blank.
      var vNote = row.availability_note ? String(row.availability_note).trim() : '';
      var unavail = (row.available === false) || isUnavailNote(vNote);
      var rowClass = 'ctx-row ' + roleRowClass(roleList) + (unavail ? ' unavail' : '');
      var noteHtml = vNote
        ? '<div class="ctx-avail-note">' + escapeHtml(vNote) + '</div>'
        : '';

      return '<li class="' + rowClass + '">' +
             '<div class="ctx-row-top">' +
             '<span class="role-badges">' + badges + '</span>' +
             '<span class="ctx-dist">' + distTxt + '</span>' +
             ctxTxt + edge +
             '</div>' +
             noteHtml +
             '</li>';
    }).join('');

    if (listEl) listEl.innerHTML = html;
    block.style.display = 'block';
    highlightFromContext(rows, agg.animal_area);
  }

  // ─── Tier 1 (By-County) qualified-volunteer list ───────────────────
  // Replicates the Tier 2 #ctx-list rendering for the By-County panel. Each row
  // shows: role badges, County + WIN Area context, and the availability note —
  // and is DIMMED via the SAME .ctx-row.unavail treatment Tier 2 uses when the
  // volunteer is not currently available. `rows` are the Worker context rows
  // (out_of_county shape: {roles, distance_mi, win_area, county, availability_note,
  // available}); `ctx` carries { county, rvs, issue } for the header + the
  // defensive qualified-only filter. Hidden entirely when there is no list.

  // Reset BOTH scope buttons to the collapsed state (label + aria + active mark).
  function resetT1VolToggles() {
    var countyBtn = $('#t1-vol-toggle-county');
    var areaBtn = $('#t1-vol-toggle-area');
    [countyBtn, areaBtn].forEach(function (btn) {
      if (!btn) return;
      btn.setAttribute('aria-expanded', 'false');
      btn.classList.remove('is-active');
    });
  }

  function hideTier1Volunteers() {
    var section = $('#t1-vol-section');
    var listEl = $('#t1-vol-list');
    var emptyEl = $('#t1-vol-empty');
    var blockEl = $('#t1-vol-block');
    // Clear any stale flag so a hidden (or about-to-be-rebuilt) section never
    // carries a dim/banner over from a previous county selection.
    clearStale(section);
    if (section) section.style.display = 'none';
    if (listEl) listEl.innerHTML = '';
    if (emptyEl) { emptyEl.style.display = 'none'; emptyEl.textContent = ''; }
    // Collapse the list + reset BOTH scope buttons so the next recommendation
    // starts hidden again (no scope open).
    if (blockEl) blockEl.style.display = 'none';
    resetT1VolToggles();
    // Drop the cached rows/ctx/scope so a stale list can never be re-opened.
    state.t1VolRows = null;
    state.t1VolCtx = null;
    state.t1VolScope = null;
    state.t1MonitoringVols = null;
  }

  // Render the cached Tier 1 volunteer rows into #t1-vol-block at the requested
  // SCOPE: 'county' (only volunteers whose home county === the selected county)
  // or 'area' (every qualified volunteer in the selected county's WIN area — the
  // original behavior). Both scopes use the SAME row markup, qualified-only
  // filter, unavailable dimming, role-colored borders, and Transport cap/banner;
  // only the row SET differs. Returns nothing; safe to call repeatedly (used by
  // the two scope buttons). When the cache is empty it no-ops.
  function renderT1VolScope(scope) {
    var rows = state.t1VolRows;
    var ctx = state.t1VolCtx;
    if (!Array.isArray(rows) || !ctx) return;
    state.t1VolScope = scope;
    renderT1VolList(rows, ctx, scope);
  }

  // Cache the fetched rows + render context, reveal the section with BOTH scope
  // buttons, and start COLLAPSED (no list shown) until the dispatcher clicks a
  // scope button. The list body is built on demand by renderT1VolScope so the
  // two buttons re-render the SAME data at different scopes without re-fetching.
  function renderTier1Volunteers(rows, ctx) {
    var section = $('#t1-vol-section');
    var emptyEl = $('#t1-vol-empty');
    var blockEl = $('#t1-vol-block');
    if (!section) return;

    state.t1VolRows = Array.isArray(rows) ? rows : [];
    state.t1VolCtx = ctx || {};
    state.t1VolScope = null;

    // A fresh recommendation always starts collapsed: the section (with its two
    // scope buttons) becomes visible, but the list itself stays hidden until the
    // dispatcher opens a scope.
    if (blockEl) blockEl.style.display = 'none';
    if (emptyEl) { emptyEl.style.display = 'none'; emptyEl.textContent = ''; }
    resetT1VolToggles();

    // Re-rendering (driven by a fresh "Get Recommendation" run / county change)
    // clears any stale flag carried over so the refreshed rows never show under
    // the dim/banner treatment.
    clearStale(section);

    section.style.display = 'block';

    // Pre-build the list body at the WIN-AREA scope (the original default) into
    // the still-hidden #t1-vol-block. This keeps the rendered rows present in the
    // DOM the moment the section appears (the block stays collapsed until a scope
    // button is clicked), and gives the area button an instant reveal. Clicking
    // either button re-renders at the chosen scope via renderT1VolScope.
    renderT1VolList(state.t1VolRows, state.t1VolCtx, 'area');
  }

  // Build the volunteer <li> list for a given scope. Extracted from the former
  // renderTier1Volunteers body so both scope buttons reuse the identical
  // qualified-only / dim / cap / banner logic; the ONLY difference is the
  // scope-level county filter applied up front.
  function renderT1VolList(rows, ctx, scope) {
    var section = $('#t1-vol-section');
    var listEl = $('#t1-vol-list');
    var emptyEl = $('#t1-vol-empty');
    var headerEl = $('#t1-vol-header');
    var blockEl = $('#t1-vol-block');
    if (!section) return;

    var T2 = MSG.tier2Aggregate;
    var county = (ctx && ctx.county) ? ctx.county : '';
    var countyScope = scope === 'county';
    if (headerEl) {
      var headerTpl = countyScope ? T2.tier1VolHeaderCounty : T2.tier1VolHeader;
      headerEl.textContent = county
        ? fmt(headerTpl, { county: county })
        : headerTpl.replace('{county}', '').replace(/\s+$/, '');
    }

    // QUALIFIED-ONLY list (SAME rule Tier 2's renderContextList applies). The
    // Worker already returns role-matched rows (it filtered by the qualify_roles
    // param we sent), but re-apply a DEFENSIVE frontend filter via the SHARED
    // decision.js predicate (qualifiesForAnimal — the SAME rule, no
    // re-derivation) so an unqualified row can never render. Skipped when base
    // info is absent (backward compat). Availability is NOT filtered here:
    // unavailable volunteers are KEPT and dimmed below (the original complaint
    // was an unavailable C&T volunteer being hidden entirely).
    var qualifyFn = (window.WildlifeDecision &&
                     typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
      ? window.WildlifeDecision.qualifiesForAnimal : null;
    var hasBase = ctx && typeof ctx.issue === 'string' && ctx.issue !== '';
    var list = Array.isArray(rows) ? rows : [];
    if (qualifyFn && hasBase) {
      list = list.filter(function (row) {
        var roleList = Array.isArray(row.roles) ? row.roles : [];
        return qualifyFn(roleList, !!ctx.rvs, ctx.issue);
      });
    }

    // SCOPE FILTER: the In-County view keeps ONLY volunteers whose home county
    // matches the selected county. The WIN-area fetch already returns every
    // in-county volunteer (county ⊆ win_area), so this is a pure client-side
    // narrowing — no re-fetch. The WIN-area scope leaves the list untouched.
    if (countyScope && county) {
      list = list.filter(function (row) {
        return row.county && String(row.county) === county;
      });
    }

    if (!list.length) {
      if (listEl) listEl.innerHTML = '';
      // Remove any banner / expand-link left over from a previous scope render.
      var prevBannerE = blockEl ? blockEl.querySelector('.t1-vol-all-qualified') : null;
      if (prevBannerE) prevBannerE.parentNode.removeChild(prevBannerE);
      var prevMoreE = blockEl ? blockEl.querySelector('.t1-vol-show-all') : null;
      if (prevMoreE) prevMoreE.parentNode.removeChild(prevMoreE);
      if (emptyEl) {
        var emptyTpl = countyScope ? T2.tier1VolEmptyCounty : T2.tier1VolEmpty;
        emptyEl.textContent = county
          ? fmt(emptyTpl, { county: county })
          : emptyTpl.replace('{county}', '').replace(/\s+$/, '');
        emptyEl.style.display = 'block';
      }
      section.style.display = 'block';
      return;
    }
    if (emptyEl) { emptyEl.style.display = 'none'; emptyEl.textContent = ''; }

    // Build the <li> markup for a single volunteer row (role badges + County +
    // WIN Area context + availability note, with the SAME dim treatment Tier 2
    // uses). Extracted so both the full list and the capped list reuse it.
    function rowHtml(row) {
      var roleList = Array.isArray(row.roles) ? row.roles : [];
      var badges = roleList.map(function (r) {
        var cls = roleBadgeClass(r);
        return '<span class="role-badge' + (cls ? ' ' + cls : '') + '">' +
               escapeHtml(r) + '</span>';
      }).join('');

      // County + WIN Area context (the four required fields are: County, WIN
      // Area, role badges, availability note).
      var ctxBits = [];
      if (row.win_area) ctxBits.push(fmt(T2.areaChip, { area: escapeHtml(String(row.win_area)) }));
      if (row.county) ctxBits.push(escapeHtml(String(row.county)));
      var ctxTxt = ctxBits.length ? ' <span class="ctx-ctx">· ' + ctxBits.join(' · ') + '</span>' : '';

      // Availability note + dimming: unavailable when available===false OR the
      // note carries a deny keyword (mirrors Tier 2 renderContextList).
      var vNote = row.availability_note ? String(row.availability_note).trim() : '';
      var unavail = (row.available === false) || isUnavailNote(vNote);
      var rowClass = 'ctx-row ' + roleRowClass(roleList) + (unavail ? ' unavail' : '');
      var noteHtml = vNote
        ? '<div class="ctx-avail-note">' + escapeHtml(vNote) + '</div>'
        : '';

      return '<li class="' + rowClass + '">' +
             '<div class="ctx-row-top">' +
             '<span class="role-badges">' + badges + '</span>' +
             ctxTxt +
             '</div>' +
             noteHtml +
             '</li>';
    }

    // ── CAP: when EVERY volunteer in the area qualifies (all 3 role types are
    //    taskable — i.e. qualifyingRoles returns C&T + RVS C&T + COURIER, which
    //    happens on Issue=Transport), the list can be very long (19+ for
    //    Allegheny). Show only 1-2 per role category, prioritizing the SELECTED
    //    county over sibling counties in the same WIN area, with a banner + a
    //    "Show all X volunteers" expand link. Other scenarios (smaller lists)
    //    render in full as before. ─────────────────────────────────────────
    var PER_ROLE_CAP = 2;
    var qfn = (window.WildlifeDecision &&
               typeof window.WildlifeDecision.qualifyingRoles === 'function')
      ? window.WildlifeDecision.qualifyingRoles : null;
    var qroles = (qfn && hasBase) ? qfn(!!ctx.rvs, ctx.issue) : [];
    var allRolesQualify = Array.isArray(qroles) && qroles.length >= 3;

    // Primary role for a row = its first canonical role badge (rows are
    // single-role from the Worker, but stay defensive). Used to bucket by
    // category for the per-role cap.
    function primaryRole(row) {
      var roleList = Array.isArray(row.roles) ? row.roles : [];
      return roleList.length ? String(roleList[0]) : '';
    }

    var capped = false;
    var displayList = list;
    if (allRolesQualify && list.length > qroles.length * PER_ROLE_CAP) {
      // Stable selected-county-first ordering: in-county rows keep their order
      // and float ahead of sibling-county rows (which also keep their order).
      var inCounty = [];
      var siblings = [];
      list.forEach(function (row) {
        if (county && row.county && String(row.county) === county) inCounty.push(row);
        else siblings.push(row);
      });
      var ordered = inCounty.concat(siblings);

      // Take up to PER_ROLE_CAP per role category, walking the county-priority
      // order so selected-county volunteers fill each bucket first.
      var perRoleCount = {};
      var picked = [];
      ordered.forEach(function (row) {
        var role = primaryRole(row);
        var n = perRoleCount[role] || 0;
        if (n < PER_ROLE_CAP) {
          perRoleCount[role] = n + 1;
          picked.push(row);
        }
      });
      if (picked.length < list.length) {
        capped = true;
        displayList = picked;
      }
    }

    var html = displayList.map(rowHtml).join('');

    // Remove any banner / expand-link left over from a previous render so a
    // fresh (e.g. non-capped) render never carries stale UI.
    var prevBanner = blockEl ? blockEl.querySelector('.t1-vol-all-qualified') : null;
    if (prevBanner) prevBanner.parentNode.removeChild(prevBanner);
    var prevMore = blockEl ? blockEl.querySelector('.t1-vol-show-all') : null;
    if (prevMore) prevMore.parentNode.removeChild(prevMore);

    if (listEl) listEl.innerHTML = html;

    // Banner: shown whenever ALL roles qualify (Issue=Transport ->
    // qualifyingRoles returns all 3), INDEPENDENT of list length. The message is
    // about QUALIFICATION ("everyone here is taskable"), not about capping, so it
    // must appear consistently across counties — whether the list is long enough
    // to be capped (Armstrong) or short (Adams/Allegheny). Injected as a SIBLING
    // of the <ul> (never nested inside it) so the list stays valid <ul><li>.
    var bannerEl = null;
    if (allRolesQualify && listEl && blockEl) {
      bannerEl = document.createElement('div');
      bannerEl.className = 't1-vol-all-qualified';
      bannerEl.setAttribute('role', 'note');
      bannerEl.textContent = T2.tier1VolAllQualified +
        (capped ? (T2.tier1VolAllQualifiedCapped || '') : '');
      listEl.parentNode.insertBefore(bannerEl, listEl);
    }

    // Expand link: ONLY in the capped state. It swaps the capped rows for the
    // FULL list and removes itself + the banner so the dispatcher can see every
    // qualified volunteer on demand.
    if (capped && listEl && blockEl) {
      var fullHtml = list.map(rowHtml).join('');
      var moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 't1-vol-show-all link-btn';
      moreBtn.textContent = fmt(T2.tier1VolShowAll, { count: list.length });
      if (listEl.nextSibling) listEl.parentNode.insertBefore(moreBtn, listEl.nextSibling);
      else listEl.parentNode.appendChild(moreBtn);
      moreBtn.addEventListener('click', function () {
        listEl.innerHTML = fullHtml;
        if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
        if (moreBtn.parentNode) moreBtn.parentNode.removeChild(moreBtn);
      });
    }

    section.style.display = 'block';
  }

  // Fetch + render the Tier 1 qualified-volunteer list for the selected county.
  // Best-effort: the Worker is queried with the county CENTROID as origin (Tier 1
  // has no animal coordinate) and context=1, returning the PII-safe per-volunteer
  // rows. ANY failure leaves the existing recommendation intact and hides the
  // list. A stale-token guard ignores out-of-order responses.
  function loadTier1Volunteers(county, base) {
    if (!county) { hideTier1Volunteers(); return; }
    var token = ++t1VolToken;

    // Immediately clear cached Tier 1 state so the cascade cannot read stale
    // data from a previous county while the new fetch is in flight.
    state.t1VolRows = null;
    state.t1VolCtx = null;
    state.t1MonitoringVols = null;

    function withCentroid() {
      if (token !== t1VolToken) return; // a newer lookup superseded us
      var centroid = state.countyCentroids && state.countyCentroids[county];
      if (!centroid || typeof centroid.lat !== 'number' || typeof centroid.lon !== 'number') {
        hideTier1Volunteers();
        return;
      }
      // Send qualify_roles (the default — no allRoles flag) so the Worker
      // returns ONLY the role-matched volunteers for the CURRENT scenario, the
      // SAME way Tier 2 (address/widen) queries. Tier 1 differs only in origin:
      // the county CENTROID instead of an address coordinate.
      //
      // SCOPE: also send the county's WIN AREA so the Worker scopes the list to
      // that WIN area (the SAME set the summary cards aggregate from
      // county_capacity.json) instead of every volunteer within a centroid
      // radius — otherwise the radius bleeds into NEIGHBORING areas (e.g. an
      // Area-13 Cumberland volunteer surfacing for an Area-12 Adams query).
      var tier1Area = (state.countyWin && state.countyWin[county] !== undefined &&
                       state.countyWin[county] !== null)
        ? String(state.countyWin[county]).trim()
        : null;
      fetchAggregateByCoord(centroid.lat, centroid.lon, RADIUS_DEFAULT,
        { context: true, base: base, tier1County: county, tier1Area: tier1Area })
        .then(function (agg) {
          if (token !== t1VolToken) return; // stale response — ignore
          var rows = (agg && Array.isArray(agg.out_of_county)) ? agg.out_of_county : [];
          // Cross-area monitors: vols from OTHER areas whose monitored_areas
          // includes the target area. Worker computes this when win_area is set.
          state.t1MonitoringVols = (agg && Array.isArray(agg.monitoring_area_vols))
            ? agg.monitoring_area_vols : [];
          renderTier1Volunteers(rows, { county: county, rvs: base.rvs, issue: base.issue });
          updateMonitoringCount();
        })
        .catch(function () {
          if (token !== t1VolToken) return;
          hideTier1Volunteers();
        });
    }

    // Centroids come from the county GeoJSON (loaded at init). If they are not
    // in yet, load the map data first, then proceed — same lazy pattern the
    // Tier-2 map uses (paintT2Map → loadMap).
    if (state.countyCentroids && state.countyCentroids[county]) {
      withCentroid();
    } else {
      loadMap().then(withCentroid).catch(function () {
        if (token === t1VolToken) hideTier1Volunteers();
      });
    }
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

  // ════════════════════════════════════════════════════════════════════
  //  TIER-2 INLINE LOCATOR MAP (Leaflet) — lazy-init behind a Show/Hide
  //  toggle inside #address-result. Lets the dispatcher visually verify the
  //  geocoded animal address and see who is nearby. Library is vendored
  //  (assets/vendor/leaflet) so it works on file:// + GitHub Pages with no
  //  CDN; only the OSM map TILES require network.
  //
  //  Three marker types (see legend in dispatcher.html):
  //    • Animal location — red diamond, most prominent, map auto-fits to it.
  //    • Rehabbers       — blue dots (public coords from rehabbers.json).
  //    • Volunteers      — amber dots at HOME-COUNTY CENTROID (exact volunteer
  //                        coords are NEVER sent to the browser; see the
  //                        clearly-marked VOLUNTEER block below).
  // ════════════════════════════════════════════════════════════════════

  // ── VOLUNTEER MARKERS master switch ────────────────────────────────
  // Flip to false (or delete the marked blocks) to remove ALL volunteer
  // markers — data prep, markers, and the legend entry are isolated.
  var SHOW_VOLUNTEER_MARKERS = true;

  var t2map = {
    instance: null,   // Leaflet map (created lazily on first reveal)
    layers: null,     // { animal, rehab, volunteer } feature groups
    pending: null,    // last render payload, applied when the map first opens
    open: false
  };

  // Average driving speed (mph) used to ESTIMATE travel time from distance when
  // no real ORS driving time is available. ~40 mph is a sensible blended
  // rural/suburban PA figure. Shared by both rehabber and volunteer popups so
  // their fallback estimates are consistent. No external routing call is made.
  var T2_EST_SPEED_MPH = 40;

  // Compact single-line distance/time label for a map popup, e.g.
  //   real ORS time present →  "10.1 miles / 15 min"
  //   estimate fallback     →  "10.1 miles / ~15 min (est.)"
  // distMi: distance in miles (any finite number). minReal: REAL driving minutes
  // (whole or fractional) when known, else null/undefined to fall back to the
  // 40 mph estimate. Returns '' when distance is not usable.
  function t2DistTimeLine(distMi, minReal) {
    if (typeof distMi !== 'number' || !isFinite(distMi)) return '';
    var distTxt = distMi.toFixed(1) + ' miles';
    if (typeof minReal === 'number' && isFinite(minReal)) {
      return distTxt + ' / ' + Math.round(minReal) + ' min';
    }
    if (T2_EST_SPEED_MPH > 0) {
      var estMin = Math.round((distMi / T2_EST_SPEED_MPH) * 60);
      return distTxt + ' / ~' + estMin + ' min (est.)';
    }
    return distTxt;
  }

  // Build a small CSS-styled DivIcon (no external sprite dependency).
  // Pick the pin CSS class for a volunteer by ROLE, using the highest-priority
  // role when several are present: RVS C&T > C&T > COURIER. Roles are canonical
  // labels ('RVS C&T' / 'C&T' / 'COURIER') but may vary in case/whitespace, so
  // normalize before matching. Falls back to the plain courier-blue pin.
  function t2VolPinClass(roles) {
    var has = { rvs: false, ct: false, courier: false };
    (roles || []).forEach(function (r) {
      var k = String(r || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (k === 'rvs c&t') has.rvs = true;
      else if (k === 'c&t') has.ct = true;
      else if (k === 'courier') has.courier = true;
    });
    if (has.rvs) return 't2-pin-vol-rvsct';   // dark green
    if (has.ct) return 't2-pin-vol-ct';       // light green
    return 't2-pin-vol-courier';              // blue (default)
  }

  function t2DivIcon(cls, size) {
    return L.divIcon({
      className: '',
      html: '<span class="t2-pin ' + cls + '"></span>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -(size / 2)]
    });
  }

  // ── WIN-area boundaries (Tier-2 map overlay) ───────────────────────
  // WIN areas are COUNTY-BASED regions (the Worker returns win_areas as an
  // array of area names/numbers, NOT polygon coordinates). We draw each
  // affected area as the union of its member-county polygons from the SAME
  // committed pa_counties.json the choropleth uses (properties: {county,
  // win_area, geoid}). Each area is one semi-transparent shaded group with a
  // visible colored border, labeled with the area name at the area centroid.

  // Convert a GeoJSON Polygon/MultiPolygon ring set into Leaflet latlng arrays.
  // Leaflet wants [lat, lon]; GeoJSON stores [lon, lat].
  function geojsonToLatLngs(geom) {
    function ring(r) {
      return r.map(function (pt) { return [pt[1], pt[0]]; });
    }
    if (!geom) return [];
    if (geom.type === 'Polygon') {
      return [geom.coordinates.map(ring)];
    }
    if (geom.type === 'MultiPolygon') {
      return geom.coordinates.map(function (poly) { return poly.map(ring); });
    }
    return [];
  }

  // Draw boundaries for the given WIN areas onto t2map.layers.winArea. `areas`
  // is the API's win_areas list (strings/numbers). Returns an array of [lat,lon]
  // bound points so the caller can include the shaded regions in fitBounds.
  function drawWinAreaBoundaries(areas) {
    var pts = [];
    if (!t2map.instance || !t2map.layers || !t2map.layers.winArea) return pts;
    t2map.layers.winArea.clearLayers();

    var geo = state.geojson;
    var features = (geo && Array.isArray(geo.features)) ? geo.features : [];
    if (!features.length) return pts;

    var wanted = {};
    (areas || []).forEach(function (a) {
      if (a === null || a === undefined) return;
      var key = String(a).trim();
      if (key !== '') wanted[key] = true;
    });
    if (!Object.keys(wanted).length) return pts;

    // Group member-county polygons by area so each area is one styled overlay
    // with a single label.
    var byArea = {};
    features.forEach(function (f) {
      var props = f.properties || {};
      var area = (props.win_area === null || props.win_area === undefined)
        ? '' : String(props.win_area).trim();
      if (!area || !wanted[area]) return;
      if (!byArea[area]) byArea[area] = { latlngs: [], pts: [] };
      var multi = geojsonToLatLngs(f.geometry);
      multi.forEach(function (polyRings) {
        byArea[area].latlngs.push(polyRings);
        polyRings.forEach(function (r) {
          r.forEach(function (ll) { byArea[area].pts.push(ll); });
        });
      });
    });

    Object.keys(byArea).forEach(function (area) {
      var color = areaColor(area);
      var poly = L.polygon(byArea[area].latlngs, {
        // Boundary lines use a darkened version of the area's fill so each
        // border reads as a strong, high-contrast line against the interior.
        // The thicker weight makes it obvious where one WIN area ends and the
        // next begins -- critical when an animal sits right on the line
        // between two areas that both need alerting.
        color: darkenColor(color, 0.45),
        weight: 3,
        opacity: 1,
        // Semi-transparent fill so the map tiles underneath remain visible
        // while the saturated hues stay clearly distinguishable.
        fillColor: color,
        fillOpacity: 0.30,
        interactive: false
      }).addTo(t2map.layers.winArea);
      poly.bindTooltip('WIN Area ' + escapeHtml(area), {
        permanent: true,
        direction: 'center',
        className: 't2-area-label'
      });
      var b = poly.getBounds();
      if (b && b.isValid()) {
        pts.push([b.getSouth(), b.getWest()]);
        pts.push([b.getNorth(), b.getEast()]);
      }
    });
    return pts;
  }

  // ── Fullscreen toggle helper (shared by Tier-2 + cross-post maps) ──
  // `mapInstance` = Leaflet map, `wrapEl` = the container that gets the
  // .map-fullscreen class, `btnEl` = the toggle button element.
  // Returns a cleanup function that removes the ESC listener.
  function toggleMapFullscreen(mapInstance, wrapEl, btnEl) {
    if (!wrapEl || !mapInstance) return function () {};
    var entering = !wrapEl.classList.contains('map-fullscreen');
    wrapEl.classList.toggle('map-fullscreen', entering);
    if (btnEl) {
      btnEl.textContent = entering ? '\u2716' : '\u26F6';
      btnEl.title = entering ? 'Exit fullscreen' : 'Fullscreen';
      btnEl.setAttribute('aria-label', entering ? 'Exit fullscreen' : 'Fullscreen');
    }
    // Prevent body scroll while fullscreen.
    document.body.style.overflow = entering ? 'hidden' : '';
    // Let the browser reflow, then tell Leaflet to recalculate.
    setTimeout(function () { mapInstance.invalidateSize(); }, 60);
    return function () {}; // placeholder; ESC wired once below
  }

  // One-time global ESC listener (handles whichever map is currently fullscreen).
  var _fsEscBound = false;
  function ensureFullscreenEsc() {
    if (_fsEscBound) return;
    _fsEscBound = true;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var active = document.querySelector('.map-fullscreen');
      if (!active) return;
      var btn = active.querySelector('.map-fs-btn');
      if (btn) btn.click();
    });
  }

  // Add a fullscreen button to a Leaflet map container. `mapEl` is the
  // Leaflet container div, `wrapEl` is the parent that receives .map-fullscreen,
  // `mapInstance` is the Leaflet map object.
  function addFullscreenBtn(mapEl, wrapEl, mapInstance) {
    if (!mapEl || !wrapEl || !mapInstance) return;
    // Avoid duplicates.
    if (mapEl.querySelector('.map-fs-btn')) return;
    var btn = document.createElement('button');
    btn.className = 'map-fs-btn';
    btn.type = 'button';
    btn.textContent = '\u26F6';
    btn.title = 'Fullscreen';
    btn.setAttribute('aria-label', 'Fullscreen');
    mapEl.style.position = 'relative'; // ensure the button is positioned inside
    mapEl.appendChild(btn);
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMapFullscreen(mapInstance, wrapEl, btn);
    });
    ensureFullscreenEsc();
  }

  // Create the Leaflet map once, on the first reveal (Leaflet needs a sized,
  // visible container). Returns true if a usable map instance exists.
  function ensureT2Map() {
    if (t2map.instance) return true;
    if (typeof L === 'undefined' || !L.map) return false; // Leaflet missing
    var el = document.getElementById('t2map');
    if (!el) return false;
    var map = L.map(el, { scrollWheelZoom: true, attributionControl: true })
      .setView([40.9, -77.6], 7); // PA center fallback before data binds
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    t2map.instance = map;
    t2map.layers = {
      // WIN-area boundaries sit UNDER the markers so pins stay clickable.
      winArea: L.layerGroup().addTo(map),
      animal: L.layerGroup().addTo(map),
      rehab: L.layerGroup().addTo(map),
      // === VOLUNTEER MARKERS START (layer) ===
      volunteer: L.layerGroup().addTo(map)
      // === VOLUNTEER MARKERS END (layer) ===
    };
    // Fullscreen toggle button (top-right of the map).
    var t2body = document.getElementById('t2map-body');
    addFullscreenBtn(el, t2body, map);
    return true;
  }

  // Apply the latest payload to the (already-created) map: clear old markers,
  // plot animal + rehabbers + volunteers, then fit bounds to everything.
  function paintT2Map(payload) {
    if (!t2map.instance || !payload) return;
    var L_ = L;
    t2map.layers.animal.clearLayers();
    t2map.layers.rehab.clearLayers();
    // === VOLUNTEER MARKERS START (clear) ===
    if (t2map.layers.volunteer) t2map.layers.volunteer.clearLayers();
    // === VOLUNTEER MARKERS END (clear) ===

    var bounds = [];

    // ── WIN-area boundaries (drawn first, under the markers) ──
    // The overlay needs the county GeoJSON (state.geojson). It is normally
    // loaded at init and again lazily in renderTier2Map, but the map may be
    // painted (e.g. on the Show-map toggle) before that load has resolved. If
    // the payload names WIN areas but the GeoJSON is not in yet, load it and
    // re-paint so the boundaries appear instead of being silently skipped.
    if (payload.winAreas && payload.winAreas.length && !state.geojson) {
      loadMap().then(function () {
        if (t2map.open && t2map.instance && t2map.pending === payload) {
          paintT2Map(payload);
        }
      });
    }
    var areaPts = drawWinAreaBoundaries(payload.winAreas);
    if (areaPts.length) bounds = bounds.concat(areaPts);

    // ── Animal location (most prominent) ──
    var a = payload.animal;
    if (a && isFinite(a.lat) && isFinite(a.lon)) {
      L_.marker([a.lat, a.lon], {
        icon: t2DivIcon('t2-pin-animal', 14),
        zIndexOffset: 1000,
        title: 'Animal location'
      }).bindPopup('<strong>Animal location</strong><br>' +
          escapeHtml(a.label || 'Entered address'))
        .addTo(t2map.layers.animal);
      bounds.push([a.lat, a.lon]);
    }

    // ── Rehabbers (public coords) ──
    (payload.rehabbers || []).forEach(function (r) {
      if (!r || !isFinite(r.lat) || !isFinite(r.lon)) return; // skip silently
      // Distance/time line: prefer REAL ORS driving numbers (drive_distance_mi +
      // duration_min, supplied by enhanceRehabDrivingDistances). Fall back to the
      // straight-line distance_mi + the same 40 mph estimate volunteers use.
      var rDist = (typeof r.drive_distance_mi === 'number' && isFinite(r.drive_distance_mi))
        ? r.drive_distance_mi : r.distance_mi;
      var rMin = (typeof r.duration_min === 'number' && isFinite(r.duration_min))
        ? r.duration_min : null;
      var distLine = t2DistTimeLine(rDist, rMin);
      var distHtml = distLine ? ('<br>' + escapeHtml(distLine)) : '';
      var phone = r.phone ? ('<br>' + escapeHtml(r.phone)) : '';
      var county = r.county ? ('<br>' + escapeHtml(r.county) + ' County') : '';
      L_.marker([r.lat, r.lon], {
        icon: t2DivIcon('t2-pin-rehab', 16),
        title: r.rehab_name || 'Rehabber'
      }).bindPopup('<strong>' + escapeHtml(r.rehab_name || 'Rehabber') + '</strong>' +
          distHtml + county + phone)
        .addTo(t2map.layers.rehab);
      bounds.push([r.lat, r.lon]);
    });

    // === VOLUNTEER MARKERS START (markers) ===
    // Volunteers are plotted at their ~1-MILE JITTERED coord (the exact home
    // nudged a fixed ~1 mi in a deterministic per-volunteer direction by the
    // Worker) when available, else at their HOME-COUNTY CENTROID fallback. The
    // Worker never sends an exact volunteer coordinate (PII rule). County-centroid
    // fallback pins share one point per county, so those are spread with a small
    // spiral offset; jittered pins keep their own point. Gated by the flag above.
    // Unavailable volunteers get a dimmed pin (t2-pin-unavail class).
    var t2VolMarkers = []; // {marker, available} for toggle filtering
    if (SHOW_VOLUNTEER_MARKERS) {
      var perCounty = {};
      (payload.volunteers || []).forEach(function (v) {
        if (!v || !isFinite(v.lat) || !isFinite(v.lon)) return; // skip silently
        // Stacked-pin spiral offset applies ONLY to county-centroid FALLBACK
        // pins (every volunteer in a county shares the one centroid point, so
        // they would fully overlap). Jittered pins (v.exact) already sit at their
        // own per-volunteer point and must NOT be nudged further.
        var lat = v.lat;
        var lon = v.lon;
        if (!v.exact) {
          var key = v.county || (v.lat + ',' + v.lon);
          var n = perCounty[key] || 0;
          perCounty[key] = n + 1;
          // Tiny deterministic spiral offset (~0.01-0.03°) for stacked pins.
          var ang = n * 2.399; // golden-angle radians
          var rad = n === 0 ? 0 : 0.012 + 0.006 * n;
          lat = v.lat + rad * Math.cos(ang);
          lon = v.lon + rad * Math.sin(ang);
        }
        // Popup content: ROLES · "X miles / Y min" · COUNTY. The distance/time
        // line uses the REAL ORS driving time (duration_min) when present,
        // otherwise the shared 40 mph estimate (marked "(est.)").
        var lines = [];
        if (v.roles && v.roles.length) {
          lines.push(escapeHtml(v.roles.join(', ')));
        }
        var vMin = (typeof v.duration_min === 'number' && isFinite(v.duration_min))
          ? v.duration_min : null;
        // Distance shown in the popup must MATCH the list: prefer the REAL ORS
        // driving distance (v.driving_miles) the list displays, falling back to
        // the straight-line distance only when no driving annotation was
        // surfaced. Never recalculate from the centroid pin position.
        var vDist = (typeof v.driving_miles === 'number' && isFinite(v.driving_miles))
          ? v.driving_miles : v.distance_mi;
        var vLine = t2DistTimeLine(vDist, vMin);
        if (vLine) lines.push(escapeHtml(vLine));
        if (v.county) {
          lines.push('County: ' + escapeHtml(v.county));
        }
        if (!v.available) lines.push('<em style="color:#999;">Unavailable</em>');
        var pinCls = t2VolPinClass(v.roles) + (v.available ? '' : ' t2-pin-unavail');
        var marker = L_.marker([lat, lon], {
          icon: t2DivIcon(pinCls, 14),
          title: 'Volunteer' + (v.available ? '' : ' (unavailable)')
        }).bindPopup(lines.length ? lines.join('<br>') : '');
        marker.addTo(t2map.layers.volunteer);
        t2VolMarkers.push({ marker: marker, available: !!v.available });
        bounds.push([lat, lon]);
      });
    }
    // === VOLUNTEER MARKERS END (markers) ===

    if (bounds.length === 1) {
      t2map.instance.setView(bounds[0], 12);
    } else if (bounds.length > 1) {
      t2map.instance.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
    }
    // Container may have just become visible — recompute tile size.
    t2map.instance.invalidateSize();

    // ── Dynamic legend with counts + availability toggle ──
    paintT2MapLegend(payload, t2VolMarkers);
  }

  // ── Dynamic legend for the Tier-2 map ──────────────────────────────
  // Builds a compact legend panel showing pin types with counts, area
  // highlighting, and an "Include unavailable" toggle that hides/shows
  // unavailable volunteer markers without re-fetching data.
  function paintT2MapLegend(payload, volMarkers) {
    var panel = document.getElementById('t2map-legend-panel');
    if (!panel) return;

    var vols = payload.volunteers || [];
    // Count by role + availability
    var counts = { ct: 0, ctAvail: 0, rvsct: 0, rvsctAvail: 0, courier: 0, courierAvail: 0 };
    vols.forEach(function (v) {
      if (!v) return;
      var cls = t2VolPinClass(v.roles);
      var avail = !!v.available;
      if (cls === 't2-pin-vol-rvsct') { counts.rvsct++; if (avail) counts.rvsctAvail++; }
      else if (cls === 't2-pin-vol-ct') { counts.ct++; if (avail) counts.ctAvail++; }
      else { counts.courier++; if (avail) counts.courierAvail++; }
    });
    var rehabCount = (payload.rehabbers || []).length;
    var hasAreas = !!(payload.winAreas && payload.winAreas.length);

    var html = '<div class="mlp-title">Legend — showing qualified volunteers</div>';
    html += '<div class="mlp-items">';
    html += '<span class="mlp-item"><span class="mlp-dot mlp-animal"></span>Animal location</span>';
    if (rehabCount > 0) {
      html += '<span class="mlp-item"><span class="mlp-dot mlp-rehab"></span>Rehabbers <span class="mlp-count">(' + rehabCount + ')</span></span>';
    }
    if (SHOW_VOLUNTEER_MARKERS) {
      if (counts.rvsct > 0) {
        html += '<span class="mlp-item"><span class="mlp-dot mlp-vol-rvsct"></span>RVS C&amp;T <span class="mlp-count">' +
          counts.rvsct + ' (' + counts.rvsctAvail + ' avail)</span></span>';
      }
      if (counts.ct > 0) {
        html += '<span class="mlp-item"><span class="mlp-dot mlp-vol-ct"></span>C&amp;T <span class="mlp-count">' +
          counts.ct + ' (' + counts.ctAvail + ' avail)</span></span>';
      }
      if (counts.courier > 0) {
        html += '<span class="mlp-item"><span class="mlp-dot mlp-vol-courier"></span>Courier <span class="mlp-count">' +
          counts.courier + ' (' + counts.courierAvail + ' avail)</span></span>';
      }
    }
    if (hasAreas) {
      html += '<span class="mlp-item"><span class="mlp-dot mlp-area-dispatch"></span>WIN service area</span>';
    }
    html += '</div>';

    // Availability toggle (only when there are unavailable volunteers)
    var hasUnavail = vols.some(function (v) { return v && !v.available; });
    if (SHOW_VOLUNTEER_MARKERS && hasUnavail) {
      html += '<hr class="mlp-sep">';
      html += '<label class="mlp-toggle"><input type="checkbox" id="t2-avail-toggle" checked> Include unavailable</label>';
    }

    panel.innerHTML = html;
    panel.style.display = '';

    // Wire the toggle
    var toggle = document.getElementById('t2-avail-toggle');
    if (toggle && volMarkers) {
      toggle.addEventListener('change', function () {
        var show = toggle.checked;
        volMarkers.forEach(function (entry) {
          if (!entry.available) {
            if (show) {
              if (!t2map.layers.volunteer.hasLayer(entry.marker)) {
                entry.marker.addTo(t2map.layers.volunteer);
              }
            } else {
              t2map.layers.volunteer.removeLayer(entry.marker);
            }
          }
        });
      });
    }
  }

  // Public entry: gather the data shape for the map and either paint now (if
  // open) or stash for the first reveal. Shows a clear 'unavailable' state when
  // the animal has no usable coordinates.
  function renderTier2Map(agg, origin, ctx) {
    var block = document.getElementById('t2map-block');
    var unavailEl = document.getElementById('t2map-unavailable');
    var mapEl = document.getElementById('t2map');
    if (!block) return;
    block.style.display = 'block';

    // === VOLUNTEER MARKERS START (legend visibility) ===
    // Legend is now built dynamically by paintT2MapLegend() — no static toggle needed.
    // === VOLUNTEER MARKERS END (legend visibility) ===

    var hasAnimal = agg && typeof agg.animal_lat === 'number' &&
                    typeof agg.animal_lon === 'number' &&
                    isFinite(agg.animal_lat) && isFinite(agg.animal_lon);

    // Edge case: no usable animal coordinates → show a message, not a broken map.
    if (!hasAnimal) {
      if (mapEl) mapEl.style.display = 'none';
      if (unavailEl) {
        unavailEl.textContent =
          'Map unavailable: the animal location could not be placed on a map ' +
          '(no coordinates for this lookup).';
        unavailEl.style.display = 'flex';
      }
      t2map.pending = null;
      return;
    }
    if (mapEl) mapEl.style.display = '';
    if (unavailEl) unavailEl.style.display = 'none';

    // Rehabbers near the origin (public coords). Reuse the same ranking helper
    // the list uses so map + list agree.
    var rehabPool = (origin && typeof origin.lat === 'number')
      ? nearestRehabbers(origin.lat, origin.lon, 8) : [];

    // === VOLUNTEER MARKERS START (data prep) ===
    // Map the PII-safe out_of_county rows to map points. Rows carry
    // {roles, distance_mi, win_area, county, approx_lat?, approx_lon?,
    // driving_miles?, duration_min?} — never an exact home coord. We PREFER the
    // JITTERED coord (approx_lat/approx_lon: the exact home nudged a fixed ~1 mi
    // in a deterministic per-volunteer direction by the Worker — close to the
    // real location yet never pointing at the actual house) and FALL BACK to the
    // county centroid (from pa_counties geojson) when the row has no jittered
    // coordinate. Rows with neither are skipped silently.
    // driving_miles/duration_min are carried through so the popup shows the SAME
    // distance/time the list does (never recomputed from the pin position).
    //
    // QUALIFIED-ONLY pins (alignment with the list): apply the SAME
    // qualifiesForAnimal predicate renderContextList uses so the map plots the
    // SAME volunteer set as the qualified-only list. No map-side dimming for
    // unavailable volunteers — every pin looks the same.
    //
    // FULL SET (map shows ALL qualified pins): the list may be CAPPED to the
    // nearest few on overflow, but the map must plot EVERY qualified volunteer.
    // Prefer the Worker's full, never-truncated out_of_county_all when present;
    // fall back to out_of_county for older Worker responses that omit it.
    var qualifyFn = (window.WildlifeDecision &&
                     typeof window.WildlifeDecision.qualifiesForAnimal === 'function')
      ? window.WildlifeDecision.qualifiesForAnimal : null;
    var hasBase = ctx && typeof ctx.issue === 'string' && ctx.issue !== '';
    var volunteers = [];
    var volSource = (agg && Array.isArray(agg.out_of_county_all))
      ? agg.out_of_county_all
      : (agg && Array.isArray(agg.out_of_county) ? agg.out_of_county : null);
    if (SHOW_VOLUNTEER_MARKERS && volSource) {
      var volRows = volSource;
      if (qualifyFn && hasBase) {
        volRows = volRows.filter(function (row) {
          var roleList = Array.isArray(row.roles) ? row.roles : [];
          return qualifyFn(roleList, !!ctx.rvs, ctx.issue);
        });
      }
      volRows.forEach(function (row) {
        if (!row) return;
        // Prefer the jittered coord the Worker provides; fall back to the county
        // centroid when it is absent (older Worker / no coord).
        var lat = NaN;
        var lon = NaN;
        var placed = false;
        if (typeof row.approx_lat === 'number' && isFinite(row.approx_lat) &&
            typeof row.approx_lon === 'number' && isFinite(row.approx_lon)) {
          lat = row.approx_lat;
          lon = row.approx_lon;
          placed = true;
        } else if (row.county) {
          var c = state.countyCentroids && state.countyCentroids[row.county];
          if (c && isFinite(c.lat) && isFinite(c.lon)) {
            lat = c.lat;
            lon = c.lon;
            placed = true;
          }
        }
        if (!placed) return; // no usable location — skip silently
        volunteers.push({
          lat: lat,
          lon: lon,
          // True when the pin sits on the per-volunteer JITTERED coord (so the
          // stacked-pin spiral offset below is NOT applied — jittered coords are
          // already distinct per volunteer, and offsetting would only add noise).
          exact: !!(typeof row.approx_lat === 'number' && isFinite(row.approx_lat)),
          county: row.county,
          roles: Array.isArray(row.roles) ? row.roles : [],
          distance_mi: (typeof row.distance_mi === 'number') ? row.distance_mi : NaN,
          // Real ORS driving distance (display-only annotation the list shows).
          // Carried through so the popup shows the SAME "mi driving" number as
          // the list instead of recalculating/using the straight-line metric.
          driving_miles: (typeof row.driving_miles === 'number') ? row.driving_miles : NaN,
          duration_min: (typeof row.duration_min === 'number') ? row.duration_min : null,
          // Availability: carried through for dimmed-pin treatment + legend counts.
          available: row.available !== false && !isUnavailNote(
            row.availability_note ? String(row.availability_note).trim() : '')
        });
      });
    }
    // === VOLUNTEER MARKERS END (data prep) ===

    var label = (origin && origin.source === 'animal' && state.selectedAnimalCoord &&
                 state.selectedAnimalCoord.label)
      ? state.selectedAnimalCoord.label : '';

    // WIN areas affected by this animal location (Worker returns these as area
    // names/numbers). Drawn as county-based shaded boundaries on the map.
    var winAreas = (agg && Array.isArray(agg.win_areas)) ? agg.win_areas.slice() : [];

    var payload = {
      animal: { lat: agg.animal_lat, lon: agg.animal_lon, label: label },
      rehabbers: rehabPool,
      volunteers: volunteers,
      winAreas: winAreas
    };

    t2map.pending = payload;
    // The WIN-area overlay needs the county GeoJSON. The SVG choropleth panel
    // loads it lazily, so it may not be present yet when the Tier-2 map paints.
    // Ensure it's loaded, then re-paint if the map is open so boundaries appear.
    if (winAreas.length && !state.geojson) {
      loadMap().then(function () {
        if (t2map.open && t2map.instance) paintT2Map(payload);
      });
    }
    if (t2map.open && ensureT2Map()) {
      paintT2Map(payload);
    }

    // ── REAL driving distance + time for the map's rehabber popups ──────
    // Reuse the SAME worker path the list uses (enhanceRehabDrivingDistances →
    // ?mode=rehabber_distances). It mutates each rehabPool row in place with the
    // real ORS drive_distance_mi + duration_min, then hands back the ranked
    // pool. We swap that into the payload (so the markers stay in the SAME
    // count/order space) and re-paint when the map is open. On ANY failure the
    // enhancer is a no-op and the straight-line + 40 mph estimate already shown
    // stays as-is. No second routing path / external API is introduced.
    if (rehabPool.length && origin && typeof origin.lat === 'number') {
      enhanceRehabDrivingDistances(origin, rehabPool, rehabPool.length, function (ranked) {
        payload.rehabbers = ranked;
        t2map.pending = payload;
        if (t2map.open && t2map.instance) paintT2Map(payload);
      });
    }
  }

  // Wire the Show/Hide toggle once. Expanding lazy-inits the map and paints any
  // pending payload; Leaflet needs the container visible + sized first.
  function wireT2MapToggle() {
    var btn = document.getElementById('t2map-toggle');
    var body = document.getElementById('t2map-body');
    var label = btn ? btn.querySelector('.t2map-toggle-label') : null;
    if (!btn || !body || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      var willOpen = body.hidden;
      body.hidden = !willOpen;
      btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      if (label) label.textContent = willOpen ? 'Hide map' : 'Show map';
      t2map.open = willOpen;
      if (willOpen) {
        if (ensureT2Map()) {
          if (t2map.pending) paintT2Map(t2map.pending);
          else t2map.instance.invalidateSize();
        }
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════
  //  LIVE DMA (Disease Management Area) CHECK — Tier-2 only
  //  Queries the PA Game Commission public ArcGIS REST layer (CWD Disease
  //  Management Areas) for the animal coordinate. Public endpoint, no auth.
  //  A non-empty `features` array means the point is INSIDE a DMA → red
  //  warning banner; otherwise a green "not within a DMA" note. Any network
  //  / parse failure fails SILENTLY (the banner is hidden) so it never blocks
  //  the rest of the Tier-2 result.
  // ════════════════════════════════════════════════════════════════════
  var DMA_QUERY_URL = 'https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer/300/query';

  function setDmaStatus(cls, html) {
    var el = $('#dma-status');
    if (!el) return;
    if (!cls) { el.style.display = 'none'; el.innerHTML = ''; el.className = 'dma-status'; return; }
    el.className = 'dma-status ' + cls;
    el.innerHTML = html;
    el.style.display = 'block';
  }

  function checkDmaForLocation(agg) {
    var el = $('#dma-status');
    if (!el) return;

    var hasCoords = agg && typeof agg.animal_lat === 'number' &&
                    typeof agg.animal_lon === 'number' &&
                    isFinite(agg.animal_lat) && isFinite(agg.animal_lon);
    if (!hasCoords) { setDmaStatus(null); return; }
    if (typeof fetch !== 'function') { setDmaStatus(null); return; }

    var token = ++dmaCheckToken;
    setDmaStatus('dma-checking', 'Checking Disease Management Area status…');

    var url = DMA_QUERY_URL +
      '?geometry=' + encodeURIComponent(agg.animal_lon + ',' + agg.animal_lat) +
      '&geometryType=esriGeometryPoint' +
      '&inSR=4326' +
      '&spatialRel=esriSpatialRelIntersects' +
      '&where=' + encodeURIComponent("dma_status='A'") +
      '&outFields=' + encodeURIComponent('dma_name,dma,dma_status,start_date,end_date,area_sqmi') +
      '&returnGeometry=false' +
      '&f=json';

    fetch(url).then(function (resp) {
      if (!resp.ok) throw new Error('DMA query HTTP ' + resp.status);
      return resp.json();
    }).then(function (data) {
      if (token !== dmaCheckToken) return; // a newer lookup superseded this one
      var features = (data && Array.isArray(data.features)) ? data.features : [];
      if (features.length) {
        var attrs = (features[0] && features[0].attributes) || {};
        var dmaName = attrs.dma_name || attrs.dma || '';
        dmaName = String(dmaName).trim();
        var nameTxt = dmaName ? (escapeHtml(dmaName) + ' ') : '';
        setDmaStatus('dma-warn',
          '<strong>Warning:</strong> This location is within ' + nameTxt +
          '(active Disease Management Area)');
      } else {
        setDmaStatus('dma-clear',
          'This location is not within an active Disease Management Area.');
      }
    }).catch(function () {
      if (token !== dmaCheckToken) return;
      // Fail silently: hide the banner rather than show a scary error. The DMA
      // check is advisory and must never block the rest of the Tier-2 result.
      setDmaStatus(null);
    });
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

    // County breakdown: per-role, inside each role card's .sub element so each
    // box shows only the counties relevant to THAT role (mirrors Tier-1 layout).
    // The standalone #agg-county-breakdown div is kept in the HTML for backward
    // compatibility but is always hidden — the per-role subs supersede it.
    var countyBreakdownEl = $('#agg-county-breakdown');
    if (countyBreakdownEl) {
      countyBreakdownEl.textContent = '';
      countyBreakdownEl.style.display = 'none';
    }
    var oocArr = (agg && Array.isArray(agg.out_of_county)) ? agg.out_of_county : [];
    var countyByRole = (agg && agg.county_by_role && typeof agg.county_by_role === 'object') ? agg.county_by_role : null;
    ['C&T', 'RVS C&T', 'COURIER'].forEach(function (bucket) {
      var card = document.querySelector('.cap-card[data-bucket="' + bucket + '"]');
      if (!card) return;
      var subEl = $('.sub', card);
      if (!subEl) return;
      var roleCountyCounts;
      if (countyByRole && countyByRole[bucket] && typeof countyByRole[bucket] === 'object') {
        // Use county_by_role from Worker — counts ALL in-radius volunteers per role,
        // regardless of qualification. Fixes breakdown when ooc is qualified-only.
        roleCountyCounts = countyByRole[bucket];
      } else {
        // Fallback: derive from ooc rows (backward compat with older Worker responses).
        roleCountyCounts = {};
        oocArr.forEach(function (row) {
          if (!row) return;
          var roleList = Array.isArray(row.roles) ? row.roles : [];
          if (roleList.indexOf(bucket) === -1) return;
          if (row.county) {
            var c = String(row.county).trim();
            if (c) roleCountyCounts[c] = (roleCountyCounts[c] || 0) + 1;
          }
        });
      }
      var countyKeys = Object.keys(roleCountyCounts).sort();
      subEl.textContent = countyKeys.length > 0
        ? countyKeys.map(function (c) { return c + '\u00a0' + roleCountyCounts[c]; }).join(', ')
        : '';
    });

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
        // NON-CONNECTEAM NOTICE: inform the dispatcher that some qualified
        // volunteers are not on the Connecteam app and must be reached by
        // text/phone instead. Blue/teal 'info' tone — NOT a warning.
        var nonCtCount = qualifiedRows.filter(function (r) {
          return r.connecteam_user === false;
        }).length;
        if (nonCtCount > 0) {
          actions.push(actionLine('info', 'i', escapeHtml(fmt(T2.nonConnecteamNotice, { count: nonCtCount }))));
        }
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
    renderTier2Map(agg, pickRehabberOrigin(agg, ctx), ctx);
    checkDmaForLocation(agg);
    // Update DMA map link with animal coordinates for find parameter
    var dmaLink = document.getElementById('dma-map-link');
    if (dmaLink && agg.animal_lat && agg.animal_lon) {
      dmaLink.href = 'https://pagame.maps.arcgis.com/apps/webappviewer/index.html?id=c9c7c8912356450fa77fc34d30b131fb&marker=' + agg.animal_lon + ',' + agg.animal_lat + '&level=12&showLayers=NEW_PUBLIC_718';
    }
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
  //
  // The autocomplete logic is factored into a reusable createAutocomplete()
  // factory so the same dropdown behavior can be attached to BOTH the Tier-2
  // Animal Address input AND the cross-post address input.

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

  // ─── Reusable autocomplete factory ─────────────────────────────────
  // createAutocomplete(opts) returns an object with setup() and close() methods.
  // opts:
  //   getEls:        function returning { input, list } DOM elements
  //   onSelect:      function(item) called when a suggestion is picked
  //   onInputChange: function() called when the input text diverges from the
  //                  last selected suggestion (i.e. user is editing/typing)
  //   idPrefix:      string prefix for option ids (default 'ac-opt')
  function createAutocomplete(opts) {
    var inst = {
      items: [],
      active: -1,
      timer: null,
      seq: 0,
      lastQuery: ''
    };
    var getEls = opts.getEls;
    var onSelect = opts.onSelect || function () {};
    var onInputChange = opts.onInputChange || function () {};
    var idPrefix = opts.idPrefix || 'ac-opt';

    function close() {
      var els = getEls();
      if (els.list) { els.list.hidden = true; els.list.innerHTML = ''; }
      if (els.input) els.input.setAttribute('aria-expanded', 'false');
      if (els.input) els.input.removeAttribute('aria-activedescendant');
      inst.items = [];
      inst.active = -1;
    }

    function render() {
      var els = getEls();
      if (!els.list) return;
      if (!inst.items.length) { close(); return; }
      var html = '';
      for (var i = 0; i < inst.items.length; i++) {
        var sel = (i === inst.active);
        html += '<li id="' + idPrefix + '-' + i + '" class="ac-item' + (sel ? ' ac-active' : '') +
                '" role="option" data-idx="' + i + '"' +
                (sel ? ' aria-selected="true"' : '') + '>' +
                escapeHtml(inst.items[i].label) + '</li>';
      }
      els.list.innerHTML = html;
      els.list.hidden = false;
      if (els.input) {
        els.input.setAttribute('aria-expanded', 'true');
        if (inst.active >= 0) {
          els.input.setAttribute('aria-activedescendant', idPrefix + '-' + inst.active);
        } else {
          els.input.removeAttribute('aria-activedescendant');
        }
      }
    }

    function select(idx) {
      if (idx < 0 || idx >= inst.items.length) return;
      var els = getEls();
      var item = inst.items[idx];
      var label = item.label;
      if (els.input) els.input.value = label;
      inst.lastQuery = label;
      onSelect(item);
      close();
      if (els.input) els.input.focus();
    }

    function doFetch(query) {
      var mySeq = ++inst.seq;
      var url = WORKER_URL +
        '?autocomplete=' + encodeURIComponent(query) +
        '&limit=' + encodeURIComponent(AC_LIMIT);
      fetch(url, { cache: 'no-store' })
        .then(function (resp) {
          if (!resp.ok) return { suggestions: [] };
          return resp.json();
        })
        .then(function (data) {
          if (mySeq !== inst.seq) return;
          var list = (data && Array.isArray(data.suggestions)) ? data.suggestions : [];
          inst.items = list.filter(function (it) {
            return it && typeof it.label === 'string' && it.label.trim() !== '';
          }).slice(0, AC_LIMIT);
          inst.active = -1;
          render();
        })
        .catch(function () {
          if (mySeq !== inst.seq) return;
          close();
        });
    }

    function onInput(immediate) {
      var els = getEls();
      var q = (els.input && els.input.value ? els.input.value : '').trim();
      if (inst.timer) { clearTimeout(inst.timer); inst.timer = null; }
      if (q === inst.lastQuery) { return; }
      inst.lastQuery = '';
      onInputChange();
      if (q.length < AC_MIN_CHARS) { close(); return; }
      var pin = detectPinDrop(q);
      if (pin) {
        inst.seq++;
        if (inst.timer) { clearTimeout(inst.timer); inst.timer = null; }
        inst.items = [{
          label: fmt(MSG.autocomplete.pinDrop, { lat: pin.lat, lon: pin.lon }),
          lat: pin.lat,
          lon: pin.lon
        }];
        inst.active = -1;
        render();
        return;
      }
      if (immediate === true) { doFetch(q); return; }
      inst.timer = setTimeout(function () { doFetch(q); }, AC_DEBOUNCE_MS);
    }

    function onPaste() {
      setTimeout(function () { onInput(true); }, 0);
    }

    function onKeydown(e) {
      var open = inst.items.length > 0;
      if (e.key === 'ArrowDown') {
        if (!open) return;
        e.preventDefault();
        inst.active = (inst.active + 1) % inst.items.length;
        render();
      } else if (e.key === 'ArrowUp') {
        if (!open) return;
        e.preventDefault();
        inst.active = (inst.active - 1 + inst.items.length) % inst.items.length;
        render();
      } else if (e.key === 'Enter') {
        if (open && inst.active >= 0) {
          e.preventDefault();
          select(inst.active);
        }
      } else if (e.key === 'Escape') {
        if (open) { e.preventDefault(); close(); }
      }
    }

    function setup() {
      var els = getEls();
      if (!els.input || !els.list) return;
      els.input.addEventListener('input', function () { onInput(false); });
      els.input.addEventListener('paste', onPaste);
      els.input.addEventListener('keydown', onKeydown);
      els.list.addEventListener('mousedown', function (e) {
        var li = e.target;
        while (li && li !== els.list && !li.getAttribute) li = li.parentNode;
        while (li && li !== els.list && li.getAttribute && li.getAttribute('data-idx') === null) {
          li = li.parentNode;
        }
        if (li && li.getAttribute && li.getAttribute('data-idx') !== null) {
          e.preventDefault();
          select(Number(li.getAttribute('data-idx')));
        }
      });
      els.input.addEventListener('blur', function () {
        setTimeout(close, 120);
      });
    }

    return { setup: setup, close: close, inst: inst };
  }

  // ─── Animal Address autocomplete instance ──────────────────────────
  function acEls() {
    return { input: $('#animal-address'), list: $('#address-suggestions') };
  }

  var animalAc = createAutocomplete({
    getEls: acEls,
    idPrefix: 'ac-opt',
    onInputChange: function () {
      // The text diverged from the selected suggestion's label: any captured
      // coord is now stale (it belongs to a DIFFERENT address), so drop it.
      state.selectedAnimalCoord = null;
    },
    onSelect: function (item) {
      // Photon ALREADY resolved this suggestion to a coordinate (autocomplete.js
      // populates lat/lon). Capture it so the submit can send animal_lat/animal_lon
      // DIRECTLY and skip the weak Census exact-match geocode. Keyed to the exact
      // label so acOnInput can detect a later edit and invalidate it.
      if (typeof item.lat === 'number' && typeof item.lon === 'number' &&
          isFinite(item.lat) && isFinite(item.lon)) {
        state.selectedAnimalCoord = { lat: item.lat, lon: item.lon, label: item.label };
      } else {
        state.selectedAnimalCoord = null;
      }
    }
  });

  function acClose() { animalAc.close(); }

  function setupAutocomplete() {
    animalAc.setup();
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

  // Darken a #rrggbb hex color by `amount` (0..1) toward black. Used to derive
  // a strong, high-contrast boundary stroke from each area's fill so the lines
  // between WIN areas stand out clearly on the Tier-2 map. Falls back to a
  // neutral dark grey if the input isn't a parseable 6-digit hex.
  function darkenColor(hex, amount) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
    if (!m) return '#37474f';
    var f = (amount === undefined || amount === null) ? 0.45 : amount;
    if (f < 0) f = 0;
    if (f > 1) f = 1;
    var n = parseInt(m[1], 16);
    var r = Math.round(((n >> 16) & 0xff) * (1 - f));
    var g = Math.round(((n >> 8) & 0xff) * (1 - f));
    var b = Math.round((n & 0xff) * (1 - f));
    function h2(v) { var s = v.toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + h2(r) + h2(g) + h2(b);
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
    // Cache the raw GeoJSON so the Tier-2 Leaflet map can draw WIN-area county
    // boundaries from the SAME source without re-fetching.
    state.geojson = geojson;
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

  // loadPolicy(): fetch the per-county dispatch policy overlay (policy.json).
  // Tries the Worker KV endpoint first (live edits from the policy editor);
  // falls back to the committed static file when the Worker is unavailable.
  // Stored as state.policy = { counties: {...} } (or null when missing/
  // malformed). The recommendation flow looks up the selected county in this
  // map and passes that county's block to recommend() as the DOWNGRADE-ONLY
  // post-step. Missing/malformed policy → null → no overlay → today's
  // count-based behavior is preserved.
  function loadPolicy() {
    return fetch(WORKER_URL + '?mode=policy', { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (json) { state.policy = json; })
      .catch(function () {
        // Worker unavailable — fall back to static file.
        return fetch('data/policy.json', { cache: 'no-store' })
          .then(function (resp) {
            if (resp.status === 404) { state.policy = null; return null; }
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.text().then(function (txt) {
              try { return JSON.parse(txt); }
              catch (e) { return null; }
            });
          })
          .then(function (json) { state.policy = json; })
          .catch(function () {
            state.policy = null;
          });
      });
  }

  // policyForCounty(): return the policy block for a county name, or null. The
  // map lives under policy.json's `counties` key.
  function policyForCounty(countyName) {
    var pol = state.policy;
    if (!pol || !countyName) return null;
    var counties = pol.counties || pol;
    if (!counties || typeof counties !== 'object') return null;
    var block = counties[countyName];
    return (block && typeof block === 'object') ? block : null;
  }

  // loadFacilities(): fetch facilities.json — the SOURCE OF TRUTH for referral
  // phone numbers — plus facility_name_map.json (alias -> canonical name). Both
  // are optional; on any miss the index is left null and the referral display
  // falls back to the policy.json phone verbatim. Builds state.facilityPhoneIndex
  // once both are resolved so resolveReferralPhone() can prefer facilities phones
  // over the (spreadsheet-sourced) policy phones.
  function loadFacilities() {
    function getJson(path) {
      return fetch(path, { cache: 'no-store' })
        .then(function (resp) {
          if (!resp || !resp.ok) return null;
          return resp.text().then(function (txt) {
            try { return JSON.parse(txt); } catch (e) { return null; }
          });
        })
        .catch(function () { return null; });
    }
    return Promise.all([
      getJson('data/facilities.json'),
      getJson('data/facility_name_map.json')
    ]).then(function (res) {
      state.facilities = res[0];
      state.facilityNameMap = res[1];
      try {
        state.facilityPhoneIndex = window.WildlifeDecision.buildFacilityPhoneIndex(
          state.facilities, state.facilityNameMap);
      } catch (e) {
        state.facilityPhoneIndex = null;
      }
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
      var county = e.target.value;
      renderCardsForCounty(county);
      // Approach B: the new county governs the recommendation cards shown from
      // the PREVIOUS "Get Recommendation" run, so flag the cards as stale (dim +
      // banner). Re-clicking "Get Recommendation" recomputes and clears them.
      markCountyChangeStale();
      // The Tier 1 qualified-volunteer list, by contrast, refreshes
      // AUTOMATICALLY — no "Get Recommendation" click needed. It always reflects
      // the CURRENT county + CURRENT animal inputs (RVS + Issue/Transport), so a
      // county change re-fetches against the new county using the current input
      // state (the t1VolToken stale guard inside loadTier1Volunteers ignores
      // out-of-order responses on rapid changes). Clearing the county hides the
      // list (refreshTier1Volunteers bumps the token + hides it). Unavailable
      // qualified volunteers still render, dimmed (availability preserved).
      refreshTier1Volunteers();
    });
    $('#recommend-btn').addEventListener('click', onRecommendClick);

    // Advanced Search toggle — expands/collapses the options panel body.
    var advBtn = document.getElementById('advanced-search-btn');
    if (advBtn) {
      advBtn.addEventListener('click', function () {
        var body = document.getElementById('advanced-search-body');
        if (!body) return;
        var open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        advBtn.classList.toggle('open', !open);
      });
    }

    // The RVS toggle and the Issue (Capture/Transport) radios feed
    // readAnimalBaseInfo(), which drives WHO qualifies. Two effects on change:
    //   1) Recommendation/address surfaces use approach B — flag stale (dim +
    //      require a re-click), never auto-recompute (markResultsStale).
    //   2) The Tier 1 By-County volunteer list refreshes IMMEDIATELY so it
    //      always reflects the current input state (refreshTier1Volunteers).
    $$('input[name="rvs"], input[name="issue"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        markResultsStale();
        refreshTier1Volunteers();
      });
    });
    // The Animal Type dropdown feeds county species_scope enforcement (the
    // In-County recommendation can refer_out a species the county doesn't
    // dispatch). It does not change WHO qualifies (role-based), so it only flags
    // an existing recommendation stale — no volunteer-list refresh needed.
    var animalTypeSel = $('#animal-type');
    if (animalTypeSel) {
      animalTypeSel.addEventListener('change', function () {
        // Bats are always RVS — auto-set the toggle
        if (animalTypeSel.value === 'bat') {
          var rvsYes = document.querySelector('input[name="rvs"][value="yes"]');
          if (rvsYes) rvsYes.checked = true;
        }
        markResultsStale();
        refreshTier1Volunteers();
      });
    }

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
    // Tier 1 volunteer-list SCOPE buttons. Two buttons share one #t1-vol-block:
    //   - #t1-vol-toggle-county -> In-County scope (home county === selected)
    //   - #t1-vol-toggle-area   -> WIN Area scope (the full area; original)
    // Clicking a scope opens the block at that scope (and marks the button
    // .is-active); clicking the SAME open scope again collapses it. Switching
    // between scopes re-renders the SAME cached rows (no re-fetch).
    function wireT1VolScopeBtn(btnId, scope) {
      var btn = $('#' + btnId);
      if (!btn) return;
      // Bind exactly once (defensive against init running more than once).
      if (btn.dataset.t1ScopeBound) return;
      btn.dataset.t1ScopeBound = '1';
      btn.addEventListener('click', function () {
        var blockEl = $('#t1-vol-block');
        if (!blockEl) return;
        var alreadyOpen = blockEl.style.display !== 'none' && state.t1VolScope === scope;
        if (alreadyOpen) {
          // Collapse: hide the block and clear both buttons' active state.
          blockEl.style.display = 'none';
          state.t1VolScope = null;
          resetT1VolToggles();
          return;
        }
        // Open (or switch scope): render the cached rows at this scope, show the
        // block, and mark THIS button active (the other inactive).
        renderT1VolScope(scope);
        blockEl.style.display = 'block';
        resetT1VolToggles();
        btn.classList.add('is-active');
        btn.setAttribute('aria-expanded', 'true');
      });
    }
    wireT1VolScopeBtn('t1-vol-toggle-county', 'county');
    wireT1VolScopeBtn('t1-vol-toggle-area', 'area');
    var addrBtn = $('#address-btn');
    if (addrBtn) addrBtn.addEventListener('click', onAddressSubmit);
    var ctxVolToggle = $('#ctx-vol-toggle');
    if (ctxVolToggle) {
      ctxVolToggle.addEventListener('click', function () {
        var contentEl = $('#ctx-content');
        if (!contentEl) return;
        var expanded = contentEl.style.display !== 'none';
        if (expanded) {
          contentEl.style.display = 'none';
          ctxVolToggle.textContent = 'Show qualified volunteers';
          ctxVolToggle.setAttribute('aria-expanded', 'false');
        } else {
          contentEl.style.display = 'block';
          ctxVolToggle.textContent = 'Hide qualified volunteers';
          ctxVolToggle.setAttribute('aria-expanded', 'true');
        }
      });
    }
    wireT2MapToggle();
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
      loadSnapshot(), loadConfig(), loadPolicy(), loadFacilities(), loadCoordinators(), loadRehabbers(), loadCountyWin(), loadMap()
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

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

  var state = {
    snapshot: null,   // parsed county_capacity.json or null
    loadError: false
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

      if (avail <= 1 && total > 0) {
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

  function onRecommendClick() {
    // Stub — Phase 3 will implement.
    console.log('recommend() not yet implemented');
    var out = $('#rec-output');
    out.classList.toggle('show');
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

  function init() {
    populateCounties();
    $('#county').addEventListener('change', function (e) {
      renderCardsForCounty(e.target.value);
    });
    $('#recommend-btn').addEventListener('click', onRecommendClick);

    loadSnapshot().then(function () {
      renderBanner();
      renderCardsForCounty($('#county').value);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

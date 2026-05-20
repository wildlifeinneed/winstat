/* decision.js — Phase 3 decision engine for Wildlife In Need dispatcher.
 * Pure module, no DOM, no fetch. Browser + Node compatible (UMD-lite).
 */
(function (root) {
  'use strict';

  var ACTIONS = {
    connecteam_task: {
      id: 'connecteam_task',
      label: 'Dispatch via Connecteam',
      tone: 'go'
    },
    call_pa_game_comm: {
      id: 'call_pa_game_comm',
      label: 'Call PA Game Commission',
      tone: 'escalate'
    },
    tbd_escalate: {
      id: 'tbd_escalate',
      label: 'No automatic action - escalate to supervisor',
      tone: 'unknown'
    }
  };

  var DEFAULTS = {
    marginal_threshold: 1,
    ct_rvs_capture_min_available: 1,
    ct_any_capture_min_available: 1,
    courier_transport_min_available: 1
  };

  function resolveConfig(rc) {
    var out = {};
    var keys = ['marginal_threshold',
                'ct_rvs_capture_min_available',
                'ct_any_capture_min_available',
                'courier_transport_min_available'];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out[k] = (rc && typeof rc[k] === 'number') ? rc[k] : DEFAULTS[k];
    }
    return out;
  }

  function bucketAvail(capacity, key) {
    var b = capacity && capacity[key];
    if (!b) return 0;
    return (typeof b.available === 'number') ? b.available : 0;
  }

  function bucketTotal(capacity, key) {
    var b = capacity && capacity[key];
    if (!b) return 0;
    return (typeof b.total === 'number') ? b.total : 0;
  }

  function bucketMarginalRoster(capacity, key) {
    var b = capacity && capacity[key];
    if (!b || !Array.isArray(b.marginal_volunteers)) return [];
    // Defensive PII strip: even if a stale county_capacity.json still
    // carries volunteer `name` fields, never let them reach the modal.
    return b.marginal_volunteers.map(function (mv) {
      var out = {};
      if (mv && typeof mv.availability_note !== 'undefined') {
        out.availability_note = mv.availability_note;
      }
      return out;
    });
  }

  function enrichMarginal(rec, capacity, chosenBucket, cfg) {
    var avail = bucketAvail(capacity, chosenBucket);
    var total = bucketTotal(capacity, chosenBucket);
    var isMarginal = (avail <= cfg.marginal_threshold) && (total > 0);
    rec.marginal = isMarginal;
    rec.marginal_volunteers = isMarginal ? bucketMarginalRoster(capacity, chosenBucket) : [];
    if (isMarginal) {
      rec.reasoning.push('Low capacity warning: only ' + avail + ' available; consider calling backup.');
    }
    return rec;
  }

  function recommend(capacity, animalRvs, issue, resolvedConfig) {
    var cfg = resolveConfig(resolvedConfig);
    var rec = {
      action: null,
      target: null,
      marginal: false,
      marginal_volunteers: [],
      reasoning: []
    };

    // A. Missing capacity
    if (!capacity) {
      rec.action = 'call_pa_game_comm';
      rec.reasoning = ['No volunteer data for this county - call PA Game Commission.'];
      return rec;
    }

    var issueNorm = (typeof issue === 'string') ? issue.toLowerCase().trim() : '';

    // E. Unknown issue
    if (issueNorm !== 'capture' && issueNorm !== 'transport') {
      rec.action = 'tbd_escalate';
      rec.reasoning = ['Issue type not recognized - select Capture or Transport.'];
      return rec;
    }

    var ctRvsAvail = bucketAvail(capacity, 'ct_rvs');
    var ctNoRvsAvail = bucketAvail(capacity, 'ct_no_rvs');
    var courierAvail = bucketAvail(capacity, 'courier');
    var ctAnyAvail = ctNoRvsAvail + ctRvsAvail;

    if (issueNorm === 'capture') {
      if (animalRvs === true) {
        // B. Capture + RVS animal
        rec.reasoning.push('Capture + RVS animal -> RVS-capable C&T required.');
        if (ctRvsAvail >= cfg.ct_rvs_capture_min_available) {
          rec.action = 'connecteam_task';
          rec.target = 'ct_rvs';
          rec.reasoning.push('Recommended: dispatch a C&T+RVS volunteer via Connecteam.');
          return enrichMarginal(rec, capacity, 'ct_rvs', cfg);
        }
        rec.action = 'call_pa_game_comm';
        rec.reasoning.push('No RVS-capable C&T volunteers currently available - call PA Game Commission.');
        return rec;
      }
      // C. Capture + non-RVS animal
      rec.reasoning.push('Capture + non-RVS animal -> any C&T volunteer acceptable.');
      if (ctAnyAvail >= cfg.ct_any_capture_min_available) {
        rec.action = 'connecteam_task';
        rec.target = 'ct_any';
        rec.reasoning.push('Recommended: dispatch a C&T volunteer via Connecteam.');
        // Choose actual bucket: prefer ct_no_rvs to save RVS volunteers.
        var chosen = (ctNoRvsAvail > 0) ? 'ct_no_rvs' : 'ct_rvs';
        return enrichMarginal(rec, capacity, chosen, cfg);
      }
      rec.action = 'call_pa_game_comm';
      rec.reasoning.push('No C&T volunteers currently available - call PA Game Commission.');
      return rec;
    }

    // D. Transport (animalRvs ignored for routing)
    rec.reasoning.push('Transport request - courier preferred (animal RVS status not used for routing).');
    if (courierAvail >= cfg.courier_transport_min_available) {
      rec.action = 'connecteam_task';
      rec.target = 'courier';
      rec.reasoning.push('Recommended: dispatch a courier via Connecteam.');
      return enrichMarginal(rec, capacity, 'courier', cfg);
    }
    if (ctAnyAvail >= cfg.ct_any_capture_min_available) {
      rec.action = 'connecteam_task';
      rec.target = 'ct_any';
      rec.reasoning.push('Courier unavailable; falling back to C&T volunteers for transport.');
      var chosenT = (ctNoRvsAvail > 0) ? 'ct_no_rvs' : 'ct_rvs';
      return enrichMarginal(rec, capacity, chosenT, cfg);
    }
    rec.action = 'call_pa_game_comm';
    rec.reasoning.push('No courier or C&T capacity available; call PA Game Commission.');
    return rec;
  }

  var api = { recommend: recommend, ACTIONS: ACTIONS };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WildlifeDecision = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

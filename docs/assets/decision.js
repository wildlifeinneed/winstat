/* decision.js — Phase 3 decision engine for Wildlife In Need dispatcher.
 * Pure module, no DOM, no fetch. Browser + Node compatible (UMD-lite).
 */
(function (root) {
  'use strict';

  // ── Wording + thresholds come from messages.js (single source of truth) ───
  // Browser: window.WildlifeMessages (loaded via <script> before this file).
  // Node tests: require the sibling module. Resolved once at load.
  var WM = (typeof root !== 'undefined' && root.WildlifeMessages)
    ? root.WildlifeMessages
    : ((typeof require !== 'undefined') ? require('./messages.js') : null);
  var MSG = WM.messages;
  var fmt = WM.fmt;
  var T1 = MSG.tier1Actions;

  // Action tones stay in code (they drive CSS classes / behavior); labels are
  // pulled from the config so wording lives in one place.
  var ACTIONS = {
    connecteam_task: {
      id: 'connecteam_task',
      label: T1.actionLabels.connecteam_task,
      tone: 'go'
    },
    call_pa_game_comm: {
      id: 'call_pa_game_comm',
      label: T1.actionLabels.call_pa_game_comm,
      tone: 'escalate'
    },
    tbd_escalate: {
      id: 'tbd_escalate',
      label: T1.actionLabels.tbd_escalate,
      tone: 'unknown'
    }
  };

  var DEFAULTS = MSG.thresholds;

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

  function enrichMarginal(rec, capacity, chosenBucket, cfg, overrideAvail) {
    var avail = (typeof overrideAvail === 'number')
      ? overrideAvail
      : bucketAvail(capacity, chosenBucket);
    var total = bucketTotal(capacity, chosenBucket);
    var isMarginal = (avail <= cfg.marginal_threshold) && (total > 0);
    rec.marginal = isMarginal;
    rec.marginal_volunteers = isMarginal ? bucketMarginalRoster(capacity, chosenBucket) : [];
    if (isMarginal) {
      rec.reasoning.push(fmt(T1.lowCapacityWarning, { count: avail }));
    }
    return rec;
  }

  // ─── Per-volunteer qualification (SINGLE SOURCE OF TRUTH) ─────────────
  // Decide whether a volunteer (by their declared qualifying roles) can respond
  // to THIS animal given its RVS flag + Issue. This is the SAME rule Tier 1's
  // recommend() enforces via its bucket selection, lifted into one named
  // predicate so Tier 1 and Tier 2 can never drift:
  //   RVS animal      -> requires 'RVS C&T'
  //   Capture (non-RVS)-> 'C&T' or 'RVS C&T'
  //   Transport       -> 'C&T' or 'RVS C&T' or 'COURIER'
  // `roles` is an array of canonical role labels (e.g. ['C&T'], ['RVS C&T'],
  // ['COURIER']). Comparison is whitespace/case-insensitive so 'rvs c&t' etc.
  // still match. Unknown issue -> not qualified (mirrors recommend's E-branch).
  function normRole(r) {
    return String(r).replace(/\s+/g, '').toLowerCase();
  }

  function qualifiesForAnimal(roles, animalRvs, issue) {
    var declared = {};
    var arr = Array.isArray(roles) ? roles : (roles ? [roles] : []);
    for (var i = 0; i < arr.length; i++) {
      declared[normRole(arr[i])] = true;
    }
    // RVS C&T implies C&T capability. The aggregate worker emits 'RVS C&T'
    // EXCLUSIVELY for a both-capable volunteer (to keep panel role_counts
    // mutually exclusive like Tier 1's ct_no_rvs/ct_rvs buckets), so the plain
    // 'C&T' token is absent on those rows. For QUALIFICATION (capability), an
    // RVS C&T volunteer is still C&T-capable -- count it as hasCt here. This is
    // role MATCHING only; it does not change the exclusive role emission/counts.
    var hasRvs = !!declared[normRole('RVS C&T')];
    var hasCt = !!declared[normRole('C&T')] || hasRvs;
    var hasCourier = !!declared[normRole('COURIER')];
    var issueNorm = (typeof issue === 'string') ? issue.toLowerCase().trim() : '';

    if (issueNorm !== 'capture' && issueNorm !== 'transport') {
      return false;
    }
    if (issueNorm === 'capture') {
      if (animalRvs === true) {
        // Capture + RVS animal -> RVS-capable C&T required.
        return hasRvs;
      }
      // Capture + non-RVS animal -> any C&T volunteer acceptable.
      return hasCt || hasRvs;
    }
    // Transport -> couriers preferred; C&T volunteers also eligible.
    return hasCt || hasRvs || hasCourier;
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
      rec.reasoning = [T1.missingCapacity];
      return rec;
    }

    var issueNorm = (typeof issue === 'string') ? issue.toLowerCase().trim() : '';

    // E. Unknown issue
    if (issueNorm !== 'capture' && issueNorm !== 'transport') {
      rec.action = 'tbd_escalate';
      rec.reasoning = [T1.unknownIssue];
      return rec;
    }

    var ctRvsAvail = bucketAvail(capacity, 'ct_rvs');
    var ctNoRvsAvail = bucketAvail(capacity, 'ct_no_rvs');
    var courierAvail = bucketAvail(capacity, 'courier');
    var ctAnyAvail = ctNoRvsAvail + ctRvsAvail;

    if (issueNorm === 'capture') {
      if (animalRvs === true) {
        // B. Capture + RVS animal
        rec.reasoning.push(T1.rvsCaptureRule);
        if (ctRvsAvail >= cfg.ct_rvs_capture_min_available) {
          rec.action = 'connecteam_task';
          rec.target = 'ct_rvs';
          rec.reasoning.push(T1.rvsCaptureDispatch);
          return enrichMarginal(rec, capacity, 'ct_rvs', cfg);
        }
        rec.action = 'call_pa_game_comm';
        rec.reasoning.push(T1.rvsCaptureNone);
        return rec;
      }
      // C. Capture + non-RVS animal
      rec.reasoning.push(T1.nonRvsCaptureRule);
      if (ctAnyAvail >= cfg.ct_any_capture_min_available) {
        rec.action = 'connecteam_task';
        rec.target = 'ct_any';
        rec.reasoning.push(T1.nonRvsCaptureDispatch);
        // Choose actual bucket: prefer ct_no_rvs to save RVS volunteers.
        var chosen = (ctNoRvsAvail > 0) ? 'ct_no_rvs' : 'ct_rvs';
        return enrichMarginal(rec, capacity, chosen, cfg, ctAnyAvail);
      }
      rec.action = 'call_pa_game_comm';
      rec.reasoning.push(T1.nonRvsCaptureNone);
      return rec;
    }

    // D. Transport - couriers preferred; C&T volunteers also eligible for transport runs.
    rec.reasoning.push(T1.transportRule);
    var transportPool = courierAvail + ctAnyAvail;
    if (transportPool >= cfg.courier_transport_min_available) {
      rec.action = 'connecteam_task';
      if (courierAvail > 0) {
        rec.target = 'courier';
        if (ctAnyAvail > 0) {
          rec.reasoning.push(fmt(T1.transportCourierAndCt, { courier: courierAvail, ct: ctAnyAvail }));
        }
        rec.reasoning.push(T1.transportCourierDispatch);
        return enrichMarginal(rec, capacity, 'courier', cfg, transportPool);
      }
      rec.target = 'ct_any';
      rec.reasoning.push(T1.transportCtFallback);
      var chosenT = (ctNoRvsAvail > 0) ? 'ct_no_rvs' : 'ct_rvs';
      return enrichMarginal(rec, capacity, chosenT, cfg, transportPool);
    }
    rec.action = 'call_pa_game_comm';
    rec.reasoning.push(T1.transportNone);
    return rec;
  }

  var api = { recommend: recommend, qualifiesForAnimal: qualifiesForAnimal, ACTIONS: ACTIONS };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WildlifeDecision = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

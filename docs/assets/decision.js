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
    },
    // Policy downgrade target: the county's standing policy says don't dispatch
    // (dispatch off, or this issue not allowed), so refer the caller to a named
    // facility instead. tone 'escalate' reuses the warning styling of the other
    // non-dispatch actions. Set ONLY by applyCountyPolicy(), never by the count
    // logic in recommend().
    refer_out: {
      id: 'refer_out',
      label: T1.actionLabels.refer_out,
      tone: 'escalate'
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

  // Canonical qualifying role labels, in stable output order. These mirror the
  // worker's QUALIFYING_ROLES and the role tokens rolesOf() emits per row.
  var CANONICAL_ROLES = ['C&T', 'RVS C&T', 'COURIER'];

  // ─── Qualifying ROLE SET for an animal (DERIVED from qualifiesForAnimal) ──
  // Return the array of canonical role labels that ARE taskable for THIS animal
  // (its RVS flag + Issue). This does NOT re-derive the qualification rules; it
  // probes the SAME qualifiesForAnimal predicate with each single role so the
  // rule lives in exactly one place. Used by Tier 2 (frontend + worker) to keep
  // the address volunteer list to QUALIFIED rows only.
  //   non-RVS capture -> ['C&T', 'RVS C&T']
  //   RVS capture     -> ['RVS C&T']
  //   transport       -> ['C&T', 'RVS C&T', 'COURIER']
  //   unknown issue   -> []
  function qualifyingRoles(animalRvs, issue) {
    var out = [];
    for (var i = 0; i < CANONICAL_ROLES.length; i++) {
      var role = CANONICAL_ROLES[i];
      if (qualifiesForAnimal([role], animalRvs, issue)) {
        out.push(role);
      }
    }
    return out;
  }

  // ─── County POLICY post-step (DOWNGRADE-ONLY) ───────────────────────────
  // Map an animal's RVS flag + Issue onto the policy's allowed_issues vocabulary
  // (['capture','transport','rvs_capture']). An RVS capture is its OWN policy
  // issue ('rvs_capture'); a non-RVS capture is 'capture'. This is matching ONLY
  // and does not touch the count logic.
  function policyIssueKey(animalRvs, issue) {
    var issueNorm = (typeof issue === 'string') ? issue.toLowerCase().trim() : '';
    if (issueNorm === 'capture') {
      return (animalRvs === true) ? 'rvs_capture' : 'capture';
    }
    if (issueNorm === 'transport') {
      return 'transport';
    }
    return issueNorm; // unknown issue -> passthrough handled by caller
  }

  // ─── Species-scope matching (animal type vs policy species_scope) ────────
  // The dispatcher's Animal Type dropdown emits one of these category values:
  //   'bird', 'waterfowl', 'raptor', 'bat', 'mammal', 'reptile_amphibian',
  //   'other' (Other/Unknown).
  // policy.json species_scope lists carry free-form spreadsheet terms like
  //   'birds', 'waterfowl', 'water birds', 'birds of prey', 'bats'.
  // SPECIES_TOKENS maps each dropdown category to the set of normalized policy
  // tokens it satisfies. 'other' (Unknown) is intentionally absent: an unknown
  // species PASSES THROUGH (we never restrict when we don't know the species).
  var SPECIES_TOKENS = {
    bird: ['birds', 'songbirds', 'bird'],
    waterfowl: ['waterfowl', 'waterbirds', 'water birds', 'birds'],
    raptor: ['raptors', 'birds of prey', 'raptor', 'birds'],
    bat: ['bats', 'bat'],
    mammal: ['mammals', 'mammal'],
    reptile_amphibian: ['reptiles', 'amphibians', 'reptile', 'amphibian', 'herps']
  };

  function normSpecies(s) {
    return String(s == null ? '' : s).toLowerCase().trim();
  }

  // speciesAllowedByScope: does `animalType` (a dropdown category) satisfy the
  // policy `scopeList` (array of allowed species terms for this issue)?
  //   - scopeList null/undefined/empty -> ALL species allowed (true).
  //   - animalType 'other'/empty/unknown -> PASS THROUGH (true): never restrict
  //     when the species is unknown.
  //   - otherwise -> true iff any of the dropdown category's tokens appears in
  //     the (normalized) scope list.
  function speciesAllowedByScope(animalType, scopeList) {
    if (!Array.isArray(scopeList) || scopeList.length === 0) return true;
    var cat = normSpecies(animalType);
    if (!cat || cat === 'other' || cat === 'unknown') return true;
    var tokens = SPECIES_TOKENS[cat];
    if (!tokens) return true; // unknown category -> don't restrict
    var allowed = {};
    for (var i = 0; i < scopeList.length; i++) {
      allowed[normSpecies(scopeList[i])] = true;
    }
    for (var j = 0; j < tokens.length; j++) {
      if (allowed[normSpecies(tokens[j])]) return true;
    }
    return false;
  }

  // scopeListForIssue: pull the species_scope array that applies to THIS policy
  // issue. species_scope is keyed by the policy issue family:
  //   'capture'      -> species_scope.capture
  //   'rvs_capture'  -> species_scope.rvs  (RVS scope, e.g. "bats only")
  //   'transport'    -> species_scope.transport
  // Returns null when species_scope is null/absent or carries no list for this
  // issue (i.e. no restriction for this call).
  function scopeListForIssue(speciesScope, policyIssue) {
    if (!speciesScope || typeof speciesScope !== 'object') return null;
    var key = (policyIssue === 'rvs_capture') ? 'rvs' : policyIssue;
    var list = speciesScope[key];
    return Array.isArray(list) ? list : null;
  }

  // Pull referral_targets relevant to a policy issue. A target with no
  // `for_issues` (or a non-array) is treated as applying to ALL issues; a target
  // WITH a for_issues array is included only when it lists this issue. Targets
  // are returned as shallow copies so callers can attach them to the rec without
  // aliasing the shared policy object.
  function referralsForIssue(targets, policyIssue) {
    if (!Array.isArray(targets)) return [];
    var out = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      if (!t || typeof t !== 'object') continue;
      var fi = t.for_issues;
      var applies = !Array.isArray(fi) || fi.indexOf(policyIssue) !== -1;
      if (!applies) continue;
      out.push({
        name: t.name,
        phone: t.phone,
        notes: (typeof t.notes !== 'undefined') ? t.notes : '',
        for_issues: Array.isArray(fi) ? fi.slice() : null
      });
    }
    return out;
  }

  // ─── Referral phone: facilities.json is the SOURCE OF TRUTH ──────────────
  // policy.json referral_targets carry phone numbers sourced from a spreadsheet,
  // which can be stale. When the refer_out display shows a phone, we prefer the
  // matching facilities.json phone and treat the policy phone as advisory only.
  //
  // normName: collapse a facility name to a comparison key (lowercase,
  // alphanumerics only) so "Raven Ridge", "Raven Ridge Wildlife Center" and
  // "raven-ridge" all line up after alias expansion.
  function normName(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // buildFacilityPhoneIndex: index facilities.json (the source of truth) by
  // normalized name for phone lookup. `aliasMap` is the optional
  // facility_name_map.json (short alias -> canonical facilities.json name);
  // both the alias key AND the canonical value are registered as lookup keys so
  // policy names that use either form resolve. Returns { byName: {normKey ->
  // {name, phone}} }.
  function buildFacilityPhoneIndex(facilities, aliasMap) {
    var byName = {};
    if (Array.isArray(facilities)) {
      for (var i = 0; i < facilities.length; i++) {
        var f = facilities[i];
        if (!f || typeof f !== 'object' || !f.name) continue;
        var entry = { name: f.name, phone: (f.phone == null ? '' : String(f.phone)) };
        byName[normName(f.name)] = entry;
      }
    }
    if (aliasMap && typeof aliasMap === 'object') {
      var keys = Object.keys(aliasMap);
      for (var j = 0; j < keys.length; j++) {
        var alias = keys[j];
        var canonical = aliasMap[alias];
        var canonEntry = byName[normName(canonical)];
        if (canonEntry) {
          // Register the alias spelling so a policy target using the short
          // alias resolves to the canonical facility's phone.
          if (!byName[normName(alias)]) byName[normName(alias)] = canonEntry;
        }
      }
    }
    return { byName: byName };
  }

  // digitsOnly: strip to bare digits for phone comparison/matching.
  function digitsOnly(s) {
    return String(s == null ? '' : s).replace(/[^0-9]/g, '');
  }

  // resolveReferralPhone: given a policy referral target and a facilities index,
  // return { phone, source, facilityName, discrepancy, policyPhone }:
  //   - source 'facilities' when the target name matches a facilities.json entry
  //     (its phone wins, even if it differs from the policy phone);
  //   - source 'policy' when there's no facilities match (fall back to the
  //     policy phone, e.g. PA Game Commission which isn't a rehab facility);
  //   - discrepancy=true when a facilities match exists AND its digits differ
  //     from the policy phone digits, so the UI can flag it.
  // NEVER returns the spreadsheet/policy phone over a facilities.json phone.
  function resolveReferralPhone(target, facIndex) {
    var policyPhone = (target && target.phone != null) ? String(target.phone) : '';
    var result = {
      phone: policyPhone,
      source: 'policy',
      facilityName: null,
      discrepancy: false,
      policyPhone: policyPhone
    };
    if (!target || !facIndex || !facIndex.byName) return result;
    var match = facIndex.byName[normName(target.name)];
    if (!match) return result; // no facilities entry -> keep policy phone
    result.facilityName = match.name;
    result.source = 'facilities';
    result.phone = match.phone || '';
    if (digitsOnly(match.phone) !== digitsOnly(policyPhone) &&
        (digitsOnly(match.phone) || digitsOnly(policyPhone))) {
      result.discrepancy = true;
    }
    return result;
  }

  // applyCountyPolicy: county-policy post-step run AFTER the count-based
  // recommend(). Given the base recommendation, the county's policy block, and
  // the animal's RVS flag + Issue, it returns the FINAL action. Rules:
  //   - No policy (null/undefined/empty) -> base action unchanged.
  //   - dispatch_enabled === false -> always refer_out (with referral targets),
  //     EVEN when the count yielded a non-dispatch (e.g. call_pa_game_comm):
  //     the county's standing policy is "do not dispatch, refer to the named
  //     targets," so the dispatcher must be shown WHO to call regardless of
  //     local capacity.
  //   - allowed_issues is an array AND this issue is NOT in it -> refer_out.
  //   - species_scope (when set for this issue) does NOT include the selected
  //     animal type -> refer_out. This is ADDITIONAL to the dispatch_enabled and
  //     allowed_issues checks: a county may dispatch this ISSUE but restrict it
  //     to certain SPECIES (e.g. Chester dispatches captures for birds only). An
  //     'Other/Unknown' (or absent) animal type PASSES THROUGH — we never
  //     restrict when the species is unknown.
  //   - Otherwise -> base action passes through unchanged.
  // It NEVER invents a DISPATCH: policy can only redirect an actionable base
  // into a referral, never turn a non-dispatch into a connecteam_task. An
  // already-refer_out base, or a tbd_escalate (malformed/unknown issue — not a
  // capacity decision), is returned untouched. referral_targets and
  // special_notes from the policy are attached to the returned object so the UI
  // can display who to call. Mutates and returns `rec` for convenience.
  function applyCountyPolicy(rec, countyPolicy, issue, animalRvs, animalType) {
    if (!rec) return rec;
    if (!countyPolicy || typeof countyPolicy !== 'object') return rec;

    var policyIssue = policyIssueKey(animalRvs, issue);

    // Determine whether policy forbids dispatching for THIS call.
    var dispatchOff = (countyPolicy.dispatch_enabled === false);
    var issueNotAllowed = false;
    if (!dispatchOff && Array.isArray(countyPolicy.allowed_issues)) {
      issueNotAllowed = (countyPolicy.allowed_issues.indexOf(policyIssue) === -1);
    }
    // Species-scope gate (ADDITIONAL to the two checks above): the county allows
    // this issue, but only for certain species. If the selected animal type is
    // not among them, refer out. Unknown/absent species passes through.
    var scopeList = scopeListForIssue(countyPolicy.species_scope, policyIssue);
    var speciesNotAllowed = !speciesAllowedByScope(animalType, scopeList);

    if (!dispatchOff && !issueNotAllowed && !speciesNotAllowed) {
      // Policy permits this dispatch: pass the base action through unchanged.
      return rec;
    }

    // Policy forbids dispatch for this call. Redirect any ACTIONABLE base into a
    // referral so the dispatcher is told who to call. A count-based dispatch
    // (connecteam_task) and a no-capacity escalation (call_pa_game_comm) both
    // become refer_out. Policy never INVENTS a dispatch, and an unknown-issue
    // escalation (tbd_escalate) or an already-refer_out base is left untouched.
    if (rec.action !== 'connecteam_task' && rec.action !== 'call_pa_game_comm') {
      return rec;
    }

    rec.action = 'refer_out';
    rec.target = null;
    rec.referral_targets = referralsForIssue(countyPolicy.referral_targets, policyIssue);
    if (typeof countyPolicy.special_notes !== 'undefined') {
      rec.special_notes = countyPolicy.special_notes;
    }
    rec.reasoning = Array.isArray(rec.reasoning) ? rec.reasoning : [];
    if (dispatchOff) {
      rec.reasoning.push(T1.policyDispatchDisabled);
    } else if (issueNotAllowed) {
      rec.reasoning.push(fmt(T1.policyIssueNotAllowed, { issue: policyIssue }));
    } else {
      // Species restriction is the reason: name the allowed species list.
      rec.reasoning.push(fmt(T1.policySpeciesNotAllowed, {
        species: Array.isArray(scopeList) ? scopeList.join(', ') : ''
      }));
    }
    return rec;
  }

  // recommend(): COUNT-BASED recommendation, then the DOWNGRADE-ONLY county
  // policy post-step. The count logic (branches A–E below) is unchanged and
  // remains the single source of "is anyone available." When a `countyPolicy`
  // block is passed, applyCountyPolicy() runs AFTER it and can only turn a
  // count-based dispatch into a named referral (refer_out) — it never invents a
  // dispatch. `countyPolicy` is optional, so existing call sites/tests that omit
  // it keep today's behavior exactly. `animalType` is the optional dropdown
  // category ('bird','waterfowl','raptor','bat','mammal','reptile_amphibian',
  // 'other'); when a county's species_scope restricts the issue, a non-matching
  // animal type is referred out. Omitting it (or 'other'/unknown) never adds a
  // species restriction.
  function recommend(capacity, animalRvs, issue, resolvedConfig, countyPolicy, animalType) {
    var rec = recommendByCount(capacity, animalRvs, issue, resolvedConfig);
    return applyCountyPolicy(rec, countyPolicy, issue, animalRvs, animalType);
  }

  function recommendByCount(capacity, animalRvs, issue, resolvedConfig) {
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

  var api = {
    recommend: recommend,
    applyCountyPolicy: applyCountyPolicy,
    buildFacilityPhoneIndex: buildFacilityPhoneIndex,
    resolveReferralPhone: resolveReferralPhone,
    qualifiesForAnimal: qualifiesForAnimal,
    qualifyingRoles: qualifyingRoles,
    speciesAllowedByScope: speciesAllowedByScope,
    ACTIONS: ACTIONS
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WildlifeDecision = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* tests/test_decision.js — Phase 3 table-driven tests for decision.js
 * Run: node tests/test_decision.js
 */
'use strict';

var assert = require('assert');
var path = require('path');
var mod = require(path.resolve(__dirname, '../docs/assets/decision.js'));
var recommend = mod.recommend;
var qualifiesForAnimal = mod.qualifiesForAnimal;
var ACTIONS = mod.ACTIONS;

// Sanity: ACTIONS registry shape
assert.strictEqual(ACTIONS.connecteam_task.tone, 'go');
assert.strictEqual(ACTIONS.call_pa_game_comm.tone, 'escalate');
assert.strictEqual(ACTIONS.tbd_escalate.tone, 'unknown');

// Helpers to build capacity buckets quickly.
function bk(total, available, marg) {
  return { total: total, available: available, marginal_volunteers: marg || [] };
}
function cap(noRvs, rvs, courier) {
  return { ct_no_rvs: noRvs, ct_rvs: rvs, courier: courier };
}

var DEFAULTS = {
  marginal_threshold: 1,
  ct_rvs_capture_min_available: 1,
  ct_any_capture_min_available: 1,
  courier_transport_min_available: 1
};

var cases = [
  {
    name: 'A. missing capacity -> call_pa_game_comm',
    capacity: undefined, rvs: true, issue: 'capture', cfg: DEFAULTS,
    expect: { action: 'call_pa_game_comm', target: null, marginal: false }
  },
  {
    name: 'B1. capture+rvs, ct_rvs.available=1, marginal',
    capacity: cap(bk(0,0), bk(1,1,[{availability_note:'M-F'}]), bk(0,0)),
    rvs: true, issue: 'capture', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'ct_rvs', marginal: true,
              marginal_volunteers_len: 1 }
  },
  {
    name: 'B2. capture+rvs, ct_rvs empty -> game comm',
    capacity: cap(bk(0,0), bk(0,0), bk(0,0)),
    rvs: true, issue: 'capture', cfg: DEFAULTS,
    expect: { action: 'call_pa_game_comm', target: null, marginal: false }
  },
  {
    name: 'C1. capture+non-rvs, ct_no_rvs healthy',
    capacity: cap(bk(5,3), bk(0,0), bk(0,0)),
    rvs: false, issue: 'capture', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'ct_any', marginal: false }
  },
  {
    name: 'C2. capture+non-rvs, both empty -> game comm',
    capacity: cap(bk(1,0), bk(1,0), bk(0,0)),
    rvs: false, issue: 'capture', cfg: DEFAULTS,
    expect: { action: 'call_pa_game_comm', target: null, marginal: false }
  },
  {
    name: 'D1. transport, courier healthy',
    capacity: cap(bk(0,0), bk(0,0), bk(3,2)),
    rvs: true, issue: 'transport', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'courier', marginal: false }
  },
  {
    name: 'D2. transport, courier empty -> C&T fallback',
    capacity: cap(bk(2,2), bk(0,0), bk(1,0)),
    rvs: true, issue: 'transport', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'ct_any', marginal: false }
  },
  {
    name: 'D3. transport, courier=0 + C&T=0 -> game comm',
    capacity: cap(bk(1,0), bk(1,0), bk(1,0)),
    rvs: false, issue: 'transport', cfg: DEFAULTS,
    expect: { action: 'call_pa_game_comm', target: null, marginal: false }
  },
  {
    name: 'E. unknown issue -> tbd_escalate',
    capacity: cap(bk(2,2), bk(2,2), bk(2,2)),
    rvs: true, issue: 'unknown_issue', cfg: DEFAULTS,
    expect: { action: 'tbd_escalate', target: null, marginal: false }
  },
  {
    name: 'Threshold-bumped: ct_rvs.available=2 < min=3 -> game comm',
    capacity: cap(bk(0,0), bk(5,2), bk(0,0)),
    rvs: true, issue: 'capture',
    cfg: { marginal_threshold: 1, ct_rvs_capture_min_available: 3,
           ct_any_capture_min_available: 1, courier_transport_min_available: 1 },
    expect: { action: 'call_pa_game_comm', target: null, marginal: false }
  },
  {
    name: 'Marginal threshold bumped: ct_rvs.available=2, marg_threshold=3 -> marginal',
    capacity: cap(bk(0,0), bk(5,2,[{availability_note:'wknds'},{availability_note:'eves'}]), bk(0,0)),
    rvs: true, issue: 'capture',
    cfg: { marginal_threshold: 3, ct_rvs_capture_min_available: 1,
           ct_any_capture_min_available: 1, courier_transport_min_available: 1 },
    expect: { action: 'connecteam_task', target: 'ct_rvs', marginal: true,
              marginal_volunteers_len: 2 }
  },
  {
    name: 'C3. capture+non-rvs, ct_no_rvs=1 + ct_rvs=3 -> combined ct_any=4, NOT marginal',
    capacity: cap(
      bk(1,1,[{availability_note:'wkends'}]),
      bk(3,3,[]),
      bk(0,0)),
    rvs: false, issue: 'capture', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'ct_any', marginal: false }
  },
  {
    name: 'C4. capture+non-rvs, ct_no_rvs=1 + ct_rvs=1 -> combined ct_any=2, NOT marginal (user regression)',
    capacity: cap(
      bk(1,1,[{availability_note:'wk'}]),
      bk(1,1,[{availability_note:'eves'}]),
      bk(0,0)),
    rvs: false, issue: 'capture', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'ct_any', marginal: false }
  },
  {
    name: 'C5. capture+non-rvs, ct_no_rvs=1 + ct_rvs=0 -> combined ct_any=1, marginal',
    capacity: cap(
      bk(1,1,[{availability_note:'wk'}]),
      bk(1,0),
      bk(0,0)),
    rvs: false, issue: 'capture', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'ct_any', marginal: true,
              marginal_volunteers_len: 1 }
  },
  {
    name: 'null resolvedConfig -> defaults applied',
    capacity: cap(bk(0,0), bk(2,2), bk(0,0)),
    rvs: true, issue: 'capture', cfg: null,
    expect: { action: 'connecteam_task', target: 'ct_rvs', marginal: false }
  },
  {
    name: 'D4. transport, courier=1 + ct_any=3, threshold=2 -> prefer courier (combined pool healthy)',
    capacity: cap(bk(2,2), bk(2,1), bk(1,1)),
    rvs: false, issue: 'transport',
    cfg: { marginal_threshold: 1, ct_rvs_capture_min_available: 1,
           ct_any_capture_min_available: 1, courier_transport_min_available: 2 },
    expect: { action: 'connecteam_task', target: 'courier', marginal: false }
  },
  {
    name: 'D5. transport, courier=0 + ct_no_rvs=1 + ct_rvs=1, threshold=2 -> ct_any, ct_no_rvs preferred',
    capacity: cap(bk(1,1,[{availability_note:'wk'}]), bk(1,1), bk(0,0)),
    rvs: false, issue: 'transport',
    cfg: { marginal_threshold: 1, ct_rvs_capture_min_available: 1,
           ct_any_capture_min_available: 1, courier_transport_min_available: 2 },
    expect: { action: 'connecteam_task', target: 'ct_any', marginal: false }
  },
  {
    name: 'D6. transport, courier=0 + ct_any=0, threshold=1 -> game comm',
    capacity: cap(bk(0,0), bk(0,0), bk(0,0)),
    rvs: false, issue: 'transport', cfg: DEFAULTS,
    expect: { action: 'call_pa_game_comm', target: null, marginal: false }
  },
  {
    name: 'D7. transport, courier=2 + ct_any=0, threshold=1 -> courier (regression)',
    capacity: cap(bk(0,0), bk(0,0), bk(3,2)),
    rvs: false, issue: 'transport', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'courier', marginal: false }
  },
  {
    name: 'D8. Bedford-shape: courier=1 + ct_rvs=2, threshold=1 -> courier NOT marginal (combined pool=3)',
    capacity: cap(bk(0,0), bk(2,2), bk(1,1,[{availability_note:'Contact for avail'}])),
    rvs: false, issue: 'transport', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'courier', marginal: false }
  },
  {
    name: 'D9. transport, courier=1 + ct_any=0, threshold=1 -> courier marginal (combined pool=1)',
    capacity: cap(bk(1,0), bk(1,0), bk(1,1,[{availability_note:'eves'}])),
    rvs: false, issue: 'transport', cfg: DEFAULTS,
    expect: { action: 'connecteam_task', target: 'courier', marginal: true,
              marginal_volunteers_len: 1 }
  }
];

var passed = 0;
cases.forEach(function (c) {
  var got = recommend(c.capacity, c.rvs, c.issue, c.cfg);
  assert.strictEqual(got.action, c.expect.action, c.name + ' [action]');
  assert.strictEqual(got.target, c.expect.target, c.name + ' [target]');
  assert.strictEqual(got.marginal, c.expect.marginal, c.name + ' [marginal]');
  if (typeof c.expect.marginal_volunteers_len === 'number') {
    assert.strictEqual(got.marginal_volunteers.length,
      c.expect.marginal_volunteers_len, c.name + ' [marginal_volunteers length]');
  }
  assert.ok(Array.isArray(got.reasoning) && got.reasoning.length >= 1,
    c.name + ' [reasoning non-empty]');
  passed++;
});

// Spot-check transport C&T-dispatch reasoning trace contains the no-courier note.
var fallbackRec = recommend(
  cap(bk(2,2), bk(0,0), bk(1,0)), true, 'transport', DEFAULTS);
assert.ok(fallbackRec.reasoning.some(function (r) {
  return r.indexOf('No couriers available') !== -1;
}), 'transport C&T dispatch reasoning should mention no couriers available');
passed++;

// Phase 4d: zero-capacity (all buckets present, all available=0) cases
// should produce a friendly call_pa_game_comm message — not threshold math.
var zeroCapRvs = recommend(
  cap(bk(2,0), bk(2,0), bk(2,0)), true, 'capture', DEFAULTS);
assert.strictEqual(zeroCapRvs.action, 'call_pa_game_comm',
  'zero-cap RVS capture -> call_pa_game_comm');
assert.ok(zeroCapRvs.reasoning.some(function (r) {
  return r.indexOf('No RVS-capable C&T volunteers available - ask the finder to call PA Game Commission') !== -1;
}), 'zero-cap RVS capture should use friendly wording');
passed++;

var zeroCapNonRvs = recommend(
  cap(bk(2,0), bk(2,0), bk(2,0)), false, 'capture', DEFAULTS);
assert.strictEqual(zeroCapNonRvs.action, 'call_pa_game_comm',
  'zero-cap non-RVS capture -> call_pa_game_comm');
assert.ok(zeroCapNonRvs.reasoning.some(function (r) {
  return r.indexOf('No C&T volunteers available - ask the finder to call PA Game Commission') !== -1;
}), 'zero-cap non-RVS capture should use friendly wording');
passed++;

// Phase 4d: missing-capacity case now routes to call_pa_game_comm.
var missingRec = recommend(undefined, true, 'capture', DEFAULTS);
assert.strictEqual(missingRec.action, 'call_pa_game_comm',
  'missing capacity -> call_pa_game_comm');
assert.ok(missingRec.reasoning[0].indexOf('call PA Game Commission') !== -1,
  'missing capacity reasoning should mention calling PA Game Commission');
passed++;

// Phase 4d: regression guard — reasoning must never contain threshold math
// (substrings like "ct_rvs.available=", "ct_any.available=", "courier.available=").
var thresholdRegex = /\.available\s*=/;
var sampleConfigs = [
  cap(bk(0,0), bk(1,1), bk(0,0)),
  cap(bk(0,0), bk(0,0), bk(0,0)),
  cap(bk(5,3), bk(0,0), bk(0,0)),
  cap(bk(1,0), bk(1,0), bk(0,0)),
  cap(bk(0,0), bk(0,0), bk(3,2)),
  cap(bk(2,2), bk(0,0), bk(1,0)),
  cap(bk(1,0), bk(1,0), bk(1,0))
];
var combos = [[true,'capture'], [false,'capture'], [true,'transport'], [false,'transport']];
sampleConfigs.forEach(function (capFix) {
  combos.forEach(function (combo) {
    var r = recommend(capFix, combo[0], combo[1], DEFAULTS);
    r.reasoning.forEach(function (line) {
      assert.ok(!thresholdRegex.test(line),
        'reasoning must not contain threshold math, got: ' + line);
    });
  });
});
passed++;

// Phase 4a: defensive PII strip — even if a stale county_capacity.json
// still includes a `name` field on a marginal_volunteer, recommend() must
// NOT pass it through to the modal payload.
var staleCap = cap(
  bk(0,0),
  bk(1,1,[{name:'Krouse', availability_note:'Contact for avail'}]),
  bk(0,0));
var staleRec = recommend(staleCap, true, 'capture', DEFAULTS);
assert.strictEqual(staleRec.marginal, true, 'stale fixture should be marginal');
assert.strictEqual(staleRec.marginal_volunteers.length, 1,
  'stale fixture should yield one marginal volunteer entry');
assert.ok(!('name' in staleRec.marginal_volunteers[0]),
  'recommend() must strip volunteer `name` from marginal_volunteers');
assert.strictEqual(staleRec.marginal_volunteers[0].availability_note,
  'Contact for avail', 'availability_note must be preserved verbatim');
passed++;

// ── qualifiesForAnimal: hasCt-includes-RVS-C&T capability matrix ────────────
// The aggregate Worker emits 'RVS C&T' EXCLUSIVELY for a both-capable
// volunteer (to keep panel role_counts mutually exclusive), dropping the plain
// 'C&T' token. QUALIFICATION must still treat an RVS C&T volunteer as
// C&T-capable, so for a NON-RVS capture ALL C&T-capable roles (plain C&T AND
// RVS C&T) qualify, while a Courier-only does not. For an RVS capture ONLY
// RVS C&T qualifies.
//
// No-RVS capture (RVS=No, ISSUE=capture): any C&T-capable qualifies.
assert.strictEqual(qualifiesForAnimal(['C&T'], false, 'capture'), true,
  'no-RVS capture: plain C&T qualifies');
assert.strictEqual(qualifiesForAnimal(['RVS C&T'], false, 'capture'), true,
  'no-RVS capture: RVS C&T qualifies (RVS C&T implies C&T capability)');
assert.strictEqual(qualifiesForAnimal(['COURIER'], false, 'capture'), false,
  'no-RVS capture: Courier-only does NOT qualify');
// Whitespace/case-insensitive combined token still treated as RVS C&T.
assert.strictEqual(qualifiesForAnimal(['rvs c&t'], false, 'capture'), true,
  'no-RVS capture: lowercase "rvs c&t" qualifies');

// RVS capture (RVS=Yes): ONLY RVS C&T qualifies.
assert.strictEqual(qualifiesForAnimal(['RVS C&T'], true, 'capture'), true,
  'RVS capture: RVS C&T qualifies');
assert.strictEqual(qualifiesForAnimal(['C&T'], true, 'capture'), false,
  'RVS capture: plain C&T does NOT qualify');
assert.strictEqual(qualifiesForAnimal(['COURIER'], true, 'capture'), false,
  'RVS capture: Courier-only does NOT qualify');

// Transport: C&T, RVS C&T, and Courier all qualify.
assert.strictEqual(qualifiesForAnimal(['C&T'], false, 'transport'), true,
  'transport: plain C&T qualifies');
assert.strictEqual(qualifiesForAnimal(['RVS C&T'], false, 'transport'), true,
  'transport: RVS C&T qualifies');
assert.strictEqual(qualifiesForAnimal(['COURIER'], false, 'transport'), true,
  'transport: Courier qualifies');

// Unknown issue -> never qualifies (mirrors recommend's E-branch).
assert.strictEqual(qualifiesForAnimal(['RVS C&T'], false, 'unknown'), false,
  'unknown issue: nobody qualifies');
passed++;

// ── qualifyingRoles: DERIVED role set must mirror qualifiesForAnimal ─────────
// Single source of truth: qualifyingRoles probes qualifiesForAnimal with each
// canonical role, so the returned set must agree with the predicate exactly.
var qualifyingRoles = mod.qualifyingRoles;
assert.strictEqual(typeof qualifyingRoles, 'function', 'qualifyingRoles is exported');

// non-RVS capture -> C&T + RVS C&T (RVS C&T implies C&T capability), NO courier.
assert.deepStrictEqual(qualifyingRoles(false, 'capture'), ['C&T', 'RVS C&T'],
  'no-RVS capture qualifying set = [C&T, RVS C&T]');
// RVS capture -> RVS C&T only.
assert.deepStrictEqual(qualifyingRoles(true, 'capture'), ['RVS C&T'],
  'RVS capture qualifying set = [RVS C&T]');
// transport -> all three.
assert.deepStrictEqual(qualifyingRoles(false, 'transport'), ['C&T', 'RVS C&T', 'COURIER'],
  'transport qualifying set = [C&T, RVS C&T, COURIER]');
assert.deepStrictEqual(qualifyingRoles(true, 'transport'), ['C&T', 'RVS C&T', 'COURIER'],
  'transport qualifying set is RVS-independent');
// unknown issue -> empty set.
assert.deepStrictEqual(qualifyingRoles(false, 'unknown'), [],
  'unknown issue -> empty qualifying set');

// Cross-check: every role qualifyingRoles returns MUST pass qualifiesForAnimal,
// and every role it omits MUST fail it (no drift between the two).
['capture', 'transport'].forEach(function (issue) {
  [false, true].forEach(function (rvs) {
    var setArr = qualifyingRoles(rvs, issue);
    ['C&T', 'RVS C&T', 'COURIER'].forEach(function (role) {
      var inSet = setArr.indexOf(role) !== -1;
      assert.strictEqual(inSet, qualifiesForAnimal([role], rvs, issue),
        'qualifyingRoles agrees with qualifiesForAnimal for ' + role +
        ' (rvs=' + rvs + ', issue=' + issue + ')');
    });
  });
});
passed++;

// ── applyCountyPolicy: DOWNGRADE-ONLY county-policy post-step ────────────────
// applyCountyPolicy runs AFTER the count-based recommend(). It can ONLY turn a
// count-based dispatch (connecteam_task) into a named referral (refer_out); it
// never invents a dispatch and never alters a non-dispatch base.
var applyCountyPolicy = mod.applyCountyPolicy;
assert.strictEqual(typeof applyCountyPolicy, 'function', 'applyCountyPolicy is exported');

// refer_out action registered with an escalate/warning tone.
assert.ok(ACTIONS.refer_out, 'ACTIONS.refer_out registered');
assert.strictEqual(ACTIONS.refer_out.tone, 'escalate', 'refer_out tone is escalate');

// A healthy non-RVS capture produces a count-based dispatch we can downgrade.
var dispatchCap = cap(bk(5, 3), bk(0, 0), bk(0, 0));

// 1. dispatch_enabled === false -> ALWAYS refer_out, with referral targets +
//    special_notes attached, regardless of capacity.
var disabledPolicy = {
  dispatch_enabled: false,
  allowed_issues: 'all',
  referral_targets: [
    { name: 'PA Game Commission', phone: '8337429453' },
    { name: 'Raven Ridge', phone: '7173274811', for_issues: ['capture', 'rvs_capture'] }
  ],
  special_notes: 'Do Not Enter Dispatch. No volunteers.'
};
var baseDisabled = recommend(dispatchCap, false, 'capture', DEFAULTS);
assert.strictEqual(baseDisabled.action, 'connecteam_task',
  'precondition: healthy capacity yields a count-based dispatch');
var disabledRec = applyCountyPolicy(baseDisabled, disabledPolicy, 'capture', false);
assert.strictEqual(disabledRec.action, 'refer_out',
  'dispatch_enabled=false downgrades dispatch -> refer_out');
assert.strictEqual(disabledRec.target, null, 'refer_out clears the dispatch target');
assert.ok(Array.isArray(disabledRec.referral_targets) && disabledRec.referral_targets.length === 2,
  'disabled county attaches both referral targets (no for_issues = all issues)');
assert.strictEqual(disabledRec.special_notes, 'Do Not Enter Dispatch. No volunteers.',
  'disabled county attaches special_notes');
assert.ok(disabledRec.reasoning.some(function (r) { return r.indexOf('dispatch is disabled') !== -1; }),
  'disabled county appends a policy reasoning line');
passed++;

// disabled county also downgrades through the full recommend() pipeline when the
// policy is passed as the 5th arg.
var pipelineDisabled = recommend(dispatchCap, false, 'capture', DEFAULTS, disabledPolicy);
assert.strictEqual(pipelineDisabled.action, 'refer_out',
  'recommend(...policy) applies the disabled-county downgrade end-to-end');
passed++;

// 2. allowed_issues filtering: dispatch_enabled=true but the current issue is
//    NOT in allowed_issues -> refer_out for THAT issue; an ALLOWED issue passes
//    through unchanged.
var transportOnlyPolicy = {
  dispatch_enabled: true,
  allowed_issues: ['transport'],
  referral_targets: [
    { name: 'Wildbird Recovery', phone: '7248981788', for_issues: ['capture'] },
    { name: 'Courier Hub', phone: '5551234567', for_issues: ['transport'] }
  ],
  special_notes: 'Captures referred out; transport dispatched.'
};
// capture is NOT allowed -> downgrade to refer_out, only capture-tagged targets.
var captureBase = recommend(dispatchCap, false, 'capture', DEFAULTS);
var captureReferred = applyCountyPolicy(captureBase, transportOnlyPolicy, 'capture', false);
assert.strictEqual(captureReferred.action, 'refer_out',
  'allowed_issues excludes capture -> refer_out');
assert.strictEqual(captureReferred.referral_targets.length, 1,
  'only the capture-tagged referral target is attached');
assert.strictEqual(captureReferred.referral_targets[0].name, 'Wildbird Recovery',
  'capture referral target is Wildbird Recovery');
assert.ok(captureReferred.reasoning.some(function (r) { return r.indexOf('capture') !== -1; }),
  'allowed_issues downgrade reasoning names the issue');

// transport IS allowed -> passthrough unchanged.
var transportCap = cap(bk(0, 0), bk(0, 0), bk(2, 2));
var transportBase = recommend(transportCap, false, 'transport', DEFAULTS);
assert.strictEqual(transportBase.action, 'connecteam_task',
  'precondition: transport capacity yields a dispatch');
var transportPassed = applyCountyPolicy(transportBase, transportOnlyPolicy, 'transport', false);
assert.strictEqual(transportPassed.action, 'connecteam_task',
  'allowed_issues includes transport -> dispatch passes through');
assert.ok(!('referral_targets' in transportPassed),
  'passthrough dispatch carries no referral_targets');
passed++;

// 2b. RVS capture maps to the 'rvs_capture' policy issue, distinct from plain
//     'capture'. A policy allowing only 'capture' still refers an RVS capture.
var captureNoRvsPolicy = {
  dispatch_enabled: true,
  allowed_issues: ['capture'],
  referral_targets: [
    { name: 'RVS Facility', phone: '5559990000', for_issues: ['rvs_capture'] }
  ]
};
var rvsCap = cap(bk(0, 0), bk(2, 2), bk(0, 0));
var rvsBase = recommend(rvsCap, true, 'capture', DEFAULTS);
assert.strictEqual(rvsBase.action, 'connecteam_task',
  'precondition: RVS capture with RVS capacity dispatches');
var rvsReferred = applyCountyPolicy(rvsBase, captureNoRvsPolicy, 'capture', true);
assert.strictEqual(rvsReferred.action, 'refer_out',
  'allowed_issues=[capture] still refers an rvs_capture');
assert.strictEqual(rvsReferred.referral_targets[0].name, 'RVS Facility',
  'rvs_capture referral target attached');
// Non-RVS capture under the SAME policy IS allowed -> passthrough.
var nonRvsBase = recommend(dispatchCap, false, 'capture', DEFAULTS);
var nonRvsPassed = applyCountyPolicy(nonRvsBase, captureNoRvsPolicy, 'capture', false);
assert.strictEqual(nonRvsPassed.action, 'connecteam_task',
  'allowed_issues=[capture] passes a plain (non-RVS) capture through');
passed++;

// 3. Unrestricted passthrough: enabled + allowed_issues 'all' (or absent) ->
//    base action unchanged.
var openPolicy = { dispatch_enabled: true, allowed_issues: 'all', referral_targets: [] };
var openBase = recommend(dispatchCap, false, 'capture', DEFAULTS);
var openPassed = applyCountyPolicy(openBase, openPolicy, 'capture', false);
assert.strictEqual(openPassed.action, 'connecteam_task',
  'unrestricted policy passes the dispatch through unchanged');
assert.strictEqual(openPassed.target, openBase.target,
  'unrestricted passthrough preserves the dispatch target');

// No policy at all -> base unchanged.
var noPolicyPassed = applyCountyPolicy(recommend(dispatchCap, false, 'capture', DEFAULTS), null, 'capture', false);
assert.strictEqual(noPolicyPassed.action, 'connecteam_task',
  'null policy -> base action unchanged');
passed++;

// 4. dispatch_enabled=false ALSO redirects a no-capacity escalation. When the
//    county's policy forbids dispatch, the dispatcher must be shown WHO to call
//    even when local capacity is empty (count base = call_pa_game_comm). The
//    base is redirected to refer_out with the policy referral targets attached.
var emptyCap = cap(bk(0, 0), bk(0, 0), bk(0, 0));
var escalateBase = recommend(emptyCap, true, 'capture', DEFAULTS);
assert.strictEqual(escalateBase.action, 'call_pa_game_comm',
  'precondition: empty capacity yields call_pa_game_comm (non-dispatch)');
var escalateAfter = applyCountyPolicy(escalateBase, disabledPolicy, 'capture', true);
assert.strictEqual(escalateAfter.action, 'refer_out',
  'dispatch_enabled=false redirects a no-capacity call_pa_game_comm -> refer_out');
assert.ok(Array.isArray(escalateAfter.referral_targets) && escalateAfter.referral_targets.length > 0,
  'redirected no-capacity base attaches the policy referral targets');
assert.strictEqual(escalateAfter.special_notes, 'Do Not Enter Dispatch. No volunteers.',
  'redirected no-capacity base attaches special_notes');
passed++;

// 4b. Policy NEVER invents a dispatch and never alters a malformed-issue base:
//     a tbd_escalate (unknown issue) under a disabled county stays tbd_escalate
//     (it is not a capacity decision, so policy leaves it untouched).
var unknownBase = recommend(emptyCap, true, 'mystery', DEFAULTS);
assert.strictEqual(unknownBase.action, 'tbd_escalate',
  'precondition: unknown issue yields tbd_escalate');
var unknownAfter = applyCountyPolicy(unknownBase, disabledPolicy, 'mystery', true);
assert.strictEqual(unknownAfter.action, 'tbd_escalate',
  'policy leaves a tbd_escalate (malformed issue) untouched — no refer_out injected');
assert.ok(!('referral_targets' in unknownAfter),
  'tbd_escalate base gets no referral_targets attached');
passed++;

// ── species_scope enforcement (animal type vs county policy) ────────────────
// applyCountyPolicy's 5th arg is the dropdown animal type. When a county allows
// the issue but restricts it to certain species, a non-matching animal type is
// referred out; a matching type (or unknown species, or null scope) passes
// through. Mirrors Chester (capture: birds-only).
var chesterBirdsPolicy = {
  dispatch_enabled: true,
  allowed_issues: ['capture', 'rvs_capture', 'transport'],
  species_scope: { capture: ['birds'] },
  referral_targets: [
    { name: 'Chester Bird Rehab', phone: '6105550000', for_issues: ['capture'] }
  ],
  special_notes: ''
};

// birds-only capture + a MAMMAL call -> refer_out with referral targets.
var mammalBase = recommend(dispatchCap, false, 'capture', DEFAULTS);
assert.strictEqual(mammalBase.action, 'connecteam_task',
  'precondition: capture with capacity dispatches');
var mammalReferred = applyCountyPolicy(mammalBase, chesterBirdsPolicy, 'capture', false, 'mammal');
assert.strictEqual(mammalReferred.action, 'refer_out',
  'birds-only capture + mammal -> refer_out');
assert.strictEqual(mammalReferred.target, null, 'species refer_out clears the dispatch target');
assert.ok(Array.isArray(mammalReferred.referral_targets) && mammalReferred.referral_targets.length === 1,
  'species refer_out attaches the capture referral target');
assert.ok(mammalReferred.reasoning.some(function (r) { return r.indexOf('birds') !== -1; }),
  'species refer_out reasoning names the allowed species');

// birds-only capture + a BIRD call -> passes through (dispatch unchanged).
var birdBase = recommend(dispatchCap, false, 'capture', DEFAULTS);
var birdPassed = applyCountyPolicy(birdBase, chesterBirdsPolicy, 'capture', false, 'bird');
assert.strictEqual(birdPassed.action, 'connecteam_task',
  'birds-only capture + bird -> passes through');
assert.ok(!('referral_targets' in birdPassed),
  'species passthrough carries no referral_targets');

// raptor matches a raptor/waterfowl scope (Lebanon-style birds of prey).
var lebanonPolicy = {
  dispatch_enabled: true,
  allowed_issues: ['capture'],
  species_scope: { capture: ['waterfowl', 'water birds', 'birds of prey'] },
  referral_targets: []
};
var raptorPassed = applyCountyPolicy(
  recommend(dispatchCap, false, 'capture', DEFAULTS), lebanonPolicy, 'capture', false, 'raptor');
assert.strictEqual(raptorPassed.action, 'connecteam_task',
  'raptor matches "birds of prey" scope -> passes through');
var batVsLebanon = applyCountyPolicy(
  recommend(dispatchCap, false, 'capture', DEFAULTS), lebanonPolicy, 'capture', false, 'bat');
assert.strictEqual(batVsLebanon.action, 'refer_out',
  'bat does NOT match waterfowl/raptor scope -> refer_out');

// null species_scope -> never restricts (even a mammal passes through).
var nullScopePolicy = {
  dispatch_enabled: true,
  allowed_issues: ['capture'],
  species_scope: null,
  referral_targets: []
};
var nullScopePassed = applyCountyPolicy(
  recommend(dispatchCap, false, 'capture', DEFAULTS), nullScopePolicy, 'capture', false, 'mammal');
assert.strictEqual(nullScopePassed.action, 'connecteam_task',
  'null species_scope -> mammal passes through (no restriction)');

// Other/Unknown animal type PASSES THROUGH even under a birds-only scope.
var unknownTypePassed = applyCountyPolicy(
  recommend(dispatchCap, false, 'capture', DEFAULTS), chesterBirdsPolicy, 'capture', false, 'other');
assert.strictEqual(unknownTypePassed.action, 'connecteam_task',
  'Other/Unknown animal type passes through under birds-only scope');
// Omitting the animal type entirely also passes through (back-compat).
var omittedTypePassed = applyCountyPolicy(
  recommend(dispatchCap, false, 'capture', DEFAULTS), chesterBirdsPolicy, 'capture', false);
assert.strictEqual(omittedTypePassed.action, 'connecteam_task',
  'omitted animal type passes through (no restriction)');

// species_scope keyed to a DIFFERENT issue does not affect this issue. Chester
// restricts only 'capture'; a transport call has no capture scope to satisfy.
var transportUnderBirds = applyCountyPolicy(
  recommend(cap(bk(0,0), bk(0,0), bk(2,2)), false, 'transport', DEFAULTS),
  chesterBirdsPolicy, 'transport', false, 'mammal');
assert.strictEqual(transportUnderBirds.action, 'connecteam_task',
  'capture-scoped species restriction does not apply to a transport call');

// speciesAllowedByScope helper unit checks.
var speciesAllowedByScope = mod.speciesAllowedByScope;
assert.strictEqual(typeof speciesAllowedByScope, 'function', 'speciesAllowedByScope exported');
assert.strictEqual(speciesAllowedByScope('bird', ['birds']), true, 'bird matches birds');
assert.strictEqual(speciesAllowedByScope('mammal', ['birds']), false, 'mammal does not match birds');
assert.strictEqual(speciesAllowedByScope('other', ['birds']), true, 'unknown species passes through');
assert.strictEqual(speciesAllowedByScope('mammal', null), true, 'null scope allows all');
assert.strictEqual(speciesAllowedByScope('mammal', []), true, 'empty scope allows all');
assert.strictEqual(speciesAllowedByScope('waterfowl', ['waterbirds']), true, 'waterfowl matches waterbirds');
assert.strictEqual(speciesAllowedByScope('bat', ['bats']), true, 'bat matches bats');
passed++;

// ── Referral phone: facilities.json is the SOURCE OF TRUTH ──────────────────
// resolveReferralPhone must prefer facilities.json phones over the
// (spreadsheet-sourced) policy phones, flag discrepancies, and fall back to the
// policy phone only when there is NO facilities match.
var buildFacilityPhoneIndex = mod.buildFacilityPhoneIndex;
var resolveReferralPhone = mod.resolveReferralPhone;
assert.strictEqual(typeof buildFacilityPhoneIndex, 'function', 'buildFacilityPhoneIndex exported');
assert.strictEqual(typeof resolveReferralPhone, 'function', 'resolveReferralPhone exported');

var FACILITIES = [
  { name: 'Raven Ridge Wildlife Center', phone: '7178082652' },
  { name: 'Humane Animal Rescue Wildlife Center', phone: '4123457300' }
];
var NAME_MAP = {
  'Raven Ridge': 'Raven Ridge Wildlife Center',
  'HAR': 'Humane Animal Rescue Wildlife Center'
};
var facIndex = buildFacilityPhoneIndex(FACILITIES, NAME_MAP);

// 1. Exact facilities-name match whose phone DIFFERS from policy -> use
//    facilities phone, flag discrepancy, never the policy phone.
var rrExact = resolveReferralPhone(
  { name: 'Raven Ridge Wildlife Center', phone: '7173274811' }, facIndex);
assert.strictEqual(rrExact.source, 'facilities', 'exact name match resolves to facilities');
assert.strictEqual(rrExact.phone, '7178082652', 'facilities phone wins over policy phone');
assert.strictEqual(rrExact.discrepancy, true, 'phone mismatch flagged as discrepancy');
assert.strictEqual(rrExact.policyPhone, '7173274811', 'policy phone preserved for the flag');

// 2. Alias / short-name match (policy uses "Raven Ridge", facilities uses the
//    canonical name) still resolves via facility_name_map.json.
var rrAlias = resolveReferralPhone({ name: 'Raven Ridge', phone: '7173274811' }, facIndex);
assert.strictEqual(rrAlias.phone, '7178082652', 'alias name resolves to canonical facilities phone');
assert.strictEqual(rrAlias.discrepancy, true, 'alias match still flags the policy discrepancy');

// 3. Matching phone -> facilities source, NO discrepancy flag.
var harMatch = resolveReferralPhone(
  { name: 'Humane Animal Rescue Wildlife Center', phone: '4123457300' }, facIndex);
assert.strictEqual(harMatch.source, 'facilities', 'HAR resolves to facilities');
assert.strictEqual(harMatch.discrepancy, false, 'identical phones -> no discrepancy flag');

// 4. No facilities match (e.g. PA Game Commission) -> fall back to policy phone,
//    source 'policy', no discrepancy.
var pgc = resolveReferralPhone({ name: 'PA Game Commission', phone: '8337429453' }, facIndex);
assert.strictEqual(pgc.source, 'policy', 'unmatched target falls back to policy source');
assert.strictEqual(pgc.phone, '8337429453', 'unmatched target keeps the policy phone');
assert.strictEqual(pgc.discrepancy, false, 'unmatched target is not a discrepancy');

// 5. Null / missing index -> graceful policy-phone passthrough.
var noIndex = resolveReferralPhone({ name: 'Raven Ridge', phone: '7173274811' }, null);
assert.strictEqual(noIndex.source, 'policy', 'null index -> policy source');
assert.strictEqual(noIndex.phone, '7173274811', 'null index -> policy phone verbatim');
passed++;

console.log('OK: ' + passed + ' tests passed');
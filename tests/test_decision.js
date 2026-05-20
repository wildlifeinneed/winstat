/* tests/test_decision.js — Phase 3 table-driven tests for decision.js
 * Run: node tests/test_decision.js
 */
'use strict';

var assert = require('assert');
var path = require('path');
var mod = require(path.resolve(__dirname, '../docs/assets/decision.js'));
var recommend = mod.recommend;
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
    name: 'C3. capture+non-rvs prefers ct_no_rvs bucket for marginal lookup',
    capacity: cap(
      bk(1,1,[{availability_note:'wkends'}]),
      bk(3,3,[]),
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

console.log('OK: ' + passed + ' tests passed');

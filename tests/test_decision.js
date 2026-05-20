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
    name: 'A. missing capacity -> tbd_escalate',
    capacity: undefined, rvs: true, issue: 'capture', cfg: DEFAULTS,
    expect: { action: 'tbd_escalate', target: null, marginal: false }
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

// Spot-check transport-fallback reasoning trace contains the courier-empty note.
var fallbackRec = recommend(
  cap(bk(2,2), bk(0,0), bk(1,0)), true, 'transport', DEFAULTS);
assert.ok(fallbackRec.reasoning.some(function (r) {
  return r.indexOf('courier empty') !== -1;
}), 'transport fallback reasoning should mention courier empty');
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

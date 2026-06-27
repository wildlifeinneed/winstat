'use strict';
/**
 * Pure-logic tests for decision.js: cascade flag, area tier, monitor tier.
 *
 * Run: node test/decision.test.js   (exit 0 = pass, 1 = fail)
 */

const assert = require('assert');
const path = require('path');

const DOCS = path.resolve(__dirname, '..', 'docs', 'assets');
const D = require(path.join(DOCS, 'decision.js'));

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.error('  \u2717 ' + name);
    console.error('    ' + (e.message || e));
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Build a minimal capacity object for recommend().
function cap(ctRvs, ctNoRvs, courier) {
  return {
    ct_rvs: { available: ctRvs, total: ctRvs },
    ct_no_rvs: { available: ctNoRvs, total: ctNoRvs },
    courier: { available: courier, total: courier }
  };
}

// ── County sufficient → cascade is falsy/absent ─────────────────────────────
console.log('\nCascade flag on recommend():');

test('County sufficient (capture, non-RVS) → no cascade', function () {
  var rec = D.recommend(cap(0, 2, 0), false, 'Capture');
  assert.strictEqual(rec.action, 'connecteam_task');
  assert.ok(!rec.cascade, 'cascade should be falsy');
});

test('County sufficient (capture, RVS) → no cascade', function () {
  var rec = D.recommend(cap(2, 0, 0), true, 'Capture');
  assert.strictEqual(rec.action, 'connecteam_task');
  assert.ok(!rec.cascade, 'cascade should be falsy');
});

test('County sufficient (transport) → no cascade', function () {
  var rec = D.recommend(cap(0, 0, 1), false, 'Transport');
  assert.strictEqual(rec.action, 'connecteam_task');
  assert.ok(!rec.cascade, 'cascade should be falsy');
});

// ── County insufficient → cascade=true, action=call_pa_game_comm ────────────
test('County insufficient (capture, non-RVS) → cascade=true', function () {
  var rec = D.recommend(cap(0, 0, 0), false, 'Capture');
  assert.strictEqual(rec.action, 'call_pa_game_comm');
  assert.strictEqual(rec.cascade, true);
});

test('County insufficient (capture, RVS) → cascade=true', function () {
  var rec = D.recommend(cap(0, 0, 0), true, 'Capture');
  assert.strictEqual(rec.action, 'call_pa_game_comm');
  assert.strictEqual(rec.cascade, true);
});

test('County insufficient (transport) → cascade=true', function () {
  var rec = D.recommend(cap(0, 0, 0), false, 'Transport');
  assert.strictEqual(rec.action, 'call_pa_game_comm');
  assert.strictEqual(rec.cascade, true);
});

test('Missing capacity (null) → cascade=true', function () {
  var rec = D.recommend(null, false, 'Capture');
  assert.strictEqual(rec.action, 'call_pa_game_comm');
  assert.strictEqual(rec.cascade, true);
});

// ── Policy refer_out → cascade is falsy (policy overrides) ──────────────────
test('Policy refer_out → no cascade', function () {
  var policy = { dispatch_enabled: false, referral_targets: [] };
  var rec = D.recommend(cap(0, 0, 0), false, 'Capture', null, policy);
  assert.strictEqual(rec.action, 'refer_out');
  assert.ok(!rec.cascade, 'cascade should be falsy after policy override');
});

// ── Unknown issue → no cascade (tbd_escalate) ──────────────────────────────
test('Unknown issue → tbd_escalate, no cascade', function () {
  var rec = D.recommend(cap(1, 1, 1), false, 'SomethingElse');
  assert.strictEqual(rec.action, 'tbd_escalate');
  assert.ok(!rec.cascade, 'cascade should be falsy for unknown issue');
});

// ── recommendAreaTier ───────────────────────────────────────────────────────
console.log('\nrecommendAreaTier():');

test('capture non-RVS: count=2 → pass=true (min=2)', function () {
  var r = D.recommendAreaTier(2, false, 'Capture');
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.min, 2);
  assert.strictEqual(r.count, 2);
});

test('capture non-RVS: count=1 → pass=false', function () {
  var r = D.recommendAreaTier(1, false, 'Capture');
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.min, 2);
});

test('capture RVS: count=2 → pass=true (min=2)', function () {
  var r = D.recommendAreaTier(2, true, 'Capture');
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.min, 2);
});

test('capture RVS: count=1 → pass=false', function () {
  var r = D.recommendAreaTier(1, true, 'Capture');
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.min, 2);
});

test('transport: count=2 → pass=true (min=2)', function () {
  var r = D.recommendAreaTier(2, false, 'Transport');
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.min, 2);
});

test('transport: count=1 → pass=false', function () {
  var r = D.recommendAreaTier(1, false, 'Transport');
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.min, 2);
});

test('unknown issue → pass=false, min=0', function () {
  var r = D.recommendAreaTier(5, false, 'Unknown');
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.min, 0);
});

// ── recommendMonitorTier ────────────────────────────────────────────────────
console.log('\nrecommendMonitorTier():');

test('capture non-RVS: count=2 → pass=true (min=2)', function () {
  var r = D.recommendMonitorTier(2, false, 'Capture');
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.min, 2);
});

test('capture non-RVS: count=1 → pass=false', function () {
  var r = D.recommendMonitorTier(1, false, 'Capture');
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.min, 2);
});

test('capture RVS: count=2 → pass=true (min=2)', function () {
  var r = D.recommendMonitorTier(2, true, 'Capture');
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.min, 2);
});

test('capture RVS: count=1 → pass=false', function () {
  var r = D.recommendMonitorTier(1, true, 'Capture');
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.min, 2);
});

test('transport: count=4 → pass=true (min=4)', function () {
  var r = D.recommendMonitorTier(4, false, 'Transport');
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.min, 4);
});

test('transport: count=3 → pass=false', function () {
  var r = D.recommendMonitorTier(3, false, 'Transport');
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.min, 4);
});

test('unknown issue → pass=false, min=0', function () {
  var r = D.recommendMonitorTier(10, false, 'Blah');
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.min, 0);
});

// ── ACTIONS entries exist ───────────────────────────────────────────────────
console.log('\nACTIONS entries:');

test('dispatch_warning action exists with tone=warn', function () {
  assert.ok(D.ACTIONS.dispatch_warning);
  assert.strictEqual(D.ACTIONS.dispatch_warning.id, 'dispatch_warning');
  assert.strictEqual(D.ACTIONS.dispatch_warning.tone, 'warn');
});

test('dispatcher_decides action exists with tone=decide', function () {
  assert.ok(D.ACTIONS.dispatcher_decides);
  assert.strictEqual(D.ACTIONS.dispatcher_decides.id, 'dispatcher_decides');
  assert.strictEqual(D.ACTIONS.dispatcher_decides.tone, 'decide');
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failed + ' failed.\n');
process.exit(failed > 0 ? 1 : 0);

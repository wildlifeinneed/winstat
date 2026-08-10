'use strict';
/**
 * Regression test: the "Qualified volunteers: N" COUNT shown in the Tier 2
 * recommended-actions area must always equal the number of qualified pins
 * plotted on the Tier 2 map, even when the search returns MORE than
 * OVERFLOW_THRESHOLD (15) qualified volunteers.
 *
 * ROOT CAUSE (owner report): buildTier2Response (worker/src/aggregate.js)
 * builds TWO arrays from the same already-role-qualified `allRows`:
 *   - out_of_county_all -- NEVER truncated. The map pins are sourced from
 *     this (renderTier2Map, docs/assets/dispatcher.js ~4890-4906).
 *   - out_of_county -- truncated to the nearest OVERFLOW_NEAREST (5) once
 *     allRows.length > OVERFLOW_THRESHOLD (15).
 * The Tier 2 "Qualified volunteers: N" line (renderAggregate's R2 leniency
 * block) used to read `agg.out_of_county` (the TRUNCATED array) for its
 * count, so on a >15-qualified search the dispatcher saw "Qualified
 * volunteers: 5" while the map plotted every qualified volunteer (e.g. 22
 * pins). The count under-reported in exactly the direction that risks a
 * volunteer never being called.
 *
 * FIX: the count-driving block now reads out_of_county_all (falling back to
 * out_of_county only when out_of_county_all is absent -- older/cached Worker
 * responses, which were never truncated either, so the fallback is exact).
 *
 * This test does NOT re-implement the logic: it extracts the ACTUAL shipped
 * blocks verbatim from docs/assets/dispatcher.js by marker text (the same
 * technique test/tier2_win_area_qualification.test.js already uses) --
 *   (a) the qualifiedVolRows/pin-source block from renderTier2Map, and
 *   (b) the ooc/qualifiedCount block from renderAggregate's R2 leniency
 *       section (same one that drives the "Qualified volunteers: N" line
 *       and the non-Connecteam notice) --
 * and runs both against the SAME synthetic payload, then asserts the two
 * counts agree. If a future edit reintroduces the truncated array as either
 * source, this test fails.
 *
 * Run: node test/tier2_qualified_count_matches_pins.test.js  (exit 0 = pass)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DISPATCHER_JS = path.resolve(__dirname, '..', 'docs', 'assets', 'dispatcher.js');
const SRC = fs.readFileSync(DISPATCHER_JS, 'utf8');
const MESSAGES_JS = path.resolve(__dirname, '..', 'docs', 'assets', 'messages.js');
const WildlifeDecision = require(path.resolve(__dirname, '..', 'docs', 'assets', 'decision.js'));
const WildlifeMessages = require(MESSAGES_JS);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    console.error('  \u2717 ' + name);
    console.error('    ' + (e.stack || e.message || e));
  }
}

function extractFunctionBody(headerRegex) {
  const m = SRC.match(headerRegex);
  assert.ok(m, 'anchor not found: ' + headerRegex);
  const braceStart = SRC.indexOf('{', m.index + m[0].length - 1);
  assert.ok(braceStart !== -1, 'no opening brace after: ' + headerRegex);
  let depth = 0;
  let i = braceStart;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return SRC.slice(braceStart + 1, i);
}

// ── (a) PIN-SOURCE extraction: the qualifiedVolRows block from renderTier2Map.
// This is the SAME set the map plots pins from (subject to a placeable coord,
// which every synthetic row below provides via `county` + a centroid fixture).
function computeQualifiedVolRows(volSourceAllRows, volSourceOoc, ctx) {
  const body = extractFunctionBody(/function renderTier2Map\(agg, origin, ctx\)/);
  const volSourceBlock = body.match(
    /var volSource = \(agg && Array\.isArray\(agg\.out_of_county_all\)\)[\s\S]*?: \(agg && Array\.isArray\(agg\.out_of_county\) \? agg\.out_of_county : null\);/
  );
  assert.ok(volSourceBlock, 'volSource block extracted from renderTier2Map');
  const qualBlock = body.match(/var qualifiedVolRows = \[\];[\s\S]*?\n    \}\n/);
  assert.ok(qualBlock, 'qualifiedVolRows block extracted from renderTier2Map');

  const fnBody =
    'var qualifyFn = opts.qualifyFn;\n' +
    'var hasBase = opts.hasBase;\n' +
    'var ctx = opts.ctx;\n' +
    'var agg = opts.agg;\n' +
    volSourceBlock[0] + '\n' +
    qualBlock[0] + '\n' +
    'return qualifiedVolRows;\n';

  const runner = new Function('opts', fnBody);
  return runner({
    qualifyFn: WildlifeDecision.qualifiesForAnimal,
    hasBase: true,
    ctx: ctx,
    agg: { out_of_county_all: volSourceAllRows, out_of_county: volSourceOoc },
  });
}

// ── (b) COUNT extraction: the ooc/qualifiedCount block from renderAggregate's
// R2 leniency section -- the SAME block that drives the "Qualified
// volunteers: N" action line and the non-Connecteam notice.
function computeAggregateCounts(aggFields, ctx) {
  const body = extractFunctionBody(/function renderAggregate\(agg, ctx\)/);

  const oocBlock = body.match(
    /var ooc = \(agg && Array\.isArray\(agg\.out_of_county_all\)\)[\s\S]*?: \(\(agg && Array\.isArray\(agg\.out_of_county\)\) \? agg\.out_of_county : null\);/
  );
  assert.ok(oocBlock, 'ooc source-selection block extracted from renderAggregate');
  const truncBlock = body.match(/var oocListTruncated = !!\(agg[\s\S]*?\);\n/);
  assert.ok(truncBlock, 'oocListTruncated block extracted from renderAggregate');
  const shownBlock = body.match(/var oocShownCount = \(agg[\s\S]*?: 0;\n/);
  assert.ok(shownBlock, 'oocShownCount block extracted from renderAggregate');
  const leniencyBlock = body.match(
    /if \(qualifyFn && ooc && ctx[\s\S]*?leniencyQualifiedCount = qualifiedCount;\n/
  );
  assert.ok(leniencyBlock, 'leniency qualifiedCount/backupCount block extracted from renderAggregate');

  const fnBody =
    'var qualifyFn = opts.qualifyFn;\n' +
    'var agg = opts.agg;\n' +
    'var ctx = opts.ctx;\n' +
    'var leniencyQualifiedCount = 0;\n' +
    oocBlock[0] + '\n' +
    truncBlock[0] + '\n' +
    shownBlock[0] + '\n' +
    'var qualifiedCount = 0;\n' +
    'var backupCount = 0;\n' +
    'var qualifiedRows = [];\n' +
    leniencyBlock[0] + '\n' +
    '}\n' + // closes the extracted "if (qualifyFn && ooc && ctx ...) {" block verbatim from source
    'return { qualifiedCount: qualifiedCount, backupCount: backupCount, ' +
    'qualifiedRows: qualifiedRows, oocListTruncated: oocListTruncated, ' +
    'oocShownCount: oocShownCount };\n';

  const runner = new Function('opts', fnBody);
  return runner({
    qualifyFn: WildlifeDecision.qualifiesForAnimal,
    agg: aggFields,
    ctx: ctx,
  });
}

// ── Fixture: 22 qualified (C&T/RVS C&T) volunteers spread across counties,
// exceeding OVERFLOW_THRESHOLD (15) so the Worker would truncate
// out_of_county to the nearest 5 while out_of_county_all keeps all 22.
// A handful are marked connecteam_user:false to exercise the non-Connecteam
// notice with the same full-set semantics.
function buildOverflowRows(n) {
  const counties = ['Beaver', 'Butler', 'Westmoreland', 'Allegheny', 'Fayette'];
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      roles: (i % 3 === 0) ? ['RVS C&T'] : ['C&T'],
      distance_mi: 5 + i,
      win_area: String(10 + (i % 3)),
      county: counties[i % counties.length],
      connecteam_user: (i % 7 === 0) ? false : true,
    });
  }
  return rows;
}

console.log('Overflow scenario (22 qualified volunteers, OVERFLOW_THRESHOLD=15, OVERFLOW_NEAREST=5):');

test('count (from out_of_county_all) equals pin count (also from out_of_county_all), NOT the truncated 5', () => {
  const allRows = buildOverflowRows(22);
  const truncated = allRows.slice(0, 5); // mirrors the Worker's OVERFLOW_NEAREST cap
  const ctx = { rvs: false, issue: 'capture', radius: 60 };

  const pinRows = computeQualifiedVolRows(allRows, truncated, ctx);
  const counts = computeAggregateCounts(
    { out_of_county_all: allRows, out_of_county: truncated, radius_too_broad: true, out_of_county_truncated: true },
    ctx
  );

  assert.strictEqual(pinRows.length, 22, 'sanity: 22 qualified rows produce 22 map pins');
  assert.strictEqual(counts.qualifiedCount, 22,
    'the "Qualified volunteers" count must be 22, matching pin count (NOT the truncated 5)');
  assert.strictEqual(counts.qualifiedCount, pinRows.length,
    'count and pin count are numerically equal');
  assert.notStrictEqual(counts.qualifiedCount, truncated.length,
    'count must NOT equal the truncated list length (5) -- this is the exact bug being guarded');
});

test('non-Connecteam count is also drawn from the full set, not the truncated 5', () => {
  const allRows = buildOverflowRows(22);
  const truncated = allRows.slice(0, 5);
  const ctx = { rvs: false, issue: 'capture', radius: 60 };
  const expectedNonCt = allRows.filter((r) => r.connecteam_user === false).length;
  const truncatedNonCt = truncated.filter((r) => r.connecteam_user === false).length;

  const counts = computeAggregateCounts(
    { out_of_county_all: allRows, out_of_county: truncated, radius_too_broad: true, out_of_county_truncated: true },
    ctx
  );
  const nonCtCount = counts.qualifiedRows.filter((r) => r.connecteam_user === false).length;

  assert.ok(expectedNonCt > truncatedNonCt,
    'sanity: the fixture actually has more non-Connecteam volunteers than the truncated slice would show');
  assert.strictEqual(nonCtCount, expectedNonCt,
    'non-Connecteam count must reflect the FULL qualified set (got ' + nonCtCount + ', expected ' + expectedNonCt + ')');
});

test('truncation flag is true (list is capped) even though the count/pins are complete', () => {
  const allRows = buildOverflowRows(22);
  const truncated = allRows.slice(0, 5);
  const ctx = { rvs: false, issue: 'capture', radius: 60 };
  const counts = computeAggregateCounts(
    { out_of_county_all: allRows, out_of_county: truncated, radius_too_broad: true, out_of_county_truncated: true },
    ctx
  );
  assert.strictEqual(counts.oocListTruncated, true, 'oocListTruncated must be true when the Worker flagged overflow');
  assert.strictEqual(counts.oocShownCount, 5, 'oocShownCount reflects the capped list length (5)');
});

console.log('\nNormal (<=15 qualified) scenario -- no truncation:');

test('count equals pin count when qualified volunteers are within OVERFLOW_THRESHOLD (no truncation)', () => {
  const allRows = buildOverflowRows(9); // under the 15 threshold
  const ctx = { rvs: false, issue: 'capture', radius: 60 };

  const pinRows = computeQualifiedVolRows(allRows, allRows, ctx);
  const counts = computeAggregateCounts(
    { out_of_county_all: allRows, out_of_county: allRows, radius_too_broad: false, out_of_county_truncated: false },
    ctx
  );

  assert.strictEqual(pinRows.length, 9, 'sanity: 9 qualified rows produce 9 map pins');
  assert.strictEqual(counts.qualifiedCount, 9, 'count matches pin count in the non-overflow case too');
  assert.strictEqual(counts.qualifiedCount, pinRows.length, 'count and pin count are numerically equal');
});

test('truncation flag is false and no caveat is added when the search is not overflowing', () => {
  const allRows = buildOverflowRows(9);
  const ctx = { rvs: false, issue: 'capture', radius: 60 };
  const counts = computeAggregateCounts(
    { out_of_county_all: allRows, out_of_county: allRows, radius_too_broad: false, out_of_county_truncated: false },
    ctx
  );
  assert.strictEqual(counts.oocListTruncated, false, 'oocListTruncated must be false when the Worker did not flag overflow');
});

console.log('\nGuardrail -- out_of_county_all absent (older/cached Worker payload):');

test('falls back safely to out_of_county with no crash and no fabricated zero, when out_of_county_all is missing', () => {
  const rows = buildOverflowRows(4); // an older, never-truncated shape (no _all field at all)
  const ctx = { rvs: false, issue: 'capture', radius: 60 };
  const counts = computeAggregateCounts(
    { out_of_county: rows }, // out_of_county_all intentionally absent; no truncation fields either
    ctx
  );
  assert.strictEqual(counts.qualifiedCount, 4,
    'falls back to out_of_county and counts correctly (no crash, no zero)');
  assert.strictEqual(counts.oocListTruncated, false,
    'oocListTruncated is false when out_of_county_all is absent (never fabricates a truncation caveat it cannot back up)');
});

console.log('\nCopy -- truncation caveat message lives in messages.js and is wired into the count line:');

test('messages.js defines qualifiedHelpersTruncatedNote with {shown} and {count} tokens', () => {
  assert.ok(/qualifiedHelpersTruncatedNote\s*:/.test(fs.readFileSync(MESSAGES_JS, 'utf8')),
    'messages.js defines qualifiedHelpersTruncatedNote');
  const T2 = WildlifeMessages.messages.tier2Aggregate;
  assert.ok(T2 && typeof T2.qualifiedHelpersTruncatedNote === 'string', 'key resolves to a string');
  assert.ok(/\{shown\}/.test(T2.qualifiedHelpersTruncatedNote), 'contains {shown} token');
  assert.ok(/\{count\}/.test(T2.qualifiedHelpersTruncatedNote), 'contains {count} token');
});

test('renderAggregate appends the truncation caveat directly to the qualifiedHelpers action line (not a separate collapsed panel)', () => {
  const body = extractFunctionBody(/function renderAggregate\(agg, ctx\)/);
  assert.ok(
    /actions\.push\(actionLine\('go', '\u2192', fmt\(T2\.qualifiedHelpers, \{[\s\S]*?\}\) \+ qTruncTxt\)\)/.test(body),
    'the qualifiedHelpers action-line concatenates qTruncTxt onto the SAME line'
  );
});

console.log('\n' + '-'.repeat(40));
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}

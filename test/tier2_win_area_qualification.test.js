'use strict';
/**
 * Regression test for the Tier-2 Leaflet base-map WIN-area highlight.
 *
 * OWNER BUG REPORT: "the other minor issue for the tier2 base map is to only
 * highlight the WIN areas on the map that house qualified volunteers within
 * the search radius ... now it appears to highlight areas that house any
 * found volunteer in that area."
 *
 * ROOT CAUSE: renderTier2Map() (docs/assets/dispatcher.js) used to shade WIN
 * areas straight from `agg.win_areas` -- a Worker aggregate computed over
 * EVERY in-radius volunteer regardless of role (C&T / RVS C&T / COURIER all
 * counted) and regardless of availability. That is a DIFFERENT, wider set
 * than the qualified-only rows the map's own volunteer pins and the
 * "qualified volunteers" list already use (both filtered via the shared
 * `qualifiesForAnimal` predicate). A COURIER-only volunteer could therefore
 * light up an area for a non-transport (capture) request where couriers do
 * not qualify.
 *
 * FIX: the shaded WIN areas are now derived from the SAME qualified rows
 * (`qualifiedVolRows`) the pins/list use -- available AND unavailable
 * volunteers both count toward a highlight (availability is a dim/label
 * treatment elsewhere, never a membership gate -- matching
 * renderContextList's existing, owner-accepted behavior).
 *
 * This test extracts the exact shipped qualification + winAreas-derivation
 * logic from renderTier2Map by marker text (verbatim, not paraphrased) and
 * exercises it against synthetic rows shaped like the owner's real
 * Punxsutawney/60mi/non-RVS-capture query (role mix reproduced from a live
 * worker query; no volunteer names/addresses/phone numbers).
 *
 * Run: node test/tier2_win_area_qualification.test.js   (exit 0 = pass, 1 = fail)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DISPATCHER_JS = path.resolve(__dirname, '..', 'docs', 'assets', 'dispatcher.js');
const SRC = fs.readFileSync(DISPATCHER_JS, 'utf8');

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

// ── Structural check: the map no longer sources highlighting from the ──────
//    unfiltered agg.win_areas aggregate.
console.log('Structural -- renderTier2Map no longer highlights from the unfiltered aggregate:');
test('renderTier2Map does not read agg.win_areas directly for the winAreas variable', () => {
  const fnStart = SRC.indexOf('function renderTier2Map(agg, origin, ctx)');
  assert.ok(fnStart !== -1, 'renderTier2Map found');
  const braceStart = SRC.indexOf('{', fnStart);
  let depth = 0, i = braceStart;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const body = SRC.slice(braceStart + 1, i);
  assert.strictEqual(
    /var winAreas = \(agg && Array\.isArray\(agg\.win_areas\)\)/.test(body),
    false,
    'the old unfiltered-aggregate read must be gone'
  );
  assert.ok(/qualifiedVolRows\.forEach\(function \(row\) \{\s*var area = row && row\.win_area;/.test(body),
    'winAreas is now derived from qualifiedVolRows (qualified-only rows)');
});

test('qualifiedVolRows is computed independent of SHOW_VOLUNTEER_MARKERS (privacy kill-switch must not blank area shading)', () => {
  const fnStart = SRC.indexOf('function renderTier2Map(agg, origin, ctx)');
  const braceStart = SRC.indexOf('{', fnStart);
  let depth = 0, i = braceStart;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const body = SRC.slice(braceStart + 1, i);
  const qualBlock = body.match(/var qualifiedVolRows = \[\];[\s\S]*?\n    \}\n/);
  assert.ok(qualBlock, 'qualifiedVolRows computation block found');
  assert.strictEqual(/SHOW_VOLUNTEER_MARKERS/.test(qualBlock[0]), false,
    'qualifiedVolRows computation must not be gated by SHOW_VOLUNTEER_MARKERS');
});

// ── Extraction helpers ──────────────────────────────────────────────────────
function extractFunctionBody(src, headerRegex) {
  const m = src.match(headerRegex);
  assert.ok(m, 'anchor not found: ' + headerRegex);
  const braceStart = src.indexOf('{', m.index + m[0].length - 1);
  assert.ok(braceStart !== -1, 'no opening brace after: ' + headerRegex);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(braceStart + 1, i);
}

const WildlifeDecision = require(path.resolve(__dirname, '..', 'docs', 'assets', 'decision.js'));

// Build a runnable version of the exact shipped qualifiedVolRows + winAreas
// derivation (extracted verbatim from renderTier2Map by markers), so a
// regression in the real source is caught here.
function computeQualifiedWinAreas(volSource, ctx) {
  const fnStart = SRC.indexOf('function renderTier2Map(agg, origin, ctx)');
  const braceStart = SRC.indexOf('{', fnStart);
  let depth = 0, i = braceStart;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const body = SRC.slice(braceStart + 1, i);

  const qualBlockMatch = body.match(/var qualifiedVolRows = \[\];[\s\S]*?\n    \}\n/);
  assert.ok(qualBlockMatch, 'qualifiedVolRows block extracted');
  const winAreasBlockMatch = body.match(/var winAreaSet = \{\};[\s\S]*?var winAreas = Object\.keys\(winAreaSet\);/);
  assert.ok(winAreasBlockMatch, 'winAreas block extracted');

  const fnBody =
    'var qualifyFn = opts.qualifyFn;\n' +
    'var hasBase = opts.hasBase;\n' +
    'var ctx = opts.ctx;\n' +
    'var volSource = opts.volSource;\n' +
    qualBlockMatch[0] + '\n' +
    winAreasBlockMatch[0] + '\n' +
    'return { qualifiedVolRows: qualifiedVolRows, winAreas: winAreas };\n';

  const runner = new Function('opts', fnBody);
  return runner({
    qualifyFn: WildlifeDecision.qualifiesForAnimal,
    hasBase: true,
    ctx: ctx,
    volSource: volSource,
  });
}

// ── Owner scenario reproduction ─────────────────────────────────────────────
// Role mix reproduced from a live worker query for Woodland Avenue,
// Punxsutawney PA 15767 @ 60mi (role_counts: C&T=3, RVS C&T=8, COURIER=26).
// Synthetic rows below keep the SAME area/role SHAPE that produced win_areas
// [1,10,11,2,5,6,7] on the unfiltered aggregate, with only areas 5/7/10/11
// actually holding a C&T or RVS C&T volunteer (matching the live
// out_of_county_all result). No volunteer names/addresses/phone numbers.
function buildPunxsutawneyRows() {
  return [
    { roles: ['COURIER'], win_area: '1', county: 'Clarion', available: true },
    { roles: ['COURIER'], win_area: '2', county: 'Armstrong', available: true },
    { roles: ['C&T'], win_area: '5', county: 'Cambria', available: true },
    { roles: ['COURIER'], win_area: '6', county: 'Somerset', available: true },
    { roles: ['RVS C&T'], win_area: '7', county: 'Centre', available: true },
    { roles: ['RVS C&T'], win_area: '10', county: 'Allegheny', available: true },
    // Area 11's ONLY qualifying (C&T/RVS C&T) volunteer is UNAVAILABLE --
    // this must still count as a highlight (availability != qualification).
    { roles: ['RVS C&T'], win_area: '11', county: 'Westmoreland', available: false },
    { roles: ['COURIER'], win_area: '11', county: 'Westmoreland', available: true },
  ];
}

console.log('\nOwner scenario -- Woodland Ave, Punxsutawney PA 15767 @ 60mi, non-RVS capture:');
test('BEFORE (unfiltered aggregate semantics): all 7 areas with ANY volunteer would show', () => {
  const rows = buildPunxsutawneyRows();
  const allAreas = Array.from(new Set(rows.map((r) => r.win_area))).sort();
  assert.deepStrictEqual(allAreas, ['1', '10', '11', '2', '5', '6', '7'],
    'sanity: synthetic fixture reproduces the 7-area unfiltered shape from the live query');
});

test('AFTER (fix): only areas with a C&T/RVS C&T qualified volunteer highlight (COURIER-only areas 1,2,6 drop out)', () => {
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'capture' };
  const result = computeQualifiedWinAreas(rows, ctx);
  const sortedAreas = result.winAreas.slice().sort();
  assert.deepStrictEqual(sortedAreas, ['10', '11', '5', '7'],
    'expected qualified-only win areas [5,7,10,11], got ' + JSON.stringify(sortedAreas));
  assert.strictEqual(sortedAreas.indexOf('1'), -1, 'area 1 (COURIER-only) must NOT highlight for a capture request');
  assert.strictEqual(sortedAreas.indexOf('2'), -1, 'area 2 (COURIER-only) must NOT highlight for a capture request');
  assert.strictEqual(sortedAreas.indexOf('6'), -1, 'area 6 (COURIER-only) must NOT highlight for a capture request');
});

test('area 11 still highlights even though its only qualifying volunteer is UNAVAILABLE (availability is not a membership gate)', () => {
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'capture' };
  const result = computeQualifiedWinAreas(rows, ctx);
  assert.ok(result.winAreas.indexOf('11') !== -1,
    'area 11 must still highlight: it has a qualified (RVS C&T) volunteer, unavailability is a dim/label concern, not exclusion');
});

test('transport request: COURIER now qualifies, so areas 1/2/6 (courier-only) DO highlight (issue-aware, not a blanket courier ban)', () => {
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'transport' };
  const result = computeQualifiedWinAreas(rows, ctx);
  const sortedAreas = result.winAreas.slice().sort();
  assert.deepStrictEqual(sortedAreas, ['1', '10', '11', '2', '5', '6', '7'],
    'transport qualifies C&T + RVS C&T + COURIER, so all 7 areas highlight -- proves the filter is issue-aware');
});

test('no qualifying volunteer anywhere -> zero areas highlight (no false "help available" signal)', () => {
  const rows = [
    { roles: ['COURIER'], win_area: '1', county: 'Clarion', available: true },
    { roles: ['COURIER'], win_area: '2', county: 'Armstrong', available: true },
  ];
  const ctx = { rvs: false, issue: 'capture' };
  const result = computeQualifiedWinAreas(rows, ctx);
  assert.deepStrictEqual(result.winAreas, [], 'no C&T/RVS C&T volunteer anywhere -> no highlighted areas');
});

console.log('\n' + '-'.repeat(40));
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}

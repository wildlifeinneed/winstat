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
  // TARGET WIN area derivation (RULE A, new): the WIN area containing the
  // animal address (agg.animal_area), extracted verbatim so a regression in
  // the real source is caught here too.
  const targetAreaBlockMatch = body.match(/var targetArea = \(agg[\s\S]*?: null;/);
  assert.ok(targetAreaBlockMatch, 'targetArea block extracted');

  const fnBody =
    'var qualifyFn = opts.qualifyFn;\n' +
    'var hasBase = opts.hasBase;\n' +
    'var ctx = opts.ctx;\n' +
    'var volSource = opts.volSource;\n' +
    'var agg = opts.agg;\n' +
    qualBlockMatch[0] + '\n' +
    winAreasBlockMatch[0] + '\n' +
    targetAreaBlockMatch[0] + '\n' +
    'return { qualifiedVolRows: qualifiedVolRows, winAreas: winAreas, targetArea: targetArea };\n';

  const runner = new Function('opts', fnBody);
  return runner({
    qualifyFn: WildlifeDecision.qualifiesForAnimal,
    hasBase: true,
    ctx: ctx,
    volSource: volSource,
    agg: (ctx && ctx.agg) || null,
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

// ── RULE A (new): the TARGET WIN area (where the animal address is) must ──
//    ALWAYS be highlighted, regardless of qualified/any/available volunteers.
console.log('\nRULE A -- target WIN area (agg.animal_area) always highlights:');

test('targetArea is derived from agg.animal_area (the Worker point-in-polygon result), not re-derived client-side', () => {
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'capture', agg: { animal_area: '11' } };
  const result = computeQualifiedWinAreas(rows, ctx);
  assert.strictEqual(result.targetArea, '11', 'targetArea must equal agg.animal_area verbatim');
});

test('edge case: address OUTSIDE every WIN area polygon (agg.animal_area null) -> no target highlight, no crash', () => {
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'capture', agg: { animal_area: null } };
  const result = computeQualifiedWinAreas(rows, ctx);
  assert.strictEqual(result.targetArea, null, 'targetArea must be null when the Worker found no containing polygon');
});

test('edge case: agg missing entirely -> targetArea is null (no crash on undefined agg)', () => {
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'capture' }; // no ctx.agg at all
  const result = computeQualifiedWinAreas(rows, ctx);
  assert.strictEqual(result.targetArea, null, 'targetArea must be null, not throw, when agg is absent');
});

test('edge case: target area has ZERO volunteers of any kind -> targetArea is still populated (union happens in drawWinAreaBoundaries, not gated by qualifiedVolRows)', () => {
  // Area '99' never appears in any volunteer row.
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'capture', agg: { animal_area: '99' } };
  const result = computeQualifiedWinAreas(rows, ctx);
  assert.strictEqual(result.targetArea, '99', 'targetArea must resolve independent of whether any volunteer sits in it');
  assert.strictEqual(result.winAreas.indexOf('99'), -1, 'sanity: area 99 correctly has no QUALIFIED volunteer of its own');
});

test('blank-string agg.animal_area is treated the same as null (never renders an empty-string highlight)', () => {
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'capture', agg: { animal_area: '   ' } };
  const result = computeQualifiedWinAreas(rows, ctx);
  assert.strictEqual(result.targetArea, null, 'whitespace-only animal_area must normalize to null');
});

// ── drawWinAreaBoundaries: union + single-render + distinct styling ────────
// Extract the real shipped function verbatim (not paraphrased) and run it
// against a mocked Leaflet + county GeoJSON so a regression in the actual
// union/no-double-draw/style logic is caught here.
function extractDrawWinAreaBoundaries() {
  const header = /function drawWinAreaBoundaries\(areas, targetArea\)/;
  const m = SRC.match(header);
  assert.ok(m, 'drawWinAreaBoundaries(areas, targetArea) found');
  const braceStart = SRC.indexOf('{', m.index + m[0].length - 1);
  let depth = 0, i = braceStart;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  return SRC.slice(braceStart + 1, i);
}

function runDrawWinAreaBoundaries(areas, targetArea, geojsonFeatures) {
  const body = extractDrawWinAreaBoundaries();
  const drawnPolys = []; // { area, isTarget, options, tooltipText, tooltipClass }

  // Minimal Leaflet mock: L.polygon(...) returns a chainable poly object.
  const L = {
    polygon: function (latlngs, options) {
      var poly = {
        options: options,
        addTo: function () { return poly; },
        bindTooltip: function (text, opts) {
          poly.tooltipText = text;
          poly.tooltipClass = opts && opts.className;
          return poly;
        },
        getBounds: function () {
          return { isValid: function () { return true; }, getSouth: function () { return 0; }, getWest: function () { return 0; }, getNorth: function () { return 1; }, getEast: function () { return 1; } };
        }
      };
      return poly;
    }
  };
  const t2map = { instance: {}, layers: { winArea: { clearLayers: function () {} } } };
  const state = { geojson: { features: geojsonFeatures } };
  function geojsonToLatLngs() { return [[[[0, 0], [0, 1], [1, 1]]]]; }
  function areaColor(area) { return '#5bbf5b'; }
  function darkenColor(hex) { return '#123456'; }
  function escapeHtml(s) { return String(s); }

  const fnBody =
    'var areas = opts.areas;\n' +
    'var targetArea = opts.targetArea;\n' +
    'var t2map = opts.t2map;\n' +
    'var state = opts.state;\n' +
    'var L = opts.L;\n' +
    'var geojsonToLatLngs = opts.geojsonToLatLngs;\n' +
    'var areaColor = opts.areaColor;\n' +
    'var darkenColor = opts.darkenColor;\n' +
    'var escapeHtml = opts.escapeHtml;\n' +
    'var __capturedPolys = opts.__capturedPolys;\n' +
    // Capture a record referencing the REAL poly object returned by
    // L.polygon (assigned right after the call), so options/tooltip set via
    // later chained calls (bindTooltip) are visible on the same record the
    // test inspects -- not a snapshot taken before those calls ran.
    body.replace(
      'var poly = L.polygon(byArea[area].latlngs, {',
      'var __rec = { area: area, isTarget: isTarget };\n      __capturedPolys.push(__rec);\n      var poly = L.polygon(byArea[area].latlngs, {'
    ).replace(
      '}).addTo(t2map.layers.winArea);',
      '}).addTo(t2map.layers.winArea);\n      __rec.options = poly.options;'
    ).replace(
      "className: 't2-area-label'\n      });",
      "className: 't2-area-label'\n      });\n      __rec.tooltipText = poly.tooltipText;\n      __rec.tooltipClass = poly.tooltipClass;"
    );

  const runner = new Function('opts', fnBody);
  const pts = runner({
    areas: areas, targetArea: targetArea, t2map: t2map, state: state, L: L,
    geojsonToLatLngs: geojsonToLatLngs, areaColor: areaColor, darkenColor: darkenColor,
    escapeHtml: escapeHtml, __capturedPolys: drawnPolys,
  });
  return { pts: pts, drawnPolys: drawnPolys };
}

function fakeAreaFeature(area) {
  return { type: 'Feature', properties: { win_area: area }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } };
}

console.log('\ndrawWinAreaBoundaries -- union + no double-render (fc18d94 behavior, styling reverted):');

test('target area with ZERO qualified volunteers still gets drawn (union)', () => {
  const geo = [fakeAreaFeature('5'), fakeAreaFeature('99')];
  const { drawnPolys } = runDrawWinAreaBoundaries(['5'], '99', geo);
  const areasDrawn = drawnPolys.map((p) => p.area).sort();
  assert.deepStrictEqual(areasDrawn, ['5', '99'], 'both the qualified area (5) and the target area (99) must be drawn');
});

test('target area already in the qualified set renders EXACTLY ONCE (no double-draw)', () => {
  const geo = [fakeAreaFeature('5'), fakeAreaFeature('11')];
  const { drawnPolys } = runDrawWinAreaBoundaries(['5', '11'], '11', geo);
  const area11Draws = drawnPolys.filter((p) => p.area === '11');
  assert.strictEqual(area11Draws.length, 1, 'area 11 (qualified AND target) must be drawn exactly once, got ' + area11Draws.length);
  assert.strictEqual(area11Draws[0].isTarget, true, 'the single area-11 render must carry the target flag');
});

test('null targetArea (address outside every polygon) draws only the qualified areas, no crash', () => {
  const geo = [fakeAreaFeature('5'), fakeAreaFeature('7')];
  const { drawnPolys } = runDrawWinAreaBoundaries(['5', '7'], null, geo);
  const areasDrawn = drawnPolys.map((p) => p.area).sort();
  assert.deepStrictEqual(areasDrawn, ['5', '7'], 'no target area -> only qualified areas draw');
  assert.ok(drawnPolys.every((p) => p.isTarget === false), 'no polygon should be flagged isTarget when targetArea is null');
});

// Owner rejected the fc18d94 dashed-black/"(target)" treatment on the live
// map ("why did you change the area lines to dotted" / "dont need (target)
// tag"): when the target area was the only area shown, the whole map read as
// dashed, and the animal pin already identifies the target area, making the
// extra visual distinction redundant. This test locks the REVERTED contract:
// the target polygon must render with the EXACT SAME style object as a plain
// qualified polygon (no color/weight/dashArray difference), while `isTarget`
// itself is still computed (verified above) so the ALWAYS-HIGHLIGHT behavior
// is untouched.
test('target-area polygon renders with the SAME style as a plain qualified area (fc18d94 dashed/target styling reverted)', () => {
  const geo = [fakeAreaFeature('5'), fakeAreaFeature('11')];
  const { drawnPolys } = runDrawWinAreaBoundaries(['5'], '11', geo);
  const target = drawnPolys.find((p) => p.area === '11');
  const plain = drawnPolys.find((p) => p.area === '5');
  assert.ok(target, 'target polygon captured');
  assert.ok(plain, 'plain qualified polygon captured');
  assert.strictEqual(target.isTarget, true, 'isTarget flag itself is still computed (union/always-highlight behavior unchanged)');
  assert.strictEqual(plain.isTarget, false);
  assert.strictEqual(target.options.color, plain.options.color, 'target and plain areas must share the same border color');
  assert.strictEqual(target.options.weight, plain.options.weight, 'target and plain areas must share the same border weight');
  assert.strictEqual(target.options.dashArray, undefined, 'target polygon must NOT have a dashArray (no dashed border)');
  assert.strictEqual(target.tooltipText, 'WIN Area 11', 'target label must NOT carry a "(target)" suffix');
  assert.strictEqual(target.tooltipClass, 't2-area-label', 'target tooltip must use the plain t2-area-label class, no target-specific class');
});

test('empty areas + null targetArea draws nothing (no stray polygons)', () => {
  const geo = [fakeAreaFeature('5')];
  const { drawnPolys, pts } = runDrawWinAreaBoundaries([], null, geo);
  assert.deepStrictEqual(drawnPolys, [], 'nothing should be drawn');
  assert.deepStrictEqual(pts, [], 'no bounds points either');
});

// ── RULE B (verify, lock): availability must NEVER gate WIN-area highlight ─
//    qualification or volunteer PIN visibility. Premise: e4ef00d already made
//    qualification role-based and availability-independent. This section
//    locks that as a regression-tested contract per the owner's directive.
console.log('\nRULE B (verified, locked) -- availability never gates highlighting or pin visibility:');

test('qualifiedVolRows filter block does not reference availability/available/availability_note at all', () => {
  const fnStart = SRC.indexOf('function renderTier2Map(agg, origin, ctx)');
  const braceStart = SRC.indexOf('{', fnStart);
  let depth = 0, i = braceStart;
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const body = SRC.slice(braceStart + 1, i);
  const qualBlock = body.match(/var qualifiedVolRows = \[\];[\s\S]*?\n    \}\n/)[0];
  assert.strictEqual(/\bavailable\b/.test(qualBlock), false,
    'the qualified-rows filter (which drives BOTH pins and WIN-area highlighting) must not read "available" anywhere');
});

test('an area whose ONLY qualified volunteer is unavailable still highlights (area 11 lock, re-asserted for Rule A regression safety)', () => {
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'capture' };
  const result = computeQualifiedWinAreas(rows, ctx);
  assert.ok(result.winAreas.indexOf('11') !== -1, 'area 11 must highlight: qualification is role-based only');
});

test('that same unavailable qualified volunteer STILL appears in qualifiedVolRows (pin is rendered, dimmed, never dropped)', () => {
  const rows = buildPunxsutawneyRows();
  const ctx = { rvs: false, issue: 'capture' };
  const result = computeQualifiedWinAreas(rows, ctx);
  const area11Rows = result.qualifiedVolRows.filter((r) => r.win_area === '11');
  assert.strictEqual(area11Rows.length, 1, 'exactly one qualified row for area 11 (the unavailable RVS C&T volunteer)');
  assert.strictEqual(area11Rows[0].available, false, 'row must be present WITH available:false, not filtered out -- pin renders dimmed, not absent');
});

test('the volunteer-marker "available" flag computation (data-prep block) is untouched by Rule A changes and still only affects pin dim/label, never inclusion', () => {
  assert.ok(/available: row\.available !== false && !isUnavailNote\(/.test(SRC),
    'the availability computation for pin dimming must still exist verbatim (no regression from Rule A edits)');
  // Confirm it lives in the per-row PUSH block (pins), never inside a
  // filter/return that could drop a row from qualifiedVolRows or winAreaSet.
  const pushBlockStart = SRC.indexOf('volunteers.push({');
  const qualFilterIdx = SRC.indexOf('qualifiedVolRows = qualifiedVolRows.filter(');
  assert.ok(pushBlockStart > qualFilterIdx, 'availability dimming must be computed AFTER qualification filtering, in the pin-push block, not inside the qualification filter itself');
});

console.log('\n' + '-'.repeat(40));
console.log('Total: ' + (passed + failed) + '  Passed: ' + passed + '  Failed: ' + failed);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
}

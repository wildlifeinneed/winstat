/* messages.js — SINGLE SOURCE OF TRUTH for the dispatcher's user-facing wording
 * and tunable thresholds.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO EDIT SAFELY (read this before changing anything):
 *
 *  • This file holds TWO kinds of values:
 *      1. WORDING  — every sentence/label the dispatcher shows a human. These
 *                    live under M.tier1Actions, M.tier2Aggregate, M.coordinator,
 *                    M.geocodeErrors, and M.staticUi. EDIT THESE FREELY to change
 *                    what the page says. The decision logic does NOT depend on
 *                    the exact text — only on which KEY is chosen.
 *      2. THRESHOLDS — the numeric tuning knobs under M.thresholds. These change
 *                    BEHAVIOR (when the app escalates to PA Game Commission, when
 *                    a "Marginal" badge appears). Change the NUMBERS only; do not
 *                    rename keys.
 *
 *  • PLACEHOLDERS: some wording contains tokens like {count}, {area}, {areas},
 *    {name}, {radius}, {county}, {phone}, {role}, {label}. At render time the
 *    code calls fmt(template, {count: 3, ...}) and the token is replaced with the
 *    value. KEEP the tokens (spelled exactly) when you reword — dropping a token
 *    just drops that value from the sentence; inventing a new token does nothing.
 *
 *  • PGC_PHONE is the PA Game Commission dispatch line. It appears in several
 *    messages AND in the page footer. It is defined ONCE here so there is a
 *    single place to update it. Reword the sentences around it as you like, but
 *    leave the {phone} token where the number should appear.
 *
 *  • DO NOT add logic here. This is data only. Pluralization, distance math,
 *    and branch selection stay in decision.js / dispatcher.js.
 *
 *  • Both decision.js and dispatcher.js read THIS object. Loaded as a plain
 *    <script> (browser) and via require()/eval (Node tests) — no fetch, so it
 *    works on file:// with no CORS concerns.
 * ─────────────────────────────────────────────────────────────────────────
 */
(function (root) {
  'use strict';

  // ── ONE source of truth for the PA Game Commission dispatch line ──────────
  // Used by dispatcher.js messages AND injected into the page footer note.
  var PGC_PHONE = '(833) 742-4868 or (833) 742-9453';

  var M = {
    // Exposed so other modules and the footer can read the single phone value.
    pgcPhone: PGC_PHONE,

    // ── THRESHOLDS (NUMERIC — these change behavior) ───────────────────────
    // Relocated verbatim from decision.js DEFAULTS / dispatcher.js DEFAULT_CONFIG.
    // These are the FALLBACK defaults used when data/config.json does not supply
    // a value; data/config.json (and its per-county overrides) still wins when present.
    thresholds: {
      // Cards show a low-capacity warning + roster when available <= this.
      marginal_threshold: 1,
      // If available_count for that bucket is < this, recommend calling PGC
      // instead of dispatching a Connecteam task.
      ct_rvs_capture_min_available: 1,
      ct_any_capture_min_available: 1,
      courier_transport_min_available: 1
    },

    // ── TIER 1 decision-engine wording (decision.js) ───────────────────────
    // action labels: shown as the headline of a recommendation.
    tier1Actions: {
      actionLabels: {
        connecteam_task: 'Dispatch via Connecteam',
        call_pa_game_comm: 'Call PA Game Commission',
        tbd_escalate: 'No automatic action - escalate to supervisor'
      },
      // enrichMarginal low-capacity note ({count} = available count).
      lowCapacityWarning: 'Low capacity warning: only {count} available; consider calling PA Game Commission.',
      // recommend() reasoning fragments, by branch.
      missingCapacity: 'No volunteers in this county - ask the finder to call PA Game Commission.',
      unknownIssue: 'Issue type not recognized - select Capture or Transport.',
      // B. Capture + RVS animal
      rvsCaptureRule: 'Capture + RVS animal -> RVS-capable C&T required.',
      rvsCaptureDispatch: 'Recommended: dispatch a C&T+RVS volunteer via Connecteam.',
      rvsCaptureNone: 'No RVS-capable C&T volunteers available - ask the finder to call PA Game Commission.',
      // C. Capture + non-RVS animal
      nonRvsCaptureRule: 'Capture + non-RVS animal -> any C&T volunteer acceptable.',
      nonRvsCaptureDispatch: 'Recommended: dispatch a C&T volunteer via Connecteam.',
      nonRvsCaptureNone: 'No C&T volunteers available - ask the finder to call PA Game Commission.',
      // D. Transport
      transportRule: 'Transport request - couriers preferred; C&T volunteers also eligible for transport runs.',
      // {courier} = courier count, {ct} = C&T count.
      transportCourierAndCt: '{courier} courier(s) + {ct} C&T(s) available for transport.',
      transportCourierDispatch: 'Recommended: dispatch a courier via Connecteam.',
      transportCtFallback: 'No couriers available; dispatching C&T for transport.',
      transportNone: 'No courier or C&T transport capacity available - ask the finder to transport the animal themselves, or call PA Game Commission.'
    },

    // ── renderRecommendation (Tier 1 modal) wording (dispatcher.js) ────────
    recommendation: {
      dismiss: 'Dismiss',
      // {label} = resolved target-role label.
      targetRole: 'Target role: <strong>{label}</strong>',
      lowCapacityHeader: 'Low capacity',
      noAvailabilityInfo: '(no availability info)',
      noRosterRecorded: 'No marginal-volunteer roster recorded for this bucket.',
      reasoningHeader: 'Reasoning',
      selectCountyFirst: 'Select a county first.',
      // Target-role display labels keyed by decision target bucket.
      targetLabels: {
        ct_rvs: 'RVS C&T',
        ct_no_rvs: 'C&T',
        ct_any: 'C&T (any)',
        courier: 'Courier'
      }
    },

    // ── Tier 1 capacity cards / empty + coordinator line (dispatcher.js) ───
    coordinator: {
      marginalBadge: 'Marginal',
      // {county} = selected county name.
      noVolunteersInCounty: 'No volunteers currently in {county} for these roles.',
      // {area} = WIN area string.
      areaCoordinatorLabel: 'Area {area} Coordinator',
      coordinatorLabel: 'Coordinator',
      // {label} = the resolved label above, {name} = coordinator name.
      coordinatorLine: '{label}: <strong>{name}</strong>.',
      // {county} = selected county name.
      noCoordinatorOnFile: '<span class="coord-area">No coordinator on file for {county}.</span>'
    },

    // ── Tier 2 aggregate / address-mode wording (dispatcher.js) ────────────
    tier2Aggregate: {
      configMalformed: 'Config file is malformed; using defaults.',
      snapshotUnavailable: 'Snapshot not available — run refresh_monday.py',
      // {ts} = formatted timestamp.
      lastRefreshed: 'Last refreshed: {ts}',
      refreshedUnknown: 'unknown',
      areasNone: 'none',
      // INFORMATIONAL volunteer count line. {count} = total in range,
      // {areaWord} = "area" or "areas" (computed in code), {areas} = area list.
      winVolunteersFound: 'WIN volunteers found: <strong>{count}</strong> (WIN {areaWord} <strong>{areas}</strong>).',
      // INFORMATIONAL coordinator line per in-range area. {area}, {name}.
      areaCoordinatorListed: 'Area {area} Coordinator: <strong>{name}</strong>.',
      // LENIENT recommendation — qualified helpers in range.
      // {count}, {areaClause} (computed, may be empty), {radius}.
      qualifiedHelpers: 'Out-of-county qualified helpers: <strong>{count}</strong>{areaClause} within {radius} mi — task via <strong>Connecteam</strong>.',
      // The "; WIN areas: ..." clause appended to the qualified/backup lines.
      // {areas} = sorted area list.
      areaClause: '; WIN areas: <strong>{areas}</strong>',
      // LENIENT recommendation — no qualified helper; surface backups.
      // {role} = needed role label, {radius}, {count}, {areaClause} (computed),
      // {gapClause} (one of the two below), {phone}.
      backupHelpers: 'No qualified <strong>{role}</strong> within {radius} mi. Nearby backup helpers: <strong>{count}</strong>{areaClause} could assist as <strong>backup</strong>{gapClause}{phone}.',
      backupGapRvs: ' (e.g. help with transport) — call <strong>PA Game Commission</strong> for the RVS capture: ',
      backupGapOther: ' — confirm capability, or call <strong>PA Game Commission</strong>: ',
      // Needed-role labels for the backup gap statement.
      needLabelRvs: 'RVS C&T',
      needLabelTransport: 'C&T / RVS C&T / Courier',
      needLabelCapture: 'C&T / RVS C&T',
      // No-qualified escalation (no leniency handled). {radius}, {phone}.
      noQualifiedEscalate: 'No qualified volunteers within {radius} mi — ask the finder to call <strong>PA Game Commission</strong>: {phone}.',
      // Closest-rehabber suggestion. {name}, {dist}, {site} (computed link or ''),
      // {closedNote} (computed or '').
      closestRehabber: 'Transport to closest rehabber: <strong>{name}</strong> (~{dist} mi){site}.{closedNote}',
      rehabberWebsiteLabel: 'website',
      rehabberClosedNote: ' <strong>Nearest is not marked OPEN — confirm before transport.</strong>',
      // No data at all. {phone}.
      noVolunteersNoData: 'No volunteers in range and no rehabber data available — ask the finder to call <strong>PA Game Commission</strong>: {phone}.',
      // Context list (out-of-county). {radius}, {county}.
      ctxHeaderBeyond: 'Out-of-county helpers within {radius} mi (beyond {county})',
      ctxHeader: 'Out-of-county helpers within {radius} mi',
      // {count} = rows shown.
      ctxOverflowNotice: 'Radius too large — showing the {count} nearest. Narrow the radius for a complete list.',
      // {radius}.
      ctxEmpty: 'No out-of-county volunteers within {radius} mi.',
      ctxEdge: 'edge',
      qualBadgeYes: 'Qualified',
      qualBadgeNo: 'Not qualified',
      qualBadgeYesTitle: 'Qualified for this animal',
      qualBadgeNoTitle: 'Not qualified for this animal',
      // {area} = win area chip / context label.
      areaChip: 'Area {area}'
    },

    // ── Address-mode status + geocode error wording (dispatcher.js) ────────
    geocodeErrors: {
      // {radius}.
      finding: 'Finding volunteers within {radius} mi…',
      enterAddress: 'Enter the animal address first.',
      renderFailed: 'Got a response but could not display it. Please report this to the site maintainer.',
      addressNotFound: 'No match for that address. Check spelling, or try "street, city, PA zip".',
      geocoderUnavailable: 'Address lookup service is temporarily unavailable. Try again shortly.',
      worker400: 'Dispatcher service could not resolve that location. Try a more specific address.',
      networkError: 'Could not reach the dispatcher service. Check your connection and try again.'
    },

    // ── Static UI strings injected into dispatcher.html (dispatcher.js) ────
    // These mirror text the markup used to hardcode; injected on init so the
    // wording (and the PGC phone) live in ONE place.
    staticUi: {
      // {phone} = PGC_PHONE. Footer fallback note under the recommend button.
      finderFallbackNote: 'If no Volunteer contacts FINDER within 2 hours FINDER should call PA Game Commission: {phone}'
    }
  };

  // ── fmt(): tiny placeholder substitution helper ───────────────────────────
  // Replaces {token} occurrences in `template` with String(values[token]).
  // A token with no matching value is left as-is. No logic, just substitution.
  function fmt(template, values) {
    if (typeof template !== 'string') return template;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, function (whole, key) {
      return Object.prototype.hasOwnProperty.call(values, key)
        ? String(values[key]) : whole;
    });
  }

  var api = { messages: M, fmt: fmt };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.WildlifeMessages = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);

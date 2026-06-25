# Dispatcher Policy System — Independent Verification

**Date:** Thu Jun 25 2026
**Method:** Read actual source + ran live `recommend()` against real `policy.json`/`facilities.json` + executed all test suites. Read-only; no code modified.
**Verdict:** **PASS** — all five verification areas confirmed from scratch. The only test failures found are stale-expectation drift in a non-required live-integration harness (`tests/test_dispatcher_live.js`), explained in §5.

Engine under test: `docs/assets/decision.js` (pure module). UI: `docs/assets/dispatcher.js` + `docs/dispatcher.html`. Editor: `docs/policy-editor.html`. Data: `docs/data/policy.json`, `docs/data/facilities.json`, `docs/data/facility_name_map.json`.

---

## 1. POLICY ENGINE — PASS (all 4 counties)

Executed `WildlifeDecision.recommend(capacity, rvs, issue, cfg, countyPolicy, animalType)` with high capacity (all buckets available=10) so the count logic always *wants* to dispatch; any `refer_out` therefore comes from the policy overlay.

| Scenario | Result | Expected | OK |
|---|---|---|---|
| **Adams** capture/mammal | `refer_out` → PGC, Raven Ridge, West Shore | refer_out + targets | yes |
| **Adams** transport/bird | `refer_out` → PGC, West Shore | refer_out | yes |
| **Adams** rvs capture/bat | `refer_out` → PGC, Raven Ridge, West Shore | refer_out | yes |
| **Chester** capture/mammal | `refer_out` → Schuylkill, Cricket, Philadelphia Metro, AARK | refer_out | yes |
| **Chester** capture/bird | `connecteam_task` | dispatch | yes |
| **Chester** transport/mammal | `connecteam_task` | dispatch (scope only gates capture) | yes |
| **Allegheny** capture/mammal | `connecteam_task` | dispatch | yes |
| **Allegheny** rvs/bat | `connecteam_task` | dispatch | yes |
| **Allegheny** transport/bird | `connecteam_task` | dispatch | yes |
| **Erie** rvs capture/bird | `refer_out` → Humane Animal Wildlife Rescue, PGC | refer_out | yes |
| **Erie** rvs capture/bat | `connecteam_task` | dispatch | yes |
| **Erie** transport/mammal | `refer_out` → Tamarack | refer_out (transport not in allowed_issues) | yes |
| **Erie** capture/mammal | `connecteam_task` | dispatch (capture allowed, no species scope on capture) | yes |

**Key code facts verified:**
- `applyCountyPolicy()` is **downgrade-only**: it can only turn `connecteam_task`/`call_pa_game_comm` into `refer_out`; it never invents a dispatch (`decision.js:404-408`).
- Adams `dispatch_enabled:false` short-circuits regardless of `allowed_issues:"all"` (a string, not array) — `dispatchOff` is checked first (`decision.js:383`). The `Array.isArray(allowed_issues)` guard means `"all"` never restricts (`decision.js:385`).
- `policyIssueKey()`: non-RVS capture→`capture`, RVS capture→`rvs_capture`, transport→`transport` (`decision.js:179-188`).
- `scopeListForIssue()` maps `rvs_capture`→`species_scope.rvs`; Erie's `species_scope.rvs:["bats"]` therefore gates RVS captures to bats only (`decision.js:242-247`).
- Species matching via `SPECIES_TOKENS`: spot-checked bird∈[birds]=true, mammal∈[birds]=false, bat∈[bats]=true, bird∈[bats]=false, other/unknown=passthrough (`decision.js:199-233`).

---

## 2. DISPATCHER UI — PASS

- **Animal Type dropdown — 7 options** (`docs/dispatcher.html:1476-1484`): `other` (Other/Unknown, `selected`), `bird`, `waterfowl`, `raptor`, `bat`, `mammal`, `reptile_amphibian`. ✔
- **In-County recommendation by default, no WIN Area button in rec panel** — `renderRecommendation()` renders the In-County rec directly with a county-scope header and no scope toggle (`dispatcher.js:822-852`). `grep` for `rec-scope-toggle`/`btn-rec-scope` across `docs/` returns **no matches**. ✔
- **Volunteer list keeps both buttons** — `#t1-vol-toggle-county` "In-County Volunteers" and `#t1-vol-toggle-area` "WIN Area Volunteers" (`docs/dispatcher.html:1544-1550`). ✔
- **Referral display = name + clickable phone + notes** — `recBodyHtml()` renders `rec-referral-name`, a `tel:`-linked `rec-referral-phone`, and `rec-referral-notes` per target, plus `special_notes` (`dispatcher.js:724-789`). ✔
- **Phone source = facilities.json when available** — UI calls `resolveReferralPhone(t, state.facilityPhoneIndex)` and prefers the facilities phone over the policy phone, flagging discrepancies inline (`dispatcher.js:743-771`; engine `decision.js:331-351`). ✔
- **Enriched reasoning = vol counts (in-county vs in-area) + animal-type-filtered rehabbers** — `recDispatchSummaryHtml()` emits `summaryVolCounty`/`summaryVolArea` from the SAME cached `state.t1VolRows` the list buttons use, then `nearbyRehabbers(county, animalType)` filtered by `rehabberAcceptsAnimal()` (`dispatcher.js:568-631`). ✔
- **Issue-aware PGC action** — transport → `pgcTransportLabel` + "transport to nearest rehabber" list; capture/rvs → `pgcCaptureLabel` ("Call PA Game Commission to capture") + PGC number (`dispatcher.js:696-714`, `recPgcGuidanceHtml` 644-671). ✔

---

## 3. POLICY EDITOR — PASS

`docs/policy-editor.html` (1587 lines). Verified by reading the source and replaying its `countyStatus()`/summary math against real `policy.json`.

- **Loads & renders all 67 counties** — banner reports `Loaded N counties` from the union of policy+capacity keys; `policy.json` has exactly 67 county entries (see §4). ✔
- **🚫 / ⚠️ dropdown indicators** — `STATUS_MARK = { off:'🚫 ', restricted:'⚠️ ', clear:'', none:'' }`; `countyStatus()` returns `off` when `dispatch_enabled===false`, `restricted` when `allowed_issues` is an array, else `clear` (`policy-editor.html:966-998`). ✔
- **Summary legend counts** — replaying the editor's own classifier over real data: **11 disabled, 20 restricted, 36 unrestricted** (clear+none), summing to 67. `renderStatusSummary()` combines `clear+none` into "unrestricted" (`policy-editor.html:1003-1019`). ✔
  - Disabled: Adams, Franklin, Fulton, Greene, McKean, Montour, Potter, Sullivan, Susquehanna, Union, Wyoming.
- **Species scope = category checkboxes** — 6 `.species-check` checkboxes (bird/waterfowl/raptor/bat/mammal/reptile_amphibian), not free text (`policy-editor.html:811-816`). Issue selection also uses checkboxes incl. an "All issues" pill (`785-787`). ✔
- **Download button** — `#download-btn` "Download policy.json"; admin note states edits export as `policy.json` for manual commit (`policy-editor.html:858-861, 690`). ✔ (Export path is the working `state.counties` copy; the loaded doc is itself valid JSON — see §4.)

---

## 4. DATA INTEGRITY — PASS

- **policy.json: 67 county entries, valid JSON** — `JSON.parse` succeeds; `counties` is an object with **67** keys; **0** non-object entries. ✔
- **Referral phones vs facilities.json: ZERO discrepancies at runtime** — built the facilities phone index (25 facilities + `facility_name_map.json` aliases) and ran `resolveReferralPhone()` over **all 91** referral targets across 67 counties:
  - 47 targets matched a facilities.json entry → **0** phone discrepancies (every matched phone identical).
  - 44 targets fall back to the policy phone (no facilities match — e.g. PA Game Commission, Raven Ridge under a non-aliased spelling). The engine correctly keeps the policy phone for these and never overrides a facilities phone with a spreadsheet phone (`decision.js:340-345`).
  - Spot check: Raven Ridge → `source:facilities`, phone `7178082652`, `discrepancy:false`. ✔
- **REHAB_SPECIES_CODES** (`dispatcher.js:468-475`): `bird:['P']`, `waterfowl:['P']`, `raptor:['R']`, `bat:['RVS']`, `mammal:['M','RVS']`, `reptile_amphibian:['RA']`. Matches the spec (bird/waterfowl→P, raptor→R, bat→RVS, mammal→M+RVS, reptile_amphibian→RA) exactly. `other`/unknown intentionally absent → pass-through. ✔

---

## 5. TEST SUITES — required suites PASS; one non-required live harness has stale expectations

| Suite | Command | Result |
|---|---|---|
| **Dispatcher DOM** | `node test/dispatcher_dom.test.js` | **65 scenarios PASS** ("ALL DOM TESTS PASSED") |
| **Flags DOM** | `node test/flags_dom.test.js` | **53 assertions PASS** |
| **Decision** | `node tests/test_decision.js` | **38 tests PASS** ("OK: 38 tests passed") |
| **Worker** | `node worker/test/run.test.js` | **132 PASS, 0 FAIL** ("ALL TESTS PASSED") |

All four required suites are green.

### Non-required: `tests/test_dispatcher_live.js` — 6 failures (NOT a policy-system defect)

This is a **live-Worker integration harness**, not one of the four suites named in the task. Run normally: `passed: 76, failed: 6`.

- **4 failures = stale hardcoded live-data counts.** The harness asserts the 40.44/-79.99/50mi query returns total **32**, C&T **12**, RVS C&T **0**, COURIER **20**, but the live Worker now returns **35 / 4 / 8 / 21**. These are expectation-vs-live-data drift (the volunteer roster changed), not a code regression.
- **2 failures = intentional refactor drift.** With `WORKER_OFFLINE=1` (live call skipped) only these remain:
  - `onRecommendClick uses getWinAreaCounties for merged capacity`
  - `onRecommendClick merges capacity via mergeCapacity`

  The test asserts (via regex on the extracted function text, `test_dispatcher_live.js:481-482`) that `onRecommendClick` references those helpers. But `onRecommendClick` was **deliberately refactored** to run the recommendation over **only the selected county's capacity** — `var countyCapacity = counties[county] || null;` with the comment *"The recommendation runs over ONLY the selected county's capacity"* (`dispatcher.js:1002-1014`). This is exactly the change described by git commit `fcc5761 "Remove WIN Area scope toggle from Tier 1 recommendation panel"`. The helpers `getWinAreaCounties`/`mergeCapacity` still exist and are used elsewhere (`dispatcher.js:272,291,366,512`); they are simply no longer called from `onRecommendClick`. **The current behavior is correct and matches the verified §1/§2 intent; the assertions are obsolete.**

**Conclusion on §5:** the policy system itself has no failing tests. The 6 live-harness failures are pre-existing test-data/expectation drift in a separate, non-required integration file and do not indicate any defect in the engine or dispatcher UI.

---

## Evidence Index
- `file_read docs/assets/decision.js:1-550` — full engine (applyCountyPolicy, scope, phone resolution).
- `file_read docs/assets/dispatcher.js:440-859, 980-1020` — REHAB_SPECIES_CODES, referral render, onRecommendClick.
- `file_read docs/dispatcher.html:1473-1494, 1543-1556` — 7-option dropdown, vol-list buttons.
- `file_read docs/policy-editor.html:966-1019` — status classifier, summary legend.
- `node /tmp/verify_policy.js` — 13 live recommend() scenarios (§1).
- `node /tmp/verify_phones.js` — 91 referral targets, 0 discrepancies (§4).
- `node /tmp/verify_editor.js` — 67 counties, status counts 11/20/36 (§3,§4).
- `node /tmp/verify_extra.js` — Raven Ridge resolve, species/qualifyingRoles spot checks.
- `node test/dispatcher_dom.test.js` → 65 PASS; `node test/flags_dom.test.js` → 53 PASS; `node tests/test_decision.js` → 38 PASS; `node worker/test/run.test.js` → 132 PASS.
- `node tests/test_dispatcher_live.js` → 76 PASS / 6 FAIL (stale, explained §5).

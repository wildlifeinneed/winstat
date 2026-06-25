# WIN Volunteer Dispatcher Spreadsheet vs. Recommendation Engine — Analysis

**Source spreadsheet:** `data/Spreadsheet of WIN Volunteers for dispatchers update March 24.xlsx`
**Engine files reviewed:** `docs/assets/decision.js`, `docs/assets/messages.js`, `docs/data/county_capacity.json`, `docs/data/config.json`, `worker/src/aggregate.js`
**Date of analysis:** 2026-06-25

---

## TL;DR

The spreadsheet and the engine answer **different questions**.

- The **engine** answers: *"Given live volunteer counts, is there capacity to dispatch, or should we call PA Game Commission?"* It is purely **count-driven** (available volunteers per role bucket vs. a threshold).
- The **spreadsheet** answers: *"For this county, is WIN even allowed to dispatch, for which issue types and which species, and if not, exactly which named facility should the dispatcher refer the caller to?"* It is **policy-driven** (per-county standing rules, species scope, time windows, named referral targets).

They **agree** on the ~40 "normal" counties where the rule is plainly "Enter dispatch for captures, transports and RVS." They **diverge** sharply on the ~25 counties that carry a restriction: *Do Not Enter Dispatch*, *transport-only*, *bats-only / birds-only RVS*, species limits, time windows, or a specific referral facility. The engine has **no concept** of any of those restrictions today — it will happily recommend a Connecteam dispatch in a county the admin has flagged "DO NOT ENTER DISPATCH" as long as one volunteer count is non-zero.

A concrete live example: **Adams County**. The snapshot shows `courier available = 1`, so `recommend()` would return *"Dispatch via Connecteam"* for a transport. The spreadsheet says **"Do not Enter Dispatch — refer to PGC / Raven Ridge / West Shore."** That is a direct contradiction the system would get wrong right now.

---

## 1. Spreadsheet Summary

### Structure
- **17 worksheets**, one per WIN **Area**: `Area 01`–`Area 16`, with Area 15 split into `Area 15 N` and `Area 15 S`.
- Each sheet is a small table with a header row and one block per county:

  | Column | Meaning |
  |---|---|
  | `County` | County name |
  | `No Vol.` | `0` flag when the county has **no volunteers** (else blank) |
  | `C & T` | count of Capture & Transport volunteers |
  | `W.C.` | count of "Wildlife Couriers" (transport-only couriers) |
  | `RVS/C & T` | count of rabies-vector-species-capable C&T volunteers |
  | `Instructions` | **free-text dispatcher directive** (the real payload) |
  | trailing cols | ad-hoc notes (coordinator backup, date blackouts, time windows) |

- Each sheet ends with an **Area Coordinator** name + phone.
- **~67 county blocks total** across all sheets.

### What guidance it provides (this is the part the engine lacks)
The `Instructions` text is a **decision directive per county**, not just a count. Observed directive categories:

1. **Full dispatch** (the common case, ~40 counties): *"Enter dispatch for captures, transports and RVS."*
2. **Do Not Enter Dispatch** (hard refer-out): McKean, Potter, Sullivan, Susquehanna (ALL→PGC), Wyoming (ALL→PGC), Montour, Union, Greene, Adams, Franklin, Fulton. Each lists **named referral facilities** with phone numbers (e.g. PGC `833-742-9453`, Raven Ridge `717-327-4811`, West Shore `717-268-9574`).
3. **Issue-scoped dispatch:**
   - *Transport-only* (capture/RVS referred out): Armstrong, Indiana, Columbia, Snyder.
   - *Capture-only* (transport/RVS referred out): Clinton ("transport+RVS → Centre Wildlife Care").
   - *Capture+Transport, no RVS* (RVS referred out): Bradford (RVS→PGC), Tioga (RVS→Good Samaritan), Washington (RVS→Humane/Forest Friends), Northumberland.
4. **Species-scoped RVS:** "RVS — **Bats only**" with everything else referred to Humane Animal Wildlife Rescue / PGC: Erie, Mercer, Venango, Warren, Clarion.
5. **Species-scoped capture:** Chester ("C&T — **Birds only**" + transports; other captures → rehabbers); Lebanon ("**Waterfowl, Water Birds and Birds of Prey only**; all other wildlife → Red Creek / Helping Hands / Raven Ridge / West Shore").
6. **Time-windowed dispatch:** Lehigh ("C&T avail. after 5PM weekdays & weekends; Mon–Thurs before 5PM / Fri before 1PM → refer to Cricket / AARK / Red Creek / Helping Hands / Pocono"); Delaware ("C&T avail Wed 12–8 / Thur 2–8 / Sun 2–6; outside those times → refer to rehab ctrs"); Philadelphia ("transports **after 2:00PM weekdays** only").
7. **Date blackouts / backup responders** (trailing notes): Lackawanna & Wayne ("No C&T nor RVS C&T **May 29–31** — refer to PGC"); Pike ("No C&T nor RVS C&T **May 29–31** → Pocono Wildlife / PGC"); Monroe transporter ("Unavail 10/3/26–10/18/26"); "Sue/Jane/Julia may respond depending on availability" backup-coordinator notes scattered across many sheets.

### Decision factors the spreadsheet uses
- County (primary key).
- Issue type (Capture / Transport / RVS) — **with per-county allow-lists**.
- **Species** (bats / birds / waterfowl / raptors) — a factor the engine does not model at all.
- **Time of day / day of week** — not modeled by the engine.
- **Named referral facility** per county+issue — the engine only ever says the generic "call PA Game Commission."
- Volunteer counts (the C&T / W.C. / RVS columns) — the **only** factor the two systems share.

---

## 2. Current Engine Summary (`recommend()` in `decision.js`)

`recommend(capacity, animalRvs, issue, resolvedConfig)` is a pure, count-driven function. Branch order:

- **A. Missing capacity** → `call_pa_game_comm` ("No volunteers in this county…").
- **E. Unknown issue** (not `capture`/`transport`) → `tbd_escalate` ("escalate to supervisor"). *Note: RVS is not a separate issue here — it's the `animalRvs` boolean modifying a Capture.*
- **B. Capture + RVS animal** → needs `ct_rvs.available >= ct_rvs_capture_min_available` (default 1) → `connecteam_task (ct_rvs)`; else `call_pa_game_comm`.
- **C. Capture + non-RVS animal** → needs `ct_no_rvs + ct_rvs >= ct_any_capture_min_available` (default 1) → `connecteam_task (ct_any)`; else `call_pa_game_comm`.
- **D. Transport** → pool = `courier + ct_any`; if `>= courier_transport_min_available` (default 1) → `connecteam_task` (courier preferred, C&T fallback); else `call_pa_game_comm`.

**Factors used:** three role-bucket *available* counts (`ct_no_rvs`, `ct_rvs`, `courier`), the `animalRvs` flag, and the issue (`capture`/`transport`). Plus a `marginal` low-capacity badge when `available <= marginal_threshold` (default 1).

**Actions produced (only three):** `connecteam_task` (go), `call_pa_game_comm` (escalate), `tbd_escalate` (unknown).

**Tuning:** `config.json` exposes global thresholds and an (empty) `county_overrides` map for per-county threshold deep-merge. Wording lives in `messages.js`. The Tier-2 worker (`aggregate.js`) is radius-scoped and PII-safe but uses the **same** count-vs-threshold philosophy — it has no policy layer either.

**Key architectural fact:** the *only* per-county knob that exists today is a **numeric threshold override**. There is no field anywhere for "dispatch disabled," "allowed issues," "species scope," "time window," or "referral facility."

---

## 3. Gap Analysis — Matches vs. Divergences

### Coverage note
All 48 counties in `county_capacity.json` appear in the spreadsheet. The spreadsheet additionally covers **19 counties with zero WIN volunteers** that are *absent* from the capacity snapshot entirely: Bradford, Cambria, Clarion, Clearfield, Forest, Franklin, Fulton, Greene, Jefferson, Juniata, McKean, Montour, Potter, Snyder, Sullivan, Susquehanna, Union, Wayne, Wyoming. For these, the engine would hit **Branch A (missing capacity) → "call PA Game Commission,"** which is *coincidentally close* to the spreadsheet's "refer out" — but it loses the specific facility names the spreadsheet provides (e.g. Center Wildlife Care, Raven Ridge, Good Samaritan).

### Where they MATCH
- **~40 "full dispatch" counties** with non-zero appropriate counts: Crawford, Lycoming, Cambria, Clearfield, Jefferson, Blair, Centre, Huntingdon, Mifflin, Carbon, Luzerne, Monroe, Allegheny, Beaver, Bedford, Fayette, Somerset, Westmoreland, York, Cumberland, Dauphin, Juniata, Perry, Berks, Schuylkill, Northampton, Bucks, Montgomery, Lancaster, Butler, etc. Spreadsheet says "Enter dispatch for captures, transports and RVS"; the engine, given the live counts, also dispatches. **Agreement.**
- **Zero-volunteer refer-out counties** (Potter, Sullivan, Susquehanna, Wyoming, McKean, Montour, Union, Greene, Franklin, Fulton): engine → "call PGC", spreadsheet → "refer out." **Agreement on the *action*, divergence on the *target* (generic PGC vs. named facility).**

### Where they DIVERGE (specific, actionable)
| County | Spreadsheet directive | Engine output (given snapshot) | Divergence |
|---|---|---|---|
| **Adams** | **Do Not Enter Dispatch** → PGC / Raven Ridge / West Shore | `courier avail=1` → **Dispatch via Connecteam** for transport | **Hard contradiction** — engine dispatches where admin forbids it |
| **Armstrong** | **Transport-only**; captures → Wildbird/Forest Friends/Humane | `ct_no_rvs/ct_rvs=0`, `courier=1`. Capture → "call PGC" (count=0). Transport → dispatch | Engine's capture answer is "call PGC," not the specific rehabber referral; OK-ish by luck on capture, wrong target |
| **Indiana** | **Transport-only**; others → rehabbers | `courier=2`, C&T=0. Capture → "call PGC" | Same as Armstrong: refer-target lost; transport agrees |
| **Columbia** | **Transport-only** → rehabbers | `courier=2`, C&T=0. Capture → "call PGC" | Refer-target lost |
| **Snyder** | **Transport-only** → rehabbers | (not in snapshot counts shown) | Engine cannot express transport-only as a *rule* |
| **Clinton** | **Capture-only**; transport+RVS → Centre Wildlife | `ct_no_rvs=1, courier=1`. Transport → **dispatch courier** | **Contradiction** — engine dispatches a transport the admin routes to Centre Wildlife |
| **Tioga** | Capture+transport; **RVS → Good Samaritan/PGC** | `ct_no_rvs=1`. RVS capture: `ct_rvs=0` → "call PGC" | Engine says generic PGC; admin names Good Samaritan first |
| **Washington** | Capture+transport; **RVS → Humane/Forest Friends** | `ct_rvs=1` → **dispatch RVS C&T** | **Contradiction** — engine dispatches an RVS capture the admin routes out (+note: HARP not accepting waterfowl) |
| **Erie / Mercer / Venango / Warren / Clarion** | RVS **Bats only**; other RVS → Humane/PGC | Engine has no species concept | Engine would dispatch/PGC purely on `ct_rvs` count, ignoring "bats only" |
| **Chester** | C&T **Birds only** + transports; other captures → rehabbers | `ct_no_rvs=1, courier=3`. Non-RVS capture → **dispatch C&T** | **Over-dispatch** — engine would dispatch a mammal capture the admin restricts to birds |
| **Lebanon** | **Waterfowl / Water Birds / Birds of Prey only**; else → rehabbers | `ct_no_rvs=1` → dispatch any capture | **Over-dispatch** on non-bird captures |
| **Lehigh** | Dispatch only **after 5PM wkdays / weekends**; else refer | Always dispatches if count>0 | Engine ignores time window |
| **Delaware** | C&T only **Wed 12–8 / Thu 2–8 / Sun 2–6**; else refer | Always dispatches if count>0 | Engine ignores time window |
| **Philadelphia** | Transport only **after 2PM weekdays** | `courier=1` → dispatch anytime | Engine ignores time window |
| **Lackawanna / Wayne / Pike** | **No C&T May 29–31** → PGC / Pocono | Dispatches from static snapshot counts | Engine ignores date blackouts |
| **Northumberland** | Capture+transport (**no RVS** line) | `ct_rvs=1` → would dispatch RVS capture | Engine would dispatch RVS the sheet doesn't authorize |

**Pattern of divergence:** every divergence is the engine being **too permissive** (dispatching where the admin restricts) or **too generic** (saying "call PGC" where the admin names a specific facility). There is no case where the spreadsheet is more permissive than the engine — the spreadsheet is strictly a **policy overlay that tightens** the count-based decision.

---

## 4. Codification Plan (no code — approach only)

The clean way to encode the spreadsheet is a **per-county policy overlay** that runs *after* the existing count logic, reusing the already-present `config.json → county_overrides` seam. The engine stays the single source of count logic; policy only ever **down-grades** a `connecteam_task` to a referral, never invents new dispatches.

### Tier A — Directly codifiable from existing data (low effort, high value)
1. **`dispatch_enabled` per county (boolean).** Encodes "Do Not Enter Dispatch." When false, `recommend()` short-circuits to a referral action regardless of counts. Covers Adams, McKean, Potter, Sullivan, Susquehanna, Wyoming, Montour, Union, Greene, Franklin, Fulton. *Fixes the Adams contradiction immediately.*
2. **`allowed_issues` per county** (`["capture","transport","rvs"]` subset). Encodes transport-only / capture-only / no-RVS. When the incoming issue isn't allowed, short-circuit to referral. Covers Armstrong, Indiana, Columbia, Snyder, Clinton, Tioga, Bradford, Washington, Northumberland. *Fixes the Clinton/Washington contradictions.*
3. **`referral_targets` per county** — a small list of `{name, phone, scope}` so the referral action names the **specific facility** instead of generic PGC. The facility names + phones are already sitting in the `Instructions` text and largely overlap `docs/data/facilities.json` / `rehabbers.json`, so most can be linked by name/phone.

These three are a **new optional schema on `county_overrides`** plus a thin post-step in `recommend()` and three new message keys + one new action tone (`refer_out`). No new data pipeline; the values are transcribed from the spreadsheet into config once.

### Tier B — Needs a new data dimension (medium effort)
4. **`species_scope` per county+issue** (e.g. RVS=bats-only, capture=birds-only, Lebanon=waterfowl/raptors). This requires the dispatcher UI to capture an **animal species/taxon** input, which the engine does not collect today (`recommend()` only takes `animalRvs` + issue). Covers Erie, Mercer, Venango, Warren, Clarion, Chester, Lebanon. **Blocker: needs a new input field + taxonomy.** Until then, the best we can do is surface the spreadsheet's species note as an **advisory string** on the recommendation, not a hard gate.

### Tier C — Needs runtime context the engine doesn't have (higher effort)
5. **`time_windows` per county** (Lehigh, Delaware, Philadelphia). Requires evaluating the **current local time/day** at decision time and a per-county schedule model. Doable but introduces time-dependence into a currently-deterministic pure function (testing implications).
6. **`blackout_dates`** (Lackawanna/Wayne/Pike May 29–31; Monroe Oct 3–18). Date-range gates. These are inherently transient — better sourced from the live availability pipeline than hard-coded, but the spreadsheet shows the admin wants them honored as hard refer-outs.

### Rough approach
- **Schema:** extend each `config.json → county_overrides[County]` with optional `dispatch_enabled`, `allowed_issues`, `referral_targets`, `species_scope`, `time_windows`, `blackout_dates`. All optional → backward compatible (absent = today's behavior).
- **Engine change:** add a `applyCountyPolicy(rec, countyPolicy, issue, animalRvs, now)` post-step in `decision.js` that can only **convert a `connecteam_task` into a referral** (Tier A/C) or **attach an advisory** (Tier B), never the reverse. Keeps count logic untouched and the policy strictly tightening.
- **Messages:** add `referOut`, `dispatchDisabled`, `issueNotAllowed`, `speciesAdvisory`, `timeWindowAdvisory` keys + a `refer_out` action tone in `messages.js` (wording stays data-only there).
- **Data entry:** one-time transcription of the spreadsheet's `Instructions` column into the config (≈25 non-trivial counties). This is the bulk of the work and is data, not code.
- **Validation:** a test that loads the config and asserts, for each restricted county, that `recommend()` returns a referral for the disallowed issue and the named facility — using the spreadsheet rows as the fixture.

---

## 5. Edge Cases / Special Notes the System Does Not Handle

1. **Species-level routing** — "bats only" RVS, "birds only" capture, "waterfowl/raptors only" (Lebanon). No species input exists; engine treats every RVS capture identically.
2. **Time-of-day / day-of-week windows** — Lehigh, Delaware, Philadelphia. `recommend()` is time-agnostic and deterministic.
3. **Date blackouts** — Lackawanna/Wayne/Pike (May 29–31), Monroe transporter (Oct 3–18). Static snapshot can't express a forward-dated gap.
4. **Named referral facilities** — the spreadsheet gives a *specific* facility + phone per county+issue (Tamarack, Centre Wildlife Care, Good Samaritan, Raven Ridge, West Shore, Humane Animal Rescue, Forest Friends, Pocono, AARK, Cricket, etc.). The engine only ever emits the generic PGC line. `facilities.json`/`rehabbers.json` exist but are not wired into the recommendation as a referral target.
5. **Backup-coordinator "may respond"** notes — "Sue / Jane / Julia may respond depending on availability." A soft fallback the engine has no slot for.
6. **Cross-county coverage volunteers** — e.g. Perry volunteer "Covers Cumberland, Dauphin, Juniata, Perry"; Pike volunteer "Covers parts of Lackawanna, Pike, Monroe, Wayne." The engine buckets strictly by `home_county`; the Tier-2 radius search partially compensates but doesn't read these explicit coverage declarations.
7. **Facility-specific exclusions** — Washington note: "HARP not accepting Waterfowl from Washington County." A negative routing rule with no representation in the system.
8. **Zero-volunteer counties absent from the snapshot** (19 of them) — engine reaches them only via Branch A's generic "call PGC," losing the spreadsheet's specific facility list.
9. **`No Vol.` / sub-species responder columns** in the sheet are human-readable hints (who specifically responds) that don't map to the engine's anonymized, PII-safe bucket counts.

---

## Bottom line for the user

1. **Does the engine already cover the spreadsheet?** Partially — only the count-based "is there capacity?" half, which matches on ~40 unrestricted counties and coincidentally on zero-volunteer counties. It covers **none** of the policy half.
2. **Where do we diverge?** On every restricted county (~25): the engine is too permissive (Adams, Clinton, Washington, Chester, Lebanon, the time-windowed and species-scoped counties) and too generic on referral targets (it always says "call PGC" instead of the named facility). The standout bug-class is **dispatching where the admin said "Do Not Enter Dispatch."**
3. **Can we codify it?** Yes — Tier A (dispatch on/off, allowed-issues, named referral targets) is directly codifiable today via the existing `county_overrides` seam and a strictly-tightening post-step, and would resolve the hard contradictions. Tier B (species scope) needs a new species input; Tier C (time windows, date blackouts) needs runtime time/date context. None require changing the core count logic.

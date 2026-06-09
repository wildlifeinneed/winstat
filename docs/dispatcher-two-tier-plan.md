# Dispatcher Two-Tier Search — Architecture Plan

Status: DESIGN ONLY. No feature code in this doc. Grounds the design in the
existing Worker + frontend and the locked decisions.

Goal: reshape the Dispatcher Console into a deliberate **two-tier** flow.

- **TIER 1 (County):** dispatcher picks the animal's county → sees the existing
  per-county volunteer counts + recommended actions (today's County mode,
  unchanged). Coordinator to notify = the coordinator for THAT county.
- **TIER 2 (Widen):** used when Tier 1 is thin. Dispatcher enters an address +
  radius → sees **out-of-county** volunteers within radius as a **context
  list**. Each row = qualification (`C&T` / `RVS C&T` / `Courier`) +
  `distance_mi`, sorted by distance. Lets the dispatcher judge viability
  ("RVS C&T in range but 38 mi out / outer edge → maybe not an option").

### HARD PII CONTRACT (user-confirmed, non-negotiable)
The ONLY per-volunteer fields that may reach the browser are **role/qualification
+ `distance_mi`** (optionally a coarse `win_area`/`county` for context).
**NEVER** name, phone, address, `lat`, `lon`, or `_addr_sig`. Distance is
computed **server-side in the Worker**; raw coords stay in private KV. The
existing aggregate-count behavior is already PII-safe and stays.

---

## 0. Grounding facts (verified in code)

- KV record shape per volunteer is already
  `{lat, lon, roles, home_county, win_area, _addr_sig}` — see
  `geocoder.py:227-235`. So **`home_county` and `win_area` already live in KV**:
  out-of-county filtering + per-row distance need **NO data-shape change**.
- Worker reads KV key `volunteer_coords` and returns only
  `{total_in_range, role_counts, win_areas}` — `worker/src/handler.js:262-272`,
  aggregate built in `findVolunteersInRadius` `worker/src/aggregate.js:115-162`.
- Haversine + radius clamp already exist and are reusable:
  `haversineMi` `worker/src/aggregate.js:62-72`, `clampRadius` `:38-53`,
  canonical roles `QUALIFYING_ROLES = ['C&T','RVS C&T','COURIER']` `:31`,
  role match `rolesOf` `:85-103`.
- Params parsed today: `animal_lat`, `animal_lon`, `address`, `radius_mi`,
  `autocomplete`, `limit` — `worker/src/handler.js:53-95`. Address is geocoded
  server-side via Census (`worker/src/census.js`), autocomplete via Photon
  (`worker/src/autocomplete.js`).
- County → coordinator mapping: `docs/data/coordinators.json` maps **WIN-area →
  coordinator name** (e.g. `"7": "Jane Pierzga"`). County → WIN area comes from
  `counties.xlsx` via `county_win.lookup_county()` `county_win.py:199-214`.
  Frontend already loads `coordinators.json` and resolves area→name
  (`dispatcher.js:377-384`, `:703-714`).
- Frontend modes today: `#county-mode` and `#address-mode` toggled by
  `setMode()` `dispatcher.js:680-684`; address result rendered by
  `renderAggregate()` `:406-483`. Dark-theme NOT present today — page is a LIGHT
  theme (`--bg:#f5f2ec`, `dispatcher.html:16-35`). See QUESTION Q4.

---

## 1. Worker endpoint signature(s) + PII-safe response schema

Tier 1 keeps using the **committed** `docs/data/county_capacity.json` snapshot
(no Worker call) — unchanged. Tier 2 uses the live Worker.

### Tier 2 request (extends the existing endpoint, no new route)
```
GET https://pa-wildlife-dispatcher.winstat.workers.dev
    ?address=<urlenc>            # OR animal_lat=<f>&animal_lon=<f>
    &radius_mi=<n>               # default 20, clamped [0,100]
    &exclude_county=<countyName> # NEW: the Tier 1 county to exclude
    &context=1                   # NEW: opt-in flag to include out-of-county rows
    &max_rows=<n>                # NEW (optional): cap rows, default 25, max 50
```
- `exclude_county` is the county chosen in Tier 1, carried into Tier 2 (locked:
  no reverse-geocode). Matched case-insensitively against KV `home_county`.
- When `context` is absent/falsy the response is byte-identical to today's
  aggregate (full backward compatibility).

### Tier 2 response (PII-safe)
```json
{
  "total_in_range": 12,
  "role_counts": { "C&T": 7, "RVS C&T": 3, "COURIER": 5 },
  "win_areas": ["05", "07", "10"],
  "out_of_county": [
    { "role": "RVS C&T", "distance_mi": 11.4, "win_area": "10", "county": "Berks" },
    { "role": "C&T",     "distance_mi": 18.9, "win_area": "07", "county": "Lehigh" },
    { "role": "COURIER", "distance_mi": 38.2, "win_area": "05", "county": "Bucks" }
  ],
  "out_of_county_truncated": false
}
```
- `out_of_county` is present ONLY when `context=1`. Sorted ascending by
  `distance_mi`. `distance_mi` rounded to 1 decimal.
- `win_area` / `county` are OPTIONAL context fields (coarse, area-level — not
  PII). They power the in/out cue and "which area to widen into."
- A volunteer with multiple qualifying roles emits **one row per qualifying
  role** (so the dispatcher sees "an RVS C&T at 11 mi" distinctly). Alternative:
  one row carrying a `roles[]` array — see QUESTION Q3.

### FORBIDDEN keys (must NEVER appear anywhere in the response)
`name`, `phone`, `email`, `address`, `street`, `city`, `zip`, `lat`, `lon`,
`_addr_sig`, `monday_item_id`. Enforced at one serialization seam (§5).

---

## 2. "Out-of-county within radius" — server-side computation

Add a sibling pure function in `worker/src/aggregate.js`, e.g.
`findContextRows(animalLat, animalLon, radiusMi, coordsDataset, excludeCounty, maxRows, distanceFn)`,
reusing the existing primitives. Algorithm:

1. `radius = clampRadius(radiusMi)` (reuse `aggregate.js:38-53`).
2. Normalize `excludeCounty` once (trim + casefold), mirroring
   `county_win._normalize` `county_win.py:133-135`.
3. For each KV record (same defensive guards as `findVolunteersInRadius`
   `aggregate.js:127-144`):
   - skip if missing/invalid `lat`/`lon`;
   - `d = haversineMi(animalLat, animalLon, lat, lon)` (reuse `:62-72`); skip if
     `!finite(d) || d > radius`;
   - **out-of-county filter:** skip if `normalize(rec.home_county) === excludeNorm`
     (Tier 1 already covers in-county; this is the "widen" set);
   - for each role in `rolesOf(rec)` (reuse `:85-103`), push
     `{ role, distance_mi: round1(d), win_area: rec.win_area || null, county: rec.home_county || null }`.
4. Sort ascending by `distance_mi`; cap to `maxRows` (default 25, max 50);
   set `out_of_county_truncated = (matched > maxRows)`.

Notes:
- The aggregate block (`total_in_range`, `role_counts`, `win_areas`) is still
  computed across **all** in-radius volunteers (in + out of county) exactly as
  today — Tier 2's context list is an ADDITIVE view, it does not change the
  aggregate.
- Optional `in_county` flag could replace the hard exclude (locked decision
  allows proposing it) — see QUESTION Q3 for the recommended variant.

---

## 3. County → coordinator resolution (the notify line)

Two consumers, same data already in the browser:

- **Tier 1 (notify THIS county's coordinator):** county → WIN area → coordinator
  name. County→area: today the browser has no county→area map client-side; it
  only has area→name (`coordinators.json`). **GAP:** to show "notify
  <coordinator> for <county>" in Tier 1 the frontend needs county→area. Options:
  (a) commit a small `docs/data/county_win.json` (`{county: area}`) generated
  from `counties.xlsx` (the Python side already resolves this via
  `county_win.lookup_county` `county_win.py:199-214`); (b) have the Worker return
  the resolved coordinator. Recommended: **(a)** — keeps Tier 1 fully static and
  offline, no Worker dependency. See QUESTION Q1.
- **Tier 2 (context):** the response's `win_areas` already drive
  `coordinatorsForAreas()` `dispatcher.js:377-384`; reuse unchanged to suggest
  which area coordinators to loop in when widening.

Coordinator name is NAME ONLY (no phone) — confirmed `coordinators.json` +
`county_win.py:14-15`. The notify line surfaces the name only.

---

## 4. Tier 1 → Tier 2 progressive UX wireframe

Reframe the existing top toggle from two co-equal modes into a **guided
escalation**. Reuse existing markup/classes in `dispatcher.html`.

```
┌─ Dispatcher Console ─────────────────────────────────────┐
│ TIER 1 — Which county is the animal in?                  │
│   [ County ▾ ]                                           │
│   ┌──────────┬──────────┬──────────┐                     │
│   │  C&T 1/3 │ RVS 0/1  │ Courier  │   (existing cards)  │
│   └──────────┴──────────┴──────────┘                     │
│   Notify: County coordinator → <Name (Area NN)>          │
│   [ Get Recommendation ]   (existing flow)               │
│                                                          │
│   ⚠ Thin in this county?                                 │
│   [ Widen search → enter address + radius ]  ← reveals T2│
└──────────────────────────────────────────────────────────┘
        ▼ (revealed on demand; county carried in as exclude_county)
┌─ TIER 2 — Widen beyond <County> ─────────────────────────┐
│   Animal address [______________]  (autocomplete, today) │
│   Radius (mi) [ 20 ]      [ Find help nearby ]           │
│                                                          │
│   Out-of-county volunteers within 20 mi (context):       │
│   ┌─────────────────────────────────────────────┐        │
│   │ [RVS C&T]  11.4 mi   · Area 10 · Berks        │        │
│   │ [C&T]      18.9 mi   · Area 07 · Lehigh       │        │
│   │ [Courier]  38.2 mi   · Area 05 · Bucks  (edge)│        │
│   └─────────────────────────────────────────────┘        │
│   Sorted by distance · "edge" tag when near radius max   │
│   Aggregate counts + WIN areas + actions (existing)      │
└──────────────────────────────────────────────────────────┘
```

Behavior:
- Tier 2 stays hidden until the dispatcher clicks **Widen search**
  (replace/augment `setMode()` `dispatcher.js:680-684`); county value is read
  from `#county` and sent as `exclude_county` + the request adds `context=1`.
- The context list is a NEW render block in `#address-result`. Each row reuses
  the role-badge styling: a pill like the existing `.win-chip`
  (`dispatcher.html:464-474`) for the role, then `distance_mi` (1 dp) + optional
  `· Area NN · County`. Add a subtle "edge" hint when `distance_mi >= 0.85 *
  radius` so the dispatcher sees outer-edge candidates ("maybe not an option").
- The existing aggregate cards + WIN-area chips + recommended actions
  (`renderAggregate` `dispatcher.js:406-483`) remain below the list, unchanged.
- No new request library: reuse `fetchAggregateByAddress` `dispatcher.js:338-350`
  with the two extra params; render `agg.out_of_county` when present.

Styling: matches the EXISTING light theme tokens (`dispatcher.html:16-35`); a
new `.ctx-row` / `.role-badge` rule pair added to the in-file `<style>`. (Brief
says "dark theme" — page is currently light; see QUESTION Q4.)

---

## 5. PII enforcement point (single serialization seam + test)

- **Single seam:** add one pure function in `worker/src/aggregate.js`, e.g.
  `buildTier2Response(aggregate, contextRows, opts)`, that is the ONLY place the
  Tier 2 JSON object is constructed. It explicitly whitelists keys:
  top-level `{ total_in_range, role_counts, win_areas, out_of_county,
  out_of_county_truncated }`, and per row whitelists
  `{ role, distance_mi, win_area?, county? }`. It receives ALREADY-projected
  rows from `findContextRows` (which never copies `lat`/`lon`/`_addr_sig`), so
  raw KV objects are never passed to the serializer.
- `handler.js` calls this seam and returns its output verbatim
  (mirror the current PII boundary comment `worker/src/handler.js:271-272`). No
  ad-hoc object spreading of KV records anywhere in the request path.
- **Test (mirrors the existing PII discipline in `tests/test_geocoder.py:166-178`):**
  add `worker/test/*.js` (or extend the Worker test suite) asserting:
  1. Given KV records containing `lat/lon/_addr_sig/home_county`, the Tier 2
     response's JSON, deep-walked, contains NONE of the forbidden keys
     (§1) at any depth.
  2. `out_of_county` rows contain ONLY the whitelisted keys.
  3. `exclude_county` rows are absent; remaining rows sorted ascending;
     `distance_mi` is a finite number rounded to 1 dp.
  4. Without `context=1`, response is byte-identical to today's aggregate.

---

## 6. Impact list (files) + data-shape gaps

### D2 — Worker
- `worker/src/handler.js` — parse new params (`exclude_county`, `context`,
  `max_rows`) in `readParams` `:53-95`; after resolving the coord + reading KV
  `:260-269`, branch on `context` and call the new builder; keep the existing
  aggregate-only return when `context` is falsy.
- `worker/src/aggregate.js` — add `findContextRows()` + `buildTier2Response()`
  (pure, reuse `haversineMi`/`clampRadius`/`rolesOf`); export them.
- `worker/test/` — add PII + sorting + filter tests (§5).

### D3 — Frontend
- `docs/dispatcher.html` — reframe toggle into Tier 1 / "Widen" reveal; add a
  Tier 1 "Notify county coordinator" line; add `.ctx-row` / `.role-badge`
  styles; add a context-list container inside `#address-result`.
- `docs/assets/dispatcher.js` — pass `exclude_county` + `context=1` in
  `fetchAggregateByAddress` `:338-350`; render `agg.out_of_county` rows
  (sorted, edge hint) in `renderAggregate` `:406-483`; wire the Widen reveal in
  `setMode`/`init` `:680-684`,`:753-790`; for Tier 1 coordinator line, resolve
  county→area→name (needs county→area map — see GAP/Q1).
- `docs/data/county_win.json` (NEW, committed, PII-free) — `{county: area}` for
  the Tier 1 coordinator line; generated from `counties.xlsx` on the Python
  side (logic already exists in `county_win.py`).

### Data-shape verdict
- **Per-volunteer role:** already in KV (`roles[]`, `geocoder.py:231`). ✅
- **Per-volunteer coord for distance:** `lat`/`lon` already in KV
  (`geocoder.py:229-230`), distance computed server-side. ✅
- **Per-volunteer county/area for the out-of-county filter & context tag:**
  `home_county` + `win_area` already in KV (`geocoder.py:232-233`). ✅
- **NO KV/refresh changes required for Tier 2.** The only NEW artifact is the
  committed `county_win.json` for the Tier 1 notify line (optional if we instead
  let the Worker resolve it).

---

## QUESTIONS (do not invent — need user decision)

- **Q1 — Tier 1 coordinator line source:** commit a PII-free
  `docs/data/county_win.json` (`{county: area}`) so Tier 1 resolves
  county→area→coordinator fully client-side/offline, OR have the Worker return
  the resolved coordinator (couples Tier 1 to the Worker)? Recommended: commit
  the static map.
- **Q2 — Coordinator contact method:** `coordinators.json` is NAME ONLY (no
  phone/email; `county_win.py:14-15`). Is surfacing the coordinator NAME
  sufficient for "notify," or do you want a contact column added upstream?
- **Q3 — Row granularity:** one row PER qualifying role (clear "an RVS C&T at
  11 mi"), or one row per volunteer with a `roles[]` array + an `in_county`
  flag? One-row-per-role is simplest and matches the "qualification + distance"
  framing; confirm.
- **Q4 — Theme:** the brief says "dark theme," but `dispatcher.html` is a LIGHT
  theme today (`--bg:#f5f2ec`). Render the context list in the EXISTING light
  theme (recommended — consistent with the rest of the console), or is a dark
  restyle actually intended/separate?
- **Q5 — Small-N de-anonymization:** a single distinct row like "1 RVS C&T at
  3.0 mi · Berks" can effectively identify a person to a dispatcher who knows
  the roster. Keep exact rows (dispatchers are trusted insiders) or bucket/round
  distance (e.g. nearest 5 mi) below a min cell size? Recommended: exact, since
  no name/coord leaves the Worker.
- **Q6 — `max_rows` cap:** default 25 / max 50 acceptable for the context list?

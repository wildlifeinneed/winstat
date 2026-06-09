# Dispatcher Address-Radius Search — Implementation Design Doc

Status: DRAFT / for review. Read-only planning artifact; no code changed.

Extends the existing **Dispatcher Console** so a dispatcher can search by
**animal ADDRESS + distance (miles)** in addition to the current **COUNTY**
path. The address path finds volunteers whose *home* is within the distance,
maps each volunteer's *home county* to a **WIN area**, and recommends tasking
actions — all while keeping volunteer PII (names + addresses) strictly
server-side.

---

## 1. Current architecture (as built)

Pipeline: **Monday.com board → `refresh_monday.py` (server/CI) → aggregate
JSON committed to repo → static browser app reads JSON.** The browser never
talks to Monday.com and never sees PII.

| Concern | Where | Notes |
|---|---|---|
| Volunteer source | Monday board `9092079933` (`Connecteam_Users`), groups `users` + `non-users` | `refresh_monday.py:56-58` |
| Columns fetched | **County, Roles, Availability only** | `fetch_volunteers` `refresh_monday.py:427-431`; narrow-fetch to stay under Monday complexity budget |
| Volunteer model | `{name, county, roles, availability_text, has_ct, has_rvs, has_courier, available, connecteam_user}` | `build_volunteer_record` `refresh_monday.py:573-602` |
| Qualifying roles | `C&T`, `RVS`, `Courier` | `QUALIFYING_ROLES` `refresh_monday.py:77` |
| Availability logic | blank ⇒ available; denylist keywords + `Unavail M/D` date clauses ⇒ unavailable | `is_available` `refresh_monday.py:553-570` |
| Aggregation | per-county buckets `ct_no_rvs / ct_rvs / courier`, each `{total, available, marginal_volunteers}` | `aggregate_by_county` `refresh_monday.py:684-739` |
| **PII strip** | aggregation drops `name`; `marginal_volunteers` keeps only `availability_note` + `connecteam_user` | `refresh_monday.py:712-717` |
| Output (committed + browser-served) | `docs/data/county_capacity.json` | `OUTPUT_REL_PATH` `refresh_monday.py:169` |
| Browser UI | `docs/dispatcher.html` (county `<select>` + RVS radio + Issue radio + button) | `dispatcher.html:423-466` |
| UI glue | `docs/assets/dispatcher.js` — `fetch('data/county_capacity.json')`, renders cards, calls decision engine | `dispatcher.js:281-289` |
| Decision engine | pure JS, no DOM/fetch | `decision.js` `recommend()` `decision.js:85-166` |
| Defensive PII re-strip | even a stale snapshot's `name` is dropped before the modal | `decision.js:60-68` |
| Connecteam "tasking" | **label only** — `'Dispatch via Connecteam'` text, no deep link/API | `decision.js:7-12`, rendered `dispatcher.js:198-247` |
| Staleness gate | tracker board `6750158385` + sidecar `docs/data/.last_remote_update` | `refresh_monday.py:903-995` |
| Token | `.monday_token` (gitignored) → env fallback | `load_token` `refresh_monday.py:244-264`; `.gitignore:18` |

**Key implication for this feature:** the browser app is a *static reader of a
pre-aggregated JSON*. The address-radius computation (geocoding, distance,
who-is-within-N-miles) MUST run in the same server/CI stage as
`refresh_monday.py`, and only **aggregate counts** may be emitted to a
browser-served file. There is no live backend to query per-request, so the
address search must be designed against a **precomputed, queryable artifact**
(see §4c / Open Question O1).

---

## 2. counties.xlsx — real columns (verified)

File: `counties.xlsx` at repo root (NOT under `docs/`, NOT committed-as-served).
Single sheet `Sheet1`, 67 data rows.

**Primary lookup (cols A–C):**

| Column | Example values |
|---|---|
| `county` | `Adams`, `Allegheny`, `Armstrong`, … (67 PA counties) |
| `area` (= WIN area) | `12`, `10`, `5`, `14`, `7`, … incl. split codes `15N`, `15S` |
| `coordinator` | `Sue DeArment`, `Julia Meredith`, `Jane Pierzga`, … |

**Reverse table (cols H–I, `coordinators` / `areas`)** — coordinator → the set
of areas they own (e.g. `Sue DeArment → 1,2,4,5,12,14,15N,15S,16`). 7 distinct
coordinators total. Columns D–G are empty.

Verified facts:
- **Each county maps to EXACTLY ONE area** — 0 counties span multiple areas.
  (`{county: set(area)}` had no multi-value entries.) So county→area is a clean
  function; no disambiguation logic needed.
- Distinct areas: `1,2,3,4,5,6,7,8,9,10,11,12,13,14,15N,15S,16`. **`area` is
  mixed-type** (ints `12` and strings `15N`) — normalize to string on load.
- **No coordinator contact info** (phone/email) anywhere in the file — only the
  coordinator *name*. (See Open Question O2.)

---

## 3. Volunteer address fields & rehabber locations (verified)

- **Address is NOT currently fetched.** `fetch_volunteers` requests only the
  County/Roles/Availability column IDs (`refresh_monday.py:427-431`). The board
  has ~17 columns (`refresh_monday.py:425` comment), so an address-type column
  very likely exists on Monday, but its exact **title/ID is unconfirmed** —
  must be discovered via `refresh_monday.py --introspect` against a live token.
  (See Open Question O3.)
- **No lat/long is stored anywhere** today — not on Monday (as far as we fetch),
  not in any local file.
- **Coordinator contact info: NAME ONLY** (counties.xlsx col C). No phone/email.
- **Rehabber locations: EXIST.** `pa_wildlife_rehab_facilities.csv` (repo root,
  **gitignored** per `.gitignore:24`) has `County, Facility Name, Contact
  Person, Address, City, State, Zip, Phone, Website, Animals Accepted, Status
  Notes` — 26 facilities with full street addresses. These are **public-facing
  org addresses, not volunteer PII**, so the "closest rehabber" recommendation
  is **feasible in v1** (downgraded from a v2 dependency). It still needs the
  same geocode step (address→lat/long) applied to facility rows. Caveat: the
  served `facilities.html` already surfaces this data publicly, so emitting a
  rehabber name/distance to the browser does not leak PII.

---

## 4. Design

### 4a. Geocoding strategy (addresses → lat/long)

**Recommendation: one-time batch geocode, server-side, store ONLY coordinates;
idempotent re-geocode on changed Monday rows.**

- Add a new server-side step (in or beside `refresh_monday.py`) that, for each
  qualifying volunteer, reads the **Address column** from Monday, geocodes it,
  and stores **only `{monday_item_id, lat, lon, county, geocoded_at,
  address_hash}`** in a **server-side, gitignored** cache file
  (e.g. `volunteer_coords.json`, added to `.gitignore` next to `.monday_token`).
  The raw address is **never persisted** — we keep a salted `address_hash`
  (e.g. SHA-256 of normalized address) purely to detect changes.
- **Idempotency / re-geocode:** on each run, recompute `address_hash` from the
  freshly fetched address. If it matches the cached hash, reuse the cached
  lat/lon (no provider call, no address re-send). If it differs (or the item is
  new), re-geocode and update. Removed Monday items ⇒ prune their cache entry.
- The geocoder is invoked **only at refresh time on the trusted host**, the same
  place `.monday_token` already lives — so addresses leaving the process is an
  existing-trust-boundary concern, not a new browser-facing one.

**Provider analysis (PII-egress lens):**

| Provider | Keyless? | US-only | Egress of address? | Verdict |
|---|---|---|---|---|
| **US Census Bureau Geocoder** | ✅ free, keyless | ✅ US-only (fine — all PA) | Address text sent to a **US-gov** endpoint over HTTPS | **DEFAULT.** No key to manage, no commercial ToS retaining data, batch endpoint (up to 10k rows/CSV). Best PII posture of the hosted options. |
| Self-hosted Nominatim | ✅ (self-run) | global | **Zero external egress** | Best privacy, heaviest infra (PA/US OSM extract + server). Reserve as the "no egress at all" option if Census is rejected. |
| Hosted Nominatim (OSM public) | ✅ | global | Address → 3rd-party; usage-policy limited | Avoid: rate-limited, ToS discourages bulk. |
| Google / Mapbox geocoding | ❌ key + billing | global | Address → commercial provider that may retain/log | Avoid for volunteer home addresses; worse PII posture, cost. |

**Recommended: US Census batch geocoder as default; self-hosted Nominatim as
the documented zero-egress alternative if the user wants no addresses to leave
the host at all.** Either way, addresses are sent **once per change**, and only
coordinates persist.

### 4b. Distance strategy

**Two-stage: haversine bounding-box PRE-FILTER → driving-distance REFINE on the
survivors. Swappable router interface with automatic haversine fallback.**

1. **Pre-filter (cheap, local, no egress):** given the animal lat/lon and radius
   `R` miles, compute a lat/lon bounding box (`±R/69°` lat, `±R/(69·cos lat)`
   lon), keep volunteers inside it, then keep those whose **haversine** distance
   ≤ `R`. This narrows hundreds of volunteers to a handful with pure arithmetic.
2. **Refine (driving distance, preferred):** for the survivors only, call the
   router for **driving** distance/time from the animal location to each
   volunteer (and to each candidate rehabber). Driving distance is the spec's
   PREFERRED metric; the pre-filter keeps the matrix call small (1×N, small N).
3. **Fallback:** if the router is unavailable/errors/times out, **use the
   haversine number** already computed in step 1 and **flag the result as
   `distance_mode: "straight_line"`** so the UI can say "approx (straight-line)".

**Swappable interface:** define a `DistanceProvider` with
`matrix(origin, destinations) -> [{meters, seconds, mode}]`. Concrete impls:
`HaversineProvider` (always available), `OsrmProvider`, `OrsProvider`. A wrapper
tries the configured driving provider, catches any failure, and transparently
falls back to `HaversineProvider`.

**Driving-distance provider analysis (egress/cost):**

| Provider | Egress | Cost | Infra | Verdict |
|---|---|---|---|---|
| **Self-hosted OSRM/Valhalla** | **Zero** — coords stay on host | free | OSM extract + routing server | **PREFERRED for the PII rules.** Only *coordinates* (already de-identified) would move even in the hosted case, but zero-egress is strictly safest and aligns with the "coords live server-side only" rule. |
| OpenRouteService (free tier) | coords → 3rd party | free tier (quota) | none | Acceptable fallback if self-hosting is too heavy. Sends only **coordinates**, never addresses — lower risk than geocoding egress. |
| Google / Mapbox matrix | coords → commercial | paid | none | Avoid unless the others are infeasible; cost + retention. |

**Recommendation:** **self-hosted OSRM** for driving distance (zero egress),
with **haversine as the guaranteed fallback**. If standing up OSRM is out of
scope for v1, ship **haversine-only** first (clearly labeled straight-line) and
add the OSRM provider in a later phase — the swappable interface makes this a
drop-in. ORS free tier is the documented middle option. Note: only **coordinates
(not addresses)** ever reach any router, so even the hosted-router path does not
expose home addresses.

### 4c. Data model

Three server-side data sources, one browser-served artifact:

1. **`volunteer_coords.json` (server-side, gitignored, NEW):** per qualifying
   volunteer `{id, lat, lon, county, has_ct, has_rvs, has_courier, available,
   address_hash, geocoded_at}`. **No name, no address.** This is the only place
   coordinates live.
2. **`county_win.json` (committed, NEW, derived from counties.xlsx):** build-time
   export of `{county → {area, coordinator}}` plus reverse `{coordinator →
   [areas]}`. Generated by a small `build_county_win.py`. Browser-safe (no PII).
   `area` normalized to string (`"15N"`).
3. **`rehabber_coords.json` (server-side or committed):** geocoded
   `pa_wildlife_rehab_facilities.csv` rows `{name, county, lat, lon}`. Facility
   addresses are public, so this MAY be committed; only lat/lon + name needed
   downstream.

**Home-county → WIN-area rule (critical):** the WIN area to notify is driven by
each matched volunteer's **HOME county** (the `county` field already on the
volunteer record), **NOT the animal's county**. For each volunteer within `R`,
look up `county_win.json[volunteer.county].area`; the **set of distinct areas**
across all in-radius volunteers is what gets tasked. (Animal location only
defines the radius origin and the closest-rehabber target.)

**Browser-served artifact — Open Question O1 (precompute vs. live):** the app is
static, so the address search needs either:
- **(A) Live geocode + distance in the browser/edge** — but driving distance and
  geocoding need server resources, and we must NOT ship volunteer coords to the
  browser. So a thin **server/edge endpoint** would be required (new infra).
- **(B) Fully precomputed** — infeasible: the animal address is arbitrary
  per-call, can't be precomputed.
- **(C, recommended) Minimal query service:** a small server endpoint that holds
  `volunteer_coords.json` in memory, accepts `(animal_address_or_latlon,
  radius)`, geocodes the *animal* address, runs §4b, and returns **only
  aggregate counts + area set + rehabber name/distance** — never coords/PII.
  This is the smallest addition that honors the PII rule. **Needs user decision
  on hosting (see O1).**

### 4d. Input / UX

- **County-OR-address branch** in `dispatcher.html`: add a mode toggle (radio:
  *By County* | *By Address*). County mode = today's flow, unchanged. Address
  mode reveals an **address text input** + a **distance (miles) input**
  (default e.g. 10). RVS/Issue radios apply to both modes.
- On submit (address mode): client posts `{address, miles, rvs, issue}` to the
  query service (O1); shows a spinner; renders the aggregate result.
- **Graceful geocode failure:** if the *animal* address can't be geocoded,
  show an inline error ("Couldn't locate that address — check spelling or try a
  ZIP / nearby intersection, or switch to County search") and do NOT fall back
  silently to a wrong location. If a *volunteer* address failed geocoding at
  refresh time, that volunteer is simply absent from radius results (logged
  server-side); surface a soft note if the excluded-count is high.
- **Distance-mode label:** when the router was unavailable, badge results
  "approx (straight-line)".

### 4e. Recommendation engine (rules)

Inputs (address mode): per-role in-radius counts `{ct_no_rvs, ct_rvs, courier}`
(available + total), the set of **WIN areas** present, the nearest in-radius
volunteer's distance, the nearest **rehabber** name/distance, plus `rvs`/`issue`
(reuse existing `decision.js` semantics: capture+RVS needs `ct_rvs`,
capture+non-RVS needs any C&T, transport prefers courier then C&T).

Rules → actions:
1. **Qualified volunteers in radius (per existing role match) ≥ threshold:**
   → **"Put out Connecteam tasking to WIN area(s) X [and Y]"**, listing the
   distinct areas of the *matched* volunteers' home counties. Reuse the existing
   `marginal_threshold` / `*_min_available` config (`refresh_monday.py:143-151`,
   mirrored `decision.js:25-30`).
2. **No qualified volunteers in radius (pool below threshold):**
   → **"Call PA Game Commission (PGC)"** — same PGC-referral threshold logic as
   today's county path (`decision.js` A/B/C/D branches).
3. **Volunteers exist but are marginal / sparse (e.g. only one area, all
   marginal):** → also surface **"Contact the Area X Coordinator"** using
   `county_win.json[...].coordinator`. (Contact *method* is name-only today — see
   O2.)
4. **Transport gap (animal far from any rehabber, no courier/C&T in radius):**
   → **"Try to find someone local to transport to the closest rehabber:
   `<Facility>` (~`<d>` mi)"**, using `rehabber_coords.json`. Feasible in v1
   since facility data exists.

Exact thresholds inherit the existing config so dispatchers keep one tuning
surface. The area list in rule 1 is the **home-county-derived** set from §4c.

### 4f. PII enforcement points

Boundaries where addresses/coords MUST be stripped before reaching any
browser-visible surface:

1. **Geocode step:** raw address used in-memory only; persist **lat/lon +
   hash**, never the address string (§4a).
2. **`volunteer_coords.json`:** gitignored, server-side only; add to `.gitignore`
   beside `.monday_token`. Never copied under `docs/` (the served dir).
3. **Query-service response (O1/C):** returns **aggregate counts, area set,
   rehabber name/distance** ONLY. Code path must construct the response from
   counts — never serialize a volunteer object. Mirror the existing
   aggregate-only discipline (`refresh_monday.py:712-717`) and the defensive
   re-strip pattern (`decision.js:60-68`).
4. **Browser/UI:** displays aggregates + area numbers + rehabber name only. No
   per-volunteer rows, ever.
5. **Logs:** server logs may reference `monday_item_id`/county/coords for
   debugging but **must not log volunteer names or addresses**.

**Small-N de-anonymization:** "1 RVS C&T within 3 miles" can effectively
identify a person to a dispatcher who knows the roster. Recommend a
**minimum-cell-size guard**: below a configurable `min_cell` (default 1, i.e.
still show exact small counts since dispatchers are trusted insiders), but make
it **configurable** so the user can choose to bucket ("1–2") if the surface ever
becomes less trusted. Flag as a policy choice — see O4.

### 4g. Phase breakdown (small, testable, one at a time)

- **Phase A — county→WIN lookup (no Monday, no geocoding).** `build_county_win.py`
  reads `counties.xlsx` → emits committed `docs/data/county_win.json`
  (`{county→{area,coordinator}}` + reverse). *Verify:* unit test asserts 67
  counties, each one area, `15N/15S` preserved as strings, coordinator set = 7.
- **Phase B — discover + fetch volunteer Address from Monday.** Run
  `--introspect`, confirm the Address column title/ID, add it to the narrow
  fetch and to `build_volunteer_record` (server-side only; address never
  written to the served snapshot). *Verify:* dry-run shows addresses present in
  memory and absent from `county_capacity.json`.
- **Phase C — geocoder + `volunteer_coords.json` (gitignored).** Implement Census
  batch geocode + idempotent hash cache. *Verify:* re-run does zero provider
  calls when addresses unchanged; coords file has no address/name; `.gitignore`
  updated.
- **Phase D — distance interface + haversine.** `DistanceProvider`,
  `HaversineProvider`, bounding-box pre-filter, `within_radius(animal_latlon, R)`.
  *Verify:* unit tests on known coordinate pairs; bbox prune correctness.
- **Phase E — recommendation engine (address mode).** Extend `decision.js` (or a
  sibling module) to take in-radius counts + area set + rehabber distance and
  emit the §4e actions. *Verify:* table-driven JS tests mirroring
  `tests/test_decision.js`.
- **Phase F — geocode rehabbers + closest-rehabber line.** Geocode
  `pa_wildlife_rehab_facilities.csv` → `rehabber_coords.json`; wire rule 4.
  *Verify:* nearest-facility unit test.
- **Phase G — query service + UI branch.** Stand up the minimal endpoint (O1),
  add the By-County / By-Address toggle, distance input, geocode-failure UX.
  *Verify:* end-to-end with a sample address; confirm response payload contains
  **no coords/PII** (assert in test).
- **Phase H — driving distance (OSRM) provider + fallback.** Add `OsrmProvider`,
  wire automatic haversine fallback + `distance_mode` labeling. *Verify:* router
  outage path falls back and labels correctly.

Each phase is independently shippable and verifiable; A–F have **no new infra**
and no browser exposure, so risk is back-loaded into G/H.

---

## 5. Open questions (need user decision)

- **O1 — Hosting for the address query:** the current app is a static
  GitHub-Pages-style site (browser reads committed JSON). Address search needs a
  small server/edge endpoint to hold volunteer coords and run geocode/distance
  *without* shipping coords to the browser. **Where should this run** (e.g. a
  tiny serverless function, a local script the dispatcher runs, an internal
  host)? This is the single biggest architectural fork.
- **O2 — Coordinator contact method:** counties.xlsx has coordinator *names*
  only (no phone/email). For "Contact the Area X Coordinator," do you want to add
  a contact column to counties.xlsx, or is surfacing the name enough?
- **O3 — Monday Address column:** what is the exact **title** of the home-address
  column on board `9092079933`? (Confirm via `--introspect`.) Is it a single
  free-text field or structured (street/city/zip)? Affects geocode input
  normalization.
- **O4 — Small-N policy:** are dispatchers fully trusted insiders (so exact small
  counts like "1 within 3 mi" are fine), or do you want a minimum-cell-size
  bucket for defense-in-depth?
- **O5 — Driving distance infra:** OK to **self-host OSRM** (zero egress,
  preferred), or should v1 ship **haversine-only** and defer OSRM? (ORS free
  tier is the middle path, sends coords only.)
- **O6 — Radius default & cap:** default miles for the input, and a sane max
  (to bound matrix calls)?

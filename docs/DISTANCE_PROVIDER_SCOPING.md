# Driving-Distance Scoping Assessment

**Question:** What is the effort to move from straight-line (haversine) distances to **actual driving distances + times**?

**Scope:** READ-ONLY analysis. No code was changed. Grounded in the actual repo
state (browser `docs/assets/dispatcher.js`, Cloudflare Worker `worker/src/*.js`,
and the Python core `dispatch_core.py`).

---

## TL;DR

- **Haversine is called *inline*** everywhere that matters in production. The
  swappable `DistanceProvider` (design intent "O5"/Phase H) **was only built in
  the Python module `dispatch_core.py`**, which is **not in the runtime path**.
  The two things that actually run — the **browser** (`dispatcher.js`) and the
  **Cloudflare Worker** (`aggregate.js`) — do **not** have a provider seam wired
  into their call sites. The Worker has a *half-seam* (an optional `distanceFn`
  argument) that is never passed.
- **Cheapest useful first step:** add driving distance/time to the **rehabber
  top-3 panel only**. Rehabber coords are **public**, so the call can even run
  from the browser. **Size: S–M.**
- **Converting the volunteer radius aggregate to driving distance is much
  higher effort (M–L)** because volunteer coords are **PII** and must never
  leave the Worker — driving distance there requires a **self-hosted routing
  engine** (or an explicit privacy decision to send coords to a 3rd party).

---

## 1. Call-site inventory (every place distance is computed)

### A. Browser — `docs/assets/dispatcher.js`

| # | Symbol | Lines | Coords used | Feeds | Rank / Filter |
|---|---|---|---|---|---|
| A1 | `haversineMiles()` | 447–456 | (helper) | the two functions below | — |
| A2 | `findClosestRehabber(lat, lon)` | 502–517 | **animal + REHABBER** | the "transport to closest rehabber" recommendation (called at line **1071**, only when `ctx.lat/lon` present) | **Ranks** (min distance) |
| A3 | `nearestRehabbers(lat, lon, n)` | 527–546 | **animal/centroid + REHABBER** | the **Nearest-rehabber top-3 panel** (`renderNearestRehabbers`, lines 815–910; invoked at **1092** via `pickRehabberOrigin`) | **Ranks** (sort asc, slice top-3) |
| A4 | county-centroid origin | `pickRehabberOrigin` 920–934; centroids built 1491–1514 | **county centroid (public)** | supplies the *origin* for A3 when there is no animal geocode | feeds origin only |

Notes:
- Rehabbers are loaded into the browser from `data/rehabbers.json`
  (`loadRehabbers`, lines 1751–1758) with `lat/lon` — **public facility data,
  already in the browser**.
- The animal coordinate is also browser-side / echoed back by the Worker as
  `animal_lat/animal_lon` (explicitly NOT volunteer PII — see handler comment
  329–333).
- **Open/closed is intentionally not used** here (comments 498–501, 519–526);
  driving distance does not change that.

### B. Cloudflare Worker — `worker/src/aggregate.js` (the CORE feature)

| # | Symbol | Lines | Coords used | Feeds | Rank / Filter |
|---|---|---|---|---|---|
| B1 | `haversineMi()` | 69–79 | (helper) | both functions below | — |
| B2 | `findVolunteersInRadius(...)` | 149–208 | **animal + VOLUNTEER (PII)** | the **address-radius aggregate** (`total_in_range`, `role_counts`, `role_available`, `win_areas`) — invoked in `handler.js` **293–298** | **Filters** (`d > radius` → skip, line 179) |
| B3 | `findContextRows(...)` | 249–305 | **animal + VOLUNTEER (PII)** | Tier-2 "widen" out-of-county list (`out_of_county[].distance_mi`) — invoked in `handler.js` **305–311** | **Both** — filters (`d > radius`, 271) *and* ranks (sort asc, 303; `distance_mi` is surfaced rounded, 297) |

Notes:
- B2/B3 take an **optional `distanceFn` arg** (`dist = distanceFn || haversineMi`,
  lines 150 & 250) — a *partial* seam — but `handler.js` **never passes one**
  (293–298, 305–311), so haversine is always used in production.
- The Worker's `distance_mi` in B3 is the **only distance number that leaves the
  server**, and it is the *volunteer's* straight-line distance. Switching it to
  driving distance is what the spec's "preferred metric" really wants — and it
  is the PII-sensitive one.

### C. Python — `dispatch_core.py` (NOT in the runtime path)

| # | Symbol | Lines | Notes |
|---|---|---|---|
| C1 | `DistanceProvider` (abstract) + `HaversineProvider` | 106–147 | The **real seam**, but Python-only. |
| C2 | `find_volunteers_in_radius(provider=...)` | 244–299 | provider-injectable |
| C3 | `find_closest_rehabber(provider=...)` | 307–364 | provider-injectable |

`aggregate.js` is described in its own header (lines 4–8) as a **"direct JS port
of dispatch_core.py"**, but the port **flattened the class-based provider into a
single function + optional `distanceFn`** and the browser never had the seam at
all. So the abstraction exists in the prototype language, not the shipped one.

---

## 2. True state of the "swappable DistanceProvider" seam

| Layer | Runtime? | Seam state |
|---|---|---|
| `dispatch_core.py` | **No** (offline prototype/tests) | Full ABC seam (`DistanceProvider`/`HaversineProvider`), provider injectable. |
| Worker `aggregate.js` | **Yes** | **Half-seam**: functions accept optional `distanceFn`, but it is `matrix`-unaware (scalar `(aLat,aLon,bLat,bLon)->miles`), **synchronous**, and **never wired** from `handler.js`. No `OsrmProvider`/wrapper/fallback exists. |
| Browser `dispatcher.js` | **Yes** | **No seam** — `haversineMiles` is called inline in A2/A3. |

The design doc (`docs/dispatcher-address-radius-plan.md` §4b, 135–172) specified
a richer `matrix(origin, destinations) -> [{meters, seconds, mode}]` interface
with `OsrmProvider`/`OrsProvider` and automatic haversine fallback + a
`distance_mode` label. **None of that matrix interface was built.** Reality: a
scalar synchronous haversine, called inline (browser) or via an unused
`distanceFn` hook (Worker).

**Implication:** there is no drop-in slot today. Any driving-distance work
requires (a) defining an **async, batched (matrix) provider interface**, and
(b) **threading async** through the call sites (the Worker is already async; the
browser ranking functions are currently synchronous and would need to become
async or be fed pre-computed distances).

---

## 3. PII analysis per call site (critical constraint)

**Rule:** volunteer coordinates live only server-side (Worker + KV) and must
**never** reach the browser or an unintended 3rd party. Rehabber + animal coords
are not volunteer PII.

| Call site | Endpoint that must do routing | Coords sent to router | PII verdict |
|---|---|---|---|
| **A2 `findClosestRehabber`** | Browser *or* Worker | animal + **rehabber** (public) | **Safe.** Both endpoints are public; can call a 3rd-party API directly. |
| **A3 `nearestRehabbers` (top-3 panel)** | Browser *or* Worker | animal/centroid + **rehabber** (public) | **Safe.** Same as A2. This is the low-risk target. |
| **A4 county centroid** | — | public centroid | **Safe.** Public geometry. |
| **B2 `findVolunteersInRadius`** | **Worker only** | animal + **VOLUNTEER** | **PII-sensitive.** Volunteer coords cannot go to a 3rd-party API without an explicit privacy decision. Needs **self-hosted** routing for zero egress. |
| **B3 `findContextRows`** | **Worker only** | animal + **VOLUNTEER** | **PII-sensitive.** Same as B2; additionally this is the path whose `distance_mi` is already exposed (as straight-line) — converting it is the user-visible win but the riskiest. |

**Key asymmetry:** the *public* (rehabber) computations can use any provider
from anywhere; the *PII* (volunteer) computations are pinned to a server-side,
ideally self-hosted, router. Even for the PII path, **only coordinates** (not
addresses, names, or phones) would ever reach a router — but for the strictest
reading of the rule that still warrants self-hosting (zero egress).

---

## 4. Provider options & tradeoffs for THIS app

Architecture = **static GitHub Pages frontend + Cloudflare Worker backend + KV**.
Matrix sizes are small: **≤25 rehabbers** (1×N for the panel) and **N volunteers
in radius** (typically a handful after the radius filter; capped — Tier-2
truncates to nearest 5/15).

| Provider | Where it must run (given PII) | Rough cost | Key/secret handling | Matrix limits | Rate limits | Offline / fallback |
|---|---|---|---|---|---|---|
| **Self-hosted OSRM / Valhalla** | Anywhere, incl. **volunteer (PII) path** — zero egress | Free software; **needs a host** (a small VM / container with a PA-or-Northeast OSM extract). The one real infra cost/ops burden. | None (own service); restrict by network/CORS. Worker → your OSRM URL. | OSRM `/table` handles 1×N and N×N easily for these sizes. | Self-imposed. | **PREFERRED.** Wrap with try/catch → haversine; emit `distance_mode`. |
| **OpenRouteService (ORS) free tier** | Public path OK; PII path only with explicit decision (coords → 3rd party) | Free tier (quota-limited) | API key — **must live as a Worker secret** (`wrangler secret put`), never in the browser. | Matrix endpoint fine for 1×25 and small N×N; watch daily quota. | ~ a few req/min on free tier; could throttle bursts. | try/catch → haversine. |
| **Mapbox Matrix** | Public path from Worker (key) | Paid after free allotment | Token as Worker secret; browser-exposed tokens are URL-restricted but still leak. | 25×25 per call (matches rehabber cap). | Generous paid. | try/catch → haversine. |
| **Google Distance Matrix** | Worker (key) | Paid per element; has retention/ToS concerns | Key as Worker secret. | 25 dest/call, 100 elements/call. | Paid. | try/catch → haversine. |

**Recommendation (matches design doc §4b, 166–172):**
- **Rehabber (public) path:** start with **ORS free tier or Mapbox**, called
  **from the Worker** (so the key stays a secret). It's cheap and needs no new
  infra. (Browser-direct is technically possible since data is public, but
  routing the call through the Worker keeps the API key off the client.)
- **Volunteer (PII) path:** **self-hosted OSRM** for zero egress, with
  **haversine as the guaranteed fallback** and a `distance_mode` label. This is
  the only option that fully honors the PII rule without a new privacy decision.

---

## 5. Phased effort estimate

### Phase 1 — Driving distance/time on the REHABBER top-3 panel only  → **S–M**

Lowest-risk; public data; biggest perceived UX win for the dispatcher.

New moving parts:
- A **matrix provider client** (`matrix(origin, destinations) -> [{meters,
  seconds}]`) — define the async interface that's missing today.
- Decide **where it runs**: simplest secret-safe option is a **new Worker route**
  (e.g. `?rehab_matrix=1` with animal/origin + the ≤25 rehabber coords, or have
  the Worker hold rehabber coords) that calls ORS/Mapbox with a **Worker secret**
  and returns `[{meters, seconds, mode}]`.
- **Browser changes:** make `nearestRehabbers`/`renderNearestRehabbers` consume
  driving distance+time when available (it currently sorts synchronously by
  haversine — either await the matrix then render, or pre-rank by haversine and
  annotate with driving time). Add a `distance_mode` indicator + the time field
  to the row UI (`messages.js` strings already localize this panel).
- **Caching:** rehabber coords are static; cache the animal→rehabber matrix per
  (origin, radius) for the session / KV TTL to cut quota.
- **Fallback:** on any provider error/timeout → existing `haversineMiles`,
  labeled "approx (straight-line)".

Risks: async refactor of a currently-synchronous render path; quota/rate limits;
keeping the API key off the client (favor the Worker route).

### Phase 2 — Convert the VOLUNTEER radius aggregate to driving distance → **M–L**

Higher effort + architecture/PII implications.

New moving parts:
- **Self-hosted OSRM/Valhalla** instance (new infra to stand up, host, monitor,
  and keep the OSM extract fresh) — the dominant cost.
- **Two-stage filter** per the design doc (§4b, 137–151): keep the cheap
  haversine **bounding-box pre-filter** to shrink N, then call OSRM `/table`
  **animal → survivors** for driving distance/time; refine the radius decision
  on driving distance.
- **Worker changes:** thread an **async** provider through `findVolunteersInRadius`
  (B2) and `findContextRows` (B3). Both currently use a **sync** `distanceFn`;
  the radius filter (`d > radius`, lines 179 & 271) and the sort/round in B3
  (297, 303) must move to an async, batched flow. Surface `distance_mode` in
  `buildTier2Response` (and possibly the legacy aggregate).
- **Secret/config:** OSRM base URL as a Worker var/secret; CORS/network lock-down
  so only the Worker can reach OSRM.
- **Fallback:** OSRM down/slow → fall back to the haversine number already
  computed in the pre-filter, flag `distance_mode: "straight_line"`.

Risks (biggest first):
1. **Standing up + operating OSRM** (infra, updates, uptime) — the real cost.
2. **Async refactor of the Worker core** (B2/B3) including the PII-safe
   serialization seams (`buildTier2Response`) — easy to regress the PII boundary.
3. **Filtering semantics change**: switching the radius test from straight-line
   to driving distance changes *who is in range* (driving > straight-line), which
   can shift counts the dispatcher relies on — needs product sign-off + the
   `distance_mode` label so users know which metric gated the result.
4. Latency/timeout budget for the radius call inside the Worker.

### Recommended path

1. **Ship Phase 1 first** (rehabber driving distance+time via a Worker matrix
   route with ORS/Mapbox + haversine fallback). It's S–M, public-data-only, and
   delivers the visible "driving time to the rehabber" value immediately.
2. **Defer Phase 2** until/if there is appetite to run OSRM. The cheapest useful
   step that touches the PII path is to **keep haversine as the radius gate but
   add an OSRM-driven driving time annotation** on the Tier-2 rows once OSRM
   exists — i.e. don't change *who's in range*, just *label the driving time* —
   which sidesteps risk #3 while still giving drivers real ETAs.

**Cheapest useful first step overall:** Phase 1, rehabber-only, Worker-routed,
with automatic haversine fallback.

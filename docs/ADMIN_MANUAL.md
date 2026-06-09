# PA Wildlife Rehab Dispatcher — Admin / Maintainer Manual

This guide is for the person who keeps the dispatcher running — not a developer.
It assumes you already know what the app does for the user. It covers where the
wording lives, how to tune behavior, how the data gets refreshed from Monday.com,
how the Cloudflare Worker works, and how to deploy the site.

Everything below describes the **actual live files** in this repository. File
paths are relative to the project root (`PA-Wildlife-Rehab/`).

---

## 1. Wording + Thresholds

There are two places that control text and behavior:

- `docs/assets/messages.js` — all user-facing **wording** and the **fallback** numeric thresholds.
- `docs/data/config.json` — the **live** numeric tuning knobs (with optional per-county overrides).

### 1a. `docs/assets/messages.js` — the single source of truth for wording

This file holds two kinds of values:

1. **Wording** — every sentence/label the dispatcher shows a person. These live
   under `tier1Actions`, `tier2Aggregate`, `coordinator`, `recommendation`,
   `stale`, `geocodeErrors`, and `staticUi`. **Edit these freely** to change what
   the page says. The decision logic does not depend on the exact text — only on
   which *key* is chosen.

2. **Thresholds** — the numeric tuning knobs under `M.thresholds`. These change
   **behavior** (when the app tells the finder to call PA Game Commission, when a
   "Marginal" badge appears). Change the **numbers** only; do **not** rename keys.

The thresholds block, exactly as it ships:

```52:60:docs/assets/messages.js
    thresholds: {
      // Cards show a low-capacity warning + roster when available <= this.
      marginal_threshold: 1,
      // If available_count for that bucket is < this, recommend calling PGC
      // instead of dispatching a Connecteam task.
      ct_rvs_capture_min_available: 1,
      ct_any_capture_min_available: 1,
      courier_transport_min_available: 1
    },
```

**Placeholders / `{tokens}`.** Some wording contains tokens like `{count}`,
`{area}`, `{areas}`, `{name}`, `{radius}`, `{county}`, `{phone}`, `{role}`,
`{label}`. At render time the code calls `fmt(template, { count: 3, ... })` and the
token is replaced with the value. **Keep the tokens spelled exactly** when you
reword. Dropping a token just drops that value from the sentence; inventing a new
token does nothing (it is left in the text as-is).

The `fmt()` helper is a pure substitution function — no logic:

```241:248:docs/assets/messages.js
  function fmt(template, values) {
    if (typeof template !== 'string') return template;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, function (whole, key) {
      return Object.prototype.hasOwnProperty.call(values, key)
        ? String(values[key]) : whole;
    });
  }
```

**`PGC_PHONE`.** The PA Game Commission dispatch line is defined **once** at the
top of the file and exposed as `M.pgcPhone`. It appears in several messages and in
the page footer note. Update it in this one spot:

```42:42:docs/assets/messages.js
  var PGC_PHONE = '(833) 742-4868 or (833) 742-9453';
```

Reword the sentences around it as you like, but leave the `{phone}` token where the
number should appear.

**What NOT to put in `messages.js`:** no logic. This file is data only.
Pluralization, distance math, and which branch is chosen all stay in
`decision.js` / `dispatcher.js`. Do not add functions or conditionals here.

### 1b. `docs/data/config.json` — live thresholds + per-county overrides

This is the file you edit to actually **change behavior in production** without
touching code. It ships as global defaults with an empty overrides block:

```1:10:docs/data/config.json
{
  "_comment": "Wildlife dispatcher config. marginal_threshold: cards show low-capacity warning + roster when available <= this. escalate_to_game_commission.*_min_available: if available_count for that bucket is < this number, Phase 3 will recommend calling PA Game Commission instead of dispatching a Connecteam task. county_overrides: per-county deep-merge override of any of the above. Defaults are global; per-county keys override only the specified leaves.",
  "marginal_threshold": 1,
  "escalate_to_game_commission": {
    "ct_rvs_capture_min_available": 1,
    "ct_any_capture_min_available": 1,
    "courier_transport_min_available": 1
  },
  "county_overrides": {}
}
```

**Deep-merge of `county_overrides`.** A per-county block overrides only the *leaf*
values you specify; everything else falls back to the global value, and then to the
baked-in default. For example, to make **Allegheny** show the low-capacity warning
when there is 2 or fewer available (instead of the global 1), and to require 2
RVS-capture volunteers there before dispatching:

```json
{
  "marginal_threshold": 1,
  "escalate_to_game_commission": {
    "ct_rvs_capture_min_available": 1,
    "ct_any_capture_min_available": 1,
    "courier_transport_min_available": 1
  },
  "county_overrides": {
    "Allegheny": {
      "marginal_threshold": 2,
      "escalate_to_game_commission": {
        "ct_rvs_capture_min_available": 2
      }
    }
  }
}
```

Counties not listed in `county_overrides` keep the global values. County names must
match the canonical PA county list (e.g. `"Allegheny"`, `"Northampton"`); an unknown
name is ignored with a warning during refresh.

### 1c. `config.json` wins over `messages.js` thresholds

The thresholds in `messages.js` are the **fallback** defaults. When
`docs/data/config.json` supplies a value (global or per-county), **that value
wins**. The browser code mirrors this exactly: `DEFAULT_CONFIG` in `dispatcher.js`
is seeded from `MSG.thresholds`, then `resolveForCounty()` overlays the loaded
`config.json` global, then the per-county override.

```68:75:docs/assets/dispatcher.js
  var DEFAULT_CONFIG = {
    marginal_threshold: MSG.thresholds.marginal_threshold,
```

So the resolution order, lowest-to-highest priority, is:

1. `messages.js` `M.thresholds` (hard fallback)
2. `config.json` global values
3. `config.json` `county_overrides[<county>]` leaves

The same deep-merge runs server-side in `refresh_monday.py`
(`resolve_marginal_threshold`) so the snapshot and the page agree.

---

## 2. Data Refresh

The dispatcher's data is pulled from Monday.com by `refresh_monday.py` and
published as JSON under `docs/data/`. Refreshes are normally automatic via CI; you
trigger one by bumping a sentinel.

### 2a. The `VOLDB_Status` sentinel board (`6750158385`)

CI does not pull the (large, expensive) Monday boards on every run. It first checks
a small **sentinel** board, `VolDB_Status` (board id `6750158385`), and only does a
full pull when that board's `Last_Updated` value has advanced.

```65:67:refresh_monday.py
TRACKER_BOARD_ID = "6750158385"          # VolDB_Status
TRACKER_GROUP_TITLE = "VolunteerDB Last Update"
TRACKER_COL_TITLE_LAST_UPDATED = "Last_Updated"
```

**To trigger a refresh:** open the `VolDB_Status` board in Monday and bump
`Last_Updated` to a newer date/time. The next CI run (daily cron, or a manual
"Run workflow") will see the advance and do the full pull. If `Last_Updated` has
not moved, CI prints "fresh, skipping" and does nothing — this is the normal,
expected behavior most days.

### 2b. The boards the refresh reads

`refresh_monday.py` reads four Monday boards. Column **IDs** (not human labels) are
used where labels are ambiguous, and were confirmed via Monday introspection.

**RehabDB — board `9092004762` (public rehabber facilities).**
Rehabbers are public-facing facilities, so this data is committed to the public
`docs/` folder. Key columns:

```189:201:refresh_monday.py
REHAB_COL_IDS = {
    "rehab_name": "text_mkv6bp9s",
    "city": "text_mkqqc1s1",
    "address": "text_mkqqff5k",
    "state": "text_mkqqk1xk",
    "zip": "text_mkqqe6qe",
    "county": "text_mkqqk5cb",
    "phone": "text_mkqqtre3",
    "latitude": "text_mkqqj30w",
    "longitude": "text_mkqqrt6e",
    "website": "text_mkv8njgj",
    "availability": "text_mkqqgq94",
}
```

- name/facility, phone (`text_mkqqtre3`), and availability (`text_mkqqgq94`) come
  from these text columns.
- lat/lon are **already on the board** (`text_mkqqj30w` / `text_mkqqrt6e`), so no
  geocoding is done for rehabbers; rows missing lat/lon are skipped.
- The board's **open/closed status column (`color_mkv6xbc`) is intentionally NOT
  pulled** — it is not the live availability surface (see §6 Beta Caveats), so
  surfacing it would mislead.

**Volunteer board — `9092079933` (Connecteam_Users).**
This is the volunteer roster. The refresh aggregates per-county capacity by role
bucket (C&T no-RVS / C&T+RVS / Courier). Volunteer addresses are geocoded into
lat/lon and written to a **PRIVATE** coords dataset
(`data/volunteer_coords.json`). That coords file contains only
`{lat, lon, roles, home_county, win_area}` — no names, addresses, or phone — and is
**gitignored / never committed / never public**. It is pushed only to private
Cloudflare KV (see §3).

```58:58:refresh_monday.py
BOARD_ID = "9092079933"          # Connecteam_Users
```

**Coordinator board — `18416913502` (Area Coordinators).**
Maps each WIN area to a coordinator name. Two important rules:

- The board's **item name** is the WIN area string (e.g. `"15N"`, `"10"`).
- The coordinator **name** comes from `long_text_mm455k2n`.
- The coordinator **phone column (`phone_mm45s2h0`) is NEVER fetched, stored, or
  emitted.** The site is public GitHub Pages; only area + name reach the public
  output.

```215:219:refresh_monday.py
COORDINATORS_BOARD_ID = "18416913502"   # Area Coordinators
COORDINATORS_GROUP_TITLE = "Coordinators"
COORD_COL_IDS = {
    "name": "long_text_mm455k2n",
}
```

### 2c. What `refresh_monday.py` does

On a full run (no `--if-stale` skip), the script:

1. Pulls volunteers from `Connecteam_Users` and aggregates per-county capacity by
   role bucket; writes the public `docs/data/county_capacity.json`.
2. Geocodes volunteer addresses into the **private** `data/volunteer_coords.json`
   (gitignored; PII-derived but stripped to lat/lon/roles/county/area).
3. Pulls `RehabDB` and writes the public `docs/data/rehabbers.json` (no geocoding;
   lat/lon already on the board).
4. Pulls `Area Coordinators` and writes the public `docs/data/coordinators.json`
   (area → name; phone excluded).
5. Stamps the sidecar (`docs/data/.last_remote_update`) with the remote sentinel
   timestamp so future `--if-stale` runs can compare.

Useful flags: `--dry-run` (print, don't write), `--diff` (county-level diff vs the
existing snapshot), `--if-stale` (sentinel pre-check; what CI uses),
`--introspect` (print resolved column IDs), `--verbose` (debug logging).

The Monday API token is read from a gitignored `.monday_token` file in the project
root, or the `MONDAY_API_TOKEN` environment variable.

### 2d. PII rule

The volunteer coords dataset is the only private dataset. It lives under
`data/` (not `docs/`) so the static site never publishes it, and it is gitignored:

```25:27:.gitignore
# Phase B — PRIVATE volunteer coords dataset (derived from PII addresses).
# Contains only lat/lon/roles/home_county/win_area but must NEVER be committed.
data/volunteer_coords.json
```

CI enforces this with defense-in-depth: it only `git add`s an explicit allow-list of
public paths, asserts the staged diff touches nothing else, and scans staged content
for PII-shaped keys (phone/email/address/etc.). Any violation aborts the push.
**Rule of thumb: never commit `data/volunteer_coords.json`, and never put volunteer
phone/address into a `docs/data/*` file.**

---

## 3. Cloudflare Worker

### 3a. What it does

The Worker answers the "find help nearby" address/radius lookups. The browser sends
an animal location (lat/lon, or an address the Worker geocodes server-side) plus a
radius; the Worker reads the **private** volunteer coords from KV and returns only a
**PII-free aggregate**:

```13:16:worker/src/index.mjs
 * The Worker returns ONLY the PII-free aggregate:
 *   { total_in_range, role_counts, win_areas }
```

It echoes back the dispatcher-entered **animal** coordinate (safe — that is the
animal location, not volunteer PII) so the browser can rank rehabbers by distance.
It never echoes a volunteer coordinate or any volunteer datum, even in error
messages. CORS is restricted to the configured Pages origin.

All real logic lives in `worker/src/handler.js` (a pure, unit-tested module);
`worker/src/index.mjs` is the thin Cloudflare entry that wires in the KV binding and
runtime `fetch`. Supporting modules: `aggregate.js`, `census.js` (geocoding),
`autocomplete.js`.

### 3b. Deploying the Worker

Deploy with `wrangler` from the `worker/` directory:

```
cd worker
wrangler deploy
```

Config lives in `worker/wrangler.toml`:

- Worker name: `pa-wildlife-dispatcher`, entry `src/index.mjs`.
- KV namespace binding `VOLUNTEER_COORDS`, id
  `43bdd5e237544683b20cdbc61d42dd49`. The CI refresh job writes the coords array to
  this namespace under the key `volunteer_coords`.

```31:33:worker/wrangler.toml
[[kv_namespaces]]
binding = "VOLUNTEER_COORDS"
id = "43bdd5e237544683b20cdbc61d42dd49"
```

- **Live URL:** `https://pa-wildlife-dispatcher.winstat.workers.dev` (this is the
  endpoint the front-end calls; see `WORKER_URL` in `docs/assets/dispatcher.js`).
- **Cloudflare account:** *Wildlife In Need*, login `wildlifeinneed111@gmail.com`.

**Redeploy after any change under `worker/src/`.** The deployed Worker is a built
bundle; editing the source files does nothing until you re-run `wrangler deploy`.
Secrets (the Cloudflare API token) are supplied to `wrangler` via the environment at
deploy time and are never committed.

> Note: the committed `wrangler.toml` header still carries old "scaffold / not
> deployed yet" comments and a `[vars] ALLOWED_ORIGIN` placeholder
> (`https://mjpierzga.github.io`). The Worker is in fact deployed and live at the URL
> above. Treat the live URL and the KV id as the source of truth; the stale scaffold
> comments are documentation lag, not current state. (See §"Flagged facts".)

---

## 4. Deploying the Front-End

The front-end is the static `docs/` folder served by **GitHub Pages** from the repo
root of `docs/`. To deploy a change:

```
git push origin main
```

GitHub Pages publishes from `docs/` on `main`; there is no separate build step for
the page itself.

**One exception — the in-app user manual.** `docs/USER_MANUAL.md` is the single
editable source for the manual the user sees in-app (`docs/help.html`). Browsers
cannot `fetch()` a `file://` sibling, so the markdown is also embedded into
`docs/assets/manual.js` for the offline path. After editing `USER_MANUAL.md` you
must regenerate that embedded copy:

```
node tools/build_manual.js
```

Then commit **both** the edited `docs/USER_MANUAL.md` and the regenerated
`docs/assets/manual.js`, and push. Do not hand-edit `docs/assets/manual.js` — it is
auto-generated and will be overwritten.

---

## 5. Adding / Removing a Coordinator

This is a **data-only** change — no code edit needed.

1. Edit the `Area Coordinators` Monday board (id `18416913502`): add, rename, or
   remove the coordinator. Remember the **item name is the WIN area string** and the
   name lives in the long-text column; do not put a phone where it will be published
   (the phone column is never read).
2. Bump `Last_Updated` on the `VolDB_Status` sentinel board (`6750158385`) so CI
   picks up the change on its next run.

The refresh writes `docs/data/coordinators.json` (area → name), which the page reads
as an override on top of the static county→area map. No code change, no manual file
edit.

---

## 6. Beta Caveats

- **Open/closed status is NOT from Monday.** The dispatcher does not surface a
  rehabber's open/closed state. The RehabDB open/closed column (`color_mkv6xbc`) is
  deliberately not pulled because the org does not keep it current. Real-time
  rehab open/closed status lives in a **separate beta "rehab status" app on
  winstat**, which owns that data — it is not wired into this dispatcher. Do not
  add the open/closed column back into the pipeline expecting it to be accurate.

- **Rehabber data traces to pawr.com.** The rehabber facility records originate
  from pawr.com. If a facility's details look wrong, that is the upstream source to
  reconcile against.

---

## Quick Reference

| What | Where |
| --- | --- |
| Wording / labels | `docs/assets/messages.js` (edit text freely, keep `{tokens}`) |
| PA Game Commission phone | `messages.js` → `PGC_PHONE` (one place) |
| Live thresholds + per-county overrides | `docs/data/config.json` (wins over `messages.js`) |
| Trigger a data refresh | Bump `Last_Updated` on VolDB_Status board `6750158385` |
| Volunteer board | `9092079933` (Connecteam_Users) — coords go to private KV |
| Rehabber board | `9092004762` (RehabDB) — public; no open/closed |
| Coordinator board | `18416913502` (Area Coordinators) — item=area, name only |
| Worker live URL | `https://pa-wildlife-dispatcher.winstat.workers.dev` |
| Worker KV namespace | `VOLUNTEER_COORDS` = `43bdd5e237544683b20cdbc61d42dd49` |
| Cloudflare account | Wildlife In Need (wildlifeinneed111@gmail.com) |
| Deploy Worker | `cd worker && wrangler deploy` (after any `worker/src/` change) |
| Deploy front-end | `git push origin main` (GitHub Pages from `docs/`) |
| After editing USER_MANUAL.md | `node tools/build_manual.js`, then commit + push both files |

---

## Flagged facts (could not be fully verified from live files)

- **Cloudflare account name / email** (*Wildlife In Need*,
  `wildlifeinneed111@gmail.com`): provided in the task brief; not present in any
  committed file. Recorded here as given.
- **Worker URL vs `wrangler.toml`:** the live URL
  `https://pa-wildlife-dispatcher.winstat.workers.dev` is confirmed in
  `docs/assets/dispatcher.js` (`WORKER_URL`). However, `worker/wrangler.toml` still
  contains "SCAFFOLD ONLY -- not deployed" comments, a different
  `account_id` (`290463cfd0bc273076e8c62678f7c845`), and an `ALLOWED_ORIGIN`
  placeholder `https://mjpierzga.github.io`. The KV namespace id
  (`43bdd5e237544683b20cdbc61d42dd49`) matches the CI workflow. The account_id in
  the repo does not obviously match the "Wildlife In Need" account from the brief —
  reconcile the Cloudflare account/account_id before the next Worker deploy.
- **Coordinator phone column id** (`phone_mm45s2h0`): the exclusion rule is
  documented in `refresh_monday.py` comments; the column is never fetched, so its id
  is taken from those comments, not from a live fetch.

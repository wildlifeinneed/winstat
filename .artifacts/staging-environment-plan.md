# PA-Wildlife-Rehab — FULL-PROJECT Staging Environment Setup Plan

**Goal:** A persistent, mobile-openable **STAGING** deployment of the **ENTIRE**
PA-Wildlife-Rehab project — every front-end page AND every backend service/data flow —
fully isolated from production and its users, on **free tiers only**:

- Front-end: ONE **Cloudflare Pages** staging project (stable `*.pages.dev` URL) built
  from a `staging` branch, output dir `docs/`. Because the whole site is a single static
  GitHub Pages site served from `docs/`, ONE Pages project serves **all five pages**
  (index, dispatcher, facilities, equipment-transfers, help).
- API: a **separate** staging Cloudflare Worker (`pa-wildlife-dispatcher-staging`) so the
  staging front-end never hits the production Worker. (There is only one Worker in the
  whole repo — see inventory §0.2.)
- Routing: the staging Worker uses its **own separate free OpenRouteService (ORS) key** so
  test traffic never burns production's ORS daily quota.
- Data: staging reads the production KV **read-only** (the Worker never writes KV) and
  **never** touches the Monday.com → KV / commit-to-`main` refresh pipeline.

> **PLAN ONLY.** No infrastructure was created, no Cloudflare resources were provisioned,
> and no code/config was changed or committed while producing this document.

---

## 0. FULL-PROJECT INVENTORY (verified, with citations)

### 0.1 Front-end surfaces — ALL served from `docs/` on `main` (one GitHub Pages site)

`glob docs/**/*.html` → exactly **5 HTML entry points**, all under `docs/`, all linked
from the `index.html` hub (`index.html:638,656,673`). They are one static site, so **one
Cloudflare Pages staging project covers every page**.

| Page | File | Backend / external calls | Where the URL is configured |
|------|------|--------------------------|------------------------------|
| **Hub / landing** | `docs/index.html` | None (static links only). External links to `winemergencyresponse.com`, Facebook (`index.html:758-759`). | n/a |
| **Dispatcher** | `docs/dispatcher.html` → loads `assets/messages.js`, `assets/decision.js`, `assets/dispatcher.js`, vendored Leaflet (`dispatcher.html:1370-1373`) | **The ONLY page that calls the Worker.** Also fetches local `docs/data/*.json`. | `WORKER_URL` literal at `docs/assets/dispatcher.js:115` |
| **Facility Status** | `docs/facilities.html` | **Google Sheets CSV** (read) + **Google Apps Script** submit macro (write) — NOT the Worker. | `CSV_URL` at `facilities.html:894`; Apps Script `exec` URL at `facilities.html:883` |
| **Equipment Transfers** | `docs/equipment-transfers.html` | A **different Google Sheets CSV** (read) — NOT the Worker. | `CSV_URL` at `equipment-transfers.html:746` |
| **Help / Manual** | `docs/help.html` → loads vendored `assets/vendor/marked.min.js` + `assets/manual.js` | Fetches local `USER_MANUAL.md` (`help.html:237`), falls back to bundled `manual.js`. No backend. | n/a (local file) |

Dispatcher Worker call sites (all via the single `WORKER_URL` const):
`dispatcher.js:593`, `:629`, `:1125` (`?mode=rehabber_distances`), `:2134`.

**Conclusion:** Only `dispatcher.js` has a backend URL that must be repointed for staging.
`facilities.html` and `equipment-transfers.html` talk to Google Sheets (see §0.3 for the
staging decision on those); `index.html` and `help.html` need no backend wiring at all.

### 0.2 Backend services / Workers — there is exactly ONE Worker

`glob **/wrangler*` → a single config: `worker/wrangler.toml`. `glob worker/**/*.{js,mjs}`
shows one Worker codebase (`src/index.mjs` entry + `handler.js`, `aggregate.js`,
`autocomplete.js`, `census.js`, `county_win.js`, `distance.js`, `pip.js`). **No second
Worker, no other wrangler config, no `[env.*]` blocks, no `routes`/`route` entries.**

Production Worker config (`worker/wrangler.toml`):

```18:40:worker/wrangler.toml
name = "pa-wildlife-dispatcher"
main = "src/index.mjs"
compatibility_date = "2024-09-23"
account_id = "290463cfd0bc273076e8c62678f7c845"

# Public GitHub Pages origin allowed to call this Worker (CORS).
# TODO(deploy): replace with the project's real Pages origin.
[vars]
ALLOWED_ORIGIN = "https://wildlifeinneed.github.io"
...
[[kv_namespaces]]
binding = "VOLUNTEER_COORDS"
id = "43bdd5e237544683b20cdbc61d42dd49"
```

Bindings / secrets / vars for the one Worker:
- **Worker name:** `pa-wildlife-dispatcher`; live URL
  `https://pa-wildlife-dispatcher.winstat.workers.dev`.
- **`[vars] ALLOWED_ORIGIN`** = `https://wildlifeinneed.github.io` (single-value CORS).
- **Secret `ORS_API_KEY`** — supplied ONLY via `wrangler secret put ORS_API_KEY`, never in
  `[vars]` (`wrangler.toml:25-33`). Consumed in `distance.js` (ORS Matrix endpoint
  `distance.js:31`) via `handler.js`. While unset, the rehabber/Tier-2 route degrades to
  haversine — it never breaks.
- **KV binding `VOLUNTEER_COORDS`** → id `43bdd5e237544683b20cdbc61d42dd49`. The Worker
  only **reads** key `volunteer_coords` (no write path in Worker code).
- `account_id` `290463cfd0bc273076e8c62678f7c845` is committed in `wrangler.toml:21`.

### 0.3 Data flows & external integrations (mark PRODUCTION-affecting)

| Integration | Mechanism | Production-affecting? | Staging stance |
|-------------|-----------|-----------------------|----------------|
| **Monday.com → public aggregates** | `.github/workflows/refresh.yml` job `refresh` runs `refresh_monday.py --if-stale`, **commits `docs/data/county_capacity.json` to `main`** (`refresh.yml:38-59`). Uses `secrets.MONDAY_TOKEN`. | **YES** — writes to `main`, drives prod site data. | Staging must NOT trigger or depend on it. Staging serves the committed `docs/data/*.json` snapshot present on the `staging` branch (frozen at branch time). |
| **Monday.com → private coords → KV** | `refresh.yml` job `refresh-dispatcher-data`: sentinel-gated `refresh_monday.py`, then **`wrangler kv key put` to prod KV id `43bdd5e2…` key `volunteer_coords`** (`refresh.yml:146-149`), then commits ONLY public aggregates to `main` (`refresh.yml:162-219`). Uses `CLOUDFLARE_API_TOKEN` + hardcoded `CLOUDFLARE_ACCOUNT_ID` (`refresh.yml:139-140`). | **YES** — the ONLY KV writer; commits to `main`. | Staging must NOT run this. Staging Worker reads the same KV **read-only** so it gets real data without any write path (see §1 KV decision). |
| **ORS Matrix API** | Worker calls `https://api.openrouteservice.org/v2/matrix/driving-car` (`distance.js:31`) with the `ORS_API_KEY` secret. | Shares prod ORS quota. | Staging Worker gets a **separate free ORS key** (own quota). |
| **Facility Status data** | `facilities.html` reads a published **Google Sheets CSV** (`facilities.html:894`) and submits via a **Google Apps Script macro** (`facilities.html:883`). | The macro **writes to a live Google Sheet** that the prod site reads. | **DECISION NEEDED** (see §1): default recommendation is staging reads the SAME CSV read-only and leaves the submit form pointed at prod's Apps Script (or disabled) so staging testers can't pollute the live facility sheet. |
| **Equipment Transfers data** | `equipment-transfers.html` reads a **different** published Google Sheets CSV (`equipment-transfers.html:746`), read-only. | Read-only; no write path in the page. | Safe to leave as-is (read-only); staging shows the same live equipment data. |
| **Committed data files** | `docs/data/{config,coordinators,county_capacity,county_win,pa_counties,rehabbers,win_area_coordinators}.json` (`glob docs/data/*`). Public, PII-free, served by Pages. `data/volunteer_coords.json` is the PRIVATE file (gitignored, KV-only). | `docs/data/*` committed to `main` by CI. | Staging serves the branch's frozen copies — no refresh needed. |

### 0.4 Config that determines prod-vs-staging behavior across ALL surfaces

- **`docs/assets/dispatcher.js:115`** — `WORKER_URL` literal (dispatcher only). Single
  point to repoint for staging.
- **`docs/facilities.html:894` `CSV_URL`** + **`:883` Apps Script `exec` URL** — facility
  data source + submit target.
- **`docs/equipment-transfers.html:746` `CSV_URL`** — equipment data source (read-only).
- **`worker/wrangler.toml`** — `name`, `account_id` (`:21`), `[vars] ALLOWED_ORIGIN`
  (`:26`), KV id (`:40`), `ORS_API_KEY` secret.
- **`.github/workflows/refresh.yml`** — hardcoded prod KV id (`:147`) + account id
  (`:140`); commits to `main`. (Left untouched by this plan.)
- `index.html` / `help.html` — no prod-vs-staging config.

> **Hosting note:** production *site* is GitHub Pages from `docs/` on `main`. The staging
> Cloudflare Pages project is **additive** and never touches the GitHub Pages prod site.

---

## 1. ARCHITECTURE — prod vs staging (ALL surfaces)

```
                       PRODUCTION (unchanged)                      STAGING (new, additive)
                       ─────────────────────                       ───────────────────────
branch                 main                                        staging  (branched off main)

SITE host              GitHub Pages (docs/ on main)                ONE Cloudflare Pages project
                       https://wildlifeinneed.github.io            https://pawr-staging.pages.dev
                       serves: index, dispatcher, facilities,      serves the SAME 5 pages from docs/
                               equipment-transfers, help                   (stable *.pages.dev, mobile-openable)

dispatcher API const   WORKER_URL = …/pa-wildlife-dispatcher       WORKER_URL = …/pa-wildlife-dispatcher-staging
(dispatcher.js:115)      .winstat.workers.dev                        .winstat.workers.dev   (staging branch ONLY)

Worker (only one)      pa-wildlife-dispatcher                      pa-wildlife-dispatcher-staging
                       (wrangler.toml top-level)                   (wrangler.toml [env.staging], additive)

ALLOWED_ORIGIN (CORS)  https://wildlifeinneed.github.io            https://pawr-staging.pages.dev

ORS key (secret)       ORS_API_KEY (prod ORS account)              ORS_API_KEY (SEPARATE staging ORS key, --env staging)

KV VOLUNTEER_COORDS    id 43bdd5e2…d42dd49  (written by CI)         same id, READ-ONLY (staging Worker only .get()s)

Facility CSV / submit  live Google Sheet CSV + Apps Script write   SAME CSV read-only; submit left at prod OR disabled
Equipment CSV          live Google Sheet CSV (read-only)           SAME CSV read-only (unchanged)
Help manual            local USER_MANUAL.md                        identical (static)

CI refresh (KV+commit) refresh.yml → prod KV + commits to main     NONE (staging never writes KV, never commits main)
```

Data-flow (staging path):

```
MOBILE (cellular) ──► pawr-staging.pages.dev (ALL 5 pages)
     ├─ dispatcher.html ──► pa-wildlife-dispatcher-staging (Worker)
     │                        ├─ reads KV volunteer_coords (READ ONLY, shared prod namespace)
     │                        └─ ORS Matrix API (STAGING ORS key, separate quota)
     ├─ facilities.html ────► live Google Sheets CSV (read); submit → prod Apps Script OR disabled
     ├─ equipment-transfers.html ─► live Google Sheets CSV (read-only)
     └─ index.html / help.html ──► static (no backend)

(Production path, untouched:)
… ──► wildlifeinneed.github.io (GH Pages) ──► pa-wildlife-dispatcher ──► same KV (CI writes) + prod ORS key
```

### Decision A — staging KV strategy → RECOMMENDED **shared prod KV, read-only**

The Worker only ever `kv.get`s `volunteer_coords`; the ONLY writer is `refresh.yml`
(`refresh.yml:146-149`), which is untouched. So binding the SAME namespace id in
`[env.staging]` gives staging realistic data and **cannot** corrupt prod (no write path).
- **Alternative (stricter):** dedicated `VOLUNTEER_COORDS_STAGING` namespace + one-time
  manual seed. Costs an extra namespace + manual copy and the data goes stale (no CI
  refresh). Only choose for *physical* write-isolation beyond "the code never writes".

### Decision B — Facility Status submit (Apps Script) → CONFIRM with user

`facilities.html` is the only page besides dispatcher with a **write** integration (the
Apps Script submit macro writes to the live facility Google Sheet). Options:
- **(B1, recommended) Leave submit pointed at prod Apps Script but tell testers not to
  submit**, OR disable the submit control on the staging branch — so staging cannot write
  test rows into the live facility sheet. Read (CSV) stays live so the page is realistic.
- **(B2) Stand up a separate staging Google Sheet + Apps Script** and repoint `CSV_URL`
  (`:894`) and the `exec` URL (`:883`) on the staging branch. Fully isolated but is extra
  Google-side setup outside Cloudflare and outside the free-tier story below.

> **CONFIRM:** Decision A (shared read-only KV vs dedicated) and Decision B (facility
> submit handling). Recommended defaults: A = shared read-only; B = B1 (don't submit /
> disable submit on staging).

---

## 2. STEP-BY-STEP SETUP (each step tagged)

Legend: **[USER — authenticated]** needs the user's Cloudflare / ORS / GitHub login.
**[MANAGER — can prep]** can be fully prepared as files/commands without any credentials.

### Step 1 — Register a SECOND free ORS key  **[USER — ORS account]**
1. <https://openrouteservice.org/dev/#/signup> — create a separate token (or fresh free
   account). Label it `pawr-staging`. Copy the key (used only in Step 3, never committed).

### Step 2 — Prepare the `[env.staging]` block in `worker/wrangler.toml`  **[MANAGER — can prep]**
Append (does NOT alter the existing top-level production config):

```toml
# ─────────────────────────────────────────────────────────────────────────
# STAGING environment. Deploy as a SEPARATE Worker:  wrangler deploy --env staging
# ORS key is a STAGING secret:  wrangler secret put ORS_API_KEY --env staging
# ─────────────────────────────────────────────────────────────────────────
[env.staging]
name = "pa-wildlife-dispatcher-staging"

[env.staging.vars]
# Must equal the staging Pages origin (Step 4) so CORS allows the staging FE.
ALLOWED_ORIGIN = "https://pawr-staging.pages.dev"

[[env.staging.kv_namespaces]]
binding = "VOLUNTEER_COORDS"
# RECOMMENDED: reuse the prod namespace READ-ONLY (Worker never writes).
id = "43bdd5e237544683b20cdbc61d42dd49"
```

`account_id`, `main`, `compatibility_date` are inherited from the top level. Staging URL
becomes `https://pa-wildlife-dispatcher-staging.winstat.workers.dev`.

### Step 3 — Deploy the staging Worker + set its ORS secret  **[USER — authenticated]** (MANAGER preps commands)
```bash
cd worker
wrangler secret put ORS_API_KEY --env staging   # paste the STAGING ORS key (Step 1)
wrangler deploy --env staging
```
Creates `pa-wildlife-dispatcher-staging` + a staging-scoped secret. Prod Worker untouched.
Verify:
```bash
curl "https://pa-wildlife-dispatcher-staging.winstat.workers.dev/?animal_lat=40.44&animal_lon=-79.99&radius_mi=20"
```

### Step 4 — Create the ONE Cloudflare Pages staging project (whole site)  **[USER — Cloudflare dashboard]**
Dashboard → **Workers & Pages → Create → Pages → Connect to Git**:
1. Repo: `PA-Wildlife-Rehab`.
2. **Project name:** `pawr-staging` → `https://pawr-staging.pages.dev` (MUST match
   `ALLOWED_ORIGIN` in Step 2).
3. **Production branch:** `staging` (so the stable URL always serves staging, never `main`).
4. Build: preset **None**, build command **empty**, **output dir `docs`**, root = repo root.
5. Save & Deploy. The single project serves all 5 pages: `/`, `/dispatcher.html`,
   `/facilities.html`, `/equipment-transfers.html`, `/help.html`.

CLI alternative:
```bash
npx wrangler pages project create pawr-staging --production-branch staging
npx wrangler pages deploy docs --project-name pawr-staging --branch staging
```

### Step 5 — Point the staging front-end at staging (staging branch ONLY)  **[USER — git]** (MANAGER preps edits)
Make these edits ONLY on `staging` so they can never reach `main`/prod:
- **Required:** `docs/assets/dispatcher.js:115`
  `var WORKER_URL = 'https://pa-wildlife-dispatcher-staging.winstat.workers.dev';`
- **Per Decision B1:** in `docs/facilities.html`, disable the submit control (or leave the
  Apps Script `exec` URL as-is and instruct testers not to submit). Per B2: repoint
  `CSV_URL` (`:894`) and the `exec` URL (`:883`) to the staging Sheet.
- `equipment-transfers.html`, `index.html`, `help.html` need **no change** (read-only /
  static).

```bash
git checkout -b staging            # first time only
# apply edits above
git add docs/assets/dispatcher.js worker/wrangler.toml docs/facilities.html
git commit -m "staging: staging Worker URL + [env.staging] + facility submit guard (DO NOT MERGE TO MAIN)"
git push -u origin staging
```

### Step 6 — CI/CD for staging  **RECOMMENDATION: keep prod CI untouched; no staging CI writes**
- `refresh.yml` only writes prod KV + commits to `main` and has no staging awareness —
  **leave it exactly as-is**.
- Cloudflare Pages Git integration (Step 4) auto-deploys the staging FE on every push to
  `staging` — no GitHub Actions change needed.
- The staging Worker is deployed manually (`wrangler deploy --env staging`) — rare, lowest
  risk.
- Do **NOT** add any staging KV-refresh / Monday job: staging shares prod KV read-only and
  serves the branch's frozen `docs/data/*.json`, so it never needs the Monday pipeline.

**Net: zero changes to `.github/workflows/refresh.yml`.**

---

## 3. ISOLATION VERIFICATION CHECKLIST (prove NOTHING in staging affects prod)

- [ ] **Site host separate.** Prod stays GitHub Pages (`wildlifeinneed.github.io` from
      `main`); the new `pawr-staging.pages.dev` is a distinct host serving the `staging`
      branch. All 5 pages load on the `.pages.dev` URL.
- [ ] **Worker separate.** `curl` staging URL → 200; distinct hostname
      `pa-wildlife-dispatcher-staging.winstat.workers.dev` from prod.
- [ ] **ORS quota separate.** `wrangler secret list --env staging` shows `ORS_API_KEY`
      scoped to staging; value is the *staging* token. Staging rehabber/Tier-2 traffic
      does not decrement the prod ORS counter.
- [ ] **CORS gate.** Staging fetches succeed only from the staging Pages origin; prod
      Worker still only allows `wildlifeinneed.github.io` (single-value header,
      `handler.js` corsHeaders).
- [ ] **No writes to prod KV.** Worker code only `kv.get`s; the ONLY writer is
      `refresh.yml` (unchanged). After several staging requests, confirm
      `wrangler kv key get volunteer_coords --namespace-id=43bdd5e2…` value/metadata
      unchanged.
- [ ] **No Monday/refresh involvement.** No staging workflow runs `refresh_monday.py`,
      `wrangler kv key put`, or commits to `main`. `refresh.yml` git diff = empty.
- [ ] **Facility sheet not polluted.** Per Decision B, staging cannot submit rows to the
      live facility Google Sheet (submit disabled on staging, or testers instructed not to
      submit). Equipment CSV is read-only by construction.
- [ ] **Front-end isolation.** `main` still has the prod `WORKER_URL`
      (`grep` finds no `-staging` literal on `main`); `-staging` exists ONLY on `staging`.
- [ ] **Branch hygiene.** `staging` is never casually merged to `main` (commit message
      "DO NOT MERGE TO MAIN"; see Risks §6.1).

---

## 4. FREE-TIER CONFIRMATION (all surfaces)

- **Cloudflare Pages (Free):** unlimited static requests/bandwidth, 500 builds/month, 1
  concurrent build, `*.pages.dev` subdomain. One static `docs/` site (5 pages) is well
  inside this. **Free.**
- **Cloudflare Workers (Free):** **100,000 requests/day** + 1,000 req/min, shared **across
  all Workers on the account** (prod + staging share the 100k/day pool). Only the
  dispatcher page hits the Worker; staging test traffic is tiny. **Free.**
- **Workers KV (Free):** generous daily reads; staging adds a handful of reads of one key,
  no extra storage (shared namespace). **Free.**
- **OpenRouteService (Free):** ~2,000 Matrix req/day with a per-minute cap. The **separate
  staging key** has its own budget; on exhaustion the route degrades to haversine (never
  errors, never bills). **Free.**
- **Google Sheets / Apps Script (facilities, equipment):** published-CSV reads and the
  Apps Script web app are Google-hosted at no cost; staging only reads (and, per B1, does
  not write). **Free / no Cloudflare cost.**

No plan upgrade or payment method required.

---

## 5. EXACT COMMAND LIST (copy-paste, in order)

```bash
# ── PREP (no creds; MANAGER can do) ──────────────────────────────────────
# Edit worker/wrangler.toml: append the [env.staging] block from Step 2.
# Edits to dispatcher.js (and facilities submit guard) happen on the staging branch below.

# ── 1. Staging branch + repoint FE (dispatcher only required) ────────────
cd /Users/P1/Projects/PA-Wildlife-Rehab
git checkout main && git pull
git checkout -b staging
# Edit docs/assets/dispatcher.js:115 ->
#   var WORKER_URL = 'https://pa-wildlife-dispatcher-staging.winstat.workers.dev';
# (Per Decision B1) disable the facilities.html submit control, OR leave & don't submit.
git add docs/assets/dispatcher.js worker/wrangler.toml docs/facilities.html
git commit -m "staging: staging Worker URL + [env.staging] + facility submit guard (DO NOT MERGE TO MAIN)"
git push -u origin staging

# ── 2. Deploy the staging Worker (USER — authenticated) ──────────────────
export CLOUDFLARE_API_TOKEN=<YOUR_CF_API_TOKEN>
cd worker
wrangler secret put ORS_API_KEY --env staging      # paste the STAGING ORS key
wrangler deploy --env staging
curl "https://pa-wildlife-dispatcher-staging.winstat.workers.dev/?animal_lat=40.44&animal_lon=-79.99&radius_mi=20"

# ── 3. Create the ONE Cloudflare Pages staging project (USER) ────────────
#   Dashboard: Workers & Pages -> Create -> Pages -> Connect to Git
#     project name = pawr-staging ; production branch = staging
#     build command = (empty) ; output directory = docs
#   OR via CLI:
npx wrangler pages project create pawr-staging --production-branch staging
npx wrangler pages deploy docs --project-name pawr-staging --branch staging

# ── 4. Open on mobile (every page) ───────────────────────────────────────
#   https://pawr-staging.pages.dev/                      (hub)
#   https://pawr-staging.pages.dev/dispatcher.html
#   https://pawr-staging.pages.dev/facilities.html
#   https://pawr-staging.pages.dev/equipment-transfers.html
#   https://pawr-staging.pages.dev/help.html
```

> If you pick a Pages name other than `pawr-staging`, update `ALLOWED_ORIGIN` in
> `[env.staging.vars]` AND redeploy the staging Worker so CORS matches.

---

## 6. RISKS / GOTCHAS

1. **Accidental `staging` → `main` merge.** The staging branch carries divergent
   `WORKER_URL`, the `[env.staging]` block, and (per B1) a facility-submit guard. Merging
   to `main` would point PRODUCTION at the staging Worker. Mitigations: "DO NOT MERGE TO
   MAIN" commit message; optional CI guard that fails if `dispatcher.js` on `main`
   contains `-staging`. Optional hardening: gate `WORKER_URL` on `location.hostname`
   (`*.pages.dev` → staging) so the same file is safe on both branches.
2. **CI commit-back-to-`main` rebase loop.** `refresh.yml` does
   `git pull --rebase origin main && git push` (`refresh.yml:55-59`, `:215-219`). Keep
   `staging` independent; never rebase the bot's auto-commits. This plan changes nothing
   in CI.
3. **Stale staging data (by design).** Staging serves the `docs/data/*.json` frozen on the
   `staging` branch and reads live KV read-only. It will NOT receive Monday refreshes
   (intentional — staging must not touch the prod pipeline). To refresh staging public
   data, periodically `git merge main` of just `docs/data/*` into `staging` (manual).
4. **ORS key leakage.** Never put the key in `[vars]` (a same-named `[vars]` clobbers the
   secret on deploy, `wrangler.toml:25-33`). Always `wrangler secret put ORS_API_KEY
   --env staging`. Never commit either key.
5. **KV write isolation.** Shared-prod-KV-read-only is safe ONLY because the Worker never
   writes KV. Do not add any KV write path to the staging Worker; do not add a staging KV
   job to CI. For a hard physical guarantee, use the dedicated-namespace alternative
   (Decision A) at the cost of stale staging data.
6. **CORS single-origin.** `ALLOWED_ORIGIN` must EXACTLY equal the `*.pages.dev` origin
   (scheme + host, no trailing slash/path) or every staging fetch fails CORS.
7. **account_id / Cloudflare account reconciliation.** Confirm the
   `CLOUDFLARE_API_TOKEN` you export belongs to the SAME account as `account_id`
   `290463cfd0bc273076e8c62678f7c845` before `wrangler deploy --env staging`; otherwise the
   staging Worker lands on the wrong account and its `*.workers.dev` subdomain differs from
   `winstat` (forcing another `WORKER_URL` fix).
8. **Pages production branch must be `staging`.** If left as `main`, the stable
   `.pages.dev` URL would serve PROD code from `main` — defeating isolation. Set it to
   `staging` explicitly (Step 4.3).
9. **Facility Apps Script is a live writer.** Unlike the equipment CSV (read-only),
   `facilities.html` can write to the live facility sheet via the Apps Script macro. Per
   Decision B, ensure staging cannot submit (disable the control or instruct testers),
   otherwise staging traffic could create real facility-status rows.
10. **Two distinct Google Sheets.** Facilities and equipment use DIFFERENT published CSVs
    (`facilities.html:894` vs `equipment-transfers.html:746`); don't conflate them if you
    pursue Decision B2.

---

## 7. SUMMARY OF DECISIONS NEEDED FROM THE USER

1. **Staging KV strategy (Decision A):** shared prod KV READ-ONLY (recommended) vs
   dedicated staging namespace (stricter, stale, more setup).
2. **Facility Status submit handling (Decision B):** B1 disable/don't-submit on staging
   (recommended) vs B2 separate staging Google Sheet + Apps Script.
3. **Staging Worker deploy:** manual `wrangler deploy --env staging` (recommended) vs CI
   (not recommended).
4. **Pages project name / staging origin:** confirm `pawr-staging`
   (→ `https://pawr-staging.pages.dev`) or supply a preferred name so `ALLOWED_ORIGIN`
   matches.
5. **Cloudflare account/account_id reconciliation** before the first staging deploy
   (Risks §7).
6. **Staging public-data freshness:** accept frozen `docs/data/*` on the `staging` branch
   (recommended) vs periodic manual `docs/data/*` merges from `main`.

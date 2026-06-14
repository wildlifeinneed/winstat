# Dispatcher Aggregate Worker

**Status: DEPLOYED & LIVE.** This Cloudflare Worker is deployed as
`pa-wildlife-dispatcher` and serving at
<https://pa-wildlife-dispatcher.winstat.workers.dev>. It was deployed in commit
`a2d8da7`. The private volunteer coordinates it serves are kept current by CI
(see "KV data refresh" below). No secret is committed to this repo.

## Purpose

The public GitHub Pages site must never see volunteer coordinates. This Worker
is the private layer: it holds the volunteer coords in Cloudflare KV (pushed by
the CI refresh job) and returns ONLY a PII-free aggregate to the browser.

It is a JS port of the Python ground truth:
- `dispatch_core.py` → `src/aggregate.js` (haversine, radius clamp, role
  counting, `find_volunteers_in_radius`).
- `geocoder.py` Census endpoint/parse → `src/census.js`.

## Response shape (the PII boundary)

A successful request returns the PII-free aggregate plus the dispatcher-entered
ANIMAL location (the animal coordinate is NOT volunteer PII) so the browser can
rank rehabbers by distance:

```json
{
  "total_in_range": 19,
  "role_counts": { "C&T": 2, "RVS C&T": 5, "COURIER": 12 },
  "win_areas": ["10"],
  "distance_mode": "straight_line",
  "animal_lat": 40.44,
  "animal_lon": -79.99,
  "animal_county": "Allegheny",
  "animal_area": "10",
  "animal_geoid": "42003"
}
```

No names, volunteer coordinates, addresses, `home_county`, `roles`, or
per-volunteer rows are ever returned. The tests assert this (deep key scan).

## Request contract

`GET` or `POST` to the Worker:
- Either `animal_lat` + `animal_lon`, OR `address` (geocoded via US Census /
  Photon at runtime).
- Optional `radius_mi` (default 20, clamped to max 100).
- `400 missing_location` when neither location is supplied; `400 invalid_radius`
  on a non-numeric radius; `422 address_not_found` / `502 geocoder_unavailable`
  on geocode failure. Error bodies never echo input coordinates.
- CORS: `Access-Control-Allow-Origin` is set from the `ALLOWED_ORIGIN` var
  (currently `https://wildlifeinneed.github.io`).

Example:

```bash
curl "https://pa-wildlife-dispatcher.winstat.workers.dev/?animal_lat=40.44&animal_lon=-79.99&radius_mi=20"
```

## Deployment config (`wrangler.toml`)

The committed `wrangler.toml` holds the real deployment binding values (no
secrets):

| Setting | Value |
| --- | --- |
| `name` | `pa-wildlife-dispatcher` |
| `main` | `src/index.mjs` |
| `compatibility_date` | `2024-09-23` |
| `account_id` | `290463cfd0bc273076e8c62678f7c845` |
| `[vars] ALLOWED_ORIGIN` | `https://wildlifeinneed.github.io` |
| KV binding `VOLUNTEER_COORDS` | id `43bdd5e237544683b20cdbc61d42dd49` |

The `ORS_API_KEY` (OpenRouteService, for the PUBLIC rehabber driving-distance
panel) is supplied ONLY as a Worker secret (`wrangler secret put ORS_API_KEY`),
never in `[vars]`. While unset, `/?mode=rehabber_distances` degrades gracefully
to haversine straight-line distances (`duration_min: null`).

## KV data refresh (CI)

The private volunteer coords are refreshed in CI by the
`refresh-dispatcher-data` job in `.github/workflows/refresh.yml`. On a refresh
(gated by the Monday `VolDB_Status` sentinel) it:
- runs `refresh_monday.py` to regenerate the datasets,
- pushes ONLY the PRIVATE volunteer coords to Cloudflare KV under key
  `volunteer_coords` via `wrangler kv key put` (namespace
  `43bdd5e237544683b20cdbc61d42dd49`), authenticated with the
  `CLOUDFLARE_API_TOKEN` repo secret and `CLOUDFLARE_ACCOUNT_ID`,
- commits ONLY the public, PII-free aggregates (never the private coords).

The Worker reads that data from KV under the key `volunteer_coords` (see
`src/handler.js`).

## Files

| File | Role |
| --- | --- |
| `wrangler.toml` | Worker config: account id, `VOLUNTEER_COORDS` KV id, `ALLOWED_ORIGIN` |
| `src/index.mjs` | Cloudflare ESM entry (thin wrapper) |
| `src/handler.js` | Pure request handler (params, geocode, KV read, CORS, errors) |
| `src/aggregate.js` | Pure port of `find_volunteers_in_radius` |
| `src/census.js` | Census geocode helper (injectable fetch) |
| `test/run.test.js` | Local mocked tests (no install, no network) |

## Running the tests locally

No install and no network required (the tests run on Node 12+). They exercise
the exact shipped logic with mocked KV, mocked Census, and a mock `Response`:

```bash
cd worker
npm test
# or: node test/run.test.js
```

Covered: correct aggregate for a known set, radius clamp, 400 on bad input,
PII-free key set (no name/lat/lon/address leak), CORS headers, address-geocode
path (mocked), POST body path, empty/malformed KV degradation.

## Redeploying

On a Node 18+ environment with Wrangler installed and `CLOUDFLARE_API_TOKEN`
exported:

```bash
cd worker
wrangler deploy
```

`account_id`, the `VOLUNTEER_COORDS` KV binding, and `ALLOWED_ORIGIN` are
already set in `wrangler.toml`; only the API token is supplied via the
environment at deploy time (never committed).

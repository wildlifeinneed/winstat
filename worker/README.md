# Dispatcher Aggregate Worker (Phase E scaffold)

**Status: SCAFFOLD ONLY — NOT deployed.** This directory contains the
Cloudflare Worker source, config, and local mocked tests. Deployment (login,
KV namespace creation, account id, API token) happens LATER in Phase E-deploy /
Phase F once a scoped token is provided. Nothing here calls live Cloudflare or
live Census, and no secret is committed.

## Purpose

The public GitHub Pages site must never see volunteer coordinates. This Worker
is the private layer: it holds the volunteer coords in Cloudflare KV (pushed by
the Phase F refresh job) and returns ONLY a PII-free aggregate to the browser.

It is a JS port of the Python ground truth:
- `dispatch_core.py` → `src/aggregate.js` (haversine, radius clamp, role
  counting, `find_volunteers_in_radius`).
- `geocoder.py` Census endpoint/parse → `src/census.js`.

## Response shape (the PII boundary)

A successful request returns EXACTLY these keys and nothing else:

```json
{ "total_in_range": 3, "role_counts": { "C&T": 1, "RVS C&T": 1, "COURIER": 2 }, "win_areas": ["WIN-1", "WIN-2"] }
```

No names, coordinates, addresses, `home_county`, `roles`, or per-volunteer rows
are ever returned. The tests assert this (deep key scan).

## Request contract

`GET` or `POST` to the Worker:
- Either `animal_lat` + `animal_lon`, OR `address` (geocoded via US Census at
  runtime — mocked in tests).
- Optional `radius_mi` (default 20, clamped to max 100).
- `400` on missing location, invalid radius, or unresolvable address. Error
  bodies never echo input coordinates.
- CORS: `Access-Control-Allow-Origin` from the `ALLOWED_ORIGIN` var.

## Files

| File | Role |
| --- | --- |
| `wrangler.toml` | Worker config; **placeholder** KV id, no account id, no secrets |
| `src/index.mjs` | Cloudflare ESM entry (thin wrapper) |
| `src/handler.js` | Pure request handler (params, geocode, KV read, CORS, 400) |
| `src/aggregate.js` | Pure port of `find_volunteers_in_radius` |
| `src/census.js` | Census geocode helper (injectable fetch) |
| `test/run.test.js` | Local mocked tests (no install, no network) |

## Running the tests locally

No install and no network required (the local toolchain is Node v12, which
predates vitest / `@cloudflare/vitest-pool-workers` / miniflare — those need
Node 18+). The tests exercise the exact shipped logic with mocked KV, mocked
Census, and a mock `Response`:

```bash
cd worker
npm test
# or: node test/run.test.js
```

Covered: correct aggregate for a known set, radius clamp, 400 on bad input,
PII-free key set (no name/lat/lon/address leak), CORS headers, address-geocode
path (mocked), POST body path, empty/malformed KV degradation.

When deploying later on a Node 18+ machine, the same `src/*` modules can be
wrapped in `@cloudflare/vitest-pool-workers` if a Workers-runtime integration
test is desired.

## Deploy steps (LATER — Phase E-deploy / Phase F, do NOT run now)

1. Use a Node 18+ environment and install Wrangler:
   `npm install -D wrangler`
2. `wrangler login`
3. Create the KV namespace and paste the returned id into `wrangler.toml`
   (replace `TODO_PLACEHOLDER_KV_NAMESPACE_ID`):
   `wrangler kv:namespace create VOLUNTEER_COORDS`
4. Supply the account id at deploy (not committed in code):
   `export CLOUDFLARE_ACCOUNT_ID=290463cfd0bc273076e8c62678f7c845`
5. Provide the scoped API token via environment (never committed):
   `export CLOUDFLARE_API_TOKEN=<scoped token, supplied at deploy>`
6. Set `ALLOWED_ORIGIN` in `wrangler.toml [vars]` to the project's real
   GitHub Pages origin.
7. `wrangler deploy`
8. The Phase F refresh job writes the coords array (JSON) to KV under key
   `volunteer_coords`.

No secret or real id is stored in this repo; all of the above are provided at
deploy time only.

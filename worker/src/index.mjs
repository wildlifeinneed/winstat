/**
 * Cloudflare Worker ESM entry for the Dispatcher aggregate endpoint.
 *
 * SCAFFOLD ONLY -- not deployed. See worker/README.md for the (later) deploy
 * steps. This file is intentionally thin: all logic lives in src/handler.js
 * (a pure, unit-tested CommonJS module). Wrangler's bundler resolves the
 * `require` of the CJS modules at build time.
 *
 * Bindings / vars (declared in wrangler.toml):
 *   - VOLUNTEER_COORDS : KV namespace holding the PRIVATE coords array (JSON),
 *                        written by the Phase F refresh job. Key: volunteer_coords.
 *   - ALLOWED_ORIGIN   : CORS origin for the public GitHub Pages site.
 *   - ORS_API_KEY      : OpenRouteService Matrix API key for DRIVING distances
 *                        on the PUBLIC rehabber path. Set as a Worker SECRET
 *                        (never committed). When unset/empty, the rehabber
 *                        distance route degrades to haversine straight-line.
 *
 * The Worker returns ONLY the PII-free aggregate:
 *   { total_in_range, role_counts, win_areas }
 */

import { handleRequest } from './handler.js';

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, {
      ResponseCtor: Response,
      kv: env.VOLUNTEER_COORDS,
      // Worker runtime global fetch; used only at runtime for live Census
      // geocoding when an address (not lat/lon) is supplied.
      fetchFn: (url, init) => fetch(url, init),
      allowedOrigin: env.ALLOWED_ORIGIN,
      // ORS Matrix API key for the PUBLIC rehabber driving-distance route.
      // Read from the Worker secret; empty/unset -> haversine fallback.
      orsApiKey: env.ORS_API_KEY,
    });
  },
};

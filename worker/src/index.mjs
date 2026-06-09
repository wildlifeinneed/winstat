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
    });
  },
};

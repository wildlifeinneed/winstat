'use strict';
/**
 * Address AUTOCOMPLETE (typeahead) helper for the Worker.
 *
 * Provider: Photon (https://photon.komoot.io/api/) — OSM-based, FREE, NO API
 * KEY, supports partial/typeahead queries (?q=), result cap (?limit=) and a
 * lat/lon bias (?lat=&lon=). Chosen over the US Census geocoder because Census
 * is a one-line *geocoder*, NOT a typeahead engine (it returns 0 matches for
 * partial input). Census stays for the FINAL geocode (see census.js); Photon is
 * used ONLY to suggest candidate strings as the dispatcher types.
 *
 * PII boundary: this provider is a GENERIC PUBLIC address source. It never
 * touches the private volunteer/coordinator KV data. The animal-location field
 * is free public address entry, so proxying it is safe.
 *
 * Like census.js this accepts an injectable `fetchFn` so tests MOCK it (no live
 * network locally). Returns a small normalized array; NEVER throws.
 *
 * Result shape (per item): { label: string, lat?: number, lon?: number }
 */

const PHOTON_URL = 'https://photon.komoot.io/api/';
// Bias results toward Pennsylvania / US. ~PA centroid.
const PA_BIAS_LAT = 40.9;
const PA_BIAS_LON = -77.8;
// SOFT bias: a Pennsylvania bounding box passed to Photon (?bbox=minLon,minLat,
// maxLon,maxLat) so the provider ranks/limits candidates inside PA. Approximate
// PA extent (lon -80.519891..-74.689516, lat 39.719799..42.269860).
const PA_BBOX = { minLon: -80.519891, minLat: 39.719799, maxLon: -74.689516, maxLat: 42.269860 };
const PA_BBOX_PARAM = PA_BBOX.minLon + ',' + PA_BBOX.minLat + ',' + PA_BBOX.maxLon + ',' + PA_BBOX.maxLat;
const MIN_QUERY_LEN = 3;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

// US Census ONELINEADDRESS *locations* geocoder — the EXACT-match fallback used
// only when Photon yields zero PA candidates for a query that LOOKS like a full
// address. Photon (OSM) lacks many rural PA house numbers (e.g. 738 Neola Rd),
// while Census finds them. This is the cheap `locations/...` endpoint (no
// geography layer) since the autocomplete candidate only needs coordinates; the
// county/area derivation stays on the handler's geographies path at submit time.
const CENSUS_AC_URL =
  'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const CENSUS_AC_BENCHMARK = 'Public_AR_Current';

// Common USPS street-suffix abbreviations -> the full word Photon indexes under.
// Applied (word-boundary, case-insensitive, optional trailing period) only to a
// COPY of the query sent to Photon — the user-visible input is never mutated.
// Photon is query-form sensitive: "Neola Rd" returns EMPTY while "Neola Road"
// surfaces the nearby street/POI, so expanding the suffix widens the hit rate.
const SUFFIX_MAP = {
  rd: 'Road',
  st: 'Street',
  ave: 'Avenue',
  dr: 'Drive',
  ln: 'Lane',
  ct: 'Court',
  blvd: 'Boulevard',
  pkwy: 'Parkway',
  hwy: 'Highway',
  pl: 'Place',
  ter: 'Terrace',
};

/**
 * Expand common street-suffix abbreviations on a COPY of the query for Photon.
 * Word-boundary + case-insensitive + optional trailing period (so "Rd" and
 * "Rd." both expand). Returns the (possibly) rewritten string; the caller's
 * user-visible input is untouched.
 */
function normalizeForPhoton(query) {
  var s = String(query || '');
  for (var abbr in SUFFIX_MAP) {
    if (!Object.prototype.hasOwnProperty.call(SUFFIX_MAP, abbr)) continue;
    var re = new RegExp('\\b' + abbr + '\\.?\\b', 'gi');
    s = s.replace(re, SUFFIX_MAP[abbr]);
  }
  return s;
}

/**
 * Heuristic: does this query look like a street INTERSECTION (two named
 * segments joined by "&" or "and"), as opposed to a house-number address or
 * a typed partial? Requires a recognised USPS street-type suffix on EACH side
 * of the connector to avoid false-positives on college/place names like
 * "Washington and Jefferson" (no suffix on either side) or "Oak and Elm"
 * (no suffix). Conservative: returns false when unsure.
 *
 * @param {string} query
 * @returns {boolean}
 */
function looksLikeIntersection(query) {
  var s = String(query || '');
  // Quick bail: must contain "&" or " and ".
  if (!/(?:&|\band\b)/i.test(s)) return false;
  // Split on the first " & " or " and " (word-bounded).
  var parts = s.split(/\s+(?:&|and)\s+/i);
  if (parts.length < 2) return false;
  // Both sides must carry at least one USPS street-type suffix.
  var suffixRe = /\b(?:St|Ave?|Rd|Blvd|Dr|Ln|Ct|Pl|Way|Ter|Pkwy|Hwy|Street|Avenue|Road|Boulevard|Drive|Lane|Court|Place|Terrace|Parkway|Highway)\.?\b/i;
  return suffixRe.test(parts[0]) && suffixRe.test(parts[1]);
}

/**
 * Heuristic: does this query LOOK like a full street address (worth a single
 * exact-match Census call) rather than a typed partial? True when:
 *   (a) INTERSECTION pattern: two street-suffix segments joined by "&" or
 *       "and", with a city/state context (comma + trailing 2-letter state or
 *       5-digit ZIP) so the Census call doesn't fire on a mid-type fragment
 *       like "Elliott St & Verona Rd" (no city yet).
 *   (b) HOUSE-NUMBER pattern (existing): contains a digit AND (a 5-digit ZIP
 *       OR a 2-letter state token).
 * This gates the Census fallback so it never fires per-keystroke — only on a
 * complete, pasted-style address or intersection.
 */
function looksLikeFullAddress(query) {
  var s = String(query || '');
  // (a) Intersection branch: require city/state context (comma + trailing
  //     2-letter abbrev OR a 5-digit ZIP) so partial "St & Rd" doesn't fire.
  if (looksLikeIntersection(s)) {
    var hasZipI = /\b\d{5}(?:-\d{4})?\b/.test(s);
    // Comma followed (possibly after a city token) by a 2-letter word at end.
    var hasStateAfterComma = /,[^&]*\b[A-Za-z]{2}\b\s*$/.test(s);
    return hasZipI || hasStateAfterComma;
  }
  // (b) House-number digit anywhere.
  if (!/\d/.test(s)) return false;
  // A 5-digit ZIP, OR a US state token (2-letter, word-boundary, e.g. " PA").
  var hasZip = /\b\d{5}(?:-\d{4})?\b/.test(s);
  var hasState = /\b[A-Za-z]{2}\b/.test(s);
  return hasZip || hasState;
}

// HARD filter: the dispatcher only ever needs PA addresses, so non-PA candidates
// are dropped from the dropdown. A feature passes when its state explicitly reads
// Pennsylvania/PA. When the provider returns NO state (some house/POI features),
// we fall back to the PA bounding box on its coordinates (assume-PA within PA).
function isPennsylvania(props, lat, lon) {
  var st = props && props.state ? String(props.state).trim().toLowerCase() : '';
  if (st) {
    return st === 'pennsylvania' || st === 'pa';
  }
  // No state field: accept only if the coordinate falls inside the PA bbox.
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return lon >= PA_BBOX.minLon && lon <= PA_BBOX.maxLon &&
           lat >= PA_BBOX.minLat && lat <= PA_BBOX.maxLat;
  }
  return false;
}

/**
 * Does ANY Photon suggestion actually resolve the pasted HOUSE NUMBER?
 *
 * The Census fallback exists for the case Photon returns a NON-EMPTY but
 * STREET-LEVEL list with the house number DROPPED (proven for real PA pastes
 * like "564 E Maiden St" / "321 2nd St"). suggestions.length===0 misses those.
 *
 * Heuristic: if the query has a LEADING house number (e.g. /^\s*\d+\b/) and NO
 * suggestion label contains that same number token, there is no house-number
 * match -> the handler should fire the Census fallback. When the query carries
 * no leading house number we return true (nothing to match -> don't force the
 * Census call on a street/town-only query).
 *
 * @param {string} query             the pasted address
 * @param {Array<{label:string}>} suggestions  Photon candidates
 * @returns {boolean} true when a suggestion matches the house number (or the
 *          query has no leading house number); false when the house number is
 *          present but unmatched by every suggestion.
 */
function hasHouseNumberMatch(query, suggestions) {
  var s = String(query || '');
  var m = s.match(/^\s*(\d+)\b/);
  if (!m) {
    // Intersection pattern: no leading house number, but Census should still be
    // attempted so the exact corner coordinates can be resolved.
    if (looksLikeIntersection(s)) return false;
    // No leading house number and not an intersection -> nothing to require.
    return true;
  }
  var house = m[1];
  var list = Array.isArray(suggestions) ? suggestions : [];
  // Word-boundary match so "738" does not spuriously match "17380".
  var re = new RegExp('\\b' + house + '\\b');
  for (var i = 0; i < list.length; i++) {
    var it = list[i] || {};
    var label = it.label != null ? String(it.label) : '';
    if (re.test(label)) {
      return true;
    }
  }
  return false;
}

function clampLimit(raw) {
  var n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(n);
}

/**
 * Build a human-readable one-line label from a Photon GeoJSON feature's
 * properties. Photon does not return a preformatted address string, so compose
 * one from the common fields (house number + street, then city/state/postcode).
 */
function labelFromProps(props) {
  if (!props || typeof props !== 'object') return '';
  var parts = [];

  // Line 1: name OR (housenumber + street).
  var street = props.street || '';
  var house = props.housenumber || '';
  var line1 = '';
  if (street) {
    line1 = (house ? house + ' ' : '') + street;
  } else if (props.name) {
    line1 = String(props.name);
  }
  if (line1) parts.push(line1);

  // City / locality.
  var city = props.city || props.town || props.village || props.district || '';
  if (city) parts.push(String(city));

  // State.
  if (props.state) parts.push(String(props.state));

  // Postcode (appended to last region segment, not its own comma group).
  var label = parts.join(', ');
  if (props.postcode) {
    label = label ? label + ' ' + String(props.postcode) : String(props.postcode);
  }
  return label.trim();
}

/**
 * Query the Photon autocomplete provider server-side.
 *
 * @param {string} query     partial address the dispatcher typed
 * @param {number} limit     desired max suggestions (clamped 1..MAX_LIMIT)
 * @param {Function} fetchFn fetch-compatible (url, init) -> Promise<Response>
 * @returns {Promise<Array<{label:string,lat?:number,lon?:number}>>}
 *          Always an array. Empty on short query, provider error, or no match.
 */
async function autocompleteAddress(query, limit, fetchFn) {
  var q = String(query || '').trim();
  if (q.length < MIN_QUERY_LEN) {
    return [];
  }
  var lim = clampLimit(limit);
  var doFetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) {
    return [];
  }

  var url = new URL(PHOTON_URL);
  // Send a suffix-expanded COPY to Photon (e.g. "Rd"->"Road") so the provider's
  // form-sensitive index still surfaces the nearby street/POI. The user-visible
  // input (and the Census fallback string) keep the dispatcher's original text.
  url.searchParams.set('q', normalizeForPhoton(q));
  url.searchParams.set('limit', String(lim));
  url.searchParams.set('lang', 'en');
  // Bias toward PA / US.
  url.searchParams.set('lat', String(PA_BIAS_LAT));
  url.searchParams.set('lon', String(PA_BIAS_LON));
  // SOFT bias: constrain ranking/limit to the PA bounding box so out-of-state
  // noise is pushed out before the limit cap.
  url.searchParams.set('bbox', PA_BBOX_PARAM);

  var resp;
  try {
    resp = await doFetch(url.toString(), { method: 'GET' });
  } catch (e) {
    return [];
  }
  if (!resp || (typeof resp.status === 'number' && resp.status >= 400)) {
    return [];
  }

  var body;
  try {
    body = await resp.json();
  } catch (e) {
    return [];
  }

  var features = (body && Array.isArray(body.features)) ? body.features : [];
  var out = [];
  for (var i = 0; i < features.length && out.length < lim; i++) {
    var f = features[i] || {};
    var props = f.properties || {};
    // Filter to US results where the provider exposes country.
    if (props.countrycode && String(props.countrycode).toUpperCase() !== 'US') {
      continue;
    }
    if (props.country &&
        String(props.country).toLowerCase().indexOf('united states') === -1 &&
        !props.countrycode) {
      continue;
    }

    // Parse coords up front (Photon GeoJSON is [lon, lat]) so the PA filter can
    // fall back to the bounding box when a feature carries no state field.
    var geom = f.geometry || {};
    var coords = Array.isArray(geom.coordinates) ? geom.coordinates : null;
    var lon, lat;
    if (coords && coords.length >= 2) {
      lon = Number(coords[0]);
      lat = Number(coords[1]);
    }

    // HARD filter: only Pennsylvania candidates reach the dropdown.
    if (!isPennsylvania(props, lat, lon)) {
      continue;
    }

    var label = labelFromProps(props);
    if (!label) continue;

    var item = { label: label };
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      item.lat = lat;
      item.lon = lon;
    }
    out.push(item);
  }
  return out;
}

/**
 * Server-side Photon GEOCODE of a full address string — the fallback used by
 * resolveAnimalCoord when the Census exact-match geocoder returns not_found
 * (Census is weak on rural PA; Photon resolves many of the same addresses the
 * typeahead already matched). Reuses autocompleteAddress (same provider, same
 * normalization) and returns the FIRST candidate that carries finite coords.
 *
 * @param {string} address    full one-line address
 * @param {Function} fetchFn  fetch-compatible (url, init) -> Promise<Response>
 * @returns {Promise<{status:'ok',coord:{lat,lon}}|{status:'not_found'}>}
 *          Never throws / never 'unavailable' — a Photon error degrades to
 *          not_found so the caller surfaces the existing not-found contract.
 */
async function photonGeocode(address, fetchFn) {
  var addr = String(address || '').trim();
  if (addr.length < MIN_QUERY_LEN) {
    return { status: 'not_found' };
  }
  var items;
  try {
    items = await autocompleteAddress(addr, 1, fetchFn);
  } catch (e) {
    return { status: 'not_found' };
  }
  if (!Array.isArray(items)) {
    return { status: 'not_found' };
  }
  for (var i = 0; i < items.length; i++) {
    var it = items[i] || {};
    if (typeof it.lat === 'number' && typeof it.lon === 'number' &&
        Number.isFinite(it.lat) && Number.isFinite(it.lon)) {
      return { status: 'ok', coord: { lat: it.lat, lon: it.lon } };
    }
  }
  return { status: 'not_found' };
}

/**
 * EXACT-match Census fallback for the typeahead. Called by the handler ONLY
 * when Photon returned 0 PA candidates AND the query looksLikeFullAddress() —
 * so it never fires per-keystroke, only on a complete pasted address. Hits the
 * Census `locations/onelineaddress` geocoder for the SAME (un-normalized) string
 * and, on a match, returns ONE dropdown candidate identical in shape to a Photon
 * suggestion ({label, lat, lon}) so the existing acSelect coord-capture path
 * treats it the same. Non-PA matches are dropped via isPennsylvania(). Never
 * throws; any error / no match -> [].
 *
 * @param {string} query     the full address the dispatcher pasted
 * @param {Function} fetchFn fetch-compatible (url, init) -> Promise<Response>
 * @returns {Promise<Array<{label:string,lat:number,lon:number}>>}
 */
async function censusAutocompleteFallback(query, fetchFn) {
  var addr = String(query || '').trim();
  if (addr.length < MIN_QUERY_LEN) {
    return [];
  }
  var doFetch = fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) {
    return [];
  }

  var url = new URL(CENSUS_AC_URL);
  url.searchParams.set('address', addr);
  url.searchParams.set('benchmark', CENSUS_AC_BENCHMARK);
  url.searchParams.set('format', 'json');

  var resp;
  try {
    resp = await doFetch(url.toString(), { method: 'GET' });
  } catch (e) {
    return [];
  }
  if (!resp || (typeof resp.status === 'number' && resp.status >= 400)) {
    return [];
  }

  var body;
  try {
    body = await resp.json();
  } catch (e) {
    return [];
  }

  var result = (body && body.result) || {};
  var matches = Array.isArray(result.addressMatches) ? result.addressMatches : [];
  if (matches.length === 0) {
    return [];
  }
  var m = matches[0] || {};
  var coords = m.coordinates || {};
  var lat = Number(coords.y);
  var lon = Number(coords.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return [];
  }
  // PA-only: the Census match has no provider state field here, so isPennsylvania
  // falls back to the PA bbox on its coordinate (consistent with the Photon path).
  if (!isPennsylvania({}, lat, lon)) {
    return [];
  }
  var label = m.matchedAddress ? String(m.matchedAddress).trim() : addr;
  return [{ label: label, lat: lat, lon: lon }];
}

module.exports = {
  PHOTON_URL,
  MIN_QUERY_LEN,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  CENSUS_AC_URL,
  CENSUS_AC_BENCHMARK,
  SUFFIX_MAP,
  clampLimit,
  labelFromProps,
  normalizeForPhoton,
  looksLikeIntersection,
  looksLikeFullAddress,
  hasHouseNumberMatch,
  autocompleteAddress,
  photonGeocode,
  censusAutocompleteFallback,
};

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
const MIN_QUERY_LEN = 3;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

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
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(lim));
  url.searchParams.set('lang', 'en');
  // Bias toward PA / US.
  url.searchParams.set('lat', String(PA_BIAS_LAT));
  url.searchParams.set('lon', String(PA_BIAS_LON));

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
    var label = labelFromProps(props);
    if (!label) continue;

    var item = { label: label };
    var geom = f.geometry || {};
    var coords = Array.isArray(geom.coordinates) ? geom.coordinates : null;
    // Photon GeoJSON is [lon, lat].
    if (coords && coords.length >= 2) {
      var lon = Number(coords[0]);
      var lat = Number(coords[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        item.lat = lat;
        item.lon = lon;
      }
    }
    out.push(item);
  }
  return out;
}

module.exports = {
  PHOTON_URL,
  MIN_QUERY_LEN,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampLimit,
  labelFromProps,
  autocompleteAddress,
};

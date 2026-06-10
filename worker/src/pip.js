'use strict';
/**
 * Point-in-polygon county resolver for the Dispatcher Worker.
 *
 * Single source of truth for the polygons is docs/data/pa_counties.json (the
 * SAME committed GeoJSON the frontend fetches for the WIN-area map). It is
 * imported (not forked) by handler.js and threaded into countyForPoint(), so
 * the worker and the browser never diverge on county boundaries.
 *
 * Algorithm: classic even-odd ray-casting against the OUTER ring of each
 * polygon. PA county features carry no interior holes, so testing the outer
 * ring is exact for this dataset (validated by the diagnosis spike). The 67
 * features are 66 Polygon + 1 MultiPolygon; MultiPolygon is handled by testing
 * every constituent polygon and matching if the point lands in ANY of them.
 *
 * countyForPoint() returns { county, win_area, geoid } from the matched
 * feature's properties, or null when the coordinate is outside every PA county
 * polygon (e.g. out of state). Callers MUST treat null as "county not
 * determined" and never guess.
 */

/**
 * Even-odd ray-casting test of (lon, lat) against a single linear ring.
 * @param {number} lon
 * @param {number} lat
 * @param {Array<[number, number]>} ring  array of [lon, lat] vertices
 * @returns {boolean}
 */
function pointInRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Test (lon, lat) against one GeoJSON Polygon coordinate array. The first ring
 * is the outer boundary; PA counties have no holes so only the outer ring is
 * tested.
 * @param {number} lon
 * @param {number} lat
 * @param {Array} polygon  GeoJSON Polygon coordinates: [outerRing, ...holes]
 * @returns {boolean}
 */
function pointInPolygon(lon, lat, polygon) {
  if (!Array.isArray(polygon) || !polygon.length) return false;
  return pointInRing(lon, lat, polygon[0]);
}

/**
 * Test (lon, lat) against a Polygon OR MultiPolygon geometry.
 * @returns {boolean}
 */
function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    return pointInPolygon(lon, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    for (let p = 0; p < polys.length; p++) {
      if (pointInPolygon(lon, lat, polys[p])) return true;
    }
    return false;
  }
  return false;
}

/**
 * Resolve the county / WIN area / geoid that CONTAINS (lon, lat).
 * @param {number} lon  longitude (x)
 * @param {number} lat  latitude (y)
 * @param {Object} geojson  FeatureCollection with {county, win_area, geoid} props
 * @returns {{county:string, win_area:string, geoid:string}|null}
 */
function countyForPoint(lon, lat, geojson) {
  if (typeof lon !== 'number' || typeof lat !== 'number') return null;
  if (!isFinite(lon) || !isFinite(lat)) return null;
  if (!geojson || !Array.isArray(geojson.features)) return null;
  const feats = geojson.features;
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    if (!f || !f.geometry) continue;
    if (pointInGeometry(lon, lat, f.geometry)) {
      const p = f.properties || {};
      return {
        county: p.county != null ? p.county : null,
        win_area: p.win_area != null ? p.win_area : null,
        geoid: p.geoid != null ? p.geoid : null,
      };
    }
  }
  return null;
}

module.exports = {
  pointInRing,
  pointInPolygon,
  pointInGeometry,
  countyForPoint,
};

'use strict';
/**
 * County -> WIN area map for the Worker.
 *
 * This is the SAME mapping the frontend loads from docs/data/county_win.json.
 * It is duplicated here (not fetched) because the Worker bundle has no access
 * to the docs/ static assets. If docs/data/county_win.json changes, update this
 * table to match. The map is PII-free public geography (PA county -> WIN area).
 *
 * countyToArea() normalizes the incoming county name (trims, strips a trailing
 * " County", case-insensitive) before lookup and returns null when the county
 * is unknown — callers must treat null as "area unknown" and never guess.
 */

const COUNTY_WIN = {
  Adams: '12', Allegheny: '10', Armstrong: '5', Beaver: '10', Bedford: '11',
  Berks: '14', Blair: '7', Bradford: '3', Bucks: '15S', Butler: '5',
  Cambria: '6', Cameron: '2', Carbon: '9', Centre: '7', Chester: '16',
  Clarion: '5', Clearfield: '6', Clinton: '3', Columbia: '8', Crawford: '1',
  Cumberland: '13', Dauphin: '13', Delaware: '16', Elk: '2', Erie: '1',
  Fayette: '11', Forest: '2', Franklin: '12', Fulton: '12', Greene: '10',
  Huntingdon: '7', Indiana: '6', Jefferson: '6', Juniata: '13', Lackawanna: '4',
  Lancaster: '16', Lawrence: '5', Lebanon: '14', Lehigh: '15N', Luzerne: '9',
  Lycoming: '3', McKean: '2', Mercer: '1', Mifflin: '7', Monroe: '9',
  Montgomery: '15S', Montour: '8', Northampton: '15N', Northumberland: '8',
  Perry: '13', Philadelphia: '15S', Pike: '9', Potter: '3', Schuylkill: '14',
  Snyder: '8', Somerset: '11', Sullivan: '3', Susquehanna: '4', Tioga: '3',
  Union: '8', Venango: '1', Warren: '2', Washington: '10', Wayne: '4',
  Westmoreland: '11', Wyoming: '4', York: '12',
};

// Lower-cased index so lookups tolerate casing differences from the geocoder.
const COUNTY_WIN_LC = Object.create(null);
for (const k in COUNTY_WIN) {
  if (Object.prototype.hasOwnProperty.call(COUNTY_WIN, k)) {
    COUNTY_WIN_LC[k.toLowerCase()] = COUNTY_WIN[k];
  }
}

/**
 * @param {string} county  bare county name (with or without a " County" suffix)
 * @returns {string|null}  WIN area string (e.g. "10", "15S") or null if unknown
 */
function countyToArea(county) {
  if (county === null || county === undefined) return null;
  const norm = String(county).trim().replace(/\s+County$/i, '').toLowerCase();
  if (!norm) return null;
  const area = COUNTY_WIN_LC[norm];
  return area === undefined ? null : area;
}

/**
 * Returns all county names (title-cased, as in COUNTY_WIN) belonging to a
 * given WIN area.  Comparison is case-insensitive so '14', '14 ', and '14'
 * all match.  Returns an empty array for null / unknown areas.
 *
 * @param {string} area  WIN area string (e.g. "14", "15S")
 * @returns {string[]}   Sorted array of county names in that area
 */
function areaCounties(area) {
  if (area === null || area === undefined) return [];
  const norm = String(area).trim().toLowerCase();
  if (!norm) return [];
  const result = [];
  for (const k in COUNTY_WIN) {
    if (Object.prototype.hasOwnProperty.call(COUNTY_WIN, k)) {
      if (String(COUNTY_WIN[k]).trim().toLowerCase() === norm) {
        result.push(k);
      }
    }
  }
  return result.sort();
}

module.exports = { COUNTY_WIN, countyToArea, areaCounties };

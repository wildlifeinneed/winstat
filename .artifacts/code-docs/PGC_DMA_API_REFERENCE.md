# PGC DMA API Reference

> Developer reference for the **Pennsylvania Game Commission (PGC) Disease
> Management Area (DMA)** resources discovered and used by this project. A DMA is
> a geographic zone the PGC defines around Chronic Wasting Disease (CWD)
> detections, with special rules for handling deer/elk carcasses and parts.
>
> Audience: a developer who wants to reuse these endpoints in another app
> (e.g. an iPhone app). Everything below is a **public** PGC resource — no API
> key or authentication is required.

---

## 1. PGC DMA Dashboard (human-facing)

**URL:** https://pagame.maps.arcgis.com/apps/dashboards/b3c0fd44cc5944ebbc2229ede897b2ae

This is an Esri/ArcGIS **Dashboard** — an interactive web map that shows the
current Pennsylvania Disease Management Areas (DMAs), their boundaries, and
related CWD information for the public. It is meant to be opened in a browser by
a person, not consumed programmatically.

**Important caveat about URL parameters:** ArcGIS dashboards *can* accept URL
parameters (such as `geometry` or `extent`) to pre-zoom or filter the map — but
**only if the dashboard owner explicitly configures URL parameters** for that
dashboard. **This dashboard does not have them configured**, so appending
`?geometry=...` / `?extent=...` to the URL has no effect. Do not rely on URL
parameters to deep-link into a specific DMA on this dashboard.

If you need to programmatically determine which DMA a coordinate falls in, use
the REST API in section 2 instead — the dashboard is for display only.

---

## 2. PGC ArcGIS REST API — DMA Spatial Query

This is the programmatic endpoint. It lets you ask **"which DMA (if any) is this
GPS coordinate inside?"** via a point-in-polygon spatial query.

### Endpoints

- **Layer info (metadata):**
  https://pgcmaps.pa.gov/arcgis/rest/services/PGC/NEW_PUBLIC/MapServer/28?f=json
  Returns the layer definition: field list, geometry type, coded-value domains,
  spatial reference, etc. Hit this first to inspect available fields.

- **Query (spatial search):**
  https://pgcmaps.pa.gov/arcgis/rest/services/PGC/NEW_PUBLIC/MapServer/28/query
  The actual point-in-polygon query endpoint used at runtime.

### Point-in-polygon query

To find the DMA containing a given longitude/latitude, append these query
parameters to the `/query` endpoint:

```
geometry=LON,LAT
geometryType=esriGeometryPoint
inSR=4326
spatialRel=esriSpatialRelIntersects
outFields=NAME,DMA
f=json
```

- `geometry=LON,LAT` — the point, as `longitude,latitude` (x,y order). **Note
  the order: longitude first, latitude second.** This is NOT `lat,lon`.
- `geometryType=esriGeometryPoint` — we are passing a single point.
- `inSR=4326` — the spatial reference of the input coordinate (WGS84 / standard
  GPS lat/lon).
- `spatialRel=esriSpatialRelIntersects` — return polygons the point falls inside.
- `outFields=NAME,DMA` — which attribute fields to return (use `*` for all).
- `f=json` — response format (`json` or `geojson`).

### Response shape

A successful response contains a `features` array. Each matching DMA polygon
appears as one feature with an `attributes` object holding the requested fields:

```json
{
  "features": [
    {
      "attributes": {
        "NAME": "DMA 2",
        "DMA": 2
      }
    }
  ]
}
```

- **`NAME`** — human-readable DMA name (e.g. `"DMA 2"`).
- **`DMA`** — the DMA number (integer, 1–10).

**Empty `features` array (`"features": []`)** means the coordinate is **not
inside any Disease Management Area** — i.e. that location is not currently in a
DMA. Treat an empty result as "no DMA here," not as an error.

### Available fields (layer 28)

| Field | Meaning |
| --- | --- |
| `NAME` | Human-readable DMA name (e.g. `"DMA 2"`). |
| `DMA` | DMA number, integer 1–10 (coded values below). |
| `WMXDB_DBO_CWD_DMA_AREA` | Area of the DMA in square miles. |
| `GlobalID` | Esri global unique identifier for the feature. |
| `Shape` | The polygon geometry of the DMA boundary. |

### DMA coded values

The `DMA` field is a coded integer. The defined values are:

| Code | Name |
| --- | --- |
| 1 | DMA 1 |
| 2 | DMA 2 |
| 3 | DMA 3 |
| 4 | DMA 4 |
| 5 | DMA 5 |
| 6 | DMA 6 |
| 7 | DMA 7 |
| 8 | DMA 8 |
| 9 | DMA 9 |
| 10 | DMA 10 |

### Working curl example

The coordinate `-77.5, 40.8` (longitude, latitude) falls inside **DMA 2**:

```bash
curl "https://pgcmaps.pa.gov/arcgis/rest/services/PGC/NEW_PUBLIC/MapServer/28/query?geometry=-77.5,40.8&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=NAME,DMA&f=json"
```

Expected (abridged) response:

```json
{
  "features": [
    { "attributes": { "NAME": "DMA 2", "DMA": 2 } }
  ]
}
```

**This is a PUBLIC endpoint — no authentication, API key, or token is required.**

---

## 3. Other PGC CWD layers on the same MapServer

The same MapServer
(`https://pgcmaps.pa.gov/arcgis/rest/services/PGC/NEW_PUBLIC/MapServer`) exposes
several other CWD-related layers. Each is queryable the same way as layer 28
(swap the layer number in the path):

| Layer | Contents |
| --- | --- |
| 28 | DMA polygons (used above for point-in-polygon DMA lookup). |
| 100 | CWD Hunter Services. |
| 300 | CWD Disease Management Areas. |
| 301 | CWD Disease Management Areas by Season. |
| 302 | CWD Established Area. |

**Hub / data catalog page:**
https://pa-geo-data-pennmap.hub.arcgis.com/maps/d19b310d50e04d88b5e3e0faeee75a78

Use the hub page to browse and confirm layer definitions, and to discover any
additional related CWD datasets the PGC publishes.

---

## 4. Usage notes

- **Public endpoint, no auth.** No API key, token, or login is needed.
- **Rate limits.** No rate limit is documented, but be reasonable — cache
  results where possible and avoid hammering the service with rapid-fire
  requests.
- **Coordinate system.** Coordinates must be **WGS84** (standard GPS lat/lon),
  which corresponds to `inSR=4326`.
- **Geometry parameter order.** The `geometry` parameter is `x,y` —
  **`longitude,latitude`**, NOT `lat,lon`. Getting the order wrong is the most
  common mistake and will silently return the wrong DMA or an empty result.
- **Response formats.** The API supports both JSON and GeoJSON: use `f=json`
  for Esri JSON or `f=geojson` for standard GeoJSON output.

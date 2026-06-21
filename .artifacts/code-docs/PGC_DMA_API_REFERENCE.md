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

## 2. PGC ArcGIS REST API — DMA Spatial Query (PRIMARY)

This is the programmatic endpoint. It lets you ask **"which DMA (if any) is this
GPS coordinate inside?"** via a point-in-polygon spatial query.

> **Recommended endpoint.** Prefer the **FeatureServer 300** endpoint below. It
> exposes richer attributes (status, dates, area) and lets you filter to
> active-only DMAs server-side. The legacy MapServer layer 28 (section 5) still
> works but is kept only as a secondary reference.

### Base URL

```
https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer
```

### Endpoints (layer 300 — CWD Disease Management Areas)

- **Layer info (metadata):**
  https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer/300?f=json
  Returns the layer definition: field list, geometry type, coded-value domains,
  spatial reference, etc. Hit this first to inspect available fields.

- **Query (spatial search):**
  https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer/300/query
  The actual point-in-polygon query endpoint used at runtime.

### Point-in-polygon query

To find the **active** DMA containing a given longitude/latitude, append these
query parameters to the `/query` endpoint:

```
geometry=LON,LAT
geometryType=esriGeometryPoint
inSR=4326
spatialRel=esriSpatialRelIntersects
where=dma_status='A'
outFields=dma_name,dma,dma_status,start_date,end_date,area_sqmi
returnGeometry=false
f=json
```

- `geometry=LON,LAT` — the point, as `longitude,latitude` (x,y order). **Note
  the order: longitude first, latitude second.** This is NOT `lat,lon`.
- `geometryType=esriGeometryPoint` — we are passing a single point.
- `inSR=4326` — the spatial reference of the input coordinate (WGS84 / standard
  GPS lat/lon).
- `spatialRel=esriSpatialRelIntersects` — return polygons the point falls inside.
- `where=dma_status='A'` — **filter to active DMAs only** (see coded values
  below). Use `where=1=1` to return DMAs of any status.
- `outFields=dma_name,dma,dma_status,start_date,end_date,area_sqmi` — which
  attribute fields to return (use `*` for all).
- `returnGeometry=false` — skip the polygon geometry for a smaller, faster
  response when you only need the attributes.
- `f=json` — response format (`json` or `geojson`).

### Response shape

A successful response contains a `features` array. Each matching DMA polygon
appears as one feature with an `attributes` object holding the requested fields.
**Note the field names are lowercase** on this FeatureServer:

```json
{
  "features": [
    {
      "attributes": {
        "dma_name": "DMA 2",
        "dma": 2,
        "dma_status": "A",
        "start_date": 1330560000000,
        "end_date": null,
        "area_sqmi": 3829.4
      }
    }
  ]
}
```

**Empty `features` array (`"features": []`)** means the coordinate is **not
inside any active Disease Management Area** — i.e. that location is not currently
in a DMA matching your `where` filter. Treat an empty result as "no DMA here,"
not as an error.

### Available fields (layer 300)

| Field | Type | Meaning |
| --- | --- | --- |
| `dma_name` | string | Human-readable DMA name (e.g. `"DMA 2"`). |
| `dma` | int | DMA number, integer 1–10 plus `99` (coded values below). |
| `dma_status` | string | DMA status code: `A`/`I`/`P` (coded values below). |
| `start_date` | epoch ms | Date the DMA took effect (Unix epoch milliseconds). |
| `end_date` | epoch ms | Date the DMA ended/expired, or `null` if still in effect. |
| `area_sqmi` | double | Area of the DMA in square miles. |
| `area_ac` | double | Area of the DMA in acres. |
| `estab_date` | epoch ms | Date the DMA was established (Unix epoch milliseconds). |

### `dma_status` coded values

The `dma_status` field is a coded string:

| Code | Meaning |
| --- | --- |
| `A` | Active |
| `I` | Inactive |
| `P` | Proposed |

To return **only active DMAs**, filter with `where=dma_status='A'`.

### `dma` coded values

The `dma` field is a coded integer:

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
| 99 | Proposed |

### Working curl example

The coordinate `-77.5, 40.8` (longitude, latitude) falls inside **DMA 2**:

```bash
curl "https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer/300/query?geometry=-77.5,40.8&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&where=dma_status%3D%27A%27&outFields=dma_name,dma,dma_status,start_date,end_date,area_sqmi&returnGeometry=false&f=json"
```

Expected (abridged) response:

```json
{
  "features": [
    {
      "attributes": {
        "dma_name": "DMA 2",
        "dma": 2,
        "dma_status": "A"
      }
    }
  ]
}
```

**This is a PUBLIC endpoint — no authentication, API key, or token is required.**

---

## 3. Other CWD layers on the FeatureServer

The same FeatureServer
(`https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer`)
exposes several other CWD-related layers. Each is queryable the same way as
layer 300 (swap the layer number in the path):

| Layer | Contents |
| --- | --- |
| 100 | CWD Hunter Services. |
| 300 | CWD Disease Management Areas (used above for point-in-polygon DMA lookup). |
| 301 | CWD Disease Management Areas by Season. |
| 302 | CWD Established Area. |

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
- **Status filtering.** Use `where=dma_status='A'` to return only active DMAs.
  Omit it (or use `where=1=1`) to include inactive/proposed areas.
- **Date fields.** `start_date`, `end_date`, and `estab_date` are Unix epoch
  **milliseconds**; divide by 1000 before passing to most date libraries.
- **Response formats.** The API supports both JSON and GeoJSON: use `f=json`
  for Esri JSON or `f=geojson` for standard GeoJSON output.

---

## 5. Legacy endpoint — MapServer layer 28 (SECONDARY reference)

> **Deprecated for new work.** Prefer the FeatureServer 300 endpoint in section
> 2. This legacy MapServer layer is retained only as a fallback reference; it
> returns fewer fields and does not expose the status/date attributes.

### Endpoints

- **Layer info (metadata):**
  https://pgcmaps.pa.gov/arcgis/rest/services/PGC/NEW_PUBLIC/MapServer/28?f=json

- **Query (spatial search):**
  https://pgcmaps.pa.gov/arcgis/rest/services/PGC/NEW_PUBLIC/MapServer/28/query

### Point-in-polygon query

```
geometry=LON,LAT
geometryType=esriGeometryPoint
inSR=4326
spatialRel=esriSpatialRelIntersects
outFields=NAME,DMA
f=json
```

### Available fields (layer 28)

| Field | Meaning |
| --- | --- |
| `NAME` | Human-readable DMA name (e.g. `"DMA 2"`). |
| `DMA` | DMA number, integer 1–10. |
| `WMXDB_DBO_CWD_DMA_AREA` | Area of the DMA in square miles. |
| `GlobalID` | Esri global unique identifier for the feature. |
| `Shape` | The polygon geometry of the DMA boundary. |

### Working curl example

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

**Hub / data catalog page:**
https://pa-geo-data-pennmap.hub.arcgis.com/maps/d19b310d50e04d88b5e3e0faeee75a78

Use the hub page to browse and confirm layer definitions, and to discover any
additional related CWD datasets the PGC publishes.

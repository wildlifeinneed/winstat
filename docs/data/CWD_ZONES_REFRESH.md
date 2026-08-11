# CWD zone data: vendored snapshot, refresh procedure, and known limitations

This directory carries **three committed GeoJSON snapshots**, vendored from the PA Game
Commission's public CWD FeatureServer, that back the address/coordinate → CWD zone check in
`docs/assets/dispatcher.js` (`checkCwdZone`, `loadCwdZones`). See
`docs/DMA_TO_WMU_MIGRATION_SCOPE.md` ("2026-08 addendum") for why this check exists at all —
short version: PGC officially retired the numbered DMA system 2026-06-30, but PGC field staff
and the state dispatch office are still enforcing the retired boundaries in practice, so this
dispatcher needs to report against BOTH the retired-but-enforced boundary and the current
official one.

## Files

| File | Contents | Source layer | Raw size | Gzipped |
| --- | --- | --- | --- | --- |
| `cwd_dma_original.json` | 8 features: the "last-in-effect" original DMA polygons (DMA 2,3,4,6,7,8,9,10) | FeatureServer layer `300`, filtered to `end_date` = 2026-06-30 | 1,757,354 bytes | ~673 KB |
| `cwd_dma5_historical.json` | 1 feature: DMA 5 only, kept **separate** from the file above | FeatureServer layer `300`, `dma=5` (OBJECTID 16) | 27,361 bytes | ~11 KB |
| `cwd_established_area.json` | 1 feature: the current official CWD Established Area | FeatureServer layer `302` | 180,365 bytes | ~70 KB |

**Fetch date of this snapshot: 2026-08-11.**

## Why DMA 5 is a separate file, not merged into `cwd_dma_original.json`

Layer 300 holds 37 records that are a **versioned history**, not 37 distinct zones — DMA 2 alone
appears many times as its boundary grew across years, each version carrying its own `end_date`.
Filtering to `end_date` = 2026-06-30 correctly isolates the **8 records that were still in effect
at the moment PGC retired the numbered system** (verified live: this filter returns exactly 8
features, OBJECTIDs 19, 22, 27, 33, 34, 35, 36, 37 — DMA 6, 7, 4, 2, 3, 8, 9, 10 respectively,
totaling ~15,043 sq mi).

**DMA 5 (OBJECTID 16) does not match that filter** — its `end_date` is 2026-06-04, three weeks
earlier, meaning it was already retired before the rest of the system was. It is neither
"currently in the last-in-effect set" nor safely ignorable: field staff working from "the
original DMA locations" may well still reference it too, and the operating principle for this
whole feature is that over-flagging is the safe direction. So it is vendored as its own file and
surfaced as its own, separately-labeled result (`dispatcher.js` `dma5Hit`, rendered via
`MSG.cwdZone.insideDma5`) — **never silently merged into the main DMA list, and never silently
dropped.**

## Source queries used to produce this snapshot

All queries were run against:

```
https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer
```

1. **Discover the schema and confirm `dma_status` is dead** (returns 0 features):
   ```
   GET /300/query?where=dma_status%3D%27A%27&returnGeometry=false&f=json
   → { "features": [] }
   ```

2. **List all 37 history records with attributes only** (no geometry, to identify which
   `OBJECTID`s to pull with geometry):
   ```
   GET /300/query?where=1%3D1&outFields=dma,dma_name,dma_status,start_date,end_date,area_sqmi,OBJECTID&returnGeometry=false&f=json
   ```
   `start_date`/`end_date` are returned as **epoch milliseconds**, not ISO strings — a plain
   string comparison like `end_date='2026-06-30'` returns 0 rows. The verified epoch value for
   2026-06-30T00:00:00Z is `1782792000000`. Filtering the 37-row attribute dump in application
   code (not a server-side `WHERE`, to avoid a second date-syntax pitfall) for
   `end_date === 1782792000000` returns exactly 8 rows; separately, `dma === 5` identifies
   OBJECTID 16 (`end_date = 1780545600000`, i.e. 2026-06-04).

3. **Fetch geometry for the 9 relevant records** (8 last-in-effect + DMA 5) in one call, WGS84:
   ```
   GET /300/query?objectIds=19,22,27,33,34,35,36,37,16&outFields=dma,dma_name,dma_status,start_date,end_date,area_sqmi,OBJECTID&returnGeometry=true&outSR=4326&f=geojson
   ```
   The result was then split locally into `cwd_dma_original.json` (the 8 non-DMA-5 features) and
   `cwd_dma5_historical.json` (the DMA-5 feature), by `dma` / `OBJECTID`, with geometry copied
   through byte-identical (no simplification, no coordinate rounding).

4. **Fetch the current Established Area** (layer 302, single active polygon):
   ```
   GET /302/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson
   ```
   Returned exactly 1 feature, `ea_status='A'`, `area_sqmi=1967.23944841` (~13% of the DMA
   footprint), `dma=2` (a **legacy tag** on this layer, `start_date` 2021-04-07 — this is NOT a
   revived DMA 2, per the task brief; it is reported under its own `insideEstablishedArea` result
   key and never conflated with the original-DMA result). Noisy internal ArcGIS bookkeeping
   fields (`GlobalID`, `created_user`, `Shape__Area`, `Shape__Length`, etc.) were dropped from the
   vendored properties; geometry was copied through unchanged.

## Why vendored instead of queried live

Investigated the payload cost directly before deciding: the 9 DMA-era records total **1.78 MB
raw / ~684 KB gzipped**; the Established Area adds **180 KB raw / ~70 KB gzipped**. That is
larger than `docs/data/pa_counties.json` (168 KB) but smaller than `docs/assets/dispatcher.js`
itself (308 KB uncompressed) — a reasonable one-time static-asset cost for a feature that answers
a disease-containment safety question, especially against the alternative of depending on a live
third-party query for that answer.

**No coordinate simplification or rounding was applied.** The vendored geometry is a structural
copy of what the FeatureServer returned (`outSR=4326`, full vertex precision as served). If this
ever needs to shrink for size reasons in the future, any simplification MUST only ever move a
boundary **outward** (buffer out, never in) and must be called out explicitly in this file and in
the commit that makes the change — silently simplifying inward would create a false "outside"
result exactly where accuracy is most important (near a boundary).

## Known limitation — read this before assuming the data is current

**This is a point-in-time snapshot of data that PA Game Commission has already administratively
retired.** The 9 source records back this snapshot are, by PGC's own current status flags,
inactive / historical. PGC has no stated obligation to keep them queryable, unchanged, or even
present in the FeatureServer going forward — they could be edited, re-keyed, or deleted at any
time, for any reason, with no notice to this project.

**If that happens, this repo's vendored copy silently becomes the only surviving version of this
boundary data.** There is no live check in this codebase that would notice a PGC-side deletion or
alteration of the source records (a live query was deliberately avoided per the design above, so
there is nothing to fail loud when the *source*, rather than *this app's fetch of its own vendored
copy*, changes). The precedent motivating this vendoring decision in the first place — a
different project's dependency on a similarly "temporary" upstream identifier 404ing for 71 days
while the UI kept printing a number — is exactly the failure mode being traded for a different
one here: instead of an outage, the risk is silent staleness with no expiry signal.

Mitigations in place:
- The fetch date (2026-08-11) is recorded in this file and in `CWD_ZONES_SNAPSHOT_DATE` in
  `dispatcher.js`, and is surfaced to the dispatcher in every zone-check result
  (`MSG.cwdZone.snapshotNote`) so staleness is visible on every use, not just in documentation.
- The refresh procedure above is fully reproducible from raw HTTP requests, so re-vendoring is a
  mechanical exercise, not a research project, if/when someone needs to check for drift.

What is explicitly **not** mitigated: there is no automated staleness alarm, and no comparison
against the live service to detect if PGC has changed or removed these records. Revisiting this
decision (e.g. adding a periodic manual re-fetch-and-diff check) is a reasonable follow-up but was
out of scope for this restoration.

## How to refresh this snapshot

1. Re-run query 2 above against layer 300 to get the current full attribute list. Confirm the
   `end_date` epoch value for the current retirement boundary (recompute `2026-06-30` if the
   effective date is different at refresh time) and confirm how many `OBJECTID`s match it — if it
   is not 8, something about the source data has changed; investigate before proceeding, do not
   assume 8 is still correct.
2. Confirm DMA 5 (or check whether any OTHER DMA has since fallen into the same "retired earlier
   than the rest" bucket) and decide file placement accordingly — the same "separate file, never
   silently merged or dropped" rule applies to any future DMA in that situation.
3. Re-run query 3 with the updated `objectIds` list, split into the two DMA files.
4. Re-run query 4 for the Established Area; confirm `ea_status='A'` still identifies exactly one
   feature.
5. Update `CWD_ZONES_SNAPSHOT_DATE` in `docs/assets/dispatcher.js` and the fetch date in this file.
6. Re-run the CWD zone check tests (`test/dispatcher_dom.test.js`) — the near-boundary and
   inside/outside fixtures used by those tests are pinned to THIS snapshot's specific geometry;
   a refresh that changes a boundary meaningfully may require updating those fixture coordinates
   too. Verify, don't assume, that the existing test coordinates still land in the same regions.

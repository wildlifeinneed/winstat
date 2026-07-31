# DMA → WMU Migration Scope: Feasibility of an Automated CWD-Area Check

> Status: research/decision doc. No code changes. Companion to the fail-safe fix in
> commit `8ebdcf9` (`fix(dma): fail-safe on empty DMA query result instead of confident 'clear'`).

## Feasibility verdict

**No.** A correct, honest, fully-automated "does this address fall in an area with active
CWD management rules?" check is **not buildable today** — not because boundary data is
unavailable (it is, and it is CORS-accessible), but because **PGC has not published, in any
machine-readable form, which Wildlife Management Units currently carry CWD restrictions.**
That fact lives only in prose (a StoryMap paragraph and the Hunting & Trapping Digest PDF).
A WMU polygon lookup can tell you *which WMU* a point is in; it cannot tell you *whether that
WMU has CWD rules* without a human-maintained, out-of-band mapping this project would have to
invent and keep in sync itself — which is a liability, not a fix.

Recommendation: **do not build a WMU rule-status lookup.** Replace the DMA banner with a
degraded-but-honest design — locate context, never assert compliance status, always route to
PGC's authoritative source. Details below.

---

## 1. Is there a queryable WMU boundary source?

**Yes — and it is CORS-accessible from a static site.** Three candidates were found and tested
live (not from docs — actual HTTP requests with `Origin: https://example.github.io`, which is
what a GitHub Pages app sends):

### 1a. PGC production layer (recommended if a boundary lookup were ever built)

```
https://pgcmaps.pa.gov/arcgis/rest/services/PGC/NEW_PUBLIC/MapServer/23
```

- **Layer name:** "Wildlife Management Units". **Fields:** `WMU_ID` (string, e.g. `"4D"`),
  `ACREAGE`, `PERIMETER`, `GROUP_ID`, `HYPERLINK`, `GlobalID`, `OBJECTID`.
- **This is the same layer PGC's own public "WMU Boundary Maps" WebAppBuilder app queries**
  (confirmed by reading the app's saved config at
  `arcgis.com/sharing/rest/content/items/52d95dfa9b1644f88afc6c07a4f404f4/data` — its Search
  widget points at this exact URL). That means it is the PGC's own live, canonical WMU source,
  not a mirror.
- **CORS test (this repo, live):**
  ```
  curl -H "Origin: https://example.github.io" -D - \
    "https://pgcmaps.pa.gov/arcgis/rest/services/PGC/NEW_PUBLIC/MapServer/23?f=json"
  → HTTP/1.1 200 OK
    Access-Control-Allow-Origin: https://example.github.io   (reflects any origin)
    Access-Control-Allow-Credentials: true
  ```
  A point-in-polygon query against it also succeeds cross-origin:
  ```
  GET .../MapServer/23/query?geometry=-77.5,40.8&geometryType=esriGeometryPoint&inSR=4326
      &spatialRel=esriSpatialRelIntersects&outFields=WMU_ID&f=json
  → 200 OK, features[0].attributes.WMU_ID = "4D"
  ```
- **Stability:** this is a legacy (non-hosted, on-prem `pgcmaps.pa.gov`) ArcGIS Server instance,
  the same tier the current DMA code already depends on for its "legacy MapServer layer 28"
  fallback (see `.artifacts/code-docs/PGC_DMA_API_REFERENCE.md` §5). It has been live since at
  least 2016 (item creation date on the WebAppBuilder wrapper). No documented SLA, but no
  different in risk profile from the FeatureServer/300 endpoint already in production use.
- **Currency of WMU boundaries themselves:** PGC's own WMU page states boundaries were "updated
  2023" and are reviewed only periodically ("established for the long term"). WMU boundaries
  change far less often than DMA boundaries did — this is a structurally more stable geometry
  to depend on.

### 1b. PASDA (Pennsylvania Spatial Data Access) mirror

```
https://mapservices.pasda.psu.edu/server/rest/services/pasda/PennsylvaniaGameCommission/MapServer/5
```
("PGC BND Wildlife Management Units 2021" — same `WMU_ID` field.) Also public, also CORS-open
(`Access-Control-Allow-Origin: https://example.github.io` reflected in test). PASDA additionally
offers static exports (GeoJSON, shapefile, CSV) at
`pasda.psu.edu/download/pgc/PGC_BNDWildlifeManagementUnits2021.zip` /
`.../PGC_BNDWildlifeManagementUnits2021.geojson` — useful only as **test fixtures**, not as a
live dependency (see Hard Constraints: no bundling a static copy as the fix).

### 1c. DCNR mirror (secondary, do not use)

```
https://www.gis.dcnr.state.pa.us/agsprod/rest/services/BOF/HuntStateForest/MapServer/1
```
Also has a `WMU_ID`-equivalent field, but is a Bureau of Forestry copy layered for their own
hunting-on-state-forest-land use case, not PGC's canonical source. Mentioned for completeness
only.

**Conclusion for Q1:** the WMU boundary problem is **solved** — multiple live, CORS-accessible,
public, no-auth endpoints exist, mirroring the existing DMA_QUERY_URL pattern almost exactly
(`geometry=lon,lat&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects`).
If boundary lookup were the only obstacle, this would be a straightforward repoint. **It is not
the obstacle — see Q2.**

---

## 2. Are the CWD rules per-WMU published in machine-readable form?

**No — and this is the actual blocker.** Every layer that could plausibly hold "which WMU has
CWD restrictions" was checked and ruled out:

### 2a. The `services1.arcgis.com/.../CWD/FeatureServer` — no WMU field, no rule field

Confirmed via `?f=json` on the service root: layers are `100` (Hunter Services), `300` (DMA),
`301` (DMA by Season), `302` (Established Area). **None of these layers has a `WMU_ID` field or
any field describing WMU-level rule status.** This service was built entirely around the DMA
model that PGC has now abandoned; it was never updated to carry WMU-keyed rule data.

### 2b. PASDA's "PGC CWD Management Units 2020" layer — a trap, not the answer

```
https://mapservices.pasda.psu.edu/server/rest/services/pasda/PennsylvaniaGameCommission/MapServer/11
```
This layer's *name* sounds exactly like what Q2 is looking for. Queried live
(`?where=1=1&outFields=*&returnGeometry=false&f=json`), it returns only **3 features**:

```json
{"attributes":{"NAME":"DMA 4","SQUARE_MIL":346.1}},
{"attributes":{"NAME":"DMA 3","SQUARE_MIL":1119.4}},
{"attributes":{"NAME":"DMA 2","SQUARE_MIL":6715.2}}
```

Its own layer description text (also fetched live) reads: *"Defines the boundaries of the
Chronic Wasting Disease Management Areas (DMAs) in Pennsylvania that are governed by special
rules... rehabilitation of cervids... is prohibited."* — **this is the same obsolete DMA
concept under a "CWD Management Units" label**, last touched 2020, missing 7 of the 10 DMAs
that existed by 2026, and it is **not keyed by WMU at all**. Naming it "CWD Management Units"
invites exactly the mistake this task was asked to avoid repeating (cf. the layer-302
"Established Area" false lead already rejected in commit `8ebdcf9`). Do not use this layer for
anything.

### 2c. The only place the WMU→CWD-restriction mapping actually exists: prose

The PGC StoryMap (`storymaps.arcgis.com/stories/ddfce74f89d24a91b116a84ddf126ac6`), fetched live
today, states the current rule set in plain English:

> "There are currently 11 wildlife management units (WMUs) where CWD has been detected in wild,
> free-ranging deer: **2C, 2D, 2E, 2F, 4A, 4B, 4C, 4D, 4E, 5A, and 5B**; and 14 WMUs where CWD
> has been detected in captive facilities: **2B, 2C, 2D, 2E, 2F, 3B, 3C, 4A, 4B, 4C, 4D, 4E, 5A,
> and 5B**."

And, statewide (not WMU-gated) prohibitions:

> "The following is prohibited within **Pennsylvania**: Disposal of high-risk parts on the
> landscape away from the site of kill... The feeding of wild, free-ranging deer within
> designated 'no feeding' areas."

Two important observations:
1. This is a **narrative list of WMU codes in a webpage paragraph**, not a queryable dataset.
   Reusing it would mean regex-scraping a StoryMap's rendered text, or manually hand-copying a
   WMU list into this repo's own JSON and hoping to notice when PGC updates the paragraph. That
   is not "machine-readable," it is "human-transcribed and stale by construction."
2. **The main prohibition (high-risk-parts disposal) is now stated as statewide**, not
   WMU-specific. This matters for Q3/Q4 below: even a perfect WMU lookup would answer a question
   ("is this WMU CWD-affected") that is no longer the same question as "do CWD carcass rules
   apply here" — because for the disposal rule, they apply everywhere in PA now. The
   "no-feeding" restriction remains geographically scoped, but the StoryMap does not give a
   machine-readable boundary for "no feeding areas" either — that is yet another separate,
   undocumented geometry.

### 2d. The stale Executive Order — confirmed, and correctly distrusted

The main PGC CWD page (`pa.gov/agencies/pgc/.../chronic-wasting-disease.html`, fetched live
today) does still link, under "Resources":

> [Executive Order](.../cwd%20designation%20of%20dmas%20and%20endemic%20states%20and%20prov%20order%2015.pdf)

titled "CWD designation of DMAs and endemic states and prov[incial] order 15" — i.e. an order
that *designates DMAs*, the exact concept the StoryMap (dated 2026, describing "regulation
changes in 2026") says no longer defines CWD management. This is agency web content lagging
policy, exactly as the task brief warned. **Trust ranking used in this doc, most to least
authoritative:**
1. The StoryMap's explicit 2026 statement ("DMAs are no longer used... managing CWD at the WMU
   level") — most recent, most directly on-point, hosted by PGC.
2. The 2026-27 Hunting & Trapping Digest (the actual regulatory text hunters are bound by) —
   authoritative but PDF-only, not fetched in full here due to size, but consistent secondary
   reporting (goerie.com, lehighvalleylive.com, wjactv.com, all April 2026) corroborates the
   "carcass can now come home" rule change and confirms it is described at the WMU/statewide
   level, not DMA level.
3. The linked Executive Order PDF — **stale, do not use**, still describes the dissolved DMA
   regime.
4. The FeatureServer/300 DMA layer itself — **stale data**, `dma_status='I'` on every record
   (already established in commit `8ebdcf9`).

**Conclusion for Q2:** No. The WMU→CWD-rule-status mapping is not machine-readable anywhere
PGC publishes it. It exists only as a sentence in a StoryMap and as regulatory text in a PDF
digest. Building a WMU lookup without this mapping produces a boundary answer to a question
nobody asked ("which WMU am I in") while silently failing to answer the actual question ("do
CWD rules apply here") — the same failure mode as the original DMA bug, just moved one layer
down.

---

## 3. What does the rehabber/dispatcher actually need?

Re-read `docs/dispatcher.html` (lines ~1930–2062) and `docs/assets/dispatcher.js`
(`checkDmaForLocation`, lines 4330–4414) plus `docs/USER_MANUAL.md` /
`docs/ADMIN_MANUAL.md` (neither manual mentions the DMA feature at all — it is undocumented
outside the code itself).

Current design, confirmed by reading the code:
- A **static, always-visible link** ("View PA Game Commission DMA Map",
  `dispatcher.html:1931-1938`) sits above both lookup modes, independent of any query result.
  It deep-links to PGC's ArcGIS WebAppBuilder viewer with a layer parameter
  (`showLayers=NEW_PUBLIC_718`) and is updated with the animal's coordinates as a `marker`
  parameter once an address is geocoded (`dispatcher.js:4716-4719`).
- A **live banner** (`#dma-status`, Tier-2/address-mode only) additionally tries to give an
  automated yes/no by querying FeatureServer/300 directly (the code just fixed in `8ebdcf9` to
  fail safely rather than falsely claim "clear").

What the volunteer/dispatcher is actually deciding: *whether it's safe to transport this animal
(almost always a deer/cervid case in practice) out of its found location*, in the middle of an
emergency phone call, with limited time to read a PDF. Given the findings in §2:

- **The WMU-gated question ("is this WMU on the 11-WMU list") does not fully answer the
  operational question anymore**, because the highest-consequence rule (carcass/high-risk-parts
  handling) is now statewide, not WMU-scoped. A rehabber outside all 11 listed WMUs could still
  be bound by the statewide disposal rule if the animal doesn't survive rehab.
- **Automating "which WMU" and stopping there would create a new, subtler version of the exact
  bug being fixed**: a volunteer outside the 11 named WMUs seeing a coded "not in a CWD WMU"
  status could reasonably read that as "no CWD rules apply," which is false for the statewide
  disposal rule. That is under-flagging — the dangerous direction per this task's own fail-safe
  principle.
- The real need, reduced to what's actually knowable and current, is: **"here is where you are
  and here is PGC's authoritative, currently-maintained guidance for that location — go read it
  or call the hotline."** That is a navigation/information need, not a computed yes/no.

The framing in the original feature ("does this address fall in a DMA" as a computed boolean)
was reasonable when DMAs were real polygons with a status flag. **It stopped being answerable
the moment PGC moved the rule logic into unstructured prose.** The feature's shape should follow
that change, not fight it.

---

## 4. Recommended design

**Remove the automated determination. Keep and slightly strengthen the link-out.**

This is the "degraded-but-honest" option from the task brief, chosen over the WMU-lookup option,
for one concrete reason: a WMU lookup can be built (§1), but it cannot be paired with a trustworthy
rule-status answer (§2), and shipping a location-aware feature that implies a rule-status answer
it cannot actually give is the harm case this task exists to prevent. Removing the live query
entirely — rather than quietly leaving today's already-fail-safe amber banner in place — is
justified because:
- The banner's *only* possible outputs today are "matched an active DMA" (impossible now — zero
  active DMAs exist statewide) or "inconclusive, verify manually" (now the only reachable
  outcome, always, for every address). A banner that can structurally only ever say "inconclusive"
  is not providing information; it is providing the same fixed disclaimer regardless of input,
  dressed as a live check. That is the "feature kept alive for appearance's sake" the task brief
  says not to do.
- Every code path in `checkDmaForLocation()` that isn't the permanent-inconclusive path is dead
  given current upstream data (the `features.length` truthy branch cannot fire while
  `dma_status='A'` matches nothing statewide).

### Cheapest-viable-slice recommendation

1. **Remove** the live `checkDmaForLocation()` fetch/banner path from `dispatcher.js` and its
   `#dma-status` element from `dispatcher.html` (this is the actual code change — out of scope
   for this read-only doc, listed here for the follow-up ticket).
2. **Keep and promote** the static resource link
   (`dispatcher.html:1931-1938`, `#dma-map-link`), already coordinate-aware
   (`dispatcher.js:4716-4719`). Consider strengthening its label from "View PA Game Commission
   DMA Map" to something that doesn't reference the retired DMA concept, e.g. "Check PGC CWD
   Rules for This Area" — and confirm the linked WebAppBuilder view (`id=c9c7c8912356450fa77fc34d30b131fb`)
   still shows something relevant post-2026, or repoint it at the StoryMap / current CWD
   Interactive Map (`id=084308c67d524d14ad90dcb2232b0c01`, linked from PGC's live CWD page today)
   if the old viewer is itself stale. That link audit is a small, separate task.
3. **Do not build a WMU polygon lookup** as a replacement. It would cost a real implementation
   (repoint to `pgcmaps.pa.gov/.../MapServer/23`, parse `WMU_ID`, maintain a hand-curated
   WMU→rule-status table sourced from prose) for a feature that, per §3, does not fully answer
   the operational question and reintroduces an under-flagging risk in its own right.
4. If product direction later decides the WMU list is worth showing anyway (e.g. "this location
   is in WMU 4C, one of the WMUs where CWD has been found in wild deer — see PGC guidance"),
   that is defensible **only** if it is presented as informational context next to the link-out,
   **never** as a computed "clear" / "restricted" verdict, and only if the hand-curated WMU list
   carries a visible "as of [date], per PGC StoryMap" provenance note and a process for someone
   to notice when PGC updates that paragraph. That is a meaningfully bigger, ongoing-maintenance
   feature than today's fetch-and-render banner, and should be scoped and approved separately.

---

## 5. Fail-safe posture

For whatever is built (or removed), the posture must be:

- **No automated "clear" / "not restricted" state, ever**, for a disease-containment question,
  unless backed by a data source with a genuine, current, machine-checkable positive/negative
  signal. None exists today (§2). This is already the posture `8ebdcf9` established for the old
  DMA banner; it must not be relaxed by a WMU repoint that merely swaps one confident-sounding
  green state for another.
- **"Could not determine — check PGC" is the correct, acceptable terminal state**, exactly as
  the task brief states, and is what the cheapest-viable-slice (§4) delivers by construction: a
  link-out makes no claim at all, which is strictly safer than a banner whose only live branch is
  a fixed "inconclusive" message.
- **Under-flagging is the harm to design against.** A WMU-list-based "not in a listed WMU, so
  you're clear" message would be a new under-flagging risk given the statewide disposal rule
  (§3) — worse than today's already-neutered banner, because it would look more specific and
  thus more trustworthy while being just as unable to cover the statewide rule.
- Any future rendering of WMU identity (§4 item 4) must be labeled as **location context**, not
  **compliance status** — e.g. "You are in WMU 4C" is a fact this project can verify (§1); "CWD
  rules do/don't apply here" is not a fact this project can currently verify (§2) and must never
  be asserted.

---

## Evidence log

| Claim | Evidence |
| --- | --- |
| PGC WMU boundary layer exists, public, no auth | `GET pgcmaps.pa.gov/.../MapServer/23?f=json` → 200, fields incl. `WMU_ID` |
| That layer is CORS-open to arbitrary origins | `curl -H "Origin: https://example.github.io" ... MapServer/23?f=json` → `Access-Control-Allow-Origin: https://example.github.io` |
| Point-in-polygon query works on it | `MapServer/23/query?geometry=-77.5,40.8&...` → `WMU_ID: "4D"` |
| It's the same layer PGC's own WMU map app uses | `arcgis.com/sharing/rest/content/items/52d95dfa9b1644f88afc6c07a4f404f4/data` → Search widget source `url: "https://pgcmaps.pa.gov/.../MapServer/23"` |
| PASDA mirror also CORS-open | `curl -H "Origin: ..." mapservices.pasda.psu.edu/.../MapServer/1?f=json` → `access-control-allow-origin: https://example.github.io` |
| CWD FeatureServer (300/301/302) has no WMU field | `services1.arcgis.com/k8yxvICm95iIFicb/.../CWD/FeatureServer?f=json` → layer list, no WMU layer |
| PASDA's "CWD Management Units" layer is stale DMA data, not WMU data | `MapServer/11?f=json` (description says "DMAs"), `MapServer/11/query?where=1=1` → only DMA 2/3/4, 2020 vintage |
| StoryMap states DMAs retired, WMU-level management now in effect | `storymaps.arcgis.com/stories/ddfce74f89d24a91b116a84ddf126ac6` fetched live |
| 11 WMUs with wild CWD detections is prose-only | same StoryMap fetch, "wildlife management units (WMUs) where CWD has been detected..." paragraph |
| High-risk-parts disposal rule is now statewide, not DMA/WMU-scoped | same StoryMap fetch, "The following is prohibited within Pennsylvania: Disposal of high-risk parts..." |
| Stale Executive Order still linked from main CWD page | `pa.gov/agencies/pgc/wildlife/wildlife-health/wildlife-diseases/chronic-wasting-disease.html` fetched live, "Executive Order" link titled "cwd designation of dmas and endemic states..." |
| Current dispatcher DMA UI/logic reviewed | `docs/dispatcher.html:1931-1938,2059-2062`, `docs/assets/dispatcher.js:4330-4414,4716-4719` |
| Feature undocumented in user-facing manuals | grep for "DMA" / "CWD" / "Disease Management" in `docs/USER_MANUAL.md`, `docs/ADMIN_MANUAL.md` → no matches |

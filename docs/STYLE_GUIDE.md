# docs/ Style Guide

Living doc capturing chrome decisions shared across the static `docs/` pages
(`index.html`, `facilities.html`, `equipment-transfers.html`, `dispatcher.html`).
Pages are hand-authored static HTML — **no framework, no build step**.

## Local development

For local development, run: `cd docs && python3 -m http.server 8000` —
some browsers block `fetch()` of `file://` JSON, so the dispatcher page
needs to be served over HTTP to load `data/county_capacity.json`.

## Header / nav pattern

Two siblings exist in the repo:

- `index.html` uses a horizontal `.top-nav` strip + a hero band (marketing-style landing).
- `facilities.html` uses a sticky `.site-header` block with a "← Back to WIN home"
  link, a small logo, and a single-line title (tool-page style).

**Decision:** new internal tool pages (`dispatcher.html` and onward) follow the
**facilities.html tool-page header**: green-dark background, home-link, header-icon,
header-text. This keeps marketing chrome on `index.html` only.

## Color tokens

All pages share the same token set declared inline under `:root`:

| Token            | Use                                  |
|------------------|--------------------------------------|
| `--green-deep`   | Strongest accent, headings           |
| `--green-dark`   | Header background                    |
| `--green`        | Primary buttons, links               |
| `--green-light`  | Soft success / info backgrounds      |
| `--amber` / `--amber-light` | Warnings, marginal badges |
| `--red` / `--red-light`     | Emergency / closed status |
| `--bg`           | Page background (`#f5f2ec`)          |
| `--surface`      | Card background                      |
| `--border`       | 1px dividers                         |
| `--text-muted`   | Secondary copy                       |

When adding a new page, copy the token block verbatim — do **not** invent new
shades unless you also document them here.

## Card pattern

`.panel` wraps a logical block (white surface, 1px border, shadow, 10px radius).
`.cap-card` is the smaller capacity tile used on the dispatcher: same surface
treatment but with a min-height and uppercase eyebrow `.role` label.

## Marginal badge

Use the `.badge` class (amber pill) when a volunteer count is marginal
(`available <= resolved.marginal_threshold && total > 0`). The dispatcher
attaches/removes it on each render — keep this CSS-class-only, no
data-attribute toggling. The threshold itself is tunable per-county via
`docs/data/config.json` (see below).

## Config file (`docs/data/config.json`)

Single tunable file consumed by both `refresh_monday.py` (Python) and
`dispatcher.js` (browser). Defines global thresholds plus optional
per-county overrides. JSON has no comments, so the schema is documented
here and the shipped file carries a `_comment` key as a human note.

Schema:

- `marginal_threshold` (int): cards show the amber "Marginal" badge and
  the volunteer roster is included in the snapshot when
  `available <= marginal_threshold`. Default `1`.
- `escalate_to_game_commission.*_min_available` (int): Phase 3 will
  recommend calling PA Game Commission instead of dispatching when the
  available count for that bucket is `<` this number. Defined here, but
  **not consumed yet**.
- `county_overrides` (object, county-name → partial config): deep-merge
  override of any of the above, keyed by exact county name (must match
  `PA_COUNTIES`). Unknown county names log a warning and are ignored.

Resolution rule: start from the global keys; if `county_overrides[county]`
exists, overlay only the keys it specifies. Missing keys fall through.
Missing config file → baked-in defaults (all `1`). Malformed JSON → fail
loud (Python exits non-zero; the page shows an inline warning banner and
falls back to defaults).

Example override (raise the marginal warning to fire when 2 or fewer
volunteers are available in Bucks):

<!--
{
  "marginal_threshold": 1,
  "escalate_to_game_commission": {
    "ct_rvs_capture_min_available": 1,
    "ct_any_capture_min_available": 1,
    "courier_transport_min_available": 1
  },
  "county_overrides": {
    "Bucks":  { "marginal_threshold": 2 },
    "Forest": { "marginal_threshold": 0 }
  }
}
-->

(The block above is HTML-comment-wrapped because Markdown will otherwise
render it as a code block; copy the inner JSON into `config.json`.)

## Empty state

If a selected county has zero capacity in the snapshot, all three numbers show
`0 / 0` and a small italic `.empty-msg` below the cards explains it. **Never crash,
never throw a console warning** for legitimate empty data.

## Banner pattern

A horizontal pill at the top of `<main>` (or directly under the header) carries
status info: green-light for normal "Last refreshed: …", amber-light + `.warn`
modifier for degraded state ("Snapshot not available — run refresh_monday.py").

## Modal / output placeholder

Phase 2 ships a simple `.rec-output` div that toggles `.show` rather than a true
modal. Phase 3 keeps the same div approach (no `<dialog>`) but styles it as a
modal-card; see "Recommendation card" below.

## Recommendation card (Phase 3)

The Phase 3 decision engine renders into the existing `#rec-output` div as a
self-contained card with a Dismiss button. Action tone drives the top banner:

| Tone       | Class                | Background      | Accent border    |
|------------|----------------------|-----------------|------------------|
| `go`       | `.rec-action.go`       | `--green-light` | `--green`        |
| `escalate` | `.rec-action.escalate` | `--amber-light` | `--amber`        |
| `unknown`  | `.rec-action.unknown`  | `#ececec`       | `--text-light`   |

The marginal subsection (`.rec-marginal`) reuses the amber tokens. Each
entry is a single `<li>` rendering only the volunteer's `availability_note`
italicized in `--text-muted` — **volunteer names are never rendered** (and
are no longer in `data/county_capacity.json` as of Phase 4a). Missing notes
fall back to `<em>(no availability info)</em>`.

The reasoning subsection (`.rec-reasoning`) is an `<ol>` of short bullets
in **user-language only** (e.g. "Recommended: dispatch a C&T+RVS volunteer
via Connecteam."). No threshold math (`ct_rvs.available=N`) — removed in
Phase 4d. Zero-volunteer cases (including missing capacity) produce a
`call_pa_game_comm` action with friendly wording like "No RVS-capable C&T
volunteers currently available - call PA Game Commission."

A persistent `.finder-fallback-note` sits directly below the Get
Recommendation button and is **always visible**: "If no Volunteer contacts
FINDER within 2 hours FINDER should call PA Game Commission: (833) 742-4868
or (833) 742-9453" — plain text, no `tel:` links (FINDER dials, not dispatcher).

## What lives where

- Per-page CSS lives **inline in `<style>`** (matches existing pages).
- Per-page JS lives in `assets/<page>.js` (vanilla, IIFE, strict mode).
- Shared images live in `assets/` (currently just `winlogo.jpg`).
- Generated data lives in `data/` and is produced by `refresh_monday.py`.
  The browser must never call the Monday API directly.

## Feature status badges

Each feature has a maturity label as a pill (`.status-badge`) in its
`index.html` tool-card and a strip (`.status-strip`) under `.site-header` — update both plus the row below to promote.

| Feature             | Label          | Class           | Tone                             |
|---------------------|----------------|-----------------|----------------------------------|
| Equipment Transfers | `LIVE`         | `.live`         | `--green-light` / `--green-dark` |
| Facility Status     | `Beta Testing` | `.beta`         | `--amber-light` / `#7a4900`      |
| Dispatcher Action   | `Construction` | `.construction` | `--red-light` / `--red`          |

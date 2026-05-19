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
(`available <= 1 && total > 0`). The dispatcher attaches/removes it on each
render — keep this CSS-class-only, no data-attribute toggling.

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
modal. Phase 3 may upgrade this to a focus-trapped dialog — if it does, document
the new pattern here and refactor any other tool pages that adopt it.

## What lives where

- Per-page CSS lives **inline in `<style>`** (matches existing pages).
- Per-page JS lives in `assets/<page>.js` (vanilla, IIFE, strict mode).
- Shared images live in `assets/` (currently just `winlogo.jpg`).
- Generated data lives in `data/` and is produced by `refresh_monday.py`.
  The browser must never call the Monday API directly.

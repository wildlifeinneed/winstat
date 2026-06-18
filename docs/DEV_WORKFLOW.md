# Quick Reference — Dev Workflow (One-Pager)

**Goal:** Put a page under maintenance on production, work on it on dev, test it, ship it, bring it back.

**Prerequisites:** `dev` branch exists on origin; Cloudflare Pages project `winstat` is live at https://winstat-dev.pages.dev.

---

## The Five Pages (keys in `docs/assets/flags.js`)

| Page | Flag key | Production URL | Dev URL |
|------|----------|----------------|---------|
| Home | `page-index` | /index.html | /index.html |
| Dispatcher | `page-dispatcher` | /dispatcher.html | /dispatcher.html |
| Facilities | `page-facilities` | /facilities.html | /facilities.html |
| Equipment | `page-equipment` | /equipment-transfers.html | /equipment-transfers.html |
| Help | `page-help` | /help.html | /help.html |

---

## Quick Test (safe — only the flags file changes)

Put the dispatcher into maintenance on production, verify it, then bring it back immediately.

### 1. Take dispatcher down (one line change in `flags.js`)

```bash
cd /Users/P1/Projects/PA-Wildlife-Rehab
git checkout main
# Edit docs/assets/flags.js:
#   'page-dispatcher': { prod: 'maintenance', dev: 'live' }
git add docs/assets/flags.js
git commit -m "maintenance: dispatcher down for dev test"
git push origin main
```

Wait ~30 seconds, then open:  
https://wildlifeinneed.github.io/dispatcher.html

**Expected:** full page dimmed with banner **"Down for Maintenance, check back later."**

### 2. Verify the dev URL is unaffected

Open: https://winstat-dev.pages.dev/dispatcher.html

**Expected:** dispatcher renders normally (not dimmed), because `dev: 'live'`.

### 3. Bring it back up

```bash
git checkout main
git pull origin main
# Edit docs/assets/flags.js back:
#   'page-dispatcher': { prod: 'live', dev: 'live' }
git add docs/assets/flags.js
git commit -m "maintenance: dispatcher back live"
git push origin main
```

Wait ~30 seconds. Confirm https://wildlifeinneed.github.io/dispatcher.html is normal again.

---

## Real Dev Work (when you're changing code)

### 1. Take the page down on production

Same as Step 1 above. This prevents volunteers from using a broken page while you work.

### 2. Work on `dev`

```bash
git checkout dev
git pull origin dev
# ... make your changes ...
git add .
git commit -m "dev: <what you changed>"
git push origin dev
```

Test on https://winstat-dev.pages.dev/(page).html

### 3. Ship it

```bash
git checkout main
git pull origin main
git merge dev
git push origin main
```

### 4. Bring the page back up

Edit `flags.js`, set `prod: 'live'`, commit, push.

> **Important:** if you tested the **facilities submit form** on dev, it writes to the **live Google Sheet**. After testing, open that Sheet and delete any test rows so they don't appear on the public facilities page.

---

## Valid states

| State | Effect |
|-------|--------|
| `'live'` | Normal — no change |
| `'maintenance'` | Page dimmed, single banner at top — users know it's intentional |
| `'hidden'` | Page completely hidden |

If you typo a state, it defaults to `'live'` as a safety measure.

# Publishing Changes to GitHub

This site is hosted from the `docs/` folder of the GitHub repo
[`mjpierzga/winstats`](https://github.com/mjpierzga/winstats) on the `main` branch.
Any change pushed to `main` goes live automatically (GitHub Pages).

## 1. Open a terminal in the project folder

```
cd ~/Projects/PA-Wildlife-Rehab
```

> You do **not** need to specify the GitHub URL. This folder is already
> linked to `https://github.com/mjpierzga/winstats.git` (branch `main`).
> Confirm anytime with:
>
> ```
> git remote -v
> ```

## 2. See what you changed

```
git status
```

This lists files you've modified (e.g. `docs/index.html`).

Optional — see the actual edits:

```
git diff
```

## 3. Stage your changes

Stage everything that's changed:

```
git add -A
```

Or stage a specific file:

```
git add docs/index.html
```

## 4. Commit with a short message

```
git commit -m "Describe what you changed"
```

Examples:
- `git commit -m "Show equipment list first on home page"`
- `git commit -m "Update Adams County contact info"`
- `git commit -m "Refresh facilities CSV"`

## 5. Push to GitHub

```
git push
```

That's it. Within a minute or two the live site will reflect your changes.

---

## Quick one-liner (after you've reviewed `git status`)

```
git add -A && git commit -m "Your message here" && git push
```

---

## Updating the facilities data

If you re-run the data refresh:

```
python3 refresh_facilities.py
```

Then commit and push the updated CSV the same way:

```
git add pa_wildlife_rehab_facilities.csv
git commit -m "Refresh facilities data"
git push
```

---

## Wildlife Dispatcher operations

The dispatcher page (`docs/dispatcher.html`, live at
<https://mjpierzga.github.io/winstats/dispatcher.html>) reads two static files
from `docs/data/`:

- `county_capacity.json` — snapshot of volunteer capacity per county (refreshed
  from Monday).
- `config.json` — escalation thresholds and per-county overrides.

Both are plain files served by GitHub Pages, so any change goes live the same
way as the rest of the site: commit and push.

### Refresh playbook (volunteer capacity)

**When to run it:** after a Connecteam → Monday import, or any time volunteer
rosters / availability change on Monday board `9092079933`.

**How to run it** — copy-paste in a terminal:

```
cd ~/Projects/PA-Wildlife-Rehab
python3 refresh_monday.py --if-stale
git add docs/data/county_capacity.json
git commit -m "Refresh capacity snapshot"
git push
```

**What `--if-stale` does:** it checks the `VolDB_Status` tracker board's
`Last_Updated` timestamp against the local sidecar file
`docs/data/.last_remote_update`. If the remote is newer, it does a full Monday
pull and rewrites `county_capacity.json`; if not, it exits without hitting the
Monday API. To force a refresh regardless, drop the flag:

```
python3 refresh_monday.py
```

**How to confirm the new JSON went live:**

1. Wait 1–2 minutes after `git push`.
2. Open <https://mjpierzga.github.io/winstats/dispatcher.html> in an incognito
   / private window (bypasses cache).
3. Pick a county you know changed, click **Get Recommendation**, and check
   that the marginal-roster card's `availability_note` text reflects the new
   data.

### Automatic daily refresh (GitHub Actions)

A scheduled workflow at `.github/workflows/refresh.yml` runs
`refresh_monday.py --if-stale` once a day on GitHub's servers, so you don't
have to remember to do it from your Mac. If the Monday `VolDB_Status` tracker
hasn't moved, the workflow exits quietly without committing anything; if it
has, the bot user `wildlife-dispatcher-bot` commits the new
`docs/data/county_capacity.json` (and `.last_remote_update`) straight to
`main` and GitHub Pages picks it up within a minute or two.

**When it runs:** every day at **10:00 UTC** — that's 6:00 AM Eastern during
EDT (March–November) and 5:00 AM Eastern during EST. GitHub cron is UTC-only,
so the local hour drifts by one across the daylight-saving boundary.

**One-time setup (you have to do this in the GitHub web UI):**

1. Go to <https://github.com/mjpierzga/winstats> → **Settings** → **Secrets
   and variables** → **Actions** → **New repository secret**.
2. Name: `MONDAY_TOKEN`. Value: paste the same token string from your local
   `.monday_token` file (the one that starts with `eyJ…`).
3. Save. Until this secret exists, the workflow will fail every morning with
   an auth error and GitHub will email you about it.

**Run it on demand:** GitHub repo → **Actions** tab → **Refresh wildlife
capacity snapshot** (left sidebar) → **Run workflow** button → pick `main` →
**Run workflow**. Takes ~30 seconds.

**See what it did:** same Actions tab → click the most recent run → expand
the **Refresh capacity snapshot** and **Commit + push if changed** steps to
read the logs. If a run failed, GitHub emails the repo owner by default.

**Pause it:** comment out (or delete) the `schedule:` block in
`.github/workflows/refresh.yml`. The `workflow_dispatch:` button still works
for manual runs, and the Mac playbook above still works for instant
refreshes any time.

### Threshold tuning (when to escalate to PA Game Commission)

The dispatcher decides whether to recommend a Connecteam task or escalate to
PA Game Commission based on thresholds in `docs/data/config.json`.

**Global thresholds** live under `escalate_to_game_commission`. Current
values:

```json
"escalate_to_game_commission": {
  "ct_rvs_capture_min_available": 1,
  "ct_any_capture_min_available": 1,
  "courier_transport_min_available": 1
}
```

- `ct_rvs_capture_min_available` — minimum available RVS-certified volunteers
  needed before the dispatcher will recommend an RVS capture task. Below this,
  it escalates.
- `ct_any_capture_min_available` — minimum combined (RVS + non-RVS) volunteers
  needed for a non-RVS capture task.
- `courier_transport_min_available` — minimum available couriers needed before
  recommending a transport task.

**Per-county overrides** live under `county_overrides`. Each county key
deep-merges over the global defaults. Current overrides:

```json
"county_overrides": {
  "Bucks":  { "marginal_threshold": 3 },
  "Centre": { "ct_rvs_capture_min_available": 2 }
}
```

To override an escalation threshold for a specific county, nest it under
`escalate_to_game_commission`, e.g.:

```json
"county_overrides": {
  "Bucks": {
    "escalate_to_game_commission": {
      "courier_transport_min_available": 2
    }
  }
}
```

**Workflow:**

```
# edit docs/data/config.json in your editor of choice
git add docs/data/config.json
git commit -m "Tune dispatcher thresholds"
git push
```

No refresh script is needed — `config.json` is a static file the dispatcher
fetches on page load.

**Rule of thumb:** raise the number to escalate to PA Game Commission **more
often** (you want their involvement at a higher capacity floor); lower the
number to escalate **less often**.

### Developer note — flat vs nested threshold keys

A small wiring detail for anyone touching the dispatcher code:

- `decision.js` (`recommend()`) consumes **flat** threshold keys:
  `ct_rvs_capture_min_available`, `ct_any_capture_min_available`,
  `courier_transport_min_available`.
- `config.json` stores those same keys **nested** under
  `escalate_to_game_commission`.
- `dispatcher.js`'s `resolveForCounty()` flattens nested → flat (and applies
  per-county overrides) before handing the resolved config to `recommend()`.

If you add a new threshold, you must: (a) add it to `config.json` under
`escalate_to_game_commission`, (b) update `resolveForCounty()` in
`docs/assets/dispatcher.js` to flatten it, and (c) consume the flat key in
`docs/assets/decision.js`.

### PII discipline reminder

> The `availability_note` text on Monday board volunteer rows flows **verbatim**
> to the public GitHub Pages site via `county_capacity.json`. **Never** put a
> volunteer's name, phone number, address, email, or other identifying info in
> the availability text field on Monday. Counts and anonymous availability
> schedules (e.g. "weekday evenings only") are fine; identifying info is not.

---

## Troubleshooting

- **`git push` asks for a password** — GitHub no longer accepts passwords. Use a
  Personal Access Token (https://github.com/settings/tokens) as the password,
  or set up the GitHub CLI: `gh auth login`.
- **"Your branch is behind 'origin/main'"** — pull first: `git pull`, then push.
- **Pushed but site didn't update** — wait 1–2 minutes, then hard-refresh the
  browser (Cmd+Shift+R on Mac).
- **Want to undo local changes before committing** — `git restore <file>`
  (this throws away your edits to that file).

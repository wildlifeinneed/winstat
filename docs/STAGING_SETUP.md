# Staging (Dev Preview) Setup — Cloudflare Pages

This guide sets up a **dev preview website** so you can test changes safely before
they go live on the public site.

- **Production (do NOT touch):** GitHub Pages — `https://wildlifeinneed.github.io`
- **Dev preview (what we are creating):** Cloudflare Pages — `https://<project>.pages.dev`
- **Backend (shared, do NOT duplicate):** the existing Worker `pa-wildlife-dispatcher`

The dev preview deploys the **`dev` branch** of the repo `wildlifeinneed/winstat`.
The `dev` branch already exists on GitHub (created for this purpose), so Cloudflare
has something to deploy.

> **One Worker only.** Do **not** create a second Worker. The dev site reuses the
> existing `pa-wildlife-dispatcher` Worker. The Worker already allows requests from
> any `*.pages.dev` address (see step 6), so the address lookup will just work.

---

## Before you start

You will be logged into Cloudflare as:

- **Login email:** `wildlifeinneed111@gmail.com`
- **Account name:** `Wildlife In Need`
- **Account id:** `290463cfd0bc273076e8c62678f7c845`

Open a browser, go to **https://dash.cloudflare.com**, and sign in with that email.

---

## Step 1 — Open Workers & Pages and start a Pages project

1. After logging in, look at the **left sidebar**.
2. Click **Workers & Pages**.
3. Click the blue **Create** button (top right of that page).
4. You will see tabs/options at the top. Click the **Pages** tab.
5. Under Pages, click **Connect to Git**.
   - (If Cloudflare asks you to authorize/connect your GitHub account first, click
     **Connect GitHub**, sign in to GitHub if prompted, and **Authorize Cloudflare
     Pages**. Grant it access to the `wildlifeinneed` organization / `winstat`
     repository.)
6. In the repository list, find and **select `wildlifeinneed/winstat`**.
7. Click **Begin setup**.

---

## Step 2 — CRITICAL: set the production branch to `dev` (NOT main)

On the "Set up builds and deployments" screen:

1. Find the field labeled **Production branch** (sometimes shown as a dropdown).
2. Change it from `main` to **`dev`**.

> **Why this matters (one line):** GitHub Pages already serves `main` as the public
> site — pointing Cloudflare at `dev` keeps the preview separate so it never
> competes with or overwrites production.

Double-check this says **`dev`** before continuing. This is the single most
important setting in this guide.

---

## Step 3 — Build settings (static site, NO build step)

This site is plain HTML/CSS/JS served from the `docs/` folder. There is **no build
step**. Set the build configuration exactly like this:

| Field                      | What to enter                          |
| -------------------------- | -------------------------------------- |
| **Framework preset**       | **None**                               |
| **Build command**          | *(leave empty — type nothing)*         |
| **Build output directory** | **`docs`**                             |

- **Framework preset:** click the dropdown and choose **None**.
- **Build command:** clear it / leave it blank.
- **Build output directory:** type `docs` (no slash, no quotes).

> The web root is the repo's `docs/` folder — that is where `index.html` and the
> other pages live. Setting the output directory to `docs` tells Cloudflare to
> publish the contents of that folder as-is.

---

## Step 4 — Project name and the resulting URL

1. Near the top of the setup screen there is a **Project name** field.
2. Suggested name: **`winstat-dev`**.
3. The public preview URL will be the project name followed by `.pages.dev`:

   ```
   https://winstat-dev.pages.dev
   ```

> **Must end in `.pages.dev`.** The flag system detects the dev environment purely
> from the hostname: any address ending in `.pages.dev` is treated as **dev**, and
> everything else (including `wildlifeinneed.github.io`) is treated as **prod**.
> Keeping the default `*.pages.dev` URL is what makes the dev/maintenance flags
> behave correctly. Do not add a custom domain.

When everything looks right (Production branch = `dev`, Framework preset = None,
Build command empty, Output directory = `docs`), click **Save and Deploy**.

---

## Step 5 — First deploy: what success looks like

1. Cloudflare shows a deployment log. Because there is no build step, it should
   finish quickly (usually under a minute).
2. Wait until you see **Success** / a green checkmark and the message that your
   site is live, with a clickable URL.
3. Open the live URL — for the suggested name:

   ```
   https://winstat-dev.pages.dev
   ```

4. **Confirm all 5 pages load** by opening each of these (replace `winstat-dev`
   if you chose a different project name):

   - Home: `https://winstat-dev.pages.dev/index.html`
     (or just `https://winstat-dev.pages.dev/`)
   - Dispatcher: `https://winstat-dev.pages.dev/dispatcher.html`
   - Facilities: `https://winstat-dev.pages.dev/facilities.html`
   - Equipment Transfers: `https://winstat-dev.pages.dev/equipment-transfers.html`
   - Help: `https://winstat-dev.pages.dev/help.html`

   Each page should render normally. On the **Dispatcher** page, try an address
   lookup — if it returns results, the shared Worker connection is working from the
   dev site (see step 6).

---

## Step 6 — The Worker already allows the dev site (no surprise needed)

You do **not** need to change anything on the Worker. The existing
`pa-wildlife-dispatcher` Worker's CORS allowlist already includes
`https://*.pages.dev`, so requests from `https://winstat-dev.pages.dev` (or any
`.pages.dev` URL) are accepted automatically. The dispatcher address lookup will
work on the dev URL with no further changes.

---

## Step 7 — Daily workflow recap

Use this loop whenever you want to take a page down for maintenance on the public
(production) site, test the change on dev first, then ship it.

1. **Put a whole PAGE under maintenance on production:**
   Edit `docs/assets/flags.js`. Find the page's line in the `PAGES` list and set
   its **`prod`** value to `'maintenance'`. There is **one key per page** — you no
   longer flip several panels to take a page down. The five page keys are:

   ```js
   var PAGES = {
     'page-index':      { prod: 'live', dev: 'live' }, // index.html (home)
     'page-dispatcher': { prod: 'live', dev: 'live' }, // dispatcher.html
     'page-facilities': { prod: 'live', dev: 'live' }, // facilities.html
     'page-equipment':  { prod: 'live', dev: 'live' }, // equipment-transfers.html
     'page-help':       { prod: 'live', dev: 'live' }, // help.html
   };
   ```

   For example, to take the **whole dispatcher page** down on production but keep
   it live on the dev preview:

   ```js
   'page-dispatcher': { prod: 'maintenance', dev: 'live' },
   ```

   This dims the entire page and shows **one** "Down for Maintenance, check back
   later." banner at the top. (Valid states are `'live'`, `'maintenance'`, and
   `'hidden'`. Default everywhere is `'live'`.)

   > **Optional — finer-grained sub-panel control (dormant by default):** If you
   > ever need to flag a single section instead of a whole page, the per-panel
   > keys still exist in the `SUB_PANELS` list (e.g. `'facilities-grid'`,
   > `'dispatcher-map-panel'`). They are **dormant**: they only take effect on a
   > page that has **no** page-level `data-panel-key="page-…"` wrapper. To use
   > sub-panel mode for a page, remove that page's `data-panel-key="page-…"`
   > attribute from its `<body>` (or delete its entry from `PAGES`) and set the
   > individual `SUB_PANELS` keys. For routine maintenance, prefer the page-level
   > keys above.

2. **Commit the flag change to `main`** (this is what production serves).

3. **Build / test on the dev URL:** push your work to the `dev` branch, let
   Cloudflare auto-deploy, then open `https://winstat-dev.pages.dev` and verify the
   panels behave the way you expect on the dev preview.

4. **Ship it:** merge `dev` -> `main` once you're happy. GitHub Pages will publish
   the updated production site.

5. **When done with maintenance,** edit `docs/assets/flags.js` again and set that
   panel's `prod` value back to `'live'`, then commit to `main`.

> **Important — clean up test data:** If you tested the **facilities submit form** on
> the dev site, it writes to the **same live Google Sheet** as production. After
> testing, open that Google Sheet and **delete any test rows you added** so they do
> not appear on the public facilities list.

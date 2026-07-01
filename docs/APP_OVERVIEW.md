# Wildlife Dispatcher — App Overview

*A plain-language introduction for board members, partner organizations, and
funders. This is the "what is this and why does it exist" document. It is not a
how-to (see `USER_MANUAL.md`) and not a maintainer guide (see `ADMIN_MANUAL.md`).*

---

## 1. The problem this solves

Wildlife In Need PA fields calls about wild animals in trouble — an injured hawk
on a roadside, an orphaned litter of raccoons, a deer that needs to be moved. A
**dispatcher** takes that call and has to make fast decisions, usually while the
caller is still on the line:

- **Who is nearby?** Which Wildlife In Need volunteers are close enough to the
  animal to actually help?
- **What can each of them do?** Volunteers are qualified for different roles:
  - **C&T** — Capture & Transport (catch and contain the animal).
  - **RVS C&T** — Capture & Transport for **Rabies Vector Species**, which
    require a specially qualified volunteer.
  - **Courier** — transport-only (moving an animal that is already contained).
- **Where is the nearest licensed rehabber?** Once an animal is in hand, it has
  to go somewhere qualified to take it.
- **Who do I call if no volunteer is available?** The PA Game Commission is the
  fallback, and each region has a WIN area coordinator who oversees it.

Before this app, answering those questions meant juggling spreadsheets, maps,
and phone lists under time pressure. The Dispatcher Console answers all of them
**on one screen**.

---

## 2. What the app is

The Dispatcher Console is a single web page used internally by WIN dispatchers.
It does **one job**: take a few facts about an animal and an emergency, and tell
the dispatcher **who to dispatch** or **what action to take**.

Importantly, the app is **advisory**. It does not call anyone, it does not
assign tasks automatically, and it does not change any volunteer's schedule. It
produces a recommendation; a human dispatcher acts on it.

---

## 3. How it works (conceptually)

The dispatcher starts by setting two facts about the animal that apply no matter
how they search:

1. **Is this a Rabies Vector Species (RVS) animal?** (Yes / No)
2. **What is the issue — Capture or Transport?**

These two choices steer the whole recommendation, because they determine which
kind of volunteer is actually qualified to respond.

Then the dispatcher picks one of **two ways to search**, depending on what
information the caller gave them:

### A. By County

When the dispatcher knows the county, they pick it from a list. The app
immediately shows, for that county:

- Three **capacity cards** — **C&T**, **RVS C&T**, and **Courier** — each showing
  how many volunteers are **available out of the total** (for example,
  "2 / 5 available").
- The **WIN area coordinator** for that county, by name (who oversees the region).
- Each WIN area displayed in a **distinct color** for easy visual identification.
- A **"Get Recommendation"** button that produces a clear, color-coded action:
  - **Dispatch via Connecteam** (green) — there is a qualified, available
    volunteer; send them the task through Connecteam (WIN's volunteer app).
  - **Outside Referral** — county policy says do not dispatch; the recommendation
    shows referral targets with name, phone, and notes.
  - **Call PA Game Commission** (amber) — no qualified volunteer is available;
    the finder should call the Game Commission.
  - **Escalate to supervisor** (grey) — there wasn't enough information to decide.
- A short **reasoning** list explaining *why* the app chose that action.
- County-specific **special notes** shown as a blue banner when set by an admin.

If a county looks thin on volunteers, the app offers to **widen the search** by
switching to address mode.

#### Cross-posting to neighboring areas

When the recommendation is to dispatch, the dispatcher can **check for cross
posting** — entering the animal's address to see if volunteers in neighboring WIN
areas could also help. The tool calculates distances to nearby area boundaries,
shows suggested areas sorted closest-first, and displays a map with volunteers
and rehabbers from both the dispatch area and suggested areas.

### B. By Animal Address + Radius

When the dispatcher has the animal's street address, they type it in (with
type-ahead address suggestions) and set a **search radius** in miles (default 20,
maximum 100). The app then shows:

- **Volunteers in range** — a total count within the radius, including volunteers
  not on Connecteam (labeled separately so the dispatcher knows to contact them
  directly).
- The same three **capacity cards** (C&T / RVS C&T / Courier), counted within range.
- **WIN areas covered** — which WIN regions fall inside the radius.
- An optional **out-of-county helpers** list — nearby volunteers just outside the
  animal's own county, each tagged **Qualified** or **Not qualified** for *this*
  specific animal, nearest first.
- **Recommended Actions** — informational and directive lines (volunteers found,
  which coordinators to notify, and whether to dispatch or escalate).
- An interactive **map** with a dynamic legend, availability toggle, fullscreen
  mode, and distance scale bar.

### The nearest-rehabber panel (on demand)

In address mode, the app can also show the **nearest licensed rehabbers** — but
only when the dispatcher asks for it, via a "Show nearest rehabbers" button. When
revealed, it lists up to the **three closest** rehabbers with name, distance,
county, phone (a tap-to-call link), the rehabber's own availability note, and a
website link when one is on file.

---

## 4. Policy Editor

The **Policy Editor** lets WIN admins configure per-county dispatch policies
through a web interface — no code or file editing required.

- **Admin login gate** — editing is locked until the admin authenticates with a
  shared password.
- **Per-county configuration** — for each county, admins can set the dispatch mode
  (dispatch all, dispatch with exceptions, or refer all calls), specify referral
  targets (from a rehabber dropdown or custom entries), and add special notes.
- **Live preview** — shows what the dispatcher would see for three scenarios
  (Capture, Transport, RVS Capture) based on current settings.
- **Volunteer info** — read-only panel showing volunteer counts by role, area
  breakdown, and unavailability details.
- **Version history** — every save creates a snapshot; admins can view diffs,
  restore previous versions, and print any version.
- **In-app save** — policies are saved directly to the Cloudflare Worker's KV
  store, taking effect immediately.

---

## 5. Where the data comes from

All the people-and-place data behind the app originates in **Monday.com**, WIN's
operational database. Four Monday boards feed the app:

- **Volunteers** (the Connecteam roster) — who can do what, and where they live.
- **Rehabbers** — licensed rehabilitation facilities. This data ultimately traces
  back to **pawr.com**, the upstream source of record.
- **Area Coordinators** — the WIN area each region belongs to and the
  coordinator's name.

The app does not talk to Monday.com live. Instead, the data is **refreshed on
demand**: an editor bumps a small "last updated" marker (a **sentinel**) in
Monday, and the next refresh pulls fresh data and republishes it. Most days
nothing changes, so the refresh simply sees "no update needed" and does nothing —
this keeps the expensive data pulls rare and predictable.

### Automated data integrity

The data pipeline includes several automated safeguards:

- **Geocoding fallback** — volunteer addresses are geocoded using the US Census
  API, with automatic fallback to Nominatim (OpenStreetMap) when Census fails.
- **Geocode failure tracking** — when addresses cannot be geocoded, a GitHub Issue
  is automatically created with the failure details.
- **Facility sync** — a weekly automated check compares the local rehabber dataset
  against pawr.com and creates a GitHub Issue when discrepancies are found.
- **Record integrity validation** — every refresh validates that volunteer data is
  internally consistent before publishing; bad data is never pushed live.

---

## 6. Privacy by design

Volunteer **home addresses are personal information (PII)**, and the app is built
so that this information **never reaches the public web**.

- Volunteer locations live only in a **private backend** — a Cloudflare Worker
  backed by private storage. When the dispatcher searches by address, the browser
  asks this private backend "how many qualified volunteers are within X miles?"
  and the backend answers with **aggregate counts only** — totals by role and by
  WIN area. It **never** returns an individual volunteer's location, name, address,
  or phone, even in error messages.
- The public website only ever sees those aggregate numbers. There is no way for
  a member of the public — or even the dispatcher's own browser — to see where any
  individual volunteer lives.
- The volunteer coordinate data derived from home addresses is stripped down to
  just location/role/area, is never committed to the public site, and is pushed
  only into the private backend.
- **Rehabber and coordinator data is public-safe** by contrast (facilities and
  coordinator names are meant to be shared), so that information is handled
  normally. Even there, coordinator and volunteer **phone numbers are kept out**
  of anything published publicly.

In short: the app is split into a **public face** that only ever knows aggregate
counts, and a **private core** that holds the sensitive location data and never
exposes it.

---

## 7. Technical architecture

The system has four main components:

- **Static front-end** — HTML/CSS/JS served by GitHub Pages from the `docs/`
  folder. No build step; changes go live on `git push`.
- **Cloudflare Worker** — a serverless backend that handles volunteer radius
  searches, address autocomplete, driving distance calculations, and policy
  management. Deployed at
  `https://pa-wildlife-dispatcher.winstat.workers.dev`.
- **Data pipeline** — Python scripts (`refresh_monday.py`, `geocoder.py`,
  `check_pawr.py`) that pull data from Monday.com and pawr.com, geocode addresses,
  validate records, and publish results.
- **GitHub Actions** — automated workflows for daily data refresh and weekly
  facility sync, with built-in notifications for failures and discrepancies.

---

## 8. Current status & caveats

A few honest limitations matter for anyone evaluating the app:

- **Rehabber OPEN/CLOSED status is not shown.** The app lists nearby rehabbers but
  does **not** indicate whether each one is currently accepting animals. That
  open/closed information is **not maintained in this app's data** — it is owned by
  a **separate "rehab status" app**. A dispatcher should always confirm
  before sending an animal.
- **Availability notes are shown verbatim** from the source data and may be out of
  date — treat them as hints, not guarantees.

When in doubt, the dispatcher falls back to calling the **PA Game Commission**,
whose dispatch line the app keeps on screen at all times.

---

## 9. In one sentence

The Wildlife Dispatcher Console turns a chaotic emergency phone call into a single
screen that tells a WIN dispatcher who can help, what they're qualified to do,
where the nearest rehabber is, and who to call next — while keeping every
volunteer's home address private.

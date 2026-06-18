# WIN Volunteer Tools — User Manual

This guide is for **WIN volunteers, dispatchers, and coordinators** using the live
tools on the WIN help site. It covers what each page does, what the information
means, and what to expect from the current version of the tools.

These tools are **decision aids**. They do not place calls, assign work, or update
Connecteam for you. A volunteer or dispatcher still makes the final call.

---

## 1. Home page

The home page is the starting point for the current WIN tools.

It includes:

- the **wildlife emergency hotline**
- a short **About WIN** section
- contact information
- three tool cards:
  - **Equipment Transfers**
  - **Dispatch Helper**
  - **Rehab Facility Status**

Each tool card has a status badge such as **LIVE** or **Beta Testing**.

If a tool is temporarily unavailable, its card may appear **dimmed**. If you open a
page that is unavailable, you may see a **Down for Maintenance, check back later.**
banner.

---

## 2. Dispatch Helper

Use the Dispatch Helper when you need to decide **who should respond** to a wildlife
call or what fallback action to take.

### Set these two facts first

At the top of the page, choose:

1. **RVS Animal?** — **Yes** or **No**
2. **Issue** — **Capture** or **Transport**

These choices affect every lookup and recommendation.

- **Capture** means the animal needs to be safely contained or caught.
- **Transport** means the animal mainly needs a ride or handoff.
- For transport, **couriers are preferred**, but C&T volunteers can also appear as
  transport-capable help.

### Choose a lookup mode

The page has two lookup modes:

- **By County**
- **By Animal Address**

Use the one that matches the information you have from the caller.

---

## 3. Dispatch Helper — By County

Use **By County** when you know the county but do not have a usable street address.

### What you see

After choosing a county, the page shows:

- a county badge such as **County · Area number**
- three volunteer cards:
  - **C&T**
  - **RVS C&T**
  - **Courier**
- each card shows **available out of total**
- a coordinator line for that WIN area, when one is on file

The county cards are based on the **WIN area pool** tied to that county, so the
subtext may show an area breakdown across more than one county.

### Getting a recommendation

Click **Get Recommendation**.

The recommendation may tell you to:

- **dispatch through Connecteam**
- use a **courier**
- use an available **C&T / RVS C&T** volunteer
- or tell the finder to call **PA Game Commission**

If capacity is very low, the result may show a **Marginal** badge and list the
stored availability notes for those volunteers. Those notes are meant to help you
judge whether someone is likely usable, but they may be out of date.

### Thin county handoff

If the county looks thin, the page may show:

**Thin in this county? → Widen search → enter address + radius**

That button switches you into address mode so you can search by a real location.

---

## 4. Dispatch Helper — By Animal Address

Use **By Animal Address** when you have the animal’s location and want a more exact
search.

### How it works

1. Enter the animal address.
2. Pick a suggestion if one appears.
3. Set the **Search Radius (miles)**.
4. Click **Find Help Nearby**.

The page uses an address lookup service and does **not** store the entered address.

### What the results mean

Address results can show:

- **Volunteers in range**
- the same three role cards:
  - **C&T**
  - **RVS C&T**
  - **Courier**
- **WIN areas covered**
- a resolved location line showing the animal’s county and WIN area, when available
- **Recommended Actions**
- a list of **qualified volunteers within the selected radius**
- an on-demand **nearest rehabbers** section
- an optional **map**

### Qualified volunteer list

The helper list in address mode shows **qualified volunteers only** for the animal
you described. Each line may show:

- role badges
- distance from the animal
- WIN area
- county
- an availability note, if one exists

Some volunteer rows may appear dimmed when the person’s availability note suggests
they are not currently available.

If the search radius is very broad, the page may show only the nearest results and
tell you to narrow the radius for a complete list.

### Driving distances

When available, the tool uses **real driving distance and travel time** for helpers
and rehabbers.

You may see either:

- **`X.X mi driving / ~Y min`** in the list views, or
- **`X.X miles / Y min`** in map popups

If live driving time is not available, the map falls back to an estimate:

- **`X.X miles / ~Y min (est.)`**

### Map

The address results can include a **Show map / Hide map** toggle.

The inline map shows three marker types:

- **animal location** — red diamond
- **rehabbers** — blue markers
- **volunteers** — amber markers

Volunteer markers are shown at the **center of the volunteer’s home county**, not
at an exact address. This is intentional for privacy.

The map includes a legend and is meant for quick orientation, not for exact routing.

### Nearest rehabbers

The rehabber list stays hidden until you click **Show nearest rehabbers**.

When opened, it shows up to the **three closest rehabbers** and may include:

- name
- county
- phone
- stored availability note
- website
- distance from the animal

If live driving data is available, the rehabber list is re-ranked by **road
distance**, not just straight-line distance.

---

## 5. Stale results

If you change **RVS Animal?** or **Issue** after a result is already on the page,
the tool does **not** silently recalculate.

Instead it:

- dims the old result
- shows a warning that inputs changed
- asks you to run the lookup again

Re-run by clicking:

- **Get Recommendation** in county mode, or
- **Find Help Nearby** in address mode

In address mode, making the result stale also collapses the rehabber panel so you
do not keep using stale supporting information.

---

## 6. Rehab Facility Status

Use this page to quickly check which licensed wildlife facilities may be accepting
animals.

### Important reminder

At the top of the page there is an advisory banner:

> This volunteer-maintained status may be out of date — always contact the facility
> directly to confirm before bringing an animal in for care.

Treat the page as a **guide**, not a guarantee.

### What the data comes from

This page combines two sources at read time:

- **base facility details** from the WIN/Monday facility dataset
- **status and alert details** from a published Google Sheet

That means contact details and status notes may come from different sources that are
joined together when the page loads.

### What you can do on this page

You can:

- search by **facility name**, **county**, or **alert text**
- filter by **county**
- filter by status:
  - **Open**
  - **Limited**
  - **Closed**
  - **Call**
- open the **Animal code legend**
- expand any facility card for details

Each facility card may show:

- facility name
- county
- animal code tags
- status badge
- last updated date
- alert text
- address and map link
- phone number
- website
- contact person
- expected reopen date

### Animal codes

The legend explains the species shorthand used on cards:

- **M** — Mammals
- **P** — Passerines / Songbirds
- **R** — Raptors
- **RVS** — Rabies Vector Species
- **END** — Endangered / Threatened
- **RA** — Reptiles & Amphibians

The codes are visible on the page, but there is **not currently a dedicated species
filter button**. Use the legend and card details when checking fit.

### Status meanings

- **Open** — currently shown as accepting
- **Limited** — only some species or situations are being accepted
- **Closed** — not currently taking animals
- **Call** — call first for clarification

Always call before transport.

---

## 7. Equipment Transfers

Use this page to review the shared equipment transfer log.

### What it does

This page loads the live transfer sheet and shows a sortable table of transfer
records.

You can:

- search across the table
- filter by:
  - **All**
  - **Operational**
  - **Not Operational**
- sort by clicking any column header
- use mobile sort controls on smaller screens
- click any row to open a detail view

### What appears in the table

Columns may include:

- submission date
- ID
- equipment
- transfer from
- transfer to
- reason
- operational status
- transfer date
- remarks
- submitted by
- other type

The page also shows a **Last refreshed** time after loading.

---

## 8. PA Game Commission fallback

The Dispatch Helper keeps the PA Game Commission fallback in view:

**(833) 742-4868 or (833) 742-9453**

Use that number when the tool tells you there is no qualified WIN help available,
or when you need to escalate beyond WIN’s volunteer response.

---

## 9. Practical reminders

- Use the **home page** to check which tools are live before you start.
- In the **Dispatch Helper**, county mode is faster, but address mode is more exact.
- In address mode, the map is a **visual aid**, not an exact volunteer location map.
- In **Facility Status**, always call ahead even if a facility appears open.
- In **Equipment Transfers**, click a row for the full details instead of relying on
  the shortened table view.

If something looks wrong or incomplete, treat the app as a guide and confirm by
phone or through the usual WIN communication channels.

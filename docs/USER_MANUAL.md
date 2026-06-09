# Dispatcher Console — User Manual

This is the guide for dispatchers who operate the Wildlife In Need PA Dispatcher
Console. It explains, step by step, how to take a wildlife report and route it to
the right volunteer or action.

> Status: this is a preview ("Under Construction") build. Read the **Beta caveats**
> section at the end before you rely on anything here.

---

## 1. What the console is for

When someone reports a wild animal in trouble, your job is to get the right help to
that animal. The console does one thing: it takes a few facts about the animal and
tells you **who to dispatch** or **what action to take** (for example, send a
volunteer through Connecteam, or call the PA Game Commission).

It does **not** call anyone for you and it does **not** change any volunteer's
schedule. It gives you a recommendation; you act on it.

---

## 2. Two facts you always set first (top of the page)

At the very top of the page there is a shared block you fill in **before** choosing
a lookup mode. These two facts apply to both lookup modes.

1. **RVS Animal?** — Choose **Yes** or **No**.
   - "RVS" means the animal needs a Rabies Vector Species qualified volunteer
     (an RVS C&T volunteer). Default is **No**.
2. **Issue** — Choose **Capture** or **Transport**. Default is **Capture**.
   - **Capture** = the animal needs to be caught / contained ("C&T" = Capture &
     Transport).
   - **Transport** = the animal mainly needs to be moved (couriers are preferred,
     but C&T volunteers can also do transport runs).

These choices change the recommendation, so set them correctly first. If you change
them **after** results are already on screen, see **Section 6 — Stale results**.

---

## 3. Choosing a lookup mode

Below the two facts is a toggle with two modes:

- **By County** — you know the county; pick it from a list.
- **By Animal Address** — you have the animal's street address; the console finds
  volunteers within a radius of that address.

Pick whichever matches the information you have.

---

## 4. COUNTY mode — step by step

Use this when you know the county the animal is in.

1. Set **RVS Animal?** and **Issue** at the top of the page (Section 2).
2. Make sure **By County** is selected.
3. Pick the county from the **County** dropdown.
4. Three **capacity cards** appear for that county:
   - **C&T** — non-RVS Capture & Transport volunteers.
   - **RVS C&T** — RVS-qualified Capture & Transport volunteers.
   - **Courier** — transport-only volunteers.
   Each card shows **available / total** (for example, `2 / 5 available`).
5. A **coordinator line** appears showing the WIN area coordinator for that county
   (for example, "Area 10 Coordinator: Julia Meredith"). If there is no coordinator
   on file for the county, it says so. This line shows a **name only** — never a
   phone number.
6. If the county looks thin, a **"Thin in this county?"** prompt offers a
   **"Widen search → enter address + radius"** button that switches you to
   Address mode (Section 5) carrying your animal facts with you.
7. Click **Get Recommendation**.
8. Read the recommendation box that appears (see **Section 7 — How to read a
   recommendation**).

If you click **Get Recommendation** before picking a county, the box tells you to
**select a county first**.

---

## 5. ADDRESS + RADIUS mode — step by step

Use this when you have the animal's address (or after you clicked "Widen search"
from County mode).

1. Set **RVS Animal?** and **Issue** at the top of the page (Section 2).
2. Select **By Animal Address**.
3. Type the animal's address in **Animal Address**. As you type, a list of address
   suggestions appears — use the arrow keys and Enter, or click, to pick one.
   - The address is geocoded by a public service (US Census, no key). **No address
     is stored.**
4. Set the **Search Radius (miles)**. Default is **20**; the maximum is **100**.
   Distance is straight-line ("as the crow flies").
5. Click **Find Help Nearby**.
6. Results appear in a panel:
   - **Volunteers in range** — the total count of WIN volunteers within the radius.
   - Three capacity cards (**C&T**, **RVS C&T**, **Courier**) showing
     **available / total** in range.
   - **WIN areas covered** — chips listing which WIN areas fall in range.
   - An **Out-of-county helpers** list when relevant: one row per volunteer with
     role badge(s) and distance, nearest first. Each row also carries a
     **Qualified / Not qualified** tag for *this* animal (based on your RVS + Issue
     choices). If the radius is very large, you may see a notice that only the
     nearest few are shown — narrow the radius for a complete list.
   - **Recommended Actions** — one or more action lines (see Section 7).
   - The on-demand **nearest rehabber** panel (see Section 8).

If the address can't be found or the service is unavailable, an error message
explains what to try (for example, check spelling, or try again shortly).

---

## 6. Stale results — when you change a fact after results show

If you change the **RVS Animal?** toggle or the **Capture / Transport** selection
**after** a result is already on screen, the console does **not** silently update
the numbers. Instead it:

- **dims and greys out** the shown result so you don't trust stale numbers, and
- shows a banner: **"Inputs changed — re-run the lookup to refresh results."**
  with a hint to click the lookup button again.

To refresh, just click the lookup button again:

- In County mode: **Get Recommendation**.
- In Address mode: **Find Help Nearby**.

Re-running clears the banner and shows fresh numbers. (Numbers are never changed
behind your back — you always re-run on purpose.) When an address result goes
stale, the nearest-rehabber panel is also collapsed so it can't reveal stale rows.

---

## 7. How to read a recommendation

A recommendation has a few parts. Read them top to bottom.

### The action headline
A colored bar tells you the recommended action:

- **Dispatch via Connecteam** (green) — send a qualified volunteer the task through
  Connecteam.
- **Call PA Game Commission** (amber) — there is no available qualified volunteer;
  the finder should call the Game Commission (see Section 9).
- **No automatic action - escalate to supervisor** (grey) — the inputs weren't
  enough to decide; pick Capture or Transport, or escalate.

In Address mode the action lines read similarly (task qualified helpers via
Connecteam, or escalate to the PA Game Commission, etc.).

### Target role
A line such as **"Target role: RVS C&T"** tells you which kind of volunteer the
recommendation is for (C&T, RVS C&T, C&T (any), or Courier).

### Reasoning
A short numbered list explains *why* the console chose that action — for example,
"Capture + RVS animal -> RVS-capable C&T required" then "Recommended: dispatch a
C&T+RVS volunteer via Connecteam."

### Capacity cards
The same **available / total** cards from the lookup, so you can see how much
capacity is behind the recommendation.

### "Marginal" low-capacity badge + roster
If the chosen role has very little capacity left (at or below the low-capacity
threshold but still above zero), the recommendation shows a **Low capacity** block.
It lists the **availability notes** for those marginal volunteers (the verbatim
note from the data) so you can judge whether to dispatch or call the Game
Commission instead. No volunteer names or phone numbers are shown here.

### Coordinator line
In County mode the area coordinator's **name** is shown (name only, never a phone),
so you know who oversees that WIN area.

You can dismiss the County-mode recommendation box with the **Dismiss** button.

---

## 8. Nearest rehabbers (on-demand)

After an Address-mode lookup, a **"Show nearest rehabbers"** button may appear.
Rehabbers are **not** shown automatically — click the button to reveal them. The
list is already prepared (clicking only shows/hides it; it does not re-run the
lookup). Click again to **Hide nearest rehabbers**.

When revealed, you see up to the **top 3 closest rehabbers**, nearest first. Each
row shows:

- **Name**
- **Distance** in miles (the header notes whether distance is measured from the
  animal location or, as a fallback, from the county center)
- **County**
- **Phone** as a tap-to-call link. If the rehabber has **no phone on file**, the
  row shows **`----`** instead of a number.
- **Availability text** — the verbatim note from the rehabber's record (line breaks
  preserved).
- **Website** link — only when a website is on file.

---

## 9. PA Game Commission fallback

The console always keeps the PA Game Commission dispatch line in front of you.
Under the **Get Recommendation** button you will always see:

> If no Volunteer contacts FINDER within 2 hours FINDER should call PA Game
> Commission: **(833) 742-4868 or (833) 742-9453**

Whenever a recommendation says to **Call PA Game Commission** (no qualified
volunteer available), this is the number to use.

---

## 10. Beta caveats — read this

This is a preview build. A few things you must keep in mind:

- **Rehabber OPEN/CLOSED status is NOT shown here and is NOT kept current.** Do
  **not** assume a rehabber is open just because they appear in the nearest-rehabber
  list. Open/closed lives in a **separate (beta) rehab-status app on the winstat
  site** — check there or call before sending an animal.
- **Availability text is verbatim.** The availability note shown for a rehabber (and
  in the marginal-volunteer roster) is the exact note from the data — it may be out
  of date. Treat it as a hint, not a guarantee.
- This build is labeled **Under Construction** and is **not yet ready for production
  use**.

When in doubt, call ahead and fall back to the PA Game Commission number in
Section 9.

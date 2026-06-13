# SPJIMR Timetable Extension

A Chrome extension that shows your SPJIMR class schedule for the week — right from your browser toolbar — without having to dig through TCS iON.

**Features:**
- View this week's classes grouped by day
- Navigate to past and future weeks
- See which classes are mandatory (highlighted separately)
- Export your week's schedule as a calendar file (.ics) to import into Google Calendar, Apple Calendar, etc.

---

## Requirements

- Google Chrome browser
- A TCS iON account (your SPJIMR login)

---

## Installation

> No app store involved — you load it directly into Chrome in a few steps.

**Step 1 — Download the extension**

Click the green **Code** button on this page → **Download ZIP** → unzip the folder somewhere you'll remember (e.g. your Desktop).

**Step 2 — Open Chrome Extensions**

In Chrome, go to this address in your address bar:
```
chrome://extensions
```

**Step 3 — Enable Developer Mode**

Toggle on **Developer mode** in the top-right corner of that page.

**Step 4 — Load the extension**

Click **Load unpacked** → select the folder you unzipped in Step 1.

The SPJIMR Timetable icon will now appear in your Chrome toolbar.

---

## First-time setup

Before the extension can show your timetable, it needs to read your session details from TCS iON once.

1. Log in to TCS iON and navigate to your **Attendance** page
2. Click the extension icon in your toolbar — it will sync automatically
3. Your timetable will load

---

## Marking classes as mandatory

Edit the `mandatory_classes.csv` file inside the extension folder. Each row is one subject:

```
Short Code, Subject Name, Mandatory Classes
OLS541-PBM, Management of Change, "3,5"
```

- **Short Code / Subject Name** — either one works to identify the subject
- **Mandatory Classes** — controls which sessions are marked:
  - `ALL` — every session of that subject is mandatory
  - `"3,5"` — only sessions 3 and 5 are mandatory
  - blank or `NA` — nothing is marked mandatory (the row is ignored)

After editing the CSV, reload the extension at `chrome://extensions`.

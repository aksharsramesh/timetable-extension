// popup.js — renders the weekly timetable.

const contentEl = document.getElementById("content");
const updatedEl = document.getElementById("updated");
const refreshBtn = document.getElementById("refresh");
const weekLabelEl = document.getElementById("weekLabel");
const prevBtn = document.getElementById("prevWeek");
const nextBtn = document.getElementById("nextWeek");
const exportBtn = document.getElementById("export");

// 0 = current week, -1 = last week, +1 = next week, etc.
let weekOffset = 0;
// Classes currently shown — used by the .ics export.
let currentClasses = [];
// Mandatory-class rules parsed from mandatory_classes.csv.
let mandatoryRules = [];

const ERROR_MESSAGES = {
  NOT_ON_SITE: "Please open TCS iON to load your timetable.",
  PARAMS_MISSING:
    "Open your TCS iON attendance page once to sync, then click Refresh.",
  SESSION_EXPIRED: "Session expired. Please log in to TCS iON.",
  NETWORK_ERROR: "Could not load timetable. Check your connection.",
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Monday..Sunday for the given week offset, with both formatted strings (for
 * the API) and Date objects (for the label). Local date components only.
 */
function getWeekRange(offset) {
  const base = new Date();
  const day = base.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(base);
  monday.setDate(base.getDate() + diffToMonday + offset * 7);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const pad = (n) => String(n).padStart(2, "0");
  const fmtTS = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmt = (d) => fmtTS(d).replace(/-/g, "");

  return {
    startdate: fmt(monday),
    enddate: fmt(sunday),
    startdateTS: fmtTS(monday),
    enddateTS: fmtTS(sunday),
    monday,
    sunday,
  };
}

function weekRangeLabel(week) {
  const m = week.monday;
  const s = week.sunday;
  const left =
    m.getMonth() === s.getMonth()
      ? `${m.getDate()}`
      : `${m.getDate()} ${MONTHS[m.getMonth()]}`;
  const right = `${s.getDate()} ${MONTHS[s.getMonth()]}`;
  return `${left} – ${right}`;
}

function renderWeekLabel(week) {
  weekLabelEl.textContent = weekRangeLabel(week);
  if (weekOffset === 0) {
    const tag = document.createElement("span");
    tag.className = "this-week";
    tag.textContent = "This week";
    weekLabelEl.appendChild(tag);
  }
}

// --- mandatory classes (from mandatory_classes.csv) --------------------------

// Minimal CSV parser that respects double-quoted fields (e.g. "3,5").
function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const fields = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    rows.push(fields);
  }
  return rows;
}

// Rows → rules: { code, subject, sessions }. sessions === null means "all".
function buildMandatoryRules(rows) {
  const rules = [];
  for (const r of rows) {
    const code = (r[0] || "").trim();
    const subject = (r[1] || "").trim();
    const sessionsRaw = (r[2] || "").trim();
    if (!code && !subject) continue;
    if (code.toLowerCase() === "short code") continue; // header row
    if (!sessionsRaw || sessionsRaw.toUpperCase() === "NA") continue; // blank/NA → not mandatory
    const sessions =
      sessionsRaw.toUpperCase() === "ALL"
        ? null // ALL → every session mandatory
        : new Set(sessionsRaw.split(",").map((s) => s.trim()).filter(Boolean));
    rules.push({ code: code.toUpperCase(), subject: subject.toUpperCase(), sessions });
  }
  return rules;
}

async function loadMandatoryRules() {
  try {
    const res = await fetch(chrome.runtime.getURL("mandatory_classes.csv"));
    if (!res.ok) return;
    mandatoryRules = buildMandatoryRules(parseCSV(await res.text()));
  } catch (_) {
    // No CSV / unreadable → nothing is marked mandatory.
    mandatoryRules = [];
  }
}

function isMandatory(cls) {
  const sc = String(cls.shortcode || "").trim().toUpperCase();
  const subj = String(cls.subject || "").trim().toUpperCase();
  const sess = String(cls.sessionNumber || "").trim();
  for (const rule of mandatoryRules) {
    const codeMatch = sc && rule.code && rule.code.includes(sc);
    const subjMatch = subj && rule.subject && rule.subject === subj;
    if (codeMatch || subjMatch) {
      if (rule.sessions === null || rule.sessions.has(sess)) return true;
    }
  }
  return false;
}

function showState(text) {
  updatedEl.textContent = "";
  contentEl.innerHTML = "";
  currentClasses = [];
  exportBtn.disabled = true;
  const el = document.createElement("div");
  el.className = "state";
  el.textContent = text;
  contentEl.appendChild(el);
}

function setLoading(isLoading) {
  refreshBtn.disabled = isLoading;
  refreshBtn.classList.toggle("spinning", isLoading);
}

/** "2026-06-15" → "Monday, 15 Jun" (daytype supplied by the API). */
function formatDayHeading(daytype, isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return daytype;
  return `${daytype}, ${d} ${MONTHS[m - 1]}`;
}

function renderClass(cls) {
  const mandatory = isMandatory(cls);

  const row = document.createElement("div");
  row.className = mandatory ? "class class--mandatory" : "class";

  const time = document.createElement("div");
  time.className = "class-time";
  time.textContent = `${cls.startTime} – ${cls.endTime}`;
  row.appendChild(time);

  const body = document.createElement("div");
  body.className = "class-body";

  const subject = document.createElement("div");
  subject.className = "class-subject";
  subject.textContent = cls.subject;
  if (mandatory) {
    const tag = document.createElement("span");
    tag.className = "tag-mandatory";
    tag.textContent = "Mandatory";
    subject.appendChild(tag);
  }
  body.appendChild(subject);

  if (cls.shortcode) {
    const shortcode = document.createElement("div");
    shortcode.className = "class-shortcode";
    shortcode.textContent = cls.shortcode;
    body.appendChild(shortcode);
  }

  const meta = document.createElement("div");
  meta.className = "class-meta";
  const parts = [cls.faculty, cls.room];
  if (cls.sessionNumber) parts.push(`Session ${cls.sessionNumber}`);
  meta.textContent = parts.filter(Boolean).join(" · ");
  body.appendChild(meta);

  row.appendChild(body);
  return row;
}

function renderTimetable(classes, lastUpdated) {
  contentEl.innerHTML = "";

  if (!classes || classes.length === 0) {
    showState("No classes found for this week.");
    return;
  }

  currentClasses = classes;
  exportBtn.disabled = false;

  // Group by date, preserving the already-sorted order.
  const groups = [];
  const byDate = new Map();
  for (const cls of classes) {
    if (!byDate.has(cls.date)) {
      const group = { date: cls.date, daytype: cls.daytype, items: [] };
      byDate.set(cls.date, group);
      groups.push(group);
    }
    byDate.get(cls.date).items.push(cls);
  }

  for (const group of groups) {
    const dayEl = document.createElement("section");
    dayEl.className = "day";

    const heading = document.createElement("h2");
    heading.className = "day-heading";
    heading.textContent = formatDayHeading(group.daytype, group.date);
    dayEl.appendChild(heading);

    for (const cls of group.items) {
      dayEl.appendChild(renderClass(cls));
    }
    contentEl.appendChild(dayEl);
  }

  if (lastUpdated) {
    const t = new Date(lastUpdated);
    updatedEl.textContent = `Updated ${t.toLocaleString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
}

function load(force) {
  const week = getWeekRange(weekOffset);
  renderWeekLabel(week);
  setLoading(true);
  showState("Loading…");

  chrome.runtime.sendMessage(
    { action: "getTimetable", force, week },
    (response) => {
      setLoading(false);

      if (chrome.runtime.lastError || !response) {
        showState(ERROR_MESSAGES.NETWORK_ERROR);
        return;
      }
      if (response.error) {
        showState(ERROR_MESSAGES[response.error] || ERROR_MESSAGES.NETWORK_ERROR);
        return;
      }
      renderTimetable(response.timetable, response.lastUpdated);
    }
  );
}

// --- .ics export -------------------------------------------------------------

// Escape per RFC 5545 (backslash, semicolon, comma, newline).
function icsEscape(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// "2026-06-15" + "10:40" → "20260615T104000" (floating local time — the times
// are already IST, so no TZID needed; calendars show them as-is).
function icsDateTime(date, time) {
  const d = date.replace(/-/g, "");
  const [h, m] = time.split(":");
  return `${d}T${h.padStart(2, "0")}${m.padStart(2, "0")}00`;
}

function icsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// Fold lines longer than 75 octets (RFC 5545) with CRLF + leading space.
function foldLine(line) {
  const out = [];
  let s = line;
  while (s.length > 73) {
    out.push(s.slice(0, 73));
    s = " " + s.slice(73);
  }
  out.push(s);
  return out.join("\r\n");
}

function buildICS(classes) {
  const stamp = icsStamp();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//SPJIMR Timetable//EN",
    "CALSCALE:GREGORIAN",
  ];

  for (const cls of classes) {
    if (!cls.date || !cls.startTime || !cls.endTime) continue;

    const uid =
      `${cls.date}-${cls.startTime}-${cls.shortcode}`.replace(/[^a-zA-Z0-9-]/g, "") +
      "@spjimr-timetable";
    const mandatory = isMandatory(cls);
    const desc = [
      cls.shortcode,
      cls.faculty,
      cls.sessionNumber ? `Session ${cls.sessionNumber}` : "",
      mandatory ? "[Mandatory]" : "",
    ]
      .filter(Boolean)
      .join("\n");

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${icsDateTime(cls.date, cls.startTime)}`);
    lines.push(`DTEND:${icsDateTime(cls.date, cls.endTime)}`);
    lines.push(`SUMMARY:${icsEscape(mandatory ? "★ " + cls.subject : cls.subject)}`);
    if (cls.room) lines.push(`LOCATION:${icsEscape(cls.room)}`);
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    if (mandatory) {
      // RFC 7986 per-event color (honored by Apple Calendar & others; Google
      // ignores it on import — the ★ prefix + category are the fallback).
      lines.push("COLOR:tomato");
      lines.push("CATEGORIES:MANDATORY");
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function downloadICS(filename, content) {
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- wiring ------------------------------------------------------------------

prevBtn.addEventListener("click", () => {
  weekOffset -= 1;
  load(false);
});
nextBtn.addEventListener("click", () => {
  weekOffset += 1;
  load(false);
});
refreshBtn.addEventListener("click", () => load(true));
exportBtn.addEventListener("click", () => {
  if (!currentClasses.length) return;
  const week = getWeekRange(weekOffset);
  downloadICS(`spjimr-timetable-${week.startdateTS}.ics`, buildICS(currentClasses));
});

// Load the mandatory-classes CSV first, then fetch the timetable so the very
// first render already reflects mandatory marking.
loadMandatoryRules().then(() => load(false));

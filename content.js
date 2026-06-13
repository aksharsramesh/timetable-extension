// content.js — runs in the isolated world on g21.tcsion.com, in every frame.
//
// Two jobs:
//   1) Receive the request params captured by inject.js (MAIN world) and cache
//      them in chrome.storage.local.
//   2) In the TOP frame only, replay the AttendancePeriodWiseServlet call as a
//      POST with the current week's dates, using the live browser session.

/**
 * @typedef {Object} ClassEvent
 * @property {string} date
 * @property {string} daytype
 * @property {string} subject
 * @property {string} shortcode
 * @property {string} faculty
 * @property {string} startTime
 * @property {string} endTime
 * @property {string} room
 * @property {string} sessionNumber
 * @property {string} attendanceStatus
 */

const API_BASE = "https://g21.tcsion.com/cms/AttendancePeriodWiseServlet";
const PARAM_KEYS = ["REFERENCE_ID", "permissionId", "entityTypeId", "examSessionId"];

// --- 1) Cache params captured by inject.js -----------------------------------
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== "spjimr-timetable" || data.type !== "params") return;
  const params = data.params || {};
  if (!params.REFERENCE_ID) return;
  chrome.storage.local.set({ pageParams: params });
  console.log("[SPJIMR] captured app request params:", params);
});

// --- helpers -----------------------------------------------------------------

/**
 * Monday..Sunday of the current week, formatted for the API.
 * Uses LOCAL date components (not toISOString) so IST users near midnight get
 * the correct day.
 */
function getWeekRange() {
  const today = new Date();
  const day = today.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday);

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
  };
}

function buildUrl(pageParams, week) {
  const qs = new URLSearchParams({
    REFERENCE_ID: pageParams.REFERENCE_ID || "",
    permissionId: pageParams.permissionId || "",
    entityTypeId: pageParams.entityTypeId || "",
    examSessionId: pageParams.examSessionId || "",
    startdate: week.startdate,
    enddate: week.enddate,
    startdateTS: week.startdateTS,
    enddateTS: week.enddateTS,
    showAcademicSlots: "no",
    screen: "c",
    isOpen: "N",
  });
  return `${API_BASE}?${qs.toString()}`;
}

/**
 * @param {any} item raw Item1 object from the API
 * @returns {ClassEvent}
 */
function toClassEvent(item) {
  const [startTime, endTime] = String(item.displaytime || "").split("-");
  return {
    date: String(item.dateval || "").substring(0, 10),
    daytype: item.daytype || "",
    subject: item.sudsubjectname || "",
    shortcode: item.sudsubjectshortcode || "",
    faculty: String(item.sudfacultyname || "").trim().replace(/\s+/g, " "),
    startTime: (startTime || "").trim(),
    endTime: (endTime || "").trim(),
    room: item.sudresourcename || "",
    sessionNumber: String(item.slot_remarks || "").replace(/"/g, "").trim(),
    attendanceStatus: item.attendanceStatus || "",
  };
}

async function fetchTimetable(week) {
  const stored = await chrome.storage.local.get(["pageParams"]);
  const pageParams = stored.pageParams;

  if (!pageParams || PARAM_KEYS.some((k) => !pageParams[k])) {
    console.warn("[SPJIMR] no cached params yet — visit the attendance page once.");
    return { error: "PARAMS_MISSING" };
  }

  const range = week || getWeekRange();
  const url = buildUrl(pageParams, range);
  console.log("[SPJIMR] requesting (POST):", url);

  let response;
  try {
    // POST, to match the request the TCS iON app itself makes; same-origin from
    // the top frame so the session cookies are sent automatically.
    response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    console.error("[SPJIMR] fetch threw:", err);
    return { error: "NETWORK_ERROR" };
  }

  console.log("[SPJIMR] response status:", response.status, "redirected:", response.redirected);

  if (response.redirected && /login/i.test(response.url)) {
    return { error: "SESSION_EXPIRED" };
  }
  if (response.status === 401 || response.status === 403) {
    return { error: "SESSION_EXPIRED" };
  }
  if (!response.ok) {
    return { error: "NETWORK_ERROR" };
  }

  const text = await response.text();
  console.log("[SPJIMR] response body (first 400 chars):", text.slice(0, 400));

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    console.warn("[SPJIMR] response was not JSON (first 300 chars):", text.slice(0, 300));
    return { error: "SESSION_EXPIRED" };
  }

  if (!Array.isArray(data)) {
    console.warn("[SPJIMR] response JSON was not an array:", data);
    return { error: "SESSION_EXPIRED" };
  }

  const classes = data
    .map((entry) => entry && entry.Item1)
    .filter(Boolean)
    .map(toClassEvent)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;
    });

  console.log("[SPJIMR] parsed", data.length, "raw entries →", classes.length, "classes");
  return { classes, pageParams };
}

// --- 2) Only the top frame answers fetch requests ----------------------------
if (window === window.top) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.action === "fetchTimetable") {
      fetchTimetable(message.week)
        .then(sendResponse)
        .catch(() => sendResponse({ error: "NETWORK_ERROR" }));
      return true; // keep the channel open for the async response
    }
  });
}

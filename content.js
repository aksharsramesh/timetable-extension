// content.js — runs in the isolated world on spp.spjimr.org, in every frame.
//
// The Salesforce (LWR) portal exposes the timetable through two Apex methods on
// one class, both callable as plain cacheable GETs with the session cookie:
//
//   getEnrolledSessions {filterJson:{startDate,endDate,sessionType}} → week list
//   getSessionDetails   {sessionId}                                  → + location
//
// Nothing opaque has to be sniffed off the app's own traffic (unlike the old
// TCS iON servlet, which needed four internal params), so there is no MAIN-world
// hook any more. The fetch still runs from the TOP frame of a portal tab so it
// is same-origin and the `sid` cookie is sent automatically.

/**
 * @typedef {Object} ClassEvent
 * @property {string} id            Salesforce record id (a1H…)
 * @property {string} date
 * @property {string} daytype
 * @property {string} subject
 * @property {string} shortcode     always "" — Salesforce does not return one
 * @property {string} faculty
 * @property {string} startTime
 * @property {string} endTime
 * @property {string} room
 * @property {string} sessionNumber
 * @property {string} activityType  "Session", "End Term", "Quiz", …
 * @property {string} attendanceStatus  always "" — not exposed by either method
 */

const API_BASE = "https://spp.spjimr.org/student/webruntime/api/apex/execute";
// Apex class behind the schedule page. Stable per org, but a redeploy on their
// side would change it — that is the one value worth checking if fetches start
// failing with a 4xx while the session is still good.
const APEX_CLASS = "@udd/01pOS00000rnWET";

const DAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// --- helpers -----------------------------------------------------------------

function apexUrl(method, params) {
  const qs = new URLSearchParams({
    cacheable: "true",
    classname: APEX_CLASS,
    isContinuation: "false",
    method,
    namespace: "",
    params: JSON.stringify(params),
    language: "en-US",
    asGuest: "false",
    htmlEncode: "false",
  });
  return `${API_BASE}?${qs.toString()}`;
}

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

/** "5:30PM" → "17:30"; "" for anything unparseable. */
function to24h(raw) {
  const m = String(raw || "").trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i);
  if (!m) return "";
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "P") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** "2026-07-27" → "Monday". The old API sent this as `daytype`. */
function dayName(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  if (!y || !m || !d) return "";
  return DAYS[new Date(y, m - 1, d).getDay()];
}

// The portal writes "Not Given" into empty text fields.
function cleanText(v) {
  const s = String(v == null ? "" : v).trim();
  return /^(not given|n\/?a|-)$/i.test(s) ? "" : s;
}

/**
 * @param {any} session entry from getEnrolledSessions
 * @param {any} detail  matching getSessionDetails payload, or null
 * @returns {ClassEvent}
 */
function toClassEvent(session, detail) {
  const date = cleanText(session.sessionDate);
  return {
    id: cleanText(session.id),
    date,
    daytype: dayName(date),
    subject: cleanText(session.courseName),
    shortcode: "",
    faculty: cleanText(session.instructorNames).replace(/\s+/g, " "),
    startTime: to24h(session.startTime),
    endTime: to24h(session.endTime),
    room: detail ? cleanText(detail.location) : "",
    sessionNumber: cleanText(session.title),
    activityType: cleanText(session.courseActivity),
    attendanceStatus: "",
  };
}

// --- fetching ----------------------------------------------------------------

/**
 * GET an Apex method and return its `returnValue`.
 * Throws a string error code the popup already knows how to render.
 */
async function callApex(method, params) {
  let response;
  try {
    response = await fetch(apexUrl(method, params), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    console.error("[SPJIMR] fetch threw:", err);
    throw "NETWORK_ERROR";
  }

  if (response.status === 401 || response.status === 403) throw "SESSION_EXPIRED";
  if (response.redirected && /login/i.test(response.url)) throw "SESSION_EXPIRED";
  if (!response.ok) throw "NETWORK_ERROR";

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    // A logged-out portal answers with the login page's HTML, not JSON.
    console.warn("[SPJIMR] response was not JSON (first 300 chars):", text.slice(0, 300));
    throw "SESSION_EXPIRED";
  }
  return data && data.returnValue;
}

/**
 * Room only comes from the per-session detail call, so fan out one request per
 * class. They are cacheable GETs and the background caches the merged result for
 * 30 minutes, so this is one burst per week, not per popup open.
 */
async function fetchDetails(sessions) {
  const results = await Promise.all(
    sessions.map((s) =>
      callApex("getSessionDetails", { sessionId: s.id }).catch(() => null)
    )
  );
  const byId = new Map();
  results.forEach((detail, i) => {
    if (detail) byId.set(sessions[i].id, detail);
  });
  return byId;
}

async function fetchTimetable(week) {
  const range = week || getWeekRange();
  console.log("[SPJIMR] requesting week:", range.startdateTS, "→", range.enddateTS);

  let sessions;
  try {
    sessions = await callApex("getEnrolledSessions", {
      filterJson: JSON.stringify({
        startDate: range.startdateTS,
        endDate: range.enddateTS,
        sessionType: null,
      }),
    });
  } catch (code) {
    return { error: typeof code === "string" ? code : "NETWORK_ERROR" };
  }

  if (!Array.isArray(sessions)) {
    console.warn("[SPJIMR] returnValue was not an array:", sessions);
    return { error: "SESSION_EXPIRED" };
  }

  const withId = sessions.filter((s) => s && s.id);
  const details = await fetchDetails(withId);

  const classes = withId
    .map((s) => toClassEvent(s, details.get(s.id) || null))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;
    });

  console.log("[SPJIMR] parsed", sessions.length, "sessions →", classes.length, "classes");
  return { classes };
}

// --- only the top frame answers fetch requests -------------------------------
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

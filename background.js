// background.js — service worker
// Mediates between the popup and the content script, and caches the timetable.

const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const SITE_URL_PATTERN = "https://spp.spjimr.org/*";

const MAX_CACHED_WEEKS = 12;

// --- Google Calendar sync ----------------------------------------------------

// Personal-account OAuth "Web application" client ID, consent screen published to
// "In production". Redirect URI registered there must be the value returned by
// chrome.identity.getRedirectURL() (https://<extension-id>.chromiumapp.org/).
const GOOGLE_CLIENT_ID = "510821583415-n40ae1e179d55f4b65vescbv9gqkvtb9.apps.googleusercontent.com";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const CALENDAR_IMPORT_URL = `${CALENDAR_EVENTS_URL}/import`;

// Every event we create carries this iCalUID suffix (see eventUID in popup.js),
// so we can recognise our own events on the calendar and never touch others'.
const UID_SUFFIX = "@spjimr-timetable";

// The college also schedules some classes straight onto Google Calendar. Those invites
// carry less than the portal gives us (no room, no session number, no mandatory marking),
// so we decline them during sync — Google Calendar hides declined events by default, and
// declining is reversible, unlike deleting.
const COLLEGE_ORGANIZER_EMAILS = ["programme.scheduling@spjimr.org"]; // lowercase

// Implicit flow (response_type=token) — no client secret, so nothing sensitive
// ships in the extension. Tokens last ~1h and are re-fetched silently.
function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: "token",
    scope: GOOGLE_SCOPE,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Pull access_token / expires_in out of the redirect URL fragment.
function parseTokenFromRedirect(redirectUrl) {
  const frag = (redirectUrl || "").split("#")[1] || "";
  const params = new URLSearchParams(frag);
  const accessToken = params.get("access_token");
  if (!accessToken) return null;
  const expiresIn = parseInt(params.get("expires_in") || "0", 10);
  return { accessToken, expiry: Date.now() + (expiresIn - 60) * 1000 };
}

async function getCachedToken() {
  const { googleToken } = await chrome.storage.local.get(["googleToken"]);
  if (googleToken && googleToken.accessToken && googleToken.expiry > Date.now()) {
    return googleToken.accessToken;
  }
  return null;
}

async function launchAuth(interactive) {
  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    url: buildAuthUrl(),
    interactive,
  });
  const token = parseTokenFromRedirect(redirectUrl);
  if (!token) throw new Error("No access token in redirect");
  await chrome.storage.local.set({ googleToken: token });
  return token.accessToken;
}

// Cached token → silent re-auth → interactive consent (first time only).
async function getAccessToken() {
  const cached = await getCachedToken();
  if (cached) return cached;
  try {
    return await launchAuth(false);
  } catch (_) {
    return await launchAuth(true);
  }
}

function importEvent(token, event) {
  return fetch(CALENDAR_IMPORT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
}

// Is this one of the events we put on the calendar?
function isOurEvent(ev) {
  return typeof ev.iCalUID === "string" && ev.iCalUID.endsWith(UID_SUFFIX);
}

// Was this event put on the calendar by the college's scheduling account?
function isCollegeEvent(ev) {
  return [ev.organizer && ev.organizer.email, ev.creator && ev.creator.email].some(
    (e) => typeof e === "string" && COLLEGE_ORGANIZER_EMAILS.includes(e.toLowerCase())
  );
}

// Every event on the calendar within [timeMin, timeMax]. Callers pick out the ones
// they care about — ours (for stale cleanup) and the college's (for declining).
async function listEvents(token, window) {
  const items = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      singleEvents: "true",
      showDeleted: "false",
      maxResults: "250",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`${CALENDAR_EVENTS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`list failed: ${res.status}`);
    const data = await res.json();
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

// Delete our events in the synced window whose class is no longer in the fresh
// data (their iCalUID isn't in keepUIDs). Returns how many were removed.
async function deleteStaleEvents(token, items, keepUIDs) {
  let removed = 0;
  for (const ev of items) {
    if (!isOurEvent(ev)) continue; // never touch events we didn't create
    if (keepUIDs.has(ev.iCalUID)) continue; // still scheduled — leave it
    const res = await fetch(`${CALENDAR_EVENTS_URL}/${ev.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok || res.status === 410) removed++; // 410 = already gone
  }
  return removed;
}

// Hide the college's own calendar entries for the synced week by declining them —
// Google Calendar keeps declined events but hides them by default, so this is
// reversible. Returns how many we newly hid.
async function declineCollegeEvents(token, items) {
  let declined = 0;
  for (const ev of items) {
    if (isOurEvent(ev) || !isCollegeEvent(ev)) continue;
    const attendees = ev.attendees || [];
    const self = attendees.find((a) => a.self);
    let res;
    if (!self) {
      // Not an invite we can respond to — drop our copy instead.
      res = await fetch(`${CALENDAR_EVENTS_URL}/${ev.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok || res.status === 410) declined++; // 410 = already gone
      continue;
    }
    if (self.responseStatus === "declined") continue; // already hidden
    // Send the whole attendee list back so the others aren't dropped, and keep the
    // organiser from being notified about a decline they don't need to see.
    const patched = attendees.map((a) =>
      a.self ? { ...a, responseStatus: "declined" } : a
    );
    res = await fetch(`${CALENDAR_EVENTS_URL}/${ev.id}?sendUpdates=none`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ attendees: patched }),
    });
    if (res.ok) declined++;
  }
  return declined;
}

async function syncToGoogle(events, window) {
  let result;
  let token;
  try {
    token = await getAccessToken();
  } catch (_) {
    result = { error: "AUTH_FAILED", imported: 0, failed: events.length, at: Date.now() };
    await chrome.storage.local.set({ lastGoogleSync: result });
    return result;
  }

  let imported = 0;
  let failed = 0;
  let removed = 0;
  let declined = 0;
  let reauthed = false;
  let authOk = true;

  for (let i = 0; i < events.length; i++) {
    let res = await importEvent(token, events[i]);
    // Token rejected mid-run — drop it, re-auth once, retry this event.
    if (res.status === 401 && !reauthed) {
      reauthed = true;
      await chrome.storage.local.remove("googleToken");
      try {
        token = await getAccessToken();
      } catch (_) {
        failed += events.length - i; // remaining events (incl. current) all fail
        authOk = false;
        break;
      }
      res = await importEvent(token, events[i]);
    }
    if (res.ok) imported++;
    else failed++;
  }

  // Clean up the week: drop our events for classes that vanished (cancelled / moved)
  // and hide the college's own entries. Only when auth is healthy — otherwise we
  // might delete events we couldn't re-add. One listing serves both passes.
  if (authOk && window && window.timeMin && window.timeMax) {
    let items = null;
    try {
      items = await listEvents(token, window);
    } catch (_) {
      items = null; // couldn't list — skip cleanup rather than guess
    }
    if (items) {
      const keepUIDs = new Set(events.map((e) => e.iCalUID));
      removed = await deleteStaleEvents(token, items, keepUIDs);
      declined = await declineCollegeEvents(token, items);
    }
  }

  result = { imported, failed, removed, declined, at: Date.now() };
  await chrome.storage.local.set({ lastGoogleSync: result });
  return result;
}

async function getTimetable(force, week) {
  const key = week.startdate; // YYYYMMDD of that week's Monday
  const stored = await chrome.storage.local.get(["timetableCache"]);
  const cache = stored.timetableCache || {};
  const entry = cache[key];

  // Serve fresh cache for THIS week unless a forced refresh was requested.
  if (!force && entry && Array.isArray(entry.timetable)) {
    const age = Date.now() - new Date(entry.lastUpdated).getTime();
    if (age < CACHE_MAX_AGE_MS) {
      return {
        timetable: entry.timetable,
        lastUpdated: entry.lastUpdated,
        fromCache: true,
      };
    }
  }

  // Find an open student-portal tab to host the authenticated fetch.
  const tabs = await chrome.tabs.query({ url: SITE_URL_PATTERN });
  if (!tabs.length) {
    return { error: "NOT_ON_SITE" };
  }

  const result = await sendToContentScript(tabs, week);
  if (!result || result.error) {
    return result || { error: "NETWORK_ERROR" };
  }

  const lastUpdated = new Date().toISOString();
  cache[key] = { lastUpdated, timetable: result.classes };
  pruneCache(cache);
  await chrome.storage.local.set({ timetableCache: cache });

  return { timetable: result.classes, lastUpdated, fromCache: false };
}

// Keep the cache bounded — drop the least-recently-updated weeks.
function pruneCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_CACHED_WEEKS) return;
  keys
    .sort((a, b) => new Date(cache[a].lastUpdated) - new Date(cache[b].lastUpdated))
    .slice(0, keys.length - MAX_CACHED_WEEKS)
    .forEach((k) => delete cache[k]);
}

// Try each matching tab until one's top frame answers. The fetch is handled
// only by the top frame (same origin as the servlet), so target frameId 0.
async function sendToContentScript(tabs, week) {
  let lastError = { error: "NOT_ON_SITE" };
  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(
        tab.id,
        { action: "fetchTimetable", week },
        { frameId: 0 }
      );
      if (response) return response;
    } catch (_) {
      // No receiver in this tab (content script not loaded yet); try the next.
      lastError = { error: "NOT_ON_SITE" };
    }
  }
  return lastError;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.action === "getTimetable") {
    getTimetable(Boolean(message.force), message.week)
      .then(sendResponse)
      .catch(() => sendResponse({ error: "NETWORK_ERROR" }));
    return true; // async response
  }
  if (message && message.action === "syncGoogleCalendar") {
    const events = message.events || [];
    syncToGoogle(events, message.window)
      .then(sendResponse)
      .catch(() =>
        sendResponse({ error: "SYNC_ERROR", imported: 0, failed: events.length, at: Date.now() })
      );
    return true; // async response
  }
});

// background.js — service worker
// Mediates between the popup and the content script, and caches the timetable.

const CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const SITE_URL_PATTERN = "https://g21.tcsion.com/*";

const MAX_CACHED_WEEKS = 12;

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

  // Find an open TCS iON tab to host the authenticated fetch.
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
});

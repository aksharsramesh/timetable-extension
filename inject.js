// inject.js — runs in the page's MAIN world, in every frame.
// The four request params (REFERENCE_ID, permissionId, entityTypeId,
// examSessionId) are NOT present anywhere in the DOM — the TCS iON app builds
// them internally and passes them straight into its own network call. So we
// hook the app's XHR/fetch, read the params off its AttendancePeriodWiseServlet
// request, and hand them to the content script via window.postMessage.

(function () {
  const TARGET = "AttendancePeriodWiseServlet";
  const KEYS = ["REFERENCE_ID", "permissionId", "entityTypeId", "examSessionId"];

  function capture(rawUrl) {
    try {
      if (!rawUrl || String(rawUrl).indexOf(TARGET) === -1) return;
      const u = new URL(rawUrl, location.href);
      const params = {};
      for (const k of KEYS) {
        const v = u.searchParams.get(k);
        if (v) params[k] = v;
      }
      if (params.REFERENCE_ID) {
        window.postMessage(
          { source: "spjimr-timetable", type: "params", params },
          "*"
        );
      }
    } catch (_) {
      // Ignore malformed URLs.
    }
  }

  // Hook XMLHttpRequest (the TCS iON app uses XHR for this call).
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    capture(url);
    return origOpen.apply(this, arguments);
  };

  // Hook fetch as well, in case the app ever uses it.
  if (window.fetch) {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === "string" ? input : input && input.url;
      capture(url);
      return origFetch.apply(this, arguments);
    };
  }
})();

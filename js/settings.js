// Server-persisted settings. config.js holds the committed defaults; this module fetches the
// per-machine app/settings.json (written by the log-server's /settings endpoint) and deep-merges
// it over window.CONFIG before the app boots. Callers invoke SETTINGS.save(patch) on every
// change, so device labels, model choices, and tuning survive reloads, browser data clears, and
// different browsers on the same machine. Secrets are NOT stored here - they live only in .env.
(function (global) {
  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  // Deep merge src into dst (arrays and scalars replace; objects merge).
  function merge(dst, src) {
    Object.keys(src || {}).forEach(function (k) {
      if (isObj(src[k]) && isObj(dst[k])) merge(dst[k], src[k]);
      else dst[k] = src[k];
    });
    return dst;
  }
  var url = (global.CONFIG && global.CONFIG.settingsUrl) || "";
  var stored = {};   // everything the user has explicitly saved (the full persisted patch)

  var ready = (url ? fetch(url).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
                   : Promise.resolve({}))
    .then(function (s) {
      stored = isObj(s) ? s : {};
      if (global.CONFIG) merge(global.CONFIG, stored);
      return stored;
    });

  // Persist a patch: merge it into both the live CONFIG and the stored settings, then POST the
  // full stored object (fire-and-forget; the app keeps working if the log-server is down).
  function save(patch) {
    if (!isObj(patch)) return;
    if (global.CONFIG) merge(global.CONFIG, patch);
    merge(stored, patch);
    if (!url) return;
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stored) })
      .catch(function () {});
  }

  global.SETTINGS = { ready: ready, save: save, stored: function () { return stored; }, merge: merge, isObj: isObj };
})(typeof window !== "undefined" ? window : globalThis);

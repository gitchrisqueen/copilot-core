// Dated, editable transcript log. Persists in the browser (localStorage) so it survives reloads,
// and mirrors every segment to the durable disk log (log-server) fire-and-forget.
// Canonical segment shape: { id, ts (ISO), date (YYYY-MM-DD), <roleField>, text, name, ...extra }.
// The role field is named "role" by default but can be renamed via
// window.CopilotCore.transcript.roleField (e.g. "speaker") so an app with an existing schema and
// a large amount of code already reading `seg.speaker` can adopt this module without a rename
// sweep. Its value is one of the ids in the app's configured roles list (see
// window.CopilotCore.roles). `name` is the display name of an identified voice (a rename
// retroactively patches every line of that cluster). Apps may attach additional fields via
// `add(role, text, extra)`'s extra bag (e.g. a raw voice verdict, or ids from an LLM/keyword
// match pass).
(function (global) {
  var NS = (global.CopilotCore && global.CopilotCore.ns) || "cc";
  var KEY = NS + "_transcript_v1";
  function cfg() { return (global.CopilotCore && global.CopilotCore.transcript) || {}; }
  function roleField() { return cfg().roleField || "role"; }
  // Which fields, besides id/ts/date, trigger a disk rewrite on update() -- i.e. which fields are
  // durable record content vs transient browser-only metadata (raw voice verdicts, match scores).
  // Override via window.CopilotCore.transcript.persistKeys = ["text","role","name","matchedId",...].
  function persistKeys() {
    return cfg().persistKeys || ["text", roleField(), "name"];
  }
  var data = [];

  function save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {} }
  // Fire-and-forget durable disk log (does not block or slow the UI).
  function disk(seg) {
    try {
      var c = (global.CONFIG && global.CONFIG.logServer) || {};
      if (!c.enabled || !c.url || !seg) return;
      fetch(c.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(seg), keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  function load() {
    try { var raw = localStorage.getItem(KEY); data = raw ? JSON.parse(raw) : []; }
    catch (e) { data = []; }
    return data;
  }
  function todayStr() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function add(role, text, extra) {
    var now = new Date();
    var seg = { id: "t" + now.getTime() + "_" + Math.floor(Math.random() * 1000),
      ts: now.toISOString(), date: todayStr(), text: text, voice: null, name: "" };
    seg[roleField()] = role;
    if (extra) Object.keys(extra).forEach(function (k) { seg[k] = extra[k]; });
    data.push(seg); save(); disk(seg);
    return seg;
  }
  function update(id, patch) {
    var s = data.filter(function (x) { return x.id === id; })[0];
    if (s) {
      Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
      save();
      // Re-write the durable disk log only when a PERSISTED field changes (text, role/speaker
      // reassignment, display name). Transient metadata (raw voice verdicts, match scores) stays
      // in the browser copy only.
      var pk = persistKeys();
      if (pk.some(function (k) { return Object.prototype.hasOwnProperty.call(patch, k); })) disk(s);
    }
    return s;
  }
  function remove(id) { data = data.filter(function (x) { return x.id !== id; }); save(); }
  function byDate(date) { return data.filter(function (x) { return x.date === date; }); }
  function dates() {
    var seen = {}; data.forEach(function (x) { seen[x.date] = true; });
    return Object.keys(seen).sort().reverse();
  }
  // Clear a day locally AND on disk, so "clear session" really starts clean (a reload would
  // otherwise rehydrate the day's segments straight back from the log server).
  function clearDate(date) {
    data = data.filter(function (x) { return x.date !== date; });
    save();
    try {
      var c = (global.CONFIG && global.CONFIG.logServer) || {};
      if (c.enabled && c.url) {
        fetch(c.url.replace(/\/log$/, "") + "/log?date=" + encodeURIComponent(date),
              { method: "DELETE" }).catch(function () {});
      }
    } catch (e) {}
  }
  // Default label formatter: NAME if set, else the role id, uppercased. Override via
  // window.CopilotCore.transcript.labelFor = function(seg) { return "..."; } for app-specific
  // labels ("ME" / "INTERVIEWER", or a party name).
  function speakerLabel(s) {
    var t = cfg();
    if (typeof t.labelFor === "function") { try { return t.labelFor(s); } catch (e) {} }
    return (s.name || s[roleField()] || "").toString().toUpperCase();
  }
  function exportText(date) {
    return byDate(date).map(function (s) {
      var t = new Date(s.ts).toLocaleTimeString();
      return "[" + t + "] " + speakerLabel(s) + ": " + s.text;
    }).join("\n");
  }

  // Replace/merge the in-memory log with segments loaded from the durable disk log (server wins by id).
  function hydrate(segs) {
    if (!segs || !segs.length) return data;
    var byId = {};
    data.forEach(function (s) { byId[s.id] = s; });
    segs.forEach(function (s) { if (s && s.id) byId[s.id] = s; });
    data = Object.keys(byId).map(function (k) { return byId[k]; });
    data.sort(function (a, b) { return String(a.ts || "").localeCompare(String(b.ts || "")); });
    save();
    return data;
  }

  global.TLOG = {
    load: load, add: add, update: update, remove: remove, hydrate: hydrate,
    byDate: byDate, dates: dates, clearDate: clearDate, exportText: exportText, today: todayStr,
    speakerLabel: speakerLabel,
    all: function () { return data.slice(); },
    _key: function () { return KEY; },
    _roleField: roleField
  };
})(typeof window !== "undefined" ? window : globalThis);

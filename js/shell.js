// Small, genuinely app-agnostic UI helpers shared by both copilot apps: DOM lookup, HTML
// escaping, a debug logger, and a bounded in-memory notification ring buffer.
//
// Deliberately NOT included here: setLive/pingLLM/probeVoice/renderVoicesStrip. Diff analysis
// against both source apps showed these differ substantially even where same-named (13% overlap)
// because they're wired into each app's own state shape and view model. They stay app-local;
// revisit sharing them only if a third consumer needs the exact same shape.
(function (global) {
  function el(id) { return document.getElementById(id); }

  // Quotes are escaped too: some callers build single-quoted HTML attributes
  // (value='...', data-doc='...'), so an unescaped apostrophe would close the attribute early.
  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function timeShort(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // Logger factory: makeLogger("copilot", function(){ return CONFIG.debug; }) -> dbg(...)
  // that no-ops unless the debug flag is currently true.
  function makeLogger(tag, isDebug) {
    return function () {
      if (isDebug && isDebug() && global.console) {
        console.log.apply(console, ["[" + tag + "]"].concat([].slice.call(arguments)));
      }
    };
  }

  // Bounded notification ring buffer. onChange(list) fires after every push so the caller can
  // re-render whatever view shows notifications.
  function makeNotifier(opts) {
    opts = opts || {};
    var max = opts.max || 12;
    var onChange = opts.onChange || function () {};
    var list = [];
    function notify(msg) {
      list.unshift({ t: new Date().toLocaleTimeString(), msg: msg });
      list = list.slice(0, max);
      onChange(list);
    }
    return { notify: notify, list: function () { return list.slice(); }, clear: function () { list = []; onChange(list); } };
  }

  global.CopilotShell = { el: el, esc: esc, escapeHtml: esc, timeShort: timeShort, makeLogger: makeLogger, makeNotifier: makeNotifier };
})(typeof window !== "undefined" ? window : globalThis);

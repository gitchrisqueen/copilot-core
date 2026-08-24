"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeDom } = require("./harness");

function boot() {
  const win = fakeDom(["foo"]);
  win.console = console;
  load(win, "js/shell.js");
  return win;
}

test("shell: el() looks up by id", () => {
  const win = boot();
  assert.equal(win.CopilotShell.el("foo"), win._byId["foo"]);
  assert.equal(win.CopilotShell.el("missing"), null);
});

test("shell: esc() escapes HTML special chars including quotes", () => {
  const win = boot();
  assert.equal(win.CopilotShell.esc(`<a href="x">L'Oreal & Co</a>`),
    "&lt;a href=&quot;x&quot;&gt;L&#39;Oreal &amp; Co&lt;/a&gt;");
});

test("shell: esc() tolerates null/undefined", () => {
  const win = boot();
  assert.equal(win.CopilotShell.esc(null), "");
  assert.equal(win.CopilotShell.esc(undefined), "");
});

test("shell: makeLogger no-ops when debug flag is false", () => {
  const win = boot();
  const logged = [];
  win.console = { log: function () { logged.push([].slice.call(arguments)); } };
  const dbg = win.CopilotShell.makeLogger("test", () => false);
  dbg("should not appear");
  assert.equal(logged.length, 0);
  const dbg2 = win.CopilotShell.makeLogger("test", () => true);
  dbg2("should appear", 1, 2);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "[test]");
});

test("shell: makeNotifier bounds the list and fires onChange", () => {
  const win = boot();
  const seen = [];
  const n = win.CopilotShell.makeNotifier({ max: 2, onChange: (list) => seen.push(list.length) });
  n.notify("a"); n.notify("b"); n.notify("c");
  assert.equal(n.list().length, 2, "bounded to max");
  assert.equal(n.list()[0].msg, "c", "newest first");
  assert.deepEqual(seen, [1, 2, 2]);
  n.clear();
  assert.equal(n.list().length, 0);
});

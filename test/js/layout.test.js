"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, fakeDom } = require("./harness");

function boot(ns) {
  const win = fakeDom(["copilot-panel", "copilot-collapse", "copilot-tabbar", "row-divider",
    "col-divider", ".grid", ".col.left", ".col.right"]);
  win.CopilotCore = { ns: ns || "test" };
  win.console = console;
  load(win, "js/layout.js");
  return win;
}

test("layout: namespaces localStorage keys from CopilotCore.ns", () => {
  const win = boot("acme");
  assert.equal(win.CopilotLayout._LS.collapsed, "acme_copilot_collapsed");
  assert.equal(win.CopilotLayout._LS.copilotH, "acme_copilot_height");
  assert.equal(win.CopilotLayout._LS.leftW, "acme_left_width");
});

test("layout: falls back to 'cc' namespace when unset", () => {
  const win = fakeDom(["copilot-panel", "copilot-collapse", "copilot-tabbar"]);
  win.console = console;
  load(win, "js/layout.js");
  assert.equal(win.CopilotLayout._LS.collapsed, "cc_copilot_collapsed");
});

test("layout: init() wires the collapse button and toggles localStorage + classes", () => {
  // boot() -> load() already auto-runs init() once, since the fake document.readyState is
  // "complete" (matching how a real browser loads this script after the DOM is ready). Do NOT
  // call CopilotLayout.init() again here: layout.js has no re-init guard, so a second call would
  // register a second click listener and the two would cancel each other out on every click.
  const win = boot("t1");
  const btn = win._byId["copilot-collapse"];
  const panel = win._byId["copilot-panel"];
  assert.equal(panel.classList.contains("collapsed"), false);
  btn.dispatchEvent({ type: "click", stopPropagation: function () {} });
  assert.equal(panel.classList.contains("collapsed"), true);
  assert.equal(win.localStorage.getItem("t1_copilot_collapsed"), "1");
  btn.dispatchEvent({ type: "click", stopPropagation: function () {} });
  assert.equal(panel.classList.contains("collapsed"), false);
  assert.equal(win.localStorage.getItem("t1_copilot_collapsed"), "0");
});

test("layout: missing panel elements -> init() is a safe no-op", () => {
  const win = fakeDom([]);
  win.console = console;
  load(win, "js/layout.js");
  assert.doesNotThrow(() => win.CopilotLayout.init());
});
